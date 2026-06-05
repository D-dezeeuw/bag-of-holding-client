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

export function beginTravel(destination, rng = Math.random) {
  const span     = TRAVEL_SEGMENTS_MAX - TRAVEL_SEGMENTS_MIN + 1;
  const segments = TRAVEL_SEGMENTS_MIN + Math.floor(rng() * span);
  return { phase: 'departing', destination, segment: 0, segments, log: [], done: false };
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
    if (opts.safe) {
      event = { type: 'uneventful' };
    } else {
      const roll = rng();
      if (roll < ENCOUNTER_CHANCE) {
        event = { type: 'encounter' };
      } else if (roll < ENCOUNTER_CHANCE + DISCOVERY_CHANCE) {
        const d = DISCOVERY_TYPES[Math.floor(rng() * DISCOVERY_TYPES.length)];
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
    return { travel: t, event: { type: 'arrive', destination: t.destination } };
  }

  return { travel: { ...t, done: true }, event: { type: 'arrive', destination: t.destination } };
}

export function pickEncounter(pool, rng = Math.random) {
  if (!pool || !pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

export function runTravel(destination, rng = Math.random, opts = {}) {
  let travel = beginTravel(destination, rng);
  const events = [];
  for (let i = 0; i < 64 && !isTravelDone(travel); i++) {
    const res = stepTravel(travel, rng, opts);
    travel = res.travel;
    events.push(res.event);
  }
  return { travel, events };
}
