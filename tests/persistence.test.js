import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { wrapEnvelope, loadEnvelope, saveEnvelope, makeCommit } from '../src/persistence/envelope.js';

// Map-backed stub of the { getItem, setItem, removeItem } storage adapter.
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

describe('wrap / save / load round-trip', () => {
  it('persists an envelope and reads it back', () => {
    const s = memStorage();
    assert.equal(saveEnvelope(s, 'save', { hp: 10, name: 'X' }, 1), true);
    const stored = JSON.parse(s.getItem('save'));
    assert.deepEqual(stored, { v: 1, data: { hp: 10, name: 'X' } });
    assert.deepEqual(loadEnvelope(s.getItem('save'), { currentVersion: 1 }), { hp: 10, name: 'X' });
  });

  it('pick whitelists which keys persist', () => {
    const s = memStorage();
    saveEnvelope(s, 'save', { a: 1, b: 2, secret: 3 }, 1, { pick: ['a', 'b'] });
    assert.deepEqual(loadEnvelope(s.getItem('save')), { a: 1, b: 2 });
  });

  it('returns false (never throws) when storage write fails', () => {
    const boom = { setItem() { throw new Error('quota'); } };
    assert.equal(saveEnvelope(boom, 'k', { a: 1 }, 1), false);
  });
});

describe('loadEnvelope — legacy + migration', () => {
  it('treats a bare (un-enveloped) snapshot as version 0', () => {
    const legacy = JSON.stringify({ hp: 5 }); // no { v, data } wrapper
    assert.deepEqual(loadEnvelope(legacy, { currentVersion: 1 }), { hp: 5 });
  });

  it('runs ordered v→v+1 migrations from a legacy save up to current', () => {
    const migrations = {
      0: (d) => ({ ...d, gold: d.gold ?? 0 }),       // v0→v1: add gold
      1: (d) => ({ ...d, gold: d.gold + 10 }),        // v1→v2: bonus
    };
    const out = loadEnvelope(JSON.stringify({ hp: 5 }), { migrations, currentVersion: 2 });
    assert.deepEqual(out, { hp: 5, gold: 10 });
  });

  it('does not migrate when already at currentVersion', () => {
    const migrations = { 1: () => assert.fail('should not run') };
    const raw = JSON.stringify(wrapEnvelope({ hp: 9 }, 2));
    assert.deepEqual(loadEnvelope(raw, { migrations, currentVersion: 2 }), { hp: 9 });
  });

  it('applies onReconcile after migration', () => {
    const out = loadEnvelope(JSON.stringify({ hp: 5 }), {
      currentVersion: 1,
      onReconcile: (d) => ({ ...d, derived: d.hp * 2 }),
    });
    assert.deepEqual(out, { hp: 5, derived: 10 });
  });

  it('returns null for empty / unparseable input', () => {
    assert.equal(loadEnvelope(null), null);
    assert.equal(loadEnvelope('not json{'), null);
    assert.equal(loadEnvelope(undefined), null);
  });
});

describe('makeCommit', () => {
  it('calls tick then save, in order', () => {
    const calls = [];
    const commit = makeCommit({ tick: () => calls.push('tick'), save: () => calls.push('save') });
    commit();
    assert.deepEqual(calls, ['tick', 'save']);
  });
});
