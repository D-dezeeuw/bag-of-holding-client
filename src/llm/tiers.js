// src/llm/tiers.js — tier → model resolution + per-tier sampling defaults.
//
// A "tier" is a quality/purpose slot (tiny | medium | large | image | tts | stt),
// distinct from any pricing plan the host may layer on top. The host passes a
// `models` map (tier → model id) in its config; these exported sets are sensible
// OpenRouter defaults a host can spread, override, or ignore. Deployment secrets
// (e.g. an embedded shared key) NEVER live here — only public model ids.

export const FREE_MODELS = Object.freeze({
  tiny:   'google/gemma-4-26b-a4b-it:free',
  medium: 'openai/gpt-oss-120b:free',
  large:  'nvidia/nemotron-3-super-120b-a12b:free',
  image:  null,
  tts:    null,
  stt:    null,
});

export const PAID_MODELS = Object.freeze({
  tiny:   'google/gemini-2.5-flash-lite',
  medium: 'deepseek/deepseek-v4-pro',
  large:  'deepseek/deepseek-v4-pro',
  image:  'google/gemini-2.5-flash-image',
  tts:    'openai/gpt-4o-mini-tts-2025-12-15',
  stt:    'openai/gpt-4o-mini-transcribe',
});

// 429 (rate-limit) fallback chains per tier — tried in order.
export const FREE_FALLBACKS = Object.freeze({
  tiny:   ['qwen/qwen3-72b:free', 'meta-llama/llama-4-scout:free'],
  medium: ['deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-4-maverick:free'],
  large:  ['deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-4-maverick:free'],
});

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
