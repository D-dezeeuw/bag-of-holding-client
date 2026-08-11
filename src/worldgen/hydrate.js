// src/worldgen/hydrate.js — lazy filling with a contract (doc 18 §5–§8, phase C).
//
// Promotion triggers say WHEN a node hydrates; the template registry says WHAT
// hydrating each kind of node means: which layers run, which ancestor facts the
// prompt must include, what is procedural vs LLM, which child stubs are minted,
// and which reference checks must hold afterwards. hydrateNode is the one
// orchestrator: it never mutates a ledger — it returns the patches of a single
// atomic commit, or nothing.
//
// House rules kept: pure and injected (the LLM arrives as a `complete`
// callback), node-testable without a network, host-overridable templates.

import { mulberry32, randInt, pick } from './rng.js';
import { ancestorsOf, childrenOf, neighbours, addNode, connect, promoteNode, knownMap, DIRECTIONS } from './geography.js';
import { SYLLABLES } from './skeleton.js';
import { makePatch } from '../ledger/patch.js';
import {
  CONTINENT_OUTLINE_SCHEMA, PROVINCE_OUTLINE_SCHEMA, REGION_SCHEMA,
  SETTLEMENT_SCHEMA, CROWN_SCHEMA, LEGEND_SCHEMA,
} from './schemas.js';

// ─── Template registry ───────────────────────────────────────────────────────
//
// Keyed by node kind (sites by `site:<siteType>`). Each entry declares:
//   outline / full — the layer spec run at that target detail:
//                    { schema, tier, retries }
//   consumes       — ancestor-slice facts the prompt must carry
//   method         — 'llm' | 'procedural' | 'mixed'
//   mints          — child stubs a successful hydration leaves behind
//   post           — reference checks (post-conditions) run on the result
//   fallback(node, ctx) — procedural stand-in when no model is available;
//                    committed as provisional, superseded by real hydration.

