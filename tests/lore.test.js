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
  mintFactionStubs, mintWarState, bindCrownsToFactions, WAR_INTENSITIES,
} from '../src/worldgen/lore.js';
import { CROWN_SCHEMA, LEGEND_SCHEMA, FACTION_SCHEMA } from '../src/worldgen/schemas.js';

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

describe('factions and the war state (Phase A)', () => {
  const sk = mintWorldSkeleton(9);
  const byContinent = {};
  for (const cId of sk.continents) {
    byContinent[cId] = sk.provinces.filter(p => sk.geo.nodes[p].parent === cId);
  }

  it('mints deterministically, world-scoped, anchored round-robin', () => {
    const a = mintFactionStubs(9, { provincesByContinent: byContinent });
    const b = mintFactionStubs(9, { provincesByContinent: byContinent });
    assert.deepEqual(a, b, 'same seed, same powers');
    assert.deepEqual(a.map(f => f.id), a.map((_, i) => `faction-${i}`));
    for (const f of a) {
      assert.ok(f.territory.length >= 1 && f.territory.length <= 2);
      const homes = new Set(f.territory.map(p => sk.geo.nodes[p].parent));
      assert.equal(homes.size, 1, 'a faction is anchored to one continent');
    }
    // Round-robin: with ≥2 continents the first two factions live apart, so a
    // rivalry between them is a rivalry across the sea.
    if (sk.continents.length >= 2) {
      assert.notEqual(sk.geo.nodes[a[0].territory[0]].parent, sk.geo.nodes[a[1].territory[0]].parent);
    }
  });

  it('relations are symmetric, disjoint, and never self-referential — with a guaranteed fault line', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const factions = mintFactionStubs(seed, { provincesByContinent: byContinent });
      const byId = new Map(factions.map(f => [f.id, f]));
      let enemies = 0;
      for (const f of factions) {
        assert.ok(!f.allies.includes(f.id) && !f.enemies.includes(f.id), 'no self-relations');
        for (const id of f.enemies) {
          assert.ok(byId.get(id).enemies.includes(f.id), `enmity is mutual (${f.id}↔${id}, seed ${seed})`);
          assert.ok(!f.allies.includes(id), 'enemies and allies are disjoint');
          enemies++;
        }
        for (const id of f.allies) {
          assert.ok(byId.get(id).allies.includes(f.id), `alliance is mutual (${f.id}↔${id}, seed ${seed})`);
        }
      }
      assert.ok(enemies >= 2, `seed ${seed}: at least one enemy pair — no friction, no stories`);
    }
  });

  it('faction stubs are a subset of FACTION_SCHEMA plus archetype', () => {
    const [f] = mintFactionStubs(9, { provincesByContinent: byContinent, slots: [{ type: 'rival crown' }] });
    assert.equal(f.archetype, 'rival crown');
    for (const k of Object.keys(f)) {
      if (k === 'stub' || k === 'archetype') continue;
      assert.ok(k in FACTION_SCHEMA.properties, `faction stub field ${k} not in schema`);
    }
  });

  it('mintWarState: one war per enemy pair, fronts on real provinces, peace is null', () => {
    const factions = mintFactionStubs(9, { provincesByContinent: byContinent });
    const war = mintWarState(9, factions);
    const pairs = factions.reduce((n, f) => n + f.enemies.length, 0) / 2;
    assert.equal(war.wars.length, pairs);
    for (const w of war.wars) {
      assert.ok(WAR_INTENSITIES.includes(w.intensity));
      for (const p of w.front) assert.ok(sk.geo.nodes[p], `front ${p} is a real province`);
    }
    assert.equal(mintWarState(9, [{ id: 'faction-0', enemies: [], territory: [] }]), null,
      'a world at peace says so instead of shipping an empty ceremony');
  });

  it('bindCrownsToFactions seats exactly one sovereign per held province, pure', () => {
    const { crowns, factions } = mintLore(sk, 9);
    const held = new Set(factions.flatMap(f => f.territory));
    for (const crown of crowns) {
      const provinceId = crown.id.replace(/\.crown$/, '');
      const sovereigns = crown.factionRelations.filter(r => r.stance === 'sovereign');
      if (held.has(provinceId)) {
        assert.equal(sovereigns.length, 1, `${crown.id} has a throne-holder`);
        assert.ok(factions.find(f => f.id === sovereigns[0].factionId).territory.includes(provinceId));
      } else {
        assert.deepEqual(crown.factionRelations, [], 'an unheld crown stays unbound at genesis');
      }
    }
    // Purity: binding again from fresh stubs gives the same answer and the
    // inputs were never mutated.
    const rebound = bindCrownsToFactions(crowns, factions, 9);
    assert.deepEqual(rebound, crowns);
  });

  it('mintLore carries the powers, and factionSlots re-skin their archetypes', () => {
    const lore = mintLore(sk, 9, { factionSlots: [{ type: 'levy compact' }, { type: 'free league' }] });
    assert.equal(lore.factions.length, 2);
    assert.deepEqual(lore.factions.map(f => f.archetype), ['levy compact', 'free league']);
    assert.ok('warState' in lore);
  });
});
