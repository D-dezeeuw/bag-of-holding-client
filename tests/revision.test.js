// tests/revision.test.js — entity-id ⇄ cell addressing (the revision plan's
// first slice; also the fold base the MCP replay fix consumes).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bakeCartridge } from '../src/worldgen/cartridge.js';
import { makePatch } from '../src/ledger/patch.js';
import {
  cellsOf, entityIdsOf, projectCells,
  REVISION_VERSION, REVISION_CELLS,
  makeRevision, mountRevision, applyRevision, applyRevisions,
  resolvedDigest, classifyRevision, revisionConflicts,
} from '../src/worldgen/revision.js';

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
    // Both scalars are present; settingId is present-and-null on a default
    // bake (null is a value, not an absence), warState carries the wars the
    // genesis factions minted (or null in a world at peace).
    assert.ok('settingId' in cells && cells.settingId === null);
    assert.ok('warState' in cells);
    assert.equal(cells.warState, data.warState);
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
    assert.equal(withFaction.factions.length, data.factions.length + 1);
    assert.equal(withFaction.factions.at(-1), faction);

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
    assert.equal(notWorld.warState, data.warState, 'a non-world id cannot reach the world scalars');
  });

  it('is a no-op on junk input', () => {
    assert.equal(projectCells(data, provinceId, null), data);
    assert.equal(projectCells(data, '', { node: {} }), data);
    assert.equal(projectCells(null, provinceId, { node: {} }), null);
  });
});

// ─── The revision artifact ───────────────────────────────────────────────────

