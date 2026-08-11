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
  machinery `narrative/acts.js` already has. One binding rule at
  genesis, the **explorer's dividend**: each continent's first port
  province carries at least one legend site — so whatever shore a
  wanderer lands on, the acts engine has something real to bind to
  (section 9).
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

1. **Approach** (travel FSM): per leg — each leg's destination → 2 at
   leg start, its neighbours → 1; and at journey start, the final
   destination's *ancestors* → 1, so a multi-leg crossing outlines the
   far shore while the first leg is still underway (section 9).
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

## 9 · Crossings — no walls, only distance

Players are creative and leave the roads. Someone will board a ship —
or grow wings — and cross to another continent in search of something
new. A flexible GM never hard-stops that player: they improvise thin
and commit later, price the detour diegetically (a ship, six days,
storms), let the abandoned plot keep moving, and telegraph danger
instead of scaling the world. We can hold ourselves to the same
standard with one advantage a GM doesn't have: **prep is free.** The
far continent has existed since genesis — name, hook, climate bands,
ports, a legend site. There is no off-the-map; there is only
not-yet-hydrated.

**The principle: refusal is never mechanical.** Everything the
skeleton minted is reachable from session one; every cost is inside
the fiction. And the inverse discipline: **canon never relocates.** No
quantum ogre — the prepared dungeon does not quietly move to wherever
the players went, because the ledger and replay would show the seams,
and because free prep makes the trick pointless. (Beat coercion —
section 5 — moves *intentions* to the nearest real place; it never
moves places.)

**The journey.** Today this is aspiration, not mechanics: the travel
FSM never sees geography — no origin, no edges, every trip is 2–3
segments whether it's a day's walk or an ocean. Geography got
distance; travel didn't follow. Phase F closes it:

- **`planJourney(geo, fromId, toId, { modes, capabilities })`** — a
  pure planner over `routeBetween`, which gains a traversability
  predicate (today it routes a sea lane like a road). The plan is
  legs: `{ from, to, mode, days, segments }`. The FSM stays
  free-standing — it gains an options bag
  (`beginTravel(dest, rng, { segments, mode })`) and the no-opts call
  keeps today's behaviour, the `adoptFlatWorld` precedent again.
- **`TRAVEL_MODES`** — a host-overridable table per mode (road / sea /
  air): days-per-segment, encounter chance, discovery table. Segments
  derive from route days **with today's 2-segment floor**, so
  promote-on-departure never loses its budget on a one-day hop. Sea
  crossings get storms as *discoveries* — the FSM's event shape does
  not change.
- **Air pays with the same coin.** Nodes have no coordinates, and we
  are not minting any — that would change the skeleton output and
  therefore the cartridge envelope, for one travel mode. Air prices
  off the underlying route days × a mode factor: faster, not free.
  (Sea lanes chain consecutive continents' ports, so a flight across
  three crossings prices off three crossings. It *is* far.)
- **Legs are capped** (~8 segments), long crossings break at port
  stops — diegetic resupply, and each leg restarts the latency budget.
- **Capability, not simulation.** The planner takes
  `capabilities: { sea, air }` from the host. How the party got a ship
  is the economy's and the kernel's business, not the planner's.

**Hearing of the far shore.** A player can only choose a destination
they can name, and today the far continent is mechanically reachable
but *unnameable*: `knownMap`'s rumours come from visited neighbours,
and province nodes are never visited — `markVisited` only ever touches
regions, so the sea edge between ports connects two permanent
strangers. The load-bearing fix is one rule: **`discovered` bubbles up
`parent` links on visit** (never clearing `stub` — the same
distinction `promoteNode` already draws). Visit any region and its
province is seen; the province's sea lane puts the far port in
`knownMap.rumoured`; the far port's detail-0 hook — *"sailors will not
name it after dark"* — is the brochure. Sailors' tales are not new
machinery; they are `knownMap` working as designed.

**Landfall.** Sea arrivals anchor at `port: true` provinces, resolved
by `portAnchorOf(geo, provinceId)` to a deterministic harbor region.
Air and portals may land anywhere: `mintLandfall(geo, provinceId,
{ via })` mints a landfall region + `site:landfall` stub, seeded from
the province seed so replay and shared cartridges agree on where the
wanderer came down. This closes a gap the plan had left open: **nobody
minted a province's first region** — the skeleton stops at provinces
and `expandFrom` grows region-from-region, which the home continent's
starting region masked. The `'province'` template's `mints` now
includes its initial region stubs.

**The cold landing.** Arriving where every ancestor is a stub
hydrates the lineage top-down — `ensureLineage`: continent outline
(tiny), province outline (tiny), landing region (medium). A 6–8-day
crossing is the *most generous latency budget in the game*: three
calls spread across six narration beats. Portals invert it — zero
days, zero budget — so portals are **fallback-first by design**: the
template's procedural fallback *is* the arrival, marked provisional,
and the real hydration supersedes it behind the first scene. One
coherence rule joins section 7: a provisional fact the players *acted
on* is promoted to a hint-commitment the real hydration must consume —
what the table saw, the world keeps.

**The story follows; it doesn't strand.**

- **Travel days are the world's clock ticks.** Journey days feed
  `tickAll` — the contested succession at home advances *because* the
  party spent eight days at sea. The diegetic cost and the
  moving-world are one mechanism, not two.
- The red thread re-anchors: the destination continent's **threat
  expression** (its `deriveBlueprint` slice) is the same world-threat
  wearing local clothes, and the next act — generated from what
  actually happened, gazetteer-constrained to the new continent's
  known nodes — binds to it. The explorer's dividend (section 4)
  guarantees the gazetteer isn't empty on arrival.
