// tests/hardening.test.js — the failure modes the audit found: a streamer that
// went silent against pretty-printed JSON, a migration runner that skipped gaps
// in silence, a pipeline that threw away four completed layers when the fifth
// timed out, and a tone that changed identity between the blueprint and the
// cover it was supposed to paint.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JsonFieldStreamer } from '../src/llm/stream.js';
import {
  wrapEnvelope, loadEnvelope, saveEnvelope, listBackups, restoreBackup,
  backupKey, digest, LOAD_ERRORS,
} from '../src/persistence/envelope.js';
import { runPipeline, PipelineError } from '../src/worldgen/pipeline.js';
import { TONES, isTone } from '../src/worldgen/tones.js';
import { TONE_PALETTE } from '../src/output/epub.js';
import { WORLD_SEED_SCHEMA } from '../src/worldgen/schemas.js';
import { buildBlueprint } from '../src/worldgen/blueprint.js';
import { currentBeat, completeBeat } from '../src/narrative/beats.js';
import { generateDungeon, DEFAULT_SIZE } from '../src/dungeon/generate.js';
import { mulberry32 } from '../src/worldgen/rng.js';

// Feed a whole JSON document through the streamer one character at a time —
// the worst case for a marker that spans chunk boundaries.
function streamCharByChar(field, json) {
  const s = new JsonFieldStreamer(field);
  let out = '';
  for (const ch of json) out += s.feed(ch);
  return out;
}

describe('JsonFieldStreamer — whitespace tolerance', () => {
  it('extracts the field from compact JSON', () => {
    assert.equal(streamCharByChar('narration', '{"narration":"You wake."}'), 'You wake.');
  });

  it('extracts the field from pretty-printed JSON', () => {
    const pretty = JSON.stringify({ narration: 'You wake.' }, null, 2);
    assert.equal(streamCharByChar('narration', pretty), 'You wake.');
  });

  it('tolerates whitespace on either side of the colon', () => {
    assert.equal(streamCharByChar('narration', '{"narration"   :   "You wake."}'), 'You wake.');
    assert.equal(streamCharByChar('narration', '{"narration"\n\t: "You wake."}'), 'You wake.');
  });

  it('is not fooled by the field name appearing as a value', () => {
    const json = '{"kind":"narration","narration":"Real text."}';
    assert.equal(streamCharByChar('narration', json), 'Real text.');
  });

  it('survives a marker split across two feeds', () => {
    const s = new JsonFieldStreamer('narration');
    let out = '';
    out += s.feed('{"narration"');
    out += s.feed('  :  "Split');
    out += s.feed(' marker."}');
    assert.equal(out, 'Split marker.');
  });

  it('escapes a field name containing regex metacharacters', () => {
    assert.equal(streamCharByChar('a.b', '{"a.b": "ok"}'), 'ok');
    // …and does not treat the dot as a wildcard that matches another field.
    assert.equal(streamCharByChar('a.b', '{"axb": "wrong", "a.b": "right"}'), 'right');
  });

  it('does not grow the buffer without bound while hunting the marker', () => {
    const s = new JsonFieldStreamer('narration');
    for (let i = 0; i < 200; i++) s.feed('{"filler":"xxxxxxxxxxxxxxxx"},');
    assert.ok(s._buf.length <= s._keep, `buffer grew to ${s._buf.length}`);
    assert.equal(s.feed('{"narration":"found"}'), 'found');
  });
});

