// src/dungeon/generate.js — procedural dungeon-graph generator.
//
// Algorithm (host-agnostic):
//   1. spine of 4-6 rooms (start → vault)
//   2. attach 2-4 branch rooms
//   3. place on a 2D grid, derive cardinal exits
//   4. lock one spine gate, hide its key in a pre-gate branch
//   5. place a depth-scaled enemy in 1-3 rooms + a boss in the vault
//   6. scatter loot, dress rooms with descriptions
//
// The algorithm is owned here; all CONTENT is injected so the library carries no
// i18n and no rules engine:
//   generateDungeon(seed, {
//     blueprint,                       // { dungeonTheme, godDomains } — optional
//     rng,                             // () => [0,1); defaults to mulberry32(seed)
//     statBlockFor(id) -> stat block,  // REQUIRED — from the host's bestiary/engine
//     crOf(id) -> number,              // optional; defaults to statBlockFor(id).cr
//     overlays,                        // theme → { atmosphere, enemies:[id] }; default DUNGEON_OVERLAYS
//     defaultEnemyIds: [id],           // fallback pool when no overlay matches
//     content: { houseStyles, roomPools, treasures, keys, loot,
//                domainTreasures, domainKeys, enemyName(id), enemyIntro(id,name,style) },
//   }) -> { currentRoom, exitRoomId, rooms, npcs }

import { mulberry32, pick as rpick, shuffle as rshuffle, randInt as rrandInt } from '../worldgen/rng.js';

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const MID_TYPES = ['hall', 'corridor', 'chamber', 'storage', 'quarters', 'shrine'];

