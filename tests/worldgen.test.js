import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, pick, pickN, shuffle, randInt } from '../src/worldgen/rng.js';
import {
  buildBlueprint, blueprintContext, worldSeedConstraints, beatsHints,
  factionsHints, regionHints, settlementHints, DEFAULT_TABLES,
} from '../src/worldgen/blueprint.js';
import { runPipeline, withRetry, ensureDigest } from '../src/worldgen/pipeline.js';

describe('rng', () => {
  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(42), b = mulberry32(42);
    assert.deepEqual(Array.from({ length: 8 }, () => a()), Array.from({ length: 8 }, () => b()));
  });
  it('pickN returns n unique members; shuffle preserves multiset', () => {
    const arr = [1, 2, 3, 4, 5];
    const r = mulberry32(7);
    const n = pickN(arr, 3, r);
    assert.equal(n.length, 3);
    assert.equal(new Set(n).size, 3);
    assert.deepEqual([...shuffle(arr, mulberry32(1))].sort(), [1, 2, 3, 4, 5]);
    const v = randInt(2, 4, mulberry32(2));
    assert.ok(v >= 2 && v <= 4);
  });
});

describe('buildBlueprint', () => {
  it('is deterministic and complete', () => {
    const a = buildBlueprint(123), b = buildBlueprint(123);
    assert.deepEqual(a, b);
    assert.ok(DEFAULT_TABLES.tones.includes(a.tone));
    assert.equal(a.factionSlots.length, 3);
    assert.equal(a.godDomains.length, 3);
    assert.equal(a.buildingTypes.length, 4);
    assert.equal(a.locationTypes.length, 3);
    assert.ok(DEFAULT_TABLES.dungeonThemes.includes(a.dungeonTheme));
  });
  it('different seeds differ; faction slots & domains are unique', () => {
    assert.notDeepEqual(buildBlueprint(1), buildBlueprint(2));
    const bp = buildBlueprint(99);
    assert.equal(new Set(bp.factionSlots.map(f => f.type)).size, 3);
    assert.equal(new Set(bp.godDomains.map(g => g.domain)).size, 3);
  });
  it('accepts an injected rng and custom tables', () => {
    const tables = { ...DEFAULT_TABLES, tones: ['only'], beatArcs: { only: ['a'], heroic: ['h'] } };
    const bp = buildBlueprint(5, { tables, rng: mulberry32(5) });
    assert.equal(bp.tone, 'only');
    assert.deepEqual(bp.beatArc, ['a']);
  });
});

describe('blueprint context formatters', () => {
  const bp = buildBlueprint(42);
  it('blueprintContext embeds every constraint', () => {
    const c = blueprintContext(bp);
    assert.match(c, new RegExp(`Tone: ${bp.tone}`));
    assert.match(c, new RegExp(`Climate: ${bp.climate}`));
    assert.match(c, /God domains to draw from:/);
    assert.match(c, /Faction archetypes:/);
  });
  it('the *Hints suffixes are empty without a blueprint', () => {
    assert.equal(worldSeedConstraints(null), '');
    assert.equal(beatsHints(null), '');
    assert.equal(factionsHints(null), '');
    assert.equal(regionHints(null), '');
    assert.equal(settlementHints(null), '');
  });
  it('factionsHints asks for exactly N factions', () => {
    assert.match(factionsHints(bp), /Create exactly 3 factions/);
  });
});

describe('pipeline', () => {
  it('ensureDigest sets and returns a digest', () => {
    const o = { name: 'X' };
    assert.equal(ensureDigest(o, 'fallback'), 'fallback');
    assert.equal(o.digest, 'fallback');
    assert.equal(ensureDigest({ digest: 'own' }, 'fb'), 'own');
  });
  it('withRetry returns on first success, retries on throw', async () => {
    let n = 0;
    const v = await withRetry(async () => { n++; if (n < 3) throw new Error('x'); return 'ok'; }, 5);
    assert.equal(v, 'ok');
    assert.equal(n, 3);
  });

  it('threads parent digests, runs a parallel group, continues past non-critical fail', async () => {
    const order = [];
    const layers = [
      { name: 'world', critical: true, generate: () => { order.push('world'); return { digest: 'W' }; } },
      { name: 'factions', group: 1, dependsOn: ['world'], generate: (pd) => { order.push('factions:' + pd.world); return { digest: 'F' }; } },
      { name: 'beats', group: 1, dependsOn: ['world'], generate: () => { order.push('beats'); return null; } }, // non-critical empty
      { name: 'region', dependsOn: ['world'], generate: (pd) => { order.push('region:' + pd.world); return { digest: 'R' }; } },
    ];
    const out = await runPipeline(layers, { blueprint: {} });
    assert.equal(out.world.digest, 'W');
    assert.equal(out.factions.digest, 'F');
    assert.equal(out.beats, null);           // non-critical failure → null, pipeline continues
    assert.equal(out.region.digest, 'R');
    assert.ok(order.includes('factions:W'));  // parent digest threaded
    assert.ok(order.includes('region:W'));
  });

  it('aborts when a critical layer fails', async () => {
    const layers = [{ name: 'world', critical: true, generate: () => { throw new Error('seed down'); } }];
    await assert.rejects(() => runPipeline(layers, {}), /Critical worldgen layer 'world'/);
  });
});
