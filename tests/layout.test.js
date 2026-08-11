// tests/layout.test.js — space that makes sense (doc 18 §10, phase G).
//
// The street graph is seeded data, never prose: the walk from the bakery down
// the lane and left to the butcher must be the same walk every session. The
// dungeon's own suite pins the extraction; this file covers the settlement
// costume.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateLayout, deriveAdjacency, OPPOSITE } from '../src/layout/engine.js';
import { settlementLayout, cityLayout, bindSettlement, SETTLEMENT_SIZES } from '../src/layout/settlement.js';

describe('generateLayout (the shared core)', () => {
  it('is deterministic and structurally sound', () => {
    const a = generateLayout(42);
    const b = generateLayout(42);
    assert.deepEqual(a, b);
    assert.ok(a.positions.length >= a.spineIds.length);
    assert.equal(a.entrance, 0);
    assert.equal(a.focus, a.spineIds.length - 1);
    // every grid-adjacent pair got a reciprocal exit
    for (let i = 0; i < a.positions.length; i++) {
      for (const exit of a.adjacency[i]) {
        assert.ok(a.adjacency[exit.target].some(x => x.target === i && x.dir === OPPOSITE[exit.dir]));
      }
    }
  });

  it('every plot is reachable from the entrance', () => {
    for (let seed = 0; seed < 20; seed++) {
      const l = generateLayout(seed);
      const seen = new Set([0]);
      const stack = [0];
      while (stack.length) {
        for (const e of l.adjacency[stack.pop()]) {
          if (!seen.has(e.target)) { seen.add(e.target); stack.push(e.target); }
        }
      }
      assert.equal(seen.size, l.positions.length, `seed ${seed}`);
    }
  });
});

describe('settlementLayout', () => {
  const BUILDINGS = ['inn', 'blacksmith', 'bakery', 'apothecary', 'temple'];

  it('the walk is the same walk in session forty', () => {
    const a = settlementLayout(1234, { kind: 'town', buildings: BUILDINGS });
    const b = settlementLayout(1234, { kind: 'town', buildings: BUILDINGS });
    assert.deepEqual(a, b);
    // bakery's neighbours (and their directions) are stable data, not prose
    const bakery = a.plots.find(p => p.building === 'bakery');
    assert.ok(bakery);
    assert.deepEqual(bakery.exits, b.plots.find(p => p.building === 'bakery').exits);
  });

  it('has one gate, one square, and places every building', () => {
    const l = settlementLayout(7, { kind: 'town', buildings: BUILDINGS });
    assert.equal(l.plots.filter(p => p.role === 'gate').length, 1);
    assert.equal(l.plots.filter(p => p.role === 'square').length, 1);
    const placed = l.plots.filter(p => p.building).map(p => p.building);
    const stalls = l.plots.find(p => p.role === 'square').stalls ?? [];
    assert.deepEqual([...placed, ...stalls].sort(), [...BUILDINGS].sort());
  });

  it('a hamlet stays small; overflow gathers on the square as stalls', () => {
    const many = ['inn', 'blacksmith', 'bakery', 'temple', 'market hall', 'stables', 'brewery', 'tannery'];
    const l = settlementLayout(3, { kind: 'hamlet', buildings: many });
    assert.ok(l.plots.length <= SETTLEMENT_SIZES.hamlet.spineMax + SETTLEMENT_SIZES.hamlet.branchMax);
    const stalls = l.plots.find(p => p.role === 'square')?.stalls ?? [];
    assert.ok(stalls.length >= 1, 'overflow must land as stalls, not vanish');
  });
});

describe('cityLayout', () => {
  it('a city is a tree of small graphs: seeded stub districts, connected', () => {
    const a = cityLayout(99);
    assert.deepEqual(a, cityLayout(99));
    assert.ok(a.districts.length >= 3 && a.districts.length <= 5);
    for (const d of a.districts) {
      assert.equal(d.stub, true);
      assert.ok(Number.isFinite(d.seed));
      assert.ok(d.exits.length >= 1, `${d.id} disconnected`);
      // a district lays out its own streets from its own seed, lazily
      const streets = settlementLayout(d.seed, { kind: 'village' });
      assert.ok(streets.plots.length >= 2);
    }
  });
});

describe('bindSettlement', () => {
  const layout = settlementLayout(1234, { kind: 'town', buildings: ['inn', 'blacksmith', 'temple'] });
  const settlement = {
    id: 's', name: 'Fenwick', description: 'x',
    npcs: [
      { id: 'n1', name: 'Vera', role: 'innkeeper', attitude: 'friendly', greeting: 'hm' },
      { id: 'n2', name: 'Brack', role: 'blacksmith', attitude: 'neutral', greeting: 'mm' },
      { id: 'n3', name: 'Odd', role: 'hermit', attitude: 'suspicious', greeting: '...' },
      { id: 'n4', name: 'Lost', role: 'merchant', attitude: 'neutral', greeting: 'eh' },
    ],
    exits: [
      { direction: 'east', targetName: 'the deep', targetType: 'dungeon', targetId: null },
      { direction: 'west', targetName: 'the road', targetType: 'road', targetId: null },
    ],
  };

  it('workplace NPCs land on their buildings; gates carry the schema exits', () => {
    const bound = bindSettlement(layout, settlement);
    const vera = bound.npcBindings.find(b => b.npcId === 'n1');
    assert.equal(vera.building, 'inn');
    const brack = bound.npcBindings.find(b => b.npcId === 'n2');
    assert.equal(brack.building, 'blacksmith');
    assert.equal(bound.gates.length, 2);
    for (const g of bound.gates) assert.ok(g.plotId);
  });

  it('coerces, never rejects: no merchant building → the square; hermits bind nowhere', () => {
    const bound = bindSettlement(layout, settlement);
    const lost = bound.npcBindings.find(b => b.npcId === 'n4');
    assert.equal(lost.plotId, layout.square);
    assert.deepEqual(bound.coerced.map(c => c.npcId), ['n4']);
    const odd = bound.npcBindings.find(b => b.npcId === 'n3');
    assert.equal(odd.plotId, null); // unhoused by design
  });
});
