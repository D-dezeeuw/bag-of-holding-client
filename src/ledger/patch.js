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

export function makePatch({ turn, chapter = null, target, scope = 'local', kind = 'canon', path, from = null, to, because = null, source = null }) {
  if (!target)                     throw new Error('patch requires a target entity id');
  if (!path)                       throw new Error('patch requires a field path');
  if (!SCOPES.includes(scope))     throw new Error(`unknown patch scope '${scope}'`);
  if (!KINDS.includes(kind))       throw new Error(`unknown patch kind '${kind}'`);
  if (!Number.isFinite(turn))      throw new Error('patch requires a numeric turn');
  return { turn, chapter, target, scope, kind, path, from, to, because, source };
}

// ─── Folding ─────────────────────────────────────────────────────────────────

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  const out   = { ...obj };
  let cursor  = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    cursor[k] = (cursor[k] && typeof cursor[k] === 'object') ? { ...cursor[k] } : {};
    cursor = cursor[k];
  }
  cursor[parts[parts.length - 1]] = value;
  return out;
}

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Current state of one entity: its base record with every patch applied in
// order. Later patches win; a mechanical patch is never overwritten by a canon
// patch that came after it (the gate in appendPatch prevents that pairing from
// being recorded at all, but folding stays defensive so a hand-edited or
// migrated ledger cannot corrupt ground truth).
export function fold(base, patches, target) {
  let out = base ?? {};
  const mechanicalPaths = new Set();
  for (const p of patches) {
    if (p.target !== target) continue;
    if (p.kind === 'canon' && mechanicalPaths.has(p.path)) continue;
    if (p.kind === 'mechanical') mechanicalPaths.add(p.path);
    out = setPath(out, p.path, p.to);
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
// mechanical fact on the same field. The narrator saying "the goblin flees,
// unharmed" cannot un-wound a goblin the dice already hurt.
//
// Returns { ok: true, ledger } or { ok: false, reason, conflict } — callers
// count rejections, because a high rate means the narrator prompt is drifting.
export function appendPatch(ledger, patch) {
  if (patch.kind === 'canon') {
    const conflict = [...ledger].reverse().find(p =>
      p.kind === 'mechanical' && p.target === patch.target && p.path === patch.path);
    if (conflict && conflict.to !== patch.to) {
      return { ok: false, reason: 'canon contradicts mechanical state', conflict };
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

// Fold old local-scope patches into per-entity base snapshots so an 80-hour
// ledger stays bounded. Deterministic: the same ledger compacts to the same
// result, and folding the compacted world equals folding the original.
// Regional and world patches are kept — they are the campaign's history.
export function compact(bases, ledger, { beforeTurn, keepScopes = ['regional', 'world'] } = {}) {
  const keep = new Set(keepScopes);
  const stale = ledger.filter(p => p.turn < beforeTurn && !keep.has(p.scope));
  if (!stale.length) return { bases: { ...bases }, ledger: [...ledger], foldedCount: 0 };

  const nextBases = { ...bases };
  for (const target of new Set(stale.map(p => p.target))) {
    // Fold the stale patches only; anything kept still applies on top later.
    nextBases[target] = fold(nextBases[target], stale, target);
  }
  const staleSet = new Set(stale);
  return {
    bases:  nextBases,
    ledger: ledger.filter(p => !staleSet.has(p)),
    foldedCount: stale.length,
  };
}
