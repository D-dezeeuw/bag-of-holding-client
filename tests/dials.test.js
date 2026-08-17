// tests/dials.test.js — the generation dials (the future admin page's knobs).
//
// One options bag on bakeCartridge sizes the world and its powers; the
// settlement ladder gains real city rows and a size override; the dungeon's
// enemy density scales. The contract throughout: ALL DIALS NULL = the
// pre-dial output, byte-identical, so existing worlds and tests never move.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bakeCartridge } from '../src/worldgen/cartridge.js';
import { mintWorldSkeleton } from '../src/worldgen/skeleton.js';
import { settlementLayout, cityLayout, SETTLEMENT_SIZES } from '../src/layout/settlement.js';
import { generateDungeon } from '../src/dungeon/generate.js';
import { mulberry32 } from '../src/worldgen/rng.js';

describe('world dials', () => {
  it('bakeCartridge forwards size and power dials', async () => {
    const cart = await bakeCartridge(1234, {
      continents: 6, provincesPer: 5,
      factionCount: 12, npcsPerFaction: 3, legendCount: 3,
    });
    const nodes = Object.values(cart.data.geo.nodes);
    assert.equal(nodes.filter(n => n.kind === 'continent').length, 6);
    assert.equal(nodes.filter(n => n.kind === 'province').length, 30);
    assert.equal(cart.data.factions.length, 12);
    assert.equal(cart.data.npcs.length, 36);
    assert.equal(cart.data.lore.legends.length, 18);
    // Every faction still gets a leader; extras are notables.
    assert.equal(cart.data.npcs.filter(n => n.role !== 'notable').length, 12);
  });

  it('dialed-up worlds keep unique names', () => {
    // 12×8 used to mint ~26 duplicate province names; 47% of DEFAULT worlds
    // shipped at least one duplicate. Now every name is unique, world-wide.
    for (const seed of [1, 7, 42, 1234, 555]) {
      const sk = mintWorldSkeleton(seed, { continents: 12, provincesPer: 8 });
      const names = Object.values(sk.geo.nodes).map(n => n.name);
      assert.equal(new Set(names).size, names.length, `seed ${seed} minted a duplicate name`);
    }
  });

  it('default worlds are collision-free too, with primary draws preserved', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const sk = mintWorldSkeleton(seed);
      const names = Object.values(sk.geo.nodes).map(n => n.name);
      assert.equal(new Set(names).size, names.length, `seed ${seed} minted a duplicate name`);
    }
  });
});

describe('settlement dials', () => {
  const BUILDINGS = Array.from({ length: 100 }, (_, i) => ({ type: 'house', name: `building-${i}` }));

  it('the ladder has real city rows and a size override', () => {
    assert.ok(SETTLEMENT_SIZES.city && SETTLEMENT_SIZES.metropolis);
    const city = settlementLayout(9, { kind: 'metropolis', buildings: BUILDINGS });
    const placed = city.plots.filter(p => p.building).length;
    assert.ok(placed >= 15, `a metropolis places a real street plan (placed ${placed})`);
    // The size override goes past the ladder entirely.
    const big = settlementLayout(9, {
      kind: 'town',
      size: { spineMin: 40, spineMax: 40, branchMin: 60, branchMax: 60 },
      buildings: BUILDINGS,
    });
    assert.ok(big.plots.filter(p => p.building).length >= 60,
      'a 100-building order mostly lands on plots, not stalls');
  });

  it('an unknown kind throws with the ladder named (no more silent village)', () => {
    assert.throws(() => settlementLayout(1, { kind: 'megacity' }), /unknown kind.*hamlet/s);
  });

  it('cityLayout cycles quarter names past eight instead of throwing', () => {
    const twelve = cityLayout(3, { districts: 12 });
    assert.equal(twelve.districts.length, 12);
    const names = twelve.districts.map(d => d.quarter);
    assert.equal(new Set(names).size, 12, 'cycled quarters stay distinct');
  });
});

describe('dungeon density dial', () => {
  const statBlockFor = (id) => ({ hp: 10, maxHp: 10, ac: 12, toHit: 3, damageDie: '1d6', damageBonus: 1, damageType: 'slashing', cr: 1, tier: 'minion' });
  const big = (seed, extra = {}) => generateDungeon(seed, {
    rng: mulberry32(seed), statBlockFor, defaultEnemyIds: ['skeleton', 'zombie', 'ghoul', 'wight'],
    size: { spineMin: 60, spineMax: 60, branchMin: 40, branchMax: 40 },
    content: {}, ...extra,
  });

  it('big dungeons can field more than three enemies', () => {
    let most = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const d = big(seed);
      most = Math.max(most, Object.keys(d.npcs).length - 1);
    }
    assert.ok(most > 3, `100-room dungeons were hard-capped at 3 enemies (saw ${most})`);
  });

  it('maxEnemies is the host dial; small dungeons are untouched', () => {
    const dialed = big(5, { maxEnemies: 2 });
    assert.ok(Object.keys(dialed.npcs).length - 1 <= 2);
    for (let seed = 1; seed <= 20; seed++) {
      const small = generateDungeon(seed, { rng: mulberry32(seed), statBlockFor, defaultEnemyIds: ['skeleton'], content: {} });
      assert.ok(Object.keys(small.npcs).length - 1 <= 3, 'default-size behavior unchanged');
    }
  });
});
