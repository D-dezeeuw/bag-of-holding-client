import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateDungeon, DUNGEON_OVERLAYS } from '../src/dungeon/generate.js';
import { mulberry32 } from '../src/worldgen/rng.js';

// A tiny fake bestiary so the dungeon generator stays engine-free in tests.
const STATS = {
  skeleton: { cr: 0.25 }, zombie: { cr: 0.25 }, ghoul: { cr: 1 }, specter: { cr: 1 }, wight: { cr: 3 },
};
const statBlockFor = (id) => {
  if (!STATS[id]) throw new Error('unknown ' + id);
  return { hp: 10, maxHp: 10, ac: 12, toHit: 3, damageDie: '1d6', damageBonus: 1, damageType: 'slashing', cr: STATS[id].cr, tier: 'minion' };
};
const content = {
  houseStyles: ['ruined keep'],
  roomPools: {
    entrance: [{ name: 'Entrance', desc: 'A {{style}} entrance.' }],
    vault:    [{ name: 'Vault', desc: 'A vault holding {{treasure}}.' }],
    chamber:  [{ name: 'Chamber', desc: 'A {{style}} chamber.' }],
    hall:     [{ name: 'Hall', desc: 'A hall.' }],
    corridor: [{ name: 'Corridor', desc: 'A corridor.' }],
    storage:  [{ name: 'Storage', desc: 'A store room.' }],
    quarters: [{ name: 'Quarters', desc: 'Old quarters.' }],
    shrine:   [{ name: 'Shrine', desc: 'A shrine.' }],
  },
  treasures: [{ name: 'gold hoard', desc: 'coins' }],
  keys: [{ name: 'bone key', desc: 'a key' }],
  loot: [{ name: 'potion', desc: 'red vial' }],
  domainTreasures: {}, domainKeys: {},
  enemyName: (id) => id.toUpperCase(),
  enemyIntro: (id, name, style) => `${name} lurches from the ${style}.`,
};
const opts = (seed) => ({
  rng: mulberry32(seed), statBlockFor,
  blueprint: { dungeonTheme: 'undead crypt', godDomains: [{ domain: 'death' }] },
  defaultEnemyIds: ['skeleton'], content,
});

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

describe('generateDungeon', () => {
  it('requires a statBlockFor provider', () => {
    assert.throws(() => generateDungeon(1, { content }), /requires a statBlockFor/);
  });

  it('produces a valid graph: bidirectional exits, one key, vault treasure, locked gate, vault boss', () => {
    for (let s = 0; s < 40; s++) {
      const d = generateDungeon(s, opts(s));
      assert.equal(d.currentRoom, 'room-0');
      assert.ok(d.rooms[d.exitRoomId], 'exit room exists');

      // exits bidirectional
      for (const [rid, room] of Object.entries(d.rooms)) {
        assert.ok(room.name && room.description);
        for (const ex of room.exits) {
          const back = d.rooms[ex.roomId].exits.find(e => e.roomId === rid);
          assert.ok(back, `back exit ${ex.roomId}->${rid}`);
          assert.equal(back.dir, OPPOSITE[ex.dir]);
        }
      }
      // exactly one key, one locked gate requiring it
      const keys = Object.values(d.rooms).flatMap(r => r.loot.filter(l => l.id === 'found-key'));
      assert.equal(keys.length, 1, `seed ${s}: one key`);
      const locked = Object.values(d.rooms).flatMap(r => r.exits.filter(e => e.locked));
      assert.ok(locked.length >= 1 && locked[0].keyId === 'found-key');
      // treasure in the vault
      assert.equal(d.rooms[d.exitRoomId].loot.filter(l => l.type === 'treasure').length, 1);
      // a boss in the vault, tagged, with combat stats
      assert.ok(d.npcs.boss?.isBoss);
      assert.equal(d.npcs.boss.roomId, d.exitRoomId);
      for (const n of Object.values(d.npcs)) {
        assert.equal(n.attitude, 'hostile'); assert.equal(n.alive, true);
        assert.ok(typeof n.hp === 'number' && n.damageDie && n.intro);
      }
    }
  });

  it('uses the theme overlay pool and scales the boss to the highest CR', () => {
    const d = generateDungeon(3, opts(3));
    const bossCr = STATS[d.npcs.boss.creatureId].cr;
    for (const [id, n] of Object.entries(d.npcs)) {
      if (id !== 'boss') assert.ok(STATS[n.creatureId].cr <= bossCr, 'boss is the toughest');
    }
    // overlay creatures only
    const pool = DUNGEON_OVERLAYS['undead crypt'].enemies;
    for (const n of Object.values(d.npcs)) assert.ok(pool.includes(n.creatureId));
  });

  it('same seed → same dungeon', () => {
    assert.deepEqual(generateDungeon(11, opts(11)), generateDungeon(11, opts(11)));
  });
});

