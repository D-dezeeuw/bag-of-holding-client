// src/llm/catalog.js — provider model catalog lookup.
//
// One job: ask the provider which model ids it actually serves, so a host can
// heal a stale `models` map at boot (see healModels in ./tiers.js) instead of
// discovering the rot one failed turn at a time. The catalog endpoint needs no
// auth on OpenRouter, so this works before the player has entered a key.
//
// Never throws: a provider that has no /models endpoint, an offline player, or a
// malformed payload all return null, which healModels treats as "heal nothing".

import { apiBase } from './transport.js';

export async function fetchModelIds(config, { timeoutMs = 8000 } = {}) {
  const ctl   = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${apiBase(config)}/models`, {
      headers: { Accept: 'application/json' },
      signal:  ctl?.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ids  = (data?.data ?? []).map(m => m?.id).filter(Boolean);
    return ids.length ? new Set(ids) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
