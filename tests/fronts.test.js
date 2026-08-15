// tests/fronts.test.js — the world moves while the player is elsewhere.
//
// Phase A stored the pressure (wars, shaky crowns); fronts.js releases it:
// state mints clocks, filled clocks change the state, and every change is a
// ledger patch in the same cell addressing replay folds. The tests hold four
// promises: minting is deterministic, escalation follows the ladder, turned
// crowns are seeded drama, and advanceWorld composes it all so the patches it
// emits fold back to exactly the world it returns.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mintWorldClocks, warClockFired, successionFired, advanceWorld,
  WAR_CLOCK_SEGMENTS, SUCCESSION_SEGMENTS, SUCCESSION_TURNS,
  makeClock, whileYouWereGone, cellsOf, fold,
} from '../index.js';

// A hand-built world in cartridge `data` shape: two wars at different heats,
// one shaky crown, one settled. Small on purpose — fronts.js is total over
// plain data, and thread-shape.test.js covers the baked-cartridge integration.
const world = () => ({
  settingId: null,
  geo: { nodes: {} }, outlines: {}, slices: {},
  factions: [], npcs: [], routes: [],
  lore: {
    eras: [], legends: [],
    crowns: [
      { id: 'continent-0.province-0.crown', name: 'House Marren', legitimacy: 'contested', factionRelations: [] },
      { id: 'continent-1.province-0.crown', name: 'House Veil', legitimacy: 'settled', factionRelations: [] },
    ],
  },
  warState: {
    wars: [
      { id: 'war-0', between: ['faction-0', 'faction-1'], intensity: 'cold', cause: 'the salt tithe', front: ['continent-0.province-0'] },
      { id: 'war-1', between: ['faction-0', 'faction-2'], intensity: 'open', cause: 'an old regicide', front: ['continent-1.province-0'] },
    ],
  },
});

describe('mintWorldClocks', () => {
  it('mints one clock per war and one per shaky crown, segments from the tables', () => {
    const clocks = mintWorldClocks(world());
    assert.deepEqual(clocks.map((c) => c.id),
      ['clock-war-0', 'clock-war-1', 'clock-continent-0.province-0.crown']);
    assert.equal(clocks[0].segments, WAR_CLOCK_SEGMENTS.cold);
    assert.equal(clocks[1].segments, WAR_CLOCK_SEGMENTS.open);
    assert.equal(clocks[2].segments, SUCCESSION_SEGMENTS.contested);
    // A settled crown runs no clock — stability is the absence of pressure.
    assert.ok(!clocks.some((c) => c.id.includes('continent-1')));
    // Deterministic: same data, same clocks, byte for byte.
    assert.deepEqual(mintWorldClocks(world()), clocks);
  });

  it('a world at peace with settled thrones mints nothing', () => {
    assert.deepEqual(mintWorldClocks({ warState: null, lore: { crowns: [] } }), []);
    assert.deepEqual(mintWorldClocks({}), []);
    assert.deepEqual(mintWorldClocks(undefined), []);
  });
});

describe('warClockFired', () => {
  it('climbs the ladder: cold → raiding, and the patch folds back to the same world', () => {
    const data = world();
    const { data: next, patches, clock } = warClockFired(data, 'war-0', { turn: 7 });
    assert.equal(next.warState.wars[0].intensity, 'raiding');
    assert.equal(data.warState.wars[0].intensity, 'cold', 'the input is untouched');
    assert.equal(next.warState.wars[1], data.warState.wars[1], 'the other war is shared, not copied');

    assert.equal(patches.length, 1);
    const [p] = patches;
    assert.equal(p.target, 'world');
    assert.equal(p.path, 'warState.wars.0.intensity');
    assert.deepEqual([p.from, p.to, p.turn, p.source], ['cold', 'raiding', 7, 'fronts']);

    // The patch IS the change: folding it over the world cell reproduces the
    // projected warState — canon a replay reproduces, not a vibe.
    const folded = fold(cellsOf(data, 'world'), patches, 'world');
    assert.deepEqual(folded.warState, next.warState);

    // The successor runs hotter: raiding burns a shorter fuse than cold.
    assert.equal(clock.segments, WAR_CLOCK_SEGMENTS.raiding);
    assert.equal(clock.filled, 0);
    assert.equal(clock.fired, false);
  });

  it('an open war that fires again grinds on — escalations count, and keep counting', () => {
    const first = warClockFired(world(), 'war-1', { turn: 3 });
    assert.equal(first.data.warState.wars[1].escalations, 1);
    assert.equal(first.patches[0].path, 'warState.wars.1.escalations');
    assert.deepEqual([first.patches[0].from, first.patches[0].to], [0, 1]);

    const second = warClockFired(first.data, 'war-1', { turn: 9 });
    assert.equal(second.data.warState.wars[1].escalations, 2);
    assert.equal(second.data.warState.wars[1].intensity, 'open', 'open stays open');
    assert.match(second.patches[0].because, /ground on/);
  });

  it('an unknown war is a total no-op', () => {
    const data = world();
    assert.deepEqual(warClockFired(data, 'war-99'), { data, patches: [], clock: null });
  });
});