export const HYDRATION_TEMPLATES = Object.freeze({
  continent: {
    outline: { schema: CONTINENT_OUTLINE_SCHEMA, tier: 'tiny', retries: 1 },
    consumes: ['tone', 'threatType', 'threatExpression'],
    method: 'llm',
    fallback: (node) => ({
      id: node.id, name: node.name, factionHomelands: [],
      digest: `${node.name} — ${node.hook ?? 'an unmapped land'}`,
    }),
  },
  province: {
    outline: { schema: PROVINCE_OUTLINE_SCHEMA, tier: 'tiny', retries: 1 },
    consumes: ['climate', 'threatExpression', 'worshipSkew'],
    method: 'llm',
    mints: 'regions',
    fallback: (node) => ({
      id: node.id, name: node.name, conflicts: [], landmarks: [],
      dominantFactionId: null, factionStance: 'absent',
      digest: `${node.name} — ${node.hook ?? 'a province no chronicle claims'}`,
    }),
  },
  region: {
    full: { schema: REGION_SCHEMA, tier: 'medium', retries: 1 },
    consumes: ['climate', 'dungeonTheme', 'settlementType', 'threatExpression'],
    method: 'llm',
    mints: 'sites',
    post: ['eraValid'],
    fallback: (node, ctx) => ({
      id: node.id, name: node.name, climate: ctx?.slice?.climate ?? 'temperate',
      description: `${node.name}. ${node.hook ?? ''}`.trim(),
      settlementName: `${node.name} Rest`, dungeonName: `the ${node.name} Deep`,
      rumor: node.hook ?? 'travellers avoid naming it', adjacentHints: [],
      digest: `${node.name} — ${node.hook ?? 'a quiet stretch of country'}`,
    }),
  },
  'site:settlement': {
    full: { schema: SETTLEMENT_SCHEMA, tier: 'medium', retries: 1 },
    consumes: ['settlementType', 'climate', 'worshipSkew'],
    method: 'llm',
    post: ['exitsResolve', 'factionsExist'],
    fallback: (node) => ({
      id: node.id, name: node.name, description: `${node.name}, quiet at this hour.`,
      regionId: node.parent ?? '', npcs: [], exits: [],
      digest: `${node.name} — a settlement, still mostly rumor`,
    }),
  },
  'site:dungeon': {
    // Floors are generateDungeon's (procedural, host-driven); the one small
    // call dresses the theme. legendHook guards the bridge between lore and
    // rooms: a dungeon bound to a legend must carry the legend's hook.
    full: { schema: null, tier: 'tiny', retries: 0 },
    consumes: ['dungeonTheme'],
    method: 'procedural',
    post: ['legendHook'],
    fallback: (node, ctx) => ({
      id: node.id, name: node.name,
      theme: ctx?.slice?.dungeonTheme ?? null,
      hook: node.hook ?? null,
      digest: `${node.name} — sealed, for now`,
    }),
  },
  'site:landfall': {
    // Where the wanderer came down: no jetty, no road. Procedural — the
    // arrival IS the fallback (portals and flight give zero latency budget);
    // the next real hydration supersedes it.
    full: { schema: null, tier: 'tiny', retries: 0 },
    consumes: ['climate', 'threatExpression'],
    method: 'procedural',
    fallback: (node, ctx) => ({
      id: node.id, name: node.name,
      climate: ctx?.slice?.climate ?? null,
      hook: node.hook ?? 'no jetty, no path, no footprints',
      digest: `${node.name} — a landing where no road ever led`,
    }),
  },
  'site:landmark': {
    full: { schema: null, tier: 'tiny', retries: 0 },
    consumes: ['climate'],
    method: 'procedural',
    post: ['eraValid'],
    fallback: (node, ctx) => ({
      id: node.id, name: node.name,
      era: ctx?.eras?.[0]?.id ?? null,
      digest: `${node.name} — older than the road that passes it`,
    }),
  },
  crown: {
    full: { schema: CROWN_SCHEMA, tier: 'tiny', retries: 1 },
    consumes: ['threatExpression', 'worshipSkew'],
    method: 'llm',
    post: ['factionsExist', 'seatResolves'],
    fallback: (stub) => ({
      ...stripStub(stub), seat: null,
      stanceOnThreat: 'undeclared', factionRelations: [],
      digest: `${stub.name}, ${stub.title} — ${stub.legitimacy}`,
    }),
  },
  legend: {
    full: { schema: LEGEND_SCHEMA, tier: 'medium', retries: 1 },
    consumes: ['tone', 'threatExpression'],
    method: 'llm',
    post: ['sitesResolve', 'eraValid'],
    fallback: (stub) => ({
      ...stripStub(stub),
      kernelOfTruth: 'more true than anyone repeating it believes',
      payoff: 'what was buried is still there',
      hooks: stub.hooks?.length ? stub.hooks : ['ask about it in any harbor tavern'],
      digest: `${stub.title} — a story with a place attached`,
    }),
  },
});

const stripStub = ({ stub, ...rest }) => rest;
const templateKeyOf = (node) => node.kind === 'site' ? `site:${node.siteType}` : node.kind;

// ─── Lineage ─────────────────────────────────────────────────────────────────

// Ancestor ids that still need an outline, root first — the ancestor-first
// rule a cold landing depends on: continent outline, then province, then the
// landing region.
export function ensureLineage(geo, nodeId) {
  return ancestorsOf(geo, nodeId)
    .filter(a => (a.detail ?? 0) < 1)
    .reverse()
    .map(a => a.id);
}

// The prompt's ancestry: digests root-down, plus exactly the slice facts the
// template consumes — not the whole tree, which is what keeps the token cost
// of depth flat.
export function lineageContext(geo, nodeId, { consumes = [], slice = null, slices = {} } = {}) {
  const lines = [];
  for (const anc of [...ancestorsOf(geo, nodeId)].reverse()) {
    lines.push(`${anc.kind} ${anc.name}: ${anc.digest ?? anc.hook ?? '(unwritten)'}`);
    const s = slices[anc.id];
    if (s) for (const key of consumes) {
      if (s[key] != null) lines.push(`  ${key}: ${Array.isArray(s[key]) ? s[key].join(', ') : s[key]}`);
    }
  }
  if (slice) for (const key of consumes) {
    if (slice[key] != null) lines.push(`${key}: ${Array.isArray(slice[key]) ? slice[key].join(', ') : slice[key]}`);
  }
  return lines.join('\n');
}

// ─── Gazetteer (the story only points at real places) ───────────────────────

