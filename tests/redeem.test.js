// Browser grant redemption. What must hold: a live grant renders
// through the provider and returns the picture with its grant id; an
// expired or malformed grant refuses WITHOUT calling the provider
// (refundable: false — expiry refunds server-side); a failed render is
// refundable: true; and the flow composes with the real imagegate —
// spend → grant → redeem round-trips.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grantIsLive, redeemImageGrant } from '../src/llm/redeem.js';
import { emptyImageGate, enableImages, spendImageRender } from '../src/llm/imagegate.js';

const NOW = 1_000_000;

test('a live grant renders and returns the picture with its id', async () => {
  const calls = [];
  const generate = async (config, args) => { calls.push(args); return 'data:image/png;base64,abc'; };
  const grant = { id: 'g-1-999', prompt: 'a hush lantern in a drowned chancel', issuedAt: NOW, expiresAt: NOW + 60_000 };
  const result = await redeemImageGrant({ apiKey: 'k' }, grant, { now: NOW + 1000, generate });
  assert.deepEqual(result, { ok: true, image: 'data:image/png;base64,abc', grantId: 'g-1-999' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, grant.prompt);
});

test('expired and malformed grants refuse WITHOUT touching the provider', async () => {
  let touched = false;
  const generate = async () => { touched = true; return 'data:x'; };
  const stale = { id: 'g-2', prompt: 'p', expiresAt: NOW - 1 };
  const result = await redeemImageGrant({}, stale, { now: NOW, generate });
  assert.equal(result.ok, false);
  assert.equal(result.refundable, false, 'expiry refunds server-side; no double refund');
  assert.match(result.reason, /expired/);
  assert.equal(result.grantId, 'g-2');
  assert.equal((await redeemImageGrant({}, null, { generate })).refundable, false);
  assert.equal((await redeemImageGrant({}, { id: 'g-3', prompt: '' , expiresAt: NOW + 1}, { now: NOW, generate })).ok, false);
  assert.equal(touched, false, 'the provider was never called');
  // grantIsLive is the same verdict, exported for host UI countdowns.
  assert.equal(grantIsLive(stale, NOW), false);
  assert.equal(grantIsLive({ id: 'g', prompt: 'p', expiresAt: NOW + 1 }, NOW), true);
});

test('a failed render is refundable — the player paid for no picture', async () => {
  const generate = async () => null;
  const grant = { id: 'g-4', prompt: 'p', expiresAt: NOW + 60_000 };
  const result = await redeemImageGrant({}, grant, { now: NOW, generate });
  assert.deepEqual(result, { ok: false, reason: 'render failed', refundable: true, grantId: 'g-4' });
});

test('spend → grant → redeem round-trips against the real gate', async () => {
  const gate = enableImages(emptyImageGate(), { tier: 'standard' });
  const spend = spendImageRender(gate, NOW, { prompt: 'the tower voice mid-verse' });
  assert.equal(spend.ok, true);
  assert.ok(spend.grant.expiresAt > NOW);
  const generate = async (config, args) => `rendered:${args.prompt}`;
  const result = await redeemImageGrant({}, spend.grant, { now: NOW + 1, generate });
  assert.equal(result.ok, true);
  assert.equal(result.image, 'rendered:the tower voice mid-verse');
  assert.equal(result.grantId, spend.grant.id);
});
