// src/travel/planner.js — the journey planner (doc 18 §9, phase F).
//
// The FSM stays free-standing (a destination and a segment count); this is
// the layer that gives those segments meaning. planJourney routes over the
// geography with the party's capabilities, splits the path into legs at mode
// changes and port stops, and prices each leg in days → segments. Travel days
// are also the world's clock ticks: applyTravelClocks feeds them to the
// narrative clocks so the diegetic cost and the moving world are one
// mechanism, not two.

import { routeBetween, neighbours } from '../worldgen/geography.js';
import { tickAll } from '../narrative/clocks.js';
import { TRAVEL_MODES } from './modes.js';
import { TRAVEL_SEGMENTS_MIN } from './fsm.js';

const edgeBetween = (geo, a, b) =>
  neighbours(geo, a).find(n => n.id === b) ?? null;

const segmentsFor = (days, mode) =>
  Math.max(TRAVEL_SEGMENTS_MIN, Math.ceil(days / (mode.daysPerSegment ?? 1)));

/**
 * Plan a journey from `fromId` to `toId`.
 *
 *   capabilities: { sea?: boolean, air?: boolean, gate?: boolean } — what
 *     the party can do. A ship is a capability, not a simulation: how they
 *     got it is the economy's and the kernel's business. `gate` is the
 *     waygate attunement (the quest reward); even with it, a gate edge only
 *     opens between endpoints the party has DISCOVERED — the D&D "you must
 *     have seen the circle" rule as data.
 *   maxSegmentsPerLeg: long crossings split into legs (diegetic resupply,
 *     and each leg restarts the promote-on-departure latency budget).
 *
 * Returns { legs: [{ from, to, mode, days, segments, path, costHint }],
 * totalDays, totalSegments, mode } or null when no traversable route
 * exists. Air is priced off the underlying route's days × airFactor —
 * nodes have no coordinates, deliberately (doc 18 §9): flight is faster,
 * never free. Each leg's `costHint` is its mode's pricing shape (sea
 * passage per day, gate toll) for the economy layer to turn into gold.
 */
export function planJourney(geo, fromId, toId, {
  modes = TRAVEL_MODES,
  capabilities = {},
  maxSegmentsPerLeg = 8,
} = {}) {
  if (!geo?.nodes[fromId] || !geo?.nodes[toId]) return null;

  const gateOpen = (edge) =>
    capabilities.gate === true &&
    geo.nodes[edge.edgeFrom]?.discovered === true &&
    geo.nodes[edge.edgeTo]?.discovered === true;

  // Flight: any land/sea edge is traversable from above; days shrink by the
  // factor. Gates are not overflown — they are stepped through or not.
  if (capabilities.air) {
    const route = routeBetween(geo, fromId, toId, { traversable: (e) => e.kind !== 'gate' });
    if (!route) return null;
    const air = modes.air ?? TRAVEL_MODES.air;
    const days = Math.max(1, Math.ceil(route.days * (air.airFactor ?? 0.5)));
    const legs = splitLeg({ from: fromId, to: toId, mode: 'air', days, path: route.path }, air, maxSegmentsPerLeg);
    return summarize(withCosts(legs, modes), 'air');
  }

  const traversable = (edge) => {
    if (edge.kind === 'sea') return capabilities.sea === true;
    if (edge.kind === 'gate') return gateOpen(edge);
    return true;
  };
  const route = routeBetween(geo, fromId, toId, { traversable });
  if (!route) return null;

  // Walk the path, cutting a new leg whenever the edge kind's mode changes.
  const legs = [];
  let cur = null;
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1], b = route.path[i];
    const edge = edgeBetween(geo, a, b);
    const mode = edge?.kind === 'sea' ? 'sea' : edge?.kind === 'gate' ? 'gate' : 'road';
    if (!cur || cur.mode !== mode) {
      if (cur) legs.push(cur);
      cur = { from: a, to: b, mode, days: 0, path: [a] };
    }
    cur.days += edge?.days ?? 1;
    cur.to = b;
    cur.path.push(b);
  }
  if (cur) legs.push(cur);

  const sized = withCosts(
    legs.flatMap(leg => splitLeg(leg, modes[leg.mode] ?? TRAVEL_MODES.road, maxSegmentsPerLeg)),
    modes);
  const headline = sized.some(l => l.mode === 'gate') ? 'gate'
    : sized.some(l => l.mode === 'sea') ? 'sea' : 'road';
  return summarize(sized, headline);
}

function withCosts(legs, modes) {
  return legs.map(leg => ({
    ...leg,
    costHint: (modes[leg.mode] ?? TRAVEL_MODES[leg.mode])?.costHint ?? null,
  }));
}

function splitLeg(leg, mode, maxSegmentsPerLeg) {
  const segments = segmentsFor(leg.days, mode);
  if (segments <= maxSegmentsPerLeg) return [{ ...leg, segments }];
  if (leg.path.length > 2) {
    // Split at path waypoints (port stops on a sea chain, towns on a road):
    // near-equal day halves, recursively, so no single leg outruns its budget.
    const midIndex = Math.max(1, Math.floor(leg.path.length / 2));
    const mid = leg.path[midIndex];
    const half = Math.ceil(leg.days / 2);
    return [
      ...splitLeg({ from: leg.from, to: mid, mode: leg.mode, days: half, path: leg.path.slice(0, midIndex + 1) }, mode, maxSegmentsPerLeg),
      ...splitLeg({ from: mid, to: leg.to, mode: leg.mode, days: leg.days - half, path: leg.path.slice(midIndex) }, mode, maxSegmentsPerLeg),
    ];
  }
  // A single edge longer than the budget has no waypoint to cut at — an
  // ocean crossing is one edge however many days it takes. Split by DAYS
  // instead: every chunk keeps the real endpoints (used to recurse into
  // path[1] of a one-node path and emit legs with `from: undefined`).
  const daysCap = Math.max(1, maxSegmentsPerLeg * (mode.daysPerSegment ?? 1));
  const chunks = [];
  for (let remaining = leg.days; remaining > 0; remaining -= daysCap) {
    const days = Math.min(daysCap, remaining);
    chunks.push({ ...leg, days, segments: segmentsFor(days, mode) });
  }
  return chunks;
}

function summarize(legs, mode) {
  return {
    legs,
    mode,
    totalDays: legs.reduce((d, l) => d + l.days, 0),
    totalSegments: legs.reduce((s, l) => s + l.segments, 0),
  };
}

// The per-leg FSM options: segments + the mode's event tuning, ready to hand
// to beginTravel/runTravel.
export function legTravelOptions(leg, { modes = TRAVEL_MODES } = {}) {
  const mode = modes[leg.mode] ?? TRAVEL_MODES.road;
  return {
    segments: leg.segments,
    mode: leg.mode,
    encounterChance: mode.encounterChance,
    discoveryChance: mode.discoveryChance,
    discoveryTypes: mode.discoveryTypes,
  };
}

// Travel days feed the clocks: the contested succession at home advances
// BECAUSE the party spent eight days at sea. Days scale down to ticks
// (default 4 days per segment) — clocks are 4-8 segments and meant to fill
// across a campaign arc, not one crossing. Returns tickAll's shape.
export function applyTravelClocks(clocks, plan, { daysPerTick = 4, pressure = {} } = {}) {
  const amount = Math.floor((plan?.totalDays ?? 0) / Math.max(1, daysPerTick));
  return tickAll(clocks, { amount, pressure });
}