export function gazetteerOf(geo, { legends = [] } = {}) {
  const { visited, rumoured } = knownMap(geo);
  const ids = new Set([...visited, ...rumoured].map(n => n.id));
  for (const l of legends) for (const s of l.sites ?? []) ids.add(s);
  return [...ids].filter(id => geo.nodes[id]).map(id => ({
    id, name: geo.nodes[id].name, hook: geo.nodes[id].hook ?? null,
  }));
}

// Deterministic nearest-match coercion for a beat whose preferredLocation is
// not in the gazetteer: token overlap first, then lexicographic id order.
// Never invents a place; moves the intention, not the geography.
export function coerceBeatLocation(beat, gazetteer) {
  if (!beat?.preferredLocation) return beat;
  if (gazetteer.some(g => g.id === beat.preferredLocation)) return beat;
  if (!gazetteer.length) return { ...beat, preferredLocation: null };
  const want = String(beat.preferredLocation).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = gazetteer.map(g => {
    const have = `${g.id} ${g.name}`.toLowerCase();
    return { g, score: want.filter(w => have.includes(w)).length };
  }).sort((a, b) => b.score - a.score || (a.g.id < b.g.id ? -1 : 1));
  return { ...beat, preferredLocation: scored[0].g.id };
}

// ─── Minting (what a hydration leaves behind) ────────────────────────────────

// A province's first regions — closes the who-mints-the-first-region gap: the
// skeleton stops at provinces, expandFrom grows region-from-region. Seeded
// from the province, named in the continent's culture. On a port province the
// first region is the harbor — the deterministic sea anchor.
export function mintProvinceRegions(geo, provinceId) {
  const prov = geo.nodes[provinceId];
  if (!prov) return { geo, minted: [] };
  if (childrenOf(geo, provinceId).some(c => c.kind === 'region')) return { geo, minted: [] };
  const rng = mulberry32(((prov.seed ?? 1) + 303) >>> 0);
  const culture = geo.nodes[prov.parent]?.nameParts ?? {
    prefixes: SYLLABLES.provincePrefixes, suffixes: SYLLABLES.provinceSuffixes,
  };
  const n = randInt(1, 2, rng);
  let out = geo;
  const minted = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const id = `${provinceId}.region-${i}`;
    out = addNode(out, {
      id, name: `${pick(culture.prefixes, rng)}${pick(culture.suffixes, rng)}`,
      kind: 'region', seed: randInt(1, 2 ** 30, rng),
      hook: prov.hook, stub: true, detail: 0, parent: provinceId,
    });
    if (prov.port && i === 0) out = { ...out, nodes: { ...out.nodes, [id]: { ...out.nodes[id], harbor: true } } };
    if (prev) out = connect(out, prev, id, { direction: DIRECTIONS[i % DIRECTIONS.length], days: randInt(1, 2, rng) });
    prev = id;
    minted.push(id);
  }
  return { geo: out, minted };
}

// A region's site stubs, from its hydrated content.
export function mintRegionSites(geo, regionId, content) {
  const region = geo.nodes[regionId];
  if (!region) return { geo, minted: [] };
  let out = geo;
  const minted = [];
  const mint = (siteType, name) => {
    if (!name) return;
    const id = `${regionId}.site-${siteType}`;
    if (out.nodes[id]) return;
    out = addNode(out, {
      id, name, kind: 'site', seed: ((region.seed ?? 1) + minted.length + 7) >>> 0,
      stub: true, detail: 0, parent: regionId,
    });
    out = { ...out, nodes: { ...out.nodes, [id]: { ...out.nodes[id], siteType } } };
    minted.push(id);
  };
  mint('settlement', content?.settlementName);
  mint('dungeon', content?.dungeonName);
  return { geo: out, minted };
}

// ─── Post-conditions and the coercion ladder ─────────────────────────────────
//
// Schema validation catches shape; these catch dangling references — the way
// canon forks when the model invents a place the tree doesn't have. Each check
// either passes, or names a violation with a deterministic coercion.

