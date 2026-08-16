// AI prompt scaffolding (the kernel roadmap's 4.0.0 row, landed
// host-side). What must hold: every declared kind renders; the user
// half carries ONLY the engine's numbers and the system half forbids
// inventing mechanics; cache keys are order-insensitive and
// payload-sensitive; replies validate through the schema with fenced
// JSON tolerated; and the three provider adapters emit their API's
// exact request shape from ONE prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMPT_KINDS, narrationPrompt, narrationCacheKey,
  NARRATION_SCHEMA, parseNarration, toAnthropic, toOpenAI, toLocal,
} from '../src/llm/prompts.js';

test('every declared kind renders a prompt; unknown kinds throw', () => {
  const payloads = {
    'attack.hit': { attacker: 'Vex', target: 'goblin', weapon: 'shortsword', total: 18, ac: 15, damage: 7, damageType: 'piercing', hpAfter: 0 },
    'attack.miss': { attacker: 'Vex', target: 'goblin', weapon: 'shortsword', total: 12, ac: 15 },
    'attack.crit': { attacker: 'Vex', target: 'goblin', weapon: 'shortsword', damage: 14, hpAfter: 0 },
    'death-save.fail': { character: 'Brann', roll: 6, dc: 10, failures: 2 },
    'condition.applied': { target: 'Vex', condition: 'poisoned', source: 'crawler mucus' },
    'scene.transition': { from: 'the-hedge', to: 'the-long-table', mood: 'held breath' },
    'healing.received': { target: 'Brann', amount: 9, source: 'cure wounds', hpAfter: 17 },
    'level.up': { character: 'Vex', level: 4, classId: 'rogue' },
  };
  for (const kind of PROMPT_KINDS) {
    const prompt = narrationPrompt(kind, payloads[kind]);
    assert.equal(prompt.kind, kind);
    assert.match(prompt.system, /never change numbers/);
    assert.ok(prompt.user.length > 10, `${kind} renders a user half`);
    assert.match(prompt.cacheKey, /^n-[0-9a-f]{8}$/);
  }
  // The user half carries the engine's numbers verbatim.
  const hit = narrationPrompt('attack.hit', payloads['attack.hit']);
  assert.match(hit.user, /18 vs 15/);
  assert.match(hit.user, /7 piercing/);
  // Missing optional fields drop their lines instead of printing undefined.
  const sparse = narrationPrompt('attack.miss', { total: 12, ac: 15 });
  assert.ok(!sparse.user.includes('undefined'));
  assert.throws(() => narrationPrompt('taunt.witty', {}), /unknown kind 'taunt\.witty'/);
  // Tone threads into the system half and the cache key.
  const grim = narrationPrompt('attack.hit', payloads['attack.hit'], { tone: 'grim' });
  assert.match(grim.system, /Tone for this table: grim/);
  assert.notEqual(grim.cacheKey, hit.cacheKey);
});

test('cache keys: order-insensitive, payload-sensitive, stable', () => {
  const a = narrationCacheKey('attack.hit', { total: 18, ac: 15, target: 'goblin' });
  const b = narrationCacheKey('attack.hit', { target: 'goblin', ac: 15, total: 18 });
  assert.equal(a, b, 'property order does not change the key');
  const c = narrationCacheKey('attack.hit', { total: 19, ac: 15, target: 'goblin' });
  assert.notEqual(a, c, 'a different roll is a different narration');
  assert.notEqual(
    narrationCacheKey('attack.hit', {}), narrationCacheKey('attack.miss', {}),
    'the kind is part of the key');
});

test('replies validate through the schema; fenced JSON is tolerated', () => {
  assert.equal(NARRATION_SCHEMA.required[0], 'narration');
  const clean = parseNarration('{"narration": "Your blade slides home.", "tone": "grim"}');
  assert.deepEqual(clean, { ok: true, narration: 'Your blade slides home.', tone: 'grim' });
  const fenced = parseNarration('```json\n{"narration": "The goblin drops."}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(parseNarration('The goblin drops.').ok, false, 'prose is not a contract');
  assert.match(parseNarration('{"tone": "grim"}').reason, /missing narration/);
  assert.equal(parseNarration({ narration: ' pre-parsed too ' }).narration, 'pre-parsed too');
});

test('one prompt, three provider request bodies', () => {
  const prompt = narrationPrompt('attack.crit', { attacker: 'Vex', damage: 14 });
  const anthropic = toAnthropic(prompt, { model: 'claude-sonnet-5' });
  assert.equal(anthropic.system, prompt.system);
  assert.deepEqual(anthropic.messages, [{ role: 'user', content: prompt.user }]);
  const openai = toOpenAI(prompt);
  assert.equal(openai.messages[0].role, 'system');
  assert.equal(openai.messages[1].content, prompt.user);
  assert.deepEqual(openai.response_format, { type: 'json_object' });
  const local = toLocal(prompt);
  assert.ok(local.prompt.startsWith(prompt.system));
  assert.ok(local.prompt.includes(prompt.user));
});
