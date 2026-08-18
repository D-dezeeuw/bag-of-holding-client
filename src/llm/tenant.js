// src/llm/tenant.js — talking to a hosted deployment's inference relay.
//
// Two ways a host can get a working LlmConfig, and until now the library only
// knew one of them:
//
//   • BYOK — the player pastes a provider key and the config points straight at
//     the provider. Every turn bills the player's account.
//   • tenant — the player pastes a token issued by a hosted deployment. The
//     config points at that deployment's OpenAI-compatible relay, which holds
//     the provider key and applies the tier budget from `relaygate.js`.
//
// The second one needs no new transport: the relay speaks the same
// `/chat/completions` + `/models` contract, so `relayBaseUrl` is the whole
// integration — build a config whose `baseUrl` is the relay and whose `key` is
// the token, and every existing call path works unchanged.
//
// The token sits in the URL path, matching how the deployment's MCP surface
// already addresses a tenant (`/mcp/<token>`), and rides the Authorization
// header too because `authHeaders` always sends one. Neither is a second
// secret — a relay URL IS the credential, so treat a leaked one as a leaked
// token and re-mint.

import { apiBase } from './transport.js';
import { relayBudgetStatus } from './relaygate.js';

/** The marker a relay returns from `/status`, so a wrong URL cannot look right. */
export const RELAY_MARKER = 'bag-of-holding-mcp';

/** Probes give up fast: this runs in a setup wizard with a person waiting. */
export const RELAY_PROBE_TIMEOUT_MS = 8000;

/**
 * The OpenAI-compatible base URL for a tenant on a deployment.
 *
 * `serverUrl` is what the operator hands out (`https://boh.example.com`, with
 * or without a trailing slash, with or without a `/mcp/...` tail already on
 * it — an operator who copies the MCP URL out of their client config gets the
 * same answer as one who types the hostname).
 */
export function relayBaseUrl(serverUrl, token) {
  const host = String(serverUrl ?? '').trim().replace(/\/+$/, '');
  if (host === '') throw new Error('relayBaseUrl needs the deployment URL, e.g. https://boh.example.com');
  const tok = String(token ?? '').trim();
  if (tok === '') throw new Error('relayBaseUrl needs a tenant token.');
  // Strip an already-complete MCP or relay path so the tail is never doubled.
  const root = host.replace(/\/mcp\/[^/]+(\/v1)?$/, '');
  return `${root}/mcp/${encodeURIComponent(tok)}/v1`;
}

/**
 * Build an LlmConfig for a tenant token. Everything else a host would pass to
 * the provider config (models, sinks, appTitle, referer) passes through, so the
 * only difference between a BYOK config and a tenant config is where it points.
 */
export function tenantConfig({ serverUrl, token, ...rest } = {}) {
  return { ...rest, key: String(token ?? '').trim(), baseUrl: relayBaseUrl(serverUrl, token) };
}

/**
 * Ask a relay whether this token works, and what it may spend.
 *
 * Never throws — a setup wizard needs an answer, not an exception, and the
 * three failure modes it must tell apart are all ordinary:
 *
 *   { ok: true,  tier, models, budget }        the token is live
 *   { ok: false, reason: 'rejected' }          relay reached, token unknown
 *                                              (or revoked, or suspended)
 *   { ok: false, reason: 'unreachable' }       no relay answered at that URL
 *   { ok: false, reason: 'not-a-relay' }       something answered, but it is
 *                                              not one of ours
 *
 * The deployment returns the same 404 for an unknown token and an unknown path
 * on purpose (it refuses to be an oracle for token guessing), so `rejected` is
 * as specific as this can honestly be about *why* a token did not work.
 */
export async function probeRelay(config, { timeoutMs = RELAY_PROBE_TIMEOUT_MS, now = Date.now() } = {}) {
  const base = apiBase(config);
  const ctl   = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(`${base}/status`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${config?.key ?? ''}` },
      signal:  ctl?.signal,
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'rejected' };
  }
  if (!res.ok) return { ok: false, reason: 'unreachable' };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'not-a-relay' };
  }
  if (body?.relay !== RELAY_MARKER) return { ok: false, reason: 'not-a-relay' };

  return {
    ok: true,
    tier: typeof body.tier === 'string' ? body.tier : null,
    // The relay decides which model ids a tier may reach, so a host that adopts
    // them cannot spend a turn discovering that its own default was refused.
    models: body.models && typeof body.models === 'object' ? body.models : null,
    budget: body.budget ? relayBudgetStatus(body.budget, now) : null,
    serverVersion: typeof body.version === 'string' ? body.version : null,
  };
}
