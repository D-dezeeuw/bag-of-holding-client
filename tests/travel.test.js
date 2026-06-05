import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginTravel, stepTravel, isTravelDone, pickEncounter, runTravel,
  TRAVEL_SEGMENTS_MIN, TRAVEL_SEGMENTS_MAX, ENCOUNTER_CHANCE, DISCOVERY_CHANCE, DISCOVERY_TYPES,
} from '../src/travel/fsm.js';
import { mulberry32 } from '../src/worldgen/rng.js';

const constRng = (v) => () => v;

describe('travel FSM', () => {
  it('begins in departing with an in-range segment count', () => {
    for (let s = 0; s < 40; s++) {
      const t = beginTravel('Dest', mulberry32(s));
      assert.equal(t.phase, 'departing');
      assert.ok(t.segments >= TRAVEL_SEGMENTS_MIN && t.segments <= TRAVEL_SEGMENTS_MAX);
    }
  });
  it('progresses departing → traveling → arriving → arrived', () => {
    let t = beginTravel('D', constRng(0.99));
    const segs = t.segments;
    let r = stepTravel(t, constRng(0.99)); assert.equal(r.event.type, 'depart'); t = r.travel;
    for (let i = 0; i < segs; i++) { r = stepTravel(t, constRng(0.99)); assert.equal(r.event.type, 'uneventful'); t = r.travel; }
    assert.equal(t.phase, 'arriving');
    r = stepTravel(t, constRng(0.99)); assert.equal(r.event.type, 'arrive');
    assert.equal(isTravelDone(r.travel), true);
  });
  it('rolls encounter / discovery / uneventful by band; safe mode suppresses both', () => {
    let { travel } = stepTravel(beginTravel('X', constRng(0)), constRng(0));
    assert.equal(stepTravel(travel, constRng(ENCOUNTER_CHANCE - 0.01)).event.type, 'encounter');
    const dEv = stepTravel(travel, constRng(ENCOUNTER_CHANCE + DISCOVERY_CHANCE - 0.01)).event;
    assert.equal(dEv.type, 'discovery'); assert.ok(DISCOVERY_TYPES.includes(dEv.discovery));
    assert.equal(stepTravel(travel, constRng(0.999)).event.type, 'uneventful');
    const { events } = runTravel('H', mulberry32(7), { safe: true });
    assert.ok(!events.some(e => e.type === 'encounter' || e.type === 'discovery'));
    assert.equal(events[events.length - 1].type, 'arrive');
  });
  it('runTravel always terminates with depart…arrive and N middle events', () => {
    for (let s = 0; s < 60; s++) {
      const { travel, events } = runTravel('D', mulberry32(s));
      assert.equal(isTravelDone(travel), true);
      assert.equal(events[0].type, 'depart');
      assert.equal(events[events.length - 1].type, 'arrive');
      assert.equal(events.slice(1, -1).length, travel.segments);
    }
  });
  it('pickEncounter draws from the pool / null when empty', () => {
    const pool = ['a', 'b', 'c'];
    assert.ok(pool.includes(pickEncounter(pool, mulberry32(3))));
    assert.equal(pickEncounter([], mulberry32(1)), null);
    assert.equal(pickEncounter(null, mulberry32(1)), null);
  });
});
