// Guards the model-rot failure mode: a delisted default model id used to end a
// turn with "GM unavailable" because the fallback walk only fired on 429 and
// aborted on the first non-429 error. These tests pin the swap policy, the
// full-chain walk, the cost accounting, and the pure heal helper.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { call, chatStream } from '../src/llm/client.js';
import { healModels, FREE_MODELS, FREE_FALLBACKS, CHAT_TIERS } from '../src/llm/tiers.js';
import { fetchModelIds } from '../src/llm/catalog.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function okCompletion(content, usage) {
  return jsonRes({ choices: [{ message: { content } }], usage });
}

// Records every model id the client attempts, and replies per a status script.
function mockChat(statusByModel) {
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    seen.push(model);
    const status = statusByModel[model] ?? 200;
    if (status !== 200) return jsonRes({ error: `status ${status}` }, status);
    return okCompletion(`hello from ${model}`, { total_tokens: 10, cost: 0.002 });
  };
  return seen;
}

const cfg = {
  models:    { tiny: 'primary-tiny', medium: 'primary-medium' },
  fallbacks: { tiny: ['fb-1', 'fb-2'], medium: ['fb-1', 'fb-2'] },
};

describe('call() — model-swap fallback policy', () => {
  it('walks the chain when the primary model is delisted (404)', async () => {
    const seen = mockChat({ 'primary-medium': 404 });
    const out  = await call(cfg, { tier: 'medium', messages: [] });
    assert.equal(out, 'hello from fb-1');
    assert.deepEqual(seen, ['primary-medium', 'fb-1']);
  });

  it('walks the chain on a 400 from an unserved model id', async () => {
    const seen = mockChat({ 'primary-medium': 400 });
    assert.equal(await call(cfg, { tier: 'medium', messages: [] }), 'hello from fb-1');
    assert.deepEqual(seen, ['primary-medium', 'fb-1']);
  });

  it('continues past a dead fallback instead of aborting the walk', async () => {
    // The shipped bug: fb-1 failing with a non-429 threw and fb-2 was never tried.
    const seen = mockChat({ 'primary-medium': 429, 'fb-1': 404 });
    assert.equal(await call(cfg, { tier: 'medium', messages: [] }), 'hello from fb-2');
    assert.deepEqual(seen, ['primary-medium', 'fb-1', 'fb-2']);
  });

  it('rethrows the ORIGINAL error when the whole chain is dead', async () => {
    mockChat({ 'primary-medium': 429, 'fb-1': 404, 'fb-2': 404 });
    await assert.rejects(
      () => call(cfg, { tier: 'medium', messages: [] }),
      (err) => err.status === 429,   // the real cause, not the last fallback's 404
    );
  });

  it('never swaps models on an auth failure', async () => {
    const seen = mockChat({ 'primary-medium': 401 });
    await assert.rejects(() => call(cfg, { tier: 'medium', messages: [] }), (e) => e.status === 401);
    assert.deepEqual(seen, ['primary-medium'], 'a bad key must not burn the fallback chain');
  });

  it('does not swap models on a server fault', async () => {
    const seen = mockChat({ 'primary-medium': 503 });
    await assert.rejects(() => call(cfg, { tier: 'medium', messages: [] }), (e) => e.status === 503);
    assert.deepEqual(seen, ['primary-medium']);
  });
});

describe('accounting — real provider cost', () => {
  it('reports usage.cost to onCost (not just token counts)', async () => {
    mockChat({});
    let tokens = 0, usd = 0;
    await call({ ...cfg, onTokens: n => { tokens += n; }, onCost: c => { usd += c; } },
      { tier: 'medium', messages: [] });
    assert.equal(tokens, 10);
    assert.equal(usd, 0.002, 'OpenRouter returns real spend per response — the meter must use it');
  });
});

describe('chatStream() — fallback chain', () => {
  function sse(lines) {
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => (i < lines.length
        ? { done: false, value: enc.encode(lines[i++]) }
        : { done: true }) }) },
    };
  }

  it('streams from a fallback when the primary is delisted', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => {
      const model = JSON.parse(init.body).model;
      seen.push(model);
      if (model === 'primary-medium') return jsonRes({ error: 'no such model' }, 404);
      return sse([
        'data: {"choices":[{"delta":{"content":"{\\"narration\\":\\"Ah"}}]}\n',
        'data: {"choices":[{"delta":{"content":"oy\\"}"}}]}\n',
        'data: [DONE]\n',
      ]);
    };
    const chunks = [];
    const raw = await chatStream(cfg, { tier: 'medium', messages: [] }, c => chunks.push(c));
    assert.deepEqual(seen, ['primary-medium', 'fb-1']);
    assert.equal(chunks.join(''), 'Ahoy');
    assert.equal(JSON.parse(raw).narration, 'Ahoy');
  });
});

describe('healModels() — stale model maps', () => {
  it('swaps unknown ids back to the tier default', () => {
    const live = new Set(['good-tiny', FREE_MODELS.medium]);
    const { models, healed } = healModels(
      { tiny: 'good-tiny', medium: 'delisted-model' }, live,
      { tiny: 'good-tiny', medium: FREE_MODELS.medium });
    assert.equal(models.medium, FREE_MODELS.medium);
    assert.deepEqual(healed, [{ tier: 'medium', from: 'delisted-model', to: FREE_MODELS.medium }]);
  });

  it('leaves deliberately-null slots alone', () => {
    const { models, healed } = healModels({ tts: null }, new Set(['x']), { tts: null });
    assert.equal(models.tts, null);
    assert.deepEqual(healed, []);
  });

  it('heals nothing when the catalog is unavailable (never destructive)', () => {
    for (const bad of [null, undefined, new Set()]) {
      const { models, healed } = healModels({ medium: 'delisted' }, bad, FREE_MODELS);
      assert.equal(models.medium, 'delisted');
      assert.deepEqual(healed, []);
    }
  });
});

describe('catalog — fetchModelIds', () => {
  it('returns the live id set', async () => {
    globalThis.fetch = async () => jsonRes({ data: [{ id: 'a/b' }, { id: 'c/d' }] });
    const ids = await fetchModelIds({});
    assert.ok(ids.has('a/b') && ids.has('c/d'));
  });
  it('returns null on any failure so healing is skipped', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await fetchModelIds({}), null);
    globalThis.fetch = async () => jsonRes({ error: 'nope' }, 500);
    assert.equal(await fetchModelIds({}), null);
  });
});

describe('default tables — internal consistency', () => {
  it('every chat tier has a model and a non-empty fallback chain', () => {
    for (const tier of CHAT_TIERS) {
      assert.ok(FREE_MODELS[tier], `free tier '${tier}' needs a model`);
      assert.ok(FREE_FALLBACKS[tier]?.length, `tier '${tier}' needs fallbacks`);
      assert.ok(!FREE_FALLBACKS[tier].includes(FREE_MODELS[tier]),
        `tier '${tier}' fallback chain must not repeat its primary`);
    }
  });
});
