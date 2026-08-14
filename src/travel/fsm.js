// src/travel/fsm.js — pure overworld travel state machine.
//
// Phases: departing → traveling (N segments) → arriving → arrived. Each
// `traveling` step rolls one event (encounter / discovery / uneventful). Pure +
// rng-injected; the host narrates each step, runs encounters, and applies
// discoveries. `pickEncounter` draws a creature id from a host-supplied pool.

export const TRAVEL_SEGMENTS_MIN = 2;
export const TRAVEL_SEGMENTS_MAX = 3;
export const ENCOUNTER_CHANCE    = 0.4;
export const DISCOVERY_CHANCE     = 0.35;

export const DISCOVERY_TYPES = ['loot', 'wanderer', 'shrine', 'clue'];

// The options bag is doc 18 §9's shim: `segments` (from a planJourney leg)
// and `mode` override the legacy defaults; the no-opts call is byte-identical
// to before — the adoptFlatWorld precedent, never strand an in-flight host.
export function beginTravel(destination, rng = Math.random, { segments = null, mode = null } = {}) {
  const span     = TRAVEL_SEGMENTS_MAX - TRAVEL_SEGMENTS_MIN + 1;
  const n        = segments ?? (TRAVEL_SEGMENTS_MIN + Math.floor(rng() * span));
  const t = { phase: 'departing', destination, segment: 0, segments: n, log: [], done: false };
  if (mode) t.mode = mode;
  return t;
}

export function isTravelDone(travel) {
  return !travel || travel.phase === 'arrived' || travel.done === true;
}

export function stepTravel(travel, rng = Math.random, opts = {}) {
  const t = { ...travel, log: [...(travel.log ?? [])] };

  if (t.phase === 'departing') {
    t.phase = 'traveling';
    return { travel: t, event: { type: 'depart', destination: t.destination } };
  }

  if (t.phase === 'traveling') {
    t.segment += 1;
    let event;
    // Per-mode tuning arrives via opts (see travel/modes.js) — an ocean
    // crossing rolls storms at sea rates, not road rates. Defaults unchanged.
    const encounterChance = opts.encounterChance ?? ENCOUNTER_CHANCE;
    const discoveryChance = opts.discoveryChance ?? DISCOVERY_CHANCE;
    const discoveryTypes  = opts.discoveryTypes ?? DISCOVERY_TYPES;
    if (opts.safe) {
      event = { type: 'uneventful' };
    } else {
      const roll = rng();
      if (roll < encounterChance) {
        event = { type: 'encounter' };
      } else if (roll < encounterChance + discoveryChance) {
        const d = discoveryTypes[Math.floor(rng() * discoveryTypes.length)];
        event = { type: 'discovery', discovery: d };
      } else {
        event = { type: 'uneventful' };
      }
    }
    t.log.push(event.type === 'discovery' ? `discovery:${event.discovery}` : event.type);
    if (t.segment >= t.segments) t.phase = 'arriving';
    return { travel: t, event };
  }

  if (t.phase === 'arriving') {
    t.phase = 'arrived';
    t.done = true;
    return { travel: t, event: { type: 'arrive', destination: t.destination, ...(t.mode ? { mode: t.mode } : {}) } };
  }

  return { travel: { ...t, done: true }, event: { type: 'arrive', destination: t.destination, ...(t.mode ? { mode: t.mode } : {}) } };
}

export function pickEncounter(pool, rng = Math.random) {
  if (!pool || !pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

export function runTravel(destination, rng = Math.random, opts = {}) {
  let travel = beginTravel(destination, rng, opts);
  const events = [];
  for (let i = 0; i < 64 && !isTravelDone(travel); i++) {
    const res = stepTravel(travel, rng, opts);
    travel = res.travel;
    events.push(res.event);
  }
  return { travel, events };
}
