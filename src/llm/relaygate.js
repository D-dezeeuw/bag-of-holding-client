// src/llm/relaygate.js — the budget math for *relayed* inference.
//
// `imagegate.js` decides whether a picture may be made. This decides whether a
// text turn may be paid for by someone other than the player: a deployment that
// holds the provider key and lets a tenant token spend against it.
//
// Why this exists at all. The browser client is BYOK by construction — the key
// is the player's, and every turn bills their account. A hosted deployment
// inverts that: the operator holds one provider key and issues tenant tokens,
// so the credential a player pastes is no longer an inference credential and
// the spend is no longer theirs. Something has to say how much a token may
// spend, and it cannot be the browser (a bundle keeps no secrets and enforces
// no ceiling) — so the rules live here, pure, and the *server* applies them.
//
// The same reasoning as the image gate, one layer over: both hosts must answer
// "may this cost money?" identically, so the answer is one implementation with
// no transport in it. The difference is *when* the cost is known. A render is
// one unit decided up front, so the image gate spends then refunds on failure.
// A completion's cost arrives with the response, so this gate checks first and
// charges after:
//
//   canRelay(budget, now)            → may a call start at all?
//   chargeRelay(budget, tokens, now) → record what it actually cost
//
// That ordering means a single turn can overshoot the window's allowance (the
// check passed with 40 tokens left, the answer cost 900). That is deliberate:
// the alternative is refusing to start a turn whose price nobody knows yet, or
// cutting a narration off mid-sentence. The overshoot is bounded by one call
// and is carried — `spent` is never clamped back down to `budget`, so the next
// window pays it no mind but the current one does not forgive it either.
//
// Everything here is pure: functions take a budget object and `now`, and return
// a new one. The host owns persistence (a JSON file per tenant on the server, a
// row in a database, whatever) and the clock.

/**
 * Tier → allowance, in provider tokens per rolling window.
 *
 * The vocabulary is deliberately the image gate's — `free` / `patron` /
 * `studio` are what the admin panel already writes into the tenant registry,
 * and a second set of tier names for the same tenants would be a mapping table
 * nobody maintains.
 *
 * The numbers are sized in *turns*, because that is the unit a player feels. A
 * narration turn costs roughly 1.5–3k tokens all in (scope packet in, prose
 * out), so `free` is about a long evening's play, `patron` a month of it, and
 * `studio` a table that plays every night with images on. They are a starting
 * point an operator can override per deployment, not a pricing promise.
 */
export const RELAY_TIERS = Object.freeze({
  free:   Object.freeze({ budget:    150_000, windowMs: 24 * 60 * 60 * 1000 }),
  patron: Object.freeze({ budget:  2_000_000, windowMs: 24 * 60 * 60 * 1000 }),
  studio: Object.freeze({ budget: 10_000_000, windowMs: 24 * 60 * 60 * 1000 }),
});

export const DEFAULT_RELAY_TIER = 'free';

const RELAY_VERSION = 1;

/** Tier record lookup, falling back to `free` for anything unrecognised. */
export function relayTierPolicy(tier) {
  return RELAY_TIERS[tier] ?? RELAY_TIERS[DEFAULT_RELAY_TIER];
}

const int = (value, fallback) =>
  (Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);

/** A fresh budget for a tier — the state a tenant starts in. */
export function emptyRelayBudget({ tier = DEFAULT_RELAY_TIER } = {}) {
  const named  = RELAY_TIERS[tier] ? tier : DEFAULT_RELAY_TIER;
  const policy = relayTierPolicy(named);
  return {
    v: RELAY_VERSION,
    tier: named,
    budget: policy.budget,
    windowMs: policy.windowMs,
    spent: 0,             // tokens charged inside the current window
    windowStart: 0,
    calls: 0,             // lifetime counter — survives window rolls
    tokens: 0,            // lifetime tokens — what an operator bills against
  };
}

/**
 * Coerce whatever came off disk into a usable budget.
 *
 * The allowance is NOT read from the file. `budget` and `windowMs` are derived
 * from the tier on every read and the persisted values are ignored, so the file
 * holds only what actually accumulates: spend counters and the window clock.
 * Two things follow, and both are the point:
 *
 *   • a hand-edited `budget: 99999999` buys nothing — the ceiling is whatever
 *     the tenant registry says the tier is;
 *   • a tier change lands on the next call in both directions. The image gate
 *     lets a persisted budget only ever *tighten*, because there a host may
 *     deliberately ask for a smaller allowance ("three pictures tonight"). No
 *     such knob exists here, so that rule would have silently pinned an
 *     upgraded tenant to the ceiling they had when the file was written.
 *
 * `spent` is clamped only against negatives, never down to the ceiling: a
 * downgrade must not be an amnesty for spend already booked in this window.
 */
export function normalizeRelayBudget(raw, { tier } = {}) {
  const base = emptyRelayBudget({ tier: tier ?? raw?.tier });
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    spent:       int(raw.spent, 0),
    windowStart: int(raw.windowStart, 0),
    calls:       int(raw.calls, 0),
    tokens:      int(raw.tokens, 0),
  };
}

/**
 * Roll the window forward if it has elapsed. Applied on every read as well as
 * every write, so a tenant who stopped playing yesterday is already refilled
 * the moment they are next looked at — no timer anywhere.
 */
export function rollRelayWindow(budget, now) {
  const b = normalizeRelayBudget(budget);
  if (b.windowStart === 0 || now - b.windowStart >= b.windowMs) {
    return { ...b, spent: 0, windowStart: now };
  }
  return b;
}

/**
 * May a relayed call start right now?
 *
 * Returns a verdict rather than a boolean so the server can tell the player
 * when to come back: `{ ok: false, reason: 'budget', resetsInMs }` becomes the
 * `Retry-After` on a 429, which the client library already treats as a
 * retryable, model-swappable error.
 */
export function canRelay(budget, now) {
  const b = rollRelayWindow(budget, now);
  const remaining  = Math.max(0, b.budget - b.spent);
  const resetsInMs = Math.max(0, b.windowStart + b.windowMs - now);
  if (remaining <= 0) return { ok: false, reason: 'budget', remaining, resetsInMs };
  return { ok: true, reason: 'ok', remaining, resetsInMs };
}

/**
 * Charge a completed call. `tokens` is what the provider reported it cost —
 * pass 0 when the provider reported nothing rather than guessing, so a
 * usage-less response is visible as a call with no tokens instead of a made-up
 * number in someone's bill.
 *
 * Charging is unconditional: this runs after the money is already spent, so
 * refusing to record it would only hide the overshoot.
 */
export function chargeRelay(budget, tokens, now) {
  const b = rollRelayWindow(budget, now);
  const n = int(tokens, 0);
  return {
    ...b,
    spent:  b.spent + n,
    calls:  b.calls + 1,
    tokens: b.tokens + n,
  };
}

/**
 * A read-only snapshot for status displays. Writes nothing and spends nothing —
 * asking how much is left must never cost anything.
 */
export function relayBudgetStatus(budget, now) {
  const b = rollRelayWindow(budget, now);
  const verdict = canRelay(b, now);
  return {
    tier: b.tier,
    budget: b.budget,
    spent: b.spent,
    remaining: verdict.remaining,
    windowMs: b.windowMs,
    resetsInMs: verdict.resetsInMs,
    calls: b.calls,
    tokens: b.tokens,
    ready: verdict.ok,
    reason: verdict.reason,
  };
}
