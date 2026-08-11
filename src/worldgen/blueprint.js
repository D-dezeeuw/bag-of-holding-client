// src/worldgen/blueprint.js — seeded world blueprint factory + prompt-constraint
// formatters.
//
// A blueprint is a deterministic set of archetype choices (tone, world archetype,
// threat, climate, factions, dungeon theme, gods, buildings, landmarks) drawn
// from curated tables with a seeded rng. It shifts each AI generator's job from
// "invent everything" to "flesh out these constraints". Same seed → same
// blueprint → reproducible worlds.
//
// DEFAULT_TABLES ships a complete D&D-flavoured archetype set; a host can pass
// its own `tables` to re-skin the genre. The `*Hints` / `blueprintContext`
// formatters turn a blueprint into the constraint strings appended to each
// generator's system prompt (host-agnostic — they read the blueprint shape only).

import { TONES } from './tones.js';

import { pick, pickN, mulberry32 } from './rng.js';

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// ─── Default archetype tables ─────────────────────────────────────────────────

export const DEFAULT_TABLES = Object.freeze({
  tones: [...TONES],

  worldArchetypes: [
    'post-collapse empire', 'frontier expansion', 'divine conflict',
    'creeping corruption', 'ancient awakening', 'invasion from beyond',
    'succession crisis', 'forbidden knowledge', 'dying world',
    'planar convergence', 'eternal war', 'shattered continent',
    'theocratic tyranny', 'merchant republic', 'nomadic wasteland',
    'underwater dominion', 'sky archipelago', 'prison realm',
    'dream-touched lands', 'clockwork civilization', 'plague aftermath',
    'dragon age', 'fey-mortal border', 'subterranean ascent',
  ],

  // Threats stay generic or SRD-listed. Five entries here used to name
  // Product Identity creatures the kernel's docs/legal.md rules out by name
  // (mind flayer, beholder, yuan-ti, githyanki, modron); two more leaned on
  // setting-specific plane names (Feywild, Shadowfell). Each is replaced by
  // the threat *shape* it was reaching for, which the model can dress however
  // the tone wants. Lich, vampire, hag, djinni, kraken, tarrasque and aboleth
  // are SRD monsters and stay.
  threatTypes: [
    'undead plague', 'demonic incursion', 'dragon tyranny',
    'psionic hive', 'lich ritual', 'fey realm breach',
    'orc horde', 'cult ascension', 'elemental upheaval',
    'vampire court', 'abyssal rift', 'aberrant conspiracy',
    'serpentfolk infiltration', 'kraken awakening', 'tarrasque stirring',
    'shadow-realm bleed', 'clockwork legion march', 'astral raider fleet',
    'aboleth domination', 'werewolf curse', 'hag coven',
    'djinn wish gone wrong', 'titan prison cracking', 'void entity',
  ],

  beatArcs: {
    grimdark:   ['omen', 'discovery', 'betrayal', 'sacrifice', 'pyrrhic victory'],
    heroic:     ['call to action', 'gathering allies', 'trial', 'darkest hour', 'triumph'],
    mysterious: ['whisper', 'clue', 'revelation', 'reversal', 'truth'],
    tragic:     ['hope', 'hubris', 'fall', 'consequence', 'acceptance'],
    whimsical:  ['curiosity', 'misadventure', 'unlikely ally', 'chaos', 'bittersweet resolution'],
  },

  factionArchetypes: [
    { type: 'crown',           desc: 'ruling monarchy or imperial authority' },
    { type: 'church',          desc: 'organized religion with political power' },
    { type: 'military',        desc: 'standing army or knightly order' },
    { type: 'rebellion',       desc: 'oppressed group fighting for freedom' },
    { type: 'cult',            desc: 'secret worshippers of a dark or forbidden power' },
    { type: 'syndicate',       desc: 'criminal network — thieves guild, smugglers, assassins' },
    { type: 'guild',           desc: 'trade or craft organization with economic leverage' },
    { type: 'warband',         desc: 'nomadic fighters, raiders, or mercenaries' },
    { type: 'circle',          desc: 'druids, sages, or arcanists pursuing knowledge' },
    { type: 'inquisition',     desc: 'zealots hunting heresy, witchcraft, or monsters' },
    { type: 'merchant house',  desc: 'wealthy trading dynasty controlling supply lines' },
    { type: 'spy network',     desc: 'intelligence agency or shadow council' },
    { type: 'undead legion',   desc: 'organized undead under a lich or vampire lord' },
    { type: 'dragonsworn',     desc: 'mortals serving a dragon overlord' },
    { type: 'ranger corps',    desc: 'wilderness protectors, monster hunters' },
    { type: 'pirate fleet',    desc: 'naval raiders controlling sea routes' },
    { type: 'exile commune',   desc: 'banished outcasts forming their own society' },
    { type: 'elemental lodge',  desc: 'elementalists harnessing primal forces' },
    { type: 'blood pact',      desc: 'warlocks bound by a shared patron' },
    { type: 'ancestors watch', desc: 'spirit-channelers preserving ancient traditions' },
  ],

  climates: [
    'frozen tundra', 'boreal taiga', 'temperate forest',
    'rolling grasslands', 'arid desert', 'rocky badlands',
    'coastal cliffs', 'tropical coast', 'mangrove swamp',
    'highland plateau', 'volcanic caldera', 'deep canyon',
    'river delta', 'island chain', 'underground caverns',
    'floating islands', 'petrified forest', 'crystal wastes',
    'mushroom jungle', 'eternal twilight moor',
  ],

  settlementTypes: {
    'frozen tundra':         ['frontier outpost', 'mining camp', 'fortified lodge', 'ice-fisher village'],
    'boreal taiga':          ['logging town', 'trapper hamlet', 'wolf-rider camp', 'monastery'],
    'temperate forest':      ['farming village', 'woodland hamlet', 'crossroads town', 'mill town'],
    'rolling grasslands':    ['herder camp', 'caravan waystation', 'horse-lord hold', 'market town'],
    'arid desert':           ['oasis trading post', 'canyon settlement', 'sandstone citadel', 'nomad bazaar'],
    'rocky badlands':        ['cliff dwelling', 'ruin-scavenger camp', 'bandit hideout', 'quarry town'],
    'coastal cliffs':        ['fishing village', 'lighthouse garrison', 'smuggler cove', 'shipwright town'],
    'tropical coast':        ['pearl-diver hamlet', 'port town', 'plantation estate', 'pirate haven'],
    'mangrove swamp':        ['stilt village', 'herbalist commune', 'lizardfolk trading post', 'druid grove'],
    'highland plateau':      ['fortress town', 'goat-herder settlement', 'sky temple', 'watchpost'],
    'volcanic caldera':      ['forge city', 'obsidian mining camp', 'fire-cult commune', 'refugee camp'],
    'deep canyon':           ['rope-bridge town', 'cave settlement', 'hermit cluster', 'mine head'],
    'river delta':           ['barge town', 'rice-farming village', 'ferry crossing', 'flood-watch post'],
    'island chain':          ['harbor village', 'coral-diver camp', 'marooned colony', 'sea-elf enclave'],
    'underground caverns':   ['mushroom farm', 'duergar outpost', 'crystal market', 'exile colony'],
    'floating islands':      ['sky-dock', 'wind-temple', 'cloud shepherd camp', 'aeronaut guild'],
    'petrified forest':      ['stone-cutter camp', 'ghost town', 'druid circle', 'fossil dig'],
    'crystal wastes':        ['shard-miner outpost', 'arcane observatory', 'nomad camp', 'rift shelter'],
    'mushroom jungle':       ['spore-farmer village', 'myconid embassy', 'alchemist colony', 'ranger station'],
    'eternal twilight moor': ['peat-cutter hamlet', 'will-o-wisp shrine', 'fogbound inn', 'wardstone outpost'],
  },

  dungeonThemes: [
    'undead crypt', 'goblin warren', 'cult sanctum',
    'beast lair', 'arcane ruin', 'flooded cavern',
    'haunted manor', 'abandoned mine', 'dragon hoard',
    'vampire castle', 'elemental nexus', 'fungal depths',
    'clockwork vault', 'planar rift', 'sunken temple',
    'frozen tomb', 'spider nest', 'bandit fortress',
    'fey glade gone wrong', 'demonic hellgate', 'ancient library',
    'petrified giant', 'living dungeon', 'dream prison',
  ],

  // Epithets, not names. This table used to list real deities (Kelemvor,
  // Mystra, Lolth, Pelor …) as `exemplars`, which is Product Identity from
  // published settings — see docs/legal.md in the kernel repo. It also worked
  // against the generator: naming a deity invites the model to reproduce that
  // deity, while an epithet hands it a *role* and leaves the name to invent.
  // Only `epithets[0]` reaches the prompt; the rest are alternates for hosts
  // that want to vary the anchor.
  godDomains: [
    { domain: 'death',     epithets: ['the one who judges every life at its end', 'the ferryman of the last river', 'the keeper of names no longer spoken'] },
    { domain: 'war',       epithets: ['the first to raise a banner', 'the god who counts the fallen and calls it worship', 'the whetstone of nations'] },
    { domain: 'nature',    epithets: ['the green that outlives every empire', 'the mother of root and antler', 'the turning of the seasons made will'] },
    { domain: 'trickery',  epithets: ['the face behind every face', 'the patron of the useful lie', 'the thief who stole the first secret'] },
    { domain: 'light',     epithets: ['the first dawn and every one after', 'the lamp that will not be smothered', 'the keeper of the watchfire'] },
    { domain: 'knowledge', epithets: ['the librarian of things not yet known', 'the god who remembers what mortals forget', 'the asker of the next question'] },
    { domain: 'tempest',   epithets: ['the voice in the thunderhead', 'the breaker of masts', 'the storm that answers no prayer'] },
    { domain: 'forge',     epithets: ['the hammer that shaped the world’s bones', 'the patron of honest work', 'the keeper of the first flame'] },
    { domain: 'life',      epithets: ['the breath given freely', 'the mender of what should not have broken', 'the god who suffers alongside'] },
    { domain: 'grave',     epithets: ['the warden of rest undisturbed', 'the one who closes the door behind the dead', 'the enemy of the unquiet'] },
    { domain: 'order',     epithets: ['the scale that does not tip', 'the writer of the first law', 'the god of the kept oath'] },
    { domain: 'twilight',  epithets: ['the guardian of the hour between', 'the shepherd of the moon', 'the comfort at the edge of dark'] },
    { domain: 'arcana',    epithets: ['the pattern beneath the world', 'the first to speak a word that changed a thing', 'the keeper of the deep grammar'] },
    { domain: 'vengeance', epithets: ['the debt that is always collected', 'the god who does not forget a wrong', 'the oath sworn over a grave'] },
    { domain: 'chaos',     epithets: ['the unmaker of settled things', 'the god with no fixed name', 'the crack in every certainty'] },
    { domain: 'sea',       epithets: ['the depth that keeps what it takes', 'the tide’s own temper', 'the god sailors bargain with'] },
    { domain: 'hunting',   epithets: ['the patient tracker', 'the god of the clean kill', 'the one who runs beside the pack'] },
    { domain: 'dreams',    epithets: ['the shepherd of sleeping minds', 'the keeper of the door behind the eyes', 'the god of what is only true at night'] },
    { domain: 'madness',   epithets: ['the whisper that will not stop', 'the god of the thought you cannot unthink', 'the wound in reason'] },
    { domain: 'beauty',    epithets: ['the god of things worth keeping', 'the first love and every echo', 'the patron of what makes life bearable'] },
  ],

  buildingTypes: [
    'tavern', 'inn', 'blacksmith', 'temple',
    'market hall', 'barracks', 'library', 'apothecary',
    'stables', 'town hall', 'warehouse', 'bakery',
    'tannery', 'watchtower', 'herbalist hut', 'alchemist shop',
    'fighting pit', 'fortune teller', 'bathhouse', 'cemetery chapel',
    'brewery', 'docks', 'wizard tower', 'orphanage',
  ],

  locationTypes: [
    'crossroads', 'bridge', 'ancient ruin', 'standing stones',
    'abandoned farm', 'battlefield', 'sacred grove', 'waterfall',
    'cave mouth', 'cliffside path', 'merchant caravan', 'bandit camp',
    'haunted well', 'toll gate', 'shipwreck', 'hermit hut',
    'hot springs', 'frozen lake', 'mushroom ring', 'dragon bones',
    'elven waystone', 'dwarven marker', 'obelisk', 'petrified tree',
  ],
});

