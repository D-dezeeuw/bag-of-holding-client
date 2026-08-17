// src/worldgen/lore.js — the tree's inhabitants (doc 18 §4, phase B).
//
// Crowns, legends, and eras exist *before* the player needs them: minted as
// stubs at genesis (names + bindings, no prose) and hydrated like places.
// Everything here is pure and seeded — one LLM call is never made. The stubs
// carry exactly enough to be referenced (an id, a name, what they bind to);
// hydration templates (phase C) fill in the rest.
//
// All tables are invented names only — same rule as every other table
// (docs/legal.md in the kernel repo), enforced by tests/legal.test.js.

import { mulberry32, pick, pickN, randInt } from './rng.js';
import { SYLLABLES } from './skeleton.js';

// ─── Tables ──────────────────────────────────────────────────────────────────

export const ERA_NAMES = Object.freeze([
  'the Age of Founding Kings', 'the Long Thaw', 'the Age of Salt and Iron',
  'the Broken Compact', 'the Quiet Roads', 'the Second Sowing',
  'the Lantern Wars', 'the Sundered Court', 'the Age of Deep Bells',
  'the White Harvest',
]);

export const LEGEND_TITLE_A = Object.freeze([
  'The Drowned', 'The Salt', 'The Hollow', 'The Last', 'The Sleeping',
  'The Iron', 'The Pale', 'The Unnumbered', 'The Broken', 'The Whispering',
]);
export const LEGEND_TITLE_B = Object.freeze([
  'Bell', 'Crown', 'Column', 'Fleet', 'King', 'Choir', 'Gate', 'Vigil',
  'Orchard', 'Tithe',
]);

export const CROWN_TITLES = Object.freeze([
  'High Sovereign', 'Warden-Regent', 'Marchion', 'Tide-Throne',
  'Elder Speaker', 'Keeper of the Long Table', 'First Reeve', 'Storm Warden',
]);

export const LEGITIMACIES = Object.freeze([
  'settled', 'contested', 'usurped', 'failing', 'newly crowned',
]);

export const FACTION_NAME_A = Object.freeze([
  'Ashen', 'Saltglass', 'Fenreeve', 'Ironbound', 'Lantern', 'Tidemark',
  'Briarwold', 'Palewater', 'Coppervein', 'Thornmark',
]);
export const FACTION_NAME_B = Object.freeze([
  'Host', 'Concord', 'Compact', 'League', 'Court', 'Banner',
  'Tithe', 'Circle', 'March', 'Charter',
]);

// What a war is ABOUT — one concrete grievance, so hydration and the acts
// engine have a fact to bind to rather than "they hate each other".
export const WAR_CAUSES = Object.freeze([
  'a broken toll charter', 'a drowned border stone', 'a stolen harvest tithe',
  'a disputed succession', 'a salt monopoly', 'a burned envoy',
  'an unpaid weregild', 'a poisoned ford', 'a forged treaty seal',
  'a bell taken as plunder',
]);

export const WAR_INTENSITIES = Object.freeze(['cold', 'raiding', 'open']);

// The faces of the powers. Given names in no culture's register (invented,
// like every table here); voices are manners of speaking a DM can perform on
// sight; wants are CONCRETE — a want the engine can check ("the border stones
// put back") beats a temperament it can only assert.
export const NPC_GIVEN_NAMES = Object.freeze([
  'Maren', 'Colwyn', 'Sefa', 'Ondred', 'Talvace', 'Bryn',
  'Ishane', 'Vessa', 'Aldric', 'Noor', 'Ederra', 'Halvard',
]);
export const NPC_VOICES = Object.freeze([
  'speaks in ledger figures and old debts',
  'never raises their voice, and never repeats an order',
  'quotes drowned poets at unhelpful moments',
  'laughs first and decides later',
  'asks questions the way a fisherman sets lines',
  'talks to everyone as if resuming an old argument',
  'measures every sentence like grain in a famine',
  'swears by bells and means it',
]);
export const NPC_WANTS = Object.freeze([
  'the war ended on their own terms',
  'an heir worth the name',
  'the old border stones put back',
  'a debt from before the thaw repaid',
  'their name in a founding charter',
  'the harvest tithe forgiven',
  'a rival house brought to the table',
  'the roads safe as far as the last bell',
]);

// ─── Minters ─────────────────────────────────────────────────────────────────

// 3–5 named epochs, oldest first. Every legend, ruin, and landmark carries an
// era tag — what makes "its roads are older than its towns" checkable.
export function mintEras(seed, { count = null } = {}) {
  const rng = mulberry32((seed ?? 1) >>> 0);
  const n = count ?? randInt(3, 5, rng);
  return pickN(ERA_NAMES, n, rng).map((name, i) => ({
    id: `era-${i}`, name, order: i, stub: true,
  }));
}

