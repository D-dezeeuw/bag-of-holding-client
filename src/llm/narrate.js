// src/llm/narrate.js — the end-to-end narration loop the prompt
// scaffolding (0.26.0) stopped short of. prompts.js shipped as an
// island: it renders provider-agnostic prompts and validates replies,
// but never touched this repo's OWN completion client — a host still
// had to wire transport, extraction, retries and caching by hand.
// `narrate()` closes the loop through the machinery that already
// exists here (client.js owns fallback chains, token accounting and
// timeouts; nothing is duplicated):
//
//   engine result → narrationPrompt → chatCompletion → parseNarration
//                        ↑ cacheKey ─────────── cache ↴
//
// The cache is injectable and tiny (makeNarrationCache) because the
// cache POLICY is the host's: a table that wants every goblin miss
// narrated fresh passes no cache; a cost-conscious one passes one and
// identical resolutions stop costing tokens.

import { chatCompletion } from './client.js';
import { narrationPrompt, parseNarration } from './prompts.js';

/**
 * A minimal LRU for narration results, keyed by the prompt's cacheKey.
 * Map-iteration order gives us recency for free: on hit, re-insert;
 * on overflow, evict the oldest key.
 */
export function makeNarrationCache(limit = 200) {
  const store = new Map();
  return Object.freeze({
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key);
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key, value) {
      store.delete(key);
      store.set(key, value);
      while (store.size > limit) store.delete(store.keys().next().value);
    },
    get size() { return store.size; },
  });
}

/**
 * Narrate one resolved moment, end to end. Returns
 *   `{ ok: true, narration, tone?, soundCue?, cacheKey, cached }`
 * or `{ ok: false, reason, cacheKey }` — the host falls back to plain
 * dice-speak, which is always correct because the MECHANICS never
 * depended on this call.
 *
 * Options: `tone` threads into prompt + cacheKey; `tier` picks the
 * chat tier ('tiny' is the right default — narration is flavor, not
 * reasoning); `cache` is a makeNarrationCache (or anything with
 * get/set); `complete` is injectable for tests and defaults to the
 * real chatCompletion.
 */
export async function narrate(config, kind, payload = {}, {
  tone, tier = 'tiny', cache, signal, timeoutMs, complete = chatCompletion,
} = {}) {
  const prompt = narrationPrompt(kind, payload, { tone });
  const hit = cache?.get(prompt.cacheKey);
  if (hit) return { ok: true, ...hit, cacheKey: prompt.cacheKey, cached: true };

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  let raw;
  try {
    raw = await complete(config, { tier, messages, maxTokens: 300, signal, timeoutMs });
  } catch (err) {
    return { ok: false, reason: `narration call failed: ${err?.message ?? err}`, cacheKey: prompt.cacheKey };
  }
  let parsed = parseNarration(raw);
  if (!parsed.ok) {
    // One repair pass, mirroring client.js's own JSON-repair posture:
    // show the model its reply and ask for schema-true JSON only.
    try {
      raw = await complete(config, {
        tier,
        messages: [
          ...messages,
          { role: 'assistant', content: typeof raw === 'string' ? raw : JSON.stringify(raw) },
          { role: 'user', content: 'That was not valid. Return ONLY a JSON object: { "narration": string, "tone"?: string, "soundCue"?: string }.' },
        ],
        maxTokens: 300, signal, timeoutMs,
      });
      parsed = parseNarration(raw);
    } catch (err) {
      return { ok: false, reason: `narration repair failed: ${err?.message ?? err}`, cacheKey: prompt.cacheKey };
    }
  }
  if (!parsed.ok) return { ok: false, reason: parsed.reason, cacheKey: prompt.cacheKey };

  const { ok, ...result } = parsed;
  cache?.set(prompt.cacheKey, result);
  return { ok: true, ...result, cacheKey: prompt.cacheKey, cached: false };
}