// ─── Blueprint builder ────────────────────────────────────────────────────────

export function buildBlueprint(seed, { tables = DEFAULT_TABLES, rng } = {}) {
  const numSeed = typeof seed === 'number' ? seed : hashString(seed ?? String(Date.now()));
  const r = rng ?? mulberry32(numSeed);

  const tone    = pick(tables.tones, r);
  const climate = pick(tables.climates, r);

  return {
    seed:           numSeed,
    tone,
    worldArchetype: pick(tables.worldArchetypes, r),
    threatType:     pick(tables.threatTypes, r),
    beatArc:        tables.beatArcs[tone] ?? tables.beatArcs.heroic,
    factionSlots:   pickN(tables.factionArchetypes, 3, r),
    climate,
    settlementType: pick(tables.settlementTypes[climate] ?? tables.settlementTypes['temperate forest'], r),
    dungeonTheme:   pick(tables.dungeonThemes, r),
    godDomains:     pickN(tables.godDomains, 3, r),
    buildingTypes:  pickN(tables.buildingTypes, 4, r),
    locationTypes:  pickN(tables.locationTypes, 3, r),
  };
}

// ─── Prompt-constraint formatters ─────────────────────────────────────────────

export function blueprintContext(bp) {
  if (!bp) return '';
  const parts = [];
  if (bp.tone)           parts.push(`Tone: ${bp.tone}`);
  if (bp.worldArchetype) parts.push(`World archetype: ${bp.worldArchetype}`);
  if (bp.threatType)     parts.push(`Primary threat: ${bp.threatType}`);
  if (bp.climate)        parts.push(`Climate: ${bp.climate}`);
  if (bp.dungeonTheme)   parts.push(`Dungeon theme: ${bp.dungeonTheme}`);
  if (bp.godDomains?.length) {
    parts.push(`God domains to draw from: ${bp.godDomains.map(g => `${g.domain} — ${g.epithets[0]}`).join('; ')}`);
    // Cleaning the table only fixes our half. A model asked for "a god of
    // death" will happily answer with one it read about, so the constraint
    // has to say so out loud.
    parts.push('Invent original names for these gods. Do not reuse deities, characters, or place names from published fantasy settings.');
  }
  if (bp.factionSlots?.length) {
    parts.push(`Faction archetypes: ${bp.factionSlots.map(f => `${f.type} — ${f.desc}`).join('; ')}`);
  }
  if (bp.beatArc?.length) parts.push(`Story arc beats: ${bp.beatArc.join(' → ')}`);
  if (bp.settlementType) parts.push(`Settlement type: ${bp.settlementType}`);
  if (bp.buildingTypes?.length) parts.push(`Key buildings: ${bp.buildingTypes.join(', ')}`);
  if (bp.locationTypes?.length) parts.push(`Nearby landmarks: ${bp.locationTypes.join(', ')}`);
  return parts.join('\n');
}

