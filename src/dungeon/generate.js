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
//     statBlockFor(id, { isBoss }) -> stat block,  // REQUIRED — host's bestiary
//     crOf(id) -> number,              // optional; defaults to statBlockFor(id).cr
//     overlays,                        // theme → { atmosphere, enemies:[id] }; default DUNGEON_OVERLAYS
//     defaultEnemyIds: [id],           // fallback pool when no overlay matches
//     content: { houseStyles, roomPools, treasures, keys, loot,
//                domainTreasures, domainKeys, enemyName(id), enemyIntro(id,name,style) },
//   }) -> { currentRoom, exitRoomId, rooms, npcs }

import { mulberry32, pick as rpick, shuffle as rshuffle, randInt as rrandInt } from '../worldgen/rng.js';
// The spatial core lives in layout/engine.js now (doc 18 §10) — settlements
// wear the same skeleton. Extraction is verbatim; the dungeon tests pin the
// output.
import { placeOnGrid, attachBranch, dirBetween, OPPOSITE } from '../layout/engine.js';

const MID_TYPES = ['hall', 'corridor', 'chamber', 'storage', 'quarters', 'shrine'];

// Theme → ascending-challenge creature-id pool (the last id is the vault boss).
export const DUNGEON_OVERLAYS = Object.freeze({
  'undead crypt':         { atmosphere: 'The air reeks of embalming salts and grave earth.',                    enemies: ['skeleton', 'zombie', 'ghoul', 'specter', 'wight'] },
  'goblin warren':        { atmosphere: 'Crude markings cover the walls. Something gnaws in the dark.',          enemies: ['kobold', 'goblin', 'worg', 'hobgoblin', 'bugbear'] },
  'cult sanctum':         { atmosphere: 'Candle wax pools on every surface. Chanting echoes from deeper within.', enemies: ['acolyte', 'cultist', 'shadow', 'specter', 'cult-fanatic'] },
  'beast lair':           { atmosphere: 'Claw marks gouge the stone. The stench of animal musk is overwhelming.', enemies: ['giant-rat', 'wolf', 'black-bear', 'dire-wolf', 'owlbear'] },
  'arcane ruin':          { atmosphere: 'Faint runes pulse along the walls. The air crackles with residual magic.', enemies: ['flying-sword', 'animated-armor', 'imp', 'specter', 'gibbering-mouther'] },
  // Overlay ids resolve against the kernel registry (2.6.0 added the
  // eight blocks these pools had referenced into the void for months;
  // `cave-spider` was invented, renamed here to the SRD-listed
  // `giant-wolf-spider`). The last five holdouts — fungal-zombie,
  // stone-sentinel, myconid-sovereign, young-drake, lesser-demon —
  // shipped in the kernel's Bestiary I (2.7.0): a host that mounts it
  // (`createEngine({ extraMonsters: BESTIARY_I })`) resolves every
  // pool in full. Against a bare-SRD engine the statBlockFor guard
  // below still filters them and the highest surviving CR stands in
  // as the vault boss — degraded, never empty.
  'flooded cavern':       { atmosphere: 'Water drips from the ceiling. The floor is slick and treacherous.',     enemies: ['giant-rat', 'constrictor-snake', 'giant-wolf-spider', 'crocodile', 'giant-spider'] },
  'haunted manor':        { atmosphere: 'Dust motes drift through pale light. A door creaks on its own.',        enemies: ['zombie', 'shadow', 'specter', 'ghoul', 'wight'] },
  'abandoned mine':       { atmosphere: 'Rotting timber props sag under the weight of earth. Pickaxes rust in corners.', enemies: ['kobold', 'swarm-of-rats', 'giant-spider', 'ghoul', 'ogre'] },
  'dragon hoard':         { atmosphere: 'Scorch marks blacken the walls. The heat is unnatural.',                enemies: ['kobold', 'skeleton', 'magma-mephit', 'hell-hound', 'young-drake'] },
  'vampire castle':       { atmosphere: 'Velvet drapes hang in tatters. The scent of old blood lingers.',        enemies: ['zombie', 'shadow', 'specter', 'ghoul', 'vampire-spawn'] },
  'elemental nexus':      { atmosphere: 'Sparks of raw energy arc between the walls. The ground hums.',          enemies: ['flying-sword', 'magma-mephit', 'ice-mephit', 'imp', 'will-o-wisp'] },
  'fungal depths':        { atmosphere: 'Bioluminescent mushrooms cast an eerie glow. Spores drift lazily.',     enemies: ['violet-fungus', 'giant-wolf-spider', 'fungal-zombie', 'giant-spider', 'myconid-sovereign'] },
  'clockwork vault':      { atmosphere: 'Gears click and whir behind the walls. The floor vibrates rhythmically.', enemies: ['kobold', 'flying-sword', 'animated-armor', 'stone-sentinel'] },
  'planar rift':          { atmosphere: 'Reality shimmers at the edges. Colours that shouldn\'t exist bleed through.', enemies: ['shadow', 'imp', 'specter', 'will-o-wisp', 'gibbering-mouther'] },
  'sunken temple':        { atmosphere: 'Waterlogged stone and barnacle-crusted pillars. Fish bones crunch underfoot.', enemies: ['zombie', 'constrictor-snake', 'crocodile', 'specter', 'ghoul'] },
  'frozen tomb':          { atmosphere: 'Ice coats every surface. Your breath crystallizes instantly.',          enemies: ['skeleton', 'zombie', 'ice-mephit', 'specter', 'wight'] },
  'spider nest':          { atmosphere: 'Silk threads catch the light everywhere. Husks of drained prey line the walls.', enemies: ['spider', 'giant-rat', 'giant-wolf-spider', 'giant-spider', 'ankheg'] },
  'bandit fortress':      { atmosphere: 'Crude barricades and stolen goods are piled in every corner.',          enemies: ['bandit', 'scout', 'spy', 'bandit-captain', 'veteran'] },
  'fey glade gone wrong': { atmosphere: 'Flowers bloom in impossible colours. The laughter you hear isn\'t human.', enemies: ['wolf', 'worg', 'dire-wolf', 'will-o-wisp', 'owlbear'] },
  'demonic hellgate':     { atmosphere: 'The stone is warm to the touch. Symbols of binding cover every surface.', enemies: ['cultist', 'imp', 'cult-fanatic', 'hell-hound', 'lesser-demon'] },
  'ancient library':      { atmosphere: 'Shelves of rotting tomes stretch into shadow. Pages flutter with no wind.', enemies: ['flying-sword', 'shadow', 'animated-armor', 'specter', 'gibbering-mouther'] },
  'petrified giant':      { atmosphere: 'The walls are organic — veins of stone pulse faintly. You\'re inside something.', enemies: ['swarm-of-rats', 'giant-wolf-spider', 'animated-armor', 'stone-sentinel'] },
  'living dungeon':       { atmosphere: 'The corridors shift when you\'re not looking. The dungeon is alive.',   enemies: ['violet-fungus', 'shadow', 'animated-armor', 'gibbering-mouther'] },
  'dream prison':         { atmosphere: 'The geometry is wrong. Stairs lead sideways. Gravity is a suggestion.', enemies: ['shadow', 'specter', 'will-o-wisp', 'gibbering-mouther', 'banshee'] },
});

