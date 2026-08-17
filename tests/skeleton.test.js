// The layered world's load-bearing invariants (doc 17).
//
// The whole design rests on four properties: the same seed always shapes the
// same world (determinism), places exist before they cost anything
// (laziness), the world's size on disk tracks where the player has BEEN, not
// how big the world is (boundedness), and detail only ever rises
// (monotonicity). If any of these breaks, textual LOD degrades back into
// either a star (regenerating worlds) or a bill (eager generation).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mintWorldSkeleton, adoptFlatWorld, CLIMATE_BANDS } from '../src/worldgen/skeleton.js';
import {
  addNode, emptyGeography, childrenOf, ancestorsOf, promoteNode, expandFrom,
  markVisited, knownMap, neighbours, routeBetween,
} from '../src/worldgen/geography.js';

describe('mintWorldSkeleton', () => {
  it('is deterministic: the same seed shapes the same world, twice', () => {
    const a = mintWorldSkeleton(1234);
    const b = mintWorldSkeleton(1234);
    assert.deepEqual(a, b);
    const c = mintWorldSkeleton(1235);
    assert.notDeepEqual(a.geo.nodes, c.geo.nodes, 'a different seed must shape a different world');
  });

  it('mints 2-4 continents of 2-4 provinces, stubs all the way down', () => {
    for (const seed of [1, 77, 90210, 424242]) {
      const { geo, continents, provinces } = mintWorldSkeleton(seed);
      assert.ok(continents.length >= 2 && continents.length <= 4, `continents: ${continents.length}`);
      for (const cId of continents) {
        const mine = childrenOf(geo, cId);
        assert.ok(mine.length >= 2 && mine.length <= 4, `provinces of ${cId}: ${mine.length}`);
        assert.ok(mine.every(p => p.kind === 'province'));
      }
      // Everything starts at detail 0 — the skeleton costs no generation.
      assert.ok(provinces.every(p => geo.nodes[p].detail === 0));
      assert.ok(continents.every(c => geo.nodes[c].detail === 0));
      // Every province owns a climate band for its regions to inherit.
      assert.ok(provinces.every(p => CLIMATE_BANDS.includes(geo.nodes[p].climate)));
    }
  });

  it('connects the sea: every continent has a port, every port has a lane, the sea is a ring', () => {
    // 200 seeds: no orphan harbors (the old pass flagged big continents'
    // far port but never laned it), and every continent pair routes by sea.
    for (let seed = 1; seed <= 200; seed++) {
      const { geo, continents, provinces } = mintWorldSkeleton(seed);
      const ports = provinces.filter(p => geo.nodes[p].port);
      for (const cId of continents) {
        assert.ok(ports.some(p => geo.nodes[p].parent === cId),
          `${cId} has no port — unreachable by sea (seed ${seed})`);
      }
      const seaEdges = geo.edges.filter(e => e.kind === 'sea');
      assert.ok(seaEdges.every(e => geo.nodes[e.from].port && geo.nodes[e.to].port));
      if (ports.length > 1) {
        for (const p of ports) {
          assert.ok(seaEdges.some(e => e.from === p || e.to === p),
            `${p} is an orphan harbor (seed ${seed})`);
        }
      }
      // Any two continents' first ports route over sea + land.
      const first = continents.map(cId => ports.find(p => geo.nodes[p].parent === cId));
      for (let i = 1; i < first.length; i++) {
        assert.ok(routeBetween(geo, first[0], first[i]),
          `${first[0]} cannot reach ${first[i]} (seed ${seed})`);
      }
    }
  });
});

