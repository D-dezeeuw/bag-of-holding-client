// src/worldgen/cartridge.js — pre-generated worlds (doc 18 §11, phase D).
//
// A cartridge is a baked genesis frozen in the versioned save envelope. It
// freezes *model output*, not just the seed — LLM sampling isn't reproducible,
// so the artifact, not the seed, is the world's identity: two players mounting
// the same cartridge get byte-identical lore. A session is a patch ledger over
// this immutable base; nothing here is ever written after the bake.
//
// The cartridge deliberately bakes nothing beyond the tree + lore + slices —
// no coordinates, no extra flags — so the envelope survives every phase of
// doc 18 unchanged. Mounting an old cartridge in a newer client runs the
// envelope migration chain; the migrated shape lives in the session, the
// artifact stays untouched.

import { mintWorldSkeleton } from './skeleton.js';
import { mintLore } from './lore.js';
import { deriveBlueprint } from './blueprint.js';
import { hydrateNode } from './hydrate.js';
import { wrapEnvelope, loadEnvelope, digest } from '../persistence/envelope.js';

export const CARTRIDGE_VERSION = 1;

// Migrations from older cartridge formats. v1 is the first, so the chain is
// empty; every future format change adds a step here, never edits artifacts.
export const CARTRIDGE_MIGRATIONS = Object.freeze({});

// Bake a world: skeleton + lore + the derived blueprint slices for every
// continent and province. Pure and synchronous with no completer; pass
// `complete` (the host LLM) to also hydrate continent/province outlines into
// the bake — the "detail ≤ 1" cartridge that makes cold landings instant.
export async function bakeCartridge(seed, { complete = null, eraCount = null } = {}) {
  const sk = mintWorldSkeleton(seed);
  let geo = sk.geo;
  const lore = mintLore(sk, seed, { eraCount });

  const world = deriveBlueprint(null, seed, 'world');
  const slices = { [`world`]: world };
  for (const cId of sk.continents) {
    const cNode = geo.nodes[cId];
    slices[cId] = deriveBlueprint(world, cNode.seed, 'continent', { culture: cNode.nameParts ?? null });
    for (const pId of sk.provinces.filter(p => geo.nodes[p].parent === cId)) {
      slices[pId] = deriveBlueprint(slices[cId], geo.nodes[pId].seed, 'province', { climate: geo.nodes[pId].climate });
    }
  }

  const outlines = {};
  if (complete) {
    for (const id of [...sk.continents, ...sk.provinces]) {
      const out = await hydrateNode(geo, id, {
        complete, detail: 1,
        slice: slices[id], slices,
        eras: lore.eras, legends: lore.legends,
      });
      if (!out.ok) continue;
      // Keep the geo regardless of provisional status — a province's minted
      // region stubs (template.mints === 'regions') must never be dropped
      // just because its outline prompt came back empty and fell back. Only
      // real model prose earns a slot in `outlines`: a cartridge's outline
      // layer is specifically the baked LLM content, and callers already
      // treat a missing outline as "not yet hydrated" via the detail ladder.
      geo = out.geo;
      if (!out.provisional) outlines[id] = out.result;
    }
  }

  const data = {
    seed,
    geo,
    continents: sk.continents,
    provinces: sk.provinces,
    lore,
    slices,
    outlines,
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
