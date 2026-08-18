import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RELAY_TIERS, DEFAULT_RELAY_TIER, relayTierPolicy,
  emptyRelayBudget, normalizeRelayBudget, rollRelayWindow,
  canRelay, chargeRelay, relayBudgetStatus,
} from '../src/llm/relaygate.js';

const T0 = 1_700_000_000_000;   // fixed clock — the module never reads one itself
const DAY = 24 * 60 * 60 * 1000;

describe('a fresh budget', () => {
  it('carries the free tier policy and is ready to spend', () => {
    const b = emptyRelayBudget();
    assert.equal(b.tier, DEFAULT_RELAY_TIER);
    assert.equal(b.budget, RELAY_TIERS.free.budget);
    assert.equal(b.spent, 0);
    assert.equal(canRelay(b, T0).ok, true);
  });

  it('an unknown tier falls back to free rather than throwing', () => {
    assert.equal(emptyRelayBudget({ tier: 'legendary' }).tier, DEFAULT_RELAY_TIER);
    assert.equal(relayTierPolicy('legendary'), RELAY_TIERS.free);
    assert.equal(relayTierPolicy('studio'), RELAY_TIERS.studio);
  });
});

describe('charging', () => {
  it('records what a call cost, in the window and for all time', () => {
    const b = chargeRelay(emptyRelayBudget(), 2_400, T0);
    assert.equal(b.spent, 2_400);
    assert.equal(b.tokens, 2_400);
    assert.equal(b.calls, 1);
    assert.equal(canRelay(b, T0).remaining, RELAY_TIERS.free.budget - 2_400);
  });

  it('a usage-less response is a call with no tokens, not a guess', () => {
    const b = chargeRelay(emptyRelayBudget(), undefined, T0);
    assert.equal(b.calls, 1);
    assert.equal(b.spent, 0);
    assert.equal(b.tokens, 0);
  });

  it('refuses once the window allowance is gone, and says when it refills', () => {
    const spent = chargeRelay(emptyRelayBudget(), RELAY_TIERS.free.budget, T0);
    const verdict = canRelay(spent, T0 + 1_000);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'budget');
    assert.equal(verdict.remaining, 0);
    assert.equal(verdict.resetsInMs, DAY - 1_000);
  });

  it('refills on the clock, not on a reload', () => {
    const spent = chargeRelay(emptyRelayBudget(), RELAY_TIERS.free.budget, T0);
    assert.equal(canRelay(spent, T0 + DAY).ok, true);
    assert.equal(rollRelayWindow(spent, T0 + DAY).spent, 0);
    // Lifetime counters survive the roll — they are what an operator bills on.
    assert.equal(rollRelayWindow(spent, T0 + DAY).tokens, RELAY_TIERS.free.budget);
  });

  it('one call may overshoot the allowance, and the overshoot is carried', () => {
    // The check passes with a sliver left; the answer costs far more than that.
    const nearly = chargeRelay(emptyRelayBudget(), RELAY_TIERS.free.budget - 40, T0);
    assert.equal(canRelay(nearly, T0).ok, true, 'a sliver of budget still starts a turn');
    const over = chargeRelay(nearly, 900, T0);
    assert.equal(over.spent, RELAY_TIERS.free.budget + 860);
    assert.equal(canRelay(over, T0).ok, false, 'the next call is refused');
    // …and a reload does not forgive it.
    assert.equal(normalizeRelayBudget(over).spent, over.spent);
  });
});

describe('a budget read off disk is not trusted', () => {
  it('a hand-edited ceiling buys nothing', () => {
    const b = normalizeRelayBudget({ tier: 'free', budget: 99_999_999, windowMs: 1_000, spent: 0 });
    assert.equal(b.budget, RELAY_TIERS.free.budget);
    assert.equal(b.windowMs, RELAY_TIERS.free.windowMs, 'a shorter window would mean more tokens per hour');
  });

  it('nonsense heals to a fresh budget instead of throwing', () => {
    for (const raw of [null, undefined, 'nope', 42, []]) {
      assert.equal(normalizeRelayBudget(raw).budget, RELAY_TIERS.free.budget);
    }
    assert.equal(normalizeRelayBudget({ spent: -50 }).spent, 0, 'negative spend must not mint tokens');
  });

  it('a downgrade applies the new ceiling and keeps the spend', () => {
    const rich = chargeRelay(emptyRelayBudget({ tier: 'studio' }), 900_000, T0);
    const poor = normalizeRelayBudget(rich, { tier: 'free' });
    assert.equal(poor.tier, 'free');
    assert.equal(poor.budget, RELAY_TIERS.free.budget);
    assert.equal(poor.spent, 900_000, 'a downgrade is not an amnesty');
    assert.equal(canRelay(poor, T0).ok, false);
  });

  it('a tier upgrade lifts the ceiling on the next read', () => {
    const b = normalizeRelayBudget(chargeRelay(emptyRelayBudget(), 150_000, T0), { tier: 'patron' });
    assert.equal(b.budget, RELAY_TIERS.patron.budget);
    assert.equal(canRelay(b, T0).ok, true);
  });
});

describe('status', () => {
  it('reports the policy that produced the verdict, and spends nothing', () => {
    const b = chargeRelay(emptyRelayBudget({ tier: 'patron' }), 1_000, T0);
    const s = relayBudgetStatus(b, T0 + 60_000);
    assert.equal(s.tier, 'patron');
    assert.equal(s.budget, RELAY_TIERS.patron.budget);
    assert.equal(s.spent, 1_000);
    assert.equal(s.remaining, RELAY_TIERS.patron.budget - 1_000);
    assert.equal(s.calls, 1);
    assert.equal(s.ready, true);
    assert.equal(s.reason, 'ok');
    assert.equal(s.resetsInMs, DAY - 60_000);
    // Reading twice changes nothing.
    assert.deepEqual(relayBudgetStatus(b, T0 + 60_000), s);
  });
});
