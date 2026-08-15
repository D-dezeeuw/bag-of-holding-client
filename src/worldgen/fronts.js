// src/worldgen/fronts.js — the world moves while the player is elsewhere.
//
// Phase A gave the world powers, wars and thrones as STATE; this module gives
// that state a pulse. Two kinds of pressure mint clocks (narrative/clocks.js):
//
//   • every war runs a clock, faster the hotter it burns — when it fills,
//     the war ESCALATES (cold → raiding → open; an open war that fires again
//     grinds on, counting escalations, which is a siege in numbers);
//   • every shaky crown (contested / usurped / failing) runs a succession
//     clock — when it fills, the legitimacy TURNS, seeded and recorded.
//
// A firing is not narration: it is a ledger patch on a world cell, written in
// the same addressing replay folds (target 'world' / the crown's entity id),
// so "the war got worse while you were at sea" is canon a replay reproduces,
// not a vibe a DM half-remembers. `whileYouWereGone` already reports fired
// clocks; this module is what finally arms it.
//
// Pure throughout. The host owns storage, the clock list, and when to call
// advanceWorld (travel days, chapter breaks, long rests — cadence is the
// host's dial; the arithmetic is ours).

import { makeClock, tickAll } from '../narrative/clocks.js';
import { makePatch } from '../ledger/patch.js';
import { projectCells } from './revision.js';
import { mulberry32, pick } from './rng.js';

// Hotter wars burn shorter fuses; steadier crowns wobble longer. Segments are
// the drama dial: at one tick per travel-day-batch or chapter, a cold war
// takes most of an act to turn, an open one turns fast enough to feel.
export const WAR_CLOCK_SEGMENTS = Object.freeze({ cold: 8, raiding: 6, open: 4 });
export const SUCCESSION_SEGMENTS = Object.freeze({ contested: 6, usurped: 4, failing: 8 });

// Where a turning throne can land. Seeded pick at fire time — succession is
// drama, not fate, but the same seed always tells the same story.
export const SUCCESSION_TURNS = Object.freeze({
  contested: ['usurped', 'settled'],
  usurped: ['settled', 'contested'],
  failing: ['contested', 'usurped'],
});

const ESCALATION = Object.freeze({ cold: 'raiding', raiding: 'open', open: 'open' });

const warClock = (war) => makeClock({
  id: `clock-${war.id}`,
  label: `the war over ${war.cause}`,
  owner: war.between[0],
  segments: WAR_CLOCK_SEGMENTS[war.intensity] ?? 6,
  onFill: [{ kind: 'war-escalates', warId: war.id }],
});

const crownClock = (crown) => makeClock({
  id: `clock-${crown.id}`,
  label: `the ${crown.legitimacy} claim of ${crown.name}`,
  owner: crown.id,
  segments: SUCCESSION_SEGMENTS[crown.legitimacy],
  onFill: [{ kind: 'succession-turns', crownId: crown.id }],
});

/**
 * Mint the world's pressure from its own state: one clock per war, one per
 * shaky crown. Deterministic — no rng, segments derive from intensity and
 * legitimacy — so the same cartridge always starts under the same pressure.
 */
export function mintWorldClocks(data) {
  const clocks = [];
  for (const war of data?.warState?.wars ?? []) clocks.push(warClock(war));
  for (const crown of data?.lore?.crowns ?? []) {
    if (crown.legitimacy in SUCCESSION_SEGMENTS) clocks.push(crownClock(crown));
  }
  return clocks;
}

/**
 * A war clock fired: escalate. Returns `{ data, patches, clock }` — the
 * projected world, the canon patches that record it (target 'world', the
 * same cell replay folds), and the war's SUCCESSOR clock, running hotter.
 */
export function warClockFired(data, warId, { turn = 0 } = {}) {
  const wars = data?.warState?.wars ?? [];
  const i = wars.findIndex(w => w.id === warId);
  if (i === -1) return { data, patches: [], clock: null };
  const war = wars[i];
  const next = war.intensity === 'open'
    ? { ...war, escalations: (war.escalations ?? 0) + 1 }
    : { ...war, intensity: ESCALATION[war.intensity] ?? war.intensity };
  const warState = { ...data.warState, wars: wars.map((w, j) => (j === i ? next : w)) };
  const patches = [makePatch({
    turn, target: 'world', scope: 'world', kind: 'canon',
    path: `warState.wars.${i}.${war.intensity === 'open' ? 'escalations' : 'intensity'}`,
    from: war.intensity === 'open' ? (war.escalations ?? 0) : war.intensity,
    to: war.intensity === 'open' ? next.escalations : next.intensity,
    because: war.intensity === 'open'
      ? `the open war over ${war.cause} ground on`
      : `the war over ${war.cause} escalated to ${next.intensity}`,
    source: 'fronts',
  })];
  return { data: projectCells(data, 'world', { warState }), patches, clock: warClock(next) };
}

/**
 * A succession clock fired: the claim turns. Seeded — same seed and turn,
 * same new ruler's fortune. Returns the successor clock when the new
 * legitimacy is itself shaky (a usurper's crown is not a settled one), or
 * null when the matter is settled.
 */
export function successionFired(data, crownId, { turn = 0, seed = 1 } = {}) {
  const crowns = data?.lore?.crowns ?? [];
  const crown = crowns.find(c => c.id === crownId);
  if (!crown || !(crown.legitimacy in SUCCESSION_TURNS)) return { data, patches: [], clock: null };
  const rng = mulberry32(((seed ?? 1) + turn + crownId.length) >>> 0);
  const to = pick(SUCCESSION_TURNS[crown.legitimacy], rng);
  const next = { ...crown, legitimacy: to };
  const patches = [makePatch({
    turn, target: crownId, scope: 'regional', kind: 'canon',
    path: 'crown.legitimacy', from: crown.legitimacy, to,
    because: `the ${crown.legitimacy} claim of ${crown.name} turned ${to}`,
    source: 'fronts',
  })];
  return {
    data: projectCells(data, crownId, { crown: next }),
    patches,
    clock: to in SUCCESSION_SEGMENTS ? crownClock(next) : null,
  };
}

/**
 * One call to move the world: tick every clock (travel days, a chapter, a
 * long rest — the host picks the amount), apply every firing to the world,
 * and hand back the new data, the surviving clock set (fired clocks replaced
 * by their successors), the canon patches to commit, and the fired clocks
 * themselves for `whileYouWereGone` to report as news.
 */
export function advanceWorld(data, clocks, { amount = 1, pressure = {}, turn = 0, seed = 1 } = {}) {
  const ticked = tickAll(clocks, { amount, pressure });
  let out = data;
  const patches = [];
  const successors = [];
  for (const clock of ticked.fired) {
    for (const effect of clock.onFill ?? []) {
      if (effect.kind === 'war-escalates') {
        const r = warClockFired(out, effect.warId, { turn });
        out = r.data; patches.push(...r.patches);
        if (r.clock) successors.push(r.clock);
      } else if (effect.kind === 'succession-turns') {
        const r = successionFired(out, effect.crownId, { turn, seed });
        out = r.data; patches.push(...r.patches);
        if (r.clock) successors.push(r.clock);
      }
      // Unknown kinds pass through untouched — a host may hang its own
      // effects on onFill and handle them outside this module.
    }
  }
  const surviving = ticked.clocks.filter(c => !c.fired);
  return { data: out, clocks: [...surviving, ...successors], fired: ticked.fired, patches };
}
