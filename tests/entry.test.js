// tests/entry.test.js — the public entry point is the only thing a consumer
// ever touches, and until this file nothing tested it. Every other suite
// imports `../src/**` directly, so a stale re-export in index.js — a renamed
// symbol, a moved module, a file left out of package.json `files` — would pass
// the whole suite and ship broken to npm. The package publishes `.` → index.js
// and nothing else, so if this module does not load, the release is dead on
// arrival regardless of how green src/ is.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as entry from '../index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('public entry point', () => {
  it('loads and exports a non-trivial surface', () => {
    const names = Object.keys(entry);
    assert.ok(names.length > 100, `expected a broad surface, got ${names.length} exports`);
  });

  // A re-export of a symbol the source no longer provides resolves to
  // `undefined` rather than throwing, so it survives until a consumer calls it.
  it('has no undefined re-exports', () => {
    const dangling = Object.keys(entry).filter((n) => entry[n] === undefined);
    assert.deepEqual(dangling, [], `dangling re-exports: ${dangling.join(', ')}`);
  });

  // One representative export per subsystem in index.js's own section order.
  // If a whole module goes missing from the bundle these fail before the
  // surface-size check gets vague about which half vanished.
  it('exposes every advertised subsystem', () => {
    const perSubsystem = {
      llm: ['chatCompletion', 'chatStream', 'JsonFieldStreamer', 'ApiError', 'resolveModel'],
      media: ['generateImage', 'synthesizeSpeech', 'transcribeAudio'],
      ledger: ['makeId', 'makePatch', 'fold', 'compact'],
      worldgen: ['buildBlueprint', 'deriveBlueprint', 'THEME_CLIMATES', 'runPipeline', 'mintWorldSkeleton', 'WORLD_SEED_SCHEMA'],
      lore: ['mintLore', 'mintEras', 'mintCrownStub', 'CROWN_SCHEMA', 'LEGEND_SCHEMA'],
      dungeon: ['generateDungeon', 'DUNGEON_OVERLAYS'],
      narrative: ['currentBeat', 'makeAct', 'adjustReputation', 'makeClock'],
      settlement: ['resolvePurchase', 'makeQuest', 'pushDialogue'],
      travel: ['beginTravel', 'stepTravel', 'runTravel'],
      output: ['buildZip', 'buildEpub', 'crc32'],
      persistence: ['wrapEnvelope', 'loadEnvelope', 'openCold', 'splitSave'],
    };
    for (const [subsystem, names] of Object.entries(perSubsystem)) {
      for (const name of names) {
        assert.ok(name in entry, `${subsystem}: missing export ${name}`);
      }
    }
  });

  it('keeps the documented install surface importable', () => {
    // `files` is what actually reaches the tarball; index.js + src/ are the
    // two entries the export map depends on.
    assert.ok(pkg.files.includes('index.js'), 'package.json files must ship index.js');
    assert.ok(pkg.files.includes('src/'), 'package.json files must ship src/');
    assert.equal(pkg.exports['.'].import, './index.js');
    assert.equal(pkg.main, 'index.js');
  });

  // The kernel is an optional peer: this package must load standalone, which
  // is what lets the suite run without @zeeuw/bag-of-holding installed at all.
  it('does not depend on the rules kernel at load time', () => {
    assert.equal(pkg.peerDependenciesMeta?.['@zeeuw/bag-of-holding']?.optional, true);
    assert.equal(pkg.dependencies, undefined, 'must stay zero-runtime-dependency');
  });
});
