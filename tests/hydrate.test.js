// tests/hydrate.test.js — hydration with a contract (doc 18 §5–§8, phase C).
//
// Everything here runs against a fake completer — the coherence machinery is
// the most testable part of the design precisely because none of it needs a
// model: post-conditions, the coercion ladder, commitments, atomic commit.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mintWorldSkeleton } from '../src/worldgen/skeleton.js';
import { mintLore } from '../src/worldgen/lore.js';
import { markVisited, discoverAncestors, knownMap, addNode, emptyGeography, connect } from '../src/worldgen/geography.js';
import {
  hydrateNode, ensureLineage, lineageContext, gazetteerOf, coerceBeatLocation,
  castGazetteerOf, coerceBeatCast,
  mintProvinceRegions, mintRegionSites, promoteObserved, HYDRATION_TEMPLATES,
} from '../src/worldgen/hydrate.js';

const skeletonWith = (seed = 1234) => {
  const sk = mintWorldSkeleton(seed, { continents: 2, provincesPer: 3 });
  const first = sk.provinces[0];
  const m = mintProvinceRegions(sk.geo, first);
  return { ...sk, geo: m.geo, firstProvince: first, firstRegion: m.minted[0] };
};

describe('discoverAncestors — hearing of the far shore', () => {
  it('visiting a region rumours the far port across the sea lane', () => {
    const { geo, firstRegion, firstProvince } = skeletonWith();
    const seen = markVisited(geo, firstRegion);
    // ancestors discovered but still stubs
    assert.equal(seen.nodes[firstProvince].discovered, true);
    assert.equal(seen.nodes[firstProvince].stub, true);
    const { rumoured } = knownMap(seen);
    // the far continent's port is sea-adjacent to our (now seen) port province
    const farPort = rumoured.find(n => n.id.startsWith('continent-1'));
    assert.ok(farPort, `far port not rumoured; rumoured = ${rumoured.map(n => n.id)}`);
  });
});

describe('ensureLineage', () => {
  it('lists un-outlined ancestors root first', () => {
    const { geo, firstRegion } = skeletonWith();
    const lineage = ensureLineage(geo, firstRegion);
    assert.deepEqual(lineage, ['continent-0', 'continent-0.province-0']);
  });
});

describe('mintProvinceRegions', () => {
  it('is deterministic, idempotent, and marks the port harbor', () => {
    const sk = mintWorldSkeleton(7);
    const port = sk.provinces.find(p => sk.geo.nodes[p].port);
    const a = mintProvinceRegions(sk.geo, port);
    const b = mintProvinceRegions(sk.geo, port);
    assert.deepEqual(a.minted, b.minted);
    assert.ok(a.minted.length >= 1);
    assert.equal(a.geo.nodes[a.minted[0]].harbor, true);
    const again = mintProvinceRegions(a.geo, port);
    assert.deepEqual(again.minted, []); // idempotent
  });
});

