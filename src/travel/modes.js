// src/travel/modes.js — travel modes and their tables (doc 18 §9, phase F).
//
// Distance is priced in days; a mode turns days into narration segments and
// tunes what a segment can roll. Air has no coordinates to fly over — nodes
// are a graph, not a map — so it pays with the same coin: the underlying
// route's days times a mode factor. Faster, never free.

export const TRAVEL_MODES = Object.freeze({
  road: {
    daysPerSegment: 1,
    encounterChance: 0.4,
    discoveryChance: 0.35,
    discoveryTypes: ['loot', 'wanderer', 'shrine', 'clue'],
  },
  sea: {
    daysPerSegment: 2,
    encounterChance: 0.25,
    discoveryChance: 0.3,
    discoveryTypes: ['storm', 'drifting wreck', 'strange sail', 'becalmed water', 'sea shrine'],
  },
  air: {
    daysPerSegment: 3,
    airFactor: 0.5, // route days × this — flight halves the crossing, not the distance
    encounterChance: 0.15,
    discoveryChance: 0.2,
    discoveryTypes: ['thermal', 'distant smoke', 'high roost', 'impossible cloud', 'lights below'],
  },
});

// Flavor lines for landfall regions minted where no road ever led — the same
// register as the skeleton's HOOKS table.
export const LANDFALL_HOOKS = Object.freeze([
  'no jetty, no path, no footprints',
  'the tide line is strewn with unfamiliar shells',
  'something watched the descent and did not run',
  'an old fire ring, cold for years',
  'the grass grows in rings here',
  'birds wheel but will not land',
]);