// 2–3 legends per continent, each bound to real province ids. The explorer's
// dividend: the continent's first port province always appears in at least
// one legend's sites, so whatever shore a wanderer lands on, the acts engine
// has something real to bind to.
export function mintLegendStubs(continentId, seed, { provinces, firstPort, eras, count = null } = {}) {
  const rng = mulberry32(((seed ?? 1) + 101) >>> 0);
  const n = count ?? randInt(2, 3, rng);
  const legends = [];
  for (let i = 0; i < n; i++) {
    const sites = pickN(provinces, Math.min(provinces.length, randInt(1, 2, rng)), rng);
    legends.push({
      id: `${continentId}.legend-${i}`,
      title: `${pick(LEGEND_TITLE_A, rng)} ${pick(LEGEND_TITLE_B, rng)}`,
      era: eras?.length ? pick(eras, rng).id : null,
      sites, hooks: [], kernelOfTruth: null, payoff: null, stub: true,
    });
  }
  if (firstPort && !legends.some(l => l.sites.includes(firstPort))) {
    legends[0].sites.push(firstPort);
  }
  return legends;
}

// One crown per province: a dynasty name in the continent's syllable culture,
// a title, and how firmly it sits. Seat and stance are hydration's to fill.
export function mintCrownStub(provinceId, seed, { culture = null } = {}) {
  const rng = mulberry32(((seed ?? 1) + 202) >>> 0);
  const pre = culture?.prefixes ?? SYLLABLES.provincePrefixes;
  const suf = culture?.suffixes ?? SYLLABLES.provinceSuffixes;
  return {
    id: `${provinceId}.crown`,
    name: `House ${pick(pre, rng)}${pick(suf, rng)}`,
    title: pick(CROWN_TITLES, rng),
    legitimacy: pick(LEGITIMACIES, rng),
    seat: null, stanceOnThreat: null, factionRelations: [], stub: true,
  };
}

// The powers that precede the player. Factions are WORLD-scoped entities
// (ids `faction-N`) so the red thread can run through them across continents;
// each is anchored to one continent (round-robin, so two continents guarantee
// a cross-sea rivalry) and holds 1-2 of its provinces as territory.
//
// The relations pass is symmetric — both sides record an enmity or alliance —
// and guarantees at least one enemy pair whenever two factions exist: a world
// with no friction generates no stories, and every downstream engine (wars,
// fronts, the acts arc) keys off that first fault line.
export function mintFactionStubs(seed, { provincesByContinent, slots = null, count = null } = {}) {
  const rng = mulberry32(((seed ?? 1) + 303) >>> 0);
  const continents = Object.keys(provincesByContinent ?? {});
  if (!continents.length) return [];
  const n = count ?? (slots?.length || 3);

  const factions = [];
  for (let i = 0; i < n; i++) {
    const home = continents[i % continents.length];
    const mine = provincesByContinent[home] ?? [];
    const territory = mine.length ? pickN(mine, Math.min(mine.length, randInt(1, 2, rng)), rng) : [];
    factions.push({
      id: `faction-${i}`,
      name: `The ${pick(FACTION_NAME_A, rng)} ${pick(FACTION_NAME_B, rng)}`,
      archetype: slots?.[i]?.type ?? null,
      territory,
      allies: [],
      enemies: [],
      stub: true,
    });
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const roll = rng();
      if (roll < 0.35) {
        factions[i].enemies.push(factions[j].id);
        factions[j].enemies.push(factions[i].id);
      } else if (roll < 0.6) {
        factions[i].allies.push(factions[j].id);
        factions[j].allies.push(factions[i].id);
      }
    }
  }
  if (n >= 2 && !factions.some(f => f.enemies.length)) {
    // The guaranteed fault line. Deterministic (first pair), and it displaces
    // any accidental alliance between them — enemies and allies are disjoint.
    factions[0].allies = factions[0].allies.filter(id => id !== factions[1].id);
    factions[1].allies = factions[1].allies.filter(id => id !== factions[0].id);
    factions[0].enemies.push(factions[1].id);
    factions[1].enemies.push(factions[0].id);
  }
  return factions;
}

// One war per enemy pair: who, how hot, what it is about, and where it is
// felt (the union of both territories — the front a travelling party crosses).
// Null when the world happens to be at peace, which the caller stores as the
// honest answer rather than an empty ceremony.
export function mintWarState(seed, factions) {
  const rng = mulberry32(((seed ?? 1) + 404) >>> 0);
  const wars = [];
  for (let i = 0; i < (factions?.length ?? 0); i++) {
    for (let j = i + 1; j < factions.length; j++) {
      if (!factions[i].enemies.includes(factions[j].id)) continue;
      wars.push({
        id: `war-${wars.length}`,
        between: [factions[i].id, factions[j].id],
        intensity: pick(WAR_INTENSITIES, rng),
        cause: pick(WAR_CAUSES, rng),
        front: [...new Set([...factions[i].territory, ...factions[j].territory])],
      });
    }
  }
  return wars.length ? { wars } : null;
}

