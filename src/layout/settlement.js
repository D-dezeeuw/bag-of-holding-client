// src/layout/settlement.js — persistent settlement space (doc 18 §10, phase G).
//
// A settlement wears the dungeon's skeleton as the high street and its lanes:
// spine = market row (gate at one end, the square where the vault was),
// branches = side lanes, plots instead of rooms. Pure and seeded from the
// site seed, so walking from the bakery down the lane and left to the butcher
// is the same walk in session forty — the street was never prose, so it
// cannot drift.
//
// Placement is procedural; dressing is the model's. The building list is
// PLACED here deterministically; what the bakery smells like is a hydration
// call. A city is not a bigger graph but a tree of small ones: a district
// graph whose members hydrate lazily like every other node.

import { mulberry32, pick, shuffle, randInt } from '../worldgen/rng.js';
import { generateLayout } from './engine.js';

// The scale ladder. A `city` here is one DENSE settlement graph — the
// district-tree alternative lives in cityLayout below; both are legitimate
// city shapes (a market city is one big street plan, a capital is quarters).
export const SETTLEMENT_SIZES = Object.freeze({
  hamlet:     { spineMin: 2, spineMax: 3, branchMin: 0, branchMax: 1 },
  village:    { spineMin: 3, spineMax: 4, branchMin: 1, branchMax: 3 },
  town:       { spineMin: 4, spineMax: 6, branchMin: 3, branchMax: 5 },
  city:       { spineMin: 8, spineMax: 12, branchMin: 6, branchMax: 10 },
  metropolis: { spineMin: 12, spineMax: 16, branchMin: 10, branchMax: 14 },
});

// Which workplace roles bind to which building types. NPC roles come from
// NPC_SCHEMA's enum; building types from the blueprint tables.
export const ROLE_BUILDINGS = Object.freeze({
  innkeeper:  ['inn', 'tavern'],
  blacksmith: ['blacksmith'],
  merchant:   ['market hall', 'warehouse', 'alchemist shop', 'apothecary', 'bakery', 'brewery'],
  healer:     ['apothecary', 'herbalist hut', 'temple', 'bathhouse'],
  elder:      ['town hall', 'temple'],
  guard:      ['barracks', 'watchtower', 'town hall'],
  questgiver: ['tavern', 'inn', 'town hall'],
  hermit:     [],   // hermits bind nowhere — that is the point of hermits
});

// Lay out one settlement: streets as a graph, buildings placed onto plots.
// Returns { plots, streets, entrance, square, kind } where plots[i] carries
// { id, pos, exits, role: 'gate'|'square'|'plot', building|null }.
export function settlementLayout(seed, { kind = 'village', buildings = [], rng = null, size = null } = {}) {
  const r = rng ?? mulberry32(((typeof seed === 'number' ? seed : 0) + 606) >>> 0);
  // An unknown kind used to degrade to a village SILENTLY — 'city' and every
  // typo shipped five plots and called it a day. Name the ladder instead;
  // a host with its own scale in mind passes `size` overrides on top.
  const row = SETTLEMENT_SIZES[kind];
  if (!row) {
    throw new Error(`settlementLayout: unknown kind ${JSON.stringify(kind)}. Kinds: ${Object.keys(SETTLEMENT_SIZES).join(', ')} (or pass size overrides).`);
  }
  const core = generateLayout(seed, { rng: r, ...row, ...(size ?? {}) });

  const plots = core.positions.map((pos, i) => ({
    id: `plot-${i}`,
    pos,
    role: i === core.entrance ? 'gate' : i === core.focus ? 'square' : 'plot',
    building: null,
    exits: core.adjacency[i].map(a => ({ dir: a.dir, plotId: `plot-${a.target}` })),
  }));

  // Deterministic placement: buildings land on ordinary plots (shuffled by the
  // same stream); overflow gathers on the square — market stalls, not sprawl.
  const open = shuffle(plots.filter(p => p.role === 'plot'), r);
  const overflow = [];
  buildings.forEach((building, i) => {
    if (i < open.length) open[i].building = building;
    else overflow.push(building);
  });
  const square = plots.find(p => p.role === 'square');
  if (square) square.stalls = overflow;

  return { kind, plots, entrance: 'plot-0', square: square?.id ?? null };
}

// A city is a district graph; each district is its own lazily-laid-out
// settlement (site:district in the hydration templates). Stub districts carry
// their own seeds, exactly like skeleton nodes.
export function cityLayout(seed, { districts = null, rng = null } = {}) {
  const r = rng ?? mulberry32(((typeof seed === 'number' ? seed : 0) + 707) >>> 0);
  const n = districts ?? randInt(3, 5, r);
  const QUARTER = ['market', 'harbor', 'temple', 'garrison', 'old town', 'artisan', 'garden', 'shambles'];
  // Past eight districts the quarter names cycle with a numeral ("market II")
  // instead of indexing past the shuffle — which was a TypeError at n ≥ 9.
  const deck = shuffle(QUARTER, r);
  const names = Array.from({ length: n }, (_, i) => {
    const cycle = Math.floor(i / deck.length);
    return cycle === 0 ? deck[i % deck.length] : `${deck[i % deck.length]} ${'I'.repeat(cycle + 1)}`;
  });
  const out = names.map((quarter, i) => ({
    id: `district-${i}`,
    quarter,
    seed: randInt(1, 2 ** 30, r),
    stub: true,
    exits: [],
  }));
  // Chain the districts, then one cross-link so bigger cities aren't a corridor.
  for (let i = 1; i < n; i++) {
    out[i - 1].exits.push({ to: out[i].id });
    out[i].exits.push({ to: out[i - 1].id });
  }
  if (n >= 4) {
    out[0].exits.push({ to: out[n - 1].id });
    out[n - 1].exits.push({ to: out[0].id });
  }
  return { kind: 'city', districts: out };
}

// Bind a hydrated settlement (SETTLEMENT_SCHEMA shape) onto its layout:
// gates carry the schema's exits, workplace NPCs resolve to plots that carry
// their building. Post-condition style — violations coerce, never reject:
// an unmatched NPC binds to the square (everyone drinks somewhere).
export function bindSettlement(layout, settlement) {
  const gates = [];
  const gatePlots = layout.plots.filter(p => p.role === 'gate');
  (settlement?.exits ?? []).forEach((exit, i) => {
    const plot = gatePlots[i % Math.max(1, gatePlots.length)] ?? null;
    gates.push({ exit, plotId: plot?.id ?? layout.entrance });
  });

  const npcBindings = [];
  const coerced = [];
  for (const npc of settlement?.npcs ?? []) {
    const wanted = ROLE_BUILDINGS[npc.role] ?? [];
    const plot = layout.plots.find(p => p.building && wanted.includes(p.building));
    if (plot) {
      npcBindings.push({ npcId: npc.id, plotId: plot.id, building: plot.building });
    } else if (wanted.length === 0) {
      npcBindings.push({ npcId: npc.id, plotId: null, building: null }); // unhoused by design
    } else {
      npcBindings.push({ npcId: npc.id, plotId: layout.square ?? layout.entrance, building: null });
      coerced.push({ npcId: npc.id, wanted });
    }
  }
  return { gates, npcBindings, coerced };
}
