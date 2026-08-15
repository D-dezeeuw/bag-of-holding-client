// tests/revision.test.js — entity-id ⇄ cell addressing (the revision plan's
// first slice; also the fold base the MCP replay fix consumes).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bakeCartridge } from '../src/worldgen/cartridge.js';
import { cellsOf, entityIdsOf, projectCells } from '../src/worldgen/revision.js';

// One real keyless bake shared by every case: the addressing must work on
// what bakeCartridge actually produces, not on a hand-made lookalike.
const cart = await bakeCartridge(77);
const data = cart.data;
const provinceId = data.provinces[0];
const continentId = data.continents[0];
const legendId = data.lore.legends[0].id;
const crownId = data.lore.crowns[0].id;

describe('cellsOf', () => {
  it('answers for a province with node + slice (+ outline only when hydrated)', () => {
    const cells = cellsOf(data, provinceId);
    assert.equal(cells.node, data.geo.nodes[provinceId]);
    assert.equal(cells.slice, data.slices[provinceId]);
    // Keyless bake ⇒ outlines is {} — the key must be OMITTED, not undefined.
    assert.ok(!('outline' in cells));
    assert.ok(!('legend' in cells));
  });

  it('answers for lore entities by their own ids', () => {
    assert.equal(cellsOf(data, legendId).legend, data.lore.legends[0]);
    assert.equal(cellsOf(data, crownId).crown, data.lore.crowns[0]);
    assert.equal(cellsOf(data, 'era-0').era, data.lore.eras[0]);
  });

  it('treats the world as one entity: slice plus the scalar cells', () => {
    const cells = cellsOf(data, 'world');
    assert.equal(cells.slice, data.slices.world);
    // Null is a value, not an absence — both scalars are present-and-null.
    assert.ok('settingId' in cells && cells.settingId === null);
    assert.ok('warState' in cells && cells.warState === null);
  });

  it('yields {} for unknown ids and junk input', () => {
    assert.deepEqual(cellsOf(data, 'continent-9.province-9'), {});
    assert.deepEqual(cellsOf(data, ''), {});
    assert.deepEqual(cellsOf(null, provinceId), {});
    assert.deepEqual(cellsOf(data, 42), {});
  });
});

describe('entityIdsOf', () => {
  it('spans nodes, slices, lore and the world id', () => {
    const ids = entityIdsOf(data);
    assert.ok(ids.has(provinceId));
    assert.ok(ids.has(continentId));
    assert.ok(ids.has(legendId));
    assert.ok(ids.has(crownId));
    assert.ok(ids.has('era-0'));
    assert.ok(ids.has('world'));
    assert.ok(!ids.has('nowhere'));
  });

  it('picks up v2 collection ids once they exist', () => {
    const withFaction = { ...data, factions: [{ id: 'faction-ashen', name: 'The Ashen Host' }] };
    assert.ok(entityIdsOf(withFaction).has('faction-ashen'));
    assert.ok(!entityIdsOf(data).has('faction-ashen'));
  });
});

describe('projectCells', () => {
  it('round-trips: projecting cellsOf\'s own answer is the identity, byte for byte', () => {
    for (const id of [provinceId, continentId, legendId, crownId, 'era-0', 'world']) {
      const out = projectCells(data, id, cellsOf(data, id));
      assert.equal(JSON.stringify(out), JSON.stringify(data), `round-trip broke for ${id}`);
    }
  });

  it('edits one cell without touching the rest', () => {
    const renamed = { ...data.geo.nodes[provinceId], name: 'Saltmarch' };
    const out = projectCells(data, provinceId, { node: renamed });
    assert.equal(out.geo.nodes[provinceId].name, 'Saltmarch');
    // Everything else is untouched — shared references, not copies.
    assert.equal(out.slices, data.slices);
    assert.equal(out.lore, data.lore);
    assert.equal(out.geo.nodes[continentId], data.geo.nodes[continentId]);
    // And the input was never mutated.
    assert.notEqual(data.geo.nodes[provinceId].name, 'Saltmarch');
  });

  it('adds where the id is new: array cells append, map cells insert', () => {
    const faction = { id: 'faction-ashen', name: 'The Ashen Host' };
    const withFaction = projectCells(data, 'faction-ashen', { faction });
    assert.deepEqual(withFaction.factions, [faction]);

    const legend = { id: `${continentId}.legend-9`, title: 'The Salt Tithe', sites: [] };
    const withLegend = projectCells(data, legend.id, { legend });
    assert.equal(withLegend.lore.legends.length, data.lore.legends.length + 1);
    assert.equal(withLegend.lore.legends.at(-1), legend, 'adds append at the end');

    const outline = { id: provinceId, name: 'x', digest: 'a province, outlined', conflicts: [], landmarks: [] };
    const withOutline = projectCells(data, provinceId, { outline });
    assert.equal(withOutline.outlines[provinceId], outline);
  });

  it('edits an array record in place, preserving order', () => {
    const edited = { ...data.lore.crowns[0], legitimacy: 'usurped' };
    const out = projectCells(data, crownId, { crown: edited });
    assert.equal(out.lore.crowns[0], edited);
    assert.equal(out.lore.crowns.length, data.lore.crowns.length);
    assert.deepEqual(out.lore.crowns.map((c) => c.id), data.lore.crowns.map((c) => c.id));
  });

  it('writes the world scalars only for the world id', () => {
    const atWar = projectCells(data, 'world', { warState: { between: ['a', 'b'] } });
    assert.deepEqual(atWar.warState, { between: ['a', 'b'] });
    const notWorld = projectCells(data, provinceId, { warState: { between: ['a', 'b'] } });
    assert.equal(notWorld.warState, null, 'a non-world id cannot reach the world scalars');
  });

  it('is a no-op on junk input', () => {
    assert.equal(projectCells(data, provinceId, null), data);
    assert.equal(projectCells(data, '', { node: {} }), data);
    assert.equal(projectCells(null, provinceId, { node: {} }), null);
  });
});
