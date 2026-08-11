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
  buildBlueprint, deriveBlueprint, worldSeedConstraints, menaceHints,
  WORLD_SEED_SCHEMA, chatCompletion,
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
log(`region hydrated: ${regionRun.result.name}${regionRun.provisional ? ' (provisional)' : ''}`);

const settlementId = regionRun.minted.find(id => geo.nodes[id].siteType === 'settlement');
const dungeonId = regionRun.minted.find(id => geo.nodes[id].siteType === 'dungeon');

const settlementRun = await hydrateNode(geo, settlementId, {
  complete, detail: 2, turn: 2, slice: { ...provinceSlice, ...regionSlice }, slices,
  eras: lore.eras, legends: lore.legends,
});
geo = settlementRun.geo;
log(`settlement hydrated: ${settlementRun.result.name}${settlementRun.provisional ? ' (provisional)' : ''}`);

// site:dungeon is procedural-only (no schema) — always the deterministic
// fallback; the room-by-room crawl comes from generateDungeon, next.
const dungeonSiteRun = await hydrateNode(geo, dungeonId, { detail: 2, turn: 2, slice: regionSlice });
geo = dungeonSiteRun.geo;

const statBlockFor = (id, { isBoss = false } = {}) => ({ cr: isBoss ? 4 : 1, hp: isBoss ? 60 : 11, ac: isBoss ? 15 : 12 });
const dungeonCrawl = generateDungeon(geo.nodes[dungeonId].seed, {
  blueprint: { dungeonTheme: regionSlice.dungeonTheme, godDomains: slices.world?.godDomains ?? [] },
  statBlockFor,
  content: { houseStyles: ['weathered stone', 'sunken timber', 'wind-scoured rock'] },
});
log(`dungeon crawl generated: ${Object.keys(dungeonCrawl.rooms).length} rooms, ${Object.keys(dungeonCrawl.npcs).length} inhabitant(s)`);

// ── 4. Hydrate a legend and a crown (phase B/C) ──────────────────────────────
const legendStub = lore.legends.find(l => l.sites.includes(homePort)) ?? lore.legends[0];
const continentSlice = slices[continents[0]];
const legendRun = await hydrateNode(geo, legendStub.id, {
  entity: { ...legendStub, kind: 'legend' }, complete, turn: 1,
  slice: { ...slices.world, ...continentSlice }, eras: lore.eras, legends: lore.legends,
});
log(`legend hydrated: "${legendRun.result.title}"`);

const crownStub = lore.crowns.find(c => c.id === `${homePort}.crown`);
const crownRun = await hydrateNode(geo, crownStub.id, {
  entity: { ...crownStub, kind: 'crown' }, complete, turn: 1, slice: provinceSlice,
});
log(`crown hydrated: ${crownRun.result.name}, ${crownRun.result.title}`);

// ── 5. Plan and sample a crossing to the far continent (phase F) ────────────
const farProvince = provinces.find(p => geo.nodes[p].parent === continents[1]);
const { geo: farGeo, anchor: farAnchor } = portAnchorOf(geo, farProvince);
geo = farGeo;
const plan = planJourney(geo, homeRegionId, farAnchor, { capabilities: { sea: true } });
log(`crossing planned: ${plan.totalDays} day(s), ${plan.legs.length} leg(s), ${plan.totalSegments} segment(s)`);
const crossingLog = plan.legs.map((leg, i) => ({
  leg, events: runTravel(leg.to, mulberry32(SEED + i), legTravelOptions(leg)).events,
}));

// Landfall: a SECOND far province, reached by air — no port, no road, no
// warning. Distinct from the sea-anchored arrival above.
const landingCandidates = provinces.filter(p => geo.nodes[p].parent === continents[1] && p !== farProvince);
const landingProvince = landingCandidates[0] ?? farProvince;
const { geo: landedGeo, landfall } = mintLandfall(geo, landingProvince, { via: 'air' });
geo = landedGeo;
const landfallRun = await hydrateNode(geo, landfall, { detail: 2, turn: 1, slice: slices[landingProvince] });
log(`landfall minted: ${landfallRun.result.name} — "${landfallRun.result.hook}"`);

