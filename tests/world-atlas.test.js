// tests/world-atlas.test.js — the World Atlas core.
//
// What must hold: the layout is DETERMINISTIC (a world always draws the
// same map, or the atlas is a different picture every session); the
// player edition DELETES rather than dims (a secret you never send
// cannot leak through CSS); the normalisation resolves the id-to-id
// links the views draw (territory, wars, crown → faction → ruler); and
// registering the elements is a clean no-op under node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bakeCartridge } from '../src/worldgen/cartridge.js';
import { markVisited } from '../src/worldgen/geography.js';
import {
  atlasViewModel, worldLayout, fromCartridge, playerCut, fromAtlasPayload, CLIMATE_COLORS,
  groupDynasties, relationEdges, localViewModel,
} from '../src/ui/atlas.js';
import { generateDungeon } from '../src/dungeon/generate.js';
import { settlementLayout } from '../src/layout/settlement.js';
import { mulberry32 } from '../src/worldgen/rng.js';
import { defineWorldAtlas } from '../src/ui/atlas-views.js';

const world = async (seed = 1234, opts = {}) => (await bakeCartridge(seed, opts));

describe('worldLayout', () => {
  it('is deterministic: the same world draws the same map', async () => {
    const cart = await world();
    const a = worldLayout(cart.data.geo, { seed: cart.data.seed });
    const b = worldLayout(cart.data.geo, { seed: cart.data.seed });
    assert.deepEqual(a, b);
  });

  it('places every continent and province, inside its own bounds', async () => {
    for (const seed of [1, 7, 1234]) {
      const cart = await world(seed);
      const { nodes, bounds } = worldLayout(cart.data.geo, { seed });
      const placeable = Object.values(cart.data.geo.nodes)
        .filter((n) => n.kind === 'continent' || n.kind === 'province');
      assert.equal(Object.keys(nodes).length, placeable.length, `seed ${seed}`);
      for (const n of Object.values(nodes)) {
        assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
        assert.ok(n.x >= bounds.minX && n.x <= bounds.maxX);
        assert.ok(n.y >= bounds.minY && n.y <= bounds.maxY);
      }
    }
  });

  it('gives provinces of one continent distinct positions', async () => {
    const cart = await world(1234, { continents: 3, provincesPer: 4 });
    const { nodes } = worldLayout(cart.data.geo, { seed: 1234 });
    const provinces = Object.entries(nodes).filter(([, n]) => n.kind === 'province');
    const keys = provinces.map(([, n]) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`);
    assert.equal(new Set(keys).size, keys.length, 'two provinces landed on one square');
  });

  it('is STABLE UNDER FOG: a place keeps its coordinates as others are found', async () => {
    // The player edition hands the layout a subset. If positions came from
    // array order — or from an rng stream shared between continents, or a
    // ring sized by the continents currently visible — a province would
    // slide across the map as its neighbours were discovered, and "same
    // world, same map" would be a lie. This walks the real path: reveal
    // one province at a time and compare against the GM chart.
    const cart = await world(1234, { continents: 3, provincesPer: 4 });
    const gm = atlasViewModel(fromCartridge(cart));
    const gmAt = Object.fromEntries(gm.map.provinces.map((p) => [p.id, p]));

    let geo = cart.data.geo;
    const order = Object.values(geo.nodes).filter((n) => n.kind === 'province');
    for (const next of order) {
      geo = markVisited(geo, next.id);
      geo = markVisited(geo, next.parent);
      geo = { ...geo, edges: geo.edges.map((e) =>
        (geo.nodes[e.from]?.discovered && geo.nodes[e.to]?.discovered)
          ? { ...e, discovered: true } : e) };
      const vm = atlasViewModel(
        fromCartridge({ ...cart, data: { ...cart.data, geo } }, { edition: 'player' }));
      for (const p of vm.map.provinces) {
        assert.equal(p.x, gmAt[p.id].x, `${p.id} drifted in x once ${next.id} was found`);
        assert.equal(p.y, gmAt[p.id].y, `${p.id} drifted in y once ${next.id} was found`);
      }
    }
  });

  it('separates continents from each other', async () => {
    const cart = await world(1234, { continents: 4, provincesPer: 2 });
    const { nodes } = worldLayout(cart.data.geo, { seed: 1234 });
    const centres = Object.entries(nodes)
      .filter(([, n]) => n.kind === 'continent')
      .map(([, n]) => n);
    for (let i = 0; i < centres.length; i++) {
      for (let j = i + 1; j < centres.length; j++) {
        const d = Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y);
        assert.ok(d > 1, `continents ${i}/${j} overlap (distance ${d})`);
      }
    }
  });
});

describe('atlasViewModel', () => {
  it('resolves the links the views draw', async () => {
    const cart = await world(1234);
    const vm = atlasViewModel(fromCartridge(cart));
    assert.equal(vm.edition, 'gm');
    assert.ok(vm.map.provinces.length > 0);
    assert.ok(vm.map.continents.length > 0);

    // Every province carries drawable coordinates and a climate colour.
    for (const p of vm.map.provinces) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.equal(p.color, CLIMATE_COLORS[p.climate] ?? '#8d8d8d');
    }
    // Links only reference placed provinces (no dangling endpoints).
    const ids = new Set(vm.map.provinces.map((p) => p.id));
    for (const l of vm.map.links) {
      assert.ok(ids.has(l.from) && ids.has(l.to));
      assert.ok(l.a && l.b, 'a link without endpoints cannot be drawn');
    }
    // Powers resolve their leader; dynasties resolve crown → faction → ruler.
    assert.ok(vm.powers.length >= 1);
    assert.ok(vm.powers.every((p) => p.leader === null || p.leader.leads === p.id));
    assert.ok(vm.dynasties.length >= 1);
    const seated = vm.dynasties.filter((d) => d.faction);
    assert.ok(seated.length >= 1, 'at least one crown has a sovereign power');
    for (const d of seated) {
      assert.ok(vm.powers.some((p) => p.id === d.faction.id));
      if (d.ruler) assert.equal(d.ruler.seatOf, d.id);
    }
  });

  it('marks contested provinces from the war fronts', async () => {
    const cart = await world(1234);
    const vm = atlasViewModel(fromCartridge(cart));
    const fronts = new Set((cart.data.warState?.wars ?? []).flatMap((w) => w.front ?? []));
    for (const p of vm.map.provinces) assert.equal(p.atWar, fronts.has(p.id));
  });

  it('counts what the caption reports', async () => {
    const cart = await world(1234, { continents: 3, provincesPer: 3, factionCount: 5 });
    const vm = atlasViewModel(fromCartridge(cart));
    assert.equal(vm.meta.counts.continents, 3);
    assert.equal(vm.meta.counts.provinces, 9);
    assert.equal(vm.meta.counts.powers, 5);
  });
});

describe('editions', () => {
  it('the player cut DELETES the undiscovered, it does not dim it', async () => {
    const cart = await world(1234);
    let geo = cart.data.geo;
    const known = Object.values(geo.nodes).filter((n) => n.kind === 'province').slice(0, 2);
    for (const n of known) geo = markVisited(geo, n.id);
    const parents = new Set(known.map((n) => n.parent));
    for (const p of parents) geo = markVisited(geo, p);

    const cut = playerCut({ ...fromCartridge({ ...cart, data: { ...cart.data, geo } }), edition: 'player' });
    const ids = Object.keys(cut.geo.nodes);
    for (const n of known) assert.ok(ids.includes(n.id), 'a visited province is on the map');
    const hidden = Object.values(cart.data.geo.nodes)
      .filter((n) => n.kind === 'province' && !known.some((k) => k.id === n.id));
    for (const n of hidden) {
      assert.ok(!ids.includes(n.id), `${n.id} leaked into the player cut`);
    }
    // Serialising the player cut must not carry a hidden name anywhere.
    const wire = JSON.stringify(cut);
    for (const n of hidden) assert.ok(!wire.includes(n.name), `${n.name} leaked in the payload`);
  });

  it('strips GM-only lore fields from the player cut', async () => {
    const cart = await world(1234);
    let geo = cart.data.geo;
    for (const n of Object.values(geo.nodes)) geo = markVisited(geo, n.id);
    const cut = playerCut({ ...fromCartridge({ ...cart, data: { ...cart.data, geo } }), edition: 'player' });
    for (const c of cut.lore.crowns ?? []) {
      assert.ok(!('stanceOnThreat' in c), 'a crown shipped its threat stance to the players');
    }
    for (const l of cut.lore.legends ?? []) {
      assert.ok(!('kernelOfTruth' in l) && !('payoff' in l), 'a legend shipped its answer');
    }
  });

  it('an unexplored world renders as an empty player map, not a crash', async () => {
    const cart = await world(1234);
    const vm = atlasViewModel(fromCartridge(cart, { edition: 'player' }));
    assert.equal(vm.edition, 'player');
    assert.equal(vm.map.provinces.length, 0);
    assert.equal(vm.map.links.length, 0);
    assert.deepEqual(vm.meta.counts.provinces, 0);
  });

  it('fromAtlasPayload takes the server-scoped shape', () => {
    const payload = {
      seed: 7, revision: 2, edition: 'player',
      worldId: 'world-1234', campaign: 'curse-of-the-fen', digest: '8ab3f21c',
      geo: {
        nodes: {
          'continent-0': { id: 'continent-0', kind: 'continent', name: 'Ashmoor', discovered: true },
          'continent-0.province-0': { id: 'continent-0.province-0', kind: 'province', name: 'Wickmere', parent: 'continent-0', discovered: true },
        },
        edges: [],
      },
      factions: [], npcs: [], warState: null, lore: {},
    };
    const world = fromAtlasPayload(payload);
    assert.equal(world.edition, 'player');
    assert.equal(world.revision, 2);
    const vm = atlasViewModel(world);
    assert.equal(vm.meta.revision, 2);
    // Identity travels with the feed, so a host can caption the map with the
    // campaign and revision it is actually looking at.
    assert.equal(vm.meta.worldId, 'world-1234');
    assert.equal(vm.meta.campaign, 'curse-of-the-fen');
    assert.equal(vm.meta.digest, '8ab3f21c');
  });

  it('fromAtlasPayload keeps the SERVER\'s worldShape, not the fogged count', () => {
    // The whole point of worldShape is that it counts landmasses the party
    // has not found yet. Recomputing it from the fogged geography would
    // shrink it to the visible count and rotate the ring under the table.
    const payload = {
      seed: 7, edition: 'player', worldShape: { continents: 5 },
      geo: {
        nodes: {
          'continent-1': { id: 'continent-1', kind: 'continent', name: 'Ashmoor', discovered: true },
          'continent-1.province-0': { id: 'continent-1.province-0', kind: 'province', name: 'Wickmere', parent: 'continent-1', discovered: true },
        },
        edges: [],
      },
    };
    const world = fromAtlasPayload(payload);
    assert.deepEqual(world.worldShape, { continents: 5 });
    // And it reaches the layout: a 5-slot ring puts continent-1 further out
    // than a 1-slot ring would.
    const wide = atlasViewModel(world);
    const narrow = atlasViewModel({ ...world, worldShape: { continents: 1 } });
    const radius = (vm) => Math.hypot(vm.map.continents[0].x, vm.map.continents[0].y);
    assert.ok(radius(wide) > radius(narrow), 'worldShape did not reach worldLayout');
  });

  it('fromAtlasPayload re-cuts a payload that only CLAIMS to be player-safe', () => {
    // Defence in depth. The server's cut is the real boundary, but a label
    // the client takes on faith is a leak waiting for one bad deployment.
    const payload = {
      seed: 7, edition: 'player',
      geo: {
        nodes: {
          'continent-0': { id: 'continent-0', kind: 'continent', name: 'Ashmoor', discovered: true },
          'continent-0.province-0': { id: 'continent-0.province-0', kind: 'province', name: 'Wickmere', parent: 'continent-0', discovered: true },
          'continent-0.province-1': { id: 'continent-0.province-1', kind: 'province', name: 'The Sunken Vault', parent: 'continent-0', discovered: false },
        },
        edges: [{ from: 'continent-0.province-0', to: 'continent-0.province-1', kind: 'road', days: 2, discovered: false }],
      },
      lore: {
        legends: [{ id: 'legend-0', name: 'The Drowned Bell', sites: ['continent-0.province-0'], kernelOfTruth: 'the bell is a person', payoff: 'it rings for the king' }],
        crowns: [],
      },
    };
    const cut = fromAtlasPayload(payload);
    const json = JSON.stringify(cut);
    assert.equal(cut.geo.nodes['continent-0.province-1'], undefined);
    assert.equal(cut.geo.edges.length, 0);
    for (const secret of ['The Sunken Vault', 'the bell is a person', 'it rings for the king']) {
      assert.ok(!json.includes(secret), `payload leaked: ${secret}`);
    }
  });

  it('fromAtlasPayload leaves a gm payload whole', () => {
    const payload = {
      seed: 7, edition: 'gm',
      geo: {
        nodes: {
          'continent-0': { id: 'continent-0', kind: 'continent', name: 'Ashmoor', discovered: false },
          'continent-0.province-1': { id: 'continent-0.province-1', kind: 'province', name: 'The Sunken Vault', parent: 'continent-0', discovered: false },
        },
        edges: [],
      },
    };
    const world = fromAtlasPayload(payload);
    assert.equal(world.edition, 'gm');
    assert.ok(world.geo.nodes['continent-0.province-1'], 'the spoiler cut lost a node');
  });
});

describe('element registration', () => {
  it('is a clean no-op where custom elements do not exist', () => {
    assert.equal(defineWorldAtlas(), null);
  });
});

describe('power graph data', () => {
  it('draws each relation once, never twice', async () => {
    // Enmity is recorded on BOTH factions. Drawing it per-faction doubles
    // every stroke (and its opacity); the pair is the unit.
    const cart = await world(1234, { continents: 3, provincesPer: 3, factionCount: 6 });
    const vm = atlasViewModel(fromCartridge(cart));
    const edges = relationEdges(vm.powers);
    const keys = edges.map((e) => [e.from, e.to].sort().join('|') + `|${e.kind}`);
    assert.equal(new Set(keys).size, keys.length, 'a relation was drawn twice');
    // Every recorded relation still appears exactly once.
    const recorded = new Set();
    for (const p of vm.powers) {
      for (const [kind, ids] of [['ally', p.allies], ['enemy', p.enemies]]) {
        for (const o of ids ?? []) recorded.add([p.id, o].sort().join('|') + `|${kind}`);
      }
    }
    assert.deepEqual(new Set(keys), recorded);
  });

  it('never points a chord at a power that is not on the graph', async () => {
    // The player cut drops powers holding no known ground; their former
    // allies must not keep an edge to a node that was never placed.
    const cart = await world(1234);
    let geo = cart.data.geo;
    const first = Object.values(geo.nodes).find((n) => n.kind === 'province');
    geo = markVisited(geo, first.id);
    geo = markVisited(geo, first.parent);
    const vm = atlasViewModel(
      fromCartridge({ ...cart, data: { ...cart.data, geo } }, { edition: 'player' }));
    const ids = new Set(vm.powers.map((p) => p.id));
    for (const e of relationEdges(vm.powers)) {
      assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from}→${e.to} leaves the graph`);
    }
  });
});