// Theme → ascending-challenge creature-id pool (the last id is the vault boss).
export const DUNGEON_OVERLAYS = Object.freeze({
  'undead crypt':         { atmosphere: 'The air reeks of embalming salts and grave earth.',                    enemies: ['skeleton', 'zombie', 'ghoul', 'specter', 'wight'] },
  'goblin warren':        { atmosphere: 'Crude markings cover the walls. Something gnaws in the dark.',          enemies: ['kobold', 'goblin', 'worg', 'hobgoblin', 'bugbear'] },
  'cult sanctum':         { atmosphere: 'Candle wax pools on every surface. Chanting echoes from deeper within.', enemies: ['acolyte', 'cultist', 'shadow', 'specter', 'cult-fanatic'] },
  'beast lair':           { atmosphere: 'Claw marks gouge the stone. The stench of animal musk is overwhelming.', enemies: ['giant-rat', 'wolf', 'black-bear', 'dire-wolf', 'owlbear'] },
  'arcane ruin':          { atmosphere: 'Faint runes pulse along the walls. The air crackles with residual magic.', enemies: ['flying-sword', 'animated-armor', 'imp', 'specter', 'gibbering-mouther'] },
  'flooded cavern':       { atmosphere: 'Water drips from the ceiling. The floor is slick and treacherous.',     enemies: ['giant-rat', 'constrictor-snake', 'cave-spider', 'crocodile', 'giant-spider'] },
  'haunted manor':        { atmosphere: 'Dust motes drift through pale light. A door creaks on its own.',        enemies: ['zombie', 'shadow', 'specter', 'ghoul', 'wight'] },
  'abandoned mine':       { atmosphere: 'Rotting timber props sag under the weight of earth. Pickaxes rust in corners.', enemies: ['kobold', 'swarm-of-rats', 'giant-spider', 'ghoul', 'ogre'] },
  'dragon hoard':         { atmosphere: 'Scorch marks blacken the walls. The heat is unnatural.',                enemies: ['kobold', 'skeleton', 'magma-mephit', 'hell-hound', 'young-drake'] },
  'vampire castle':       { atmosphere: 'Velvet drapes hang in tatters. The scent of old blood lingers.',        enemies: ['zombie', 'shadow', 'specter', 'ghoul', 'vampire-spawn'] },
  'elemental nexus':      { atmosphere: 'Sparks of raw energy arc between the walls. The ground hums.',          enemies: ['flying-sword', 'magma-mephit', 'ice-mephit', 'imp', 'will-o-wisp'] },
  'fungal depths':        { atmosphere: 'Bioluminescent mushrooms cast an eerie glow. Spores drift lazily.',     enemies: ['violet-fungus', 'cave-spider', 'fungal-zombie', 'giant-spider', 'myconid-sovereign'] },
  'clockwork vault':      { atmosphere: 'Gears click and whir behind the walls. The floor vibrates rhythmically.', enemies: ['kobold', 'flying-sword', 'animated-armor', 'stone-sentinel'] },
  'planar rift':          { atmosphere: 'Reality shimmers at the edges. Colours that shouldn\'t exist bleed through.', enemies: ['shadow', 'imp', 'specter', 'will-o-wisp', 'gibbering-mouther'] },
  'sunken temple':        { atmosphere: 'Waterlogged stone and barnacle-crusted pillars. Fish bones crunch underfoot.', enemies: ['zombie', 'constrictor-snake', 'crocodile', 'specter', 'ghoul'] },
  'frozen tomb':          { atmosphere: 'Ice coats every surface. Your breath crystallizes instantly.',          enemies: ['skeleton', 'zombie', 'ice-mephit', 'specter', 'wight'] },
  'spider nest':          { atmosphere: 'Silk threads catch the light everywhere. Husks of drained prey line the walls.', enemies: ['spider', 'giant-rat', 'cave-spider', 'giant-spider', 'ankheg'] },
  'bandit fortress':      { atmosphere: 'Crude barricades and stolen goods are piled in every corner.',          enemies: ['bandit', 'scout', 'spy', 'bandit-captain', 'veteran'] },
  'fey glade gone wrong': { atmosphere: 'Flowers bloom in impossible colours. The laughter you hear isn\'t human.', enemies: ['wolf', 'worg', 'dire-wolf', 'will-o-wisp', 'owlbear'] },
  'demonic hellgate':     { atmosphere: 'The stone is warm to the touch. Symbols of binding cover every surface.', enemies: ['cultist', 'imp', 'cult-fanatic', 'hell-hound', 'lesser-demon'] },
  'ancient library':      { atmosphere: 'Shelves of rotting tomes stretch into shadow. Pages flutter with no wind.', enemies: ['flying-sword', 'shadow', 'animated-armor', 'specter', 'gibbering-mouther'] },
  'petrified giant':      { atmosphere: 'The walls are organic — veins of stone pulse faintly. You\'re inside something.', enemies: ['swarm-of-rats', 'cave-spider', 'animated-armor', 'stone-sentinel'] },
  'living dungeon':       { atmosphere: 'The corridors shift when you\'re not looking. The dungeon is alive.',   enemies: ['violet-fungus', 'shadow', 'animated-armor', 'gibbering-mouther'] },
  'dream prison':         { atmosphere: 'The geometry is wrong. Stairs lead sideways. Gravity is a suggestion.', enemies: ['shadow', 'specter', 'will-o-wisp', 'gibbering-mouther', 'banshee'] },
});

function interp(str, params) {
  let out = str ?? '';
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}

function dirBetween(from, to) {
  const dc = to.col - from.col, dr = to.row - from.row;
  if (dc === 1 && dr === 0) return 'east';
  if (dc === -1 && dr === 0) return 'west';
  if (dc === 0 && dr === -1) return 'north';
  if (dc === 0 && dr === 1) return 'south';
  return null;
}

function placeOnGrid(count, rng) {
  const offsets = () => rshuffle([{ dc: 1, dr: 0 }, { dc: -1, dr: 0 }, { dc: 0, dr: -1 }, { dc: 0, dr: 1 }], rng);
  const grid = new Map();
  const positions = [];
  let col = 0, row = 0;
  grid.set('0,0', 0); positions.push({ col, row });
  for (let i = 1; i < count; i++) {
    let placed = false;
    for (const { dc, dr } of offsets()) {
      const nc = col + dc, nr = row + dr;
      if (!grid.has(`${nc},${nr}`)) { grid.set(`${nc},${nr}`, i); positions.push({ col: nc, row: nr }); col = nc; row = nr; placed = true; break; }
    }
    if (!placed) {
      for (let j = positions.length - 1; j >= 0 && !placed; j--) {
        const p = positions[j];
        for (const { dc, dr } of offsets()) {
          const nc = p.col + dc, nr = p.row + dr;
          if (!grid.has(`${nc},${nr}`)) { grid.set(`${nc},${nr}`, i); positions.push({ col: nc, row: nr }); col = nc; row = nr; placed = true; break; }
        }
      }
    }
  }
  return { grid, positions };
}