- **Coming home is cheap by construction** — home is canon, zero
  hydration. What needs assembling is the recap:
  `whileYouWereGone(clocks, ledger, { sinceTurn })`, a pure digest of
  clocks that filled and provisionals that were superseded while the
  party was away.
- **Death far from home** changes nothing here: dying is the kernel's
  business; worldgen's only promise is that far-continent canon
  persists in the ledger, whoever comes looking next.

**Honest danger.** The world does not scale to the party — chosen
deliberately over rubber-banding. Each continent's blueprint slice
carries a `menace` tier, expressed **only through signposting** the
machinery already has: detail-0 hooks, scoped hints, legend rumors,
what the sailors refuse to say. Informed risk is the fun; walking into
a place that outclasses you is a choice the world telegraphed. And a
hard fence for hosts that insist otherwise: scaling must live as a
session-local ledger *view*, never a patch — write it into canon and
two players mounting the same cartridge no longer share a world
(section 11's byte-identical guarantee).

## 10 · Layouts — space that makes sense

Dungeons already have honest space: rooms on a grid, exits derived
from adjacency, lock-and-key over the graph. Settlements have none —
`SETTLEMENT_SCHEMA` is a cast list with gates, and "you walk left from
the bakery to the butcher" is re-improvised every scene, which is
exactly how a table GM drifts when nobody wrote the street down. The
common craft answer — in interactive fiction, MUDs, and every GM's
actual notebook — is not a geometric map but a **location graph with
landmarks**: notable places as nodes, streets as edges with
directions, districts when the settlement outgrows one graph. We make
it persistent the same way we made dungeons persistent: seed it.

- **One layout engine, two costumes.** The dungeon generator's spatial
  core — grid placement, spine + branches, derived cardinal exits — is
  extracted (guarded by the existing dungeon tests; its output must not
  change) into a shared `generateLayout`. A dungeon dresses it as
  corridors and rooms; a settlement dresses it as **the high street
  and its lanes**: spine = market row (entrance gate at one end, the
  seat/square where the vault was), branches = side lanes, plots
  instead of rooms. Pure and seeded from the site seed — free,
  deterministic, replay- and cartridge-safe. Layouts never need
  baking; only their dressing is patches.
- **A scale ladder, recursing the LOD.** Hamlet = a single path;
  village = spine + branches; town and city = a **district graph**
  where each district is its own lazily-hydrated layout
  (`site:district` — stubs until entered, like everything else in the
  tree). A city is not a bigger graph; it is a tree of small ones.
- **Placement is procedural; dressing is LLM.** The settlement's
  building list (blueprint `buildingTypes`, the buildings its template
  mints) is *placed* onto plots deterministically. The model writes
  what the bakery smells like; it never chooses where the bakery
  stands — the same `method: mixed` division dungeons already use.
  Buildings are interiors: detail on entry.
- **Movement is free navigation.** No travel FSM inside the walls —
  walking the graph is narration, like dungeon rooms. The settlement's
  `exits[]` (already in the schema) are its gates, and each gate binds
  to a layout node on one side and a region edge on the other.
- **Bindings are post-conditions** (section 7 machinery): every NPC
  with a workplace role resolves to a plot that carries their building
  (the innkeeper's inn exists, and is *somewhere*); every gate lands
  on a layout edge node. A violation coerces like any other dangling
  reference.

So the walk from the bakery, down the lane and left to the butcher, is
the same walk in session forty — not because anyone wrote prose down,
but because the street graph was never prose in the first place.

## 11 · Pre-generated worlds — cartridges and MCP playback

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

## 12 · Phases

Each phase is one branch → PR → merge, tests green, in this order —
every phase is independently shippable and the ones after C are
parallel-friendly:

- **A · Scoped blueprints** — `deriveBlueprint`, `THEME_CLIMATES`,
  climate spread, naming cultures, scoped hint formatters, deprecation
  shims. *Fixes the frozen-tomb bug on its own.* (minor bump)
- **B · Lore entities** — crown/legend/era schemas + genesis stubs +
  the explorer's-dividend binding rule (≥1 legend site on each
  continent's first port province) + `legal.test.js` coverage of every
  new table. (minor)
- **C · Hydration** — sites as nodes, the template registry with
  consumes/mints/post-conditions and procedural fallbacks (the
  `'province'` template mints its initial region stubs),
  `lineageContext` + `ensureLineage`, `hydrateNode` with the coercion
  ladder and atomic commit, hint-commitments + neighbour digests +
  observed-provisional promotion, `discoverAncestors` bubbling,
  promotion triggers (including the gazetteer constraint on beats),
  ledger-canon wiring. (minor)
- **D · Cartridges** — bake script, envelope format, catalog layout.
  Deliberately bakes nothing new for crossings or layouts: no
  coordinates, no coastal flags — the envelope is untouched. (minor)
- **E · MCP surface** — resources + tools + playback, in
  `bag-of-holding-mcp`; port-anchor regions are the natural pre-bake
  candidates for `world_hydrate`. (that package's own versioning)
- **F · Crossings** — `planJourney` + `TRAVEL_MODES`, the
  `routeBetween` traversability predicate, FSM options-bag shims,
  `mintLandfall` + `portAnchorOf`, travel-days → `tickAll` wiring,
  `menace` + signposting hints, `whileYouWereGone`, mode-flavored
  discovery tables through the legal sweep. The planner half depends
  only on `geography.js` and can land any time; the landfall half
  depends on C. (minor)
- **G · Layouts** — extract the layout engine from
  `dungeon/generate.js` with its output pinned by the existing dungeon
  tests, then `generateLayout` for settlements, the district ladder
  (`site:district`), deterministic building placement, gate/NPC
  bindings. Pure procedural, no LLM calls; parallel-friendly. (minor)

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