describe('loadEnvelope — refusals', () => {
  const migrations = { 0: d => d, 1: d => ({ ...d, migrated: true }) };

  it('migrates through a complete chain', () => {
    const raw = JSON.stringify(wrapEnvelope({ hp: 5 }, 1));
    assert.deepEqual(loadEnvelope(raw, { migrations, currentVersion: 2 }), { hp: 5, migrated: true });
  });

  it('refuses a save written by a newer build', () => {
    const codes = [];
    const raw = JSON.stringify(wrapEnvelope({ hp: 5 }, 9));
    const out = loadEnvelope(raw, { migrations, currentVersion: 2, onError: c => codes.push(c) });
    assert.equal(out, null);
    assert.deepEqual(codes, [LOAD_ERRORS.FUTURE_VERSION]);
  });

  it('refuses a gap in the migration chain instead of skipping it', () => {
    const codes = [];
    const raw = JSON.stringify(wrapEnvelope({ hp: 5 }, 0));
    const out = loadEnvelope(raw, {
      migrations: { 0: d => d },          // 1→2 undeclared
      currentVersion: 3,
      onError: c => codes.push(c),
    });
    assert.equal(out, null);
    assert.deepEqual(codes, [LOAD_ERRORS.MISSING_MIGRATION]);
  });

  it('skips a gap when strict is off', () => {
    const raw = JSON.stringify(wrapEnvelope({ hp: 5 }, 0));
    const out = loadEnvelope(raw, { migrations: { 0: d => d }, currentVersion: 3, strict: false });
    assert.deepEqual(out, { hp: 5 });
  });

  it('reports a throwing migration rather than propagating it', () => {
    const codes = [];
    const raw = JSON.stringify(wrapEnvelope({ hp: 5 }, 0));
    const out = loadEnvelope(raw, {
      migrations: { 0: () => { throw new Error('bad shape'); } },
      currentVersion: 1,
      onError: (c, d) => codes.push([c, d]),
    });
    assert.equal(out, null);
    assert.equal(codes[0][0], LOAD_ERRORS.MIGRATION_FAILED);
    assert.match(codes[0][1], /bad shape/);
  });

  it('reports unparseable input', () => {
    const codes = [];
    assert.equal(loadEnvelope('not json{', { onError: c => codes.push(c) }), null);
    assert.deepEqual(codes, [LOAD_ERRORS.PARSE]);
  });

  it('still accepts a legacy bare snapshot when v0 is declared', () => {
    assert.deepEqual(
      loadEnvelope(JSON.stringify({ hp: 5 }), { migrations: { 0: d => d }, currentVersion: 1 }),
      { hp: 5 },
    );
  });
});

describe('saveEnvelope — checksum + backup rotation', () => {
  const store = () => {
    const m = new Map();
    return {
      _m: m,
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: k => m.delete(k),
    };
  };

  it('stamps a digest that verifies on load', () => {
    const s = store();
    saveEnvelope(s, 'save', { hp: 10 }, 1, { checksum: true });
    const codes = [];
    assert.deepEqual(
      loadEnvelope(s.getItem('save'), { currentVersion: 1, onError: c => codes.push(c) }),
      { hp: 10 },
    );
    assert.deepEqual(codes, []);
  });

  it('reports a tampered payload but still returns it', () => {
    const s = store();
    saveEnvelope(s, 'save', { hp: 10 }, 1, { checksum: true });
    const env = JSON.parse(s.getItem('save'));
    env.data.hp = 999;
    const codes = [];
    const out = loadEnvelope(JSON.stringify(env), { currentVersion: 1, onError: c => codes.push(c) });
    assert.deepEqual(out, { hp: 999 });
    assert.deepEqual(codes, [LOAD_ERRORS.CHECKSUM]);
  });

  it('rotates previous saves into numbered backup slots', () => {
    const s = store();
    for (const hp of [1, 2, 3, 4]) saveEnvelope(s, 'save', { hp }, 1, { backups: 2 });
    assert.deepEqual(loadEnvelope(s.getItem('save'), { currentVersion: 1 }), { hp: 4 });
    assert.deepEqual(loadEnvelope(s.getItem(backupKey('save', 1)), { currentVersion: 1 }), { hp: 3 });
    assert.deepEqual(loadEnvelope(s.getItem(backupKey('save', 2)), { currentVersion: 1 }), { hp: 2 });
    assert.equal(s.getItem(backupKey('save', 3)), null);
  });

  it('lists and restores the newest usable backup', () => {
    const s = store();
    for (const hp of [1, 2, 3]) saveEnvelope(s, 'save', { hp }, 1, { backups: 3 });
    assert.deepEqual(listBackups(s, 'save', 3).map(b => b.slot), [1, 2]);
    assert.deepEqual(restoreBackup(s, 'save', { keep: 3, currentVersion: 1 }), { slot: 1, data: { hp: 2 } });
  });

  it('skips a backup this build cannot read', () => {
    const s = store();
    s.setItem(backupKey('save', 1), JSON.stringify(wrapEnvelope({ hp: 99 }, 7)));  // future version
    s.setItem(backupKey('save', 2), JSON.stringify(wrapEnvelope({ hp: 42 }, 1)));
    assert.deepEqual(restoreBackup(s, 'save', { keep: 3, currentVersion: 1 }), { slot: 2, data: { hp: 42 } });
  });

  it('keeps the live save when the quota only allows one write', () => {
    const m = new Map();
    let budget = 3;   // enough for the rotation, not for the new save on top
    const s = {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { if (budget-- <= 0) throw new Error('QuotaExceeded'); m.set(k, v); },
      removeItem: k => m.delete(k),
    };
    m.set('save', JSON.stringify(wrapEnvelope({ hp: 1 }, 1)));
    m.set(backupKey('save', 1), JSON.stringify(wrapEnvelope({ hp: 0 }, 1)));
    // rotation burns 2 writes, the live write fails, the retry after dropping
    // the oldest backup succeeds.
    assert.equal(saveEnvelope(s, 'save', { hp: 2 }, 1, { backups: 2 }), true);
    assert.deepEqual(loadEnvelope(s.getItem('save'), { currentVersion: 1 }), { hp: 2 });
  });

  it('returns false rather than throwing on unserializable state', () => {
    const s = store();
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(saveEnvelope(s, 'save', cyclic, 1), false);
  });

  it('digest is stable and dependency-free', () => {
    assert.equal(digest('abc'), digest('abc'));
    assert.notEqual(digest('abc'), digest('abd'));
  });
});