function attachBranch(parentIdx, positions, grid, rng) {
  const p = positions[parentIdx];
  for (const { dc, dr } of rshuffle([{ dc: 1, dr: 0 }, { dc: -1, dr: 0 }, { dc: 0, dr: -1 }, { dc: 0, dr: 1 }], rng)) {
    const nc = p.col + dc, nr = p.row + dr;
    if (!grid.has(`${nc},${nr}`)) { const idx = positions.length; grid.set(`${nc},${nr}`, idx); positions.push({ col: nc, row: nr }); return idx; }
  }
  return -1;
}

function buildEnemyNpc(npcId, roomId, creatureId, style, c, statBlockFor, extra = {}) {
  const name = c.enemyName ? c.enemyName(creatureId) : creatureId;
  return {
    id: npcId, roomId, name, creatureId,
    ...statBlockFor(creatureId),
    conditions: [], attitude: 'hostile', alive: true,
    intro: c.enemyIntro ? c.enemyIntro(creatureId, name, style) : `${name} appears, hostile.`,
    ...extra,
  };
}

export function generateDungeon(seed, opts = {}) {
  const {
    blueprint = null,
    rng = mulberry32(typeof seed === 'number' ? seed : 0),
    statBlockFor,
    crOf = (id) => statBlockFor(id)?.cr ?? 0,
    overlays = DUNGEON_OVERLAYS,
    defaultEnemyIds = [],
    content = {},
  } = opts;

  if (typeof statBlockFor !== 'function') throw new Error('generateDungeon requires a statBlockFor(id) provider');

  const c = content;
  const styleList = c.houseStyles?.length ? c.houseStyles : ['ancient hold'];
  const style = rpick(styleList, rng);

  const overlay = blueprint?.dungeonTheme ? (overlays[blueprint.dungeonTheme] ?? null) : null;
  const atmosphere = overlay?.atmosphere ?? '';
  const primaryDomain = blueprint?.godDomains?.[0]?.domain ?? null;

  // 1. spine + 2. branches
  const spineLen = rrandInt(4, 6, rng);
  const { grid, positions } = placeOnGrid(spineLen, rng);
  const spineIds = Array.from({ length: spineLen }, (_, i) => i);

  const branchCount = rrandInt(2, 4, rng);
  const branchIds = [];
  const branchParent = {};
  const candidates = spineIds.slice(1, -1);
  for (let b = 0; b < branchCount; b++) {
    const parent = rpick(candidates.length ? candidates : spineIds.slice(1), rng);
    const idx = attachBranch(parent, positions, grid, rng);
    if (idx >= 0) { branchIds.push(idx); branchParent[idx] = parent; }
  }

  const totalRooms = positions.length;

  // 3. adjacency
  const adjacency = Array.from({ length: totalRooms }, () => []);
  for (let i = 0; i < totalRooms; i++) {
    for (let j = i + 1; j < totalRooms; j++) {
      const dir = dirBetween(positions[i], positions[j]);
      if (dir) { adjacency[i].push({ target: j, dir }); adjacency[j].push({ target: i, dir: OPPOSITE[dir] }); }
    }
  }

  // 4. room types
  const roomTypes = [];
  for (let i = 0; i < totalRooms; i++) {
    roomTypes[i] = i === 0 ? 'entrance' : (i === spineLen - 1 && spineIds.includes(i)) ? 'vault' : rpick(MID_TYPES, rng);
  }

  // themed treasure + key (domain → generic fallback)
  const dt = c.domainTreasures ?? {};
  const dk = c.domainKeys ?? {};
  const genTreasures = c.treasures?.length ? c.treasures : [{ name: 'hoard of coin', desc: 'A glittering pile of gold.' }];
  const genKeys = c.keys?.length ? c.keys : [{ name: 'iron key', desc: 'A heavy iron key.' }];
  const treasure = (primaryDomain && dt[primaryDomain])
    ? { ...dt[primaryDomain], id: 'treasure', type: 'treasure', value: 250, taken: false }
    : { ...rpick(genTreasures, rng), id: 'treasure', type: 'treasure', value: 250, taken: false };
  const keyItem = (primaryDomain && dk[primaryDomain])
    ? { ...dk[primaryDomain], id: 'found-key', taken: false }
    : { ...rpick(genKeys, rng), id: 'found-key', taken: false };

  const rooms = {};
  for (let i = 0; i < totalRooms; i++) {
    const id = `room-${i}`;
    const type = roomTypes[i];
    const pool = (c.roomPools && (c.roomPools[type] ?? c.roomPools.chamber)) ?? [{ name: 'Chamber', desc: 'A bare stone room.' }];
    const def = rpick(pool, rng);
    const descParams = { style };
    if (type === 'vault') descParams.treasure = treasure.name;
    const baseDesc = interp(def.desc, descParams);
    const themedDesc = (atmosphere && type !== 'entrance' && type !== 'vault') ? `${baseDesc} ${atmosphere}` : baseDesc;
    rooms[id] = {
      id, name: def.name, description: themedDesc,
      exits: adjacency[i].map(a => ({ dir: a.dir, roomId: `room-${a.target}`, locked: false })),
      loot: [],
    };
  }

  // 5. lock gate + key
  const gateSpineIdx = rrandInt(1, spineLen - 2, rng);
  const gateRoom = rooms[`room-${spineIds[gateSpineIdx]}`];
  const gateExit = gateRoom.exits.find(e => e.roomId === `room-${spineIds[gateSpineIdx + 1]}`);
  if (gateExit) { gateExit.locked = true; gateExit.keyId = 'found-key'; }

  let keyPlaced = false;
  for (const bIdx of branchIds) {
    if (spineIds.indexOf(branchParent[bIdx]) <= gateSpineIdx) {
      rooms[`room-${bIdx}`].loot.push({ id: 'found-key', name: keyItem.name, description: keyItem.desc, taken: false });
      keyPlaced = true; break;
    }
  }
  if (!keyPlaced) {
    const keyRoomIdx = rpick(spineIds.slice(1, gateSpineIdx + 1), rng);
    rooms[`room-${keyRoomIdx}`].loot.push({ id: 'found-key', name: keyItem.name, description: keyItem.desc, taken: false });
  }

  rooms[`room-${spineLen - 1}`].loot.push(treasure);

  // 6. enemies — depth-scaled + vault boss
  const poolIds = (overlay?.enemies?.length ? overlay.enemies : defaultEnemyIds).filter(id => {
    try { statBlockFor(id); return true; } catch { return false; }
  });
  const sortedPool = [...(poolIds.length ? poolIds : defaultEnemyIds)].sort((a, b) => crOf(a) - crOf(b));
  const npcs = {};

  if (sortedPool.length) {
    const bossId = sortedPool[sortedPool.length - 1];
    const spawnPool = sortedPool.length > 1 ? sortedPool.slice(0, -1) : sortedPool;
    const depthFraction = (roomIdx) => {
      const order = roomIdx < spineLen ? roomIdx : (branchParent[roomIdx] ?? 1);
      return spineLen > 1 ? order / (spineLen - 1) : 0;
    };

    npcs.boss = buildEnemyNpc('boss', `room-${spineLen - 1}`, bossId, style, c, statBlockFor, { isBoss: true });

    const enemyCount = rrandInt(1, Math.min(3, totalRooms - 2), rng);
    const enemyRooms = rshuffle(Array.from({ length: totalRooms }, (_, i) => i).filter(i => i !== 0 && i !== spineLen - 1), rng).slice(0, enemyCount);
    for (let e = 0; e < enemyRooms.length; e++) {
      const frac = depthFraction(enemyRooms[e]);
      const idx = Math.min(spawnPool.length - 1, Math.max(0, Math.round(frac * (spawnPool.length - 1))));
      npcs[`enemy-${e + 1}`] = buildEnemyNpc(`enemy-${e + 1}`, `room-${enemyRooms[e]}`, spawnPool[idx], style, c, statBlockFor);
    }
  }

  // 7. scatter loot in keyless branch rooms
  const lootPool = c.loot ?? [];
  for (const bIdx of branchIds) {
    const room = rooms[`room-${bIdx}`];
    if (room.loot.length === 0 && lootPool.length) {
      const item = rpick(lootPool, rng);
      room.loot.push({ id: `loot-${bIdx}`, name: item.name, description: item.desc, taken: false });
    }
  }

  return { currentRoom: 'room-0', exitRoomId: `room-${spineLen - 1}`, rooms, npcs };
}
