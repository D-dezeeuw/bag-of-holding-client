// tests/legal.test.js — content hygiene guard.
//
// The blueprint's god table used to list real deities from published settings
// (Kelemvor, Mystra, Lolth, Pelor …) as prompt exemplars, and five threat
// entries named Product Identity creatures the kernel's docs/legal.md rules
// out explicitly. Both shipped for months because nothing checked: the tables
// are plain data, so no test had a reason to look at them.
//
// This suite scans the *data that reaches a prompt* — the archetype tables, the
// dungeon overlays, and the rendered constraint strings — rather than the source
// text, so the comments explaining what was removed do not trip their own guard.
//
// The list below is illustrative, not exhaustive. The actual rule lives in
// docs/legal.md in the kernel repo: SRD 5.2 content by name is fine, generic
// terms are fine, invented names are fine, and everything else gets invented.
// Deliberate keeps: lich, vampire, hag, djinni, kraken, tarrasque and aboleth
// are SRD-listed monsters, not Product Identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TABLES, buildBlueprint, deriveBlueprint, blueprintContext,
         worldSeedConstraints, beatsHints, factionsHints, regionHints, settlementHints,
         THEME_CLIMATES, BAND_SETTLEMENTS, THREAT_EXPRESSIONS } from '../src/worldgen/blueprint.js';
import { DUNGEON_OVERLAYS } from '../src/dungeon/generate.js';
import { mintLore, ERA_NAMES, LEGEND_TITLE_A, LEGEND_TITLE_B, CROWN_TITLES, LEGITIMACIES,
  FACTION_NAME_A, FACTION_NAME_B, WAR_CAUSES, WAR_INTENSITIES,
  NPC_GIVEN_NAMES, NPC_VOICES, NPC_WANTS } from '../src/worldgen/lore.js';
import { mintWorldSkeleton } from '../src/worldgen/skeleton.js';
import { TRAVEL_MODES, LANDFALL_HOOKS } from '../src/travel/modes.js';
import { MENACE_TIERS, menaceHints, MENACE_SIGNPOSTS } from '../src/worldgen/blueprint.js';
import { ROLE_BUILDINGS } from '../src/layout/settlement.js';
import { cityLayout } from '../src/layout/settlement.js';

// Product Identity creatures named in docs/legal.md, plus the setting and
// character names it rules out, plus the deity roster this table used to carry.
// Short or ordinary English words (mask, bane, helm, tyr) are deliberately
// omitted — they would fire on innocent prose and the boundary match cannot
// tell a god from a noun.
const FORBIDDEN = [
  // Product Identity creatures
  'beholder', 'mind flayer', 'illithid', 'yuan-ti', 'yuanti', 'slaad',
  'displacer beast', 'carrion crawler', 'githyanki', 'githzerai', 'kuo-toa',
  'modron',
  // Characters Wizards owns
  'mordenkainen', 'tasha', 'bigby', 'tenser', 'drizzt', 'elminster',
  'acererak', 'strahd', 'vecna',
  // Setting names
  'forgotten realms', 'eberron', 'greyhawk', 'faerun', 'faerûn', 'waterdeep',
  'neverwinter', 'sword coast', 'underdark', 'feywild', 'shadowfell',
  'dragonlance', 'ravenloft',
  // Deities from published settings
  'kelemvor', 'myrkul', 'raven queen', 'tempus', 'gruumsh', 'silvanus',
  'mielikki', 'chauntea', 'cyric', 'lolth', 'lathander', 'pelor', 'oghma',
  'mystra', 'azuth', 'umberlee', 'moradin', 'ilmater', 'lliira', 'boldrei',
  'jergal', 'wee jas', 'pholtus', 'aureon', 'selune', 'sehanine', 'celestian',
  'corellon', 'boccob', 'erythnul', 'tharizdun', 'procan', 'sashelas',
  'malar', 'ehlonna', 'obad-hai', 'celanil', 'dal quor',
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERN = new RegExp(`\\b(${FORBIDDEN.map(escape).join('|')})\\b`, 'i');

// Collect every string reachable in a value, with the path that found it.
function strings(value, path = '$', out = []) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  }
  return out;
}

function offendersIn(value, label) {
  return strings(value, label)
    .filter(([, s]) => PATTERN.test(s))
    .map(([p, s]) => `${p} → "${s}" (matched ${s.match(PATTERN)[0]})`);
}

