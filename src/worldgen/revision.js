// src/worldgen/revision.js — entity-id ⇄ cell addressing over a cartridge.
//
// A cartridge's `data` is a handful of collections (geo nodes, outlines,
// slices, lore, and the v2 content collections), each keyed or id-tagged in
// its own way. Everything that wants to talk about "one thing in the world" —
// a session replay folding patches over the base, a future revision editing a
// province, a conflict check asking "was this observed" — needs one uniform
// answer to the question *what does the cartridge say about entity X?*
//
// That answer is a CELLS object: the slots the cartridge holds for one entity
// id, keyed by cell name.
//
//   cellsOf(data, 'continent-0.province-1')
//     → { node: {…}, slice: {…}, outline: {…} }          // only what exists
//   cellsOf(data, 'continent-0.legend-0')
//     → { legend: {…} }
//   cellsOf(data, 'world')
//     → { slice: {…}, settingId: null, warState: null }
//
// Why paths can't do this job: patch paths are dot-split, and geo node ids
// contain dots ('continent-0.province-1'), so 'geo.nodes.continent-0…' would
// shatter at the first split. The patch `target` carries the entity id whole;
// the patch `path`'s FIRST segment names the cell. This module is the mapping
// between that addressing and the cartridge's actual layout — the same
// addressing hydrateNode already emits, so play patches and (future) revision
// patches speak one language.
//
// Everything here is pure and total: unknown ids yield {} / no-ops, absent
// cells are OMITTED (never `cell: undefined` — JSON round-trips would drop
// the key and a digest would change), and projectCells(data, id,
// cellsOf(data, id)) is the identity, byte for byte.

// The array-backed collections in one table: cell name → read the array out
// of `data`, write a replacement array back (immutably). Legends, crowns and
// eras live under lore; the v2 content collections are top-level. Every entry
// is an array of records carrying their own `id` — that shared shape is what
// lets one pair of helpers serve all six.
const ARRAY_CELLS = Object.freeze({
  legend:  { get: (d) => d.lore?.legends, set: (d, a) => ({ ...d, lore: { ...d.lore, legends: a } }) },
  crown:   { get: (d) => d.lore?.crowns,  set: (d, a) => ({ ...d, lore: { ...d.lore, crowns: a } }) },
  era:     { get: (d) => d.lore?.eras,    set: (d, a) => ({ ...d, lore: { ...d.lore, eras: a } }) },
  faction: { get: (d) => d.factions,      set: (d, a) => ({ ...d, factions: a }) },
  npc:     { get: (d) => d.npcs,          set: (d, a) => ({ ...d, npcs: a }) },
  route:   { get: (d) => d.routes,        set: (d, a) => ({ ...d, routes: a }) },
});

// World-scoped scalar cells: they have no id of their own, so they hang off
// the entity id 'world' — which is also the key slices already uses for the
// world blueprint, keeping "the world as an entity" one id, not two.
const WORLD_ID = 'world';

/**
 * Every cell the cartridge holds for `entityId`, keyed by cell name. Absent
 * cells are omitted; an unknown id yields `{}`. Null is a value, not an
 * absence — `warState: null` and `settingId: null` are real answers ("no war
 * yet", "the library's own tables") and are included for the world id.
 */
export function cellsOf(data, entityId) {
  const out = {};
  if (!data || typeof entityId !== 'string' || entityId === '') return out;

  const node = data.geo?.nodes?.[entityId];
  if (node !== undefined) out.node = node;
  const outline = data.outlines?.[entityId];
  if (outline !== undefined) out.outline = outline;
  const slice = data.slices?.[entityId];
  if (slice !== undefined) out.slice = slice;

  for (const [cell, { get }] of Object.entries(ARRAY_CELLS)) {
    const hit = (get(data) ?? []).find((r) => r?.id === entityId);
    if (hit !== undefined) out[cell] = hit;
  }

  if (entityId === WORLD_ID) {
    if ('settingId' in data) out.settingId = data.settingId;
    if ('warState' in data) out.warState = data.warState;
  }
  return out;
}

/**
 * Every entity id the cartridge can answer for: geo nodes, outlined and
 * sliced ids, every id-tagged record in the array collections, and 'world'.
 * The Set is the domain of cellsOf — an id outside it folds from nothing.
 */
export function entityIdsOf(data) {
  const ids = new Set();
  if (!data) return ids;
  for (const id of Object.keys(data.geo?.nodes ?? {})) ids.add(id);
  for (const id of Object.keys(data.outlines ?? {})) ids.add(id);
  for (const id of Object.keys(data.slices ?? {})) ids.add(id);
  for (const { get } of Object.values(ARRAY_CELLS)) {
    for (const r of get(data) ?? []) if (typeof r?.id === 'string') ids.add(r.id);
  }
  ids.add(WORLD_ID);
  return ids;
}

// Replace the record with `entityId` in an array (in place, order preserved),
// or append it — an unknown id is an ADD, which is exactly what a revision
// introducing a new legend or faction needs.
function upsert(array, entityId, record) {
  const i = (array ?? []).findIndex((r) => r?.id === entityId);
  if (i === -1) return [...(array ?? []), record];
  const next = array.slice();
  next[i] = record;
  return next;
}

/**
 * Write a CELLS object back into `data` for one entity, immutably. Only the
 * cells present in `cells` are touched; containers along the way are copied,
 * everything else is shared. New ids append to their collection (array cells)
 * or their map (node/outline/slice), so the same call expresses both an edit
 * and an add. Round-trip identity holds: projecting cellsOf's own answer
 * changes nothing, byte for byte.
 */
export function projectCells(data, entityId, cells) {
  if (!data || typeof entityId !== 'string' || entityId === '' || !cells) return data;
  let out = data;

  if ('node' in cells) {
    out = { ...out, geo: { ...out.geo, nodes: { ...out.geo?.nodes, [entityId]: cells.node } } };
  }
  if ('outline' in cells) {
    out = { ...out, outlines: { ...out.outlines, [entityId]: cells.outline } };
  }
  if ('slice' in cells) {
    out = { ...out, slices: { ...out.slices, [entityId]: cells.slice } };
  }

  for (const [cell, { get, set }] of Object.entries(ARRAY_CELLS)) {
    if (cell in cells) out = set(out, upsert(get(out), entityId, cells[cell]));
  }

  if (entityId === WORLD_ID) {
    if ('settingId' in cells) out = { ...out, settingId: cells.settingId };
    if ('warState' in cells) out = { ...out, warState: cells.warState };
  }
  return out;
}
