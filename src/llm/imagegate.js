// src/llm/imagegate.js — the permission + budget math for scene images.
//
// `image.js` knows how to *make* an image. This module decides whether one may
// be made at all, and composes the art-direction prompt. It is deliberately
// separate, pure, and free of transport: two very different hosts have to agree
// on the same answer — the browser client, which owns the API key and renders
// inline, and the MCP server, where the DM model asks for a picture on the
// player's behalf. Same rules, one implementation, no drift.
//
// The problem being solved is not cost alone; it is *cadence*. A model with an
// image tool and no gate illustrates every paragraph. So:
//
//   • images are OFF until someone turns them on (a player action, never a
//     model's initiative);
//   • once on, a tier grants N renders per rolling window, plus a cooldown so
//     a single scene can't be re-rolled ten times;
//   • enabling again does not launder spend — the window refills on the clock,
//     not on a toggle, so "turn it off and on again" buys nothing.
//
// Everything here is pure: functions take a gate object and `now`, and return a
// new gate. The host owns persistence (localStorage, IndexedDB, a JSON file on
// the MCP server's disk) and the clock.

/**
 * Tier → allowance. `free` is what everyone gets today; the richer tiers exist
 * because the hosted story is "a billing site mints a token, the token names a
 * tier" — the seam is here so that later change is a lookup, not a redesign.
 * A tier is chosen by the *host* from its own config; it is never something a
 * model or a player can pass in, which is why `enableImages` ignores any tier
 * on the input gate that isn't in this table.
 */
export const IMAGE_TIERS = Object.freeze({
  free:   Object.freeze({ budget:  6, windowMs: 60 * 60 * 1000, cooldownMs: 45_000 }),
  patron: Object.freeze({ budget: 40, windowMs: 60 * 60 * 1000, cooldownMs: 10_000 }),
  studio: Object.freeze({ budget: 200, windowMs: 60 * 60 * 1000, cooldownMs: 5_000 }),
});

export const DEFAULT_IMAGE_TIER = 'free';

// A grant is a promise to render one image, handed to whoever owns the pixels.
// It expires because an unredeemed grant is spent budget: without a TTL a host
// could hoard grants all session and cash them in at once, which is exactly the
// burst the budget exists to prevent.
export const GRANT_TTL_MS = 5 * 60 * 1000;

const GATE_VERSION = 1;

/** Tier record lookup, falling back to `free` for anything unrecognised. */
export function tierPolicy(tier) {
  return IMAGE_TIERS[tier] ?? IMAGE_TIERS[DEFAULT_IMAGE_TIER];
}

/**
 * A fresh, disabled gate for a tier. This is the state a campaign starts in and
 * the state anything unparseable heals back to.
 */
export function emptyImageGate({ tier = DEFAULT_IMAGE_TIER } = {}) {
  const named  = IMAGE_TIERS[tier] ? tier : DEFAULT_IMAGE_TIER;
  const policy = tierPolicy(named);
  return {
    v: GATE_VERSION,
    enabled: false,
    tier: named,
    budget: policy.budget,
    windowMs: policy.windowMs,
    cooldownMs: policy.cooldownMs,
    spent: 0,
    windowStart: 0,
    lastRenderAt: 0,
    renders: 0,          // lifetime counter — survives window rolls, never resets
  };
}

const int = (value, fallback) =>
  (Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);

/**
 * Coerce whatever came off disk into a usable gate.
 *
 * Persisted state is attacker-adjacent (a hand-edited file, a truncated write,
 * an older schema) and a gate that throws would take the whole campaign with
 * it. Unknown fields are dropped, out-of-range numbers snap back to the tier's
 * policy, and the spend counters are clamped rather than trusted — a file
 * claiming `spent: -50` must not mint 50 free renders. Ceilings come from the
 * tier, so editing `budget: 9999` into the file buys nothing either.
 */
