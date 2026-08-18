// === The World Atlas — pure core ===
//
// Everything needed to LOOK at a generated world, with no DOM in sight.
// The elements in atlas-views.js are thin skins over the functions here,
// so the part that can be wrong stays node-testable — the same split the
// initiative tracker uses.
//
// THE COORDINATE PROBLEM, AND WHY IT IS SOLVED HERE
//
// A world's geography is a GRAPH, deliberately: nodes carry no x/y, and
// travel is priced in days, not distance (see travel/modes.js). That is
// the right call for the engine — and it means a map has to invent
// positions. It invents them HERE, at view time, seeded from the world's
// own seed, so:
//
//   - the same world always draws the same map, forever (replayable);
//   - the cartridge format never gains a `x`/`y` field it would have to
//     migrate, digest and defend;
//   - a host that wants a different projection writes its own layout and
//     keeps every other part of the atlas.
//
// The layout reuses `placeOnGrid` from the layout engine — the same
// self-avoiding walk that lays out dungeon corridors and settlement
// streets, which is exactly the shape a chain of provinces wants.
//
// EDITIONS
//
// `gm` is the spoiler cut: the whole world, with unvisited places drawn
// faintly. `player` is what the table has actually earned: undiscovered
// nodes and edges are gone, not greyed — you cannot leak a secret you
// never sent. Same vocabulary as world_export's player/GM editions.

import { mulberry32 } from '../worldgen/rng.js';
import { placeOnGrid } from '../layout/engine.js';

/** Climate → map ink. Eight bands (CLIMATE_BANDS), eight colours. */
export const CLIMATE_COLORS = Object.freeze({
  temperate: '#7e9b63',
  arid:      '#c9a86a',
  frozen:    '#a8c0cc',
  tropical:  '#5f9e73',
  volcanic:  '#a4655c',
  coastal:   '#7fa9b0',
  highland:  '#9a9484',
  mire:      '#6f7f5e',
});

export const EDITIONS = Object.freeze(['gm', 'player']);

const isKnown = (thing) => thing?.discovered === true;

// One province square is `cell` USER UNITS across. It is deliberately
// large: inside an SVG viewBox, `font-size: 12px` means twelve USER
// UNITS, so a unit grid would render labels many times the size of the
// world. A hundred-unit cell lets type, strokes and marks all be
// expressed in comfortable whole numbers.
export const ATLAS_CELL = 100;

// Positions must be STABLE UNDER FOG: the player edition hands us only
// the provinces a table has found, and a place must not slide across the
// map because its neighbour was discovered. So a node's slot comes from
// the index in its own id (`continent-2.province-3`), never from its
// position in whatever subset we were given. Hosts with their own id
// scheme fall back to array order, which is stable for a full world.
const indexIn = (id, kind, fallback) => {
  const m = new RegExp(`${kind}-(\\d+)$`).exec(String(id ?? ''));
  return m ? Number(m[1]) : fallback;
};

/**
 * Deterministic coordinates for a coordinate-free world.
 *
 * Continents are dealt onto a coarse ring (so the sea between them is
 * real space, not a rounding error); each continent's provinces fill its
 * block via `placeOnGrid`. Returns unit-ish coordinates — the view scales
 * them — plus the bounding box, so a renderer never has to measure.
 *
 *   → { nodes: { [id]: { x, y, kind, continent } }, bounds: {…}, cell }
 */