function interp(str, params) {
  let out = str ?? '';
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}

function buildEnemyNpc(npcId, roomId, creatureId, style, c, statBlockFor, extra = {}) {
  const name = c.enemyName ? c.enemyName(creatureId) : creatureId;
  // The host's provider is told whether this is the vault boss, so it can hand
  // back a raised stat block (multiattack, legendary actions) instead of the
  // ordinary one. Providers that ignore the second argument are unaffected.
  const block = statBlockFor(creatureId, { isBoss: extra.isBoss === true });
  return {
    id: npcId, roomId, name, creatureId,
    ...block,
    // A raised block carries its own display name ("Ancient Wight").
    ...(block?.name ? { name: block.name } : {}),
    conditions: [], attitude: 'hostile', alive: true,
    intro: c.enemyIntro ? c.enemyIntro(creatureId, name, style) : `${name} appears, hostile.`,
    ...extra,
  };
}

// Default dungeon scale — the shape every dungeon had before `opts.size` existed.
export const DEFAULT_SIZE = { spineMin: 4, spineMax: 6, branchMin: 2, branchMax: 4 };

export function generateDungeon(seed, opts = {}) {
  const {
    blueprint = null,
    rng = mulberry32(typeof seed === 'number' ? seed : 0),
    statBlockFor,
    crOf = (id) => statBlockFor(id)?.cr ?? 0,
    overlays = DUNGEON_OVERLAYS,
    defaultEnemyIds = [],
    content = {},
    size = {},
  } = opts;

  if (typeof statBlockFor !== 'function') throw new Error('generateDungeon requires a statBlockFor(id) provider');

  const c = content;
  const styleList = c.houseStyles?.length ? c.houseStyles : ['ancient hold'];
  const style = rpick(styleList, rng);

  const overlay = blueprint?.dungeonTheme ? (overlays[blueprint.dungeonTheme] ?? null) : null;
  const atmosphere = overlay?.atmosphere ?? '';
  const primaryDomain = blueprint?.godDomains?.[0]?.domain ?? null;

  // 1. spine + 2. branches
  //
  // Sizes come from `opts.size` so a host can scale a dungeon to the act it sits
  // in — a prologue crypt and a late-campaign fortress used to be the same four
  // to six rooms. The spine floor is 3: the lock gate is placed strictly between
  // the entrance and the vault, so a shorter spine has nowhere to put it.
  const sz        = { ...DEFAULT_SIZE, ...size };
  const spineMin  = Math.max(3, Math.trunc(sz.spineMin));
  const spineMax  = Math.max(spineMin, Math.trunc(sz.spineMax));
  const branchMin = Math.max(0, Math.trunc(sz.branchMin));
  const branchMax = Math.max(branchMin, Math.trunc(sz.branchMax));

  const spineLen = rrandInt(spineMin, spineMax, rng);
  const { grid, positions } = placeOnGrid(spineLen, rng);
  const spineIds = Array.from({ length: spineLen }, (_, i) => i);

  const branchCount = rrandInt(branchMin, branchMax, rng);
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
  // Full field pass-through, same contract as scattered loot and the key: the
  // treasure was the ONE item that kept its pool `desc` unmapped (the vault's
  // goal object reached the narrator descriptionless) and had its pool/domain
  // value clobbered by a flat 250 (2026-08-09 audit).
  const mkTreasure = (t) => {
    const { desc, ...fields } = t;
    return { ...fields, id: 'treasure', type: 'treasure',
             description: desc ?? t.description, value: t.value ?? 250, taken: false };
  };
  const treasure = (primaryDomain && dt[primaryDomain])
    ? mkTreasure(dt[primaryDomain])
    : mkTreasure(rpick(genTreasures, rng));
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
    // Theme atmosphere is ONE sentence per theme, so every middle room in a
    // dungeon used to end with the same line. `content.dressingFor` hands back a
    // pool of small concrete details for this theme and room type; one is drawn
    // per room from the same seeded stream, so a crypt's chambers differ from
    // each other and the dungeon still regenerates identically from its seed.
    // This is where the moulded curtain and the cracked bell come from — and
    // because it lands in the room's description, the host's canon extractor
    // can persist it as something the world remembers.
    const dressPool = c.dressingFor ? c.dressingFor(blueprint?.dungeonTheme ?? null, type) : null;
    const dressing  = Array.isArray(dressPool) && dressPool.length ? rpick(dressPool, rng) : '';
    const themedDesc = [
      baseDesc,
      (atmosphere && type !== 'entrance' && type !== 'vault') ? atmosphere : '',
      dressing,
    ].filter(Boolean).join(' ');
    rooms[id] = {
      id, name: def.name, description: themedDesc,
      exits: adjacency[i].map(a => ({ dir: a.dir, roomId: `room-${a.target}`, locked: false })),
      loot: [],
    };
  }

  // 5. lock gate + key
  //
  // The gate must be a genuine CUT of the room graph, not one locked door.
  // Exits are derived for every grid-adjacent pair, so locking only the spine
  // edge left the vault reachable without the key in ~69% of seeds (measured
  // over 5000 seeds) — the dungeon's signature puzzle was decorative in two
  // dungeons out of three.
  //
  // Partition by the spine: everything from the gate onward (and any branch
  // hanging off it) is "beyond the gate"; lock every edge that crosses, both
  // ways. spineIds is [0..spineLen-1], so a room index IS its spine position.
  const gateSpineIdx = rrandInt(1, spineLen - 2, rng);
  const beyondGate = new Set();
  for (let i = gateSpineIdx + 1; i < spineLen; i++) beyondGate.add(i);
  for (const b of branchIds) if (branchParent[b] > gateSpineIdx) beyondGate.add(b);

  for (let i = 0; i < totalRooms; i++) {
    for (const exit of rooms[`room-${i}`].exits) {
      const target = Number(exit.roomId.slice('room-'.length));
      if (beyondGate.has(i) !== beyondGate.has(target)) {
        exit.locked = true;
        exit.keyId  = 'found-key';
      }
    }
  }

  let keyPlaced = false;
  for (const bIdx of branchIds) {
    if (spineIds.indexOf(branchParent[bIdx]) <= gateSpineIdx) {
      rooms[`room-${bIdx}`].loot.push({ ...keyItem, description: keyItem.desc ?? keyItem.description, taken: false });
      keyPlaced = true; break;
    }
  }
  if (!keyPlaced) {
    const keyRoomIdx = rpick(spineIds.slice(1, gateSpineIdx + 1), rng);
    rooms[`room-${keyRoomIdx}`].loot.push({ ...keyItem, description: keyItem.desc ?? keyItem.description, taken: false });
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

  // 7. scatter loot in keyless branch rooms.
  // The WHOLE item passes through — the pool's mechanical fields (heals,
  // gold, value, lore, consumable) used to be stripped here, so the host's
  // use-item machinery could never fire on generated loot: the healing
  // potion in the pool healed nothing by the time it reached a room.
  const lootPool = c.loot ?? [];
  for (const bIdx of branchIds) {
    const room = rooms[`room-${bIdx}`];
    if (room.loot.length === 0 && lootPool.length) {
      const { desc, ...fields } = rpick(lootPool, rng);
      room.loot.push({ ...fields, id: `loot-${bIdx}`, description: desc ?? fields.description, taken: false });
    }
  }

  return { currentRoom: 'room-0', exitRoomId: `room-${spineLen - 1}`, rooms, npcs };
}