describe('dynasty grouping', () => {
  it('files every crown under its power, unclaimed ones last', async () => {
    const cart = await world(1234, { continents: 2, provincesPer: 3, factionCount: 4 });
    const vm = atlasViewModel(fromCartridge(cart));
    const groups = groupDynasties(vm.dynasties, vm.powers);

    // No crown is lost, none is duplicated.
    const filed = groups.flatMap((g) => g.crowns.map((c) => c.id));
    assert.equal(filed.length, vm.dynasties.length);
    assert.equal(new Set(filed).size, filed.length);

    // Claimed groups come first; the unclaimed group is last if present.
    const unclaimedAt = groups.findIndex((g) => !g.faction);
    if (unclaimedAt !== -1) assert.equal(unclaimedAt, groups.length - 1);
    for (const g of groups.filter((x) => x.faction)) {
      assert.ok(vm.powers.some((p) => p.id === g.faction.id), 'group names a real power');
      for (const c of g.crowns) assert.equal(c.faction.id, g.faction.id);
    }
  });

  it('carries the power archetype for the group heading', async () => {
    const cart = await world(1234, { factionCount: 4 });
    const vm = atlasViewModel(fromCartridge(cart));
    for (const g of groupDynasties(vm.dynasties, vm.powers).filter((x) => x.faction)) {
      const power = vm.powers.find((p) => p.id === g.faction.id);
      assert.equal(g.archetype, power.archetype ?? null);
    }
  });
});

