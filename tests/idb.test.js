// Two-tier persistence (Epic E3).
//
// docs/ideas/06-persistence.md called the IndexedDB split "essential, not
// optional"; nothing was built, so an 80-hour campaign had to fit in a ~5 MB
// localStorage budget shared with journal caches and base64 images — and the
// overflow failed silently.
//
// The cold tier must degrade rather than break: a browser that refuses
// IndexedDB (private mode, a blocked origin, a test runner) has to keep
// playing on the hot tier alone.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  openCold, coldPut, coldGet, coldKeys, coldAll, coldDelete,
  appendSegment, readSegments, segmentKey, splitSave,
} from '../src/persistence/idb.js';

// A minimal in-memory IndexedDB good enough for the surface this module uses.
function fakeIndexedDB() {
  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const ok = (result) => {
    const req = { result };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  return {
    open() {
      const db = {
        objectStoreNames: { contains: (n) => stores.has(n) },
        createObjectStore: (n) => store(n),
        transaction: (name) => ({
          objectStore: () => ({
            put:        (row) => { store(name).set(row.key, row.value); return ok(undefined); },
            get:        (key) => ok(store(name).has(key) ? { key, value: store(name).get(key) } : undefined),
            getAllKeys: ()    => ok([...store(name).keys()]),
            getAll:     ()    => ok([...store(name).entries()].map(([key, value]) => ({ key, value }))),
            delete:     (key) => { store(name).delete(key); return ok(undefined); },
          }),
        }),
      };
      const req = { result: db };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
}

describe('cold store', () => {
  it('round-trips values', async () => {
    const db = await openCold(fakeIndexedDB());
    assert.ok(db);
    assert.equal(await coldPut(db, 'blobs', 'a', { n: 1 }), true);
    assert.deepEqual(await coldGet(db, 'blobs', 'a'), { n: 1 });
  });

  it('lists and deletes', async () => {
    const db = await openCold(fakeIndexedDB());
    await coldPut(db, 'blobs', 'a', 1);
    await coldPut(db, 'blobs', 'b', 2);
    assert.deepEqual((await coldKeys(db, 'blobs')).sort(), ['a', 'b']);
    assert.deepEqual((await coldAll(db, 'blobs')).sort(), [1, 2]);
    await coldDelete(db, 'blobs', 'a');
    assert.deepEqual(await coldKeys(db, 'blobs'), ['b']);
  });

  it('returns null for a missing key rather than throwing', async () => {
    const db = await openCold(fakeIndexedDB());
    assert.equal(await coldGet(db, 'blobs', 'nope'), null);
  });
});

describe('degrading without IndexedDB', () => {
  it('opening returns null when the platform has none', async () => {
    assert.equal(await openCold(undefined), null);
    assert.equal(await openCold(null), null);
  });

  it('opening returns null when the browser refuses', async () => {
    const refusing = { open() { const req = {}; queueMicrotask(() => req.onerror?.()); return req; } };
    assert.equal(await openCold(refusing), null);
    const throwing = { open() { throw new Error('private mode'); } };
    assert.equal(await openCold(throwing), null);
  });

  it('every operation is a safe no-op on a null database', async () => {
    assert.equal(await coldPut(null, 'blobs', 'a', 1), false);
    assert.equal(await coldGet(null, 'blobs', 'a'), null);
    assert.deepEqual(await coldKeys(null, 'blobs'), []);
    assert.deepEqual(await coldAll(null, 'blobs'), []);
    assert.equal(await coldDelete(null, 'blobs', 'a'), false);
    assert.equal(await appendSegment(null, 'transcript', 'run', [1]), null);
    assert.deepEqual(await readSegments(null, 'transcript', 'run'), []);
  });
});

describe('segmented archives', () => {
  it('appends batches instead of rewriting one growing blob', async () => {
    const db = await openCold(fakeIndexedDB());
    await appendSegment(db, 'transcript', 'run', [1, 2, 3]);
    await appendSegment(db, 'transcript', 'run', [4, 5]);
    assert.deepEqual(await coldKeys(db, 'transcript'), ['run:000000', 'run:000001']);
    assert.deepEqual(await readSegments(db, 'transcript', 'run'), [1, 2, 3, 4, 5]);
  });

  it('keeps segments in order past ten', async () => {
    const db = await openCold(fakeIndexedDB());
    for (let i = 0; i < 12; i++) await appendSegment(db, 'transcript', 'run', [i]);
    assert.deepEqual(await readSegments(db, 'transcript', 'run'), [...Array(12).keys()],
      'zero-padded keys must sort lexicographically in numeric order');
  });

  it('ignores other prefixes in the same store', async () => {
    const db = await openCold(fakeIndexedDB());
    await appendSegment(db, 'transcript', 'run-a', [1]);
    await appendSegment(db, 'transcript', 'run-b', [9]);
    assert.deepEqual(await readSegments(db, 'transcript', 'run-a'), [1]);
  });

  it('writing nothing writes nothing', async () => {
    const db = await openCold(fakeIndexedDB());
    assert.equal(await appendSegment(db, 'transcript', 'run', []), null);
    assert.deepEqual(await coldKeys(db, 'transcript'), []);
  });

  it('pads keys so a campaign can exceed a million entries', () => {
    assert.equal(segmentKey('run', 0), 'run:000000');
    assert.equal(segmentKey('run', 42), 'run:000042');
  });
});

describe('hot/cold split', () => {
  const snapshot = (turns) => ({
    session: { turnCount: turns },
    transcript: Array.from({ length: turns * 2 }, (_, i) => ({ role: i % 2 ? 'gm' : 'player', text: `t${i}` })),
    world: { ledger: Array.from({ length: turns }, (_, i) => ({ turn: i, target: 'x', path: 'p', to: i })) },
  });

  it('keeps a recent tail hot and archives the rest', () => {
    const { hot, cold } = splitSave(snapshot(200), { keepTranscript: 50, keepLedger: 100 });
    assert.equal(hot.transcript.length, 50);
    assert.equal(hot.world.ledger.length, 100);
    assert.equal(cold.transcript.length, 350);
    assert.equal(cold.ledger.length, 100);
  });

  it('the hot tail is the NEWEST material', () => {
    const { hot } = splitSave(snapshot(100), { keepTranscript: 4 });
    assert.equal(hot.transcript.at(-1).text, 't199', 'a reload must resume from the latest turn');
  });

  it('records how much was archived, so the tail is not mistaken for the whole', () => {
    const first  = splitSave(snapshot(100), { keepTranscript: 10, keepLedger: 10 });
    assert.equal(first.hot.archived.transcript, 190);
    // Splitting again accumulates rather than resetting.
    const second = splitSave({ ...first.hot, transcript: [...first.hot.transcript, ...snapshot(5).transcript] },
      { keepTranscript: 10, keepLedger: 10 });
    assert.ok(second.hot.archived.transcript > 190);
  });

  it('is a no-op for a short campaign', () => {
    const { hot, cold } = splitSave(snapshot(5), { keepTranscript: 50, keepLedger: 200 });
    assert.equal(cold.transcript.length, 0);
    assert.equal(cold.ledger.length, 0);
    assert.equal(hot.transcript.length, 10);
  });

  it('leaves everything except transcript and ledger untouched', () => {
    const snap = { ...snapshot(60), party: { pc: { name: 'Mara' } }, settings: { tts: true } };
    const { hot } = splitSave(snap);
    assert.deepEqual(hot.party, snap.party);
    assert.deepEqual(hot.settings, snap.settings);
  });

  it('bounds the hot slice regardless of campaign length', () => {
    const short = splitSave(snapshot(50)).hot;
    const long  = splitSave(snapshot(3000)).hot;
    // The point of the split: what gets written every turn is a fixed-size tail,
    // not a growing history. Entry counts match exactly; byte counts differ only
    // because later entries carry longer ids.
    assert.equal(long.transcript.length, short.transcript.length);
    // A short campaign holds fewer entries than the cap; a long one is capped.
    assert.ok(short.world.ledger.length <= 200);
    assert.equal(long.world.ledger.length, 200, 'the hot ledger is capped, not proportional to play');
    const ratio = JSON.stringify(long.transcript).length / JSON.stringify(short.transcript).length;
    assert.ok(ratio < 1.5,
      `an 80-hour campaign writes ${ratio.toFixed(2)}x the hot bytes of a one-hour one — the tail must stay bounded`);
  });
});
