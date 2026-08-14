// src/persistence/idb.js — the cold half of a two-tier save (Epic E3).
//
// docs/ideas/06-persistence.md called this split "essential, not optional" and
// none of it existed: everything lived in localStorage, which is synchronous,
// ~5 MB, and shared with journal caches and base64 scene images. An 80-hour
// campaign cannot fit, and the failure mode was silent.
//
// The split:
//   HOT  (localStorage)  small, synchronous, always current — world, party,
//                        session, the ledger tail, recent transcript. Written
//                        every turn; this is what a reload needs to resume.
//   COLD (IndexedDB)     large, async, append-mostly — transcript history,
//                        compacted ledger segments, chapter archives, sketches.
//                        Written in batches; only read when something reaches
//                        back for it.
//
// Config-injected like everything else here: the host passes an indexedDB
// factory (or nothing, in which case every call degrades to a no-op and the
// game keeps working on the hot tier alone — Safari private mode, a blocked
// origin, or a test runner all land there).

const DB_NAME = 'dans-dungeons-cold';
const VERSION = 1;
const STORES  = ['transcript', 'ledger', 'chapters', 'blobs'];

// Open (and upgrade) the database. Resolves to null when IndexedDB is
// unavailable or refuses — never throws, because losing the cold tier must
// degrade the game, not break it.
export function openCold(factory = globalThis.indexedDB, { name = DB_NAME } = {}) {
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req;
    try { req = factory.open(name, VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode);
}

// Resolve with the request's result AND whether it actually succeeded. The
// previous wrapper resolved `null` for both "no result" and "the request
// errored", so a failed write reported `true` to its caller — the silent
// quota failure this module exists to eliminate came straight back.
function wrap(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve({ ok: true, result: request.result ?? null });
    request.onerror   = () => resolve({ ok: false, result: null });
  });
}

// A write is durable when its TRANSACTION completes, not when the request
// fires onsuccess — a quota abort can still arrive between the two. Waits on
// oncomplete/onabort when the transaction object supports them (real
// IndexedDB); resolves optimistically for minimal fakes that don't.
function settled(transaction, requestOk) {
  if (!requestOk) return Promise.resolve(false);
  if (!transaction || typeof transaction !== 'object') return Promise.resolve(true);
  if (!('oncomplete' in transaction) && !('addEventListener' in transaction)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      transaction.oncomplete = () => finish(true);
      transaction.onabort    = () => finish(false);
      transaction.onerror    = () => finish(false);
    } catch { finish(true); }
  });
}

export async function coldPut(db, store, key, value) {
  if (!db) return false;
  try {
    const t = tx(db, store, 'readwrite');
    const { ok } = await wrap(t.objectStore(store).put({ key, value }));
    return await settled(t, ok);
  } catch { return false; }
}

export async function coldGet(db, store, key) {
  if (!db) return null;
  try {
    const { result } = await wrap(tx(db, store, 'readonly').objectStore(store).get(key));
    return result?.value ?? null;
  } catch { return null; }
}

export async function coldKeys(db, store) {
  if (!db) return [];
  try {
    const { result } = await wrap(tx(db, store, 'readonly').objectStore(store).getAllKeys());
    return result ?? [];
  } catch { return []; }
}

export async function coldAll(db, store) {
  if (!db) return [];
  try {
    const { result } = await wrap(tx(db, store, 'readonly').objectStore(store).getAll());
    return (result ?? []).map(r => r.value);
  } catch { return []; }
}

export async function coldDelete(db, store, key) {
  if (!db) return false;
  try {
    const t = tx(db, store, 'readwrite');
    const { ok } = await wrap(t.objectStore(store).delete(key));
    return await settled(t, ok);
  } catch { return false; }
}

// ─── Segmented archives ──────────────────────────────────────────────────────
//
// Long histories are written as numbered segments rather than one growing blob,
// so appending costs the size of the batch instead of the size of the campaign.
// This is the same lesson as the transcript's narrow writes, applied to the
// cold tier.

export const segmentKey = (prefix, index) => `${prefix}:${String(index).padStart(6, '0')}`;

