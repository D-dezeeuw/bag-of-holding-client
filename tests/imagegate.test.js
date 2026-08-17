import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_TIERS, DEFAULT_IMAGE_TIER, GRANT_TTL_MS, tierPolicy,
  emptyImageGate, normalizeImageGate, rollImageWindow,
  enableImages, disableImages, canRenderImage, imageGateStatus,
  spendImageRender, refundImageRender, isGrantExpired, composeImagePrompt,
} from '../src/llm/imagegate.js';

const T0 = 1_700_000_000_000;   // fixed clock — the module never reads one itself

describe('the gate starts shut', () => {
  it('a fresh gate is disabled and carries the free tier policy', () => {
    const gate = emptyImageGate();
    assert.equal(gate.enabled, false);
    assert.equal(gate.tier, DEFAULT_IMAGE_TIER);
    assert.equal(gate.budget, IMAGE_TIERS.free.budget);
    assert.equal(canRenderImage(gate, T0).reason, 'disabled');
  });

  it('an unknown tier falls back to free rather than throwing', () => {
    assert.equal(emptyImageGate({ tier: 'legendary' }).tier, DEFAULT_IMAGE_TIER);
    assert.equal(tierPolicy('legendary'), IMAGE_TIERS.free);
    assert.equal(tierPolicy('patron'), IMAGE_TIERS.patron);
  });
});

describe('spending', () => {
  it('a spend consumes budget, stamps the clock and mints a grant', () => {
    const gate = enableImages(emptyImageGate(), {});
    const out = spendImageRender(gate, T0, { prompt: 'a lantern in fog' });
    assert.equal(out.ok, true);
    assert.equal(out.gate.spent, 1);
    assert.equal(out.gate.renders, 1);
    assert.equal(out.remaining, IMAGE_TIERS.free.budget - 1);
    assert.equal(out.grant.prompt, 'a lantern in fog');
    assert.equal(out.grant.expiresAt, T0 + GRANT_TTL_MS);
    assert.equal(out.grant.prevRenderAt, 0);
  });

  it('refuses while the cooldown runs, and says when to retry', () => {
    const first = spendImageRender(enableImages(emptyImageGate(), {}), T0, {});
    const soon = spendImageRender(first.gate, T0 + 1_000, {});
    assert.equal(soon.ok, false);
    assert.equal(soon.reason, 'cooldown');
    assert.equal(soon.retryInMs, IMAGE_TIERS.free.cooldownMs - 1_000);
    assert.equal(soon.gate.spent, 1, 'a refused call spends nothing');
    assert.equal(soon.grant, null);

    const later = spendImageRender(first.gate, T0 + IMAGE_TIERS.free.cooldownMs, {});
    assert.equal(later.ok, true);
    assert.equal(later.gate.spent, 2);
  });

  it('refuses once the window budget is gone, and refills on the clock', () => {
    const { budget, cooldownMs, windowMs } = IMAGE_TIERS.free;
    let gate = enableImages(emptyImageGate(), {});
    let now = T0;
    for (let i = 0; i < budget; i++) {
      const out = spendImageRender(gate, now, {});
      assert.equal(out.ok, true, `render ${i + 1} of ${budget} should pass`);
      gate = out.gate;
      now += cooldownMs;
    }
    const dry = spendImageRender(gate, now, {});
    assert.equal(dry.ok, false);
    assert.equal(dry.reason, 'budget');
    assert.equal(dry.remaining, 0);
    assert.ok(dry.resetsInMs > 0);

    const refilled = spendImageRender(gate, T0 + windowMs, {});
    assert.equal(refilled.ok, true);
    assert.equal(refilled.gate.spent, 1);
    assert.equal(refilled.gate.renders, budget + 1, 'lifetime count survives the roll');
  });

  it('a refund gives back exactly one render and restores the cooldown', () => {
    const first = spendImageRender(enableImages(emptyImageGate(), {}), T0, {});
    const second = spendImageRender(first.gate, T0 + IMAGE_TIERS.free.cooldownMs, {});
    const back = refundImageRender(second.gate, second.grant);
    assert.deepEqual(
      { spent: back.spent, renders: back.renders, lastRenderAt: back.lastRenderAt },
      { spent: 1, renders: 1, lastRenderAt: T0 },
      'the failed render is undone, including its cooldown stamp'
    );
    // Refunding a gate that never spent must not go negative.
    const floor = refundImageRender(emptyImageGate(), null);
    assert.equal(floor.spent, 0);
    assert.equal(floor.renders, 0);
    assert.equal(floor.lastRenderAt, 0);
  });

  it('grants expire, so an unredeemed one cannot be hoarded', () => {
    const { grant } = spendImageRender(enableImages(emptyImageGate(), {}), T0, {});
    assert.equal(isGrantExpired(grant, T0 + GRANT_TTL_MS - 1), false);
    assert.equal(isGrantExpired(grant, T0 + GRANT_TTL_MS), true);
    assert.equal(isGrantExpired(null, T0), true);
    assert.equal(isGrantExpired({ id: 'x' }, T0), true);
  });
});

