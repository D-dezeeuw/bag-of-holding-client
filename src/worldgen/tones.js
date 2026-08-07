// src/worldgen/tones.js — the one tone vocabulary.
//
// Tone is picked once by the seeded blueprint and then has to survive three
// hops: the world-seed prompt, the schema that validates the model's answer,
// and the EPUB cover palette. Those three lists used to be written out
// separately and had drifted — the blueprint could pick 'tragic', the schema
// enum permitted only three tones so a strict json_schema forced the model to
// answer 'heroic' instead, and the cover then painted the default parchment.
// The campaign's declared tone quietly became a different tone by the time
// anything used it. One list, imported everywhere, is the fix.

export const TONES = ['grimdark', 'heroic', 'mysterious', 'tragic', 'whimsical'];

// True for a tone this library knows how to honour end to end.
export function isTone(t) {
  return TONES.includes(t);
}
