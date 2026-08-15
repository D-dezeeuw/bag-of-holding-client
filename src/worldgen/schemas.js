// worldgen/schemas.js — JSON Schema contracts for the AI-generated worldgen
// layers (world seed, region, factions, story beats, settlement + NPCs).
//
// One import (the shared tone vocabulary); otherwise plain JSON-Schema object
// literals. The host passes these as the
// `schema` for each structured completion in the worldgen pipeline (runPipeline)
// so the model's output is validated/repaired against the layer's shape. The
// NPC and settlement contracts are also the data shape the host's settlement
// economy/dialogue helpers consume at play time.

import { TONES } from './tones.js';

export const WORLD_SEED_SCHEMA = {
  type: 'object',
  properties: {
    name:     { type: 'string' },
    tone:     { type: 'string', enum: [...TONES] },
    creation: { type: 'string' },
    gods: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:   { type: 'string' },
          domain: { type: 'string' },
        },
        required: ['name', 'domain'],
        additionalProperties: false,
      },
    },
    redThread: {
      type: 'object',
      properties: {
        premise: { type: 'string' },
        hook:    { type: 'string' },
      },
      required: ['premise', 'hook'],
      additionalProperties: false,
    },
    digest: { type: 'string' },
  },
  required: ['name', 'tone', 'creation', 'gods', 'redThread', 'digest'],
  additionalProperties: false,
};

export const REGION_SCHEMA = {
  type: 'object',
  properties: {
    id:             { type: 'string' },
    name:           { type: 'string' },
    climate:        { type: 'string' },
    description:    { type: 'string' },
    settlementName: { type: 'string' },
    dungeonName:    { type: 'string' },
    rumor:          { type: 'string' },
    adjacentHints: {
      type: 'array',
      items: { type: 'string' },
    },
    digest: { type: 'string' },
  },
  required: ['id', 'name', 'climate', 'description', 'settlementName', 'dungeonName', 'rumor', 'adjacentHints', 'digest'],
  additionalProperties: false,
};

const NPC_RELATIONSHIP_SCHEMA = {
  type: 'object',
  properties: {
    targetId: { type: 'string' },
    type:     { type: 'string', enum: ['spouse', 'parent', 'child', 'rival', 'ally', 'employer', 'mentor'] },
  },
  required: ['targetId', 'type'],
  additionalProperties: false,
};

const NPC_INVENTORY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name:        { type: 'string' },
    price:       { type: 'number' },
    description: { type: 'string' },
  },
  required: ['name', 'price', 'description'],
  additionalProperties: false,
};

export const NPC_SCHEMA = {
  type: 'object',
  properties: {
    id:            { type: 'string' },
    name:          { type: 'string' },
    role:          { type: 'string', enum: ['innkeeper', 'questgiver', 'merchant', 'guard', 'elder', 'blacksmith', 'healer', 'hermit'] },
    attitude:      { type: 'string', enum: ['friendly', 'neutral', 'suspicious', 'hostile'] },
    greeting:      { type: 'string' },
    questHook:     { type: ['string', 'null'] },
    personality:   { type: 'string' },
    secret:        { type: ['string', 'null'] },
    factionId:     { type: ['string', 'null'] },
    relationships: { type: 'array', items: NPC_RELATIONSHIP_SCHEMA },
    inventory:     { type: ['array', 'null'], items: NPC_INVENTORY_ITEM_SCHEMA },
  },
  required: ['id', 'name', 'role', 'attitude', 'greeting'],
  additionalProperties: false,
};

export const FACTION_SCHEMA = {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    name:        { type: 'string' },
    description: { type: 'string' },
    values:      { type: 'string' },
    allies:      { type: 'array', items: { type: 'string' } },
    enemies:     { type: 'array', items: { type: 'string' } },
    territory:   { type: 'array', items: { type: 'string' } },
    digest:      { type: 'string' },
  },
  required: ['id', 'name', 'description', 'values', 'allies', 'enemies', 'territory', 'digest'],
  additionalProperties: false,
};

export const BEAT_SCHEMA = {
  type: 'object',
  properties: {
    id:                    { type: 'string' },
    dramaticPurpose:       { type: 'string' },
    targetPlaytimeMinutes: { type: 'number' },
    prerequisites:         { type: 'array', items: { type: 'string' } },
    setRequiredFlags:      { type: 'array', items: { type: 'string' } },
    preferredLocation:     { type: ['string', 'null'] },
    requiredArchetypes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role:  { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['role', 'notes'],
        additionalProperties: false,
      },
    },
    successors: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'dramaticPurpose', 'targetPlaytimeMinutes', 'prerequisites', 'setRequiredFlags', 'preferredLocation', 'requiredArchetypes', 'successors'],
  additionalProperties: false,
};

