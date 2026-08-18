import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { RELAY_MARKER, relayBaseUrl, tenantConfig, probeRelay } from '../src/llm/tenant.js';
import { emptyRelayBudget, chargeRelay, RELAY_TIERS } from '../src/llm/relaygate.js';

const TOKEN = 'a'.repeat(64);
const T0 = 1_700_000_000_000;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stub fetch with one canned answer, recording the URL it was asked for. */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return calls;
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

describe('relayBaseUrl', () => {
  it('builds the tenant path from a bare host', () => {
    assert.equal(relayBaseUrl('https://boh.example.com', TOKEN), `https://boh.example.com/mcp/${TOKEN}/v1`);
  });

  it('tolerates the shapes an operator actually pastes', () => {
    const want = `https://boh.example.com/mcp/${TOKEN}/v1`;
    assert.equal(relayBaseUrl('https://boh.example.com/', TOKEN), want);
    assert.equal(relayBaseUrl('  https://boh.example.com  ', TOKEN), want);
    // The MCP URL out of a client config, and the relay URL itself: neither
    // should end up with the tail on twice.
    assert.equal(relayBaseUrl(`https://boh.example.com/mcp/${TOKEN}`, TOKEN), want);
    assert.equal(relayBaseUrl(`https://boh.example.com/mcp/${TOKEN}/v1`, TOKEN), want);
  });

  it('percent-encodes a token so a stray slash cannot forge a path', () => {
    assert.equal(relayBaseUrl('https://boh.example.com', 'a/b'), 'https://boh.example.com/mcp/a%2Fb/v1');
  });

  it('refuses the two inputs it cannot guess', () => {
    assert.throws(() => relayBaseUrl('', TOKEN), /deployment URL/);
    assert.throws(() => relayBaseUrl('https://boh.example.com', '  '), /tenant token/);
  });
});

describe('tenantConfig', () => {
  it('points the config at the relay and keeps the host sinks', () => {
    const onTokens = () => {};
    const cfg = tenantConfig({ serverUrl: 'https://boh.example.com', token: TOKEN, appTitle: 'Dan', onTokens });
    assert.equal(cfg.key, TOKEN);
    assert.equal(cfg.baseUrl, `https://boh.example.com/mcp/${TOKEN}/v1`);
    assert.equal(cfg.appTitle, 'Dan');
    assert.equal(cfg.onTokens, onTokens);
  });
});

describe('probeRelay', () => {
  const cfg = { key: TOKEN, baseUrl: `https://boh.example.com/mcp/${TOKEN}/v1` };

  it('reads the tier, the models and the budget off a live relay', async () => {
    const budget = chargeRelay(emptyRelayBudget({ tier: 'patron' }), 5_000, T0);
    const calls = stubFetch(jsonResponse(200, {
      relay: RELAY_MARKER, version: '0.17.0', tier: 'patron',
      models: { tiny: 'a/b', medium: 'c/d' }, budget,
    }));
    const out = await probeRelay(cfg, { now: T0 });
    assert.equal(out.ok, true);
    assert.equal(out.tier, 'patron');
    assert.equal(out.serverVersion, '0.17.0');
    assert.deepEqual(out.models, { tiny: 'a/b', medium: 'c/d' });
    assert.equal(out.budget.remaining, RELAY_TIERS.patron.budget - 5_000);
    assert.equal(calls[0].url, `https://boh.example.com/mcp/${TOKEN}/v1/status`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it('a 404 is a rejected token — the deployment will not say which', async () => {
    stubFetch(jsonResponse(404, { error: 'Not found' }));
    assert.deepEqual(await probeRelay(cfg), { ok: false, reason: 'rejected' });
  });

  it('a network failure is unreachable, not rejected', async () => {
    stubFetch(new TypeError('fetch failed'));
    assert.deepEqual(await probeRelay(cfg), { ok: false, reason: 'unreachable' });
  });

  it('a 200 from something that is not a relay says so', async () => {
    stubFetch(jsonResponse(200, { hello: 'i am a blog' }));
    assert.deepEqual(await probeRelay(cfg), { ok: false, reason: 'not-a-relay' });

    globalThis.fetch = async () => new Response('<html>hi</html>', { status: 200 });
    assert.deepEqual(await probeRelay(cfg), { ok: false, reason: 'not-a-relay' });
  });

  it('a relay that is up but broken is unreachable rather than fatal', async () => {
    stubFetch(jsonResponse(500, { error: 'boom' }));
    assert.deepEqual(await probeRelay(cfg), { ok: false, reason: 'unreachable' });
  });

  it('never throws, whatever comes back', async () => {
    globalThis.fetch = async () => { throw new Error('DNS on fire'); };
    assert.equal((await probeRelay(cfg)).ok, false);
  });
});
