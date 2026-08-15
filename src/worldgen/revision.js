// src/worldgen/revision.js — entity-id ⇄ cell addressing over a cartridge,
// and the REVISION format built on it.
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
import { fold, pathsConflict } from '../ledger/patch.js';
import { isUnder } from '../ledger/ids.js';
import { loadEnvelope, digest } from '../persistence/envelope.js';

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

// ─── The revision artifact ───────────────────────────────────────────────────
//
// Like a game cartridge, a baked world accepts REVISIONS: the base file is
// never opened for writing, never re-digested — a revision is a separate
// artifact carrying an ordered ledger of ordinary patches in the cell
// addressing above, plus a record of exactly which resolved content it was
// authored against. A campaign pins the revision it began on and never moves;
// a new campaign defaults to latest. Two consequences drive the design:
//
//   • REVISION_VERSION is its own envelope version, entirely separate from
//     CARTRIDGE_VERSION — the two formats evolve independently.
//   • Resolution REFUSES on base mismatch, deliberately diverging from
//     envelope.js (which reports checksum-mismatch and mounts anyway): if
//     r2's recorded base digest does not match the recomputed digest of r1,
//     r2's edits were authored against content that is no longer there.
//     Refusing r2 and everything above it keeps serving r1 — a stale-but-
//     coherent world beats a fresh-but-scrambled one. The FNV-1a/32 digest
//     is an identity label and consistency tripwire, never an integrity
//     gate — authorize nothing on it.

export const REVISION_VERSION = 1;
export const REVISION_MIGRATIONS = Object.freeze({});

// The legal cell vocabulary — v1 already includes the four collections the
// cartridge v2 format materializes, so the first faction/npc/war revision
// needs no format bump.
export const REVISION_CELLS = Object.freeze([
  'node', 'outline', 'slice', 'legend', 'crown', 'era', 'settingId',
  'faction', 'npc', 'warState', 'route',
]);

// The digest a revision chain resolves to: same function, same serialization
// as the bake (`c = digest(JSON.stringify(data))`), run on PRISTINE data —
// never on mountCartridge's flattened view, which adds digest/v/beginSession.
// By construction resolvedDigest(revision 0) === cartridge.c, so the base
// needs no special case anywhere.
export function resolvedDigest(data) {
  return digest(JSON.stringify(data));
}

/**
 * Author a revision artifact: `{ v, data, c }`, like a cartridge but its own
 * format. Every patch must speak the cell vocabulary — an unknown cell is
 * refused HERE, at authoring time, with the legal list in the error, because
 * a bad revision on a shelf poisons every table that mounts it.
 *
 * `base` records what the ledger was authored against: the revision number
 * below this one and that content's resolved digest.
 */
export function makeRevision({ worldId, revision, base, ledger, notes = null, now = null }) {
  if (!worldId || typeof worldId !== 'string') throw new Error('a revision needs its worldId');
  if (!Number.isInteger(revision) || revision < 1) throw new Error('revision must be an integer >= 1');
  if (!Number.isInteger(base?.revision) || typeof base?.digest !== 'string') {
    throw new Error('a revision records its base: { revision, digest }');
  }
  if (base.revision !== revision - 1) {
    throw new Error(`revision ${revision} must stack on base ${revision - 1}, not ${base.revision}`);
  }
  if (!Array.isArray(ledger) || !ledger.length) throw new Error('a revision carries a non-empty patch ledger');
  for (const p of ledger) {
    const cell = String(p?.path ?? '').split('.')[0];
    if (!REVISION_CELLS.includes(cell)) {
      throw new Error(`patch on '${p?.target}' names unknown cell '${cell}' — legal cells: ${REVISION_CELLS.join(', ')}`);
    }
    if (typeof p?.target !== 'string' || !p.target) throw new Error('every revision patch targets an entity id');
  }
  const data = {
    worldId, revision,
    base: { revision: base.revision, digest: base.digest },
    ledger, notes,
    publishedAt: now,
  };
  return { v: REVISION_VERSION, data, c: digest(JSON.stringify(data)) };
}

/**
 * Parse + validate one revision artifact. Returns its `data` or null (with
 * `onError(code, detail)`). Structural refusals use 'revision-invalid'; the
 * envelope layer's own codes (parse-failed, future-version, …) pass through.
 */
