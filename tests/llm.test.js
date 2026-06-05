import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, apiBase, authHeaders, DEFAULT_BASE_URL, DEFAULT_APP_TITLE } from '../src/llm/transport.js';
import { resolveModel, sampling, FREE_MODELS, PAID_MODELS, FREE_FALLBACKS } from '../src/llm/tiers.js';
import { JsonFieldStreamer } from '../src/llm/stream.js';

describe('transport — apiBase / headers / ApiError', () => {
  it('defaults the base URL and strips a trailing slash', () => {
    assert.equal(apiBase({}), DEFAULT_BASE_URL);
    assert.equal(apiBase(null), DEFAULT_BASE_URL);
    assert.equal(apiBase({ baseUrl: 'https://x.test/v1/' }), 'https://x.test/v1');
    assert.equal(apiBase({ baseUrl: 'https://x.test/v1' }), 'https://x.test/v1');
  });
  it('builds auth headers with a configurable title', () => {
    const h = authHeaders({ key: 'sk-1', referer: 'https://app', appTitle: "Dan's Dungeons" });
    assert.equal(h.Authorization, 'Bearer sk-1');
    assert.equal(h['HTTP-Referer'], 'https://app');
    assert.equal(h['X-Title'], "Dan's Dungeons");
    assert.equal(authHeaders({})['X-Title'], DEFAULT_APP_TITLE);
  });
  it('ApiError carries a typed status', () => {
    const e = new ApiError(429, 'rate limited');
    assert.equal(e.status, 429);
    assert.equal(e.name, 'ApiError');
    assert.match(e.message, /AI 429:/);
    assert.ok(e instanceof Error);
  });
});

describe('tiers — resolveModel / sampling', () => {
  it('prefers config.models, then defaults, then null', () => {
    assert.equal(resolveModel('tiny', { models: { tiny: 'm-cfg' } }, FREE_MODELS), 'm-cfg');
    assert.equal(resolveModel('tiny', {}, FREE_MODELS), FREE_MODELS.tiny);
    assert.equal(resolveModel('nope', {}, FREE_MODELS), null);
    assert.equal(resolveModel('medium', {}, PAID_MODELS), PAID_MODELS.medium);
  });
  it('samples cold+short for tiny, warm+long otherwise', () => {
    assert.deepEqual(sampling('tiny'), { temperature: 0.1, maxTokens: 250 });
    assert.deepEqual(sampling('medium'), { temperature: 0.85, maxTokens: 700 });
  });
  it('ships fallback chains per tier', () => {
    assert.ok(FREE_FALLBACKS.tiny.length >= 1);
    assert.ok(FREE_FALLBACKS.medium.length >= 1);
  });
});

describe('JsonFieldStreamer', () => {
  function streamAll(chunks, field = 'narration') {
    const s = new JsonFieldStreamer(field);
    return chunks.map(c => s.feed(c)).join('');
  }
  it('extracts the field value across the whole object', () => {
    assert.equal(streamAll(['{"narration":"hello world","x":1}']), 'hello world');
  });
  it('survives arbitrary chunk boundaries (incl. mid-marker)', () => {
    assert.equal(streamAll(['{"narr', 'ation":"', 'split ', 'text"}']), 'split text');
    assert.equal(streamAll(['{"narration":"a', 'b', 'c"}']), 'abc');
  });
  it('decodes \\n \\t \\" escapes and drops \\r', () => {
    assert.equal(streamAll(['{"narration":"a\\nb\\tc\\"d\\re"}']), 'a\nb\tc"de');
  });
  it('decodes a \\u unicode escape (the fix), even split across chunks', () => {
    assert.equal(streamAll(['{"narration":"caf\\u00e9"}']), 'café');
    assert.equal(streamAll(['{"narration":"x\\u00', 'e9y"}']), 'xéy');
  });
  it('honours a custom field name and stops at the closing quote', () => {
    assert.equal(streamAll(['{"reply":"hi there","n":2}'], 'reply'), 'hi there');
  });
});
