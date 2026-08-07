// src/worldgen/geography.js — the world as a graph, not a star (Epic E6).
//
// Overworld travel used to mint a brand-new region every time the player left
// town: adjacency was stored as display-name strings, road exits carried a null
// targetId, and going back the way you came generated somewhere different. That
// is a star with the player at the centre — an "open world" the data model
// could not even represent.
//
// The fix is to mint neighbours as STUBS at generation time: cheap records with
// a stable id, a name, a one-line hook and their own seed. Nothing about a stub
// costs an LLM call until the player actually goes there, at which point it
// hydrates deterministically from its seed. The world feels endless, costs
// O(visited), and the place you reach in hour 60 was always going to be that
// place.

import { mulberry32, randInt, pick } from './rng.js';

export const DIRECTIONS = Object.freeze(['north', 'east', 'south', 'west']);
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

export function emptyGeography() {
  return { nodes: {}, edges: [] };
}

// Add (or replace) a node. `stub: true` means "named but not yet generated".
export function addNode(geo, { id, name, kind = 'region', seed, hook = null, stub = true }) {
  return {
    ...geo,
    nodes: { ...geo.nodes, [id]: { id, name, kind, seed, hook, stub, discovered: !stub } },
  };
}

// Connect two nodes. Edges are undirected but stored once, with the direction
// as seen from `from` so the UI can render a compass.
export function connect(geo, from, to, { direction = 'north', days = 1, kind = 'road' } = {}) {
  if (geo.edges.some(e => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return geo;
  return { ...geo, edges: [...geo.edges, { from, to, direction, days, kind, discovered: false }] };
}

export function neighbours(geo, id) {
  return geo.edges
    .filter(e => e.from === id || e.to === id)
    .map(e => {
      const otherId = e.from === id ? e.to : e.from;
      const dir     = e.from === id ? e.direction : (OPPOSITE[e.direction] ?? e.direction);
      return { ...geo.nodes[otherId], direction: dir, days: e.days, kind: e.kind, discovered: e.discovered };
    })
    .filter(n => n.id);
}

// Mint a ring of unexplored neighbours around a node. Deterministic from the
// parent's seed, so the same world always grows the same shape — the player who
// sails somewhere in hour 60 arrives at the place that was always waiting.
export function expandFrom(geo, id, { count = 3, nameFor, hookFor } = {}) {
  const node = geo.nodes[id];
  if (!node) return geo;
  const rng = mulberry32((node.seed ?? 1) >>> 0);
  let out = geo;
  const taken = new Set(neighbours(geo, id).map(n => n.direction));
  const dirs = DIRECTIONS.filter(d => !taken.has(d));

  for (let i = 0; i < Math.min(count, dirs.length); i++) {
    const direction = dirs[i];
    const seed = randInt(1, 2 ** 30, rng);
    const childId = `${node.id}.${direction}`;
    if (out.nodes[childId]) continue;
    out = addNode(out, {
      id:   childId,
      name: nameFor ? nameFor(seed, direction) : `${node.name} ${direction}`,
      kind: node.kind,
      seed,
      hook: hookFor ? hookFor(seed, direction) : null,
      stub: true,
    });
    out = connect(out, node.id, childId, { direction, days: randInt(1, 3, rng) });
  }
  return out;
}

// Mark a node hydrated (its content has been generated) and reveal its edges.
export function markVisited(geo, id) {
  const node = geo.nodes[id];
  if (!node) return geo;
  return {
    ...geo,
    nodes: { ...geo.nodes, [id]: { ...node, stub: false, discovered: true } },
    edges: geo.edges.map(e => (e.from === id || e.to === id) ? { ...e, discovered: true } : e),
  };
}

// Everything the player has seen or heard of — what a map screen renders.
export function knownMap(geo) {
  const nodes = Object.values(geo.nodes).filter(n => n.discovered || !n.stub);
  const seen  = new Set(nodes.map(n => n.id));
  // Stubs adjacent to somewhere visited are "heard of": named, not yet walked.
  const rumoured = Object.values(geo.nodes).filter(n =>
    n.stub && !seen.has(n.id) && neighbours(geo, n.id).some(x => seen.has(x.id)));
  return { visited: nodes, rumoured };
}

// Shortest path in days between two nodes (Dijkstra over a tiny graph), or null
// when unreachable. Travel time is what makes distance mean something.
export function routeBetween(geo, from, to) {
  if (from === to) return { path: [from], days: 0 };
  const dist = { [from]: 0 };
  const prev = {};
  const queue = new Set(Object.keys(geo.nodes));
  while (queue.size) {
    let best = null;
    for (const id of queue) if (dist[id] != null && (best == null || dist[id] < dist[best])) best = id;
    if (best == null) break;
    queue.delete(best);
    if (best === to) break;
    for (const n of neighbours(geo, best)) {
      const alt = dist[best] + (n.days ?? 1);
      if (dist[n.id] == null || alt < dist[n.id]) { dist[n.id] = alt; prev[n.id] = best; }
    }
  }
  if (dist[to] == null) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return { path, days: dist[to] };
}
