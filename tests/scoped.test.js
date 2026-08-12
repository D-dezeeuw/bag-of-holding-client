// tests/scoped.test.js — scoped blueprints (doc 18 §3, phase A).
//
// The world singleton rolled one climate and one dungeon theme for the whole
// world; deriveBlueprint gives each tree tier its own slice, constrained by
// its ancestors. These tests pin the ownership table: what each scope draws,
// what it inherits, and that the climate→theme compatibility actually binds.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBlueprint, deriveBlueprint, regionHints, settlementHints,
  THEME_CLIMATES, BAND_SETTLEMENTS, DEFAULT_TABLES, mergeTables,
} from '../src/worldgen/blueprint.js';
import { mintWorldSkeleton, CLIMATE_BANDS } from '../src/worldgen/skeleton.js';

const chain = (seed) => {
  const world = deriveBlueprint(null, seed, 'world');
  const cont = deriveBlueprint(world, seed + 1, 'continent');
  const prov = deriveBlueprint(cont, seed + 2, 'province');
  const reg = deriveBlueprint(prov, seed + 3, 'region');
  return { world, cont, prov, reg };
};

describe('deriveBlueprint', () => {
  it('is deterministic per scope and seed', () => {
    for (const scope of ['world', 'continent', 'province', 'region']) {
      const parent = scope === 'world' ? null : deriveBlueprint(null, 1, 'world');
      assert.deepEqual(
        deriveBlueprint(parent, 42, scope),
        deriveBlueprint(parent, 42, scope), scope);
    }
  });

  it('world scope is a superset of the legacy singleton', () => {
    const legacy = buildBlueprint(1234);
    const world = deriveBlueprint(null, 1234, 'world');
    for (const k of Object.keys(legacy)) assert.deepEqual(world[k], legacy[k], k);
    assert.equal(world.scope, 'world');
  });

  it('continent inherits tone/threat and draws its own expression', () => {
    const { world, cont } = chain(7);
    assert.equal(cont.tone, world.tone);
    assert.equal(cont.threatType, world.threatType);
    assert.ok(typeof cont.threatExpression === 'string' && cont.threatExpression.length > 10);
  });

  it('province palette only contains themes its band permits', () => {
    for (let seed = 0; seed < 40; seed++) {
      const { prov } = chain(seed);
      assert.ok(prov.dungeonThemePalette.length >= 1);
      for (const t of prov.dungeonThemePalette) {
        assert.ok(THEME_CLIMATES[t].includes(prov.climate),
          `${t} not permitted in ${prov.climate}`);
      }
      assert.deepEqual(prov.settlementPalette, BAND_SETTLEMENTS[prov.climate]);
    }
  });

  it('province accepts the geography-dealt climate band', () => {
    const cont = deriveBlueprint(deriveBlueprint(null, 1, 'world'), 2, 'continent');
    const prov = deriveBlueprint(cont, 3, 'province', { climate: 'frozen' });
    assert.equal(prov.climate, 'frozen');
    for (const t of prov.dungeonThemePalette) assert.ok(THEME_CLIMATES[t].includes('frozen'));
  });

  it('worship skew draws from the parent pantheon', () => {
    const { world, prov } = chain(11);
    const domains = world.godDomains.map(g => g.domain);
    assert.ok(prov.worshipSkew.length >= 1 && prov.worshipSkew.length <= 2);
    for (const d of prov.worshipSkew) assert.ok(domains.includes(d));
  });

  it('region inherits the province climate and picks from its palettes', () => {
    for (let seed = 0; seed < 40; seed++) {
      const { prov, reg } = chain(seed);
      assert.equal(reg.climate, prov.climate);
      assert.ok(prov.dungeonThemePalette.includes(reg.dungeonTheme));
      assert.ok(prov.settlementPalette.includes(reg.settlementType));
    }
  });

  it('rejects unknown scopes', () => {
    assert.throws(() => deriveBlueprint(null, 1, 'galaxy'), /unknown scope/);
  });
});

