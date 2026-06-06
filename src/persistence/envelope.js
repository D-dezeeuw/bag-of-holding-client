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

// Parse + migrate a raw stored value (JSON string or already-parsed object).
//   migrations:     { [fromVersion]: (data) => data }, applied in order
//   currentVersion: target version (default 1)
//   onReconcile:    optional (data) => data, run after migration (e.g. re-derive
//                   a character sheet from its record)
// Returns the migrated data, or null if raw is empty / unparseable.
export function loadEnvelope(raw, { migrations = {}, currentVersion = 1, onReconcile } = {}) {
  if (raw == null) return null;

  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  if (parsed == null) return null;

  let version, data;
  if (isEnvelope(parsed)) {
    ({ v: version, data } = parsed);
  } else {
    version = 0;     // legacy bare snapshot, pre-versioning
    data = parsed;
  }

  for (let v = version; v < currentVersion; v++) {
    const migrate = migrations[v];
    if (typeof migrate === 'function') data = migrate(data);
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
export function saveEnvelope(storage, key, data, version, { pick } = {}) {
  const snap = pick ? Object.fromEntries(pick.map(k => [k, data[k]])) : data;
  try {
    storage.setItem(key, JSON.stringify(wrapEnvelope(snap, version)));
    return true;
  } catch {
    return false;
  }
}

// Combine a host's tick + save into one commit() — closes the recurring
// "mutated state but forgot to flush/persist" footgun. tick/save stay host-owned
// (e.g. Spektrum tick + localStorage write); the library only supplies the pair.
export function makeCommit({ tick, save }) {
  return function commit() { tick(); save(); };
}