// Append a batch as a new segment.
//
// `startIndex` (when the caller tracks one — the archive watermark does) keys
// the segment by the batch's position in the source array, which makes an
// accidental re-archive of the same range an idempotent overwrite instead of
// a duplicate. Without it, the next key is max(existing)+1 — the previous
// count-based scheme reused a key after any deletion and silently destroyed
// the newest segment.
export async function appendSegment(db, store, prefix, items, { startIndex = null } = {}) {
  if (!db || !items?.length) return null;
  let index = startIndex;
  if (index === null) {
    const existing = await coldKeys(db, store);
    const mine = existing
      .filter(k => typeof k === 'string' && k.startsWith(`${prefix}:`))
      .map(k => Number(k.slice(prefix.length + 1)))
      .filter(Number.isFinite);
    index = mine.length ? Math.max(...mine) + 1 : 0;
  }
  const key = segmentKey(prefix, index);
  return (await coldPut(db, store, key, items)) ? key : null;
}

// Read a prefix's segments back in order, flattened.
export async function readSegments(db, store, prefix) {
  if (!db) return [];
  const keys = (await coldKeys(db, store))
    .filter(k => typeof k === 'string' && k.startsWith(`${prefix}:`))
    .sort();
  const out = [];
  for (const key of keys) {
    const chunk = await coldGet(db, store, key);
    if (Array.isArray(chunk)) out.push(...chunk);
  }
  return out;
}

// ─── Hot/cold split ──────────────────────────────────────────────────────────

// Split a save snapshot into what must stay resident and what can be archived.
// Pure, so the policy is testable without a browser: the hot slice keeps the
// last `keepTranscript` entries and the ledger tail; the rest goes cold.
//
// `archivedTranscript` / `archivedLedger` are the caller's WATERMARKS — how
// many leading entries are already durably archived. The cold slice starts at
// the watermark, so calling this every turn archives only what is NEW since
// the last successful archive. Without watermarks (the pre-0.2.0 behaviour),
// every save re-archived the entire overflow: measured 88x duplication at 200
// turns, quadratic beyond. Callers advance the watermark only after the
// archive write reports success, and `cold.*Start` says where each batch
// begins so it can key the segment idempotently.
// Two calling modes, distinguished by whether a watermark is passed:
//
//   TRIM MODE (no watermark — the original contract): the caller feeds the
//   previous HOT slice back in each cycle, so the array only ever contains
//   un-archived material. Cold = everything that leaves the keep-window;
//   `hot.archived` accumulates the running total for display.
//
//   WATERMARK MODE (`archivedTranscript`/`archivedLedger` passed): the caller
//   keeps the FULL live array (a reactive app state it must not trim) and
//   tracks how many leading entries are already durably archived. Cold starts
//   at the watermark, so calling this every turn archives only what is new —
//   without it, every save re-archived the entire overflow (measured 88x
//   duplication at 200 turns, quadratic beyond). Advance the watermark to
//   `hot.archived.*` only after the archive write reports success;
//   `cold.*Start` keys the segment idempotently.
export function splitSave(snapshot, opts = {}) {
  const { keepTranscript = 50, keepLedger = 200 } = opts;
  const watermarked = opts.archivedTranscript !== undefined || opts.archivedLedger !== undefined;
  const transcript = snapshot?.transcript ?? [];
  const ledger     = snapshot?.world?.ledger ?? [];

  // slice(-0) is slice(0) — the whole array — so keep = 0 must short-circuit
  // or "keep nothing hot" duplicates the full history into both tiers.
  const tail = (arr, keep) => (keep > 0 ? arr.slice(-keep) : []);
  const coldEnd = (arr, keep) => Math.max(0, arr.length - keep);

  const tStart = watermarked ? Math.max(0, Math.min(opts.archivedTranscript ?? 0, transcript.length)) : 0;
  const lStart = watermarked ? Math.max(0, Math.min(opts.archivedLedger ?? 0, ledger.length)) : 0;
  const coldTranscript = transcript.slice(tStart, Math.max(tStart, coldEnd(transcript, keepTranscript)));
  const coldLedger     = ledger.slice(lStart, Math.max(lStart, coldEnd(ledger, keepLedger)));

  const hot = {
    ...snapshot,
    transcript: tail(transcript, keepTranscript),
    world: { ...snapshot?.world, ledger: tail(ledger, keepLedger) },
  };
  hot.archived = watermarked
    ? { transcript: tStart + coldTranscript.length, ledger: lStart + coldLedger.length }
    : {
        transcript: (snapshot?.archived?.transcript ?? 0) + coldTranscript.length,
        ledger:     (snapshot?.archived?.ledger ?? 0) + coldLedger.length,
      };
  return {
    hot,
    cold: {
      transcript: coldTranscript, transcriptStart: tStart,
      ledger: coldLedger, ledgerStart: lStart,
    },
  };
}
