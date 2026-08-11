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
const HOOKS = [
  'maps disagree about its borders', 'its rivers run the wrong way',
  'no two travellers describe it alike', 'the birds cross it without landing',
  'its roads are older than its towns', 'sailors will not name it after dark',
  'caravans pay double to go around it', 'the stars sit differently above it',
];
// Climate bands are OWNED by the province layer (doc 17's variation table):
// regions inside a province inherit its band instead of rerolling at random.
export const CLIMATE_BANDS = ['temperate', 'arid', 'frozen', 'tropical', 'volcanic', 'coastal', 'highland', 'mire'];

const continentName = (rng) => `${pick(CONTINENT_A, rng)}${pick(CONTINENT_B, rng)}`;

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
export function mintWorldSkeleton(seed, { continents = null, provincesPer = null } = {}) {
  const rng = mulberry32((seed ?? 1) >>> 0);
  let geo = emptyGeography();
  const continentIds = [];
  const provinceIds = [];

  const nContinents = continents ?? randInt(2, 4, rng);
  for (let c = 0; c < nContinents; c++) {
    const cSeed = randInt(1, 2 ** 30, rng);
    const cRng  = mulberry32(cSeed);
    const cId   = `continent-${c}`;
    geo = addNode(geo, {
      id: cId, name: continentName(cRng), kind: 'continent',
      seed: cSeed, hook: pick(HOOKS, cRng), stub: true, detail: 0, parent: null,
    });
    continentIds.push(cId);

    const nProvinces = provincesPer ?? randInt(2, 4, cRng);
    // Naming culture: each continent commits to a syllable subset, so names
    // on one landmass rhyme with each other and not with the neighbour's.
    // Recorded on the continent node for hints and later landfall minting.
    const prefixes = shuffle(PROVINCE_A, cRng).slice(0, 5);
    const suffixes = shuffle(PROVINCE_B, cRng).slice(0, 5);
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
        id: pId, name: `${pick(prefixes, pRng)}${pick(suffixes, pRng)}`, kind: 'province',
        seed: pSeed, hook: pick(HOOKS, pRng), stub: true, detail: 0, parent: cId,
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
  // of each continent is a port; consecutive continents' ports are connected.
  const ports = [];
  for (const cId of continentIds) {
    const mine = provinceIds.filter(p => geo.nodes[p].parent === cId);
    if (!mine.length) continue;
    geo = patchNode(geo, mine[0], { port: true });
    ports.push(mine[0]);
    if (mine.length > 2) geo = patchNode(geo, mine[mine.length - 1], { port: true });
  }
  for (let i = 1; i < ports.length; i++) {
    geo = connect(geo, ports[i - 1], ports[i], { direction: 'east', days: randInt(4, 8, rng), kind: 'sea' });
  }

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