describe('toggling cannot launder the budget', () => {
  it('enable/disable/enable keeps the spend counters', () => {
    const spent = spendImageRender(enableImages(emptyImageGate(), {}), T0, {}).gate;
    const cycled = enableImages(disableImages(spent), {});
    assert.equal(cycled.enabled, true);
    assert.equal(cycled.spent, 1);
    assert.equal(cycled.windowStart, T0, 'the window keeps running through the toggle');
  });

  it('enable can tighten the allowance but never raise it above the tier', () => {
    assert.equal(enableImages(emptyImageGate(), { budget: 2 }).budget, 2);
    assert.equal(enableImages(emptyImageGate(), { budget: 999 }).budget, IMAGE_TIERS.free.budget);
    assert.equal(enableImages(emptyImageGate(), { budget: 0 }).budget, 1);
    assert.equal(enableImages(emptyImageGate(), { budget: -5 }).budget, IMAGE_TIERS.free.budget);
    assert.equal(enableImages(emptyImageGate(), { tier: 'patron' }).budget, IMAGE_TIERS.patron.budget);
  });

  it('disabling keeps the spend so it is not a free reset either', () => {
    const spent = spendImageRender(enableImages(emptyImageGate(), {}), T0, {}).gate;
    assert.equal(disableImages(spent).spent, 1);
  });
});

describe('normalizing what came off disk', () => {
  it('heals junk back to a shut gate', () => {
    for (const junk of [null, undefined, 'nope', 42]) {
      assert.deepEqual(normalizeImageGate(junk), emptyImageGate());
    }
  });

  it('clamps a hand-edited file to the tier policy', () => {
    const tampered = normalizeImageGate({
      enabled: true, tier: 'free', budget: 9999, spent: -50,
      windowMs: 1, cooldownMs: 0, renders: -3, lastRenderAt: 'soon',
    });
    assert.equal(tampered.budget, IMAGE_TIERS.free.budget);
    assert.equal(tampered.spent, 0);
    assert.equal(tampered.windowMs, IMAGE_TIERS.free.windowMs, 'a shorter window would mean faster refills');
    assert.equal(tampered.cooldownMs, IMAGE_TIERS.free.cooldownMs);
    assert.equal(tampered.renders, 0);
    assert.equal(tampered.lastRenderAt, 0);
    assert.equal(tampered.enabled, true, 'only the numbers are suspect, not the toggle');
  });

  it('accepts stricter-than-policy pacing and a spend inside the budget', () => {
    const strict = normalizeImageGate({
      enabled: true, spent: 2, windowMs: IMAGE_TIERS.free.windowMs * 3,
      cooldownMs: 90_000, windowStart: T0, lastRenderAt: T0, renders: 2,
    });
    assert.equal(strict.spent, 2);
    assert.equal(strict.windowMs, IMAGE_TIERS.free.windowMs * 3);
    assert.equal(strict.cooldownMs, 90_000);
  });

  it('an explicit tier overrides the stored one (the host owns tiering)', () => {
    const upgraded = normalizeImageGate({ tier: 'free', budget: 6 }, { tier: 'patron' });
    assert.equal(upgraded.tier, 'patron');
    assert.equal(upgraded.budget, 6, 'the stored, tighter budget survives the upgrade');
  });
});

