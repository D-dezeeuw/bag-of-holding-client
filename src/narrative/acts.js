// src/narrative/acts.js — the layer that makes a red thread long enough (E7).
//
// The generated red thread was 3–5 beats at 30–90 minutes each: by the prompt's
// own arithmetic, 1.5 to 7.5 hours of story for an 80-hour campaign. It was
// also linear, had no failure states, no binding to real people or places, and
// no ending — completing the last beat changed a progress line in a menu.
//
// Acts fix the arithmetic without generating eighty hours of story up front:
// a campaign is 4–5 acts, and only the current act's beats exist. The next act
// is generated at the transition, conditioned on what actually happened — so
// the story reacts to the world instead of ignoring it, and a side threat the
// player made memorable can be promoted into the main line.
//
// Pure. The host owns storage and the generation calls.

export function makeAct({ id, title, premise, beats = [], index = 0 }) {
  if (!id) throw new Error('an act needs an id');
  return { id, title, premise, beats, index, status: 'active', startedAtTurn: null, endedAtTurn: null };
}

export function emptyThread() {
  return { acts: [], actIndex: 0, flags: {}, payoffs: [], stallSince: null };
}

export function currentAct(thread) {
  return thread?.acts?.[thread.actIndex] ?? null;
}

// The active beat: the first in the current act whose prerequisites are met and
// which is not yet done.
export function activeBeat(thread) {
  const act = currentAct(thread);
  if (!act) return null;
  return act.beats.find(b => !isDone(thread, b) && prereqsMet(thread, b)) ?? null;
}

export function isDone(thread, beat) {
  return !!thread.flags?.[`beat-done-${beat.id}`];
}

function prereqsMet(thread, beat) {
  return (beat.requires ?? []).every(f => !!thread.flags?.[f]);
}

// Raise a flag. Flags are the PRIMARY completion signal: mechanical events set
// them, so a beat completes because something happened, not because a language
// model was asked whether the scene felt finished. The judge stays as a
// fallback for beats that are purely dramatic.
export function setFlag(thread, flag) {
  if (!flag || thread.flags?.[flag]) return thread;
  return { ...thread, flags: { ...thread.flags, [flag]: true }, stallSince: null };
}

export function completeBeat(thread, beatId, { turn = 0 } = {}) {
  const next = setFlag(thread, `beat-done-${beatId}`);
  const act  = currentAct(next);
  if (!act) return next;
  // Act complete when every beat is done.
  const allDone = act.beats.every(b => isDone(next, b));
  if (!allDone) return { ...next, stallSince: turn };
  const acts = next.acts.map((a, i) => i === next.actIndex ? { ...a, status: 'complete', endedAtTurn: turn } : a);
  return { ...next, acts, actIndex: next.actIndex + 1, stallSince: null };
}

// Append a freshly generated act (the host generates it at the transition).
export function pushAct(thread, act) {
  return { ...thread, acts: [...thread.acts, { ...act, index: thread.acts.length }] };
}

// Has the story stopped moving? A thread that cannot advance should escalate —
// the world comes to the player — rather than freezing forever, which is what
// judge-only progression allowed.
export function isStalled(thread, { turn, patience = 60 }) {
  if (!activeBeat(thread)) return false;
  const since = thread.stallSince ?? 0;
  return turn - since >= patience;
}

// ─── Foreshadowing ───────────────────────────────────────────────────────────
//
// A planted clue creates an obligation. Act generation must consume due payoffs
// or explicitly abandon them, so setups stop evaporating — 'clue' discoveries
// used to have no content at all.

export function plantSetup(thread, { id, clue, paysInto, dueByAct, turn = 0 }) {
  if (!id || thread.payoffs.some(p => p.id === id)) return thread;
  return {
    ...thread,
    payoffs: [...thread.payoffs, { id, clue, paysInto, dueByAct, plantedAtTurn: turn, paid: false }],
  };
}

export function paySetup(thread, id, { turn = 0 } = {}) {
  return { ...thread, payoffs: thread.payoffs.map(p => p.id === id ? { ...p, paid: true, paidAtTurn: turn } : p) };
}

// Setups that are due (or overdue) and still unpaid — the raw material the next
// act's generation must weave in.
//
// `dueByAct` is a 1-based act NUMBER while actIndex is 0-based, so the act about
// to be generated is actIndex + 2. A setup with no deadline is always available
// to whoever can use it.
export function duePayoffs(thread) {
  const nextActNumber = thread.actIndex + 2;
  return thread.payoffs.filter(p => !p.paid && (p.dueByAct == null || p.dueByAct <= nextActNumber));
}

// ─── Progress ────────────────────────────────────────────────────────────────

export function threadProgress(thread) {
  const acts = thread?.acts ?? [];
  const beats = acts.flatMap(a => a.beats);
  const done  = beats.filter(b => isDone(thread, b)).length;
  return {
    act: thread.actIndex + 1,
    acts: acts.length,
    beatsDone: done,
    beats: beats.length,
    complete: acts.length > 0 && thread.actIndex >= acts.length,
    currentTitle: currentAct(thread)?.title ?? null,
  };
}

// The GM-private steer for this turn: the current beat's dramatic purpose plus
// where it wants to happen. Never shown to the player.
export function directive(thread) {
  const beat = activeBeat(thread);
  if (!beat) return null;
  return {
    purpose: beat.dramaticPurpose ?? beat.title,
    location: beat.location ?? null,
    cast: beat.cast ?? [],
  };
}
