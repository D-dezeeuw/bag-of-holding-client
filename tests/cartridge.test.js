// tests/cartridge.test.js — pre-generated worlds (doc 18 §11, phase D).
//
// The artifact, not the seed, is the world's identity: a bake must be
// byte-stable, a mount must round-trip, and a future-version cartridge must
// be refused at the door rather than half-read.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bakeCartridge, mountCartridge, catalogEntry, CARTRIDGE_VERSION } from '../src/worldgen/cartridge.js';
import { childrenOf } from '../src/worldgen/geography.js';

describe('bakeCartridge', () => {
  it('is byte-deterministic without a completer', async () => {
    const a = await bakeCartridge(1234);
    const b = await bakeCartridge(1234);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.v, CARTRIDGE_VERSION);
    assert.equal(typeof a.c, 'string');
  });

  it('carries the tree, the lore, and a slice for every layer node', async () => {
    const cart = await bakeCartridge(7);
    const d = cart.data;
    assert.ok(d.continents.length >= 2);
    assert.ok(d.lore.eras.length >= 3);
    assert.ok(d.lore.legends.length >= d.continents.length * 2);
    assert.ok(d.lore.crowns.length === d.provinces.length);
    for (const id of [...d.continents, ...d.provinces]) {
      assert.ok(d.slices[id], `no slice for ${id}`);
    }
    // province slices agree with the skeleton's dealt bands
    for (const pId of d.provinces) {
      assert.equal(d.slices[pId].climate, d.geo.nodes[pId].climate, pId);
    }
  });

  it('bakes outlines to detail 1 when a completer is provided', async () => {
    const complete = async ({ schema }) => {
      const props = Object.keys(schema.properties);
      const stub = {};
      for (const p of props) {
        if (p === 'factionHomelands' || p === 'conflicts' || p === 'landmarks') stub[p] = [];
        else if (p === 'dominantFactionId') stub[p] = null;
        else if (p === 'factionStance') stub[p] = 'absent';
        else stub[p] = 'x';
      }
      return stub;
    };
    const cart = await bakeCartridge(7, { complete });
    const d = cart.data;
    assert.ok(Object.keys(d.outlines).length > 0);
    for (const id of Object.keys(d.outlines)) {
      assert.ok((d.geo.nodes[id].detail ?? 0) >= 1, `${id} not promoted`);
      assert.equal(d.geo.nodes[id].stub, true, `${id} must stay a stub at detail 1`);
    }
  });

  // Regression: a province whose outline prompt comes back empty still falls
  // back and commits — including the region stubs its template mints. Losing
  // those silently (by discarding the whole hydration because it was
  // provisional) used to strand a province with no regions to land in.
  it('mints a province’s regions even when its outline hydration is provisional', async () => {
    const complete = async () => null; // every layer falls back
    const cart = await bakeCartridge(7, { complete });
    const d = cart.data;
    assert.deepEqual(Object.keys(d.outlines), []); // nothing was real prose
    for (const pId of d.provinces) {
      const regions = childrenOf(d.geo, pId).filter(n => n.kind === 'region');
      assert.ok(regions.length >= 1, `${pId} has no minted regions`);
    }
  });
});

describe('mountCartridge', () => {
  it('round-trips through JSON and begins a fresh session over the base', async () => {
    const cart = await bakeCartridge(42);
    const mounted = mountCartridge(JSON.stringify(cart));
    assert.equal(mounted.seed, 42);
    assert.equal(mounted.digest, cart.c);
    assert.deepEqual(Object.keys(mounted.geo.nodes).sort(), Object.keys(cart.data.geo.nodes).sort());
    const session = mounted.beginSession();
    assert.deepEqual(session.ledger, []);
    assert.equal(session.base.seed, 42);
  });

  it('refuses a future-version cartridge with a reason', async () => {
    const cart = await bakeCartridge(42);
    const errors = [];
    const mounted = mountCartridge(
      JSON.stringify({ ...cart, v: CARTRIDGE_VERSION + 1 }),
      { onError: (code) => errors.push(code) });
    assert.equal(mounted, null);
    assert.deepEqual(errors, ['future-version']);
  });
});

describe('catalogEntry', () => {
  it('summarizes a cartridge for the catalog', async () => {
    const cart = await bakeCartridge(9);
    const e = catalogEntry(cart);
    assert.equal(e.id, 'world-9');
    assert.equal(e.digest, cart.c);
    assert.equal(e.continents, cart.data.continents.length);
    assert.equal(e.provinces, cart.data.provinces.length);
    assert.ok(e.tone);
    assert.ok(e.threat);
  });
});