export function normalizeImageGate(raw, { tier } = {}) {
  const base   = emptyImageGate({ tier: tier ?? raw?.tier });
  if (!raw || typeof raw !== 'object') return base;
  const policy = tierPolicy(base.tier);
  const budget = Math.min(int(raw.budget, policy.budget), policy.budget);
  return {
    ...base,
    enabled: raw.enabled === true,
    budget,
    // Pacing knobs may only get stricter than the tier's — a longer window and
    // a longer cooldown both mean fewer pictures per hour, so `max` is the
    // conservative direction for each.
    windowMs:   Math.max(int(raw.windowMs, policy.windowMs), policy.windowMs),
    cooldownMs: Math.max(int(raw.cooldownMs, policy.cooldownMs), policy.cooldownMs),
    spent:        Math.min(int(raw.spent, 0), budget),
    windowStart:  int(raw.windowStart, 0),
    lastRenderAt: int(raw.lastRenderAt, 0),
    renders:      int(raw.renders, 0),
  };
}

/**
 * Roll the spend window forward if it has elapsed. Pure, and applied on every
 * read as well as every write: a gate sitting untouched on disk for two hours
 * is already refilled the moment it is next looked at, with no timer anywhere.
 */
export function rollImageWindow(gate, now) {
  const g = normalizeImageGate(gate);
  if (g.windowStart === 0 || now - g.windowStart >= g.windowMs) {
    return { ...g, spent: 0, windowStart: now };
  }
  return g;
}

/**
 * Turn images on. `budget` may only tighten the tier's allowance (a host
 * wanting "three pictures tonight" gets it); it can never raise it, and it
 * never clears `spent`, so toggling is not a refill. Returns a new gate.
 */
export function enableImages(gate, { tier, budget } = {}) {
  const g = normalizeImageGate(gate, { tier });
  const policy = tierPolicy(g.tier);
  const asked = budget === undefined || budget === null ? policy.budget : int(budget, policy.budget);
  return { ...g, enabled: true, budget: Math.max(1, Math.min(asked, policy.budget)) };
}

/** Turn images off. Spend counters are kept — disabling is not a refill either. */
export function disableImages(gate) {
  return { ...normalizeImageGate(gate), enabled: false };
}

/**
 * May a render happen right now? Returns a verdict object rather than a boolean
 * so a host can tell the player *why* not, and when to come back:
 *
 *   { ok: false, reason: 'disabled' | 'budget' | 'cooldown', … }
 *
 * `remaining`, `resetsInMs` and `retryInMs` are always present so a UI (or a
 * tool response) can render the same sentence for every outcome.
 */
export function canRenderImage(gate, now) {
  const g = rollImageWindow(gate, now);
  const remaining  = Math.max(0, g.budget - g.spent);
  const resetsInMs = Math.max(0, g.windowStart + g.windowMs - now);
  const sinceLast  = g.lastRenderAt === 0 ? Infinity : now - g.lastRenderAt;
  const retryInMs  = sinceLast >= g.cooldownMs ? 0 : g.cooldownMs - sinceLast;

  if (!g.enabled) return { ok: false, reason: 'disabled', remaining, resetsInMs, retryInMs: 0 };
  if (remaining <= 0) return { ok: false, reason: 'budget', remaining, resetsInMs, retryInMs: resetsInMs };
  if (retryInMs > 0) return { ok: false, reason: 'cooldown', remaining, resetsInMs, retryInMs };
  return { ok: true, reason: 'ok', remaining, resetsInMs, retryInMs: 0 };
}

/**
 * A read-only snapshot for status displays: the verdict plus the policy that
 * produced it. Takes no lock and writes nothing — asking how many pictures are
 * left must never cost a picture.
 */
export function imageGateStatus(gate, now) {
  const g = rollImageWindow(gate, now);
  const verdict = canRenderImage(g, now);
  return {
    enabled: g.enabled,
    tier: g.tier,
    budget: g.budget,
    spent: g.spent,
    remaining: verdict.remaining,
    resetsInMs: verdict.resetsInMs,
    cooldownMs: g.cooldownMs,
    retryInMs: verdict.retryInMs,
    windowMs: g.windowMs,
    renders: g.renders,
    ready: verdict.ok,
    reason: verdict.reason,
  };
}

