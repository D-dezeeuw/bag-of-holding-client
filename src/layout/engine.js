// src/layout/engine.js — the shared spatial core (doc 18 §10, phase G).
//
// Extracted verbatim from dungeon/generate.js: grid placement, branch
// attachment, direction derivation. The dungeon dresses this skeleton as
// corridors and rooms; a settlement dresses it as the high street and its
// lanes. Space that makes sense is the same trick in both costumes — a
// seeded graph with derived cardinal exits, so "left of the bakery" is the
// same left in session forty.
//
// Nothing in here calls a model or reads a table: pure geometry over an
// injected rng. The dungeon's output is pinned by its existing tests, which
// is the extraction's safety net.

import { mulberry32, pick as rpick, shuffle as rshuffle, randInt as rrandInt } from '../worldgen/rng.js';

export const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

export function dirBetween(from, to) {
  const dc = to.col - from.col, dr = to.row - from.row;
  if (dc === 1 && dr === 0) return 'east';
  if (dc === -1 && dr === 0) return 'west';
  if (dc === 0 && dr === -1) return 'north';
  if (dc === 0 && dr === 1) return 'south';
  return null;
}

export function placeOnGrid(count, rng) {
  const offsets = () => rshuffle([{ dc: 1, dr: 0 }, { dc: -1, dr: 0 }, { dc: 0, dr: -1 }, { dc: 0, dr: 1 }], rng);
  const grid = new Map();
  const positions = [];
  let col = 0, row = 0;
  grid.set('0,0', 0); positions.push({ col, row });
  for (let i = 1; i < count; i++) {
    let placed = false;
    for (const { dc, dr } of offsets()) {
      const nc = col + dc, nr = row + dr;
      if (!grid.has(`${nc},${nr}`)) { grid.set(`${nc},${nr}`, i); positions.push({ col: nc, row: nr }); col = nc; row = nr; placed = true; break; }
    }
    if (!placed) {
      for (let j = positions.length - 1; j >= 0 && !placed; j--) {
        const p = positions[j];
        for (const { dc, dr } of offsets()) {
          const nc = p.col + dc, nr = p.row + dr;
          if (!grid.has(`${nc},${nr}`)) { grid.set(`${nc},${nr}`, i); positions.push({ col: nc, row: nr }); col = nc; row = nr; placed = true; break; }
        }
      }
    }
  }
  return { grid, positions };
}

export function attachBranch(parentIdx, positions, grid, rng) {
  const p = positions[parentIdx];
  for (const { dc, dr } of rshuffle([{ dc: 1, dr: 0 }, { dc: -1, dr: 0 }, { dc: 0, dr: -1 }, { dc: 0, dr: 1 }], rng)) {
    const nc = p.col + dc, nr = p.row + dr;
    if (!grid.has(`${nc},${nr}`)) { const idx = positions.length; grid.set(`${nc},${nr}`, idx); positions.push({ col: nc, row: nr }); return idx; }
  }
  return -1;
}

// Cardinal exits for every grid-adjacent pair. No rng — pure derivation.
export function deriveAdjacency(positions) {
  const adjacency = Array.from({ length: positions.length }, () => []);
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dir = dirBetween(positions[i], positions[j]);
      if (dir) { adjacency[i].push({ target: j, dir }); adjacency[j].push({ target: i, dir: OPPOSITE[dir] }); }
    }
  }
  return adjacency;
}

// The composed core: spine + branches + adjacency, undressed. Returns
// { positions, adjacency, spineIds, branchIds, branchParent, entrance, focus }
// where entrance is index 0 and focus is the spine's far end — the vault in a
// dungeon, the square/seat in a settlement.
export function generateLayout(seed, {
  rng = mulberry32(typeof seed === 'number' ? seed : 0),
  spineMin = 4, spineMax = 6, branchMin = 2, branchMax = 4,
} = {}) {
  const sMin = Math.max(2, Math.trunc(spineMin));
  const sMax = Math.max(sMin, Math.trunc(spineMax));
  const bMin = Math.max(0, Math.trunc(branchMin));
  const bMax = Math.max(bMin, Math.trunc(branchMax));

  const spineLen = rrandInt(sMin, sMax, rng);
  const { grid, positions } = placeOnGrid(spineLen, rng);
  const spineIds = Array.from({ length: spineLen }, (_, i) => i);

  const branchCount = rrandInt(bMin, bMax, rng);
  const branchIds = [];
  const branchParent = {};
  const candidates = spineIds.slice(1, -1);
  for (let b = 0; b < branchCount; b++) {
    const parent = rpick(candidates.length ? candidates : spineIds.slice(1), rng);
    const idx = attachBranch(parent, positions, grid, rng);
    if (idx >= 0) { branchIds.push(idx); branchParent[idx] = parent; }
  }

  return {
    positions,
    adjacency: deriveAdjacency(positions),
    spineIds, branchIds, branchParent,
    entrance: 0,
    focus: spineLen - 1,
  };
}
