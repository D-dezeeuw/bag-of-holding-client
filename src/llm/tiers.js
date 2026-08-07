// src/llm/tiers.js — tier → model resolution + per-tier sampling defaults.
//
// A "tier" is a quality/purpose slot (tiny | medium | large | image | tts | stt),
// distinct from any pricing plan the host may layer on top. The host passes a
// `models` map (tier → model id) in its config; these exported sets are sensible
// OpenRouter defaults a host can spread, override, or ignore. Deployment secrets
// (e.g. an embedded shared key) NEVER live here — only public model ids.
//
// Model ids rot: providers delist models without notice, and a dead id in a
// default table breaks every host that spreads it. Two defences ship with these
// tables: `healModels()` below (swap unknown ids back to defaults at boot) and
// the catalog fetch in ./catalog.js. Ids here were verified against the live
// OpenRouter catalog on 2026-08-07; re-run `npm run models:check` to re-verify.

export const FREE_MODELS = Object.freeze({
  tiny:   'google/gemma-4-26b-a4b-it:free',
  medium: 'nvidia/nemotron-3-super-120b-a12b:free',
  large:  'nvidia/nemotron-3-super-120b-a12b:free',
  image:  null,   // no free image gen
  tts:    null,   // OpenRouter hosts no speech models — see PAID_MODELS
  stt:    null,
});

// Paid slots. tts/stt stay null: OpenRouter's catalog carries no text-to-speech
// or transcription models, so those features are provider-gated, not tier-gated
// (a host wanting speech must point `baseUrl` at a provider that has them).
export const PAID_MODELS = Object.freeze({
  tiny:   'google/gemini-2.5-flash-lite',
  medium: 'deepseek/deepseek-v4-pro',
  large:  'deepseek/deepseek-v4-pro',
  image:  'google/gemini-2.5-flash-image',
  tts:    null,
  stt:    null,
});

// Fallback chains per tier — tried in order when the primary model fails with a
// retryable 4xx (rate limit, or an id the provider no longer serves). Every
// entry supports structured outputs, so a schema-bound call survives the walk.
export const FREE_FALLBACKS = Object.freeze({
  tiny:   ['nvidia/nemotron-nano-9b-v2:free', 'openai/gpt-oss-20b:free'],
  medium: ['openai/gpt-oss-20b:free', 'google/gemma-4-26b-a4b-it:free'],
  large:  ['openai/gpt-oss-20b:free', 'google/gemma-4-26b-a4b-it:free'],
});

// Tier slots that name a chat model (the ones a chat fallback chain applies to).
export const CHAT_TIERS = Object.freeze(['tiny', 'medium', 'large']);

// Pure resolution: config.models[tier] ?? defaults[tier] ?? null.
export function resolveModel(tier, config, defaults = FREE_MODELS) {
  return config?.models?.[tier] ?? defaults?.[tier] ?? null;
}

// Default sampling for a tier: classifiers run cold + short, narration runs warm.
export function sampling(tier) {
  return {
    temperature: tier === 'tiny' ? 0.1 : 0.85,
    maxTokens:   tier === 'tiny' ? 250 : 700,
  };
}

// Swap any model id the provider no longer serves back to the tier default.
// Pure: takes the live id set (from fetchModelIds) and returns
// { models, healed: [{ tier, from, to }] } — the host decides how to surface it.
// A null slot is "deliberately unconfigured" and is left alone; an unknown live
// set (null/empty) heals nothing, so a failed catalog fetch is never destructive.
export function healModels(models = {}, liveIds, defaults = FREE_MODELS) {
  if (!liveIds || typeof liveIds.has !== 'function' || liveIds.size === 0) {
    return { models: { ...models }, healed: [] };
  }
  const next   = { ...models };
  const healed = [];
  for (const [tier, id] of Object.entries(next)) {
    if (!id || liveIds.has(id)) continue;
    const fallback = defaults?.[tier] ?? null;
    if (fallback === id) continue;              // default is itself dead — nothing to do
    next[tier] = fallback;
    healed.push({ tier, from: id, to: fallback });
  }
  return { models: next, healed };
}