// The lock-and-key puzzle must be a genuine CUT of the room graph.
//
// Exits are derived for every grid-adjacent room pair, but only the single
// spine edge used to be locked — so a side route around the gate left the vault
// reachable without the key in ~69% of seeds (measured over 5000). The puzzle
// was decorative in two dungeons out of three.
describe('lock-and-key is a graph cut', () => {
  const reachableWithoutKey = (rooms) => {
    const seen = new Set(['room-0']);
    const queue = ['room-0'];
    while (queue.length) {
      for (const exit of rooms[queue.shift()].exits) {
        if (exit.locked || seen.has(exit.roomId)) continue;
        seen.add(exit.roomId);
        queue.push(exit.roomId);
      }
    }
    return seen;
  };
  const keyRoomOf = (rooms) =>
    Object.keys(rooms).find(id => (rooms[id].loot ?? []).some(i => i.id === 'found-key')) ?? null;

  it('never leaves the vault reachable without the key', () => {
    const bypassed = [];
    for (let s = 0; s < 400; s++) {
      const d = generateDungeon(s, opts(s));
      if (reachableWithoutKey(d.rooms).has(d.exitRoomId)) bypassed.push(s);
    }
    assert.deepEqual(bypassed, [], `seeds where the gate can be walked around: ${bypassed.slice(0, 10).join(', ')}`);
  });

  it('always leaves the key reachable (no soft-locks)', () => {
    const stuck = [];
    for (let s = 0; s < 400; s++) {
      const d = generateDungeon(s, opts(s));
      const key = keyRoomOf(d.rooms);
      if (!key || !reachableWithoutKey(d.rooms).has(key)) stuck.push(s);
    }
    assert.deepEqual(stuck, [], `seeds where the key cannot be reached: ${stuck.slice(0, 10).join(', ')}`);
  });

  it('locks crossings in both directions so backtracking behaves', () => {
    for (let s = 0; s < 100; s++) {
      const { rooms } = generateDungeon(s, opts(s));
      for (const [id, room] of Object.entries(rooms)) {
        for (const exit of room.exits) {
          const back = rooms[exit.roomId].exits.find(e => e.roomId === id);
          assert.equal(back.locked, exit.locked, `seed ${s}: ${id} <-> ${exit.roomId} disagree on locked`);
        }
      }
    }
  });

  it('every locked exit names the key that opens it', () => {
    for (let s = 0; s < 100; s++) {
      const { rooms } = generateDungeon(s, opts(s));
      for (const room of Object.values(rooms)) {
        for (const exit of room.exits) {
          if (exit.locked) assert.equal(exit.keyId, 'found-key');
        }
      }
    }
  });
});

describe('the vault treasure passes its fields through (2026-08-09 audit)', () => {
  it('keeps the pool description and value', () => {
    const richContent = {
      ...content,
      treasures: [{ name: 'gold idol', desc: 'A gold idol with garnet eyes.', value: 999, lore: 'old' }],
    };
    const d = generateDungeon(11, { ...opts(11), content: richContent });
    const treasure = Object.values(d.rooms).flatMap(r => r.loot ?? []).find(i => i.type === 'treasure');
    assert.equal(treasure.description, 'A gold idol with garnet eyes.',
      'the campaign goal object reached the narrator descriptionless');
    assert.equal(treasure.value, 999, 'the flat 250 clobbered every authored value');
    assert.equal(treasure.lore, 'old', 'full pass-through, same contract as scattered loot');
    assert.equal(treasure.taken, false);
  });

  it('defaults value to 250 when the pool has none', () => {
    const d = generateDungeon(12, opts(12));
    const treasure = Object.values(d.rooms).flatMap(r => r.loot ?? []).find(i => i.type === 'treasure');
    assert.equal(treasure.value, 250);
    assert.ok(treasure.description, 'generic treasures carry their desc too');
  });
});