describe('containment and promotion', () => {
  it('ancestorsOf walks region → province → continent', () => {
    const { geo, provinces } = mintWorldSkeleton(9);
    const pId = provinces[0];
    const withRegion = addNode(geo, {
      id: 'region-start', name: 'Emberfen', kind: 'region', seed: 7, parent: pId, stub: false, detail: 2,
    });
    const chain = ancestorsOf(withRegion, 'region-start');
    assert.deepEqual(chain.map(n => n.kind), ['province', 'continent']);
    assert.equal(chain[0].id, pId);
  });

  it('promotion is monotonic and only full detail clears the stub flag', () => {
    const { geo, provinces } = mintWorldSkeleton(9);
    const pId = provinces[1];
    const outlined = promoteNode(geo, pId, { detail: 1, digest: 'A salt-bitten border province.' });
    assert.equal(outlined.nodes[pId].detail, 1);
    assert.equal(outlined.nodes[pId].digest, 'A salt-bitten border province.');
    assert.equal(outlined.nodes[pId].stub, true, 'outlined is still "not yet generated"');
    // Re-outlining at a lower level must not demote.
    const demoted = promoteNode(outlined, pId, { detail: 0 });
    assert.equal(demoted.nodes[pId].detail, 1);
    const detailed = promoteNode(outlined, pId, { detail: 2, name: 'the Saltmarch' });
    assert.equal(detailed.nodes[pId].stub, false);
    assert.equal(detailed.nodes[pId].name, 'the Saltmarch');
    // Unknown ids are a no-op, not a throw.
    assert.equal(promoteNode(geo, 'nope', { detail: 1 }), geo);
  });

  it('the region frontier inherits its province', () => {
    const { geo, provinces } = mintWorldSkeleton(21);
    const pId = provinces[0];
    let g = addNode(geo, { id: 'r0', name: 'Start', kind: 'region', seed: 40, parent: pId, stub: false, detail: 2 });
    g = expandFrom(g, 'r0', { count: 3 });
    const minted = neighbours(g, 'r0');
    assert.ok(minted.length >= 1);
    assert.ok(minted.every(n => g.nodes[n.id].parent === pId),
      'minted neighbour regions must belong to the same province, not float free');
  });

  it('knownMap keeps outlined-but-unvisited places on the rumour side', () => {
    const { geo, provinces } = mintWorldSkeleton(33);
    let g = addNode(geo, { id: 'r0', name: 'Start', kind: 'region', seed: 4, parent: provinces[0], stub: false, detail: 2 });
    g = markVisited(g, 'r0');
    g = promoteNode(g, provinces[1], { detail: 1, digest: 'outlined' });
    const map = knownMap(g);
    assert.ok(!map.visited.some(n => n.id === provinces[1]),
      'an outline is hearsay, not a visit');
  });
});

describe('back-compat: adoptFlatWorld', () => {
  it('files parentless regions under a synthetic province, idempotently', () => {
    let flat = emptyGeography();
    flat = addNode(flat, { id: 'region-a', name: 'Emberfen', kind: 'region', seed: 5, stub: false });
    flat = addNode(flat, { id: 'region-a.north', name: 'Saltreach', kind: 'region', seed: 6, stub: true });
    const adopted = adoptFlatWorld(flat, 42);
    assert.equal(adopted.nodes['region-a'].parent, 'continent-known.province-known');
    assert.equal(adopted.nodes['region-a.north'].parent, 'continent-known.province-known');
    assert.equal(adopted.nodes['continent-known'].kind, 'continent');
    // Region content is untouched — an address, not a regeneration.
    assert.equal(adopted.nodes['region-a'].name, 'Emberfen');
    assert.equal(adopted.nodes['region-a'].stub, false);
    // Idempotent: adopting an already-layered world changes nothing.
    assert.equal(adoptFlatWorld(adopted, 42), adopted);
    // A skeleton-minted world is never re-adopted.
    const { geo } = mintWorldSkeleton(1);
    assert.equal(adoptFlatWorld(geo, 1), geo);
  });
});

describe('the LOD walk: lazy, bounded, reproducible', () => {
  // Simulate a long campaign's travel: hydrate 120 regions across the
  // starting province's frontier. The world must stay O(visited + frontier),
  // no node below detail 1 may require content, and the same seed must
  // reproduce the identical walk.
  function walk(seed, steps) {
    const { geo, provinces } = mintWorldSkeleton(seed);
    let g = addNode(geo, {
      id: 'region-start', name: 'Start', kind: 'region',
      seed: (seed * 7 + 1) >>> 0, parent: provinces[0], stub: false, detail: 2,
    });
    g = expandFrom(g, 'region-start', { count: 3 });
    let current = 'region-start';
    for (let i = 0; i < steps; i++) {
      const next = neighbours(g, current).find(n => g.nodes[n.id].stub);
      if (!next) break;
      g = markVisited(g, next.id);              // arrival = full detail
      g = expandFrom(g, next.id, { count: 2 }); // frontier keeps moving
      current = next.id;
    }
    return g;
  }

  it('holds all three invariants over a 120-region campaign', () => {
    const g1 = walk(777, 120);
    const g2 = walk(777, 120);
    assert.deepEqual(g1, g2, 'the same seed must reproduce the identical campaign');

    const nodes = Object.values(g1.nodes);
    const visited = nodes.filter(n => n.detail === 2).length;
    const stubs   = nodes.filter(n => n.detail === 0).length;
    // Boundedness: the frontier is a constant factor of the visited set, not
    // a function of world size (the skeleton adds a fixed handful of layers).
    assert.ok(nodes.length < visited * 4 + 20,
      `world grew superlinearly: ${nodes.length} nodes for ${visited} visited`);
    // Laziness: everything not walked to is a free stub — nothing above
    // detail 0 exists without an explicit promotion or visit.
    assert.ok(stubs > 0);
    assert.ok(nodes.every(n => n.detail === 2 ? n.discovered || n.kind !== 'region' : true));
    // And the layers are intact: every region has a province above it.
    const regions = nodes.filter(n => n.kind === 'region');
    assert.ok(regions.every(r => ancestorsOf(g1, r.id).some(a => a.kind === 'province')));
  });
});
