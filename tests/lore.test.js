// tests/lore.test.js — lore entities (doc 18 §4, phase B).
//
// Crowns, legends, and eras are minted as stubs at genesis, pure and seeded.
// The load-bearing rule is the explorer's dividend: every continent's first
// port province appears in at least one legend's sites, so a wanderer's
// landfall always has story to bind to.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mintWorldSkeleton } from '../src/worldgen/skeleton.js';
import {
  mintEras, mintLegendStubs, mintCrownStub, mintLore, LEGITIMACIES,
} from '../src/worldgen/lore.js';
import { CROWN_SCHEMA, LEGEND_SCHEMA } from '../src/worldgen/schemas.js';

describe('mintEras', () => {
  it('is deterministic and mints 3–5 ordered epochs', () => {
    assert.deepEqual(mintEras(7), mintEras(7));
    for (let seed = 0; seed < 20; seed++) {
      const eras = mintEras(seed);
      assert.ok(eras.length >= 3 && eras.length <= 5);
      assert.deepEqual(eras.map(e => e.order), eras.map((_, i) => i));
      assert.equal(new Set(eras.map(e => e.name)).size, eras.length);
    }
  });
});

describe('mintLore over a skeleton', () => {
  it('is deterministic', () => {
    const sk = mintWorldSkeleton(1234);
    assert.deepEqual(mintLore(sk, 1234), mintLore(sk, 1234));
  });

  it('every continent’s first port province carries a legend (explorer’s dividend)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const sk = mintWorldSkeleton(seed);
      const { legends } = mintLore(sk, seed);
      for (const cId of sk.continents) {
        const mine = sk.provinces.filter(p => sk.geo.nodes[p].parent === cId);
        const firstPort = mine.find(p => sk.geo.nodes[p].port);
        assert.ok(firstPort, `${cId} has no port`);
        const bound = legends.some(l => l.id.startsWith(cId) && l.sites.includes(firstPort));
        assert.ok(bound, `seed ${seed}: ${firstPort} unbound`);
      }
    }
  });

  it('legend sites bind only to real provinces of their own continent', () => {
    const sk = mintWorldSkeleton(42);
    const { legends } = mintLore(sk, 42);
    for (const l of legends) {
      const cId = l.id.split('.legend-')[0];
      assert.ok(l.sites.length >= 1);
      for (const s of l.sites) {
        assert.ok(sk.geo.nodes[s], `${s} not a node`);
        assert.equal(sk.geo.nodes[s].parent, cId, `${s} outside ${cId}`);
      }
    }
  });

  it('mints one crown per province, named in the continent’s culture', () => {
    const sk = mintWorldSkeleton(99);
    const { crowns } = mintLore(sk, 99);
    assert.equal(crowns.length, sk.provinces.length);
    for (const c of crowns) {
      const pId = c.id.replace(/\.crown$/, '');
      const cNode = sk.geo.nodes[sk.geo.nodes[pId].parent];
      assert.ok(LEGITIMACIES.includes(c.legitimacy));
      assert.ok(c.name.startsWith('House '));
      assert.ok(cNode.nameParts.prefixes.some(p => c.name.startsWith(`House ${p}`)),
        `${c.name} not in ${cNode.nameParts.prefixes}`);
    }
  });

  it('legends carry era tags from the minted epochs', () => {
    const sk = mintWorldSkeleton(5);
    const { eras, legends } = mintLore(sk, 5);
    const eraIds = new Set(eras.map(e => e.id));
    for (const l of legends) assert.ok(eraIds.has(l.era), `${l.id} era ${l.era}`);
  });
});

describe('lore hydration contracts', () => {
  it('stub shapes are a subset of their hydration schemas', () => {
    const crown = mintCrownStub('continent-0.province-0', 3, {});
    for (const k of Object.keys(crown)) {
      if (k === 'stub') continue;
      assert.ok(k in CROWN_SCHEMA.properties, `crown stub field ${k} not in schema`);
    }
    const [legend] = mintLegendStubs('continent-0', 3, { provinces: ['continent-0.province-0'], firstPort: null, eras: mintEras(3) });
    for (const k of Object.keys(legend)) {
      if (k === 'stub') continue;
      assert.ok(k in LEGEND_SCHEMA.properties, `legend stub field ${k} not in schema`);
    }
  });
});