describe('status and window rolls', () => {
  it('status reads without spending and reports the whole policy', () => {
    const gate = enableImages(emptyImageGate(), {});
    const before = imageGateStatus(gate, T0);
    assert.equal(before.ready, true);
    assert.equal(before.reason, 'ok');
    assert.equal(before.remaining, IMAGE_TIERS.free.budget);
    assert.equal(before.spent, 0);
    assert.equal(imageGateStatus(gate, T0).remaining, before.remaining, 'reading twice costs nothing');

    const after = imageGateStatus(spendImageRender(gate, T0, {}).gate, T0 + 1);
    assert.equal(after.ready, false);
    assert.equal(after.reason, 'cooldown');
    assert.equal(after.renders, 1);
    assert.equal(after.windowMs, IMAGE_TIERS.free.windowMs);
  });

  it('an untouched gate is already refilled when it is next read', () => {
    const spent = spendImageRender(enableImages(emptyImageGate(), {}), T0, {}).gate;
    const rolled = rollImageWindow(spent, T0 + IMAGE_TIERS.free.windowMs);
    assert.equal(rolled.spent, 0);
    assert.equal(rolled.windowStart, T0 + IMAGE_TIERS.free.windowMs);
    // Inside the window nothing moves.
    assert.equal(rollImageWindow(spent, T0 + 1).windowStart, T0);
  });
});

describe('composeImagePrompt', () => {
  it('builds one art-direction block from the scene', () => {
    const prompt = composeImagePrompt({
      scene: '  A drowned chapel at low tide, bells still ringing under water.  ',
      subject: 'the bell tower', tone: 'grim', style: 'ink and wash', aspect: '1:1',
    });
    assert.match(prompt, /Scene: A drowned chapel at low tide/);
    assert.match(prompt, /Focus on: the bell tower/);
    assert.match(prompt, /Mood: grim\./);
    assert.match(prompt, /Style: ink and wash\./);
    assert.match(prompt, /Aspect ratio 1:1\./);
    assert.match(prompt, /No text/);
  });

  it('falls back to the house style and 16:9 when unguided', () => {
    const prompt = composeImagePrompt({ scene: 'A crossroads gallows in the rain.' });
    assert.match(prompt, /Style: digital painting/);
    assert.match(prompt, /Aspect ratio 16:9/);
    assert.ok(!prompt.includes('Focus on:'));
    assert.ok(!prompt.includes('Mood:'));
  });

  it('refuses an empty scene — a blank prompt is a wasted render', () => {
    for (const scene of [undefined, '', '   ', 42]) {
      assert.throws(() => composeImagePrompt({ scene }), /needs a `scene`/);
    }
    assert.throws(() => composeImagePrompt(), /needs a `scene`/);
  });
});

describe('grant ids', () => {
  test('the default id stays derived from the counters, so replays match', () => {
    const gate = enableImages(emptyImageGate(), {});
    const first = spendImageRender(gate, T0, {});
    assert.equal(first.grant.id, 'g-1-' + T0);
    const second = spendImageRender(first.gate, T0 + IMAGE_TIERS.free.cooldownMs, {});
    assert.equal(second.grant.id, 'g-2-' + (T0 + IMAGE_TIERS.free.cooldownMs));
  });

  test('a caller can mint unguessable ids without giving up determinism for everyone', () => {
    // A predictable grant id is a forgeable one as soon as a server mints
    // grants for more than one tenant. Browser hosts keep the deterministic
    // default; a multi-tenant server passes its own source.
    const seen = [];
    const gate = enableImages(emptyImageGate(), {});
    const out = spendImageRender(gate, T0, {
      prompt: 'a lantern in fog',
      mintId: (ctx) => { seen.push(ctx); return 'grant_2f7c9a'; },
    });
    assert.equal(out.grant.id, 'grant_2f7c9a');
    assert.deepEqual(seen, [{ renders: 1, now: T0 }]);
    // Everything else about the grant is unchanged.
    assert.equal(out.grant.prompt, 'a lantern in fog');
    assert.equal(out.grant.issuedAt, T0);
    assert.ok(out.grant.expiresAt > T0);
  });

  test('a minter returning a non-string is coerced rather than trusted', () => {
    const out = spendImageRender(enableImages(emptyImageGate(), {}), T0, { mintId: () => 12345 });
    assert.equal(out.grant.id, '12345');
    assert.equal(typeof out.grant.id, 'string');
  });

  test('a refused spend mints nothing at all', () => {
    let called = 0;
    const disabled = emptyImageGate();
    const out = spendImageRender(disabled, T0, { mintId: () => { called += 1; return 'x'; } });
    assert.equal(out.grant, null);
    assert.equal(called, 0, 'no render, no id, no cost');
  });
});
