// === AI prompt scaffolding (the kernel roadmap's 4.0.0 row) ===
//
// Structured templates that take the ENGINE'S deterministic output and
// feed it to an LLM for narration. The roadmap wanted this as a sister
// package so the kernel never imports it; it lands in the client for
// the same reason the image pipeline did — this repo IS the host-side
// toolkit, and the kernel's boundary stays intact (nothing here is
// imported by the kernel).
//
// Deliverables per the row:
//   - templates per resolution kind (attack hit/miss/crit, death-save
//     fail, condition applied, scene transition — plus the healing and
//     level-up moments every table narrates),
//   - provider adapters for the three major API shapes,
//   - cache-key derivation so repeated identical resolutions reuse the
//     same narration (cost saver),
//   - structured-output schemas so the model's reply is PARSEABLE
//     before it reaches the player.

// ── Templates ───────────────────────────────────────────────────────────
//
// Each template renders `{ system, user }` from a resolution payload.
// The system half fixes the narrator's job (2-3 sentences, second
// person, never invent mechanics); the user half carries ONLY the
// engine's numbers — the model narrates what happened, it never
// decides what happened.

const SYSTEM_BASE =
  'You are the narrator at a tabletop RPG session. Narrate the resolved '
  + 'moment in 2-3 vivid sentences, second person, present tense. The '
  + 'mechanical outcome is already decided and is final: never change '
  + 'numbers, never add effects, never decide what happens next. Respond '
  + 'with JSON matching the provided schema.';

const line = (label, value) => (value === undefined || value === null ? null : `${label}: ${value}`);
const compose = (...lines) => lines.filter(Boolean).join('\n');

export const PROMPT_KINDS = Object.freeze([
  'attack.hit', 'attack.miss', 'attack.crit',
  'death-save.fail', 'condition.applied', 'scene.transition',
  'healing.received', 'level.up',
]);

const TEMPLATES = Object.freeze({
  'attack.hit': (p) => compose(
    'A weapon attack HIT.',
    line('Attacker', p.attacker), line('Target', p.target),
    line('Weapon', p.weapon), line('Attack total vs AC', `${p.total} vs ${p.ac}`),
    line('Damage', `${p.damage} ${p.damageType ?? ''}`.trim()),
    line('Target hp after', p.hpAfter),
  ),
  'attack.miss': (p) => compose(
    'A weapon attack MISSED.',
    line('Attacker', p.attacker), line('Target', p.target),
    line('Weapon', p.weapon), line('Attack total vs AC', `${p.total} vs ${p.ac}`),
  ),
  'attack.crit': (p) => compose(
    'A weapon attack scored a CRITICAL HIT.',
    line('Attacker', p.attacker), line('Target', p.target),
    line('Weapon', p.weapon),
    line('Damage (doubled dice)', `${p.damage} ${p.damageType ?? ''}`.trim()),
    line('Target hp after', p.hpAfter),
  ),
  'death-save.fail': (p) => compose(
    'A death saving throw FAILED.',
    line('Character', p.character),
    line('Roll vs DC', `${p.roll} vs ${p.dc}`),
    line('Failures so far', `${p.failures} of ${p.failuresToDie ?? 3}`),
  ),
  'condition.applied': (p) => compose(
    'A condition was applied.',
    line('Target', p.target), line('Condition', p.condition),
    line('Source', p.source),
  ),
  'scene.transition': (p) => compose(
    'The scene changes.',
    line('Leaving', p.from), line('Arriving', p.to),
    line('Mood', p.mood), line('Time of day', p.timeOfDay),
  ),
  'healing.received': (p) => compose(
    'Healing landed.',
    line('Target', p.target), line('Healed', p.amount),
    line('Source', p.source), line('Hp after', p.hpAfter),
  ),
  'level.up': (p) => compose(
    'A character reached a new level.',
    line('Character', p.character), line('New level', p.level),
    line('Class', p.classId),
  ),
});

/**
 * Render the provider-agnostic prompt for a resolution:
 * `{ kind, system, user, cacheKey }`. Throws on unknown kinds — a
 * typo'd kind is a host bug, not a narration.
 */
export function narrationPrompt(kind, payload = {}, { tone } = {}) {
  const template = TEMPLATES[kind];
  if (!template) {
    throw new Error(`narrationPrompt: unknown kind '${kind}' (known: ${PROMPT_KINDS.join(', ')})`);
  }
  const system = tone ? `${SYSTEM_BASE} Tone for this table: ${tone}.` : SYSTEM_BASE;
  return {
    kind,
    system,
    user: template(payload),
    cacheKey: narrationCacheKey(kind, payload, tone),
  };
}

// ── Cache keys ──────────────────────────────────────────────────────────
//
// FNV-1a over a stable stringify (sorted keys) — identical resolutions
// hash identically regardless of property order, so a host cache can
// serve the goblin's third identical miss from memory instead of the
// provider. Same non-cryptographic tripwire class as the cartridge
// digest: a cache key, never an integrity gate.

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function narrationCacheKey(kind, payload = {}, tone) {
  const input = `${kind}|${tone ?? ''}|${stableStringify(payload)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `n-${hash.toString(16).padStart(8, '0')}`;
}

// ── Structured output ───────────────────────────────────────────────────

/** The reply contract: narration text plus optional presentation tags. */
export const NARRATION_SCHEMA = Object.freeze({
  type: 'object',
  required: ['narration'],
  properties: {
    narration: { type: 'string', description: '2-3 sentences, second person, present tense.' },
    tone: { type: 'string', description: 'One-word delivery tag (grim, wry, triumphant…).' },
    soundCue: { type: 'string', description: 'Optional ambient cue for hosts with audio.' },
  },
});

/**
 * Parse and validate a model reply against NARRATION_SCHEMA. Accepts a
 * raw string (possibly fenced) or an already-parsed object. Returns
 * `{ ok: true, narration }` or `{ ok: false, reason }` — the host
 * decides whether to retry or fall back to plain dice-speak.
 */
export function parseNarration(reply) {
  let value = reply;
  if (typeof reply === 'string') {
    const body = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try { value = JSON.parse(body); } catch {
      return { ok: false, reason: 'reply is not JSON' };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'reply is not an object' };
  }
  if (typeof value.narration !== 'string' || !value.narration.trim()) {
    return { ok: false, reason: 'missing narration text' };
  }
  const out = { narration: value.narration.trim() };
  if (typeof value.tone === 'string') out.tone = value.tone;
  if (typeof value.soundCue === 'string') out.soundCue = value.soundCue;
  return { ok: true, ...out };
}

// ── Provider adapters ───────────────────────────────────────────────────
//
// The three major API shapes. Each takes the provider-agnostic prompt
// and returns the REQUEST BODY for that provider — transport stays the
// host's (src/llm/transport.js already owns retries and streaming).

export function toAnthropic(prompt, { model = 'claude-sonnet-5', maxTokens = 300 } = {}) {
  return {
    model,
    max_tokens: maxTokens,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  };
}

export function toOpenAI(prompt, { model = 'gpt-4o-mini', maxTokens = 300 } = {}) {
  return {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    response_format: { type: 'json_object' },
  };
}

export function toLocal(prompt, { model = 'local', maxTokens = 300 } = {}) {
  // The llama.cpp/ollama-style completion shape: one flat prompt.
  return {
    model,
    max_tokens: maxTokens,
    prompt: `${prompt.system}\n\n${prompt.user}\n\nJSON reply:`,
  };
}