export function worldSeedConstraints(bp) {
  return bp ? `\n\nUse these creative constraints:\n${blueprintContext(bp)}` : '';
}

export function beatsHints(bp) {
  const arc = bp?.beatArc?.length
    ? `\n\nUse this story arc structure: ${bp.beatArc.join(' → ')}. Each beat maps to one step in this arc.` : '';
  const fac = bp?.factionSlots?.length
    ? `\nTie beats to these faction types: ${bp.factionSlots.map(f => f.type).join(', ')}.` : '';
  return arc + fac;
}

export function factionsHints(bp) {
  return bp?.factionSlots?.length
    ? `\n\nCreate exactly ${bp.factionSlots.length} factions using these archetypes:\n${bp.factionSlots.map((f, i) => `${i + 1}. A "${f.type}" faction (${f.desc})`).join('\n')}\n\nEach faction MUST reference the world's red thread and primary threat.` : '';
}

export function regionHints(bp) {
  const cl = bp?.climate ? `\n\nThe region's climate is: ${bp.climate}. Reflect this in the description, settlement architecture, and hazards.` : '';
  const th = bp?.dungeonTheme ? `\nThe nearby dungeon should be themed as: ${bp.dungeonTheme}.` : '';
  const lo = bp?.locationTypes?.length ? `\nNearby landmarks include: ${bp.locationTypes.join(', ')}.` : '';
  return cl + th + lo;
}

export function settlementHints(bp) {
  const ty = bp?.settlementType ? `\n\nThis settlement is a: ${bp.settlementType}. Reflect this in the description and NPC roles.` : '';
  const bu = bp?.buildingTypes?.length ? `\nKey buildings in this settlement: ${bp.buildingTypes.join(', ')}. NPCs should relate to these.` : '';
  const fa = bp?.factionSlots?.length ? `\nAt least one NPC should be affiliated with one of these factions: ${bp.factionSlots.map(f => f.type).join(', ')}.` : '';
  return ty + bu + fa;
}
