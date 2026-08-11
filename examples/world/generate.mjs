#!/usr/bin/env node
// examples/world/generate.mjs — run the lore-tree worldgen pipeline end to
// end (docs/worldgen-lore-tree.md, phases A-G) and export what it produces.
//
//   node examples/world/generate.mjs [seed]
//
// Writes world-<seed>.json (everything the pipeline generated: the baked
// cartridge, hydrated region/settlement/dungeon/legend/crown content, a
// planned sea crossing with a sampled travel log, a landfall, and a laid-out
// settlement) and world-<seed>.epub (the same material read as a book).
//
// With OPENROUTER_API_KEY set, every LLM-backed layer hydrates real prose.
// Without one, every layer still runs — each hydration template's procedural
// fallback stands in, and the book reads a little drier but the pipeline
// exercises exactly the same code path (this is the point of the fallback
// design: play never blocks on a model).
//
// This script is an example, not part of the published package (nothing
// under examples/ ships in the npm tarball) — it imports the sibling source
// tree directly; a real consumer would `import ... from '@zeeuw/bag-of-holding-client'`.

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBlueprint, deriveBlueprint, worldSeedConstraints, beatsHints, MENACE_SIGNPOSTS,
  WORLD_SEED_SCHEMA, RED_THREAD_SCHEMA, chatCompletion,
  bakeCartridge, hydrateNode, childrenOf,
  portAnchorOf, mintLandfall,
  planJourney, legTravelOptions, runTravel, mulberry32,
  generateDungeon,
  settlementLayout, bindSettlement,
} from '../../index.js';
import { installMiniCanvasPolyfill } from './mini-canvas.mjs';
import { buildEpub } from '../../src/output/epub.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = Number(process.argv[2] ?? 1234);

const key = process.env.OPENROUTER_API_KEY ?? null;
const complete = key
  ? ({ tier, schema, prompt }) => chatCompletion({ key }, { tier, schema, messages: [{ role: 'user', content: prompt }] })
  : null;

const log = (msg) => console.log(`  ${msg}`);
console.log(`Generating world seed=${SEED} ${key ? '(model-hydrated)' : '(procedural fallback only — set OPENROUTER_API_KEY for prose)'}`);

