// Initiative tracker (the kernel roadmap's 4.1.0 row). What must hold:
// the view model sorts by initiative with a STABLE tie-break (equal
// rolls never reshuffle between renders); the active turn wraps and
// bumps the round; downed combatants stay listed at zero; hp bars
// clamp; and the element registration is a clean no-op in node — the
// part that can be wrong is fully covered without a DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initiativeViewModel, advanceTurn, defineInitiativeTracker,
} from '../src/ui/initiative.js';

const ENCOUNTER = {
  participants: [
    { id: 'vex', name: 'Vex', initiative: 17, hp: 21, hpMax: 24, side: 'party' },
    { id: 'wolf-1', name: 'Wolf 1', initiative: 12, hp: 11, hpMax: 11, side: 'foe' },
    { id: 'wolf-2', name: 'Wolf 2', initiative: 12, hp: 0, hpMax: 11, side: 'foe', conditions: ['prone'] },
    { id: 'brann', name: 'Brann', initiative: 8, hp: 30, hpMax: 30, side: 'party' },
  ],
  turnIndex: 0,
  round: 1,
};

test('the view model sorts, stably tie-breaks, and derives the render facts', () => {
  const vm = initiativeViewModel(ENCOUNTER);
  assert.deepEqual(vm.rows.map((r) => r.id), ['vex', 'wolf-1', 'wolf-2', 'brann'],
    'equal initiatives keep arrival order');
  assert.equal(vm.active, 'vex');
  assert.equal(vm.rows[0].active, true);
  assert.equal(vm.round, 1);
  // Hp bars clamp; the downed wolf is still on the list, flagged.
  assert.equal(vm.rows[0].hpFraction, 21 / 24);
  assert.equal(vm.rows[2].hpFraction, 0);
  assert.equal(vm.rows[2].downed, true);
  assert.deepEqual(vm.rows[2].conditions, ['prone']);
  // Participants without hp (narrative extras) get no bar, not a NaN.
  const noHp = initiativeViewModel({ participants: [{ id: 'ghost', initiative: 5 }] });
  assert.equal(noHp.rows[0].hpFraction, null);
  // Out-of-range turn indices normalise instead of pointing nowhere.
  assert.equal(initiativeViewModel({ ...ENCOUNTER, turnIndex: 9 }).active, 'wolf-1');
  assert.equal(initiativeViewModel({ participants: [] }).active, null);
});

test('advanceTurn wraps and bumps the round exactly on the wrap', () => {
  let state = ENCOUNTER;
  const seen = [];
  for (let i = 0; i < 5; i++) {
    seen.push(initiativeViewModel(state).active);
    state = advanceTurn(state);
  }
  assert.deepEqual(seen, ['vex', 'wolf-1', 'wolf-2', 'brann', 'vex']);
  assert.equal(state.round, 2, 'one full cycle = one round');
  state = advanceTurn(advanceTurn(state));
  assert.equal(state.round, 2, 'mid-round advances do not bump');
  // An empty encounter is inert, not an exception.
  assert.equal(advanceTurn({ participants: [] }).turnIndex, 0);
});

test('element registration is a clean no-op without a DOM', () => {
  assert.equal(globalThis.customElements, undefined, 'node has no custom elements');
  assert.equal(defineInitiativeTracker(), null, 'no-op, no throw');
});