export function mountRevision(raw, { onError } = {}) {
  const data = loadEnvelope(raw, {
    migrations: REVISION_MIGRATIONS, currentVersion: REVISION_VERSION, onError,
  });
  if (data == null) return null;
  const bad = (detail) => { onError?.('revision-invalid', detail); return null; };
  if (typeof data.worldId !== 'string' || !data.worldId) return bad('missing worldId');
  if (!Number.isInteger(data.revision) || data.revision < 1) return bad(`bad revision number ${data.revision}`);
  if (!Number.isInteger(data.base?.revision) || typeof data.base?.digest !== 'string') return bad('missing base record');
  if (!Array.isArray(data.ledger) || !data.ledger.length) return bad('empty ledger');
  return data;
}

// Re-derive the continent/province index from the tree itself. The baked
// arrays are exactly the geo's continent/province ids in insertion order, so
// deriving them after an apply makes geo/array divergence impossible — a
// revision adding a province never has to remember to patch two places.
function reindex(data) {
  const nodes = data.geo?.nodes ?? {};
  const ids = Object.keys(nodes);
  return {
    ...data,
    continents: ids.filter(id => nodes[id].kind === 'continent'),
    provinces: ids.filter(id => nodes[id].kind === 'province'),
  };
}

/**
 * Apply one revision ledger to pristine cartridge data: fold per target over
 * its cells, project the answer back, re-derive the geo index. Uses fold()
 * in a loop — never compact(), whose reserved bookkeeping key would leak
 * into the projected data and change the resolved digest for nothing. Pure;
 * resolving the same chain twice is byte-identical.
 */
export function applyRevision(data, ledger) {
  let out = data;
  for (const target of new Set((ledger ?? []).map(p => p.target))) {
    out = projectCells(out, target, fold(cellsOf(out, target), ledger, target));
  }
  return reindex(out);
}

/**
 * Resolve a whole chain: apply each revision in order, verifying that its
 * recorded base digest matches the content it is about to change. The first
 * mismatch (or numbering gap) refuses THAT revision and everything above it
 * — the world keeps serving the last coherent resolution. Returns
 * `{ data, applied }`; report goes to `onError('revision-base-mismatch' |
 * 'revision-gap', detail)`.
 */
export function applyRevisions(data, revisions, { onError } = {}) {
  const chain = [...(revisions ?? [])].sort((a, b) => a.revision - b.revision);
  let out = data;
  let at = 0;
  const applied = [];
  for (const rev of chain) {
    if (rev.revision !== at + 1) {
      onError?.('revision-gap', `expected revision ${at + 1}, found ${rev.revision} — it and everything above it are not applied`);
      break;
    }
    const have = resolvedDigest(out);
    if (rev.base.digest !== have) {
      onError?.('revision-base-mismatch',
        `revision ${rev.revision} was authored against ${rev.base.digest}, but revision ${at} resolves to ${have} — it and everything above it are not applied`);
      break;
    }
    out = applyRevision(out, rev.ledger);
    at = rev.revision;
    applied.push(rev.revision);
  }
  return { data: out, applied };
}

/**
 * Sort a revision's patches into adds and edits against a given resolution:
 * a patch whose named cell already exists for its target is an EDIT (it
 * changes something a table may have seen); a patch writing a cell the
 * content never had is an ADD (hydrating a province the bake left empty
 * contradicts nobody). The split is per-resolution — a node added in r1 is
 * an add for a campaign pinned at r0 and an edit for one at r1.
 */
export function classifyRevision(data, ledger) {
  const adds = [], edits = [];
  for (const p of ledger ?? []) {
    const cell = String(p.path ?? '').split('.')[0];
    (cellsOf(data, p.target)[cell] !== undefined ? edits : adds).push(p);
  }
  return { adds, edits };
}

/**
 * Which edits collide with what a campaign has observed. `observations` maps
 * entity id → '*' (the whole entity was seen) or a list of observed paths.
 * The containment test runs BOTH ways — observing a province blocks edits to
 * its regions, and observing a region blocks an edit that replaces the whole
 * province — and path conflicts are prefix-aware in both directions too.
 * Adds are never passed in here; classify first.
 */
export function revisionConflicts(edits, observations) {
  const out = [];
  for (const p of edits ?? []) {
    for (const [observed, paths] of Object.entries(observations ?? {})) {
      if (!isUnder(p.target, observed) && !isUnder(observed, p.target)) continue;
      if (paths === '*' || (Array.isArray(paths) && paths.some(q => pathsConflict(p.path, q)))) {
        out.push({ target: p.target, path: p.path, blockedBy: observed });
        break;
      }
    }
  }
  return out;
}