const POST_CHECKS = {
  exitsResolve(result, ctx) {
    const out = [];
    for (const [i, exit] of (result.exits ?? []).entries()) {
      if (exit.targetId && !ctx.geo.nodes[exit.targetId]) {
        out.push({ check: 'exitsResolve', at: `exits[${i}]`, value: exit.targetId,
          coerce: (r) => ({ ...r, exits: r.exits.map((x, j) => j === i ? { ...x, targetId: null } : x) }) });
      }
    }
    return out;
  },
  factionsExist(result, ctx) {
    const known = new Set((ctx.factions ?? []).map(f => f.id));
    const out = [];
    for (const [i, npc] of (result.npcs ?? []).entries()) {
      if (npc.factionId && !known.has(npc.factionId)) {
        out.push({ check: 'factionsExist', at: `npcs[${i}]`, value: npc.factionId,
          coerce: (r) => ({ ...r, npcs: r.npcs.map((x, j) => j === i ? { ...x, factionId: null } : x) }) });
      }
    }
    for (const [i, rel] of (result.factionRelations ?? []).entries()) {
      if (rel.factionId && !known.has(rel.factionId)) {
        out.push({ check: 'factionsExist', at: `factionRelations[${i}]`, value: rel.factionId,
          coerce: (r) => ({ ...r, factionRelations: r.factionRelations.filter((_, j) => j !== i) }) });
      }
    }
    return out;
  },
  eraValid(result, ctx) {
    if (result.era == null) return [];
    const ids = new Set((ctx.eras ?? []).map(e => e.id));
    if (ids.has(result.era)) return [];
    const snap = ctx.eras?.[0]?.id ?? null;
    return [{ check: 'eraValid', at: 'era', value: result.era,
      coerce: (r) => ({ ...r, era: snap }) }];
  },
  seatResolves(result, ctx) {
    if (result.seat == null || ctx.geo.nodes[result.seat]) return [];
    return [{ check: 'seatResolves', at: 'seat', value: result.seat,
      coerce: (r) => ({ ...r, seat: null }) }];
  },
  sitesResolve(result, ctx) {
    const bad = (result.sites ?? []).filter(s => !ctx.geo.nodes[s]);
    if (!bad.length) return [];
    return [{ check: 'sitesResolve', at: 'sites', value: bad.join(','),
      coerce: (r) => ({ ...r, sites: r.sites.filter(s => ctx.geo.nodes[s]) }) }];
  },
  legendHook(result, ctx) {
    const legend = (ctx.legends ?? []).find(l => (l.sites ?? []).some(s =>
      s === ctx.nodeId || ctx.nodeId.startsWith(`${s}.`)));
    if (!legend) return [];
    const text = JSON.stringify(result).toLowerCase();
    if (legend.hooks?.some(h => text.includes(String(h).toLowerCase())) ||
        text.includes(legend.title.toLowerCase())) return [];
    return [{ check: 'legendHook', at: 'hook', value: legend.title,
      coerce: (r) => ({ ...r, hook: legend.hooks?.[0] ?? `they still tell of ${legend.title}` }) }];
  },
};

export function runPostConditions(result, checks, ctx) {
  const violations = [];
  for (const name of checks ?? []) {
    const fn = POST_CHECKS[name];
    if (fn) violations.push(...fn(result, ctx));
  }
  return violations;
}

// ─── The orchestrator ────────────────────────────────────────────────────────