describe('successionFired', () => {
  it('turns the claim within the table, seeded — same seed, same fortune', () => {
    const data = world();
    const crownId = 'continent-0.province-0.crown';
    const r = successionFired(data, crownId, { turn: 5, seed: 11 });
    const to = r.data.lore.crowns[0].legitimacy;
    assert.ok(SUCCESSION_TURNS.contested.includes(to), `${to} is a legal turn for a contested claim`);
    assert.equal(data.lore.crowns[0].legitimacy, 'contested', 'the input is untouched');

    assert.equal(r.patches.length, 1);
    assert.equal(r.patches[0].target, crownId);
    assert.equal(r.patches[0].path, 'crown.legitimacy');
    assert.equal(r.patches[0].to, to);

    // The patch folds over the crown's own cell to the same answer.
    const folded = fold(cellsOf(data, crownId), r.patches, crownId);
    assert.equal(folded.crown.legitimacy, to);

    // Seeded drama: the same seed and turn always tell the same story…
    assert.equal(successionFired(world(), crownId, { turn: 5, seed: 11 }).data.lore.crowns[0].legitimacy, to);

    // …and the successor clock exists exactly when the new claim is shaky.
    if (to in SUCCESSION_SEGMENTS) {
      assert.equal(r.clock.segments, SUCCESSION_SEGMENTS[to]);
    } else {
      assert.equal(r.clock, null, 'a settled matter runs no clock');
    }
  });

  it('a settled crown, or an unknown one, is a total no-op', () => {
    const data = world();
    assert.deepEqual(successionFired(data, 'continent-1.province-0.crown'), { data, patches: [], clock: null });
    assert.deepEqual(successionFired(data, 'nowhere.crown'), { data, patches: [], clock: null });
  });
});

describe('advanceWorld', () => {
  it('ticks, fires, applies, and replaces — one call moves the whole world', () => {
    const data = world();
    const clocks = mintWorldClocks(data);
    // Enough days at sea to fill the open war's short fuse (4) but not the
    // cold war's long one (8) or the succession clock (6).
    const r = advanceWorld(data, clocks, { amount: 4, turn: 12, seed: 3 });

    assert.deepEqual(r.fired.map((c) => c.id), ['clock-war-1']);
    assert.equal(r.data.warState.wars[1].escalations, 1, 'the firing changed the world');
    assert.equal(r.patches.length, 1);
    assert.equal(r.patches[0].turn, 12);

    // The fired clock is gone; its hotter successor and the two survivors remain.
    assert.deepEqual(r.clocks.map((c) => c.id).sort(),
      ['clock-continent-0.province-0.crown', 'clock-war-0', 'clock-war-1']);
    const successor = r.clocks.find((c) => c.id === 'clock-war-1');
    assert.equal(successor.filled, 0, 'the successor starts fresh');
    const coldClock = r.clocks.find((c) => c.id === 'clock-war-0');
    assert.equal(coldClock.filled, 4, 'the survivors kept their progress');

    // And the fired clocks are exactly what whileYouWereGone reports as news.
    assert.deepEqual(whileYouWereGone(r.fired, []).firedClocks.map((c) => c.id), ['clock-war-1']);
  });

  it('pressure pushes one clock harder without moving the others', () => {
    const data = world();
    const clocks = mintWorldClocks(data);
    const r = advanceWorld(data, clocks, { amount: 0, pressure: { 'clock-war-0': 8 }, turn: 2 });
    assert.deepEqual(r.fired.map((c) => c.id), ['clock-war-0']);
    assert.equal(r.data.warState.wars[0].intensity, 'raiding');
    assert.equal(r.clocks.find((c) => c.id === 'clock-war-1').filled, 0);
  });

  it('every emitted patch folds over the cells to exactly the returned world', () => {
    const data = world();
    // Fill everything at once: two wars escalate AND the crown turns.
    const r = advanceWorld(data, mintWorldClocks(data), { amount: 8, turn: 1, seed: 7 });
    assert.equal(r.fired.length, 3);

    const foldedWorld = fold(cellsOf(data, 'world'), r.patches, 'world');
    assert.deepEqual(foldedWorld.warState, r.data.warState,
      'replay(base, patches) and the projected data agree on the war');
    const crownId = 'continent-0.province-0.crown';
    const foldedCrown = fold(cellsOf(data, crownId), r.patches, crownId);
    assert.equal(foldedCrown.crown.legitimacy, r.data.lore.crowns[0].legitimacy,
      'and on the throne');
  });

  it('unknown onFill kinds pass through for the host to handle', () => {
    const data = world();
    const custom = makeClock({ id: 'clock-comet', label: 'the comet returns', segments: 1, onFill: [{ kind: 'omen', text: 'the sky splits' }] });
    const r = advanceWorld(data, [custom], { amount: 1, turn: 1 });
    assert.deepEqual(r.fired.map((c) => c.id), ['clock-comet'], 'the host still hears it fired');
    assert.equal(r.data, data, 'but the world is untouched');
    assert.deepEqual(r.patches, []);
    assert.deepEqual(r.clocks, [], 'and no successor is invented');
  });
});
