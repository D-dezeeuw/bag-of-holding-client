// src/ledger/patch.js — the world's memory: an append-only patch ledger.
//
// The world is `base ⊕ fold(patches)`. Base is what generation produced (seeded
// structure plus the LLM prose that hydrated it, persisted once). Every change
// after that is a patch: who changed, what field, from what to what, on which
// turn, and why.
//
// This exists because nothing the Game Master said was ever remembered. Prose
// went into the transcript, scrolled out of the narrator's short window, and was
// gone — so the GM contradicted itself, and details it invented (the mold on the
// castle curtains, the ghoul in the inn's privy) could never be revisited. A
// ledger makes them first-class: addressable, queryable at any altitude, and
// replayable.
//
// Two producers, one ledger:
//   • MECHANICAL patches come from the rules engine via the host's resolver —
//     hit points, deaths, loot, doors. These are ground truth.
//   • CANON patches come from extracting claims out of narration. These are
//     colour, and they lose to mechanical facts on conflict.
//
// Everything here is pure. The host owns storage and the LLM calls.

import { isUnder } from './ids.js';

export const SCOPES = Object.freeze(['local', 'regional', 'world']);
export const KINDS  = Object.freeze(['mechanical', 'canon']);

const SCOPE_RANK = { local: 0, regional: 1, world: 2 };

// Path segments that would write into the prototype chain instead of the
// record, or that split() produces from a malformed path. Patch paths come
// from LLM extraction, so they are input, not code.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function validatePath(path) {
  const parts = String(path).split('.');
  for (const k of parts) {
    if (!k) throw new Error(`invalid patch path '${path}': empty segment`);
    if (FORBIDDEN_SEGMENTS.has(k)) throw new Error(`invalid patch path '${path}': forbidden segment '${k}'`);
  }
  return parts;
}

export function makePatch({ turn, chapter = null, target, scope = 'local', kind = 'canon', path, from = null, to, because = null, source = null }) {
  if (!target)                     throw new Error('patch requires a target entity id');
  if (!path)                       throw new Error('patch requires a field path');
  validatePath(path);
  if (!SCOPES.includes(scope))     throw new Error(`unknown patch scope '${scope}'`);
  if (!KINDS.includes(kind))       throw new Error(`unknown patch kind '${kind}'`);
  if (!Number.isFinite(turn))      throw new Error('patch requires a numeric turn');
  return { turn, chapter, target, scope, kind, path, from, to, because, source };
}

// Two field paths conflict when they are the same field or one contains the
// other: a write to `stats` replaces everything under `stats.hp`, and a write
// to `stats.hp.current` reaches inside `stats.hp`. Exact-string comparison —
// what this module used before — let canon overwrite dice facts by aiming one
// level up or down.
export function pathsConflict(a, b) {
  return a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
}

// ─── Folding ─────────────────────────────────────────────────────────────────

function setPath(obj, path, value) {
  const parts = validatePath(path);
  // Arrays stay arrays: `{ ...['a','b'] }` silently turns an inventory list
  // into `{ '0': 'a', '1': 'b' }`, which is how a patch through an index used
  // to destroy the list it was editing.
  const copy = (v) => (Array.isArray(v) ? [...v] : (v && typeof v === 'object') ? { ...v } : {});
  const out  = copy(obj);
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    cursor[k] = copy(cursor[k]);
    cursor = cursor[k];
  }
  cursor[parts[parts.length - 1]] = value;
  return out;
}

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// The paths on a base record that compaction marked as mechanically owned
// (see `compact`). Stored under a reserved key so the protection survives the
// patches themselves being folded away; stripped from folded views.
const MECH_KEY = '__mech';

export function mechanicalPathsOf(base) {
  return Array.isArray(base?.[MECH_KEY]) ? base[MECH_KEY] : [];
}

// Current state of one entity: its base record with every patch applied in
// order. Later patches win; a mechanical patch is never overwritten by a canon
// patch that came after it (the gate in appendPatch prevents that pairing from
// being recorded at all, but folding stays defensive so a hand-edited or
// migrated ledger cannot corrupt ground truth). Both defenses are prefix-aware,
// and both honour mechanical ownership that compaction folded into the base.
// Patches marked `folded: true` are already inside the base and are skipped —
// they stay in the ledger as history, not as pending writes.
export function fold(base, patches, target) {
  const mechanicalPaths = new Set(mechanicalPathsOf(base));
  const conflictsMechanical = (path) => {
    for (const m of mechanicalPaths) if (pathsConflict(m, path)) return true;
    return false;
  };
  let out = base ?? {};
  for (const p of patches) {
    if (p.target !== target) continue;
    if (p.folded === true) continue;
    if (p.kind === 'canon' && conflictsMechanical(p.path)) continue;
    if (p.kind === 'mechanical') mechanicalPaths.add(p.path);
    out = setPath(out, p.path, p.to);
  }
  if (out && typeof out === 'object' && MECH_KEY in out) {
    const { [MECH_KEY]: _mech, ...view } = out;
    return view;
  }
  return out;
}

// Fold every entity under a prefix: { [entityId]: foldedRecord }.
// `bases` maps entity id → base record; entities that exist only in the ledger
// (minted mid-play — an invented NPC, a noticed detail) fold from {}.
export function foldAll(bases, patches, prefix) {
  const ids = new Set();
  for (const id of Object.keys(bases ?? {})) if (isUnder(id, prefix)) ids.add(id);
  for (const p of patches)                   if (isUnder(p.target, prefix)) ids.add(p.target);
  const out = {};
  for (const id of ids) out[id] = fold(bases?.[id], patches, id);
  return out;
}

