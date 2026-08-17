# Generation dials & travel

The knobs an admin surface (or any host) can expose, and the travel
contract that connects the world they generate. Every number below is
measured, not guessed — the envelopes come from the 2026-08 scalability
audit. The standing rule for all dials: **defaults reproduce the
pre-dial output byte-for-byte** (rng streams untouched), so turning
nothing changes nothing.

## World dials — `bakeCartridge(seed, options)`

| Dial | Default | What it does | Measured envelope |
| --- | --- | --- | --- |
| `continents` | 2–4 (seeded roll) | landmass count | 12×8 bakes in ~9 ms at ~164 KB; 30×20 in ~725 ms at ~957 KB (~650 B/node) |
| `provincesPer` | 2–4 per continent | provinces per landmass | climate bands repeat past 8 per continent (8-band deck wraps) |
| `factionCount` | 3 | world powers | relations + wars are O(n²): 20 factions ≈ 24 KB of war state; keep ≤ ~20 unless you want a war-torn epic |
| `npcsPerFaction` | 1 | faces per power (leader + notables) | 12 factions × 3 = 36 world NPCs in one bag |
| `legendCount` | 2–3 per continent | legend stubs | title pool is 100 combos |
| `eraCount` | 3–5 | historical eras | table holds 10; higher counts truncate |

Names are deduplicated world-wide since 0.32.0 (stream-preserving:
only a *colliding* draw is rerouted), so dialed-up worlds keep unique
continent/province names all the way to pool exhaustion, then take
numerals.

```js
const cart = await bakeCartridge(1234, {
  continents: 6, provincesPer: 5,
  factionCount: 12, npcsPerFaction: 3,
});
```

## Settlement & city dials — `settlementLayout` / `cityLayout`

- The ladder: `hamlet`, `village`, `town`, `city` (8–12 spine),
  `metropolis` (12–16). Unknown kinds **throw** naming the ladder.
- `size: { spineMin, spineMax, branchMin, branchMax }` overrides the
  ladder row entirely — a 100-building order lands on plots when the
  street plan is sized for it (overflow still gathers on the square as
  market stalls, by design).
- `cityLayout(seed, { districts })` — quarter names cycle with numerals
  past eight ("market II"); each district is its own lazily-hydrated
  settlement.
- Branch attachment saturates: a spine of length S holds at most ~0.9×S
  branches. To build bigger, lengthen the spine, don't stack branches.

## Dungeon dial — `generateDungeon(seed, { size, maxEnemies })`

- `size` scales the graph; measured: ~100 rooms in 0.6 ms, ~5,000 rooms
  in ~55 ms (the practical ceiling for interactive use).
- Enemy density defaults to `max(3, rooms/8)` (≤31-room dungeons are
  byte-identical to the old fixed cap of 3); `maxEnemies` is the
  explicit dial. The lock-and-key gate stays correct at every measured
  size (0 broken seeds in 500 at 100 rooms).

## The travel contract

How the generated world connects, layered the way real D&D campaigns
layer it — distance is a **cost** early and a **key** late:

1. **Roads** (`border` edges) chain a continent's provinces. Free,
   evented, 2–4 days each.
2. **Sea lanes** (`sea` edges) form a ring over every port — coastal
   runs 2–4 days, crossings 4–8. Requires `capabilities.sea` (a ship is
   a capability, not a simulation). Legs carry
   `costHint: { passageGoldPerDay: 1 }` for the economy to price.
   Long crossings split by days into resupply legs.
3. **Air** halves the underlying route's days
   (`capabilities.air`, `costHint: { charterGoldPerDay: 5 }`).
4. **Waygates** (`gate` edges): every continent's middle province holds
   a dormant ancient gate. 0 days, no encounters, one scene, toll hint
   `{ tollGold: 25 }` — and they open ONLY when the party holds
   `capabilities.gate` (the quest-reward attunement) *and* has
   discovered both endpoints. "You must have seen the circle," as data.
   Dormant gates never affect default routing — `routeBetween` skips
   them unless a predicate opts in.

```js
const plan = planJourney(geo, home, farCapital, {
  capabilities: { sea: true, gate: hasAttunement },
});
// plan.legs → [{ from, to, mode, days, segments, path, costHint }, …]
// plan.mode → 'gate' | 'sea' | 'road' | 'air' (the headline)
```

Settings re-skin the gates' prose at hydration like everything else: a
Sundermark relic-arch, a Brassgear pressure-rail terminus, a Hollow
Vale mist-door. The skeleton only places them.

## Known envelopes (the honest limits)

- Travel graph: interactive to ~1,000 nodes; ~2,000 is the ceiling
  (~100 ms per route query).
- Red thread: no beat cap; a 200-beat campaign costs ~2.5 ms of
  evaluator time across its whole life (acts engine). The cost of a
  1000-hour campaign is content generation, not evaluation.
- Ledger: `compact()` bounds fold work; keep the hot tail at the
  persistence layer's defaults (50 transcript / 200 ledger entries).
- Worlds are extended after baking via revisions (adds are always
  clean); note that revisions cannot yet add *edges* — connecting new
  territory is tracked as backlog.
