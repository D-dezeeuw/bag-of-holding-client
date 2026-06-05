import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure runtime engines for AI-generated story state: beat prerequisite
// evaluation / flag gating / completion, and faction reputation math.
import {
  isBeatDone, isBeatEligible, nextEligibleBeats, currentBeat,
  setFlag, completeBeat, storyProgress, storyHint,
} from '../src/narrative/beats.js';
import {
  REP_MIN, REP_MAX, THRESHOLDS, clampRep, reputationOf, adjustReputation,
  standing, standingFor, priceModifier, adjustPrice, isHostile,
} from '../src/narrative/factions.js';

const makeRT = () => ({
  currentIndex: 0,
  flags: {},
  beats: [
    { id: 'b1', dramaticPurpose: 'discover the threat', prerequisites: [], setRequiredFlags: ['threat-known'] },
    { id: 'b2', dramaticPurpose: 'learn the scope',     prerequisites: ['threat-known'], setRequiredFlags: ['scope-known'] },
    { id: 'b3', dramaticPurpose: 'confront the source', prerequisites: ['scope-known'], setRequiredFlags: ['threat-resolved'] },
  ],
});

describe('beats — eligibility & flag gating', () => {
  it('only the first beat is eligible at the start', () => {
    const rt = makeRT();
    const elig = nextEligibleBeats(rt);
    assert.equal(elig.length, 1);
    assert.equal(elig[0].id, 'b1');
    assert.equal(currentBeat(rt).id, 'b1');
  });

  it('isBeatEligible respects prerequisite flags', () => {
    assert.equal(isBeatEligible({ prerequisites: ['x'] }, {}), false);
    assert.equal(isBeatEligible({ prerequisites: ['x'] }, { x: true }), true);
    assert.equal(isBeatEligible({ prerequisites: [] }, {}), true);
  });

  it('completing a beat raises its flags and unlocks the next', () => {
    let rt = makeRT();
    rt = completeBeat(rt, 'b1');
    assert.equal(isBeatDone(rt, 'b1'), true);
    assert.equal(rt.flags['threat-known'], true);
    assert.equal(rt.currentIndex, 1);
    assert.equal(currentBeat(rt).id, 'b2');
    assert.equal(nextEligibleBeats(rt).some(b => b.id === 'b3'), false);
  });

  it('drives the full chain to completion in order', () => {
    let rt = makeRT();
    const order = [];
    for (let i = 0; i < 5 && currentBeat(rt); i++) {
      const b = currentBeat(rt);
      order.push(b.id);
      rt = completeBeat(rt, b.id);
    }
    assert.deepEqual(order, ['b1', 'b2', 'b3']);
    assert.equal(currentBeat(rt), null);
    assert.equal(rt.flags['threat-resolved'], true);
  });

  it('setFlag is idempotent and immutable', () => {
    const rt = makeRT();
    const rt2 = setFlag(rt, 'visited-ashvale');
    assert.equal(rt2.flags['visited-ashvale'], true);
    assert.equal(rt.flags['visited-ashvale'], undefined);
    assert.equal(setFlag(rt2, 'visited-ashvale'), rt2);
  });

  it('completeBeat on an unknown id is a no-op', () => {
    const rt = makeRT();
    assert.equal(completeBeat(rt, 'nope'), rt);
  });

  it('storyProgress / storyHint report counts without spoilers', () => {
    let rt = makeRT();
    rt = completeBeat(rt, 'b1');
    const p = storyProgress(rt);
    assert.equal(p.done, 1);
    assert.equal(p.total, 3);
    assert.equal(p.current.id, 'b2');
    assert.deepEqual(storyHint(rt), { done: 1, total: 3 });
    assert.equal(storyHint({ beats: [] }), null);
  });
});

describe('factions — reputation math', () => {
  it('clamps to [-100, 100]', () => {
    assert.equal(clampRep(999), REP_MAX);
    assert.equal(clampRep(-999), REP_MIN);
    assert.equal(clampRep(12.6), 13);
    assert.equal(clampRep('x'), 0);
  });

  it('reputationOf defaults to neutral 0', () => {
    assert.equal(reputationOf({}, 'crown'), 0);
    assert.equal(reputationOf({ crown: 30 }, 'crown'), 30);
  });

  it('adjustReputation shifts and clamps immutably', () => {
    const m0 = {};
    const m1 = adjustReputation(m0, 'crown', 40);
    assert.equal(m1.crown, 40);
    assert.equal(m0.crown, undefined);
    const m2 = adjustReputation(m1, 'crown', 80);
    assert.equal(m2.crown, REP_MAX);
    const m3 = adjustReputation(m2, 'crown', -250);
    assert.equal(m3.crown, REP_MIN);
  });

  it('standing buckets thresholds correctly', () => {
    assert.equal(standing(0), 'neutral');
    assert.equal(standing(THRESHOLDS.ally), 'ally');
    assert.equal(standing(THRESHOLDS.ally - 1), 'neutral');
    assert.equal(standing(THRESHOLDS.champion), 'champion');
    assert.equal(standing(THRESHOLDS.enemy), 'enemy');
    assert.equal(standing(THRESHOLDS.nemesis), 'nemesis');
    assert.equal(standing(-79), 'enemy');
  });

  it('standingFor reads the map', () => {
    assert.equal(standingFor({ cult: -90 }, 'cult'), 'nemesis');
    assert.equal(standingFor({}, 'cult'), 'neutral');
  });

  it('priceModifier / adjustPrice reward allies and punish enemies', () => {
    assert.equal(priceModifier('ally'), 0.9);
    assert.equal(priceModifier('nemesis'), 1.5);
    assert.equal(priceModifier('neutral'), 1.0);
    assert.equal(adjustPrice(100, 'champion'), 80);
    assert.equal(adjustPrice(100, 'enemy'), 125);
    assert.equal(adjustPrice(0, 'ally'), 1);
  });

  it('isHostile flags enemy and nemesis', () => {
    assert.equal(isHostile('enemy'), true);
    assert.equal(isHostile('nemesis'), true);
    assert.equal(isHostile('neutral'), false);
    assert.equal(isHostile('ally'), false);
  });
});
