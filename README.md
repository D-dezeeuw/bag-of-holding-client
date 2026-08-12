# bag-of-holding-client

The **browser host toolkit** for AI-driven D&D. The
[`@zeeuw/bag-of-holding`](https://github.com/D-dezeeuw/bag-of-holding) rules
kernel is AI-agnostic by design — *the host owns the prose, the persistence, and
the AI loop*. This package **is** that host machinery, factored out so it's
reusable.

- **Zero runtime dependencies.** Single ESM surface, config-injected (no
  globals), `node --test`-friendly.
- **Provider-agnostic LLM client** (OpenRouter default): tiered model routing,
  JSON-schema-constrained completions, JSON-repair retry, model fallbacks on 400/404/429,
  streaming with a `JsonFieldStreamer`, and a typed `ApiError`.
- **Layered worldgen** — a seeded blueprint factory + a `runPipeline` orchestrator
  that threads digests, fans out parallel layers, retries, and continues past
  non-critical failures.
- **Procedural dungeon generator** — grid placement, spine + branches,
  lock-and-key, depth-scaled enemies, vault boss; content + stat blocks injected.
- **Overworld travel FSM** — departing → traveling (encounters / discoveries) →
  arriving.
- **Narrative runtime engines** — a flag-gated red-thread *beat* evaluator and
  *faction-reputation* math (standings, merchant prices, hostility) — the engines
  that consume what the worldgen blueprint's `beatsHints` / `factionsHints`
  constrain the AI to produce, plus the JSON-schema contracts for every layer.
- **Settlement economy** — pure trade, quest state, inventory, and per-NPC
  dialogue-memory helpers over the generated settlements + NPCs.

```sh
npm i @zeeuw/bag-of-holding-client
```

## Why it exists

`bag-of-holding-client` is the reusable **host machinery** for AI-driven tabletop
RPGs — everything that sits *between a rules engine and a finished game*. It only
makes sense as one third of a family, where each package is defined as much by
what it **refuses** to do as by what it owns:

| Package | Owns | Deliberately omits |
|---|---|---|
| [`@zeeuw/bag-of-holding`](https://github.com/D-dezeeuw/bag-of-holding) | the **rules kernel** — dice, checks, combat, XP, SRD, character derivation. What is *true* in 5e: deterministic, replay-verifiable, AI-agnostic. | the AI, the prose, the world, the persistence |
| [`@zeeuw/bag-of-holding-mcp`](https://github.com/D-dezeeuw/bag-of-holding-mcp) | the **rules-as-tools bridge** — exposes the kernel over MCP so any AI host runs rules-correct math instead of trusting the model to do it. | anything that isn't a rules call |
| **`@zeeuw/bag-of-holding-client`** | the **host machinery** — LLM client, worldgen pipeline, dungeon generator, travel FSM, narrative (beats/factions) + settlement engines. | the rules (never reimplemented) and the UI (never touches DOM / app state) |

The kernel is an intentionally closed, honest core. This package is the open,
reusable scaffolding *around* it — the half every AI-DM app re-invents and gets
subtly wrong. Kernel = **truth**, MCP = **tool access to the truth**, client =
**the experience built on top**.

**One principle explains the whole design: the library owns algorithms and
orchestration; the host injects content** (rng, stat blocks, locale text,
schemas, prompts). That is what keeps it config-injected, global-free,
genre-agnostic, and `node --test`-able — and it is guarded by two hard fences:

1. **No credential ever ships** in the package. Bring your own key; the host
   passes it into `config`.
2. **No core rules leak in.** Anything that computes a 5e outcome belongs in the
   kernel, not here.

Its signature move is owning **both halves of the AI narrative loop**: it
generates the constraints that *steer* the model (`beatsHints`, `factionsHints`,
`settlementHints`, derived from a seeded blueprint) **and** owns the runtime
engines that *consume* the model's output (the beat evaluator, reputation math,
settlement economy). It does not just call an LLM — it frames the generation,
then runs the result as durable game state. That is what makes this an AI-D&D
**host toolkit** rather than an OpenRouter wrapper.

## How to use it

Every entry point takes an explicit config/args object — there are no globals to
set up. Import only the subsystems you need; they compose but don't depend on
each other.

### 1 · Talk to a model (LLM client)

```js
import { chatCompletion, chatStream, WORLD_SEED_SCHEMA } from '@zeeuw/bag-of-holding-client';

// The host owns the config; the library never reads globals or env.
const config = {
  key: getKey(),                            // BYOK — from localStorage / OAuth / env, never embedded
  models: { tiny: 'google/gemini-2.5-flash-lite', medium: 'deepseek/deepseek-chat' },
  onTokens: (n) => meter(n),                // optional usage callback
};

// Schema-constrained JSON (auto-repair on malformed output, 400→medium / 429→fallback
// recovery on a typed ApiError):
const seed = await chatCompletion(config, {
  tier: 'medium',
  schema: WORLD_SEED_SCHEMA,
  messages: [{ role: 'user', content: 'Invent a grimdark world.' }],
});

// Streaming — pull one JSON field out of the stream as tokens arrive:
await chatStream(
  config,
  { tier: 'medium', messages: [{ role: 'user', content: 'Narrate the scene.' }] },
  (chunk) => render(chunk),
  { field: 'narration' },
);
```

### 2 · Generate a world (blueprint → pipeline)

```js
import { buildBlueprint, worldSeedConstraints, runPipeline,
         WORLD_SEED_SCHEMA, SETTLEMENT_SCHEMA } from '@zeeuw/bag-of-holding-client';

const blueprint = buildBlueprint(1234);     // deterministic archetype choices for this seed

// Re-skinning the genre is a partial table override — everything you do not
// name keeps coming from DEFAULT_TABLES:
const cyberpunk = buildBlueprint(1234, { tables: {
  dungeonThemes: ['server-crypt', 'flooded sublevel', 'tong den'],
  themeClimates: { 'server-crypt': ['highland'], 'flooded sublevel': ['coastal', 'mire'], 'tong den': ['coastal'] },
} });
// ...and the layers above the region can carry their own naming culture:
// mintWorldSkeleton(1234, { syllables: { continentPrefixes: [...], ... }, hooks: [...] })

// A pre-generated world carries its setting the same way, and the catalog
// says which is which:
// bakeCartridge(1234, { setting: { id: 'neon-stacks', tables, syllables, hooks } })

const world = await runPipeline([
  { name: 'world', critical: true, retries: 1,
    generate: (_digests, bp) => chatCompletion(config, {
      tier: 'medium', schema: WORLD_SEED_SCHEMA,
      messages: [{ role: 'system', content: worldSeedConstraints(bp) }],
    }) },
  { name: 'town', dependsOn: ['world'],
    generate: (digests) => chatCompletion(config, {
      tier: 'medium', schema: SETTLEMENT_SCHEMA,
      messages: [{ role: 'system', content: `World so far: ${digests.world}` }],
    }) },
], {
  blueprint,
  onProgress:   (kind, info) => log(kind, info),
  onCheckpoint: (partial) => localStorage.setItem('worldgen', JSON.stringify(partial)),
  initialResults: JSON.parse(localStorage.getItem('worldgen') ?? 'null'),   // resume a half-built world
});
// → { world: {…}, town: {…} }   digests threaded down; same-`group` layers run in parallel
// A critical layer that fails throws a PipelineError carrying `.results` — persist it and
// pass it back as `initialResults` so the completed layers are never paid for twice.
```

### 3 · Generate a dungeon

```js
import { generateDungeon } from '@zeeuw/bag-of-holding-client';

const dungeon = generateDungeon(1234, {
  blueprint,                                // optional: themes the rooms + loot
  statBlockFor: (id) => bestiary[id],       // REQUIRED — your engine's stat blocks
  size: { spineMin: 6, spineMax: 9, branchMin: 3, branchMax: 5 },   // optional: scale to the act
  content: {                                // injected locale dressing (the library ships none)
    roomPools, houseStyles, treasures, keys, loot,
    dressingFor: (theme, roomType) => details[theme]?.[roomType],   // one small detail per room
    enemyName:  (id) => names[id],
    enemyIntro: (id, name, style) => `${name} lurks in the ${style}.`,
  },
});
// → { currentRoom, exitRoomId, rooms: {…}, npcs: {…} }  — grid, lock-and-key, vault boss
```

### 4 · Run overworld travel

```js
import { runTravel, mulberry32 } from '@zeeuw/bag-of-holding-client';

const { travel, events } = runTravel('Ashvale', mulberry32(7));
// events: [{type:'depart'}, {type:'encounter'|'discovery'|'uneventful'}, …, {type:'arrive'}]
// Or drive it a segment at a time with beginTravel / stepTravel / isTravelDone; pass
// { safe: true } for fast-travel with no random events.
```

### 5 · Drive the story & factions (narrative engines)

```js
import { currentBeat, completeBeat,
         adjustReputation, standingFor, standing, reputationOf, adjustPrice }
  from '@zeeuw/bag-of-holding-client';

let thread = { beats, currentIndex: 0, flags: {} };
const beat = currentBeat(thread);           // the beat to steer toward right now
thread = completeBeat(thread, beat.id);     // raises its flags, advances the index (immutable)
// Gating is `prerequisites` only. A beat's `successors` is advisory: it breaks the tie when
// several beats are eligible at once, so the story follows the arc the author intended.

let rep = adjustReputation({}, 'crown', 30);
standingFor(rep, 'crown');                   // 'neutral' | 'ally' | 'enemy' | 'champion' | 'nemesis'
adjustPrice(100, standing(reputationOf(rep, 'crown')));  // ally discount / enemy markup
```

### 6 · Run a settlement (economy)

```js
import { resolvePurchase, addToInventory, makeQuest, resolveRest }
  from '@zeeuw/bag-of-holding-client';

const buy = resolvePurchase(pc.record, { name: 'Healing Potion', price: 10 });
if (buy.ok) { pc.gold = buy.gold; inventory = addToInventory(inventory, buy.item); }

const quest = makeQuest(npc);               // stable id; tracks factionId for the rep payoff
const rest  = resolveRest(pc.record, pc.maxHp);   // heal to full, charge the inn
```

> Dan's Dungeons (the reference host) wires all of the above to a reactive store
> and a browser UI in a thin adapter — the library itself stays pure.

## Design

The library owns **algorithms and orchestration**; the host injects **content**
(rng, stat blocks, locale descriptors, schemas, prompts). That keeps it free of
both a rules engine and any i18n, so it loads under `node --test` and re-skins to
any genre.

| Module | Owns |
|---|---|
| `llm/transport` `llm/tiers` `llm/client` `llm/stream` | the structured/streaming LLM client (deadlines + AbortSignal end to end) |
| `llm/catalog` `llm/image` `llm/audio` | live model-catalog healing, scene-image generation, TTS/STT — all under the same deadlines and cost accounting |
| `worldgen/rng` `worldgen/blueprint` `worldgen/pipeline` `worldgen/schemas` `worldgen/tones` `worldgen/geography` | seeded blueprint + resumable pipeline runner + layer schemas + the shared tone vocabulary + the region graph |
| `dungeon/generate` | the dungeon-graph algorithm (injected stat blocks + content) |
| `narrative/beats` `narrative/acts` `narrative/clocks` `narrative/factions` | beat evaluator, act arc, faction/threat clocks, reputation math |
| `ledger/patch` `ledger/ids` | world memory: base ⊕ append-only patches ⊕ folded views |
| `persistence/envelope` `persistence/idb` | versioned saves (strict migrations, backup rotation) + a hot/cold split |
| `settlement/economy` | trade / quests / inventory / dialogue-memory helpers |
| `travel/fsm` | the overworld travel state machine |
| `output/zip` `output/epub` | store-only ZIP + EPUB builders (browser-only canvas cover) |

## Develop

```sh
npm test     # node --test tests/*.test.js
```

## Content hygiene

`DEFAULT_TABLES` ships archetype names that end up inside prompts, so it
follows the same rule as the rules kernel
([docs/legal.md](https://github.com/D-dezeeuw/bag-of-holding/blob/main/docs/legal.md)):
SRD 5.2 content by its real name, generic terms, or invented names — nothing
that belongs to a published setting. Gods are described by **epithet** rather
than named (`death — "the one who judges every life at its end"`), which keeps
Product Identity out and steers better besides: an epithet gives the model a
role to name, where a real deity invites it to reproduce that deity.
`blueprintContext` also tells the model outright to invent original names,
because a clean table alone does not stop it reaching for one it has read.

`tests/legal.test.js` enforces this over the tables, the dungeon overlays, and
every rendered prompt constraint across 250 seeds. If you swap in your own
`tables`, that guard covers the defaults only — yours are your own to check.

## License

MPL-2.0 — matching the rules kernel (file-level copyleft).