// hydrateNode's post-conditions check REFERENCES (does this id exist?), not
// completeness — a model that drops a required field despite the schema's
// `strict: true` hint (this free tier does, occasionally) sails through with
// that field simply undefined. Any real host needs this same defence; merge
// the result over a known-good fallback so a missing field reads as
// deterministic prose instead of "undefined" in the book.
const withDefaults = (result, fallback) => {
  const out = { ...fallback };
  for (const [k, v] of Object.entries(result ?? {})) {
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out;
};

// ── 1. World seed (the top-level premise a title page needs) ────────────────
// Not part of the lore-tree pipeline itself (that starts from a blueprint,
// never names the world) — this is the older top-level generator the README
// documents, run once for a proper title. Same resilience rule as
// hydrateNode: a model that returns nothing usable falls back, never throws.
const legacyBp = buildBlueprint(SEED);
const fallbackWorldSeed = () => ({
  name: `The ${legacyBp.worldArchetype.replace(/\b\w/g, c => c.toUpperCase())}`,
  tone: legacyBp.tone, creation: 'A world newly dreamed; its myths are not yet told.',
  gods: [], redThread: { premise: legacyBp.threatType, hook: 'The threat gathers, unseen.' },
});
let worldSeed = fallbackWorldSeed();
let worldSeedProvisional = true;
if (complete) {
  try {
    const generated = await complete({ tier: 'tiny', schema: WORLD_SEED_SCHEMA, prompt: `Generate the world seed.${worldSeedConstraints(legacyBp)}` });
    if (generated) { worldSeed = generated; worldSeedProvisional = false; }
  } catch { /* fall back below */ }
}
log(`world seed: "${worldSeed.name}"${worldSeedProvisional ? ' (provisional)' : ''}`);

// ── 1b. The red thread — a whole story, not one sentence ────────────────────
// worldSeed.redThread is a two-sentence teaser; RED_THREAD_SCHEMA is the
// actual structure this codebase gives a campaign to unfold from: an
// ordered, prerequisite-chained beats[] (src/narrative/acts.js consumes
// exactly this shape). The fallback is never a placeholder — it derives one
// beat per step of the blueprint's own beatArc (e.g. grimdark's
// omen -> discovery -> betrayal -> sacrifice -> pyrrhic victory), chained by
// id, so the story has real shape even with no model at all.
const fallbackBeats = () => legacyBp.beatArc.map((step, i) => ({
  id: `beat-${i}`,
  dramaticPurpose: `${step[0].toUpperCase()}${step.slice(1)} — ${worldSeed.redThread?.premise ?? legacyBp.threatType} closes in.`,
  targetPlaytimeMinutes: 45,
  prerequisites: i === 0 ? [] : [`beat-${i - 1}`],
  setRequiredFlags: [`beat-${i}-done`],
  preferredLocation: null,
  requiredArchetypes: [],
  successors: i === legacyBp.beatArc.length - 1 ? [] : [`beat-${i + 1}`],
}));
let beats = fallbackBeats();
let beatsProvisional = true;
if (complete) {
  try {
    const generated = await complete({
      tier: 'medium', schema: RED_THREAD_SCHEMA,
      prompt: [
        `Generate the red thread: one beat per step of the story arc, in order.`,
        `World: ${worldSeed.name}. ${worldSeed.redThread?.premise ?? ''} ${worldSeed.redThread?.hook ?? ''}`.trim(),
        beatsHints(legacyBp),
      ].join('\n'),
    });
    if (generated?.beats?.length) { beats = generated.beats; beatsProvisional = false; }
  } catch { /* keep the deterministic fallback */ }
}
log(`red thread: ${beats.length} beats${beatsProvisional ? ' (provisional)' : ''}`);

// ── 2. Bake the genesis: skeleton + lore + slices (phases A, B, D) ──────────
// Deliberately baked WITHOUT the live completer: this free-tier model is slow
// and occasionally rate-limited, and the bake alone is 9 sequential calls
// (2 continents + 7 provinces). Every one already has good deterministic
// prose from its detail-0 hook — hydrateNode's procedural fallback, exactly
// as designed — so the model's budget goes to the handful of calls that
// matter more for the book: the world seed above, and the region, settlement,
// legend and crown below.
const cartridge = await bakeCartridge(SEED, { complete: null });
let geo = cartridge.data.geo;
const { continents, provinces, lore, slices } = cartridge.data;
log(`baked: ${continents.length} continents, ${provinces.length} provinces, ${lore.eras.length} eras, ${lore.legends.length} legends, ${lore.crowns.length} crowns`);

// ── 3. Hydrate one full region + its minted settlement + dungeon (phase C) ──
const homePort = provinces.find(p => geo.nodes[p].parent === continents[0] && geo.nodes[p].port);
const homeRegionId = childrenOf(geo, homePort).find(n => n.kind === 'region').id;
const provinceSlice = slices[homePort];
const regionSlice = deriveBlueprint(provinceSlice, geo.nodes[homeRegionId].seed, 'region');

const regionRun = await hydrateNode(geo, homeRegionId, {
  complete, detail: 2, turn: 1, slice: regionSlice, slices,
  eras: lore.eras, legends: lore.legends,
});
geo = regionRun.geo;
const regionResult = withDefaults(regionRun.result, {
  name: geo.nodes[homeRegionId].name, description: geo.nodes[homeRegionId].hook ?? '',
  rumor: '', adjacentHints: [],
});
log(`region hydrated: ${regionResult.name}${regionRun.provisional ? ' (provisional)' : ''}`);

const settlementId = regionRun.minted.find(id => geo.nodes[id].siteType === 'settlement');
const dungeonId = regionRun.minted.find(id => geo.nodes[id].siteType === 'dungeon');

const settlementRun = await hydrateNode(geo, settlementId, {
  complete, detail: 2, turn: 2, slice: { ...provinceSlice, ...regionSlice }, slices,
  eras: lore.eras, legends: lore.legends,
});
geo = settlementRun.geo;
const settlementResult = withDefaults(settlementRun.result, {
  name: geo.nodes[settlementId].name, description: '', npcs: [], exits: [],
});
log(`settlement hydrated: ${settlementResult.name}${settlementRun.provisional ? ' (provisional)' : ''}`);

// site:dungeon is procedural-only (no schema) — always the deterministic
// fallback; the room-by-room crawl comes from generateDungeon, next.
const dungeonSiteRun = await hydrateNode(geo, dungeonId, { detail: 2, turn: 2, slice: regionSlice });
geo = dungeonSiteRun.geo;

// A small, generic-but-varied content pack. Without one, every room falls
// back to the SAME single { name: 'Chamber', desc: 'A bare stone room.' }
// entry, and the theme's one-sentence atmosphere gets appended to every
// non-entrance/non-vault room identically — which is exactly how a dungeon
// chapter ends up printing the same paragraph six times. generateDungeon
// already supports real per-type variety; this just feeds it some.
const dungeonContent = {
  houseStyles: ['weathered stone', 'sunken timber', 'wind-scoured rock'],
  roomPools: {
    entrance: [{ name: 'The Threshold', desc: 'A {{style}} doorway, its lintel cracked but still standing.' }],
    vault:    [{ name: 'The Vault', desc: 'A sealed chamber built to hold {{treasure}} and nothing else.' }],
    hall:     [
      { name: 'Long Hall', desc: 'A {{style}} hall, its far end lost to shadow.' },
      { name: 'Collapsed Hall', desc: 'Half the ceiling has come down here, burying whatever the hall once led to.' },
      { name: 'Pillared Hall', desc: 'Rows of {{style}} pillars, several of them cracked through.' },
    ],
    corridor: [
      { name: 'Narrow Passage', desc: 'A {{style}} passage, barely shoulder-width.' },
      { name: 'Branching Corridor', desc: 'Three ways forward here, none of them obviously safer.' },
      { name: 'Sloping Passage', desc: 'The floor here tilts downward, and keeps tilting.' },
    ],
    chamber: [
      { name: 'Empty Chamber', desc: 'A {{style}} room, stripped of everything that once furnished it.' },
      { name: 'Cracked Chamber', desc: 'The floor here has split, and something below breathes cold air upward.' },
      { name: 'Round Chamber', desc: 'An oddly circular room; nothing here explains why.' },
    ],
    storage: [
      { name: 'Old Storeroom', desc: 'Shelving lines the walls, mostly collapsed, mostly empty.' },
      { name: 'Ransacked Larder', desc: 'Whatever was stored here was taken — or is still being taken.' },
      { name: 'Sealed Cellar', desc: 'A {{style}} cellar, its door long since forced open by someone else.' },
    ],
    quarters: [
      { name: 'Abandoned Quarters', desc: 'A bed frame, a washbasin, and a door that no longer locks.' },
      { name: "Warden's Room", desc: 'Someone kept watch from here once. The chair still faces the door.' },
      { name: 'Shared Barracks', desc: 'Several bedrolls, none of them recently used.' },
    ],
    shrine: [
      { name: 'Forgotten Shrine', desc: 'A small altar, {{style}}, to a god no one here still names.' },
      { name: 'Defaced Shrine', desc: 'Whatever symbol this shrine once bore has been scratched away.' },
      { name: 'Sunken Shrine', desc: 'The shrine has settled below the level of the floor around it.' },
    ],
  },
  // One extra concrete detail per room, drawn from the same seeded stream —
  // generic enough to fit any theme, specific enough that no two rooms read
  // identically even when their base type repeats.
  dressingFor: () => [
    'A single unlit torch still sits in its bracket.',
    'Something has scratched marks into the doorframe, low to the ground.',
    'The dust here has been disturbed recently.',
    'A draft comes from somewhere that shouldn\'t have one.',
    'Old bloodstains have long since gone black.',
    'A child\'s toy, of all things, lies half-buried in the grit.',
  ],
  treasures: [
    { name: 'a chest of tarnished coin', desc: 'Coin from at least three different mints, none current.' },
    { name: 'a locked iron strongbox', desc: 'Rust has fused the hinges nearly shut.' },
  ],
  keys: [
    { name: 'a corroded brass key', desc: 'Green with age but still solid.' },
    { name: 'a bone-carved key', desc: 'Carved from something that was once alive.' },
  ],
  loot: [
    { name: 'a handful of loose coin', desc: 'Not much, but not nothing.' },
    { name: 'a half-burned letter', desc: 'Too damaged to read more than a few words.' },
  ],
  domainTreasures: {}, domainKeys: {},
  enemyName: (id) => id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
  enemyIntro: (id, name, style) => `${name} rises from the ${style} dark, hostile.`,
};

const statBlockFor = (id, { isBoss = false } = {}) => ({ cr: isBoss ? 4 : 1, hp: isBoss ? 60 : 11, ac: isBoss ? 15 : 12 });
const dungeonCrawl = generateDungeon(geo.nodes[dungeonId].seed, {
  blueprint: { dungeonTheme: regionSlice.dungeonTheme, godDomains: slices.world?.godDomains ?? [] },
  statBlockFor,
  content: dungeonContent,
});
log(`dungeon crawl generated: ${Object.keys(dungeonCrawl.rooms).length} rooms, ${Object.keys(dungeonCrawl.npcs).length} inhabitant(s)`);

// ── 4. Hydrate a legend and a crown (phase B/C) ──────────────────────────────
const legendStub = lore.legends.find(l => l.sites.includes(homePort)) ?? lore.legends[0];
const continentSlice = slices[continents[0]];
const legendRun = await hydrateNode(geo, legendStub.id, {
  entity: { ...legendStub, kind: 'legend' }, complete, turn: 1,
  slice: { ...slices.world, ...continentSlice }, eras: lore.eras, legends: lore.legends,
});
const legendResult = withDefaults(legendRun.result, {
  title: legendStub.title, kernelOfTruth: 'more true than anyone repeating it believes',
  payoff: 'what was buried is still there',
  hooks: legendStub.hooks?.length ? legendStub.hooks : ['ask about it in any harbor tavern'],
});
log(`legend hydrated: "${legendResult.title}"`);

const crownStub = lore.crowns.find(c => c.id === `${homePort}.crown`);
const crownRun = await hydrateNode(geo, crownStub.id, {
  entity: { ...crownStub, kind: 'crown' }, complete, turn: 1, slice: provinceSlice,
});
const crownResult = withDefaults(crownRun.result, {
  name: crownStub.name, title: crownStub.title, stanceOnThreat: 'undeclared', factionRelations: [],
});
log(`crown hydrated: ${crownResult.name}, ${crownResult.title}`);

// ── 5. Plan and sample a crossing to the far continent (phase F) ────────────
// Sea lanes connect PROVINCES, not regions — a region only has edges to its
// siblings within the same province (mintProvinceRegions), so routing must
// happen at the province level; portAnchorOf's harbor region is where the
// book says the ship actually ties up, not a routable waypoint.
const farProvince = provinces.find(p => geo.nodes[p].parent === continents[1]);
const { geo: farGeo, anchor: farAnchor } = portAnchorOf(geo, farProvince);
geo = farGeo;
const plan = planJourney(geo, homePort, farProvince, { capabilities: { sea: true } });
log(`crossing planned: ${plan.totalDays} day(s), ${plan.legs.length} leg(s), ${plan.totalSegments} segment(s)`);
const crossingLog = plan.legs.map((leg, i) => ({
  leg, events: runTravel(leg.to, mulberry32(SEED + i), legTravelOptions(leg)).events,
}));

// Landfall: a SECOND far province, reached by air — no port, no road, no
// warning. Distinct from the sea-anchored arrival above.
const landingCandidates = provinces.filter(p => geo.nodes[p].parent === continents[1] && p !== farProvince);
const landingProvince = landingCandidates[0] ?? farProvince;
// mintLandfall mints TWO nodes: the landfall region itself, and a child
// site:landfall node — hydrate `site`, not `landfall`. The region resolves
// to the region template (a real, valid, but WRONG hydration here: its
// description/digest all derive from the same hook the site's own digest
// carries, which is how a book ends up printing one arrival's hook twice).
const { geo: landedGeo, landfall, site: landfallSite } = mintLandfall(geo, landingProvince, { via: 'air' });
geo = landedGeo;
const landfallRun = await hydrateNode(geo, landfallSite, { detail: 2, turn: 1, slice: slices[landingProvince] });
const landfallRegionName = geo.nodes[landfall].name;
const landfallResult = {
  // The site's own node name is the fixed generic label 'the landing', and
  // its template fallback bakes that SAME generic label into `digest` too
  // ("the landing — a landing where no road ever led") — the REGION carries
  // the actual place name. Override both fields outright rather than
  // defaulting: withDefaults would keep the site's non-empty-but-wrong
  // values, since it only falls through to a default when the result's own
  // field is empty.
  ...withDefaults(landfallRun.result, {
    hook: geo.nodes[landfall].hook ?? 'no jetty, no path, no footprints',
  }),
  name: landfallRegionName,
  digest: `${landfallRegionName} — a landing where no road ever led`,
};
log(`landfall minted: ${landfallResult.name} — "${landfallResult.hook}"`);

// ── 6. Lay out the settlement's streets and bind its cast (phase G) ─────────
const layout = settlementLayout(geo.nodes[settlementId].seed, { kind: 'town', buildings: regionSlice.buildingTypes });
const bindings = bindSettlement(layout, settlementResult);
log(`settlement laid out: ${layout.plots.length} plots, ${bindings.npcBindings.length} NPC(s) placed`);

// ── Assemble the example JSON ────────────────────────────────────────────────
const output = {
  seed: SEED,
  generatedAt: new Date().toISOString(),
  hydratedByModel: Boolean(key),
  worldSeed: { provisional: worldSeedProvisional, ...worldSeed },
  redThread: { provisional: beatsProvisional, beats },
  cartridge: { v: cartridge.v, digest: cartridge.c, continents, provinces, lore, slices, outlines: cartridge.data.outlines },
  hydrated: {
    region: { id: homeRegionId, provisional: regionRun.provisional, ...regionResult },
    settlement: { id: settlementId, provisional: settlementRun.provisional, ...settlementResult },
    dungeonSite: { id: dungeonId, ...dungeonSiteRun.result },
    legend: { provisional: legendRun.provisional, ...legendResult },
    crown: { provisional: crownRun.provisional, ...crownResult },
    landfall: { id: landfall, provisional: landfallRun.provisional, ...landfallResult },
  },
  dungeonCrawl,
  crossing: { plan, log: crossingLog, harborRegion: farAnchor },
  layout: { settlement: layout, bindings },
};

// ── Formatters: the same generated data, read as prose ───────────────────────
const fmtDungeon = (crawl, theme) => {
  const lines = [`A ${theme ?? 'nameless'} dungeon of ${Object.keys(crawl.rooms).length} rooms.`, ''];
  for (const room of Object.values(crawl.rooms)) {
    const tag = room.id === crawl.exitRoomId ? ' — the vault' : '';
    lines.push(`${room.name}${tag}: ${room.description}`);
  }
  const boss = crawl.npcs.boss;
  const rest = Object.values(crawl.npcs).filter(n => n.id !== 'boss');
  lines.push('');
  if (boss) lines.push(`Guarding the vault: ${boss.name} (CR ${boss.cr}, ${boss.hp} hp).`);
  if (rest.length) {
    // Two of the same creature is completely legitimate content (a small
    // pool re-picked per room); "Crocodile, Crocodile" just reads oddly as
    // prose. Count instead of listing the name twice.
    const counts = new Map();
    for (const n of rest) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
    const named = [...counts].map(([name, n]) => n > 1 ? `${name} (x${n})` : name);
    lines.push(`Elsewhere: ${named.join(', ')}.`);
  }
  return lines.join('\n');
};

const fmtSettlement = (settlement, layout, bindings) => {
  const nExits = settlement.exits?.length ?? 0;
  const gateLine = `${layout.plots.length} plots along the high street and its lanes` +
    (nExits ? `; ${nExits} way(s) out through the gate.` : ', the gate opening onto a road not yet named.');
  const lines = [settlement.description, '', gateLine, ''];
  const npcs = settlement.npcs ?? [];
  if (!npcs.length) lines.push('No one is named here yet.');
  for (const npc of npcs) {
    const b = bindings.npcBindings.find(x => x.npcId === npc.id);
    const where = b?.building ? ` at the ${b.building}` : '';
    lines.push(`${npc.name}, ${npc.role}${where}: "${npc.greeting}"`);
  }
  return lines.join('\n');
};

const fmtCrossing = (plan, crossingLog, harborName) => {
  const lines = [
    `${plan.totalDays} day(s) by ${plan.mode}, in ${plan.legs.length} leg(s), bound for the harbor at ${harborName}.`,
    '',
  ];
  for (const { leg, events } of crossingLog) {
    lines.push(`${leg.mode} leg — ${leg.from} to ${leg.to}: ${leg.days} day(s), ${leg.segments} segment(s).`);
    for (const e of events) {
      if (e.type === 'encounter') lines.push('  An encounter finds them.');
      else if (e.type === 'discovery') lines.push(`  A discovery: ${e.discovery}.`);
      else if (e.type === 'depart') lines.push(`  They put out for ${e.destination}.`);
      else if (e.type === 'arrive') lines.push(`  They make landfall.`);
    }
  }
  return lines.join('\n');
};

const fmtLegend = (l) => [l.kernelOfTruth, '', l.hooks?.length ? `They say: ${l.hooks.join(' · ')}` : '', '', l.payoff].filter(Boolean).join('\n');
// Capitalize both sentences independently — stanceOnThreat is free text from
// the model (or the 'undeclared' fallback) and isn't guaranteed to arrive
// capitalized; without this a lowercase model answer reads as a typo
// straight after the period.
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const fmtCrown = (c) => `${cap(c.legitimacy)}. ${cap(c.stanceOnThreat)}`;

const continentOutline = cartridge.data.outlines[continents[0]];
const fmtRedThread = (beats) => {
  const lines = [`${beats.length} beats carry the story from here, each opened by what came before it.`, ''];
  for (const b of beats) {
    const gate = b.prerequisites?.length ? `after ${b.prerequisites.join(', ')}` : 'opens the thread';
    const needs = b.requiredArchetypes?.length ? ` Needs: ${b.requiredArchetypes.map(a => a.role).join(', ')}.` : '';
    lines.push(`${b.id} (${gate}) — ${b.dramaticPurpose}${needs}`);
  }
  return lines.join('\n');
};

// The region and the settlement inside it can legitimately share a name (the
// model named both "Ironvale" once) — disambiguate the headings so two
// consecutive chapters don't read as an accidental duplicate.
const settlementHeading = settlementResult.name === regionResult.name
  ? `${settlementResult.name} (the settlement)` : settlementResult.name;

const chapters = [
  {
    heading: worldSeed.name,
    text: [
      worldSeed.creation,
      `Tone: ${worldSeed.tone}. ${worldSeed.redThread?.premise ?? ''} ${worldSeed.redThread?.hook ?? ''}`.trim(),
      `${lore.eras.length} ages are remembered, oldest first: ${lore.eras.map(e => e.name).join(', ')}.`,
    ].filter(Boolean).join('\n\n'),
  },
  { heading: 'The Red Thread', text: fmtRedThread(beats) },
  {
    heading: geo.nodes[continents[0]].name,
    // MENACE_SIGNPOSTS, not menaceHints() — the latter appends a clause
    // meant to steer a generator ("...never state a tier or adjust any
    // creature"), which has no business in reader-facing prose.
    text: [continentOutline?.digest ?? geo.nodes[continents[0]].hook, MENACE_SIGNPOSTS[continentSlice.menace]].filter(Boolean).join('\n\n'),
  },
  {
    heading: regionResult.name,
    // The region template's own procedural fallback builds description AS
    // "name. hook" and rumor as the bare hook — so rumor is always a
    // substring of description there, not just occasionally equal to it.
    // Harmless as data; printing it a second time right below reads as a
    // bug even though it isn't one. Only show rumor when it adds something.
    text: [regionResult.description, regionResult.rumor && !regionResult.description.includes(regionResult.rumor) ? regionResult.rumor : null]
      .filter(Boolean).join('\n\n'),
  },
  { heading: settlementHeading, text: fmtSettlement(settlementResult, layout, bindings) },
  { heading: `Beneath ${regionResult.name}`, text: fmtDungeon(dungeonCrawl, regionSlice.dungeonTheme) },
  { heading: legendResult.title, text: fmtLegend(legendResult) },
  { heading: `${crownResult.name}, ${crownResult.title}`, text: fmtCrown(crownResult) },
  { heading: 'The Crossing', text: fmtCrossing(plan, crossingLog, geo.nodes[farAnchor]?.name ?? geo.nodes[farProvince].name) },
  { heading: `Landfall: ${landfallResult.name}`, text: [landfallResult.hook, landfallResult.digest].filter(Boolean).join('\n\n') },
];

// ── Export: the data, and a book read from it ────────────────────────────────
installMiniCanvasPolyfill();
const epubBlob = await buildEpub({
  title: worldSeed.name,
  // Short by design: unlike the title and tagline, epub.js's cover renderer
  // draws the subtitle as a single unwrapped line — and mini-canvas.mjs's
  // bitmap font is monospace (wider per character than a real proportional
  // face), so a long subtitle overflows the 600px cover here in a way it
  // likely wouldn't in a real browser.
  subtitle: `A world bible - seed ${SEED}`,
  lang: 'en',
  chapters,
  tone: worldSeed.tone,
  tagline: worldSeed.redThread?.hook ?? '',
  brand: 'bag of holding',
});
const epubBytes = new Uint8Array(await epubBlob.arrayBuffer());

const jsonPath = join(HERE, `world-${SEED}.json`);
const epubPath = join(HERE, `world-${SEED}.epub`);
const json = JSON.stringify(output, null, 2);
await writeFile(jsonPath, json);
await writeFile(epubPath, epubBytes);

console.log(`\nwrote ${jsonPath} (${(json.length / 1024).toFixed(1)} kB)`);
console.log(`wrote ${epubPath} (${(epubBytes.length / 1024).toFixed(1)} kB)`);
