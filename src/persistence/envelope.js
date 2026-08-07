// src/persistence/envelope.js — versioned save envelope + migration runner.
//
// Wraps a state snapshot as { v, data }, runs ordered v→v+1 migrations on load,
// and reads/writes through an injected storage adapter ({ getItem, setItem,
// removeItem }) — so it's node-testable with a Map-backed stub and carries no
// DOM. Legacy saves written before versioning existed (a bare snapshot with no
// envelope) are treated as version 0 and migrated forward, so adding versioning
// never strands an existing save.

// Wrap a snapshot with its schema version.
export function wrapEnvelope(data, version) {
  return { v: version, data };
}

// True for a value already in { v: number, data } envelope shape.
function isEnvelope(x) {
  return x != null && typeof x === 'object' && typeof x.v === 'number' && 'data' in x;
}

// Why a load was refused. Reported to `onError` so the host can quarantine the
// bytes and tell the player something truer than "no save found".
export const LOAD_ERRORS = {
  PARSE:             'parse-failed',
  FUTURE_VERSION:    'future-version',
  MISSING_MIGRATION: 'missing-migration',
  MIGRATION_FAILED:  'migration-failed',
  CHECKSUM:          'checksum-mismatch',
};

// Parse + migrate a raw stored value (JSON string or already-parsed object).
//   migrations:     { [fromVersion]: (data) => data }, applied in order. Every
//                   step from the save's version up to currentVersion must be
//                   declared — use an identity function for a benign bump.
//   currentVersion: target version (default 1)
//   onReconcile:    optional (data) => data, run after migration (e.g. re-derive
//                   a character sheet from its record)
//   onError:        optional (code, detail) => void, called before a refusal
//   strict:         when false, an undeclared migration step is skipped instead
//                   of refusing the load (default true)
// Returns the migrated data, or null if raw is empty, unparseable, or refused.
//
// Two refusals matter more than they look. A save written by a NEWER build
// carries a shape this build has never seen; migrating it forward is impossible
// and loading it raw silently feeds unknown fields into live state. And a gap in
// the migration chain used to be skipped in silence, so a v1 save reached v3
// code having run only the v2 step — a corruption that surfaces turns later, far
// from its cause. Both now stop at the door.
export function loadEnvelope(raw, { migrations = {}, currentVersion = 1, onReconcile, onError, strict = true } = {}) {
  if (raw == null) return null;
  const fail = (code, detail) => { onError?.(code, detail); return null; };

  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (err) { return fail(LOAD_ERRORS.PARSE, err?.message ?? 'unparseable'); }
  }
  if (parsed == null) return null;

  let version, data;
  if (isEnvelope(parsed)) {
    ({ v: version, data } = parsed);
  } else {
    version = 0;     // legacy bare snapshot, pre-versioning
    data = parsed;
  }

  if (version > currentVersion) {
    return fail(LOAD_ERRORS.FUTURE_VERSION, `save is v${version}, this build reads up to v${currentVersion}`);
  }

  // Reported, not refused: a stamped save whose digest no longer matches has
  // been edited or partially rewritten, but it still parsed — refusing it would
  // throw away a campaign over a digest this library cannot prove is the newer
  // truth. The host decides whether to warn or fall back to a backup.
  if (typeof parsed?.c === 'string') {
    let actual;
    try { actual = digest(JSON.stringify(data)); } catch { actual = null; }
    if (actual && actual !== parsed.c) onError?.(LOAD_ERRORS.CHECKSUM, `expected ${parsed.c}, got ${actual}`);
  }

  for (let v = version; v < currentVersion; v++) {
    const migrate = migrations[v];
    if (typeof migrate !== 'function') {
      if (strict) return fail(LOAD_ERRORS.MISSING_MIGRATION, `no migration declared for v${v}→v${v + 1}`);
      continue;
    }
    try {
      data = migrate(data);
    } catch (err) {
      return fail(LOAD_ERRORS.MIGRATION_FAILED, `v${v}→v${v + 1}: ${err?.message ?? err}`);
    }
  }

  if (typeof onReconcile === 'function') {
    const reconciled = onReconcile(data);
    if (reconciled != null) data = reconciled;
  }
  return data;
}