describe('a cast the table can tell apart', () => {
  it('gives every power a distinct name and every leader a distinct voice', async () => {
    // Both were visible in the atlas the moment it was drawn: two powers
    // called the same thing, two rulers with one manner of speaking.
    const { NPC_VOICES } = await import('../src/worldgen/lore.js');
    for (const seed of [1, 42, 1234, 9999]) {
      const cart = await world(seed, { continents: 3, provincesPer: 3, factionCount: 6 });
      const names = cart.data.factions.map((f) => f.name);
      assert.equal(new Set(names).size, names.length, `seed ${seed} repeated a faction name`);
      const voices = cart.data.npcs.map((n) => n.voice);
      if (voices.length <= NPC_VOICES.length) {
        assert.equal(new Set(voices).size, voices.length, `seed ${seed} repeated a voice`);
      }
    }
  });
});

describe('local maps (settlements and dungeons)', () => {
  const statBlockFor = (id, { isBoss } = {}) => ({
    hp: 10, maxHp: 10, ac: 12, toHit: 3, damageDie: '1d6', damageBonus: 1,
    cr: isBoss ? 3 : 1, tier: isBoss ? 'boss' : 'minion',
  });
  const aDungeon = (seed = 7) => generateDungeon(seed, {
    rng: mulberry32(seed), statBlockFor,
    defaultEnemyIds: ['skeleton', 'ghoul'], content: {},
  });

  it('every dungeon room publishes the grid cell it was placed on', () => {
    // The generator always knew; without it on the room a host cannot
    // draw the floor without re-deriving the whole walk.
    for (const seed of [1, 7, 99]) {
      for (const room of Object.values(aDungeon(seed).rooms)) {
        assert.ok(room.pos, `${room.id} has no pos`);
        assert.ok(Number.isInteger(room.pos.col) && Number.isInteger(room.pos.row));
      }
    }
  });

  it('draws a dungeon: one cell per room, doors deduped, locks kept', () => {
    const d = aDungeon(7);
    const vm = localViewModel(d);
    assert.equal(vm.kind, 'dungeon');
    assert.equal(vm.cells.length, Object.keys(d.rooms).length);

    // Exits are recorded from both sides; a door is one line, not two.
    const keys = vm.links.map((l) => [l.from, l.to].sort().join('|'));
    assert.equal(new Set(keys).size, keys.length);
    const lockedInRooms = Object.values(d.rooms)
      .flatMap((r) => r.exits.filter((e) => e.locked).map((e) => [r.id, e.roomId].sort().join('|')));
    assert.deepEqual(
      new Set(vm.links.filter((l) => l.locked).map((l) => [l.from, l.to].sort().join('|'))),
      new Set(lockedInRooms));

    // The entrance and the vault are marked, and the boss is pipped.
    assert.equal(vm.cells.filter((c) => c.role === 'entrance').length, 1);
    assert.equal(vm.cells.filter((c) => c.role === 'vault').length, 1);
    const bossRoom = d.npcs.boss.roomId;
    assert.ok(vm.cells.find((c) => c.id === bossRoom).tags.includes('boss'));
  });

  it('draws a settlement from the same function: plots, roles, buildings', () => {
    const town = settlementLayout(9, {
      kind: 'town',
      buildings: [{ type: 'inn', name: 'The Bell' }, { type: 'forge', name: 'Ashworks' }],
    });
    const vm = localViewModel(town);
    assert.equal(vm.kind, 'settlement');
    assert.equal(vm.cells.length, town.plots.length);
    assert.equal(vm.cells.filter((c) => c.role === 'gate').length, 1);
    const labels = vm.cells.map((c) => c.label).filter(Boolean);
    assert.ok(labels.includes('The Bell') && labels.includes('Ashworks'));
    for (const c of vm.cells) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
  });

  it('an empty place renders as an empty model, not a crash', () => {
    const vm = localViewModel({ plots: [] });
    assert.equal(vm.cells.length, 0);
    assert.equal(vm.links.length, 0);
  });
});
