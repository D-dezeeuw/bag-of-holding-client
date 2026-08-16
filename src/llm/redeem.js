// === Browser grant redemption (closing the keyless-deployment gap) ===
//
// On a keyless MCP server, image_observe spends a render slot and hands
// back a GRANT — a promise-to-render with a prompt and a five-minute
// TTL — tagged `renderer: 'host'`. Until now no shipped host redeemed
// one: the flagship flow's default deployment ended at a prompt string.
// This module is the redemption counter.
//
//   const result = await redeemImageGrant(config, grant);
//   // → { ok: true, image, grantId }                    picture delivered
//   // → { ok: false, reason, refundable: true|false }   tell the server
//
// The refund contract mirrors the gate's design: a player who got no
// picture should not have paid for one. `refundable: true` means the
// host should hand the grant back through the server's refund path
// (the MCP refunds on the failure path of the call that spent); an
// EXPIRED grant is `refundable: false` because expiry is the gate's
// own anti-hoarding rule doing its job — the spend already refunded
// server-side when the TTL lapsed.

import { generateImage } from './image.js';

/** Is the grant still alive at `now`? Malformed grants are dead. */
export function grantIsLive(grant, now = Date.now()) {
  return Boolean(grant
    && typeof grant.id === 'string'
    && typeof grant.prompt === 'string' && grant.prompt.length > 0
    && Number.isFinite(grant.expiresAt)
    && now < grant.expiresAt);
}

/**
 * Redeem a render grant against the configured image provider.
 * Pure-ish: all I/O flows through `generate` (injectable for tests;
 * defaults to the real generateImage).
 */
export async function redeemImageGrant(config, grant, {
  now = Date.now(), model, generate = generateImage,
} = {}) {
  if (!grant || typeof grant !== 'object') {
    return { ok: false, reason: 'no grant to redeem', refundable: false };
  }
  if (!grantIsLive(grant, now)) {
    return {
      ok: false,
      reason: 'grant expired (the gate refunds lapsed grants server-side)',
      refundable: false,
      grantId: typeof grant.id === 'string' ? grant.id : null,
    };
  }
  const image = await generate(config, { prompt: grant.prompt, model });
  if (!image) {
    // Provider error, no model configured, or an imageless response —
    // the render did not happen, so the spend should come back.
    return { ok: false, reason: 'render failed', refundable: true, grantId: grant.id };
  }
  return { ok: true, image, grantId: grant.id };
}
