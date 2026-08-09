// Acts, stalls and payoffs — the red thread at campaign length (Epic E7).
//
// The generated thread was 3–5 beats of 30–90 minutes: 1.5 to 7.5 hours of
// story for an 80-hour campaign, linear, unbound to any real person or place,
// with no failure state and no ending. Completing the last beat changed a line
// in a menu.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeAct, emptyThread, pushAct, currentAct, activeBeat, completeBeat, setFlag,
  isStalled, plantSetup, paySetup, duePayoffs, threadProgress, directive, isDone,
} from '../src/narrative/acts.js';

const beat = (id, over = {}) => ({ id, title: `Beat ${id}`, dramaticPurpose: `purpose ${id}`, ...over });

const act1 = () => makeAct({
  id: 'act-1', title: 'The Vault of Ash', premise: 'Something stirs beneath Emberfen.',
  beats: [beat('b1'), beat('b2', { requires: ['beat-done-b1'] })],
});

describe('acts', () => {
  it('starts on the first act and its first beat', () => {
    const t = pushAct(emptyThread(), act1());
    assert.equal(currentAct(t).id, 'act-1');
    assert.equal(activeBeat(t).id, 'b1');
  });

  it('respects beat prerequisites', () => {
    const t = pushAct(emptyThread(), act1());
    assert.equal(activeBeat(t).id, 'b1', 'b2 is gated behind b1');
    const after = completeBeat(t, 'b1', { turn: 10 });
    assert.equal(activeBeat(after).id, 'b2');
  });

  it('advances to the next act only when every beat is done', () => {
    let t = pushAct(emptyThread(), act1());
    t = completeBeat(t, 'b1', { turn: 10 });
    assert.equal(t.actIndex, 0, 'one beat left');
    t = completeBeat(t, 'b2', { turn: 20 });
    assert.equal(t.actIndex, 1, 'the act closes');
    assert.equal(t.acts[0].status, 'complete');
    assert.equal(t.acts[0].endedAtTurn, 20);
  });

  it('generates lazily: only the current act needs to exist', () => {
    let t = pushAct(emptyThread(), act1());
    t = completeBeat(completeBeat(t, 'b1'), 'b2');
    assert.equal(currentAct(t), null, 'the next act has not been generated yet');
    t = pushAct(t, makeAct({ id: 'act-2', title: 'The Road South', premise: 'x', beats: [beat('c1')] }));
    assert.equal(currentAct(t).id, 'act-2');
    assert.equal(activeBeat(t).id, 'c1');
  });

  it('reports a campaign as complete when the last act closes', () => {
    let t = pushAct(emptyThread(), makeAct({ id: 'a', title: 'Only', premise: 'x', beats: [beat('z')] }));
    assert.equal(threadProgress(t).complete, false);
    t = completeBeat(t, 'z');
    assert.equal(threadProgress(t).complete, true, 'a campaign must be finishable');
  });

  it('reaches 80-hour length by act count, not by one long list', () => {
    let t = emptyThread();
    for (let a = 1; a <= 5; a++) {
      t = pushAct(t, makeAct({ id: `act-${a}`, title: `Act ${a}`, premise: 'x',
        beats: Array.from({ length: 6 }, (_, i) => beat(`a${a}b${i}`)) }));
    }
    const p = threadProgress(t);
    assert.equal(p.acts, 5);
    assert.equal(p.beats, 30, '5 acts x 6 beats — hours of story, generated an act at a time');
  });
});

describe('flags are the primary completion signal', () => {
  it('a mechanical flag completes a beat without asking a model', () => {
    let t = pushAct(emptyThread(), act1());
    t = setFlag(t, 'beat-done-b1');
    assert.ok(isDone(t, act1().beats[0]));
    assert.equal(activeBeat(t).id, 'b2');
  });

  it('setting a flag twice is a no-op', () => {
    const t = setFlag(pushAct(emptyThread(), act1()), 'x');
    assert.equal(setFlag(t, 'x'), t);
  });
});