// Seat the powers on the thrones. The faction holding a crown's province IS
// its sovereign — a stored fact, not a vibe, which is what makes "the King of
// Faction A" a target the acts engine can bind to. Additional holders of the
// same province take a lesser stance; at most one sovereign per crown by
// construction. Pure: returns new crown records, never mutates.
export function bindCrownsToFactions(crowns, factions, seed) {
  const rng = mulberry32(((seed ?? 1) + 505) >>> 0);
  return crowns.map((crown) => {
    const provinceId = crown.id.replace(/\.crown$/, '');
    const holders = (factions ?? []).filter(f => f.territory.includes(provinceId));
    if (!holders.length) return crown;
    const relations = holders.map((f, i) => ({
      factionId: f.id,
      stance: i === 0 ? 'sovereign' : pick(['rival', 'puppet', 'defiant', 'ally'], rng),
    }));
    return { ...crown, factionRelations: relations };
  });
}

// Give every power a face: one npc per faction, world-scoped ids `npc-N`.
// A faction seated on a throne (some crown's sovereign) gets a SOVEREIGN —
// the King of Faction A is finally a person, linked both ways by id: the npc
// `seatOf` the crown and `leads` the faction. A throneless power gets a
// leader. Voice and wants ride on the stub so the table can hate a face
// before hydration ever writes prose. Pure and seeded, like every minter.
export function mintNpcStubs(seed, { crowns = [], factions = [], npcsPerFaction = 1 } = {}) {
  const rng = mulberry32(((seed ?? 1) + 606) >>> 0);
  const perFaction = Math.max(1, Math.trunc(npcsPerFaction));
  const npcs = [];
  for (const f of factions) {
    const throne = crowns.find(c =>
      c.factionRelations?.some(r => r.factionId === f.id && r.stance === 'sovereign'));
    const given = pick(NPC_GIVEN_NAMES, rng);
    npcs.push({
      id: `npc-${npcs.length}`,
      name: `${given} of ${throne ? throne.name : f.name}`,
      role: throne ? 'sovereign' : 'leader',
      seatOf: throne?.id ?? null,
      leads: f.id,
      voice: pick(NPC_VOICES, rng),
      wants: pickN(NPC_WANTS, 2, rng),
      stub: true,
    });
    // Extra faces per faction (the npcsPerFaction dial): notables under the
    // leader — same shape, no seat, drawn from the same stream so the
    // default (1) mints byte-identically to the pre-dial minter.
    for (let extra = 1; extra < perFaction; extra++) {
      npcs.push({
        id: `npc-${npcs.length}`,
        name: `${pick(NPC_GIVEN_NAMES, rng)} of ${f.name}`,
        role: 'notable',
        seatOf: null,
        leads: f.id,
        voice: pick(NPC_VOICES, rng),
        wants: pickN(NPC_WANTS, 2, rng),
        stub: true,
      });
    }
  }
  return npcs;
}

// Walk a minted skeleton and populate the whole lore layer in one pass.
// Pure: same skeleton + seed → same lore, which is what lets a cartridge
// carry it and a replay reproduce it. `factionSlots` (the world blueprint's
// archetype roll) rides in so a host's setting tables re-skin the factions
// the same way they re-skin everything else.
export function mintLore({ geo, continents, provinces }, seed, {
  eraCount = null, factionSlots = null,
  factionCount = null, npcsPerFaction = null, legendCount = null,
} = {}) {
  const eras = mintEras(seed, { count: eraCount });
  const legends = [];
  let crowns = [];
  const provincesByContinent = {};
  for (const cId of continents) {
    const cNode = geo.nodes[cId];
    const mine = provinces.filter(p => geo.nodes[p].parent === cId);
    provincesByContinent[cId] = mine;
    const firstPort = mine.find(p => geo.nodes[p].port) ?? mine[0] ?? null;
    legends.push(...mintLegendStubs(cId, cNode.seed, { provinces: mine, firstPort, eras, count: legendCount }));
    for (const pId of mine) {
      crowns.push(mintCrownStub(pId, geo.nodes[pId].seed, { culture: cNode.nameParts }));
    }
  }
  const factions = mintFactionStubs(seed, { provincesByContinent, slots: factionSlots, count: factionCount });
  const warState = mintWarState(seed, factions);
  crowns = bindCrownsToFactions(crowns, factions, seed);
  const npcs = mintNpcStubs(seed, { crowns, factions, npcsPerFaction: npcsPerFaction ?? 1 });
  return { eras, legends, crowns, factions, warState, npcs };
}
