# The lore tree — layered worldgen implementation plan

**Status: plan, not shipped.** Continues the layered-world skeleton work
(doc 17, textual LOD) that landed in `0.3.0`. Target: a world that can
carry an 80-hour campaign — many climates, many dungeon flavours, rulers
and legends that exist before the player needs them — while staying
cheap, because everything below an outline hydrates lazily.

---

## 1 · Where 0.4.0 actually stands

`buildBlueprint(seed)` is a **world-level singleton**. One call rolls one
tone, one climate, one settlement type, one dungeon theme, three faction
slots — and every prompt formatter reads those singleton fields directly:

```
regionHints(bp)      → "The nearby dungeon should be themed as: frozen tomb."
settlementHints(bp)  → "This settlement is a: mushroom farm."
```

So with today's wiring, **every dungeon in the world is a frozen tomb and
every settlement is a mushroom farm** — not because the design wants
that, but because there is exactly one blueprint and it doesn't know
where the region asking for hints *is*.

The `0.3.0` skeleton already fixed half of this. Geography is layered
(world → continent → province → region), provinces own a climate band
(`CLIMATE_BANDS`), and regions are supposed to inherit it. But the
blueprint never consumes any of it: `blueprint.climate` is rolled
globally and `settlementTypes[climate]` is keyed off that single roll.
Geography got layered; **lore didn't follow**. That is the gap this plan
closes.

What the singleton got right and we keep: seeded determinism, curated
tables the host can re-skin, hint formatters that constrain rather than
generate, and the `additionalProperties: false` schema contracts.

## 2 · Target shape: the lore tree

