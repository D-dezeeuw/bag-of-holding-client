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
//
// Layered-world fields (doc 17, textual LOD):
//   parent — containment: a region belongs to a province, a province to a
//            continent. `null` marks a top-level or legacy flat-world node.
//   detail — how much of this place EXISTS as text:
//            0 = stub (name + hook, deterministic, free)
//            1 = outlined (~50-word digest: what the place is about)
//            2 = detailed (full generation — today's region/settlement content)
export function addNode(geo, { id, name, kind = 'region', seed, hook = null, stub = true,
                               parent = null, detail = undefined }) {
  const lod = detail ?? (stub ? 0 : 2);
  return {
    ...geo,
    nodes: { ...geo.nodes, [id]: { id, name, kind, seed, hook, stub, discovered: !stub, parent, detail: lod } },
  };
}

// Containment queries. Both walk the `parent` links only — edges are travel
// topology, not ownership.
export function childrenOf(geo, id) {
  return Object.values(geo.nodes).filter(n => n.parent === id);
}

export function ancestorsOf(geo, id) {
  const out = [];
  let node = geo.nodes[id];
  const seen = new Set();
  while (node?.parent && !seen.has(node.parent)) {
    seen.add(node.parent);
    node = geo.nodes[node.parent];
    if (node) out.push(node);
  }
  return out;
}

// Raise a node's level of detail — the lazy load's write half. Promotion is
// monotonic (a place never forgets its outline) and can carry the real name
// and the outline digest the LLM produced. Unknown ids are a no-op.
export function promoteNode(geo, id, { detail, name = null, digest = null } = {}) {
  const node = geo.nodes[id];
  if (!node) return geo;
  const next = { ...node, detail: Math.max(node.detail ?? 0, detail ?? node.detail ?? 0) };
  if (name)   next.name = name;
  if (digest) next.digest = digest;
  // Only FULL detail clears the stub flag: an outlined place is still
  // "named but not yet generated" — it has a digest, not content — and
  // knownMap must keep showing it as rumoured, not visited.
  if (next.detail >= 2) next.stub = false;
  return { ...geo, nodes: { ...geo.nodes, [id]: next } };
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
      // The frontier grows INSIDE the layer: a region's minted neighbours
      // belong to the same province. Cross-border regions are minted by the
      // skeleton, which knows where provinces meet.
      parent: node.parent ?? null,
    });
    out = connect(out, node.id, childId, { direction, days: randInt(1, 3, rng) });
  }
  return out;
}

// Seeing a place means seeing what it belongs to: visiting a region makes
// its province and continent `discovered` (never clearing `stub` — an
// ancestor is seen-of, not generated). This is the load-bearing trick of
// doc 18 §9: the home port province becomes visible, its sea lane makes the
// far port `rumoured`, and sailors' tales are knownMap working as designed.
export function discoverAncestors(geo, id) {
  let out = geo;
  for (const anc of ancestorsOf(geo, id)) {
    if (out.nodes[anc.id]?.discovered) continue;
    out = { ...out, nodes: { ...out.nodes, [anc.id]: { ...out.nodes[anc.id], discovered: true } } };
  }
  return out;
}

// Mark a node hydrated (its content has been generated) and reveal its edges.
export function markVisited(geo, id) {
  const node = geo.nodes[id];
  if (!node) return geo;
  return discoverAncestors({
    ...geo,
    // Visited means the content was generated — full detail by definition.
    nodes: { ...geo.nodes, [id]: { ...node, stub: false, discovered: true, detail: 2 } },
    edges: geo.edges.map(e => (e.from === id || e.to === id) ? { ...e, discovered: true } : e),
  }, id);
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
//
// `traversable` filters edges by capability (doc 18 §9): a walking party
// cannot take a 'sea' lane without a ship. Default: everything, preserving
// every existing caller. It deliberately ignores `discovered` — the route
// exists whether the player has heard of it or not; knowing about it is the
// gazetteer's business, not the pathfinder's.
export function routeBetween(geo, from, to, { traversable = null } = {}) {
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
      if (traversable && !traversable(n)) continue;
      const alt = dist[best] + (n.days ?? 1);
      if (dist[n.id] == null || alt < dist[n.id]) { dist[n.id] = alt; prev[n.id] = best; }
    }
  }
  if (dist[to] == null) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return { path, days: dist[to] };
}
