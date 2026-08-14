// src/worldgen/lore.js — the tree's inhabitants (doc 18 §4, phase B).
//
// Crowns, legends, and eras exist *before* the player needs them: minted as
// stubs at genesis (names + bindings, no prose) and hydrated like places.
// Everything here is pure and seeded — one LLM call is never made. The stubs
// carry exactly enough to be referenced (an id, a name, what they bind to);
// hydration templates (phase C) fill in the rest.
//
// All tables are invented names only — same rule as every other table
// (docs/legal.md in the kernel repo), enforced by tests/legal.test.js.

import { mulberry32, pick, pickN, randInt } from './rng.js';
import { SYLLABLES } from './skeleton.js';

// ─── Tables ──────────────────────────────────────────────────────────────────

export const ERA_NAMES = Object.freeze([
  'the Age of Founding Kings', 'the Long Thaw', 'the Age of Salt and Iron',
  'the Broken Compact', 'the Quiet Roads', 'the Second Sowing',
  'the Lantern Wars', 'the Sundered Court', 'the Age of Deep Bells',
  'the White Harvest',
]);

export const LEGEND_TITLE_A = Object.freeze([
  'The Drowned', 'The Salt', 'The Hollow', 'The Last', 'The Sleeping',
  'The Iron', 'The Pale', 'The Unnumbered', 'The Broken', 'The Whispering',
]);
export const LEGEND_TITLE_B = Object.freeze([
  'Bell', 'Crown', 'Column', 'Fleet', 'King', 'Choir', 'Gate', 'Vigil',
  'Orchard', 'Tithe',
]);

export const CROWN_TITLES = Object.freeze([
  'High Sovereign', 'Warden-Regent', 'Marchion', 'Tide-Throne',
  'Elder Speaker', 'Keeper of the Long Table', 'First Reeve', 'Storm Warden',
]);

export const LEGITIMACIES = Object.freeze([
  'settled', 'contested', 'usurped', 'failing', 'newly crowned',
]);

// ─── Minters ─────────────────────────────────────────────────────────────────

// 3–5 named epochs, oldest first. Every legend, ruin, and landmark carries an
// era tag — what makes "its roads are older than its towns" checkable.
export function mintEras(seed, { count = null } = {}) {
  const rng = mulberry32((seed ?? 1) >>> 0);
  const n = count ?? randInt(3, 5, rng);
  return pickN(ERA_NAMES, n, rng).map((name, i) => ({
    id: `era-${i}`, name, order: i, stub: true,
  }));
}

// 2–3 legends per continent, each bound to real province ids. The explorer's
// dividend: the continent's first port province always appears in at least
// one legend's sites, so whatever shore a wanderer lands on, the acts engine
// has something real to bind to.
export function mintLegendStubs(continentId, seed, { provinces, firstPort, eras, count = null } = {}) {
  const rng = mulberry32(((seed ?? 1) + 101) >>> 0);
  const n = count ?? randInt(2, 3, rng);
  const legends = [];
  for (let i = 0; i < n; i++) {
    const sites = pickN(provinces, Math.min(provinces.length, randInt(1, 2, rng)), rng);
    legends.push({
      id: `${continentId}.legend-${i}`,
      title: `${pick(LEGEND_TITLE_A, rng)} ${pick(LEGEND_TITLE_B, rng)}`,
      era: eras?.length ? pick(eras, rng).id : null,
      sites, hooks: [], kernelOfTruth: null, payoff: null, stub: true,
    });
  }
  if (firstPort && !legends.some(l => l.sites.includes(firstPort))) {
    legends[0].sites.push(firstPort);
  }
  return legends;
}

// One crown per province: a dynasty name in the continent's syllable culture,
// a title, and how firmly it sits. Seat and stance are hydration's to fill.
export function mintCrownStub(provinceId, seed, { culture = null } = {}) {
  const rng = mulberry32(((seed ?? 1) + 202) >>> 0);
  const pre = culture?.prefixes ?? SYLLABLES.provincePrefixes;
  const suf = culture?.suffixes ?? SYLLABLES.provinceSuffixes;
  return {
    id: `${provinceId}.crown`,
    name: `House ${pick(pre, rng)}${pick(suf, rng)}`,
    title: pick(CROWN_TITLES, rng),
    legitimacy: pick(LEGITIMACIES, rng),
    seat: null, stanceOnThreat: null, factionRelations: [], stub: true,
  };
}

// Walk a minted skeleton and populate the whole lore layer in one pass.
// Pure: same skeleton + seed → same lore, which is what lets a cartridge
// carry it and a replay reproduce it.
export function mintLore({ geo, continents, provinces }, seed, { eraCount = null } = {}) {
  const eras = mintEras(seed, { count: eraCount });
  const legends = [];
  const crowns = [];
  for (const cId of continents) {
    const cNode = geo.nodes[cId];
    const mine = provinces.filter(p => geo.nodes[p].parent === cId);
    const firstPort = mine.find(p => geo.nodes[p].port) ?? mine[0] ?? null;
    legends.push(...mintLegendStubs(cId, cNode.seed, { provinces: mine, firstPort, eras }));
    for (const pId of mine) {
      crowns.push(mintCrownStub(pId, geo.nodes[pId].seed, { culture: cNode.nameParts }));
    }
  }
  return { eras, legends, crowns };
}