describe('THEME_CLIMATES', () => {
  it('covers every dungeon theme with valid, non-empty band lists', () => {
    assert.deepEqual(
      Object.keys(THEME_CLIMATES).sort(),
      [...DEFAULT_TABLES.dungeonThemes].sort());
    for (const bands of Object.values(THEME_CLIMATES)) {
      assert.ok(bands.length >= 1);
      for (const b of bands) assert.ok(CLIMATE_BANDS.includes(b), b);
    }
  });

  it('every band offers at least two themes (palettes never starve)', () => {
    for (const band of CLIMATE_BANDS) {
      const n = Object.values(THEME_CLIMATES).filter(bs => bs.includes(band)).length;
      assert.ok(n >= 2, `${band} has only ${n} theme(s)`);
    }
  });
});

describe('skeleton climate spread + naming culture', () => {
  it('deals distinct bands across a continent', () => {
    const { geo, continents, provinces } = mintWorldSkeleton(1234, { continents: 2, provincesPer: 4 });
    for (const cId of continents) {
      const bands = provinces.filter(p => geo.nodes[p].parent === cId).map(p => geo.nodes[p].climate);
      assert.equal(new Set(bands).size, bands.length, `duplicate bands on ${cId}: ${bands}`);
    }
  });

  it('provinces draw names from their continent’s committed syllables', () => {
    const { geo, continents, provinces } = mintWorldSkeleton(99, { continents: 2, provincesPer: 3 });
    for (const cId of continents) {
      const { prefixes } = geo.nodes[cId].nameParts;
      for (const p of provinces.filter(p => geo.nodes[p].parent === cId)) {
        assert.ok(prefixes.some(pre => geo.nodes[p].name.startsWith(pre)),
          `${geo.nodes[p].name} not from ${prefixes}`);
      }
    }
  });
});

describe('scoped hint formatters', () => {
  it('prefer the slice, fall back to the singleton', () => {
    const bp = buildBlueprint(1234);
    const { reg } = chain(500);
    const scoped = regionHints(bp, reg);
    assert.match(scoped, new RegExp(`climate is: ${reg.climate}`));
    assert.match(scoped, new RegExp(`themed as: ${reg.dungeonTheme}`));
    // no slice → unchanged legacy behaviour
    assert.match(regionHints(bp), new RegExp(`climate is: ${bp.climate}`));
    const s = settlementHints(bp, reg);
    assert.match(s, new RegExp(`settlement is a: ${reg.settlementType}`));
    assert.match(s, /affiliated with one of these factions/); // factions still world-owned
  });
});

// ─── Host-supplied palettes (doc 19: setting packs) ──────────────────────────
//
// A setting is largely its proper nouns and its furniture. A host re-skinning
// the genre replaces the tables wholesale — every "theme" in a vertical city is
// a floor, a sublevel or a shaft, and none of them appear in THEME_CLIMATES —
// so the two module constants that used to be read directly had to become
// defaults rather than laws. These pin that they still ARE the defaults.

describe('host-supplied naming banks', () => {
  const SYL = {
    continentPrefixes: ['Kau', 'Sān', 'Wai', 'Tsim'],
    continentSuffixes: ['lung', 'shui', 'wan', 'kok'],
    provincePrefixes:  ['Low', 'Ash', 'Wire', 'Rain', 'Iron'],
    provinceSuffixes:  ['stack', 'deck', 'shaft', 'tier', 'row'],
  };

  it('names every layer from the injected banks only', () => {
    const { geo, continents, provinces } = mintWorldSkeleton(4242, { continents: 3, provincesPer: 3, syllables: SYL });
    for (const cId of continents) {
      const name = geo.nodes[cId].name;
      assert.ok(SYL.continentPrefixes.some(a => name.startsWith(a)), `continent '${name}' is not from the bank`);
      assert.ok(SYL.continentSuffixes.some(b => name.endsWith(b)),   `continent '${name}' is not from the bank`);
    }
    for (const pId of provinces) {
      const name = geo.nodes[pId].name;
      assert.ok(SYL.provincePrefixes.some(a => name.startsWith(a)), `province '${name}' is not from the bank`);
      assert.ok(SYL.provinceSuffixes.some(b => name.endsWith(b)),   `province '${name}' is not from the bank`);
    }
  });

  it('fills a partial set in from the defaults', () => {
    const { geo, continents } = mintWorldSkeleton(7, { continents: 2, provincesPer: 2,
      syllables: { continentPrefixes: SYL.continentPrefixes } });
    for (const cId of continents) {
      assert.ok(SYL.continentPrefixes.some(a => geo.nodes[cId].name.startsWith(a)));
    }
  });

  it('leaves the default world byte-identical when no banks are passed', () => {
    assert.deepEqual(mintWorldSkeleton(1234, { continents: 2, provincesPer: 3, syllables: null }),
                     mintWorldSkeleton(1234, { continents: 2, provincesPer: 3 }));
  });
});