describe('runPipeline — checkpoint and resume', () => {
  const layer = (name, opts = {}) => ({
    name,
    generate: async () => ({ digest: `${name}-digest`, value: name }),
    ...opts,
  });

  it('checkpoints after every group', async () => {
    const seen = [];
    await runPipeline([layer('a'), layer('b')], { onCheckpoint: r => seen.push(Object.keys(r)) });
    assert.deepEqual(seen, [['a'], ['a', 'b']]);
  });

  it('carries completed layers out of a critical failure', async () => {
    const boom = { name: 'b', critical: true, generate: async () => { throw new Error('timeout'); } };
    const err = await runPipeline([layer('a'), boom, layer('c')], {}).then(() => null, e => e);
    assert.ok(err instanceof PipelineError);
    assert.deepEqual(err.results, { a: { digest: 'a-digest', value: 'a' } });
  });

  it('adopts checkpointed results instead of regenerating them', async () => {
    let calls = 0;
    const counted = (name) => ({ name, generate: async () => { calls++; return { digest: name, value: name }; } });
    const out = await runPipeline([counted('a'), counted('b')], {
      initialResults: { a: { digest: 'a', value: 'from-checkpoint' } },
    });
    assert.equal(calls, 1);                       // only 'b' ran
    assert.equal(out.a.value, 'from-checkpoint');
    assert.equal(out.b.value, 'b');
  });

  it('threads a resumed layer digest to its dependents', async () => {
    let got = null;
    const dependent = {
      name: 'b', dependsOn: ['a'],
      generate: async (parents) => { got = parents; return { digest: 'b' }; },
    };
    await runPipeline([layer('a'), dependent], { initialResults: { a: { digest: 'a-digest' } } });
    assert.deepEqual(got, { a: 'a-digest' });
  });

  it('does not re-throw on a checkpointed critical layer that had failed', async () => {
    const crit = { name: 'a', critical: true, generate: async () => { throw new Error('nope'); } };
    const out = await runPipeline([crit, layer('b')], { initialResults: { a: null } });
    assert.equal(out.a, null);
    assert.equal(out.b.value, 'b');
  });
});

describe('tone vocabulary is one list', () => {
  it('the world-seed schema permits exactly the blueprint tones', () => {
    assert.deepEqual([...WORLD_SEED_SCHEMA.properties.tone.enum].sort(), [...TONES].sort());
  });

  it('every tone has a cover palette', () => {
    for (const t of TONES) assert.ok(TONE_PALETTE[t], `no palette for tone '${t}'`);
  });

  it('every blueprint picks a tone the schema accepts', () => {
    for (let seed = 0; seed < 200; seed++) {
      const bp = buildBlueprint(seed);
      assert.ok(isTone(bp.tone), `seed ${seed} produced tone '${bp.tone}'`);
    }
  });

  it('every tone has a beat arc', () => {
    const arcs = new Set();
    for (let seed = 0; seed < 400; seed++) {
      const bp = buildBlueprint(seed);
      assert.ok(Array.isArray(bp.beatArc) && bp.beatArc.length, `seed ${seed} has no beat arc`);
      arcs.add(bp.tone);
    }
    assert.equal(arcs.size, TONES.length, 'not every tone was reachable');
  });
});