describe('hydrateNode', () => {
  it('hydrates a region via the completer, promotes, and mints sites', async () => {
    const { geo, firstRegion } = skeletonWith();
    const completer = async ({ schema }) => ({
      id: firstRegion, name: 'Emberfen', climate: 'mire',
      description: 'low country', settlementName: 'Fenwick', dungeonName: 'the Sunken Stair',
      rumor: 'lights over the reeds', adjacentHints: ['smoke to the east'], digest: 'a mire region',
    });
    const out = await hydrateNode(geo, firstRegion, { complete: completer, turn: 3 });
    assert.equal(out.ok, true);
    assert.equal(out.provisional, false);
    assert.equal(out.geo.nodes[firstRegion].detail, 2);
    assert.equal(out.geo.nodes[firstRegion].name, 'Emberfen');
    assert.ok(out.minted.includes(`${firstRegion}.site-settlement`));
    assert.ok(out.minted.includes(`${firstRegion}.site-dungeon`));
    assert.equal(out.geo.nodes[`${firstRegion}.site-settlement`].siteType, 'settlement');
    const content = out.patches.find(p => p.path === 'content');
    assert.equal(content.because, 'worldgen');
    assert.equal(content.target, firstRegion);
  });

  it('records adjacent hints as commitments on neighbour stubs', async () => {
    let geo = emptyGeography();
    geo = addNode(geo, { id: 'r0', name: 'Start', kind: 'region', seed: 1, stub: false, detail: 2 });
    geo = addNode(geo, { id: 'r1', name: 'East', kind: 'region', seed: 2, stub: true });
    geo = connect(geo, 'r0', 'r1', { direction: 'east' });
    const out = await hydrateNode(geo, 'r0', {
      complete: async () => ({
        id: 'r0', name: 'Start', climate: 'temperate', description: 'x',
        settlementName: 'S', dungeonName: 'D', rumor: 'r',
        adjacentHints: ['smoke over the eastern ridge'], digest: 'd',
      }),
    });
    const hint = out.patches.find(p => p.path === 'hintedBy');
    assert.equal(hint.target, 'r1');
    assert.equal(hint.to.hint, 'smoke over the eastern ridge');
    assert.equal(hint.because, 'worldgen:commitment');
    // ...and the neighbour's hydration prompt honours them
    const prompt = [];
    await hydrateNode(out.geo, 'r1', {
      ledger: out.patches,
      complete: async ({ prompt: p }) => { prompt.push(p); return {
        id: 'r1', name: 'East', climate: 'temperate', description: 'y',
        settlementName: 'S2', dungeonName: 'D2', rumor: 'r2', adjacentHints: [], digest: 'd2',
      }; },
    });
    assert.match(prompt[0], /smoke over the eastern ridge/);
  });

  it('semantic-repairs then coerces dangling references', async () => {
    const { geo, firstRegion } = skeletonWith();
    const rm = mintRegionSites(geo, firstRegion, { settlementName: 'Fenwick', dungeonName: 'Deep' });
    const siteId = `${firstRegion}.site-settlement`;
    let calls = 0;
    const bad = {
      id: siteId, name: 'Fenwick', description: 'x', regionId: firstRegion,
      npcs: [{ id: 'n1', name: 'Vera', role: 'innkeeper', attitude: 'friendly', greeting: 'hm', factionId: 'faction-nope' }],
      exits: [{ direction: 'east', targetName: 'Nowhere', targetType: 'road', targetId: 'no-such-node' }],
      digest: 'd',
    };
    const out = await hydrateNode(rm.geo, siteId, {
      complete: async ({ prompt }) => {
        calls++;
        if (calls === 2) assert.match(prompt, /invalid references/);
        return bad; // refuses to repair — the ladder must coerce
      },
      factions: [{ id: 'faction-real' }],
    });
    assert.equal(calls, 2); // one semantic-repair retry happened
    assert.equal(out.ok, true);
    assert.deepEqual([...new Set(out.coerced)].sort(), ['exitsResolve', 'factionsExist']);
    assert.equal(out.result.npcs[0].factionId, null);
    assert.equal(out.result.exits[0].targetId, null);
  });

  it('falls back procedurally when no model is available (provisional)', async () => {
    const { geo, firstRegion } = skeletonWith();
    const out = await hydrateNode(geo, firstRegion, { complete: null });
    assert.equal(out.ok, true);
    assert.equal(out.provisional, true);
    const p = out.patches.find(p => p.path === 'content');
    assert.equal(p.because, 'worldgen:provisional');
    assert.ok(out.result.settlementName); // the fallback is playable, not empty
  });

  it('province hydration mints its first regions', async () => {
    const sk = mintWorldSkeleton(77);
    const pId = sk.provinces[0];
    const out = await hydrateNode(sk.geo, pId, { complete: null, detail: 1 });
    assert.equal(out.ok, true);
    assert.ok(out.minted.length >= 1);
    assert.ok(out.minted.every(id => out.geo.nodes[id].kind === 'region'));
  });

  it('legend hydration coerces era and sites to real ones', async () => {
    const sk = mintWorldSkeleton(5);
    const { eras, legends } = mintLore(sk, 5);
    const stub = legends[0];
    const out = await hydrateNode(sk.geo, stub.id, {
      entity: { ...stub, kind: 'legend' },
      eras, legends,
      complete: async () => ({
        id: stub.id, title: stub.title, era: 'era-of-nothing',
        kernelOfTruth: 'k', sites: [...stub.sites, 'continent-9.province-9'],
        hooks: ['h'], payoff: 'p', digest: 'd',
      }),
    });
    assert.equal(out.ok, true);
    assert.ok(out.coerced.includes('eraValid'));
    assert.ok(out.coerced.includes('sitesResolve'));
    assert.equal(out.result.era, eras[0].id);
    assert.ok(out.result.sites.every(s => sk.geo.nodes[s]));
  });

  it('is atomic: an unknown node yields no patches and the same geo', async () => {
    const { geo } = skeletonWith();
    const out = await hydrateNode(geo, 'continent-9.region-9', { complete: null });
    assert.equal(out.ok, false);
    assert.deepEqual(out.patches, []);
    assert.equal(out.geo, geo);
  });
});

