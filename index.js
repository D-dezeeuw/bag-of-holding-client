// @zeeuw/bag-of-holding-client — the browser host toolkit for AI-driven D&D.
//
// The @zeeuw/bag-of-holding rules kernel is AI-agnostic by design: the host owns
// the prose, the persistence, and the AI loop. This package IS that host
// machinery, factored out so it's reusable:
//
//   • llm/      a structured + streaming LLM client (OpenRouter default),
//               tiered model routing, JSON-schema completions, repair retry,
//               400/429 fallbacks, typed ApiError — config-injected, no globals.
//   • worldgen/ a layered blueprint→AI-constrain→assemble pipeline runner +
//               a seeded blueprint factory.
//   • dungeon/  a procedural dungeon-graph generator (grid placement, spine +
//               branches, lock-and-key, depth-scaled enemies, vault boss) with
//               injected content + stat-block providers.
//   • travel/   an overworld travel state machine (encounters / discoveries).
//
// Everything is config/callback-injected and free of bag-of-holding so it loads
// under `node --test`; the host supplies rng, stat blocks, schemas, prompts, and
// locale content.

// ── LLM ──────────────────────────────────────────────────────────────────────
export { ApiError, apiBase, authHeaders, post, DEFAULT_BASE_URL, DEFAULT_APP_TITLE } from './src/llm/transport.js';
export { resolveModel, sampling, FREE_MODELS, PAID_MODELS, FREE_FALLBACKS } from './src/llm/tiers.js';
export { JsonFieldStreamer } from './src/llm/stream.js';
export { call, chatCompletion, chatStream, repairJson, checkKey } from './src/llm/client.js';

// ── Worldgen ───────────────────────────────────────────────────────────────────
export { pick, pickN, shuffle, randInt, mintSeed, mulberry32 } from './src/worldgen/rng.js';
export { buildBlueprint, blueprintContext, worldSeedConstraints, beatsHints, factionsHints, regionHints, settlementHints } from './src/worldgen/blueprint.js';
export { runPipeline, ensureDigest, withRetry } from './src/worldgen/pipeline.js';

// ── Dungeon ────────────────────────────────────────────────────────────────────
export { generateDungeon, DUNGEON_OVERLAYS } from './src/dungeon/generate.js';

// ── Travel ─────────────────────────────────────────────────────────────────────
export {
  beginTravel, stepTravel, isTravelDone, pickEncounter, runTravel,
  TRAVEL_SEGMENTS_MIN, TRAVEL_SEGMENTS_MAX, ENCOUNTER_CHANCE, DISCOVERY_CHANCE, DISCOVERY_TYPES,
} from './src/travel/fsm.js';
