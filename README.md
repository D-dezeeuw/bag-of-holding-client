# bag-of-holding-client

The **browser host toolkit** for AI-driven D&D. The
[`@zeeuw/bag-of-holding`](https://github.com/D-dezeeuw/bag-of-holding) rules
kernel is AI-agnostic by design — *the host owns the prose, the persistence, and
the AI loop*. This package **is** that host machinery, factored out so it's
reusable.

- **Zero runtime dependencies.** Single ESM surface, config-injected (no
  globals), `node --test`-friendly.
- **Provider-agnostic LLM client** (OpenRouter default): tiered model routing,
  JSON-schema-constrained completions, JSON-repair retry, 400/429 fallbacks,
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

```js
import {
  chatCompletion, chatStream,                         // structured + streaming LLM
  buildBlueprint, runPipeline, WORLD_SEED_SCHEMA,     // layered worldgen
  generateDungeon, runTravel,                         // dungeon + overworld
  currentBeat, completeBeat, adjustReputation,        // narrative engines
  resolvePurchase, makeQuest,                         // settlement economy
} from '@zeeuw/bag-of-holding-client';

// Every entry point is config-injected — the host builds a plain object and
// passes it in; the library never reads globals:
const config = { key: MY_OPENROUTER_KEY, models: { medium: 'deepseek/deepseek-chat' } };
const out = await chatCompletion(config, { tier: 'medium', messages, schema: WORLD_SEED_SCHEMA });
```

## Design

The library owns **algorithms and orchestration**; the host injects **content**
(rng, stat blocks, locale descriptors, schemas, prompts). That keeps it free of
both a rules engine and any i18n, so it loads under `node --test` and re-skins to
any genre.

| Module | Owns |
|---|---|
| `llm/transport` `llm/tiers` `llm/client` `llm/stream` | the structured/streaming LLM client |
| `worldgen/rng` `worldgen/blueprint` `worldgen/pipeline` `worldgen/schemas` | seeded blueprint + layered pipeline runner + layer schemas |
| `dungeon/generate` | the dungeon-graph algorithm (injected stat blocks + content) |
| `narrative/beats` `narrative/factions` | red-thread beat evaluator + faction-reputation math |
| `settlement/economy` | trade / quests / inventory / dialogue-memory helpers |
| `travel/fsm` | the overworld travel state machine |

## Develop

```sh
npm test     # node --test tests/*.test.js
```

## License

MPL-2.0 — matching the rules kernel (file-level copyleft).
