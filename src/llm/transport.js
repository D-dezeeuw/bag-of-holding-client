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
export async function post(config, path, body, { stream = false } = {}) {
  const res = await fetch(`${apiBase(config)}${path}`, {
    method:  'POST',
    headers: authHeaders(config),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(res.status, txt.slice(0, 200));
  }
  return res;
}