// ─── Appending ───────────────────────────────────────────────────────────────

// Append with the precedence rule enforced: a canon patch may not contradict a
// mechanical fact on the same field — or on a field that CONTAINS or IS INSIDE
// it. The narrator saying "the goblin flees, unharmed" cannot un-wound a goblin
// the dice already hurt, and writing to the goblin's whole `stats` object is
// not a loophole for the same lie one level up.
//
// `bases` is optional: when the caller passes the per-entity base snapshots,
// mechanical ownership that compaction folded into a base keeps protecting the
// path even though the original patches are gone from the ledger.
//
// Returns { ok: true, ledger } or { ok: false, reason, conflict } — callers
// count rejections, because a high rate means the narrator prompt is drifting.
export function appendPatch(ledger, patch, bases = null) {
  if (patch.kind === 'canon') {
    const conflict = [...ledger].reverse().find(p =>
      p.kind === 'mechanical' && p.target === patch.target && pathsConflict(p.path, patch.path));
    // Same field re-asserting the same value is redundancy, not contradiction;
    // different fields (parent/child) have incomparable values — always reject.
    if (conflict && (conflict.path !== patch.path || conflict.to !== patch.to)) {
      return { ok: false, reason: 'canon contradicts mechanical state', conflict };
    }
    const baseMech = mechanicalPathsOf(bases?.[patch.target]);
    const owned = baseMech.find(m => pathsConflict(m, patch.path));
    if (owned) {
      return { ok: false, reason: 'canon contradicts compacted mechanical state', conflict: { path: owned } };
    }
  }
  return { ok: true, ledger: [...ledger, patch] };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

// Everything recorded about one entity, oldest first — the raw material for
// "what do we know about Mara?" without any LLM involvement.
export function historyOf(ledger, target) {
  return ledger.filter(p => p.target === target);
}

// Digests are rendered views, so a patch invalidates every digest at or above
// its scope. Returns the entity ids whose digests need re-rendering.
export function dirtyTargets(patches, { minScope = 'regional' } = {}) {
  const floor = SCOPE_RANK[minScope] ?? 1;
  const out = new Set();
  for (const p of patches) {
    if ((SCOPE_RANK[p.scope] ?? 0) < floor) continue;
    out.add(p.target);
    // Walk up: a regional fact also changes the region's own digest.
    let id = p.target;
    while (id.includes('.')) {
      id = id.split('.').slice(0, -2).join('.');
      if (id) out.add(id);
    }
  }
  return [...out];
}

// Recent notable events as one-line causes, newest first — the cheap narrative
// memory the GM gets every turn without paying for a summarizer call.
export function recentCauses(ledger, { limit = 8, minScope = 'local', sinceTurn = 0 } = {}) {
  const floor = SCOPE_RANK[minScope] ?? 0;
  const out = [];
  for (let i = ledger.length - 1; i >= 0 && out.length < limit; i--) {
    const p = ledger[i];
    if (!p.because || p.turn < sinceTurn) continue;
    if ((SCOPE_RANK[p.scope] ?? 0) < floor) continue;
    out.push({ turn: p.turn, target: p.target, because: p.because });
  }
  return out;
}

// ─── Compaction ──────────────────────────────────────────────────────────────

// Fold old patches into per-entity base snapshots so an 80-hour ledger stays
// bounded. Deterministic: the same ledger compacts to the same result, and
// folding the compacted world equals folding the original — for real, which
// takes three properties the previous implementation lacked:
//
//   1. The ENTIRE chronological prefix (every patch with turn < beforeTurn,
//      any scope) folds into base, so nothing that originally applied before
//      a kept patch ends up re-applying after it. (Folding only the local
//      ones reordered history: a kept regional patch that predated a folded
//      local one suddenly applied on top of it, and the fold changed.)
//   2. Regional and world patches from that prefix STAY in the ledger — they
//      are the campaign's history, and `recentCauses`/`historyOf` still cite
//      them — but marked `folded: true`, so `fold` never applies them twice.
//      Local patches, pure detail, are dropped.
//   3. Mechanical ownership survives the fold: the folded prefix's mechanical
//      paths are recorded on the base (see `mechanicalPathsOf`), so a canon
//      patch appended AFTER compaction still cannot overwrite what the dice
//      decided before it.
export function compact(bases, ledger, { beforeTurn, keepScopes = ['regional', 'world'] } = {}) {
  const keep = new Set(keepScopes);
  const prefix = ledger.filter(p => p.turn < beforeTurn && p.folded !== true);
  if (!prefix.length) return { bases: { ...bases }, ledger: [...ledger], foldedCount: 0 };

  const nextBases = { ...bases };
  for (const target of new Set(prefix.map(p => p.target))) {
    const folded = fold(nextBases[target], prefix, target);
    const mech = new Set(mechanicalPathsOf(nextBases[target]));
    for (const p of prefix) {
      if (p.target === target && p.kind === 'mechanical') mech.add(p.path);
    }
    nextBases[target] = mech.size ? { ...folded, __mech: [...mech].sort() } : folded;
  }

  const prefixSet = new Set(prefix);
  const nextLedger = [];
  for (const p of ledger) {
    if (!prefixSet.has(p)) { nextLedger.push(p); continue; }
    if (keep.has(p.scope)) nextLedger.push({ ...p, folded: true });
    // local prefix patches are folded in and dropped.
  }
  return {
    bases:  nextBases,
    ledger: nextLedger,
    foldedCount: prefix.length,
  };
}