// ── 6. Lay out the settlement's streets and bind its cast (phase G) ─────────
const layout = settlementLayout(geo.nodes[settlementId].seed, { kind: 'town', buildings: regionSlice.buildingTypes });
const bindings = bindSettlement(layout, settlementRun.result);
log(`settlement laid out: ${layout.plots.length} plots, ${bindings.npcBindings.length} NPC(s) placed`);

// ── Assemble the example JSON ────────────────────────────────────────────────
const output = {
  seed: SEED,
  generatedAt: new Date().toISOString(),
  hydratedByModel: Boolean(key),
  worldSeed: { provisional: worldSeedProvisional, ...worldSeed },
  cartridge: { v: cartridge.v, digest: cartridge.c, continents, provinces, lore, slices, outlines: cartridge.data.outlines },
  hydrated: {
    region: { id: homeRegionId, provisional: regionRun.provisional, ...regionRun.result },
    settlement: { id: settlementId, provisional: settlementRun.provisional, ...settlementRun.result },
    dungeonSite: { id: dungeonId, ...dungeonSiteRun.result },
    legend: { provisional: legendRun.provisional, ...legendRun.result },
    crown: { provisional: crownRun.provisional, ...crownRun.result },
    landfall: { id: landfall, provisional: landfallRun.provisional, ...landfallRun.result },
  },
  dungeonCrawl,
  crossing: { plan, log: crossingLog },
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
  if (rest.length) lines.push(`Elsewhere: ${rest.map(n => n.name).join(', ')}.`);
  return lines.join('\n');
};

const fmtSettlement = (settlement, layout, bindings) => {
  const lines = [settlement.description, '',
    `${layout.plots.length} plots along the high street and its lanes; ${settlement.exits?.length ?? 0} way(s) out through the gate.`, ''];
  for (const npc of settlement.npcs ?? []) {
    const b = bindings.npcBindings.find(x => x.npcId === npc.id);
    const where = b?.building ? ` at the ${b.building}` : '';
    lines.push(`${npc.name}, ${npc.role}${where}: "${npc.greeting}"`);
  }
  return lines.join('\n');
};

const fmtCrossing = (plan, crossingLog) => {
  const lines = [`${plan.totalDays} day(s) by ${plan.mode}, in ${plan.legs.length} leg(s).`, ''];
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
const fmtCrown = (c) => `${c.legitimacy[0].toUpperCase()}${c.legitimacy.slice(1)}. ${c.stanceOnThreat}`;

const continentOutline = cartridge.data.outlines[continents[0]];
const chapters = [
  {
    heading: worldSeed.name,
    text: [
      worldSeed.creation,
      `Tone: ${worldSeed.tone}. ${worldSeed.redThread?.premise ?? ''} ${worldSeed.redThread?.hook ?? ''}`.trim(),
      `${lore.eras.length} ages are remembered, oldest first: ${lore.eras.map(e => e.name).join(', ')}.`,
    ].filter(Boolean).join('\n\n'),
  },
  {
    heading: geo.nodes[continents[0]].name,
    text: [continentOutline?.digest ?? geo.nodes[continents[0]].hook, menaceHints(continentSlice).trim()].filter(Boolean).join('\n\n'),
  },
  { heading: regionRun.result.name, text: [regionRun.result.description, regionRun.result.rumor].filter(Boolean).join('\n\n') },
  { heading: settlementRun.result.name, text: fmtSettlement(settlementRun.result, layout, bindings) },
  { heading: `Beneath ${regionRun.result.name}`, text: fmtDungeon(dungeonCrawl, regionSlice.dungeonTheme) },
  { heading: legendRun.result.title, text: fmtLegend(legendRun.result) },
  { heading: `${crownRun.result.name}, ${crownRun.result.title}`, text: fmtCrown(crownRun.result) },
  { heading: 'The Crossing', text: fmtCrossing(plan, crossingLog) },
  { heading: `Landfall: ${landfallRun.result.name}`, text: [landfallRun.result.hook, landfallRun.result.digest].filter(Boolean).join('\n\n') },
];

// ── Export: the data, and a book read from it ────────────────────────────────
installMiniCanvasPolyfill();
const epubBlob = await buildEpub({
  title: worldSeed.name,
  subtitle: `A world bible generated from seed ${SEED}`,
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
