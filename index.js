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
// Whether an image may be made at all — pure, host-agnostic gate math, shared
// with the MCP server so "the DM asked for a picture" and "the player clicked
// render" answer to the same budget.
export {
  IMAGE_TIERS, DEFAULT_IMAGE_TIER, GRANT_TTL_MS, tierPolicy,
  emptyImageGate, normalizeImageGate, rollImageWindow,
  enableImages, disableImages, canRenderImage, imageGateStatus,
  spendImageRender, refundImageRender, isGrantExpired, composeImagePrompt,
} from './src/llm/imagegate.js';
export { synthesizeSpeech, transcribeAudio, pcmToWav, bytesToBase64, TTS_FALLBACKS, PCM_MODELS } from './src/llm/audio.js';

export { makeClock, isFull, advance, tickAll, clockMood, pressingClocks } from './src/narrative/clocks.js';

// ── Ledger (world memory: base ⊕ patches ⊕ views) ─────────────────────────────
export { makeId, slugSegment, isValidId, parentOf, kindOf, isUnder } from './src/ledger/ids.js';
export {
  makePatch, appendPatch, fold, foldAll, getPath, historyOf,
  dirtyTargets, recentCauses, compact, SCOPES, KINDS,
  pathsConflict, mechanicalPathsOf,
  digestScopeOf, causesFor,
} from './src/ledger/patch.js';

// ── Worldgen ───────────────────────────────────────────────────────────────────
export { pick, pickN, shuffle, randInt, mintSeed, mulberry32 } from './src/worldgen/rng.js';
export { TONES, isTone } from './src/worldgen/tones.js';
export {
  buildBlueprint, deriveBlueprint, blueprintContext, worldSeedConstraints,
  beatsHints, factionsHints, regionHints, settlementHints, menaceHints,
  DEFAULT_TABLES, mergeTables,
  THEME_CLIMATES, BAND_SETTLEMENTS, THREAT_EXPRESSIONS, MENACE_TIERS, MENACE_SIGNPOSTS,
} from './src/worldgen/blueprint.js';
export { runPipeline, ensureDigest, withRetry, PipelineError } from './src/worldgen/pipeline.js';
export {
  emptyGeography, addNode, connect, neighbours, expandFrom, markVisited,
  knownMap, routeBetween, DIRECTIONS,
  childrenOf, ancestorsOf, promoteNode, discoverAncestors,
} from './src/worldgen/geography.js';
export {
  HYDRATION_TEMPLATES, hydrateNode, ensureLineage, lineageContext,
  gazetteerOf, coerceBeatLocation, castGazetteerOf, coerceBeatCast, runPostConditions,
  mintProvinceRegions, mintRegionSites, promoteObserved,
  portAnchorOf, mintLandfall, whileYouWereGone,
} from './src/worldgen/hydrate.js';
export {
  bakeCartridge, mountCartridge, catalogEntry,
  CARTRIDGE_VERSION, CARTRIDGE_MIGRATIONS,
} from './src/worldgen/cartridge.js';
// Entity-id ⇄ cell addressing over a cartridge: what does the world say about
// entity X, and how to write an answer back. The fold base for session replay
// and the future revision format both speak this addressing.
export {
  cellsOf, entityIdsOf, projectCells,
  REVISION_VERSION, REVISION_MIGRATIONS, REVISION_CELLS,
  makeRevision, mountRevision, applyRevision, applyRevisions,
  resolvedDigest, classifyRevision, revisionConflicts,
} from './src/worldgen/revision.js';
// Fronts: the world's own pressure — wars and shaky crowns mint clocks, and a
// filled clock changes the world through ledger patches replay can fold.
export {
  mintWorldClocks, warClockFired, successionFired, advanceWorld,
  WAR_CLOCK_SEGMENTS, SUCCESSION_SEGMENTS, SUCCESSION_TURNS,
} from './src/worldgen/fronts.js';
export { mintWorldSkeleton, adoptFlatWorld, CLIMATE_BANDS, SYLLABLES, STUB_HOOKS } from './src/worldgen/skeleton.js';
export {
  WORLD_SEED_SCHEMA, REGION_SCHEMA, NPC_SCHEMA, FACTION_SCHEMA,
  BEAT_SCHEMA, RED_THREAD_SCHEMA, FACTIONS_SCHEMA, SETTLEMENT_SCHEMA,
  CONTINENT_OUTLINE_SCHEMA, CONTINENTS_OUTLINE_SCHEMA, PROVINCE_OUTLINE_SCHEMA,
  CROWN_SCHEMA, LEGEND_SCHEMA, WORLD_NPC_SCHEMA,
} from './src/worldgen/schemas.js';
export {
  mintEras, mintLegendStubs, mintCrownStub, mintLore,
  mintFactionStubs, mintWarState, bindCrownsToFactions, mintNpcStubs,
  ERA_NAMES, LEGEND_TITLE_A, LEGEND_TITLE_B, CROWN_TITLES, LEGITIMACIES,
  FACTION_NAME_A, FACTION_NAME_B, WAR_CAUSES, WAR_INTENSITIES,
  NPC_GIVEN_NAMES, NPC_VOICES, NPC_WANTS,
} from './src/worldgen/lore.js';

// ── Dungeon ────────────────────────────────────────────────────────────────────
export { generateDungeon, DUNGEON_OVERLAYS, DEFAULT_SIZE as DEFAULT_DUNGEON_SIZE } from './src/dungeon/generate.js';

// ── Layout (shared spatial core + settlement space) ───────────────────────────
export { generateLayout, placeOnGrid, attachBranch, dirBetween, deriveAdjacency } from './src/layout/engine.js';
export { settlementLayout, cityLayout, bindSettlement, SETTLEMENT_SIZES, ROLE_BUILDINGS } from './src/layout/settlement.js';

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
  adjustReputationWithRipples,
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
export { TRAVEL_MODES, LANDFALL_HOOKS } from './src/travel/modes.js';
export { planJourney, legTravelOptions, applyTravelClocks } from './src/travel/planner.js';

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

// ── AI prompt scaffolding (the kernel roadmap's 4.0.0 row, landed host-side) ──
// Structured narration templates over the engine's deterministic output:
// provider-agnostic prompts with cache keys, the parseable reply schema,
// and adapters for the three major API shapes. The kernel never imports
// this — its boundary stays intact; this repo IS the host toolkit.
export {
  PROMPT_KINDS, narrationPrompt, narrationCacheKey,
  NARRATION_SCHEMA, parseNarration, toAnthropic, toOpenAI, toLocal,
} from './src/llm/prompts.js';

// ── Initiative tracker reference UI (the kernel roadmap's 4.1.0 row) ────────
// A pure view model + a web component registered only where custom
// elements exist (defineInitiativeTracker is a clean no-op in node).
// Reference example, not part of the engine — the boundary holds.
export {
  initiativeViewModel, advanceTurn, defineInitiativeTracker,
} from './src/ui/initiative.js';

// ── Grant redemption (closing the keyless-deployment gap) ───────────────────
// On a keyless MCP server the image gate hands the HOST a render grant;
// this is the redemption counter — expiry-checked, provider-injected,
// with the refund verdict the server's refund path needs.
export { grantIsLive, redeemImageGrant } from './src/llm/redeem.js';
