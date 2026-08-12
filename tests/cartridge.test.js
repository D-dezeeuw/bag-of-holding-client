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

  // Regression: the keyless case — no completer AT ALL, not just one that
  // resolves empty. bakeCartridge used to skip its whole hydrate/mint loop
  // whenever `complete` was falsy, so a host with no model configured (the
  // common case: BYOK, no key yet) baked a world where every province had
  // no region frontier — hydrateNode handles `complete: null` fine on its
  // own; the bug was bakeCartridge never calling it in the first place.
  it('mints every province’s regions with no completer at all', async () => {
    const cart = await bakeCartridge(7); // complete defaults to null
    const d = cart.data;
    assert.deepEqual(Object.keys(d.outlines), []);
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

// ─── Settings (the host's genre, baked in) ───────────────────────────────────
//
// A cartridge with no setting is high fantasy, which is fine until a host has
// eight genres and a catalog that cannot tell them apart. The bake has to
// honour the host's tables, banks and hooks everywhere the world's vocabulary
// is decided, and record WHICH setting it was — the tables themselves stay
// with the host that owns them.

describe('a cartridge remembers the setting it was baked under', () => {
  const SETTING = {
    id: 'neon-stacks',
    tables: {
      dungeonThemes: ['server-crypt', 'flooded sublevel'],
      themeClimates: { 'server-crypt': ['highland', 'arid', 'frozen', 'volcanic'],
                       'flooded sublevel': ['coastal', 'mire', 'tropical', 'temperate'] },
    },
    syllables: {
      continentPrefixes: ['Sau', 'Rin', 'Hoa', 'Kem', 'Yun', 'Bau', 'Sei', 'Lor'],
      continentSuffixes: ['kara', 'veyn', 'marr', 'tsun', 'daat', 'reth', 'sai', 'luun'],
      provincePrefixes:  ['Low', 'Ash', 'Wire', 'Rain', 'Iron', 'Deck', 'Sump', 'Mast', 'Vent', 'Coil'],
      provinceSuffixes:  ['stack', 'deck', 'shaft', 'tier', 'row', 'lift', 'pier', 'hold', 'rung', 'span'],
    },
    hooks: ['the lifts run there and the call buttons are painted over'],
  };

  it('names every layer from the host’s banks, not the library’s', async () => {
    const cart = await bakeCartridge(4242, { setting: SETTING });
    for (const node of Object.values(cart.data.geo.nodes)) {
      if (node.kind === 'continent') {
        assert.ok(SETTING.syllables.continentPrefixes.some(p => node.name.startsWith(p)), node.name);
      }
      if (node.kind !== 'continent') {
        assert.ok(SETTING.syllables.provincePrefixes.some(p => node.name.startsWith(p)),
          `${node.kind} '${node.name}' kept a library name`);
      }
      if (node.kind !== 'region') assert.equal(node.hook, SETTING.hooks[0]);
    }
  });

  it('rolls the blueprint inside the host’s tables', async () => {
    const cart = await bakeCartridge(4242, { setting: SETTING });
    for (const [id, slice] of Object.entries(cart.data.slices)) {
      for (const theme of slice.dungeonThemePalette ?? []) {
        assert.ok(SETTING.tables.dungeonThemes.includes(theme), `${id} rolled '${theme}'`);
      }
    }
  });

  it('records the setting id, and the catalog says which world is which', async () => {
    const cart = await bakeCartridge(4242, { setting: SETTING });
    assert.equal(cart.data.settingId, 'neon-stacks');
    assert.equal(catalogEntry(cart).setting, 'neon-stacks');
    // Only the id: a cartridge that carried the tables would be claiming to be
    // their source of truth, and they belong to the host.
    assert.equal(cart.data.tables, undefined);
    assert.equal(cart.data.syllables, undefined);
  });

  it('bakes exactly as before when no setting is given', async () => {
    const plain = await bakeCartridge(99);
    const nulled = await bakeCartridge(99, { setting: null });
    assert.deepEqual(nulled.data.geo, plain.data.geo);
    assert.deepEqual(nulled.data.slices, plain.data.slices);
    assert.equal(catalogEntry(plain).setting, null);
  });
});
