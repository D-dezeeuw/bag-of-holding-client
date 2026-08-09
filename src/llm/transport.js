// src/llm/transport.js — the single seam to the OpenAI-compatible HTTP contract.
//
// Owns base-URL normalization, header construction, and a typed ApiError so
// retry/fallback logic branches on `err.status` (not on string-matching the
// message). No globals: every function takes an LlmConfig
// ({ key, baseUrl?, models?, defaultModels?, fallbacks?, appTitle?, referer?, onTokens? }).

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_APP_TITLE = 'bag-of-holding-client';

// Typed transport error. `status` is the HTTP status; `body` the (truncated) text.
export class ApiError extends Error {
  constructor(status, body = '') {
    super(`AI ${status}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// A request that never returns is worse than one that fails: with no timeout
// anywhere in the LLM stack, a hung fetch froze the player's turn forever with
// no way out. Every call now runs under a deadline, and a caller can pass its
// own signal to cancel (a Stop button, a navigation away).
export const DEFAULT_TIMEOUT_MS = 60_000;

// Thrown when a call is cancelled or times out. Distinct from ApiError so retry
// logic never treats a deliberate cancellation as a provider fault.
export class AbortedError extends Error {
  constructor(reason = 'aborted') {
    super(`AI request ${reason}`);
    this.name = 'AbortedError';
    this.reason = reason;
  }
}

// Combine a caller's signal with a timeout into one signal, and hand back a
// disposer so the timer never outlives the request.
export function withDeadline(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof AbortController !== 'function') return { signal, done: () => {} };
  const ctl = new AbortController();
  const onAbort = () => ctl.abort('cancelled');
  const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
  if (signal) {
    if (signal.aborted) ctl.abort('cancelled');
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    done: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); },
  };
}

// Normalise a fetch rejection: an aborted request becomes AbortedError so the
// caller can tell "the player stopped this" from "the provider broke".
export function asTransportError(err, signal) {
  const aborted = err?.name === 'AbortError' || signal?.aborted;
  if (aborted) return new AbortedError(signal?.reason === 'timeout' ? 'timed out' : 'cancelled');
  return err;
}

// Base URL with any trailing slash stripped — the one place the default lives.
export function apiBase(config) {
  return (config?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

// OpenAI/OpenRouter-style auth + identity headers.
export function authHeaders(config) {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${config?.key || ''}`,
    'HTTP-Referer':  config?.referer || '',
    'X-Title':       config?.appTitle || DEFAULT_APP_TITLE,
  };
}

// POST JSON and return the raw Response. Throws ApiError(status, body) on !ok.
// Callers that need the body as JSON/blob/stream read it off the Response.
// Runs under the same deadline machinery as the chat paths — before this,
// image generation and speech calls through here could hang forever, which
// contradicted the header's "every call now runs under a deadline".
export async function post(config, path, body, { signal, timeoutMs } = {}) {
  const deadline = withDeadline(signal ?? config?.signal, timeoutMs ?? config?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${apiBase(config)}${path}`, {
      method:  'POST',
      headers: authHeaders(config),
      body:    JSON.stringify(body),
      signal:  deadline.signal,
    });
  } catch (err) {
    throw asTransportError(err, deadline.signal);
  } finally {
    deadline.done();
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(res.status, txt.slice(0, 200));
  }
  return res;
}