Every place is a node in one tree, every node has its own seed (minted
from its parent's rng, as the skeleton already does), and every tier
draws its *own slice* of the blueprint — constrained by its ancestors,
never rerolling what a parent already decided.

```
world                           tone, archetype, threat, pantheon, eras
└─ continent (2–4)              naming culture, threat expression, legends,
   │                            faction homelands
   └─ province (2–4 each)       climate band, crown/ruler, dungeon-theme
      │                         palette, conflicts, worship skew
      └─ region (frontier)      settlement type, dungeon theme, landmarks,
         │                      rumors
         └─ site                settlement | dungeon | landmark — first-class
            │                   nodes, no longer strings on the region
            └─ interior         dungeon floors (the generator we have),
                                notable buildings
```

Two structural changes versus today:

- **Sites become geography nodes.** Today `settlementName` / `dungeonName`
  are strings on the region result. Promoting them to child nodes
  (`…region-2.site-0`) gives them seeds, detail levels, edges (a road to a
  dungeon is an edge), and lets `childrenOf` / `ancestorsOf` /
  `promoteNode` — which already exist in `geography.js` — work uniformly
  from continent down to a cellar.
- **Lore entities live on the tree**, not in a flat list: a legend node
  references the sites it is buried under; a crown sits on a province; a
  faction's homeland is a continent fact that its provinces inherit.

## 3 · Scoped blueprints — the keystone

One new pure function, mirroring `buildBlueprint`'s table-driven design:

```js
deriveBlueprint(parentBp, nodeSeed, scope, { tables } = {})
// scope: 'world' | 'continent' | 'province' | 'region'
```

Each scope draws only what it owns, with the node's own rng:

| scope | draws | inherits (never rerolls) |
|---|---|---|
| world | tone, worldArchetype, threatType, beatArc, godDomains (pantheon), eras | — |
| continent | naming culture (syllable tables), threat *expression* ("how the void entity manifests here"), legend slots, faction homelands | tone, threat, pantheon |
| province | climate band, dungeon-theme **palette** (2–3, filtered by climate), settlement palette (from climate), crown, worship skew (1–2 dominant domains), conflicts | continent's culture + threat expression |
| region | settlementType (from province palette), dungeonTheme (from province palette), buildingTypes, locationTypes | province climate — the doc-17 rule, now actually enforced |

Supporting data changes:

- **`THEME_CLIMATES`** — a compatibility table mapping each dungeon theme
  to the climate bands it can appear in (`frozen tomb` → frozen /
  highland; `flooded cavern` → coastal / mire / tropical; `fungal
  depths` → mire / subterranean …). A province's palette is drawn from
  the themes its band permits. This is the direct fix for "frozen tomb
  under a mushroom farm".
- **Climate spread guarantee.** A continent draws its provinces' bands
  without replacement until the band list is exhausted, so a 4-province
  continent gets 4 different bands instead of `temperate` three times
  (seed 1234 today: temperate, temperate, arid, temperate on Karossa).
- **Naming cultures.** The skeleton's `CONTINENT_A/B` syllable tables
  become per-continent picks (each continent commits to a syllable
  flavour), so names on one landmass rhyme with each other and not with
  the neighbour's — cheap coherence, zero LLM calls.
- `buildBlueprint(seed)` survives as `deriveBlueprint(null, seed,
  'world')` plus the legacy region-ish fields, deprecated but intact —
  the `adoptFlatWorld` precedent: never strand an in-flight campaign.

The hint formatters gain scoped variants (`regionHints(bp, node)`)
that prefer the node's derived slice and fall back to the singleton, so
existing hosts keep working unmodified.

## 4 · Lore entities — factions, kings, legends

The tree needs inhabitants whose existence *precedes* the player. All
minted as stubs at genesis (names + bindings, no prose), hydrated like
places.

- **Crowns** (`CROWN_SCHEMA`): one per province — `{ name, title, seat
  (a site id), legitimacy, stanceOnThreat, factionRelations[] }`. The
  region's "who rules here" answer stops being improvised per prompt.
  Succession is a clock (`narrative/clocks.js` exists): a crown with
  `legitimacy: 'contested'` mints a clock at hydration, and the world
  moves while the player is elsewhere.
- **Legends** (`LEGEND_SCHEMA`): 2–3 per continent — `{ title, era,
  kernelOfTruth, sites[], hooks[], payoff }`. A legend is the bridge
  between lore and play: its `sites` bind to province/region ids, so a
  dungeon is *where a legend is buried* rather than a theme with rooms.
  Legends feed the acts engine directly — `plantSetup` at first rumor,
  `paySetup` when the vault opens — which is exactly the payoff-ledger
  machinery `narrative/acts.js` already has.
- **Eras**: 3–5 named epochs minted at world genesis, one line each.
  Every legend, ruin, and landmark carries an `era` tag. This is what
  makes "its roads are older than its towns" a checkable fact instead of
  a vibe, and it costs one field.
- **Worship skew**: the pantheon stays global; a province records which
  1–2 domains dominate locally. Temples, oaths, and cult threats
  localize without new gods.
- **Faction ↔ crown relations** land on the province outline (the
  `PROVINCE_OUTLINE_SCHEMA` already carries `dominantFactionId` /
  `factionStance`; crowns complete the triangle).

All new tables go through the `tests/legal.test.js` sweep — epithets and
invented names only, same rule as `docs/legal.md` in the kernel repo.

## 5 · Detail ladder and hydration

The existing ladder holds; sites and interiors join it:

| detail | meaning | cost |
|---|---|---|
| 0 | stub — name, hook, seed (skeleton mints these) | free |
| 1 | outline — 40–60 words of what it's *about* + inheritable facts, digest | 1 small call |
| 2 | full content — region/settlement/NPC schemas, playable | 1–2 medium calls |
| interior | dungeon floors via `generateDungeon` (seeded, free), notable buildings | free / 1 small call |

**Promotion triggers**, in priority order:

1. **Approach** (travel FSM): destination → 2, its neighbours → 1.
2. **Foreshadow**: a beat or legend that references a node promotes it
   to 1 immediately — the place the story points at must have an outline
   *before* the model narrates pointing at it, or the narration invents
   one and the canon forks.
3. **Rumor**: settlement NPC dialogue can pull one distant node to 1 per
   session (bounded, so gossip doesn't hydrate the planet).

**`lineageContext(geo, nodeId)`** — walk `ancestorsOf`, concatenate
digests/outlines root-down, append the node's derived blueprint slice.
Every generation call gets its full ancestry for a few hundred tokens.
This replaces today's single `digests.world` threading with the tree
path, and it is what keeps a region on Velwyn *feeling like Velwyn*.

**Budget shape** (the reason this scales to 80h): genesis is 1 world
call + 1 continents-outline call — everything else is stubs. A campaign
that visits 12 regions across 3 provinces pays for exactly those 12
regions. The tree adds depth without adding a single eager call; wider
worlds cost more *disk*, not more *tokens*.

### Hydration at the table — latency is a design input

Triggers fire during play, so every hydration is a player waiting unless
the design says otherwise. It says otherwise three ways:

- **Promote on departure, not arrival.** The approach trigger fires when
  travel *begins*; the travel FSM's segments are the latency budget. A
  3-segment journey is three narration beats of cover for the region
  call running behind them — by the arrival segment the destination is
  usually canon. Arriving before it finishes narrates the approach
  ("the walls resolve out of the haze") until the result lands.
- **Stream what can stream.** `JsonFieldStreamer` exists so prose fields
  render as they generate; structure validates when the document closes.
- **Every template declares a procedural fallback** — what to serve when
  the model is slow, offline, or keyless: names from the continent's
  syllable culture, a dungeon from `generateDungeon`, an NPC assembled
  from role + palette tables. Fallback content is written as patches
  marked `provisional`; the next successful hydration supersedes it.
  **Play never blocks on a model** — the same rule persistence already
  follows when IndexedDB is missing: degrade, don't die.

When triggers pile up, the queue drains in the trigger priority order
(approach > foreshadow > rumor), and rumor stays bounded per session.

### The story only points at real places

The foreshadow trigger has a hidden precondition: the beat must
reference a node that *exists*. Acts are generated from play — and an
act generator that free-texts place names invents geography, which is
the same canon fork the post-conditions catch at the content layer,
arriving from the narrative side instead.

- Act and beat generation consume a **gazetteer**: `knownMap` plus
  rumoured stubs plus legend sites, as ids with one-line summaries. A
  beat's `preferredLocation` must come from it — post-condition, coerced
  to the nearest match on violation.
- The deliberate exception: a beat may mint **one** new stub beyond the
  frontier, attached to an existing province at detail 0. That is how
  the story is allowed to create geography *on purpose* instead of by
  accident, and the mint is a canon patch like any other.

## 6 · Hydration templates — how a node knows what to become

Promotion (section 5) says *when* a node hydrates. It deliberately says
nothing about *what* hydrating a node means — and without that contract,
`hydrateNode` degenerates into a switch statement that guesses a layer
list per kind, every site type gets whatever the prompt happened to
imply, and two hydrations of similar nodes drift apart in what they
contain. The fix is the same move the archetype tables made for
constraints: **make the recipe data.**

A template registry, keyed by node kind and subtype:

```js
HYDRATION_TEMPLATES = {
  'continent':        { outline: {…} },
  'province':         { outline: {…} },
  'region':           { outline: {…}, full: [{…}, …] },
  'site:settlement':  { full: [{…}] },
  'site:dungeon':     { full: [{…}] },
  'site:landmark':    { full: [{…}] },
  'crown': {…}, 'legend': {…}, 'faction': {…},
}
```

Each template declares five things:

1. **Layers** — per target detail level, the ordered specs the pipeline
   runs: `{ schema, tier, retries, critical, group }`. Tier reuses
   `llm/tiers.js` routing: outlines are `tiny`-model calls, full content
   is `medium`. The registry is where "an outline costs a small call"
   stops being a convention and becomes enforced.
2. **Consumes** — the ancestor facts this kind's prompt must include:
   a settlement consumes the province climate band + settlement palette
   + crown + worship skew; a dungeon consumes the theme (from the
   province palette), the legend bound to it if any, and the threat
   expression; a landmark consumes climate + era. `lineageContext`
   reads this list and assembles *only* those facts instead of dumping
   the whole ancestry — which is what keeps the token cost of depth
   flat as the tree grows.
3. **Method** — `llm | procedural | mixed`. This is where the "don't
   pay the model for what a seed can decide" rule lives per type: a
   dungeon is procedural first (`generateDungeon` from the site seed —
   free, deterministic) plus one small dressing call for room prose; a
   landmark is a table pick plus one line; a settlement is a full
   `SETTLEMENT_SCHEMA` completion; a crown is a small structured call;
   a legend outline is `tiny`, its payoff text is `medium` and deferred
   until an act actually points at it.
4. **Mints** — the child stubs a hydration must leave behind, so the
   frontier always extends ahead of the player: a region mints its site
   stubs; a settlement mints notable-building stubs and NPC entries; a
   dungeon mints nothing below itself (floors are procedural); a legend
   mints no nodes but must *bind* to existing site ids.
5. **Post-conditions** — checks `hydrateNode` runs after schema
   validation passes: every exit `targetId` resolves to a real node or
   is minted as a stub in the same transaction; every NPC `factionId`
   exists; every era tag is one of the world's eras; a dungeon bound to
   a legend actually contains the legend's payoff hook. Schema
   validation catches *shape*; post-conditions catch **dangling
   references** — the exact way canon forks when the model invents a
   place the tree doesn't have.

Templates are data, host-overridable exactly like the archetype tables
(`hydrateNode(geo, id, { templates })`), so the genre re-skin story
stays intact — and the default set's strings go through the
`legal.test.js` sweep like every other table. A custom site type (a
host adding `site:shipwreck`) is a registry entry, not a fork of the
pipeline.

## 7 · Canon coherence — late content must agree with early content

Lazy filling's hard problem is not generating content late; it is that
late content must not contradict what two sessions ago made canon.
Consistency has two directions, and the plan so far only handled one.

**Vertical** (ancestor → descendant) is `lineageContext` + `consumes`:
done. **Horizontal** (sibling ↔ sibling, neighbour ↔ neighbour) is not
free, and `adjacentHints` is where it bites: a hydrated region's hints
are *promises about neighbours that don't exist yet*. Three rules make
them binding:

- **Hints become commitments.** At hydration commit, each adjacent hint
  is recorded as a fact patch on the target stub (`hintedBy`, with the
  hint text and source node). When that stub later hydrates, its
  template's `consumes` includes inbound commitments — the neighbour
  that promised "smoke over the eastern ridge" gets a region that has
  something burning.
- **Neighbour digests travel too.** Hydrating a node includes the
  digests of already-hydrated *direct* neighbours (bounded to one edge —
  a few lines each), so borders agree on the war, the river, and the
  weather without paying for the whole map.
- **Earlier canon wins.** New content is generated under existing
  patches as constraints; where output still contradicts something
  checkable (an id, an era, a name, a committed hint), the *new* content
  is repaired or coerced — existing canon is never rewritten to
  accommodate it. The ledger is append-only for the same reason `main`
  is.

**Failure is a path, not an exception.** The post-conditions in section
6 say what must hold; this is what happens when it doesn't:

1. *Shape* failures → schema validation + `repairJson` (exists today).
2. *Reference* failures → one semantic repair retry: re-ask with the
   violations enumerated ("these ids do not exist: …; these facts are
   already canon: …").
3. Still failing → a **deterministic coercion ladder** per reference
   class: a dangling exit mints its missing stub; an unknown
   `factionId` drops to `null`; a wrong era snaps to the nearest era; a
   missing legend hook is attached procedurally from the legend's
   `hooks[]`. Logged via `onProgress`, never thrown at the player.
4. **Commit is atomic.** Pipeline results are staging; post-conditions
   and coercion run on the staged set; the ledger write lands all of a
   hydration's patches or none of them. A half-hydrated settlement is a
   retry (whose completed layers the pipeline's checkpoints already
   preserve), never canon.

**Regeneration is supersession.** Rerolling a bad settlement writes
superseding patches — compacted later by the ledger's `compact` — and
never mutates or deletes, so a replayed campaign passes through the bad
roll the same way the timeline did.

## 8 · Pipeline and persistence wiring

- **`hydrateNode(geo, nodeId, { config, templates })`** — look up the
  node's template, build the layer list for the target detail, call
  `runPipeline` with the template's `consumes` list (plus inbound
  commitments and direct-neighbour digests, section 7) resolved through
  `lineageContext` in `ctx`, run post-conditions and the coercion
  ladder, then commit atomically: mint the declared stubs, record the
  new node's own adjacent hints as commitments, write the canon patches,
  return results + the promoted geography. Checkpoint/resume comes free
  from the pipeline's existing `onCheckpoint` / `initialResults`.
- **Canon lives in the ledger.** Hydration output is written as patches
  (`kind: 'canon'`, `source: 'worldgen'`) over the base world —
  `ledger/patch.js` (base ⊕ patches ⊕ views, conflict detection,
  compaction) was built for exactly this shape. Play writes are patches
  too; `mechanicalPathsOf` already separates what the kernel owns.

## 9 · Pre-generated worlds — cartridges and MCP playback

The ledger split above is what makes shared worlds nearly free:

- **A cartridge is a baked genesis.** Run world + continent outlines +
  legends + crowns offline (a `scripts/bake-world.js`, BYOK), freeze the
  result in the versioned save envelope (`wrapEnvelope` + `digest`),
  ship it as `world-<seed>.json`. Crucially this freezes *model output*,
  not just the seed — LLM sampling isn't reproducible, so the artifact,
  not the seed, is the world's identity. Two players mounting cartridge
  `oss-drath-7731` get byte-identical lore.
- **A session is a patch ledger over an immutable base.** Mounting a
  cartridge = adopting it as the ledger base; every play event and every
  lazy hydration is a patch on top. "A fresh version of that world" is
  therefore trivial: new session, same base, empty patch log. Nothing is
  ever copied and the cartridge is never written.
- **MCP surface** (lands in `bag-of-holding-mcp`, its own PR):
  - resources: `world://catalog`, `world://<id>/node/<nodeId>`,
    `world://<id>/lineage/<nodeId>` — read-only cartridge access, so any
    MCP host can mount a world with no client code.
  - tools: `world_begin(worldId)` → base digest + starting node;
    `world_hydrate(nodeId)` → detail-2 content (server-baked for popular
    worlds, or host-key at the table).
  - **playback**: a finished campaign = cartridge digest + ordered patch
    log. Replaying the log over the same base reproduces the whole
    campaign — same story the kernel's `Replay` tells for dice, one
    level up. Spectating, post-mortems, and "resume anywhere" all fall
    out of one design decision.
- **A cartridge pins its schema version.** Mounting an old cartridge in
  a newer client runs the envelope's migration runner (exists) — but the
  migration output lands as session-local patches over the untouched
  artifact, never as a rewrite of it. The cartridge stays immutable
  even across format changes; only its overlay evolves.
- Cartridges do **not** ship in the npm tarball (they're data, and they
  would swamp the 69 kB package); a catalog repo or GitHub release
  assets carry them.

## 10 · Phases

Each phase is one branch → PR → merge, tests green, in this order —
every phase is independently shippable and the ones after C are
parallel-friendly:

- **A · Scoped blueprints** — `deriveBlueprint`, `THEME_CLIMATES`,
  climate spread, naming cultures, scoped hint formatters, deprecation
  shims. *Fixes the frozen-tomb bug on its own.* (minor bump)
- **B · Lore entities** — crown/legend/era schemas + genesis stubs +
  `legal.test.js` coverage of every new table. (minor)
- **C · Hydration** — sites as nodes, the template registry with
  consumes/mints/post-conditions and procedural fallbacks,
  `lineageContext`, `hydrateNode` with the coercion ladder and atomic
  commit, hint-commitments + neighbour digests, promotion triggers
  (including the gazetteer constraint on beats), ledger-canon wiring.
  (minor)
- **D · Cartridges** — bake script, envelope format, catalog layout.
  (minor)
- **E · MCP surface** — resources + tools + playback, in
  `bag-of-holding-mcp`. (that package's own versioning)

Test strategy stays the house style: every new module is pure and
injected, so `node --test` covers it without a network; the entry-point
suite pins the new exports; the legal sweep runs over every new table
(fallback tables included) and every rendered scoped prompt. The
coherence machinery is the most testable part of the design precisely
because it never needs a model: post-conditions, the coercion ladder,
hint-commitments, and atomic commit all run against fixture output — a
"contradiction fixture" (a staged region that violates a committed
hint, a dangling exit, a wrong era) must come out repaired, coerced, or
rejected, deterministically.

---

*Why this document lives here:* worldgen is client-owned. The kernel
stays out of it entirely — nothing in this plan computes a 5e outcome.
The MCP phase touches `bag-of-holding-mcp` only as a read/serve surface
over artifacts this package produces.
