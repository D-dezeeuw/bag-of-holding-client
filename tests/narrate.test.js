// narrate() — the end-to-end loop the 0.26.0 scaffolding stopped short
// of. What must hold: the happy path goes prompt → completion → parsed
// narration with the cacheKey attached; a cache turns the second
// identical resolution into zero completion calls; a malformed reply
// gets exactly ONE repair pass (mirroring client.js's posture) and a
// still-broken repair reports instead of throwing; transport errors
// surface as { ok: false } so the host's dice-speak fallback always
// works; and the LRU actually evicts oldest-first.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { narrate, makeNarrationCache } from '../src/llm/narrate.js';

const HIT = { attacker: 'Vex', target: 'goblin', weapon: 'shortsword', total: 18, ac: 15, damage: 7 };

test('happy path: prompt → completion → parsed narration, cache primed', async () => {
  const calls = [];
  const complete = async (config, opts) => {
    calls.push(opts);
    return '{"narration": "Your blade slides home.", "tone": "grim"}';
  };
  const cache = makeNarrationCache();
  const first = await narrate({}, 'attack.hit', HIT, { cache, complete });
  assert.equal(first.ok, true);
  assert.equal(first.narration, 'Your blade slides home.');
  assert.equal(first.tone, 'grim');
  assert.equal(first.cached, false);
  assert.match(first.cacheKey, /^n-[0-9a-f]{8}$/);
  // The system/user halves reached the completion intact, on the cheap tier.
  assert.equal(calls[0].tier, 'tiny');
  assert.match(calls[0].messages[0].content, /never change numbers/);
  assert.match(calls[0].messages[1].content, /18 vs 15/);

  // Second identical resolution: zero completion calls, served from cache.
  const second = await narrate({}, 'attack.hit', HIT, { cache, complete });
  assert.equal(second.cached, true);
  assert.equal(second.narration, first.narration);
  assert.equal(calls.length, 1, 'the cache absorbed the call');
  // A different payload is a different key — the cache never lies.
  await narrate({}, 'attack.hit', { ...HIT, total: 19 }, { cache, complete });
  assert.equal(calls.length, 2);
});

test('a malformed reply gets exactly one repair pass', async () => {
  let n = 0;
  const complete = async (config, opts) => {
    n++;
    if (n === 1) return 'The goblin drops, dramatically.';
    // The repair turn shows the model its own reply.
    assert.match(opts.messages.at(-2).content, /dramatically/);
    assert.match(opts.messages.at(-1).content, /ONLY a JSON object/);
    return '{"narration": "The goblin drops."}';
  };
  const repaired = await narrate({}, 'attack.crit', { damage: 14 }, { complete });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.narration, 'The goblin drops.');
  assert.equal(n, 2);

  // A repair that is STILL broken reports; it never loops.
  let m = 0;
  const stubborn = async () => { m++; return 'still prose'; };
  const failed = await narrate({}, 'attack.crit', { damage: 14 }, { complete: stubborn });
  assert.equal(failed.ok, false);
  assert.equal(m, 2, 'one attempt + one repair, never more');
  assert.match(failed.reason, /not JSON/);
});

test('transport errors surface as ok:false — dice-speak fallback always works', async () => {
  const down = async () => { throw new Error('rate limited'); };
  const result = await narrate({}, 'scene.transition', { from: 'a', to: 'b' }, { complete: down });
  assert.equal(result.ok, false);
  assert.match(result.reason, /narration call failed: rate limited/);
  assert.ok(result.cacheKey, 'the key is still reported for host-side retry bookkeeping');
});

test('the LRU evicts oldest-first and refreshes on hit', () => {
  const cache = makeNarrationCache(2);
  cache.set('a', 1); cache.set('b', 2);
  cache.get('a');            // refresh a — b is now oldest
  cache.set('c', 3);         // evicts b
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});