describe('gazetteer + beat coercion', () => {
  it('beats can only point at known places; coercion moves intent, not places', () => {
    const { geo, firstRegion } = skeletonWith();
    const seen = markVisited(geo, firstRegion);
    const gaz = gazetteerOf(seen, { legends: [] });
    assert.ok(gaz.some(g => g.id === firstRegion));
    const beat = { id: 'b1', preferredLocation: 'continent-0.province-0.region-0' };
    assert.equal(coerceBeatLocation(beat, gaz).preferredLocation, beat.preferredLocation);
    const wild = { id: 'b2', preferredLocation: 'the invented citadel of nowhere' };
    const coerced = coerceBeatLocation(wild, gaz);
    assert.ok(gaz.some(g => g.id === coerced.preferredLocation));
  });

  it('cast coercion: exact ids pass, prose re-binds, inventions drop', () => {
    const data = {
      factions: [{ id: 'faction-0', name: 'The Saltglass Concord' }],
      npcs: [{ id: 'continent-0.province-0.npc-0', name: 'Mara of the Sluice' }],
      lore: { crowns: [{ id: 'continent-0.province-0.crown', name: 'House Marren' }] },
    };
    const gaz = castGazetteerOf(data);
    assert.equal(gaz.length, 3, 'factions, crowns and npcs are all castable');

    const beat = coerceBeatCast({ id: 'b', cast: [
      'faction-0',                     // exact id — passes
      'the crown of House Marren',     // prose — re-binds to the crown entity
      'Mara',                          // name fragment — re-binds to the npc
      'the drowned parliament of eels' // invention — dropped, never invented
    ] }, gaz);
    assert.deepEqual(beat.cast, [
      'faction-0', 'continent-0.province-0.crown', 'continent-0.province-0.npc-0',
    ]);

    // Total: no cast is a no-op, an empty gazetteer empties the cast.
    const castless = { id: 'b2' };
    assert.equal(coerceBeatCast(castless, gaz), castless);
    assert.deepEqual(coerceBeatCast({ id: 'b3', cast: ['anyone'] }, []).cast, []);
  });
});

describe('observed provisionals', () => {
  it('a provisional fact the players saw reaches the real hydration prompt', async () => {
    const { geo, firstRegion } = skeletonWith();
    const fallbackRun = await hydrateNode(geo, firstRegion, { complete: null });
    const ledger = [...fallbackRun.patches, promoteObserved(firstRegion, 4)];
    const prompts = [];
    await hydrateNode(geo, firstRegion, {
      ledger,
      complete: async ({ prompt }) => { prompts.push(prompt); return {
        id: firstRegion, name: 'X', climate: 'temperate', description: 'x',
        settlementName: 'S', dungeonName: 'D', rumor: 'r', adjacentHints: [], digest: 'd',
      }; },
    });
    assert.match(prompts[0], /Provisional facts the players have already seen/);
  });
});

describe('template registry', () => {
  it('covers every tree kind with consumes and a fallback', () => {
    for (const key of ['continent', 'province', 'region', 'site:settlement', 'site:dungeon', 'site:landmark', 'crown', 'legend']) {
      const t = HYDRATION_TEMPLATES[key];
      assert.ok(t, key);
      assert.ok(Array.isArray(t.consumes) && t.consumes.length, `${key} consumes`);
      assert.equal(typeof t.fallback, 'function', `${key} fallback`);
      assert.ok(t.outline || t.full, `${key} layers`);
    }
  });
});
