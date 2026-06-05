// src/llm/client.js — schema-bound + streaming chat completions over transport.js.
//
// Functional + config-injected: every call takes an LlmConfig. The config carries
// `onTokens(n)` so the HOST does usage accounting (the library never touches
// global state). Fallback policy branches on ApiError.status:
//   400 (content filter / unsupported feature) → retry once at the medium tier
//   429 (rate limited)                          → walk the tier's fallback model chain

import { apiBase, authHeaders, ApiError } from './transport.js';
import { resolveModel, sampling, FREE_MODELS, FREE_FALLBACKS } from './tiers.js';
import { JsonFieldStreamer } from './stream.js';

function accountTokens(config, data) {
  const n = data?.usage?.total_tokens;
  if (n && config.onTokens) config.onTokens(n);
}

async function callOnce(config, { tier = 'medium', messages, schema, maxTokens, temperature, model: override }) {
  const model = override ?? resolveModel(tier, config, config.defaultModels);
  if (!model) throw new Error(`No model configured for tier '${tier}'.`);
  const s = sampling(tier);

  const body = {
    model,
    messages,
    temperature: temperature ?? s.temperature,
    max_tokens:  maxTokens ?? s.maxTokens,
  };
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'output', strict: true, schema } };
  }

  const res = await fetch(`${apiBase(config)}/chat/completions`, {
    method:  'POST',
    headers: authHeaders(config),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(res.status, txt.slice(0, 200));
  }
  const data = await res.json();
  accountTokens(config, data);
  return data.choices[0].message.content;
}

// Raw text completion with the 400/429 fallback policy.
export async function call(config, opts) {
  try {
    return await callOnce(config, opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && opts.tier !== 'medium') {
      return await callOnce(config, { ...opts, tier: 'medium' });
    }
    if (err instanceof ApiError && err.status === 429 && opts.tier) {
      const fallbacks = (config.fallbacks ?? FREE_FALLBACKS)[opts.tier] ?? [];
      for (const model of fallbacks) {
        try {
          return await callOnce(config, { ...opts, model });
        } catch (fbErr) {
          if (!(fbErr instanceof ApiError && fbErr.status === 429)) throw fbErr;
        }
      }
    }
    throw err;
  }
}

// One JSON-repair pass: append the bad output + a correction nudge, re-call, parse.
export async function repairJson(config, raw, opts) {
  const messages = [
    ...opts.messages,
    { role: 'assistant', content: raw },
    { role: 'user', content: 'Your response was not valid JSON. Retry and return only a JSON object matching the schema.' },
  ];
  return JSON.parse(await call(config, { ...opts, messages }));
}

// Structured (schema present → parsed object, with one repair pass) or raw text.
export async function chatCompletion(config, opts) {
  const content = await call(config, opts);
  if (!opts.schema) return content;
  try {
    return JSON.parse(content);
  } catch {
    return repairJson(config, content, opts);
  }
}

// Streaming completion. Feeds deltas to a JsonFieldStreamer(field) so onChunk
// receives only the live text of that one JSON field; returns the full raw
// content for a post-stream JSON.parse/repair. `field: null` streams raw deltas.
export async function chatStream(config, { tier = 'medium', messages, maxTokens, temperature }, onChunk, { field = 'narration' } = {}) {
  const model = resolveModel(tier, config, config.defaultModels);
  const s = sampling(tier);

  const res = await fetch(`${apiBase(config)}/chat/completions`, {
    method:  'POST',
    headers: authHeaders(config),
    body:    JSON.stringify({
      model,
      messages,
      temperature: temperature ?? s.temperature,
      max_tokens:  maxTokens ?? s.maxTokens,
      stream:      true,
    }),
  });
  if (!res.ok) {
    if (res.status === 400 && tier !== 'medium') {
      return chatStream(config, { tier: 'medium', messages, maxTokens, temperature }, onChunk, { field });
    }
    const txt = await res.text().catch(() => '');
    throw new ApiError(res.status, txt.slice(0, 200));
  }

  const reader    = res.body.getReader();
  const decoder   = new TextDecoder();
  const extractor = field ? new JsonFieldStreamer(field) : null;
  let full    = '';
  let partial = '';

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = partial + decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');
    partial = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') break outer;
      try {
        const evt   = JSON.parse(data);
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (onChunk) {
            const out = extractor ? extractor.feed(delta) : delta;
            if (out) onChunk(out);
          }
        }
        accountTokens(config, evt);
      } catch { /* malformed SSE line — skip */ }
    }
  }
  return full;
}

// Validate a key against the provider's key endpoint. False ONLY on 401; any
// other outcome (404, network error, non-OpenRouter base) returns true so custom
// providers are not blocked.
export async function checkKey(config) {
  if (!config?.key) return false;
  try {
    const res = await fetch(`${apiBase(config)}/auth/key`, { headers: { Authorization: `Bearer ${config.key}` } });
    return res.status !== 401;
  } catch {
    return true;
  }
}
