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
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror   = () => resolve(null);
  });
}

export async function coldPut(db, store, key, value) {
  if (!db) return false;
  try {
    await wrap(tx(db, store, 'readwrite').put({ key, value }));
    return true;
  } catch { return false; }
}

export async function coldGet(db, store, key) {
  if (!db) return null;
  try {
    const row = await wrap(tx(db, store, 'readonly').get(key));
    return row?.value ?? null;
  } catch { return null; }
}

export async function coldKeys(db, store) {
  if (!db) return [];
  try { return (await wrap(tx(db, store, 'readonly').getAllKeys())) ?? []; } catch { return []; }
}

export async function coldAll(db, store) {
  if (!db) return [];
  try {
    const rows = await wrap(tx(db, store, 'readonly').getAll());
    return (rows ?? []).map(r => r.value);
  } catch { return []; }
}

export async function coldDelete(db, store, key) {
  if (!db) return false;
  try { await wrap(tx(db, store, 'readwrite').delete(key)); return true; } catch { return false; }
}

// ─── Segmented archives ──────────────────────────────────────────────────────
//
// Long histories are written as numbered segments rather than one growing blob,
// so appending costs the size of the batch instead of the size of the campaign.
// This is the same lesson as the transcript's narrow writes, applied to the
// cold tier.

export const segmentKey = (prefix, index) => `${prefix}:${String(index).padStart(6, '0')}`;

export async function appendSegment(db, store, prefix, items) {
  if (!db || !items?.length) return null;
  const existing = await coldKeys(db, store);
  const mine = existing.filter(k => typeof k === 'string' && k.startsWith(`${prefix}:`));
  const key = segmentKey(prefix, mine.length);
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
export function splitSave(snapshot, { keepTranscript = 50, keepLedger = 200 } = {}) {
  const transcript = snapshot?.transcript ?? [];
  const ledger     = snapshot?.world?.ledger ?? [];

  const coldTranscript = transcript.slice(0, Math.max(0, transcript.length - keepTranscript));
  const coldLedger     = ledger.slice(0, Math.max(0, ledger.length - keepLedger));

  const hot = {
    ...snapshot,
    transcript: transcript.slice(-keepTranscript),
    world: { ...snapshot?.world, ledger: ledger.slice(-keepLedger) },
  };
  // Where the archived material starts, so a reader knows the hot slice is a
  // tail and not the whole history.
  hot.archived = {
    transcript: (snapshot?.archived?.transcript ?? 0) + coldTranscript.length,
    ledger:     (snapshot?.archived?.ledger ?? 0) + coldLedger.length,
  };
  return { hot, cold: { transcript: coldTranscript, ledger: coldLedger } };
}
