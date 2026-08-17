// src/worldgen/skeleton.js — the world's shape above the region (doc 17).
//
// The flat world had no structure between "the world" and "a region", so
// nothing above the region could vary, foreshadow, or be travelled toward —
// every campaign was one frontier walked outward from one town. The skeleton
// mints the missing layers at genesis, deterministically from the world seed:
// 2–4 continents, each with 2–4 provinces, each province seeded to grow its
// own region frontier. No LLM call — the skeleton is stubs all the way down
// (detail 0: a name, a hook, a seed). Outlines (detail 1) and full content
// (detail 2) hydrate lazily as the player approaches; see promoteNode.
//
// Port provinces are the sea's anchors: each continent marks 1–2, and sea
// edges connect them so a campaign can cross the water in act 4 and land
// somewhere that was always going to be there.

import { mulberry32, randInt, pick, shuffle } from './rng.js';
import { emptyGeography, addNode, connect, DIRECTIONS } from './geography.js';

const patchNode = (geo, id, fields) =>
  ({ ...geo, nodes: { ...geo.nodes, [id]: { ...geo.nodes[id], ...fields } } });

// Name tables — deterministic flavour, replaced by the real name when a layer
// is outlined. Kept small on purpose: these are addresses, not prose.
const CONTINENT_A = ['Vel', 'Kar', 'Oss', 'Thal', 'Mor', 'Ael', 'Dur', 'Ish', 'Bren', 'Sol'];
const CONTINENT_B = ['drath', 'moor', 'heim', 'anta', 'ossa', 'gard', 'wyn', 'kara', 'dane', 'mir'];
const PROVINCE_A  = ['Salt', 'Ash', 'Iron', 'Grey', 'Thorn', 'Ember', 'Mire', 'Bone', 'Storm', 'Elder', 'Fal', 'Hollow'];
const PROVINCE_B  = ['march', 'fell', 'mark', 'reach', 'vale', 'wald', 'coast', 'gate', 'moor', 'rise', 'shore', 'deep'];
// One line of rumour per unvisited layer, and the ONLY prose the skeleton
// invents. It reaches a player twice — the rumoured section of the map screen,
// and the fallback when a sea crossing sights a province with no outline yet —
// so a host whose world has no sailors and no caravans needs to replace it.
// (A host that renames the layers and leaves these behind gets an underground
// shelter whose neighbouring level "sailors will not name after dark".)
export const STUB_HOOKS = Object.freeze([
  'maps disagree about its borders', 'its rivers run the wrong way',
  'no two travellers describe it alike', 'the birds cross it without landing',
  'its roads are older than its towns', 'sailors will not name it after dark',
  'caravans pay double to go around it', 'the stars sit differently above it',
]);
// Climate bands are OWNED by the province layer (doc 17's variation table):
// regions inside a province inherit its band instead of rerolling at random.
export const CLIMATE_BANDS = ['temperate', 'arid', 'frozen', 'tropical', 'volcanic', 'coastal', 'highland', 'mire'];

// A host can supply its own banks — a setting is largely its proper nouns, and
// "Veldrath" belongs to a different world than "Kau Lung". Partial sets fill in
// from the defaults so a host can re-skin continents without restating
// provinces.
function banks(syllables) {
  return {
    cA: syllables?.continentPrefixes ?? CONTINENT_A,
    cB: syllables?.continentSuffixes ?? CONTINENT_B,
    pA: syllables?.provincePrefixes  ?? PROVINCE_A,
    pB: syllables?.provinceSuffixes  ?? PROVINCE_B,
  };
}

// Exported so scoped blueprints can mint a matching naming culture without
// duplicating the syllable banks.
export const SYLLABLES = Object.freeze({
  continentPrefixes: CONTINENT_A, continentSuffixes: CONTINENT_B,
  provincePrefixes: PROVINCE_A, provinceSuffixes: PROVINCE_B,
});

