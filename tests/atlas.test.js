// Geography as a graph, and clocks that make the world move (Epic E6).
//
// Overworld travel used to mint a brand-new region on every departure —
// adjacency was display-name strings, road exits carried a null targetId, and
// walking back the way you came landed somewhere else. That is a star with the
// player at its centre; an open world could not be represented at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyGeography, addNode, connect, neighbours, expandFrom, markVisited,
  knownMap, routeBetween, DIRECTIONS,
} from '../src/worldgen/geography.js';
import { makeClock, advance, tickAll, isFull, clockMood, pressingClocks } from '../src/narrative/clocks.js';

const start = () => addNode(emptyGeography(), {
  id: 'region.emberfen', name: 'Emberfen', seed: 12345, stub: false,
});

describe('geography graph', () => {
  it('mints stub neighbours deterministically from the parent seed', () => {
    const a = expandFrom(start(), 'region.emberfen', { count: 3 });
    const b = expandFrom(start(), 'region.emberfen', { count: 3 });
    assert.deepEqual(a, b, 'the same world must always grow the same shape');
    assert.equal(neighbours(a, 'region.emberfen').length, 3);
  });

  it('neighbours are named but ungenerated until visited', () => {
    const geo = expandFrom(start(), 'region.emberfen', { count: 2 });
    for (const n of neighbours(geo, 'region.emberfen')) {
      assert.equal(n.stub, true, 'a stub costs nothing until the player goes there');
      assert.ok(n.seed, 'but it already knows how it will be generated');
    }
  });

  it('walking back the way you came returns to the same place', () => {
    let geo = expandFrom(start(), 'region.emberfen', { count: 2 });
    const [first] = neighbours(geo, 'region.emberfen');
    geo = markVisited(geo, first.id);
    const back = neighbours(geo, first.id).find(n => n.id === 'region.emberfen');
    assert.ok(back, 'the edge is bidirectional');
    assert.equal(back.name, 'Emberfen');
  });

  it('reports the reciprocal direction from the far end', () => {
    let geo = start();
    geo = addNode(geo, { id: 'b', name: 'B', seed: 2 });
    geo = connect(geo, 'region.emberfen', 'b', { direction: 'north' });
    assert.equal(neighbours(geo, 'region.emberfen')[0].direction, 'north');
    assert.equal(neighbours(geo, 'b')[0].direction, 'south');
  });

  it('never duplicates an edge', () => {
    let geo = addNode(start(), { id: 'b', name: 'B', seed: 2 });
    geo = connect(geo, 'region.emberfen', 'b');
    geo = connect(geo, 'b', 'region.emberfen');
    assert.equal(geo.edges.length, 1);
  });

  it('grows outward without revisiting, so the world can be large', () => {
    let geo = start();
    let frontier = ['region.emberfen'];
    for (let depth = 0; depth < 3; depth++) {
      const next = [];
      for (const id of frontier) {
        geo = expandFrom(geo, id, { count: 2 });
        next.push(...neighbours(geo, id).filter(n => n.stub).map(n => n.id));
      }
      frontier = next;
    }
    assert.ok(Object.keys(geo.nodes).length > 8, 'three hops out is already a real map');
  });

  it('routes between distant nodes by travel days', () => {
    let geo = start();
    geo = addNode(geo, { id: 'b', name: 'B', seed: 2 });
    geo = addNode(geo, { id: 'c', name: 'C', seed: 3 });
    geo = connect(geo, 'region.emberfen', 'b', { days: 2 });
    geo = connect(geo, 'b', 'c', { days: 3 });
    const route = routeBetween(geo, 'region.emberfen', 'c');
    assert.deepEqual(route.path, ['region.emberfen', 'b', 'c']);
    assert.equal(route.days, 5);
    assert.equal(routeBetween(geo, 'region.emberfen', 'nowhere'), null);
  });

  it('separates places seen from places merely heard of', () => {
    let geo = expandFrom(start(), 'region.emberfen', { count: 3 });
    const map = knownMap(geo);
    assert.equal(map.visited.length, 1);
    assert.equal(map.rumoured.length, 3, 'named neighbours are rumours until walked');
  });

  it('offers at most one edge per cardinal direction', () => {
    const geo = expandFrom(start(), 'region.emberfen', { count: 8 });
    const dirs = neighbours(geo, 'region.emberfen').map(n => n.direction);
    assert.equal(new Set(dirs).size, dirs.length);
    assert.ok(dirs.every(d => DIRECTIONS.includes(d)));
  });
});

describe('clocks', () => {
  const siege = () => makeClock({ id: 'clock.siege', label: 'The Iron Court marches', segments: 4 });

  it('fills and fires exactly once', () => {
    let c = siege();
    let fires = 0;
    for (let i = 0; i < 6; i++) {
      const r = advance(c);
      c = r.clock;
      if (r.justFilled) fires++;
    }
    assert.equal(fires, 1, 'consequences must not repeat every tick after filling');
    assert.ok(isFull(c));
  });

  it('can be wound back by player action', () => {
    const { clock } = advance(advance(siege()).clock, -1);
    assert.equal(clock.filled, 0, 'the party can push a threat back');
  });

  it('never goes below empty or above full', () => {
    assert.equal(advance(siege(), -5).clock.filled, 0);
    assert.equal(advance(siege(), 99).clock.filled, 4);
  });

  it('ticks a whole set and reports what fired', () => {
    const clocks = [siege(), makeClock({ id: 'clock.plague', label: 'Fever spreads', segments: 2 })];
    const first  = tickAll(clocks);
    assert.equal(first.fired.length, 0);
    const second = tickAll(first.clocks);
    assert.equal(second.fired.length, 1, 'the shorter clock fires first');
    assert.equal(second.fired[0].id, 'clock.plague');
  });

  it('applies extra pressure to a threat the player ignores', () => {
    const { clocks } = tickAll([siege()], { pressure: { 'clock.siege': 3 } });
    assert.equal(clocks[0].filled, 3);
  });

  it('describes urgency as mood, never as numbers', () => {
    let c = siege();
    assert.equal(clockMood(c), 'quiet');
    c = advance(c).clock;      assert.equal(clockMood(c), 'stirring');
    c = advance(c).clock;      assert.equal(clockMood(c), 'building');
    c = advance(c).clock;      assert.equal(clockMood(c), 'imminent');
    c = advance(c).clock;      assert.equal(clockMood(c), 'resolved');
  });

  it('surfaces only what is pressing, most urgent first', () => {
    const clocks = [
      advance(siege(), 3).clock,
      makeClock({ id: 'clock.quiet', label: 'Nothing yet', segments: 4 }),
      advance(makeClock({ id: 'clock.half', label: 'Halfway', segments: 4 }), 2).clock,
    ];
    const out = pressingClocks(clocks);
    assert.deepEqual(out.map(c => c.id), ['clock.siege', 'clock.half']);
  });

  it('rejects a malformed clock rather than silently misbehaving', () => {
    assert.throws(() => makeClock({ label: 'no id' }), /id/);
    assert.throws(() => makeClock({ id: 'x', segments: 0 }), /segments/);
  });
});
