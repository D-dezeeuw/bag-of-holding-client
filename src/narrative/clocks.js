// src/narrative/clocks.js — the world moves while you are elsewhere (Epic E6.S3).
//
// A campaign where nothing happens unless the player is watching is a set of
// rooms, not a world. Clocks are the cheapest honest simulation: a named
// project with N segments that fills as chapters pass, and fires consequences
// when full. A faction plots, a threat festers, a siege closes in.
//
// Deliberately not a tick-per-turn simulation — that would be expensive and
// noisy. Clocks advance at chapter boundaries and on player action, so the
// world's movement lands as news between scenes rather than interrupting one.
//
// Pure: the host owns storage and decides what a fired clock does with the
// patches it hands back.

export function makeClock({ id, label, owner = null, segments = 4, filled = 0, onFill = [] }) {
  if (!id)                      throw new Error('a clock needs an id');
  if (!Number.isInteger(segments) || segments < 1) throw new Error('segments must be a positive integer');
  return { id, label, owner, segments, filled: Math.min(filled, segments), onFill, fired: false };
}

export function isFull(clock) { return clock.filled >= clock.segments; }

// Advance (or wind back, with a negative amount). Returns the clock and whether
// this call is the one that filled it — callers fire consequences exactly once.
// "Just filled" means "full and not yet fired", not "crossed the threshold on
// this call": a clock CREATED already full (migrated state, a host that clamps)
// used to sit at 'breaking' forever without its consequences ever firing.
export function advance(clock, amount = 1) {
  if (clock.fired) return { clock, justFilled: false };
  const filled = Math.max(0, Math.min(clock.segments, clock.filled + amount));
  const next   = { ...clock, filled };
  const justFilled = filled >= clock.segments;
  return { clock: justFilled ? { ...next, fired: true } : next, justFilled };
}

// Advance every clock a step, returning the updated set plus the ones that just
// filled. `pressure` lets the host push specific clocks harder — a threat the
// player keeps ignoring, a faction whose plans they keep helping.
export function tickAll(clocks, { amount = 1, pressure = {} } = {}) {
  const out   = [];
  const fired = [];
  for (const c of clocks) {
    const step = pressure[c.id] ?? amount;
    const { clock, justFilled } = advance(c, step);
    out.push(clock);
    if (justFilled) fired.push(clock);
  }
  return { clocks: out, fired };
}

// How close a clock is, as prose the narrator and rumour system can use without
// exposing the mechanism. Players should feel a clock, never read it.
export function clockMood(clock) {
  const ratio = clock.filled / clock.segments;
  if (clock.fired) return 'resolved';
  if (ratio >= 1)    return 'breaking';
  if (ratio >= 0.75) return 'imminent';
  if (ratio >= 0.5)  return 'building';
  if (ratio > 0)     return 'stirring';
  return 'quiet';
}

// The clocks worth mentioning in a region digest or a tavern rumour: anything
// past halfway, most urgent first.
export function pressingClocks(clocks, { limit = 3 } = {}) {
  return [...clocks]
    .filter(c => !c.fired && c.filled / c.segments >= 0.5)
    .sort((a, b) => (b.filled / b.segments) - (a.filled / a.segments))
    .slice(0, limit)
    .map(c => ({ id: c.id, label: c.label, owner: c.owner, mood: clockMood(c) }));
}
