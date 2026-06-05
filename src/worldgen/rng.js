// src/worldgen/rng.js — seeded RNG + array helpers (one home for the trio that
// was triplicated across the host's worldseed/world/tests).
//
// All selection helpers take an injected `rng` (a () => [0,1) function) so they
// stay deterministic and node-testable. `mulberry32` matches the engine's
// Dice.seededRng so the host can use either interchangeably.

export function mulberry32(seed) {
  let state = (seed | 0) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

export function pickN(arr, n, rng = Math.random) {
  const shuffled = shuffle(arr, rng);
  return shuffled.slice(0, n);
}

export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function randInt(min, max, rng = Math.random) {
  return min + Math.floor(rng() * (max - min + 1));
}

// A fresh 31-bit seed. Non-deterministic by design (call site decides when).
export function mintSeed() {
  return Math.floor(Math.random() * 2147483647);
}