describe('beat successors are advisory, not a gate', () => {
  const thread = {
    currentIndex: 0,
    flags: {},
    beats: [
      { id: 'a', prerequisites: [], setRequiredFlags: ['opened'], successors: ['c'] },
      { id: 'b', prerequisites: ['opened'], setRequiredFlags: [], successors: [] },
      { id: 'c', prerequisites: ['opened'], setRequiredFlags: [], successors: [] },
    ],
  };

  it('follows the successor when several beats are eligible', () => {
    const after = completeBeat(thread, 'a');
    assert.equal(currentBeat(after).id, 'c');
  });

  it('falls back to the first eligible beat when the successor is unreachable', () => {
    const broken = { ...thread, beats: [{ ...thread.beats[0], successors: ['nonexistent'] }, ...thread.beats.slice(1)] };
    const after = completeBeat(broken, 'a');
    assert.equal(currentBeat(after).id, 'b');
  });

  it('never strands a thread when the successor list is empty', () => {
    const noEdges = { ...thread, beats: thread.beats.map(b => ({ ...b, successors: [] })) };
    const after = completeBeat(noEdges, 'a');
    assert.ok(currentBeat(after), 'thread stalled with beats still open');
  });
});

describe('dungeon scale is configurable', () => {
  const statBlockFor = () => ({ name: 'goblin', cr: 0.25, hp: 7, ac: 15, attacks: [] });

  const roomCount = (seed, size) =>
    Object.keys(generateDungeon(seed, { rng: mulberry32(seed), statBlockFor, size }).rooms).length;

  it('defaults to the historical 4-6 room spine plus 2-4 branches', () => {
    assert.deepEqual(DEFAULT_SIZE, { spineMin: 4, spineMax: 6, branchMin: 2, branchMax: 4 });
    for (let seed = 1; seed < 60; seed++) {
      const n = roomCount(seed);
      assert.ok(n >= 6 && n <= 10, `seed ${seed} built ${n} rooms`);
    }
  });

  it('builds a larger dungeon when asked', () => {
    // Branches attach opportunistically — a crowded grid can refuse one — so
    // the spine floor is the only hard guarantee. What must always hold is that
    // asking for more rooms yields more rooms than the default for that seed.
    for (let seed = 1; seed < 40; seed++) {
      const n = roomCount(seed, { spineMin: 10, spineMax: 12, branchMin: 5, branchMax: 6 });
      assert.ok(n >= 10, `seed ${seed} built only ${n} rooms`);
      assert.ok(n > roomCount(seed), `seed ${seed}: ${n} rooms is no bigger than the default`);
    }
  });

  it('clamps a spine too short to hold the lock gate', () => {
    for (let seed = 1; seed < 40; seed++) {
      const d = generateDungeon(seed, { rng: mulberry32(seed), statBlockFor, size: { spineMin: 1, spineMax: 1, branchMin: 0, branchMax: 0 } });
      assert.ok(Object.keys(d.rooms).length >= 3, `seed ${seed} built a spine with nowhere for the gate`);
      const locked = Object.values(d.rooms).flatMap(r => r.exits).filter(e => e.locked);
      assert.ok(locked.length > 0, `seed ${seed} lost its lock gate`);
    }
  });

  it('keeps the vault unreachable without the key at every scale', () => {
    for (const size of [undefined, { spineMin: 8, spineMax: 10, branchMin: 4, branchMax: 5 }]) {
      for (let seed = 1; seed < 40; seed++) {
        const d = generateDungeon(seed, { rng: mulberry32(seed), statBlockFor, size });
        // Flood from the entrance across unlocked exits only.
        const seen = new Set(['room-0']);
        const queue = ['room-0'];
        while (queue.length) {
          for (const exit of d.rooms[queue.shift()].exits) {
            if (exit.locked || seen.has(exit.roomId)) continue;
            seen.add(exit.roomId); queue.push(exit.roomId);
          }
        }
        assert.ok(!seen.has(d.exitRoomId), `seed ${seed} reached the vault with no key`);
      }
    }
  });
});