describe('the revision format', () => {
  const patch = (target, path, to, because = 'rev') =>
    makePatch({ turn: 0, target, scope: 'world', kind: 'canon', path, to, because, source: 'revision' });

  const r1 = () => makeRevision({
    worldId: 'world-77', revision: 1,
    base: { revision: 0, digest: cart.c },
    ledger: [
      patch(provinceId, 'node', { ...data.geo.nodes[provinceId], name: 'Saltmarch' }),
      patch('world', 'warState', { wars: [{ id: 'war-x', between: ['faction-0', 'faction-1'], intensity: 'cold', cause: 'a test', front: [] }] }),
    ],
    notes: 'a new name on the south reach; the war stated',
    now: '2026-08-15T00:00:00Z',
  });

  it('resolvedDigest(pristine data) IS the cartridge digest — revision 0 needs no special case', () => {
    assert.equal(resolvedDigest(data), cart.c);
  });

  it('authoring validates the cell vocabulary and the base stacking', () => {
    const rev = r1();
    assert.equal(rev.v, REVISION_VERSION);
    assert.equal(rev.data.base.digest, cart.c);
    assert.throws(() => makeRevision({
      worldId: 'world-77', revision: 1, base: { revision: 0, digest: cart.c },
      ledger: [patch(provinceId, 'terrain.mood', 'wrong')],
    }), new RegExp(`unknown cell 'terrain'.*${REVISION_CELLS.join(', ')}`), 'the refusal names the legal vocabulary');
    assert.throws(() => makeRevision({
      worldId: 'world-77', revision: 2, base: { revision: 0, digest: cart.c }, ledger: [patch('world', 'settingId', 'x')],
    }), /must stack on base 1/);
    assert.throws(() => makeRevision({
      worldId: 'world-77', revision: 1, base: { revision: 0, digest: cart.c }, ledger: [],
    }), /non-empty/);
  });

  it('mounts its own envelope and refuses structural junk', () => {
    const rev = r1();
    const mounted = mountRevision(JSON.stringify(rev));
    assert.deepEqual(mounted, rev.data);
    const errs = [];
    assert.equal(mountRevision(JSON.stringify({ v: REVISION_VERSION, data: { worldId: 'w' } }),
      { onError: (c, d) => errs.push([c, d]) }), null);
    assert.equal(errs[0][0], 'revision-invalid');
    assert.equal(mountRevision(JSON.stringify({ ...rev, v: REVISION_VERSION + 1 }),
      { onError: (c) => errs.push([c]) }), null, 'a future revision format is refused');
  });

  it('applies: the edit lands, the add appends, arrays re-derive, and twice is byte-identical', () => {
    const newProvince = {
      id: `${continentId}.province-99`, name: 'Fenholt', kind: 'province',
      parent: continentId, seed: 9, detail: 0, stub: true,
    };
    const ledger = [
      ...r1().data.ledger,
      patch(newProvince.id, 'node', newProvince),
    ];
    const out = applyRevision(data, ledger);
    assert.equal(out.geo.nodes[provinceId].name, 'Saltmarch', 'the edit landed');
    assert.equal(out.warState.wars[0].id, 'war-x', 'the world scalar landed');
    assert.ok(out.provinces.includes(newProvince.id), 'the index re-derived the added province');
    assert.equal(data.geo.nodes[provinceId].name === 'Saltmarch', false, 'pristine data untouched');
    assert.equal(JSON.stringify(applyRevision(data, ledger)), JSON.stringify(out), 'resolution is deterministic');
  });

  it('re-deriving the index on an untouched world is byte-identical to the bake', () => {
    // applyRevision re-derives continents/provinces from geo after every
    // apply; that is only safe if derivation reproduces the baked arrays
    // exactly. An empty-target ledger exercises just the reindex.
    const out = applyRevision(data, [patch('world', 'settingId', null)]);
    assert.deepEqual(out.continents, data.continents);
    assert.deepEqual(out.provinces, data.provinces);
  });

  it('resolves a chain, and a wrong base digest refuses that revision AND everything above', () => {
    const rev1 = r1();
    const afterR1 = applyRevision(data, rev1.data.ledger);
    const rev2 = makeRevision({
      worldId: 'world-77', revision: 2,
      base: { revision: 1, digest: resolvedDigest(afterR1) },
      ledger: [patch(crownId, 'crown.legitimacy', 'usurped')],
    });

    const good = applyRevisions(data, [rev1.data, rev2.data]);
    assert.deepEqual(good.applied, [1, 2]);
    assert.equal(good.data.lore.crowns[0].legitimacy, 'usurped');
    assert.equal(resolvedDigest(good.data), resolvedDigest(applyRevision(afterR1, rev2.data.ledger)),
      'chain resolution === stepwise resolution');

    // Corrupt r1's authored-against digest: r1 refuses, r2 falls with it.
    const errs = [];
    const broken = applyRevisions(data,
      [{ ...rev1.data, base: { revision: 0, digest: 'deadbeef' } }, rev2.data],
      { onError: (c, d) => errs.push([c, d]) });
    assert.deepEqual(broken.applied, []);
    assert.equal(resolvedDigest(broken.data), cart.c, 'the base keeps serving');
    assert.equal(errs[0][0], 'revision-base-mismatch');

    // A numbering gap truncates the same way.
    const gapErrs = [];
    const gapped = applyRevisions(data, [rev2.data], { onError: (c) => gapErrs.push(c) });
    assert.deepEqual(gapped.applied, []);
    assert.deepEqual(gapErrs, ['revision-gap']);
  });

  it('classifies per resolution: the same patch is an edit at r0 and an add nowhere', () => {
    const newLegend = { id: `${continentId}.legend-9`, title: 'The Salt Tithe', sites: [provinceId] };
    const ledger = [
      patch(provinceId, 'node.name', 'Saltmarch'),          // node exists → edit
      patch(newLegend.id, 'legend', newLegend),             // legend does not → add
    ];
    const { adds, edits } = classifyRevision(data, ledger);
    assert.deepEqual(edits.map(p => p.target), [provinceId]);
    assert.deepEqual(adds.map(p => p.target), [newLegend.id]);
    // Once the add has been applied, the SAME patch classifies as an edit —
    // the split is per-resolution, which is what makes upgrades honest.
    const later = applyRevision(data, [patch(newLegend.id, 'legend', newLegend)]);
    assert.equal(classifyRevision(later, ledger).edits.length, 2);
  });

  it('conflicts: containment both ways, paths prefix-aware, adds never blocked', () => {
    const edits = [
      patch(provinceId, 'node.name', 'Saltmarch'),
      patch(`${provinceId}.region-0`, 'node.mood', 'uneasy'),
      patch(crownId, 'crown.legitimacy', 'usurped'),
    ];
    // The whole province was observed: it, its region AND its crown block —
    // the crown id lives under the province id, and a table that has seen
    // the province has met its throne.
    const wholeProvince = revisionConflicts(edits, { [provinceId]: '*' });
    assert.deepEqual(wholeProvince.map(c => c.target).sort(),
      [provinceId, `${provinceId}.crown`, `${provinceId}.region-0`].sort());
    assert.ok(wholeProvince.every(c => c.blockedBy === provinceId));
    // A DIFFERENT province's observation blocks none of these.
    assert.deepEqual(revisionConflicts(edits, { [data.provinces[1]]: '*' }), []);

    // Observing a REGION blocks the edit that replaces its whole province —
    // containment runs upward too.
    const regionSeen = revisionConflicts([edits[0]], { [`${provinceId}.region-0`]: ['node'] });
    assert.equal(regionSeen.length, 1);

    // Path-scoped observation: only conflicting paths block — and the
    // observed paths guard everything under the observed entity, so
    // 'node.mood' spares the province rename but blocks the region's mood.
    const pathScoped = revisionConflicts(edits, { [provinceId]: ['node.name'] });
    assert.deepEqual(pathScoped.map(c => c.target), [provinceId]);
    assert.deepEqual(revisionConflicts(edits, { [provinceId]: ['node.mood'] }).map(c => c.target),
      [`${provinceId}.region-0`], 'a different path spares the province itself');
    assert.deepEqual(revisionConflicts([], { [provinceId]: '*' }), [], 'no edits, no conflicts');
  });
});
