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
//   • narrative/ pure runtime engines for the AI-generated story: red-thread
//               beat evaluator + faction-reputation math (consume what the
//               worldgen beatsHints/factionsHints constrain the AI to produce).
//   • settlement/ pure economy / quest / dialogue helpers over the generated
//               settlements + NPCs.
//   • travel/   an overworld travel state machine (encounters / discoveries).
//
// Everything is config/callback-injected and free of bag-of-holding so it loads
// under `node --test`; the host supplies rng, stat blocks, schemas, prompts, and
// locale content.

// ── LLM ──────────────────────────────────────────────────────────────────────
export {
  ApiError, AbortedError, apiBase, authHeaders, post, withDeadline, asTransportError,
  DEFAULT_BASE_URL, DEFAULT_APP_TITLE, DEFAULT_TIMEOUT_MS,
} from './src/llm/transport.js';
export { resolveModel, sampling, healModels, FREE_MODELS, PAID_MODELS, FREE_FALLBACKS, CHAT_TIERS } from './src/llm/tiers.js';
export { fetchModelIds } from './src/llm/catalog.js';
export { JsonFieldStreamer } from './src/llm/stream.js';
export { call, chatCompletion, chatStream, repairJson, checkKey } from './src/llm/client.js';
export { generateImage, parseImageFromResponse } from './src/llm/image.js';
export { synthesizeSpeech, transcribeAudio, pcmToWav, bytesToBase64, TTS_FALLBACKS, PCM_MODELS } from './src/llm/audio.js';

export { makeClock, isFull, advance, tickAll, clockMood, pressingClocks } from './src/narrative/clocks.js';

// ── Ledger (world memory: base ⊕ patches ⊕ views) ─────────────────────────────
export { makeId, slugSegment, isValidId, parentOf, kindOf, isUnder } from './src/ledger/ids.js';
export {
  makePatch, appendPatch, fold, foldAll, getPath, historyOf,
  dirtyTargets, recentCauses, compact, SCOPES, KINDS,
  pathsConflict, mechanicalPathsOf,
} from './src/ledger/patch.js';

// ── Worldgen ───────────────────────────────────────────────────────────────────
export { pick, pickN, shuffle, randInt, mintSeed, mulberry32 } from './src/worldgen/rng.js';
export { TONES, isTone } from './src/worldgen/tones.js';
export {
  buildBlueprint, deriveBlueprint, blueprintContext, worldSeedConstraints,
  beatsHints, factionsHints, regionHints, settlementHints,
  THEME_CLIMATES, BAND_SETTLEMENTS, THREAT_EXPRESSIONS,
} from './src/worldgen/blueprint.js';
export { runPipeline, ensureDigest, withRetry, PipelineError } from './src/worldgen/pipeline.js';
export {
  emptyGeography, addNode, connect, neighbours, expandFrom, markVisited,
  knownMap, routeBetween, DIRECTIONS,
  childrenOf, ancestorsOf, promoteNode, discoverAncestors,
} from './src/worldgen/geography.js';
export {
  HYDRATION_TEMPLATES, hydrateNode, ensureLineage, lineageContext,
  gazetteerOf, coerceBeatLocation, runPostConditions,
  mintProvinceRegions, mintRegionSites, promoteObserved,
} from './src/worldgen/hydrate.js';
export { mintWorldSkeleton, adoptFlatWorld, CLIMATE_BANDS, SYLLABLES } from './src/worldgen/skeleton.js';
export {
  WORLD_SEED_SCHEMA, REGION_SCHEMA, NPC_SCHEMA, FACTION_SCHEMA,
  BEAT_SCHEMA, RED_THREAD_SCHEMA, FACTIONS_SCHEMA, SETTLEMENT_SCHEMA,
  CONTINENT_OUTLINE_SCHEMA, CONTINENTS_OUTLINE_SCHEMA, PROVINCE_OUTLINE_SCHEMA,
  CROWN_SCHEMA, LEGEND_SCHEMA,
} from './src/worldgen/schemas.js';
export {
  mintEras, mintLegendStubs, mintCrownStub, mintLore,
  ERA_NAMES, LEGEND_TITLE_A, LEGEND_TITLE_B, CROWN_TITLES, LEGITIMACIES,
} from './src/worldgen/lore.js';

// ── Dungeon ────────────────────────────────────────────────────────────────────
export { generateDungeon, DUNGEON_OVERLAYS, DEFAULT_SIZE as DEFAULT_DUNGEON_SIZE } from './src/dungeon/generate.js';

// ── Narrative (story beats + faction reputation) ─────────────────────────────────
export {
  isBeatDone, isBeatEligible, nextEligibleBeats, currentBeat,
  setFlag, completeBeat, storyProgress, storyHint,
} from './src/narrative/beats.js';
// Acts sit above beats: a campaign is 4-5 acts, generated one at a time from
// what actually happened, with stall detection and a payoff ledger.
export {
  makeAct, emptyThread, pushAct, currentAct, activeBeat as activeActBeat,
  completeBeat as completeActBeat, setFlag as setActFlag, isStalled,
  plantSetup, paySetup, duePayoffs, threadProgress, directive, isDone as isActBeatDone,
} from './src/narrative/acts.js';
export {
  REP_MIN, REP_MAX, THRESHOLDS, clampRep, reputationOf, adjustReputation,
  standing, standingFor, priceModifier, adjustPrice, isHostile,
} from './src/narrative/factions.js';

// ── Settlement (economy / quests / dialogue) ─────────────────────────────────────
export {
  DEFAULT_START_GOLD, DEFAULT_REST_COST, DIALOGUE_MEMORY, SECRET_MIN_EXCHANGES,
  slug, goldOf, resolvePurchase, addToInventory, resolveRest,
  questId, makeQuest, addQuest, setQuestStatus, activeQuests,
  pushDialogue, canRevealSecret,
} from './src/settlement/economy.js';

// ── Travel ─────────────────────────────────────────────────────────────────────
export {
  beginTravel, stepTravel, isTravelDone, pickEncounter, runTravel,
  TRAVEL_SEGMENTS_MIN, TRAVEL_SEGMENTS_MAX, ENCOUNTER_CHANCE, DISCOVERY_CHANCE, DISCOVERY_TYPES,
} from './src/travel/fsm.js';

// ── Output (browser-only: ZIP byte-core is node-testable, EPUB needs a canvas) ───
export { crc32, zipBytes, buildZip } from './src/output/zip.js';
export { buildEpub, TONE_PALETTE } from './src/output/epub.js';

// ── Persistence (versioned save envelope + migration runner + commit combinator) ─
export {
  wrapEnvelope, loadEnvelope, saveEnvelope, makeCommit,
  listBackups, restoreBackup, backupKey, digest, LOAD_ERRORS,
} from './src/persistence/envelope.js';
// Two-tier persistence: a small synchronous hot slice in localStorage, an
// unbounded async cold archive in IndexedDB. Degrades to hot-only when the
// platform has no IndexedDB, so the game keeps working.
export {
  openCold, coldPut, coldGet, coldKeys, coldAll, coldDelete,
  appendSegment, readSegments, segmentKey, splitSave,
} from './src/persistence/idb.js';