/**
 * Spend one render. Returns `{ ...verdict, gate, grant }`:
 *
 *   • refused → the gate comes back untouched and `grant` is null;
 *   • allowed → the gate has one more spent and `grant` carries the prompt,
 *     an id, and its expiry.
 *
 * The default grant id is derived from the counters rather than randomness,
 * keeping the whole module deterministic — the same reason the engine seeds
 * its dice. `prevRenderAt` rides along so a failed render can be refunded
 * exactly.
 *
 * That determinism also makes the id *guessable*, which is fine while the
 * gate is per-player and the grant never leaves the machine that minted it.
 * It stops being fine the moment a server mints grants for many tenants: a
 * predictable id is a forgeable one. Pass `mintId` to supply unguessable ids
 * (a server does; `crypto.randomUUID` is the obvious choice) without giving
 * up determinism for everyone who does not need it.
 *
 * @param {{ prompt?: string, mintId?: (ctx: { renders: number, now: number }) => string }} [opts]
 */
export function spendImageRender(gate, now, { prompt = '', mintId } = {}) {
  const g = rollImageWindow(gate, now);
  const verdict = canRenderImage(g, now);
  if (!verdict.ok) return { ...verdict, gate: g, grant: null };
  const next = { ...g, spent: g.spent + 1, lastRenderAt: now, renders: g.renders + 1 };
  return {
    ...verdict,
    remaining: Math.max(0, next.budget - next.spent),
    gate: next,
    grant: {
      id: typeof mintId === 'function'
        ? String(mintId({ renders: next.renders, now }))
        : `g-${next.renders}-${now}`,
      prompt,
      issuedAt: now,
      expiresAt: now + GRANT_TTL_MS,
      prevRenderAt: g.lastRenderAt,
    },
  };
}

/**
 * Give a spent render back — for when the provider errored, the request timed
 * out, or a grant expired unredeemed. A player who got no picture should not
 * have paid for one. Idempotency is the caller's problem (refunding the same
 * grant twice refunds twice), which is why the MCP tool refunds only on the
 * failure path of the call that spent.
 */
export function refundImageRender(gate, grant) {
  const g = normalizeImageGate(gate);
  return {
    ...g,
    spent: Math.max(0, g.spent - 1),
    renders: Math.max(0, g.renders - 1),
    lastRenderAt: int(grant?.prevRenderAt, 0),
  };
}

/** Has this grant timed out? Unredeemed-and-expired is refundable. */
export function isGrantExpired(grant, now) {
  return !grant || typeof grant.expiresAt !== 'number' || now >= grant.expiresAt;
}

// House style for scene art. Kept here rather than in the caller so every host
// asks for the same look — a campaign whose pictures drift in style each time
// reads as a slideshow of different games.
const BASE_STYLE = 'digital painting, painterly brushwork, dramatic natural light, cinematic composition, muted earthy palette';

// Image models happily render captions, borders and stray UI chrome when the
// prompt came from a chat transcript. Saying no once, here, beats every host
// rediscovering it.
const NEGATIVES = 'No text, letters, captions, watermarks, logos, borders, frames, UI, or speech bubbles.';

/**
 * Build one art-direction prompt from what the DM knows about the moment.
 *
 * `scene` is the only required part — a sentence or three of what is in front
 * of the players, in the present tense. `subject` narrows the focus (a face, a
 * doorway) when the scene text is broad, `tone` carries the campaign's mood,
 * and `style` overrides the house look entirely for a host that wants ink
 * sketches or 8-bit tiles.
 */
export function composeImagePrompt({ scene, subject, tone, style, aspect = '16:9' } = {}) {
  const text = typeof scene === 'string' ? scene.trim() : '';
  if (text === '') {
    throw new Error('composeImagePrompt needs a `scene` — a sentence or two describing what the players can see.');
  }
  const lines = [
    'A single illustrated moment from a tabletop fantasy roleplaying campaign.',
    `Scene: ${text}`,
  ];
  if (subject) lines.push(`Focus on: ${String(subject).trim()}`);
  if (tone)    lines.push(`Mood: ${String(tone).trim()}.`);
  lines.push(`Style: ${(style ? String(style).trim() : BASE_STYLE)}.`);
  lines.push(`Aspect ratio ${aspect}.`);
  lines.push(NEGATIVES);
  return lines.join('\n');
}
