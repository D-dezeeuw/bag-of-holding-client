# A generated world

This directory runs the full lore-tree worldgen pipeline
([`docs/worldgen-lore-tree.md`](../../docs/worldgen-lore-tree.md),
phases A–G) end to end against a real seed and exports what it
produces: a JSON snapshot of everything generated, and an EPUB "world
bible" assembled from the same material.

```sh
node examples/world/generate.mjs [seed]   # defaults to 1234
```

## What's here

- **`generate.mjs`** — the script. Bakes a genesis, hydrates one full
  region + its settlement + dungeon site, hydrates a legend and a
  crown, plans and samples a sea crossing to a second continent, mints
  a separate air-landfall on unclaimed shore, lays out the
  settlement's streets, and exports both files below.
- **`mini-canvas.mjs`** — a from-scratch `OffscreenCanvas` stand-in.
  `src/output/epub.js` is deliberately browser-only (its cover art
  needs a canvas, which Node doesn't have); this polyfill exists only
  so the example can call `buildEpub()` under plain `node`, without
  adding a canvas dependency to anyone's tree. It is not part of the
  published package — nothing under `examples/` ships in the npm
  tarball.
- **`world-1234.json`** — everything the pipeline generated for seed
  `1234`: the world seed, the baked cartridge (skeleton + lore +
  blueprint slices), the hydrated region/settlement/dungeon-site/
  legend/crown/landfall content, the procedurally generated dungeon
  crawl, the planned crossing with a sampled travel log, and the
  settlement's street layout with NPC bindings.
- **`world-1234.epub`** — the same generation read as a book: one
  chapter per major piece of content, opening with the world's
  premise and closing with a wanderer's landfall on a second
  continent.

## Reading it

`world-1234.epub` opens in any e-reader (Apple Books, calibre,
Thorium, the Kindle app via conversion, etc.). `world-1234.json` is
plain data — every field is documented by the schema it was hydrated
against (`src/worldgen/schemas.js`) or, for procedural content, by the
generator that produced it (`src/dungeon/generate.js`,
`src/layout/settlement.js`).

## On the model

Generation with `OPENROUTER_API_KEY` set hydrates real prose for the
world seed, the region, the settlement, the legend, and the crown —
the pieces that matter most for a readable book. The cartridge bake
itself (continent and province outlines) runs *without* a live
completer on purpose: it's nine sequential calls for content that
already reads fine from its deterministic hook text, and keeping it
procedural bounds the script's total run time against a free-tier
model's very uneven latency (individual calls in this run ranged from
under a minute to several minutes).

Every hydration is resilient by design — this is not a script-level
workaround, it's the pipeline working as built: a model that returns
nothing usable falls back to each hydration template's procedural
content (marked `provisional: true` in the JSON) rather than blocking
or crashing. Set `OPENROUTER_API_KEY` for the richest run; without one,
the script still completes and produces a fully valid — just
plainer — book, in seconds.

## Regenerating

Re-running with the same seed is **not** guaranteed to reproduce this
exact file: LLM sampling isn't deterministic (this is exactly why
`bakeCartridge`'s cartridges freeze *model output*, not just the seed —
see doc 18 §11). The deterministic parts — the skeleton, the lore
stubs, the dungeon crawl, the settlement layout, the blueprint slices —
will always match; the hydrated prose will vary run to run whenever a
completer is used.