export const RED_THREAD_SCHEMA = {
  type: 'object',
  properties: {
    beats: { type: 'array', items: BEAT_SCHEMA },
  },
  required: ['beats'],
  additionalProperties: false,
};

export const FACTIONS_SCHEMA = {
  type: 'object',
  properties: {
    factions: { type: 'array', items: FACTION_SCHEMA },
  },
  required: ['factions'],
  additionalProperties: false,
};

export const SETTLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    name:        { type: 'string' },
    description: { type: 'string' },
    regionId:    { type: 'string' },
    npcs:        { type: 'array', items: NPC_SCHEMA },
    exits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          direction:  { type: 'string' },
          targetName: { type: 'string' },
          targetType: { type: 'string', enum: ['dungeon', 'road', 'wilderness'] },
          targetId:   { type: ['string', 'null'] },
        },
        required: ['direction', 'targetName', 'targetType', 'targetId'],
        additionalProperties: false,
      },
    },
    digest: { type: 'string' },
  },
  required: ['id', 'name', 'description', 'npcs', 'exits'],
  additionalProperties: false,
};

// ─── Layered-world outlines (doc 17, textual LOD) ────────────────────────────
//
// An outline is detail level 1: ~40–60 words of what a place is ABOUT, plus
// the facts lower layers inherit (faction presence, conflicts). One call
// outlines all continents at genesis; a province outlines on first approach.

export const CONTINENT_OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    id:     { type: 'string' },
    name:   { type: 'string' },
    digest: { type: 'string' },
    factionHomelands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factionId: { type: 'string' },
          presence:  { type: 'string', enum: ['homeland', 'strong', 'contested', 'absent'] },
        },
        required: ['factionId', 'presence'],
        additionalProperties: false,
      },
    },
  },
  required: ['id', 'name', 'digest', 'factionHomelands'],
  additionalProperties: false,
};

export const CONTINENTS_OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    continents: { type: 'array', items: CONTINENT_OUTLINE_SCHEMA },
  },
  required: ['continents'],
  additionalProperties: false,
};

// ─── Lore entities (doc 18 §4) ───────────────────────────────────────────────
//
// Hydration contracts for the stubs src/worldgen/lore.js mints at genesis.

export const CROWN_SCHEMA = {
  type: 'object',
  properties: {
    id:            { type: 'string' },
    name:          { type: 'string' },
    title:         { type: 'string' },
    seat:          { type: ['string', 'null'] },
    legitimacy:    { type: 'string', enum: ['settled', 'contested', 'usurped', 'failing', 'newly crowned'] },
    stanceOnThreat: { type: 'string' },
    factionRelations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factionId: { type: 'string' },
          // 'sovereign' — this crown IS the faction's throne, the stored fact
          // that makes "the King of Faction A" a bindable target. At most one
          // sovereign per crown (enforced at genesis by bindCrownsToFactions).
          stance:    { type: 'string', enum: ['sovereign', 'ally', 'rival', 'puppet', 'defiant'] },
        },
        required: ['factionId', 'stance'],
        additionalProperties: false,
      },
    },
    digest: { type: 'string' },
  },
  required: ['id', 'name', 'title', 'seat', 'legitimacy', 'stanceOnThreat', 'factionRelations', 'digest'],
  additionalProperties: false,
};

export const LEGEND_SCHEMA = {
  type: 'object',
  properties: {
    id:            { type: 'string' },
    title:         { type: 'string' },
    era:           { type: ['string', 'null'] },
    kernelOfTruth: { type: 'string' },
    sites:         { type: 'array', items: { type: 'string' } },
    hooks:         { type: 'array', items: { type: 'string' } },
    payoff:        { type: 'string' },
    digest:        { type: 'string' },
  },
  required: ['id', 'title', 'era', 'kernelOfTruth', 'sites', 'hooks', 'payoff', 'digest'],
  additionalProperties: false,
};

export const PROVINCE_OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    id:       { type: 'string' },
    name:     { type: 'string' },
    digest:   { type: 'string' },
    conflicts:  { type: 'array', items: { type: 'string' } },
    landmarks:  { type: 'array', items: { type: 'string' } },
    dominantFactionId: { type: ['string', 'null'] },
    factionStance:     { type: 'string', enum: ['dominant', 'contested', 'absent'] },
  },
  required: ['id', 'name', 'digest', 'conflicts', 'landmarks', 'dominantFactionId', 'factionStance'],
  additionalProperties: false,
};