// Hydrate one node to the target detail. Never touches a ledger: returns
// { ok, geo, patches, result, minted, coerced, provisional } where `patches`
// is the whole atomic commit — the caller appends all of them or none.
//
// `complete` is the host's LLM: async ({ tier, schema, prompt }) => object.
// Absent (or throwing beyond its retry), the template's procedural fallback
// serves instead and the commit is marked provisional.
export async function hydrateNode(geo, nodeId, {
  complete = null,
  templates = HYDRATION_TEMPLATES,
  detail = 2,
  turn = 0,
  slice = null, slices = {},
  eras = [], legends = [], factions = [], crowns = [],
  ledger = [],
  entity = null,           // for crown/legend hydration: the stub being filled
  onProgress = () => {},
} = {}) {
  const node = entity ?? geo.nodes[nodeId];
  if (!node) return { ok: false, geo, patches: [], error: `unknown node ${nodeId}` };
  const template = templates[templateKeyOf(node)] ?? null;
  if (!template) return { ok: false, geo, patches: [], error: `no template for ${templateKeyOf(node)}` };
  const spec = detail >= 2 ? (template.full ?? template.outline) : (template.outline ?? null);
  if (!spec) return { ok: false, geo, patches: [], error: `template ${templateKeyOf(node)} has no layer for detail ${detail}` };

  const ctx = { geo, nodeId, eras, legends, factions, crowns, slice };

  // Assemble the prompt: lineage + consumed facts + inbound commitments +
  // digests of already-hydrated direct neighbours + observed provisionals.
  const commitments = ledger.filter(p => p.target === nodeId && p.path === 'hintedBy').map(p => p.to);
  const neighbourDigests = entity ? [] : neighbours(geo, nodeId)
    .filter(n => (n.detail ?? 0) >= 1 && n.digest)
    .map(n => `${n.name}: ${n.digest}`);
  const observed = ledger.filter(p =>
    p.target === nodeId && p.because === 'worldgen:provisional' &&
    ledger.some(q => q.target === nodeId && q.path === 'observed'));
  const prompt = [
    `Generate ${templateKeyOf(node)} "${node.name}" (${nodeId}).`,
    lineageContext(geo, nodeId, { consumes: template.consumes, slice, slices }),
    commitments.length ? `Already promised about this place (honour these): ${commitments.map(c => c.hint ?? c).join('; ')}` : '',
    neighbourDigests.length ? `Adjacent, already canon (do not contradict): ${neighbourDigests.join(' | ')}` : '',
    observed.length ? `Provisional facts the players have already seen (keep true): ${observed.map(p => JSON.stringify(p.to)).join('; ')}` : '',
  ].filter(Boolean).join('\n\n');

  // Generate: llm with one semantic-repair retry, else procedural fallback.
  let result = null;
  let provisional = false;
  const coerced = [];
  const canCall = complete && template.method !== 'procedural' && spec.schema;
  if (canCall) {
    try {
      result = await complete({ tier: spec.tier, schema: spec.schema, prompt });
      let violations = runPostConditions(result, template.post, ctx);
      if (violations.length) {
        onProgress('repair', { node: nodeId, violations: violations.map(v => `${v.check}:${v.value}`) });
        try {
          result = await complete({
            tier: spec.tier, schema: spec.schema,
            prompt: `${prompt}\n\nYour previous answer had invalid references — fix ONLY these and change nothing else:\n${violations.map(v => `- ${v.check} at ${v.at}: '${v.value}' does not exist`).join('\n')}`,
          });
        } catch { /* fall through to coercion on the first result */ }
        // Still failing → the deterministic coercion ladder.
        for (const v of runPostConditions(result, template.post, ctx)) {
          result = v.coerce(result);
          coerced.push(v.check);
        }
      }
    } catch (e) {
      onProgress('fallback', { node: nodeId, message: e?.message });
      result = null;
    }
  }
  if (result == null) {
    result = template.fallback ? template.fallback(node, ctx) : null;
    if (result == null) return { ok: false, geo, patches: [], error: `no result and no fallback for ${nodeId}` };
    provisional = true; // fallback content is provisional by definition
    // Fallbacks obey post-conditions too — coerce, never reject.
    for (const v of runPostConditions(result, template.post, ctx)) { result = v.coerce(result); coerced.push(v.check); }
  }

  // Promote + mint (geo is copy-on-write; nothing applied until we return ok).
  let outGeo = entity ? geo : promoteNode(geo, nodeId, {
    detail, name: result.name ?? null, digest: result.digest ?? null,
  });
  let minted = [];
  if (!entity && template.mints === 'regions') {
    const m = mintProvinceRegions(outGeo, nodeId); outGeo = m.geo; minted = m.minted;
  }
  if (!entity && template.mints === 'sites') {
    const m = mintRegionSites(outGeo, nodeId, result); outGeo = m.geo; minted = m.minted;
  }

  // The atomic commit: the content patch plus hint-commitments recorded on
  // neighbour stubs (promises about places that do not exist yet, consumed
  // when they hydrate).
  const patches = [makePatch({
    turn, target: nodeId, scope: 'regional', kind: 'canon',
    path: 'content', to: result,
    because: provisional ? 'worldgen:provisional' : 'worldgen',
    source: 'worldgen',
  })];
  if (!entity && Array.isArray(result.adjacentHints) && result.adjacentHints.length) {
    const stubs = neighbours(outGeo, nodeId).filter(n => n.stub).map(n => n.id);
    result.adjacentHints.forEach((hint, i) => {
      const target = stubs[i % Math.max(1, stubs.length)] ?? nodeId;
      patches.push(makePatch({
        turn, target, scope: 'regional', kind: 'canon',
        path: 'hintedBy', to: { from: nodeId, hint },
        because: 'worldgen:commitment', source: 'worldgen',
      }));
    });
  }

  return { ok: true, geo: outGeo, patches, result, minted, coerced, provisional };
}

