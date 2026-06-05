import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WORLD_SEED_SCHEMA, REGION_SCHEMA, NPC_SCHEMA, FACTION_SCHEMA,
  BEAT_SCHEMA, RED_THREAD_SCHEMA, FACTIONS_SCHEMA, SETTLEMENT_SCHEMA,
} from '../src/worldgen/schemas.js';

// A tiny structural validator: enough to prove the schemas describe the shapes
// the worldgen pipeline expects (required fields, enums, additionalProperties,
// nested composition). Not a full JSON-Schema implementation.
function validate(val, sch, path = '$') {
  const errs = [];
  const types = Array.isArray(sch.type) ? sch.type : [sch.type];
  const isNull = val === null;
  if (isNull && types.includes('null')) return errs;
  if (sch.type === 'object' || types.includes('object')) {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return [`${path}: expected object`];
    for (const req of sch.required ?? []) if (!(req in val)) errs.push(`${path}: missing '${req}'`);
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(val)) if (!(k in (sch.properties ?? {}))) errs.push(`${path}: extra '${k}'`);
    }
    for (const [k, sub] of Object.entries(sch.properties ?? {})) {
      if (k in val && val[k] !== undefined) errs.push(...validate(val[k], sub, `${path}.${k}`));
    }
  } else if (sch.type === 'array' || types.includes('array')) {
    if (!Array.isArray(val)) return [`${path}: expected array`];
    if (sch.items) val.forEach((el, i) => errs.push(...validate(el, sch.items, `${path}[${i}]`)));
  } else if (sch.enum && !sch.enum.includes(val)) {
    errs.push(`${path}: '${val}' not in enum`);
  }
  return errs;
}

describe('worldgen schemas — composition wiring', () => {
  it('composed schemas reference their element sub-schemas by identity', () => {
    assert.equal(RED_THREAD_SCHEMA.properties.beats.items, BEAT_SCHEMA);
    assert.equal(FACTIONS_SCHEMA.properties.factions.items, FACTION_SCHEMA);
    assert.equal(SETTLEMENT_SCHEMA.properties.npcs.items, NPC_SCHEMA);
  });
  it('every object schema locks additionalProperties: false', () => {
    for (const s of [WORLD_SEED_SCHEMA, REGION_SCHEMA, NPC_SCHEMA, FACTION_SCHEMA, BEAT_SCHEMA, SETTLEMENT_SCHEMA]) {
      assert.equal(s.additionalProperties, false);
    }
  });
});

describe('worldgen schemas — validation', () => {
  it('accepts a well-formed world seed and rejects a bad tone', () => {
    const seed = {
      name: 'Aldoria', tone: 'grimdark', creation: 'It began in fire.',
      gods: [{ name: 'Mara', domain: 'death' }],
      redThread: { premise: 'The dead walk.', hook: 'A plea for help.' },
      digest: 'grimdark world, undead threat',
    };
    assert.deepEqual(validate(seed, WORLD_SEED_SCHEMA), []);
    assert.ok(validate({ ...seed, tone: 'silly' }, WORLD_SEED_SCHEMA).length > 0);
  });

  it('validates a nested settlement with NPCs', () => {
    const town = {
      id: 'town-1', name: 'Ashvale', description: 'A mining camp.', regionId: 'r1',
      npcs: [{ id: 'n1', name: 'Bera', role: 'innkeeper', attitude: 'friendly', greeting: 'Welcome.' }],
      exits: [{ direction: 'north', targetName: 'The Crypt', targetType: 'dungeon', targetId: 'd1' }],
      digest: 'mining camp',
    };
    assert.deepEqual(validate(town, SETTLEMENT_SCHEMA), []);
    // bad NPC role surfaces through composition
    const bad = { ...town, npcs: [{ id: 'n2', name: 'X', role: 'wizard', attitude: 'neutral', greeting: 'Hi.' }] };
    assert.ok(validate(bad, SETTLEMENT_SCHEMA).some(e => e.includes('enum')));
  });

  it('validates a red thread of beats', () => {
    const rt = {
      beats: [{
        id: 'b1', dramaticPurpose: 'the hook', targetPlaytimeMinutes: 45,
        prerequisites: [], setRequiredFlags: ['threat-known'], preferredLocation: null,
        requiredArchetypes: [{ role: 'informant', notes: 'a witness' }], successors: [],
      }],
    };
    assert.deepEqual(validate(rt, RED_THREAD_SCHEMA), []);
  });
});