// Mint the layered skeleton: continents and provinces as stubs, sea edges
// between port provinces. Pure and deterministic — the same seed always
// shapes the same world. Returns { geo, continents, provinces } where the
// lists are ids in minting order (the first province of the first continent
// is the conventional starting province).
export function mintWorldSkeleton(seed, { continents = null, provincesPer = null,
                                          syllables = null, hooks = null } = {}) {
  const rng = mulberry32((seed ?? 1) >>> 0);
  const { cA, cB, pA, pB } = banks(syllables);
  const hookPool = (Array.isArray(hooks) && hooks.length) ? hooks : STUB_HOOKS;
  let geo = emptyGeography();
  const continentIds = [];
  const provinceIds = [];

  // Name dedup, stream-preserving: the primary draws below are byte-for-byte
  // what they always were (so collision-free worlds bake identically); only
  // when a draw REPEATS an earlier name does `unique` walk the ordered combo
  // grid for the first unused pair — no extra rng draws — and fall back to a
  // numeral once a pool is exhausted. Before this, 47% of default worlds
  // shipped a duplicate province name.
  const takenNames = new Set();
  const unique = (name, as, bs) => {
    if (!takenNames.has(name)) { takenNames.add(name); return name; }
    for (const a of as) {
      for (const b of bs) {
        const alt = `${a}${b}`;
        if (!takenNames.has(alt)) { takenNames.add(alt); return alt; }
      }
    }
    for (let i = 2; ; i++) {
      const alt = `${name} ${'I'.repeat(i)}`;
      if (!takenNames.has(alt)) { takenNames.add(alt); return alt; }
    }
  };

  const nContinents = continents ?? randInt(2, 4, rng);
  for (let c = 0; c < nContinents; c++) {
    const cSeed = randInt(1, 2 ** 30, rng);
    const cRng  = mulberry32(cSeed);
    const cId   = `continent-${c}`;
    geo = addNode(geo, {
      id: cId, name: unique(`${pick(cA, cRng)}${pick(cB, cRng)}`, cA, cB), kind: 'continent',
      seed: cSeed, hook: pick(hookPool, cRng), stub: true, detail: 0, parent: null,
    });
    continentIds.push(cId);

    const nProvinces = provincesPer ?? randInt(2, 4, cRng);
    // Naming culture: each continent commits to a syllable subset, so names
    // on one landmass rhyme with each other and not with the neighbour's.
    // Recorded on the continent node for hints and later landfall minting.
    const prefixes = shuffle(pA, cRng).slice(0, 5);
    const suffixes = shuffle(pB, cRng).slice(0, 5);
    geo = patchNode(geo, cId, { nameParts: { prefixes, suffixes } });
    // Climate spread: deal bands without replacement so a 4-province
    // continent gets 4 different bands instead of `temperate` three times.
    const bandDeck = shuffle(CLIMATE_BANDS, cRng);
    let prevProvince = null;
    for (let p = 0; p < nProvinces; p++) {
      const pSeed = randInt(1, 2 ** 30, cRng);
      const pRng  = mulberry32(pSeed);
      const pId   = `${cId}.province-${p}`;
      geo = addNode(geo, {
        id: pId, name: unique(`${pick(prefixes, pRng)}${pick(suffixes, pRng)}`, prefixes, suffixes), kind: 'province',
        seed: pSeed, hook: pick(hookPool, pRng), stub: true, detail: 0, parent: cId,
      });
      // The province owns its climate band — recorded on the node so regions
      // and dungeons inside it inherit instead of rerolling.
      geo = patchNode(geo, pId, { climate: bandDeck[p % bandDeck.length] });
      provinceIds.push(pId);
      // Provinces of a continent form a land chain (a simple, walkable shape;
      // richer internal topology can come later without breaking ids).
      if (prevProvince) {
        geo = connect(geo, prevProvince, pId, {
          direction: DIRECTIONS[p % DIRECTIONS.length], days: randInt(2, 4, cRng), kind: 'border',
        });
      }
      prevProvince = pId;
    }
  }

  // Ports and sea lanes: the first (and on big continents the last) province
  // of each continent is a port, and EVERY flagged port joins the lane
  // graph — the sea is a ring, not a chain, so any two continents route in
  // both directions and no harbor is decoration. (The old pass flagged the
  // far port but never laned it: every big continent shipped an orphan
  // harbor.) Consecutive ports of the SAME continent get a short coastal
  // run; cross-continent lanes stay the 4-8 day crossings.
  const ports = [];
  for (const cId of continentIds) {
    const mine = provinceIds.filter(p => geo.nodes[p].parent === cId);
    if (!mine.length) continue;
    geo = patchNode(geo, mine[0], { port: true });
    ports.push(mine[0]);
    if (mine.length > 2) {
      const far = mine[mine.length - 1];
      geo = patchNode(geo, far, { port: true });
      ports.push(far);
    }
  }
  const lane = (a, b) => {
    const coastal = geo.nodes[a].parent === geo.nodes[b].parent;
    geo = connect(geo, a, b, {
      direction: 'east',
      days: coastal ? randInt(2, 4, rng) : randInt(4, 8, rng),
      kind: 'sea',
    });
  };
  for (let i = 1; i < ports.length; i++) lane(ports[i - 1], ports[i]);
  if (ports.length > 2) lane(ports[ports.length - 1], ports[0]);

  return { geo, continents: continentIds, provinces: provinceIds };
}

// Adopt a flat (pre-layer) world: every parentless region node is filed under
// a synthetic continent/province minted from the same seed, so an in-flight
// campaign acquires an address without regenerating anything. Idempotent —
// a geography that already has a continent is returned unchanged.
export function adoptFlatWorld(geo, seed) {
  const nodes = Object.values(geo?.nodes ?? {});
  if (!nodes.length) return geo;
  if (nodes.some(n => n.kind === 'continent')) return geo;

  const rng = mulberry32((seed ?? 1) >>> 0);
  const cId = 'continent-known';
  const pId = `${cId}.province-known`;
  let out = addNode(geo, {
    id: cId, name: 'the Known Lands', kind: 'continent',
    seed: randInt(1, 2 ** 30, rng), hook: 'every map begins here', stub: true, detail: 1, parent: null,
  });
  out = addNode(out, {
    id: pId, name: 'the Heartland', kind: 'province',
    seed: randInt(1, 2 ** 30, rng), hook: 'the roads all know each other', stub: true, detail: 1, parent: cId,
  });
  out = patchNode(out, pId, { climate: pick(CLIMATE_BANDS, rng), port: true });
  const adopted = { ...out.nodes };
  for (const n of nodes) {
    if (n.kind === 'region' && (n.parent == null)) adopted[n.id] = { ...adopted[n.id], parent: pId };
  }
  return { ...out, nodes: adopted };
}
