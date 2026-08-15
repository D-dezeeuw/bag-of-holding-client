// src/worldgen/cartridge.js — pre-generated worlds (doc 18 §11, phase D).
//
// A cartridge is a baked genesis frozen in the versioned save envelope. It
// freezes *model output*, not just the seed — LLM sampling isn't reproducible,
// so the artifact, not the seed, is the world's identity: two players mounting
// the same cartridge get byte-identical lore. A session is a patch ledger over
// this immutable base; nothing here is ever written after the bake.
//
// The cartridge bakes the tree + lore + slices, and (since v2) four content
// collections — factions, npcs, warState, routes — that the worldgen depth
// phases fill; nothing speculative beyond those, no coordinates, no extra
// flags. Mounting an old cartridge in a newer client runs the envelope
// migration chain; the migrated shape lives in the session, the artifact
// stays untouched.
//
// A cartridge also records its SETTING. A host that re-skins the genre passes
// its archetype tables, naming banks and stub hooks here, and the bake honours
// them everywhere the world's vocabulary is decided — otherwise every
// pre-generated world is high fantasy no matter what the host is, and a
// catalog cannot say which is which. Only the id is stored: the tables
// themselves belong to the host that owns the setting, and a cartridge that
// carried them would be claiming to be their source of truth.

import { mintWorldSkeleton } from './skeleton.js';
import { mintLore } from './lore.js';
import { deriveBlueprint } from './blueprint.js';
import { hydrateNode } from './hydrate.js';
import { wrapEnvelope, loadEnvelope, digest } from '../persistence/envelope.js';

export const CARTRIDGE_VERSION = 2;

// Migrations from older cartridge formats. Each step MATERIALIZES the fields
// its target version adds — an identity migration (`d => d`) would pass
// loadEnvelope and then hand v2 readers `undefined` where they expect `[]`,
// which is strictly worse than refusing. The four v2 collections land empty
// here and get content from the depth phases (factions as tree entities, NPCs
// with voice/wants, war state, red-thread routes); doing the format change
// once, ahead of them, is what lets all five phases ship without ever touching
// this file again. Key order matters: the digest is computed over
// JSON.stringify(data), so the migration appends the new keys in exactly the
// order bakeCartridge emits them.
export const CARTRIDGE_MIGRATIONS = Object.freeze({
  1: (d) => ({ ...d, factions: [], npcs: [], warState: null, routes: [] }),
});

// Bake a world: skeleton + lore + the derived blueprint slices for every
// continent and province, with every continent/province minting its region
// frontier along the way (via hydrateNode's normal fallback, regardless of
// whether a model is available). Pass `complete` (the host LLM) to also
// hydrate real prose into continent/province outlines — the "detail ≤ 1"
// cartridge that makes cold landings instant — instead of each one staying
// at its deterministic hook text.
export async function bakeCartridge(seed, { complete = null, eraCount = null, setting = null } = {}) {
  const { id: settingId = null, tables = null, syllables = null, hooks = null } = setting ?? {};
  const sk = mintWorldSkeleton(seed, { syllables, hooks });
  let geo = sk.geo;

  // The world blueprint rolls BEFORE the lore so its faction archetypes feed
  // the faction stubs — a host's setting tables re-skin the powers the same
  // way they re-skin everything else. Order is safe: both are pure and draw
  // from independent seeded streams.
  const world = deriveBlueprint(null, seed, 'world', { tables });
  const lore = mintLore(sk, seed, { eraCount, factionSlots: world.factionSlots });
  const slices = { [`world`]: world };
  for (const cId of sk.continents) {
    const cNode = geo.nodes[cId];
    slices[cId] = deriveBlueprint(world, cNode.seed, 'continent', { tables, culture: cNode.nameParts ?? null });
    for (const pId of sk.provinces.filter(p => geo.nodes[p].parent === cId)) {
      slices[pId] = deriveBlueprint(slices[cId], geo.nodes[pId].seed, 'province', { tables, climate: geo.nodes[pId].climate });
    }
  }

  const outlines = {};
  // Always run this loop, `complete` or not: hydrateNode(..., { complete: null
  // }) already degrades to each template's procedural fallback on its own —
  // that is the whole point of the fallback design — and province minting
  // (template.mints === 'regions') has to happen either way, or a keyless
  // bake leaves every province with no region to land a cold arrival in.
  // Only whether `outlines` gets real prose depends on having a completer.
  for (const id of [...sk.continents, ...sk.provinces]) {
    const out = await hydrateNode(geo, id, {
      complete, detail: 1,
      slice: slices[id], slices,
      eras: lore.eras, legends: lore.legends,
    });
    if (!out.ok) continue;
    // Keep the geo regardless of provisional status — the region stubs a
    // province mints must never be dropped just because its outline prompt
    // came back empty and fell back. Only real model prose earns a slot in
    // `outlines`: a cartridge's outline layer is specifically the frozen LLM
    // layer, and callers already treat a missing outline as "not yet
    // hydrated" via the detail ladder.
    geo = out.geo;
    if (!out.provisional) outlines[id] = out.result;
  }

  const { factions = [], warState = null, npcs = [], ...loreCore } = lore;
  const data = {
    seed,
    settingId,
    geo,
    continents: sk.continents,
    provinces: sk.provinces,
    lore: loreCore,
    slices,
    outlines,
    // v2 collections. Factions, the war state and the powers' faces are
    // minted at genesis (the powers precede the player, and they have names);
    // routes stay empty until their phase. Key order is part of the format —
    // same keys, same order as MIGRATIONS[1] materializes for v1 artifacts.
    factions,
    npcs,
    warState,
    routes: [],
  };
  const body = wrapEnvelope(data, CARTRIDGE_VERSION);
  return { ...body, c: digest(JSON.stringify(data)) };
}

// The catalog row for one baked cartridge — what world://catalog serves.
export function catalogEntry(cartridge, { id = null } = {}) {
  const d = cartridge.data;
  const startContinent = d.geo.nodes[d.continents[0]];
  return {
    id: id ?? `world-${d.seed}`,
    seed: d.seed,
    digest: cartridge.c,
    v: cartridge.v,
    name: startContinent?.name ?? `world-${d.seed}`,
    // Which setting this world was baked under. A catalog of eight worlds is
    // unreadable without it: 'Kau Lung, heroic, water riot' and 'Veldrath,
    // heroic, undead plague' are the same row to a host that cannot tell they
    // are different genres. null means the library's own default tables.
    setting: d.settingId ?? null,
    tone: d.slices.world?.tone ?? null,
    threat: d.slices.world?.threatType ?? null,
    continents: d.continents.length,
    provinces: d.provinces.length,
    legends: d.lore.legends.length,
    outlined: Object.keys(d.outlines ?? {}).length,
  };
}

// Mount a cartridge: parse, verify, migrate (session-local — the artifact is
// never rewritten), and hand back the base a session's ledger folds over.
// Returns null on refusal; `onError` says why.
export function mountCartridge(raw, { onError = null } = {}) {
  const data = loadEnvelope(raw, {
    migrations: CARTRIDGE_MIGRATIONS,
    currentVersion: CARTRIDGE_VERSION,
    onError,
  });
  if (data == null) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    ...data,
    digest: parsed?.c ?? null,
    v: parsed?.v ?? CARTRIDGE_VERSION,
    // A fresh session over this base: same base, empty patch log.
    beginSession: () => ({ base: data, ledger: [] }),
  };
}
