// narrative/beats.js — pure red-thread (story beat) evaluator.
//
// Zero imports: beat eligibility, flag gating, completion, and progress are
// pure functions of a `redThread` ({ beats, currentIndex, flags }) so they're
// unit-testable. The host sets flags as the player acts, injects the current
// beat's dramatic purpose into the narrator, and (typically via a tiny-tier LLM
// check) decides whether a beat was fulfilled — then calls completeBeat here.
//
// Pairs with the worldgen blueprint's `beatsHints`, which constrains the AI that
// generates the beats this module then runs.
//
// Flag convention: a beat with id "B" is marked done by the flag `beat-done-B`.
// Beats also declare `prerequisites` (flags that must be set first) and
// `setRequiredFlags` (flags they raise on completion).

const flagsOf = (rt) => rt?.flags ?? {};
const doneFlag = (id) => `beat-done-${id}`;

export function isBeatDone(rt, id) {
  return !!flagsOf(rt)[doneFlag(id)];
}

// A beat is eligible when every prerequisite flag is set and it isn't done yet.
export function isBeatEligible(beat, flags) {
  if (!beat) return false;
  return (beat.prerequisites ?? []).every(p => flags[p]);
}

// All incomplete beats whose prerequisites are satisfied.
export function nextEligibleBeats(rt) {
  const flags = flagsOf(rt);
  return (rt?.beats ?? []).filter(b => !flags[doneFlag(b.id)] && isBeatEligible(b, flags));
}

// `successors` names the beats the arc's author meant to follow this one. It is
// ADVISORY: when several beats are eligible at once it breaks the tie toward the
// intended chain, and that is all it does. Making it a gate was tempting and
// wrong — an AI-authored arc with one bad edge would strand a campaign with no
// reachable beat, and `prerequisites` already does the gating.
function preferredNext(rt, eligible) {
  const beats = rt?.beats ?? [];
  const last  = beats[(rt?.currentIndex ?? 0) - 1];
  const named = new Set(last?.successors ?? []);
  return eligible.find(b => named.has(b.id)) ?? eligible[0];
}

// The beat to steer the story toward right now: the eligible incomplete beat the
// last completed beat pointed at (else the first eligible one), else the first
// incomplete beat (so the thread never silently stalls), else null when the arc
// is finished.
export function currentBeat(rt) {
  const elig = nextEligibleBeats(rt);
  if (elig.length) return preferredNext(rt, elig);
  const flags = flagsOf(rt);
  return (rt?.beats ?? []).find(b => !flags[doneFlag(b.id)]) ?? null;
}

// Set a single story flag (idempotent). Returns a new redThread.
export function setFlag(rt, flag) {
  const flags = flagsOf(rt);
  if (!flag || flags[flag]) return rt ?? { beats: [], currentIndex: 0, flags: {} };
  return { ...(rt ?? { beats: [], currentIndex: 0 }), flags: { ...flags, [flag]: true } };
}

// Mark a beat complete: raise its done flag + its setRequiredFlags, and advance
// currentIndex past it. Returns a new redThread (no-op if the beat is unknown).
export function completeBeat(rt, beatId) {
  const beats = rt?.beats ?? [];
  const idx = beats.findIndex(b => b.id === beatId);
  if (idx < 0) return rt ?? { beats: [], currentIndex: 0, flags: {} };
  const beat = beats[idx];
  const flags = { ...flagsOf(rt), [doneFlag(beatId)]: true };
  for (const f of (beat.setRequiredFlags ?? [])) flags[f] = true;
  const currentIndex = Math.max(rt.currentIndex ?? 0, idx + 1);
  return { ...rt, flags, currentIndex };
}

// Progress summary for the story UI.
export function storyProgress(rt) {
  const beats = rt?.beats ?? [];
  const done = beats.filter(b => isBeatDone(rt, b.id)).length;
  return { done, total: beats.length, current: currentBeat(rt) };
}

// A compact, NON-spoilery hint for the player: the current beat's dramatic
// purpose is the GM's directive, so the player only sees how far along they are.
export function storyHint(rt) {
  const { done, total } = storyProgress(rt);
  if (!total) return null;
  return { done, total };
}