// Mark a provisional fact as observed: the players acted on it, so the real
// hydration must keep it true. Append-only, like everything in the ledger.
export function promoteObserved(targetId, turn = 0) {
  return makePatch({
    turn, target: targetId, scope: 'regional', kind: 'canon',
    path: 'observed', to: true, because: 'worldgen:observed', source: 'worldgen',
  });
}

// ─── Landfall (doc 18 §9, phase F) ───────────────────────────────────────────

// A port province's deterministic sea anchor: the harbor region minted by
// mintProvinceRegions. Regions get minted here if the province was never
// hydrated — arriving by sea IS an approach.
export function portAnchorOf(geo, provinceId) {
  const prov = geo.nodes[provinceId];
  if (!prov) return { geo, anchor: null };
  let out = geo;
  let regions = childrenOf(out, provinceId).filter(c => c.kind === 'region');
  if (!regions.length) {
    out = mintProvinceRegions(out, provinceId).geo;
    regions = childrenOf(out, provinceId).filter(c => c.kind === 'region');
  }
  const anchor = regions.find(r => r.harbor) ?? regions[0] ?? null;
  return { geo: out, anchor: anchor?.id ?? null };
}

// Air and portals land anywhere: mint a landfall region on the chosen
// province — no jetty, no road — seeded from the province so replay and
// shared cartridges agree on where the wanderer came down. Idempotent.
export function mintLandfall(geo, provinceId, { via = 'air', hooks = null } = {}) {
  const prov = geo.nodes[provinceId];
  if (!prov) return { geo, landfall: null };
  const id = `${provinceId}.landfall`;
  if (geo.nodes[id]) return { geo, landfall: id };
  const rng = mulberry32(((prov.seed ?? 1) + 404) >>> 0);
  const culture = geo.nodes[prov.parent]?.nameParts ?? {
    prefixes: SYLLABLES.provincePrefixes, suffixes: SYLLABLES.provinceSuffixes,
  };
  const hookTable = hooks ?? [
    'no jetty, no path, no footprints',
    'the tide line is strewn with unfamiliar shells',
    'something watched the descent and did not run',
    'an old fire ring, cold for years',
  ];
  let out = addNode(geo, {
    id, name: `${pick(culture.prefixes, rng)}${pick(culture.suffixes, rng)}`,
    kind: 'region', seed: randInt(1, 2 ** 30, rng),
    hook: pick(hookTable, rng), stub: true, detail: 0, parent: provinceId,
  });
  out = { ...out, nodes: { ...out.nodes, [id]: { ...out.nodes[id], landfall: via } } };
  const siteId = `${id}.site-landfall`;
  out = addNode(out, {
    id: siteId, name: 'the landing', kind: 'site',
    seed: randInt(1, 2 ** 30, rng), stub: true, detail: 0, parent: id,
  });
  out = { ...out, nodes: { ...out.nodes, [siteId]: { ...out.nodes[siteId], siteType: 'landfall' } } };
  // Tie the landfall into the province's walkable frontier if regions exist.
  const sibling = childrenOf(out, provinceId).find(c => c.kind === 'region' && c.id !== id);
  if (sibling) out = connect(out, id, sibling.id, { direction: DIRECTIONS[0], days: randInt(1, 2, rng) });
  return { geo: out, landfall: id };
}

// ─── The return recap (doc 18 §9) ────────────────────────────────────────────

// "While you were gone": clocks that fired and provisional content that was
// superseded since the party left. Pure digest over existing state — the
// host narrates it as news on the road home.
export function whileYouWereGone(clocks, ledger, { sinceTurn = 0 } = {}) {
  const firedClocks = (clocks ?? []).filter(c => c.fired);
  const provisionalTargets = new Set(
    (ledger ?? []).filter(p => p.because === 'worldgen:provisional').map(p => p.target));
  const superseded = (ledger ?? []).filter(p =>
    p.because === 'worldgen' && p.path === 'content' &&
    p.turn >= sinceTurn && provisionalTargets.has(p.target))
    .map(p => ({ target: p.target, turn: p.turn }));
  return { firedClocks, superseded };
}
