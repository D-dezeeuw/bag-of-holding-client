#!/usr/bin/env node
// scripts/bake-world.js — bake a world cartridge to disk (doc 18 §11).
//
//   node scripts/bake-world.js --seed 1234 [--out worlds/] [--eras 4]
//
// Without a key the bake is procedural (detail-0 stubs + lore + slices) —
// already mountable, hydrating at the table. With OPENROUTER_API_KEY set the
// bake also hydrates continent/province outlines (detail ≤ 1), which is what
// makes cold landings instant on a shared world. Writes world-<seed>.json and
// refreshes catalog.json alongside it. Existing cartridges are never
// overwritten: a published world is immutable, same rule as an npm version.

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { bakeCartridge, catalogEntry } from '../src/worldgen/cartridge.js';
import { chatCompletion } from '../src/llm/client.js';

const args = process.argv.slice(2);
const argOf = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};

const seed = Number(argOf('--seed'));
if (!Number.isFinite(seed)) {
  console.error('usage: node scripts/bake-world.js --seed <number> [--out worlds/] [--eras <3-5>]');
  process.exit(1);
}
const outDir = argOf('--out', 'worlds');
const eraCount = argOf('--eras') ? Number(argOf('--eras')) : null;

const key = process.env.OPENROUTER_API_KEY ?? null;
const complete = key
  ? ({ tier, schema, prompt }) => chatCompletion({ key }, {
      tier, schema, messages: [{ role: 'user', content: prompt }],
    })
  : null;

const cartridge = await bakeCartridge(seed, { complete, eraCount });
const id = `world-${seed}`;
const file = join(outDir, `${id}.json`);

await mkdir(outDir, { recursive: true });
try {
  await access(file);
  console.error(`${file} already exists — a baked world is immutable. Pick another seed.`);
  process.exit(1);
} catch { /* good: not there yet */ }

await writeFile(file, JSON.stringify(cartridge));

const catalogFile = join(outDir, 'catalog.json');
let catalog = [];
try { catalog = JSON.parse(await readFile(catalogFile, 'utf8')); } catch { /* fresh catalog */ }
catalog = catalog.filter(e => e.id !== id);
catalog.push(catalogEntry(cartridge, { id }));
catalog.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(catalogFile, JSON.stringify(catalog, null, 2));

const entry = catalog.find(e => e.id === id);
console.log(`baked ${file}`);
console.log(`  digest ${entry.digest} | ${entry.continents} continents, ${entry.provinces} provinces, ${entry.legends} legends, ${entry.outlined} outlined`);
console.log(key ? '  outlines: hydrated via model' : '  outlines: none (set OPENROUTER_API_KEY to bake detail-1)');