export function worldLayout(geo, { seed = 1, cell = ATLAS_CELL, gap = 1.6, ringSize = null } = {}) {
  const nodes = {};
  const all = Object.values(geo?.nodes ?? {});
  const continents = all.filter((n) => n.kind === 'continent');

  // Ring slots come from the ids, so a wholly-unvisited landmass leaves a
  // gap in the ocean rather than rotating the others. `ringSize` is how
  // many slots the ring has in the WHOLE world — a fogged view must be
  // told, or the first sight of a third continent would swing the two
  // already on the map. `playerCut` carries it as `worldShape`.
  const contSlot = new Map(continents.map((c, i) => [c.id, indexIn(c.id, 'continent', i)]));
  const ringSlots = Math.max(
    ringSize ?? 0, continents.length, ...[...contSlot.values()].map((i) => i + 1));
  const radius = (0.9 + Math.max(1, ringSlots) * 0.5) * gap * cell;

  continents.forEach((cont) => {
    const slot = contSlot.get(cont.id);
    const angle = (slot / Math.max(1, ringSlots)) * Math.PI * 2 - Math.PI / 2;
    const ox = ringSlots === 1 ? 0 : Math.cos(angle) * radius;
    const oy = ringSlots === 1 ? 0 : Math.sin(angle) * radius;

    // Each continent walks its own rng, seeded from its own node seed.
    // A shared stream would let a fogged neighbour (fewer draws) reshape
    // this landmass — the fog must never move the ground.
    const rng = mulberry32((((cont.seed ?? seed ?? 1) + 909) >>> 0));
    const provinces = all.filter((n) => n.kind === 'province' && n.parent === cont.id);
    const provinceSlots = provinces.map((p, i) => indexIn(p.id, 'province', i));
    // placeOnGrid is prefix-stable: the first N cells of a longer walk are
    // the same cells, so asking for fewer slots never moves the rest.
    const { positions } = placeOnGrid(Math.max(1, ...provinceSlots.map((s) => s + 1)), rng);

    provinces.forEach((prov, p) => {
      const pos = positions[provinceSlots[p]] ?? { col: 0, row: 0 };
      nodes[prov.id] = {
        x: ox + pos.col * cell,
        y: oy + pos.row * cell,
        kind: 'province',
        continent: cont.id,
      };
    });
    // The continent's own marker sits at its centre of mass, which reads
    // as a label anchor rather than a place.
    const mine = provinces.map((p) => nodes[p.id]).filter(Boolean);
    nodes[cont.id] = {
      x: mine.length ? mine.reduce((s, n) => s + n.x, 0) / mine.length : ox,
      y: mine.length ? mine.reduce((s, n) => s + n.y, 0) / mine.length : oy,
      kind: 'continent',
      continent: cont.id,
    };
  });

  const xs = Object.values(nodes).map((n) => n.x);
  const ys = Object.values(nodes).map((n) => n.y);
  const pad = cell * 1.5;
  const bounds = xs.length
    ? { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad,
        minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad }
    : { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return { nodes, bounds, cell };
}

/**
 * Normalise a world into everything the views draw, fog applied.
 *
 * `world` is the shape `fromCartridge` / `fromAtlasPayload` produce:
 * `{ seed, geo, factions, npcs, warState, lore, edition }`.
 *
 *   → { edition, map, powers, dynasties, meta }
 */
export function atlasViewModel(world = {}, { seed = null } = {}) {
  const edition = world.edition === 'player' ? 'player' : 'gm';
  const geo = world.geo ?? { nodes: {}, edges: [] };
  const layout = worldLayout(geo, {
    seed: seed ?? world.seed ?? 1,
    ringSize: world.worldShape?.continents ?? null,
  });

  const factions = Array.isArray(world.factions) ? world.factions : [];
  const npcs = Array.isArray(world.npcs) ? world.npcs : [];
  const crowns = Array.isArray(world.lore?.crowns) ? world.lore.crowns : [];
  const wars = Array.isArray(world.warState?.wars) ? world.warState.wars : [];

  // Territory → holder, so a province can be tinted by whoever claims it.
  const holderOf = {};
  for (const f of factions) for (const pid of f.territory ?? []) holderOf[pid] = f.id;

  const provinces = Object.values(geo.nodes)
    .filter((n) => n.kind === 'province')
    .map((n) => ({
      id: n.id,
      name: n.name,
      continent: n.parent,
      climate: n.climate ?? null,
      color: CLIMATE_COLORS[n.climate] ?? '#8d8d8d',
      port: n.port === true,
      waygate: n.waygate === true,
      discovered: n.discovered === true,
      detail: n.detail ?? 0,
      hook: n.hook ?? null,
      digest: n.digest ?? null,
      holder: holderOf[n.id] ?? null,
      atWar: wars.some((w) => (w.front ?? []).includes(n.id)),
      ...(layout.nodes[n.id] ?? { x: 0, y: 0 }),
    }));

  const continents = Object.values(geo.nodes)
    .filter((n) => n.kind === 'continent')
    .map((n) => ({
      id: n.id, name: n.name, discovered: n.discovered === true,
      provinces: provinces.filter((p) => p.continent === n.id).map((p) => p.id),
      ...(layout.nodes[n.id] ?? { x: 0, y: 0 }),
    }));

  const placed = new Set(provinces.map((p) => p.id));
  const links = (geo.edges ?? [])
    .filter((e) => placed.has(e.from) && placed.has(e.to))
    .map((e) => ({
      from: e.from, to: e.to, kind: e.kind ?? 'road', days: e.days ?? 1,
      discovered: e.discovered === true,
      a: layout.nodes[e.from], b: layout.nodes[e.to],
    }));

  const powers = factions.map((f) => ({
    id: f.id,
    name: f.name,
    archetype: f.archetype ?? null,
    territory: (f.territory ?? []).filter((pid) => placed.has(pid)),
    allies: f.allies ?? [],
    enemies: f.enemies ?? [],
    leader: npcs.find((n) => n.leads === f.id) ?? null,
    wars: wars.filter((w) => (w.between ?? []).includes(f.id)).map((w) => w.id),
  }));

  // The dynasty view: a crown, the power that sits behind it, and the
  // person who wears it. Three tables' worth of ids, resolved once.
  const dynasties = crowns.map((c) => {
    const sovereign = (c.factionRelations ?? []).find((r) => r.stance === 'sovereign') ?? null;
    const faction = sovereign ? factions.find((f) => f.id === sovereign.factionId) ?? null : null;
    return {
      id: c.id,
      house: c.name,
      title: c.title ?? null,
      legitimacy: c.legitimacy ?? null,
      province: c.id.replace(/\.crown$/, ''),
      faction: faction ? { id: faction.id, name: faction.name } : null,
      ruler: npcs.find((n) => n.seatOf === c.id) ?? null,
      vassals: (c.factionRelations ?? []).filter((r) => r.stance !== 'sovereign'),
    };
  });

  return Object.freeze({
    edition,
    map: Object.freeze({ continents, provinces, links, bounds: layout.bounds, cell: layout.cell }),
    powers: Object.freeze(powers),
    wars: Object.freeze(wars.map((w) => ({
      ...w,
      sides: (w.between ?? []).map((id) => factions.find((f) => f.id === id)?.name ?? id),
    }))),
    dynasties: Object.freeze(dynasties),
    meta: Object.freeze({
      seed: world.seed ?? null,
      settingId: world.settingId ?? null,
      revision: world.revision ?? null,
      counts: {
        continents: continents.length,
        provinces: provinces.length,
        powers: powers.length,
        wars: wars.length,
        dynasties: dynasties.length,
      },
    }),
  });
}

/**
 * Read a baked cartridge.
 *
 *   edition 'gm'     — the spoiler cut: everything, as authored.
 *   edition 'player' — only what has been discovered. Undiscovered nodes
 *                      and the edges touching them are REMOVED, and
 *                      powers narrow to those holding known ground.
 *
 * `ledger` (optional) folds a campaign's world patches first, so the map
 * shows what this table changed, not just what was baked.
 */
export function fromCartridge(cartridge, { edition = 'gm', ledger = null, fold = null } = {}) {
  const data = cartridge?.data ?? cartridge ?? {};
  let geo = data.geo ?? { nodes: {}, edges: [] };
  if (ledger?.length && typeof fold === 'function') geo = fold(geo, ledger) ?? geo;

  const world = {
    seed: data.seed ?? null,
    settingId: data.settingId ?? null,
    geo,
    factions: data.factions ?? [],
    npcs: data.npcs ?? [],
    warState: data.warState ?? null,
    lore: data.lore ?? {},
    edition,
  };
  return edition === 'player' ? playerCut(world) : world;
}

/** Accept the MCP `world_atlas` payload (already player-scoped server-side). */
export function fromAtlasPayload(payload = {}) {
  return {
    seed: payload.seed ?? null,
    settingId: payload.settingId ?? null,
    revision: payload.revision ?? null,
    geo: payload.geo ?? { nodes: {}, edges: [] },
    factions: payload.factions ?? [],
    npcs: payload.npcs ?? [],
    warState: payload.warState ?? null,
    lore: payload.lore ?? {},
    edition: payload.edition === 'gm' ? 'gm' : 'player',
  };
}

/**
 * Narrow a world to what a table has actually seen. Deliberately a
 * DELETION, not a dimming: an undiscovered province is absent from the
 * data the view receives, so no amount of clever CSS reveals it.
 */
export function playerCut(world) {
  const geo = world.geo ?? { nodes: {}, edges: [] };
  const known = Object.fromEntries(
    Object.entries(geo.nodes ?? {}).filter(([, n]) => isKnown(n) || n.kind === 'continent'));
  // A continent survives only if the party has set foot on some of it.
  for (const [id, n] of Object.entries(known)) {
    if (n.kind !== 'continent') continue;
    const anyKnown = Object.values(geo.nodes).some((c) => c.parent === id && isKnown(c));
    if (!anyKnown) delete known[id];
  }
  const edges = (geo.edges ?? []).filter((e) => known[e.from] && known[e.to] && isKnown(e));
  const provinceIds = new Set(Object.keys(known));

  const factions = (world.factions ?? []).filter(
    (f) => (f.territory ?? []).some((pid) => provinceIds.has(pid)));
  const factionIds = new Set(factions.map((f) => f.id));

  return {
    ...world,
    edition: 'player',
    // How many landmasses the world HAS, so the fogged map keeps its
    // geometry as new coasts appear. A count, never a name.
    worldShape: { continents: Object.values(geo.nodes ?? {}).filter((n) => n.kind === 'continent').length },
    geo: { ...geo, nodes: known, edges },
    factions: factions.map(({ gm, ...f }) => f),
    npcs: (world.npcs ?? []).filter((n) => factionIds.has(n.leads)).map(({ gm, ...n }) => n),
    warState: world.warState
      ? { ...world.warState,
          wars: (world.warState.wars ?? []).filter(
            (w) => (w.between ?? []).some((id) => factionIds.has(id))) }
      : null,
    lore: {
      ...world.lore,
      crowns: (world.lore?.crowns ?? [])
        .filter((c) => provinceIds.has(c.id.replace(/\.crown$/, '')))
        .map(({ stanceOnThreat, ...c }) => c),
      legends: (world.lore?.legends ?? [])
        .filter((l) => (l.sites ?? []).some((s) => provinceIds.has(s)))
        .map(({ kernelOfTruth, payoff, ...l }) => l),
    },
  };
}

/**
 * Group crowns under the power that claims them, for the dynasty view.
 * Unclaimed crowns get their own trailing group rather than vanishing;
 * powers come first, biggest first, so the page reads top-down.
 *
 *   → [{ faction: {id,name}|null, archetype, crowns: [...] }]
 */
export function groupDynasties(dynasties = [], powers = []) {
  const groups = new Map();
  for (const d of dynasties) {
    const key = d.faction?.id ?? '';
    if (!groups.has(key)) {
      groups.set(key, {
        faction: d.faction ?? null,
        archetype: powers.find((p) => p.id === d.faction?.id)?.archetype ?? null,
        crowns: [],
      });
    }
    groups.get(key).crowns.push(d);
  }
  return [...groups.values()].sort(
    (a, b) => (a.faction ? 0 : 1) - (b.faction ? 0 : 1) || b.crowns.length - a.crowns.length);
}

/**
 * The relation chords the power graph draws: one entry per PAIR, never
 * two (an enmity is recorded on both sides, and drawing it twice doubles
 * every stroke's opacity).
 *
 *   → [{ from, to, kind: 'ally'|'enemy' }]
 */
export function relationEdges(powers = []) {
  const known = new Set(powers.map((p) => p.id));
  const seen = new Set();
  const out = [];
  for (const p of powers) {
    for (const [kind, ids] of [['ally', p.allies], ['enemy', p.enemies]]) {
      for (const other of ids ?? []) {
        if (!known.has(other) || other === p.id) continue;
        const key = [p.id, other].sort().join('|') + `|${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from: p.id, to: other, kind });
      }
    }
  }
  return out;
}

/**
 * Normalise a settlement layout or a dungeon into one drawable shape.
 * Both are grid-placed graphs — the same `placeOnGrid` walk underneath —
 * so one view draws either:
 *
 *   localViewModel({ plots })  → a settlement (plot.pos, role, building)
 *   localViewModel({ rooms })  → a dungeon    (room.pos, exits, loot, npcs)
 *
 *   → { kind, cells: [{ id, x, y, label, role, tags, locked }], links, bounds }
 */
export function localViewModel(local = {}, { npcs = null, cell = ATLAS_CELL } = {}) {
  const isDungeon = !!local.rooms;
  const source = isDungeon ? Object.values(local.rooms) : (local.plots ?? []);
  const occupants = npcs ?? local.npcs ?? {};
  const byRoom = {};
  for (const n of Object.values(occupants)) {
    if (!n?.roomId) continue;
    (byRoom[n.roomId] ??= []).push(n);
  }

  const cells = source.filter((c) => c?.pos).map((c) => {
    const here = byRoom[c.id] ?? [];
    return {
      id: c.id,
      x: c.pos.col * cell,
      y: c.pos.row * cell,
      // A settlement plot is named by what stands on it; a dungeon room
      // by what it is. Either way the label is what a player would say.
      label: isDungeon ? (c.name ?? c.id) : (c.building?.name ?? c.building?.type ?? ''),
      role: isDungeon
        ? (c.id === local.currentRoom ? 'entrance' : c.id === local.exitRoomId ? 'vault' : 'room')
        : (c.role ?? 'plot'),
      tags: [
        ...(here.some((n) => n.isBoss) ? ['boss'] : []),
        ...(here.length && !here.some((n) => n.isBoss) ? ['foes'] : []),
        ...((c.loot ?? []).length ? ['loot'] : []),
        ...((c.stalls ?? []).length ? ['stalls'] : []),
      ],
      occupants: here.length,
    };
  });

  const at = new Map(cells.map((c) => [c.id, c]));
  const links = [];
  const seen = new Set();
  for (const c of source) {
    for (const exit of c.exits ?? []) {
      const target = exit.roomId ?? exit.plotId;
      if (!at.has(c.id) || !at.has(target)) continue;
      const key = [c.id, target].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ from: c.id, to: target, locked: exit.locked === true,
                   a: at.get(c.id), b: at.get(target) });
    }
  }

  const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
  const pad = cell;
  const bounds = xs.length
    ? { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad,
        minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad }
    : { minX: -1, maxX: 1, minY: -1, maxY: 1 };

  return Object.freeze({
    kind: isDungeon ? 'dungeon' : 'settlement',
    cells: Object.freeze(cells), links: Object.freeze(links), bounds, cell,
  });
}