describe('host-supplied climate palettes', () => {
  const tables = {
    dungeonThemes: ['server-crypt', 'flooded sublevel', 'tong den'],
    themeClimates: { 'server-crypt': ['highland'], 'flooded sublevel': ['coastal', 'mire'], 'tong den': ['highland', 'coastal'] },
    bandSettlements: { highland: ['antenna tier'], coastal: ['ferry gate'], mire: ['sump row'] },
  };

  it('honours the host map instead of the built-in one', () => {
    const world = buildBlueprint(11, { tables });
    const prov = deriveBlueprint(world, 22, 'province', { tables, climate: 'highland' });
    assert.deepEqual(prov.settlementPalette, ['antenna tier']);
    for (const theme of prov.dungeonThemePalette) {
      assert.ok(tables.themeClimates[theme].includes('highland'), `${theme} does not belong in highland`);
    }
  });

  it('never starves a band the host left uncovered', () => {
    const sparse = { ...tables, themeClimates: { 'server-crypt': ['highland'] } };
    const world = buildBlueprint(11, { tables: sparse });
    const prov = deriveBlueprint(world, 22, 'province', { tables: sparse, climate: 'mire' });
    assert.ok(prov.dungeonThemePalette.length >= 1, 'an empty palette makes pick() return undefined downstream');
    const region = deriveBlueprint(prov, 33, 'region', { tables: sparse });
    assert.ok(sparse.dungeonThemes.includes(region.dungeonTheme));
  });

  it('leaves the default derivation untouched', () => {
    const world = buildBlueprint(4242);
    for (const scope of ['continent', 'province', 'region']) {
      assert.deepEqual(deriveBlueprint(world, 777, scope, { tables: DEFAULT_TABLES }),
                       deriveBlueprint(world, 777, scope));
    }
  });
});

describe('partial table overrides', () => {
  it('merge over the defaults instead of replacing them', () => {
    // The all-or-nothing contract was a footgun: replacing only the themes —
    // the normal shape of a genre re-skin — left `tones` undefined and the
    // factory threw inside pick().
    const bp = buildBlueprint(5, { tables: { dungeonThemes: ['server-crypt'] } });
    assert.equal(bp.dungeonTheme, 'server-crypt');
    assert.ok(DEFAULT_TABLES.tones.includes(bp.tone), 'untouched tables still come from the defaults');
  });

  it('mergeTables replaces arrays and merges objects, without mutating', () => {
    const snapshot = JSON.stringify(DEFAULT_TABLES.settlementTypes);
    const merged = mergeTables({ settlementTypes: { 'temperate forest': ['stack ward'] } });
    assert.deepEqual(merged.settlementTypes['temperate forest'], ['stack ward']);
    assert.ok(Object.keys(merged.settlementTypes).length > 1, 'other climates survive the merge');
    assert.equal(JSON.stringify(DEFAULT_TABLES.settlementTypes), snapshot, 'defaults are not mutated');
  });

  it('is identity for no override, so every existing caller is untouched', () => {
    assert.equal(mergeTables(null), DEFAULT_TABLES);
    assert.equal(mergeTables({}), DEFAULT_TABLES);
    assert.equal(mergeTables(DEFAULT_TABLES), DEFAULT_TABLES);
    assert.deepEqual(buildBlueprint(999, { tables: {} }), buildBlueprint(999));
  });
});