// Serialize + persist a snapshot under `key`. `pick` optionally whitelists which
// top-level keys to persist (defaults to the whole object). Returns true on
// success, false if the storage write threw (e.g. quota). Never throws.
//
// `backups: n` keeps the n previous saves alongside the live one under
// `<key>.bak.1` (newest) … `<key>.bak.n`. An autosave that lands mid-corruption
// otherwise overwrites the only good copy; with rotation on, the host can hand
// the player back the turn before. `checksum: true` stamps a cheap digest of the
// payload so a silently altered save is reported on load.
export function saveEnvelope(storage, key, data, version, { pick, backups = 0, checksum = false } = {}) {
  const snap = pick ? Object.fromEntries(pick.map(k => [k, data[k]])) : data;
  const env  = wrapEnvelope(snap, version);
  let payload;
  try {
    if (checksum) env.c = digest(JSON.stringify(snap));
    payload = JSON.stringify(env);
  } catch {
    return false;   // cyclic or otherwise unserializable state
  }

  if (backups > 0) rotateBackups(storage, key, backups);

  try {
    storage.setItem(key, payload);
    return true;
  } catch {
    // Out of room — the rotation we just did is the likeliest cause. Give the
    // live save priority over its own history and try once more.
    if (backups > 0) {
      try { storage.removeItem(backupKey(key, backups)); } catch { /* nothing to do */ }
      try { storage.setItem(key, payload); return true; } catch { /* fall through */ }
    }
    return false;
  }
}

// `<key>.bak.1` is the most recent previous save.
export function backupKey(key, slot) {
  return `${key}.bak.${slot}`;
}

// Shift bak.(n-1)→bak.n … key→bak.1. Copies rather than moves, so a failed
// write afterwards still leaves the live save intact.
function rotateBackups(storage, key, keep) {
  for (let slot = keep; slot > 1; slot--) {
    try {
      const prev = storage.getItem(backupKey(key, slot - 1));
      if (prev != null) storage.setItem(backupKey(key, slot), prev);
    } catch { /* a lost backup is never worth failing the save over */ }
  }
  try {
    const live = storage.getItem(key);
    if (live != null) storage.setItem(backupKey(key, 1), live);
  } catch { /* same */ }
}

// Raw stored values for every populated backup slot, newest first, as
// { slot, raw }. Feed `raw` to loadEnvelope to recover one.
export function listBackups(storage, key, keep = 3) {
  const out = [];
  for (let slot = 1; slot <= keep; slot++) {
    let raw = null;
    try { raw = storage.getItem(backupKey(key, slot)); } catch { /* skip */ }
    if (raw != null) out.push({ slot, raw });
  }
  return out;
}

// The newest backup that survives loadEnvelope, or null. Options are forwarded,
// so a backup written by a future build or with a broken migration path is
// skipped rather than handed back as the recovery.
export function restoreBackup(storage, key, { keep = 3, ...opts } = {}) {
  for (const { slot, raw } of listBackups(storage, key, keep)) {
    const data = loadEnvelope(raw, opts);
    if (data != null) return { slot, data };
  }
  return null;
}

// FNV-1a/32 — not a security hash, just enough to notice a save that changed
// under us. Deterministic and dependency-free, which is the whole requirement.
export function digest(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Combine a host's tick + save into one commit() — closes the recurring
// "mutated state but forgot to flush/persist" footgun. tick/save stay host-owned
// (e.g. Spektrum tick + localStorage write); the library only supplies the pair.
export function makeCommit({ tick, save }) {
  return function commit() { tick(); save(); };
}
