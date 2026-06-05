import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure settlement helpers: trade math, quest state transitions, inventory ops,
// rest, and per-NPC dialogue memory. No I/O, no globals — exercise real code.
import {
  DEFAULT_START_GOLD, DEFAULT_REST_COST, DIALOGUE_MEMORY, SECRET_MIN_EXCHANGES,
  slug, goldOf, resolvePurchase, addToInventory, resolveRest,
  questId, makeQuest, addQuest, setQuestStatus, activeQuests,
  pushDialogue, canRevealSecret,
} from '../src/settlement/economy.js';

describe('goldOf / slug', () => {
  it('defaults missing gold to the starting amount', () => {
    assert.equal(goldOf({}), DEFAULT_START_GOLD);
    assert.equal(goldOf(null), DEFAULT_START_GOLD);
    assert.equal(goldOf({ gold: 0 }), 0);
    assert.equal(goldOf({ gold: 99 }), 99);
  });
  it('honours an injected start-gold default', () => {
    assert.equal(goldOf({}, 50), 50);
    assert.equal(goldOf({ gold: 7 }, 50), 7);
  });
  it('slugifies names', () => {
    assert.equal(slug('Healing Potion'), 'healing-potion');
    assert.equal(slug("Bera's Ale!"), 'bera-s-ale');
    assert.equal(slug(''), 'item');
  });
});

describe('resolvePurchase — trade math', () => {
  const item = { name: 'Healing Potion', price: 10, description: 'red' };

  it('succeeds and deducts gold when affordable', () => {
    const r = resolvePurchase({ gold: 25 }, item);
    assert.equal(r.ok, true);
    assert.equal(r.gold, 15);
    assert.equal(r.price, 10);
    assert.equal(r.item.name, 'Healing Potion');
    assert.equal(r.item.id, 'healing-potion');
    assert.equal(r.item.quantity, 1);
  });
  it('fails with the shortfall when too poor', () => {
    const r = resolvePurchase({ gold: 4 }, item);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'insufficient-gold');
    assert.equal(r.short, 6);
  });
  it('treats a missing price as free', () => {
    const r = resolvePurchase({ gold: 0 }, { name: 'Free Sample' });
    assert.equal(r.ok, true);
    assert.equal(r.gold, 0);
  });
  it('uses the starting gold default when the record has none', () => {
    const r = resolvePurchase({}, item);
    assert.equal(r.ok, true);
    assert.equal(r.gold, DEFAULT_START_GOLD - 10);
  });
  it('rejects a null item', () => {
    assert.equal(resolvePurchase({ gold: 99 }, null).ok, false);
  });
});

describe('addToInventory', () => {
  it('adds a new item', () => {
    const inv = addToInventory([], { id: 'rope', name: 'Rope' });
    assert.equal(inv.length, 1);
    assert.equal(inv[0].quantity, 1);
  });
  it('stacks quantity for an existing id', () => {
    let inv = addToInventory([], { id: 'potion', name: 'Potion', quantity: 1 });
    inv = addToInventory(inv, { id: 'potion', name: 'Potion', quantity: 1 });
    inv = addToInventory(inv, { id: 'potion', name: 'Potion', quantity: 2 });
    assert.equal(inv.length, 1);
    assert.equal(inv[0].quantity, 4);
  });
  it('does not mutate the input array', () => {
    const orig = [];
    addToInventory(orig, { id: 'x', name: 'X' });
    assert.equal(orig.length, 0);
  });
});

describe('resolveRest', () => {
  it('heals to full and charges the cost', () => {
    const r = resolveRest({ gold: 25 }, 30, 5);
    assert.equal(r.ok, true);
    assert.equal(r.hpCurrent, 30);
    assert.equal(r.gold, 20);
  });
  it('is free when cost is 0 (no innkeeper)', () => {
    const r = resolveRest({ gold: 0 }, 30, 0);
    assert.equal(r.ok, true);
    assert.equal(r.hpCurrent, 30);
    assert.equal(r.gold, 0);
  });
  it('fails when the room is unaffordable', () => {
    const r = resolveRest({ gold: 2 }, 30, DEFAULT_REST_COST);
    assert.equal(r.ok, false);
    assert.equal(r.short, DEFAULT_REST_COST - 2);
  });
});

describe('quests — state transitions', () => {
  const npc = { id: 'npc-thorn', name: 'Captain Thorn', questHook: 'Clear the crypt.' };

  it('makeQuest produces a stable, active quest', () => {
    const q = makeQuest(npc);
    assert.equal(q.id, questId(npc));
    assert.equal(q.status, 'active');
    assert.equal(q.npcId, 'npc-thorn');
    assert.equal(q.description, 'Clear the crypt.');
  });
  it('addQuest is idempotent by id', () => {
    let quests = addQuest({}, makeQuest(npc));
    quests = addQuest(quests, makeQuest(npc));
    assert.equal(Object.keys(quests).length, 1);
  });
  it('setQuestStatus advances a quest and leaves others alone', () => {
    let quests = addQuest({}, makeQuest(npc));
    quests = setQuestStatus(quests, questId(npc), 'completed');
    assert.equal(quests[questId(npc)].status, 'completed');
    assert.equal(activeQuests(quests).length, 0);
  });
  it('setQuestStatus on an unknown id is a no-op', () => {
    const quests = setQuestStatus({}, 'nope', 'completed');
    assert.deepEqual(quests, {});
  });
  it('activeQuests filters by status', () => {
    let quests = addQuest({}, makeQuest(npc));
    quests = addQuest(quests, makeQuest({ id: 'npc-syl', name: 'Syl', questHook: 'Find the ring.' }));
    quests = setQuestStatus(quests, questId(npc), 'failed');
    assert.equal(activeQuests(quests).length, 1);
    assert.equal(activeQuests(quests)[0].npcName, 'Syl');
  });
});

describe('dialogue memory + secret gating', () => {
  it('pushDialogue keeps only the last N exchanges', () => {
    let h = [];
    for (let i = 0; i < 10; i++) h = pushDialogue(h, 'player', `line ${i}`);
    assert.equal(h.length, DIALOGUE_MEMORY);
    assert.equal(h[h.length - 1].text, 'line 9');
  });
  it('canRevealSecret requires a secret, enough probing, and not-yet-revealed', () => {
    const base = { secret: 'I poisoned the well.', secretRevealed: false };
    assert.equal(canRevealSecret({ ...base, dialogueHistory: [{ role: 'player', text: 'hi' }] }), false);
    const hist = [];
    for (let i = 0; i < SECRET_MIN_EXCHANGES; i++) hist.push({ role: 'player', text: `q${i}` }, { role: 'npc', text: `a${i}` });
    assert.equal(canRevealSecret({ ...base, dialogueHistory: hist }), true);
    assert.equal(canRevealSecret({ ...base, secretRevealed: true, dialogueHistory: hist }), false);
    assert.equal(canRevealSecret({ secret: null, dialogueHistory: hist }), false);
  });
});