describe('content hygiene', () => {
  it('ships no product-identity names in the archetype tables', () => {
    const bad = offendersIn(DEFAULT_TABLES, 'DEFAULT_TABLES');
    assert.deepEqual(bad, [], `forbidden names in blueprint tables:\n${bad.join('\n')}`);
  });

  it('ships no product-identity names in the dungeon overlays', () => {
    const bad = offendersIn(DUNGEON_OVERLAYS, 'DUNGEON_OVERLAYS');
    assert.deepEqual(bad, [], `forbidden names in dungeon overlays:\n${bad.join('\n')}`);
  });

  it('ships no product-identity names in the scoped-blueprint tables', () => {
    const bad = [
      ...offendersIn(THEME_CLIMATES, 'THEME_CLIMATES'),
      ...offendersIn(BAND_SETTLEMENTS, 'BAND_SETTLEMENTS'),
      ...offendersIn(THREAT_EXPRESSIONS, 'THREAT_EXPRESSIONS'),
    ];
    assert.deepEqual(bad, [], `forbidden names in scoped tables:\n${bad.join('\n')}`);
  });

  it('ships no product-identity names in the travel/menace tables', () => {
    const bad = [
      ...offendersIn(TRAVEL_MODES, 'TRAVEL_MODES'),
      ...offendersIn(LANDFALL_HOOKS, 'LANDFALL_HOOKS'),
      ...offendersIn(MENACE_TIERS, 'MENACE_TIERS'),
      ...offendersIn(MENACE_SIGNPOSTS, 'MENACE_SIGNPOSTS'),
      ...MENACE_TIERS.flatMap(m => offendersIn(menaceHints({ menace: m }), `menaceHints(${m})`)),
    ];
    assert.deepEqual(bad, [], `forbidden names in travel tables:\n${bad.join('\n')}`);
  });

  // MENACE_SIGNPOSTS is the reader-safe half of menaceHints — it must cover
  // every tier (a book chapter can't fall back to nothing) and must never
  // carry menaceHints' generator-facing instruction clause.
  it('MENACE_SIGNPOSTS covers every tier and stays reader-facing', () => {
    for (const tier of MENACE_TIERS) {
      assert.ok(MENACE_SIGNPOSTS[tier], `no signpost for ${tier}`);
      assert.doesNotMatch(MENACE_SIGNPOSTS[tier], /never state a tier|adjust any creature/i);
    }
  });

  it('ships no product-identity names in the layout tables', () => {
    const bad = [
      ...offendersIn(ROLE_BUILDINGS, 'ROLE_BUILDINGS'),
      ...offendersIn(cityLayout(7), 'cityLayout(7)'),
    ];
    assert.deepEqual(bad, [], `forbidden names in layout tables:\n${bad.join('\n')}`);
  });

  it('ships no product-identity names in the lore tables or minted lore', () => {
    const bad = [
      ...offendersIn({ ERA_NAMES, LEGEND_TITLE_A, LEGEND_TITLE_B, CROWN_TITLES, LEGITIMACIES,
        FACTION_NAME_A, FACTION_NAME_B, WAR_CAUSES, WAR_INTENSITIES,
        NPC_GIVEN_NAMES, NPC_VOICES, NPC_WANTS }, 'lore tables'),
    ];
    for (let seed = 1; seed <= 20; seed++) {
      bad.push(...offendersIn(mintLore(mintWorldSkeleton(seed), seed), `mintLore seed ${seed}`));
    }
    assert.deepEqual(bad, [], `forbidden names in lore:\n${bad.slice(0, 10).join('\n')}`);
  });

  it('renders no product-identity names through the scoped chain', () => {
    const bad = [];
    for (let seed = 0; seed < 100; seed++) {
      const world = deriveBlueprint(null, seed, 'world');
      const cont = deriveBlueprint(world, seed + 1, 'continent');
      const prov = deriveBlueprint(cont, seed + 2, 'province');
      const reg = deriveBlueprint(prov, seed + 3, 'region');
      bad.push(...offendersIn({
        slices: [cont, prov, reg],
        region: regionHints(world, reg),
        settlement: settlementHints(world, reg),
      }, `seed ${seed}`));
    }
    assert.deepEqual(bad, [], `forbidden names in scoped output:\n${bad.slice(0, 10).join('\n')}`);
  });

  // The tables are only half the surface: a clean table can still compose into
  // a dirty prompt. Sweep a spread of seeds through every formatter that ends
  // up in a system message.
  it('renders no product-identity names into any prompt constraint', () => {
    const bad = [];
    for (let seed = 0; seed < 250; seed++) {
      const bp = buildBlueprint(seed);
      const rendered = {
        blueprintContext: blueprintContext(bp),
        worldSeedConstraints: worldSeedConstraints(bp),
        beatsHints: beatsHints(bp),
        factionsHints: factionsHints(bp),
        regionHints: regionHints(bp),
        settlementHints: settlementHints(bp),
      };
      bad.push(...offendersIn(rendered, `seed ${seed}`));
    }
    assert.deepEqual(bad, [], `forbidden names in rendered prompts:\n${bad.slice(0, 10).join('\n')}`);
  });

  // Guards the shape change: `exemplars` held proper nouns, `epithets` holds
  // descriptions. Reintroducing the old key is the likely shape of a regression.
  it('describes gods by epithet, never by name', () => {
    for (const entry of DEFAULT_TABLES.godDomains) {
      assert.ok(!('exemplars' in entry), `${entry.domain}: 'exemplars' is the retired name-carrying field`);
      assert.ok(Array.isArray(entry.epithets) && entry.epithets.length > 0, `${entry.domain}: needs epithets`);
      for (const e of entry.epithets) {
        // An epithet is a description. A capitalised bare word is a name
        // wearing a description's clothes.
        assert.ok(e.length > 12, `${entry.domain}: "${e}" is too short to be an epithet`);
        assert.ok(/\s/.test(e), `${entry.domain}: "${e}" looks like a name, not a description`);
      }
    }
  });

  // Cleaning our tables does not stop a model from answering "god of death"
  // with one it read about; the constraint has to say so.
  it('tells the model to invent original names', () => {
    const ctx = blueprintContext(buildBlueprint(1234));
    assert.match(ctx, /invent original names/i);
    assert.match(ctx, /published fantasy settings/i);
  });
});