describe('stalls', () => {
  it('a thread that cannot move is detected so the world can escalate', () => {
    let t = pushAct(emptyThread(), act1());
    t = completeBeat(t, 'b1', { turn: 10 });   // stallSince = 10
    assert.equal(isStalled(t, { turn: 40, patience: 60 }), false);
    assert.equal(isStalled(t, { turn: 100, patience: 60 }), true,
      'judge-only progression could freeze a campaign forever');
  });

  it('progress restarts the stall clock from NOW, not from turn 0', () => {
    // The old behaviour set stallSince to null on any flag, and the detector
    // read null as 0 — so raising a flag at turn 120 made the thread read as
    // stalled at turn 121. The test used to assert that intermediate null;
    // now it asserts the behaviour the mechanism exists for.
    let t = pushAct(emptyThread(), act1());
    t = completeBeat(t, 'b1', { turn: 100 });
    assert.equal(isStalled(t, { turn: 120, patience: 60 }), false);
    t = setFlag(t, 'something-happened', { turn: 120 });
    assert.equal(isStalled(t, { turn: 121, patience: 60 }), false,
      'fresh progress must not read as a stall');
    assert.equal(isStalled(t, { turn: 180, patience: 60 }), true,
      'sixty idle turns after the last progress is a stall');
  });

  it('a deadlocked act — no eligible beat, act incomplete — reads as stalled', () => {
    // An act whose remaining beats are gated behind flags nothing raises used
    // to be invisible to escalation forever: the hardest-stuck state was the
    // one the mechanism could not see.
    const gated = makeAct({ id: 'a2', title: 'x', premise: 'x', beats: [
      { id: 'locked', title: 'never', dramaticPurpose: 'never', requires: ['flag-nothing-raises'] },
    ] });
    const t = pushAct(emptyThread(), gated);
    assert.equal(activeBeat(t), null, 'precondition: no beat is eligible');
    assert.equal(isStalled(t, { turn: 9999, patience: 60 }), true);
  });

  it('a finished thread is never stalled', () => {
    let t = pushAct(emptyThread(), makeAct({ id: 'a', title: 'x', premise: 'x', beats: [beat('z')] }));
    t = completeBeat(t, 'z', { turn: 5 });
    assert.equal(isStalled(t, { turn: 9999 }), false);
  });
});

describe('foreshadowing and payoff', () => {
  it('a planted clue creates an obligation', () => {
    const t = plantSetup(emptyThread(), { id: 'p1', clue: 'a sigil on the door', paysInto: 'act-2', dueByAct: 2, turn: 3 });
    assert.equal(duePayoffs(t).length, 1);
    assert.equal(duePayoffs(t)[0].clue, 'a sigil on the door');
  });

  it('does not plant the same setup twice', () => {
    let t = plantSetup(emptyThread(), { id: 'p1', clue: 'c', paysInto: 'x' });
    t = plantSetup(t, { id: 'p1', clue: 'c', paysInto: 'x' });
    assert.equal(t.payoffs.length, 1);
  });

  it('a paid setup stops being due', () => {
    let t = plantSetup(emptyThread(), { id: 'p1', clue: 'c', paysInto: 'x', dueByAct: 1 });
    t = paySetup(t, 'p1', { turn: 50 });
    assert.deepEqual(duePayoffs(t), []);
    assert.equal(t.payoffs[0].paidAtTurn, 50);
  });

  it('setups not yet due are held back', () => {
    const t = plantSetup(emptyThread(), { id: 'far', clue: 'c', paysInto: 'x', dueByAct: 5 });
    assert.deepEqual(duePayoffs(t), [], 'a slow burn is not overdue');
  });
});

describe('the GM directive', () => {
  it('carries purpose, place and cast — bound to real entities', () => {
    const t = pushAct(emptyThread(), makeAct({
      id: 'a', title: 'x', premise: 'x',
      beats: [beat('b', { location: 'region.emberfen.settlement.thornwick', cast: ['...npc.mara'] })],
    }));
    const d = directive(t);
    assert.equal(d.purpose, 'purpose b');
    assert.equal(d.location, 'region.emberfen.settlement.thornwick',
      'beats used to be prompted with a null location, so they bound to nothing');
    assert.deepEqual(d.cast, ['...npc.mara']);
  });

  it('is null when there is nothing to steer toward', () => {
    assert.equal(directive(emptyThread()), null);
  });
});

describe('act transitions and the stall clock (2026-08-09 audit)', () => {
  const oneBeatAct = (id, index = 0) => makeAct({ id, title: id, beats: [{ id: `${id}-b1` }], index });

  it('an act adopted mid-campaign is not born stalled', () => {
    let t = pushAct(emptyThread(), oneBeatAct('act-1'));
    t = completeBeat(t, 'act-1-b1', { turn: 200 });
    t = pushAct(t, oneBeatAct('act-2', 1));
    // The close at turn 200 is story movement; act 2's patience runs from there.
    assert.equal(isStalled(t, { turn: 201, patience: 60 }), false,
      'the first turn of a freshly adopted act must not fire an escalation');
    assert.equal(isStalled(t, { turn: 259, patience: 60 }), false);
    assert.equal(isStalled(t, { turn: 260, patience: 60 }), true,
      'a genuinely idle act 2 must still stall once patience runs out');
  });

  it('pushAct with a turn stamps the act and the clock', () => {
    const t = pushAct(emptyThread(), oneBeatAct('act-1'), { turn: 42 });
    assert.equal(t.acts[0].startedAtTurn, 42);
    assert.equal(t.stallSince, 42);
    assert.equal(isStalled(t, { turn: 43, patience: 60 }), false);
  });
});
