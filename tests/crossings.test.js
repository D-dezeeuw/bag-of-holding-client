// tests/crossings.test.js — no walls, only distance (doc 18 §9, phase F).
//
// The planner gives travel segments meaning: distance prices in days, modes
// gate edges, air pays with the same coin, and travel days tick the world's
// clocks. Landfall is deterministic so replay and shared cartridges agree on
// where the wanderer came down.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mintWorldSkeleton } from '../src/worldgen/skeleton.js';
import { routeBetween } from '../src/worldgen/geography.js';
import { planJourney, legTravelOptions, applyTravelClocks } from '../src/travel/planner.js';
import { TRAVEL_MODES } from '../src/travel/modes.js';
import { beginTravel, runTravel } from '../src/travel/fsm.js';
import { mintProvinceRegions, portAnchorOf, mintLandfall, whileYouWereGone, promoteObserved, hydrateNode } from '../src/worldgen/hydrate.js';
import { deriveBlueprint, MENACE_TIERS, menaceHints } from '../src/worldgen/blueprint.js';
import { makeClock } from '../src/narrative/clocks.js';
import { makePatch } from '../src/ledger/patch.js';
import { mulberry32 } from '../src/worldgen/rng.js';

const crossContinentPair = (sk) => {
  const home = sk.provinces.find(p => sk.geo.nodes[p].parent === 'continent-0' && sk.geo.nodes[p].port);
  const far = sk.provinces.find(p => sk.geo.nodes[p].parent === 'continent-1');
  return { home, far };
};

describe('routeBetween with a traversability predicate', () => {
  it('a walking party cannot cross a sea lane; a shipped one can', () => {
    const sk = mintWorldSkeleton(1234);
    const { home, far } = crossContinentPair(sk);
    // An explicit predicate owns the WHOLE decision (the default's
    // dormant-gate exclusion included) — a walking party is road-only.
    const walk = routeBetween(sk.geo, home, far, { traversable: (e) => e.kind === 'border' });
    assert.equal(walk, null);
    const sail = routeBetween(sk.geo, home, far, { traversable: (e) => e.kind !== 'gate' });
    assert.ok(sail && sail.days > 0);
  });
});

describe('planJourney', () => {
  it('refuses the ocean without a ship, plans it with one', () => {
    const sk = mintWorldSkeleton(1234);
    const { home, far } = crossContinentPair(sk);
    assert.equal(planJourney(sk.geo, home, far, { capabilities: {} }), null);
    const plan = planJourney(sk.geo, home, far, { capabilities: { sea: true } });
    assert.ok(plan);
    assert.ok(plan.legs.some(l => l.mode === 'sea'));
    assert.equal(plan.totalDays, routeBetween(sk.geo, home, far).days);
    // sea segments derive from days at sea rates, never below the floor
    for (const leg of plan.legs) {
      assert.ok(leg.segments >= 2, `leg floor: ${leg.segments}`);
      assert.ok(leg.segments <= 8, `leg cap: ${leg.segments}`);
    }
  });

  it('air is faster, never free, and works without a ship', () => {
    const sk = mintWorldSkeleton(1234);
    const { home, far } = crossContinentPair(sk);
    const sail = planJourney(sk.geo, home, far, { capabilities: { sea: true } });
    const fly = planJourney(sk.geo, home, far, { capabilities: { air: true } });
    assert.ok(fly);
    assert.equal(fly.mode, 'air');
    assert.ok(fly.totalDays >= 1);
    assert.ok(fly.totalDays < sail.totalDays, `${fly.totalDays} !< ${sail.totalDays}`);
  });

  it('a short hop keeps the two-segment floor (the latency budget survives)', () => {
    const sk = mintWorldSkeleton(7);
    const provs = sk.provinces.filter(p => sk.geo.nodes[p].parent === 'continent-0');
    const plan = planJourney(sk.geo, provs[0], provs[1], { capabilities: {} });
    assert.ok(plan);
    assert.ok(plan.legs.every(l => l.segments >= 2));
  });

  it('legTravelOptions carries mode tuning into the FSM unchanged shape', () => {
    const sk = mintWorldSkeleton(1234);
    const { home, far } = crossContinentPair(sk);
    const plan = planJourney(sk.geo, home, far, { capabilities: { sea: true } });
    const sea = plan.legs.find(l => l.mode === 'sea');
    const opts = legTravelOptions(sea);
    const travel = beginTravel(far, mulberry32(1), opts);
    assert.equal(travel.segments, sea.segments);
    assert.equal(travel.mode, 'sea');
    const { events } = runTravel(far, mulberry32(2), opts);
    const discoveries = events.filter(e => e.type === 'discovery');
    for (const d of discoveries) assert.ok(TRAVEL_MODES.sea.discoveryTypes.includes(d.discovery), d.discovery);
    assert.equal(events.at(-1).type, 'arrive');
    assert.equal(events.at(-1).mode, 'sea');
  });

  it('no-opts FSM behaviour is unchanged', () => {
    const a = beginTravel('D', mulberry32(9));
    assert.ok(a.segments >= 2 && a.segments <= 3);
    assert.equal(a.mode, undefined);
  });
});

describe('landfall', () => {
  it('portAnchorOf resolves (minting if needed) to the harbor region', () => {
    const sk = mintWorldSkeleton(1234);
    const port = sk.provinces.find(p => sk.geo.nodes[p].port);
    const { geo, anchor } = portAnchorOf(sk.geo, port);
    assert.ok(anchor);
    assert.equal(geo.nodes[anchor].harbor, true);
    // stable on a second call
    assert.equal(portAnchorOf(geo, port).anchor, anchor);
  });

  it('mintLandfall is deterministic, idempotent, and joins the frontier', () => {
    const sk = mintWorldSkeleton(1234);
    const far = sk.provinces.find(p => sk.geo.nodes[p].parent === 'continent-1');
    const withRegions = mintProvinceRegions(sk.geo, far).geo;
    const a = mintLandfall(withRegions, far, { via: 'air' });
    const b = mintLandfall(withRegions, far, { via: 'air' });
    assert.equal(a.landfall, b.landfall);
    assert.deepEqual(a.geo.nodes[a.landfall], b.geo.nodes[b.landfall]);
    assert.equal(a.geo.nodes[a.landfall].landfall, 'air');
    assert.equal(a.geo.nodes[`${a.landfall}.site-landfall`].siteType, 'landfall');
    // connected to a sibling region, so the walk inland exists
    assert.ok(a.geo.edges.some(e => e.from === a.landfall || e.to === a.landfall));
    // idempotent against the already-minted geo
    assert.equal(mintLandfall(a.geo, far).geo, a.geo);
    // the site id is returned too, and it's the child, not the region itself
    assert.equal(a.site, `${a.landfall}.site-landfall`);
  });

  // Regression: mintLandfall mints TWO nodes — the landfall region and its
  // child site:landfall node — but only ever returned the region id. A
  // caller who hydrates `.landfall` (the natural-looking field to reach for)
  // gets the REGION template instead of site:landfall: a real, valid
  // hydration, but the wrong shape and content — its digest and description
  // are both built from the same hook text the site's own digest already
  // carries, which is exactly how a book ended up printing "something
  // watched the descent and did not run" twice in a row for one arrival.
  it('.landfall resolves the region template; .site resolves site:landfall — never the same content', async () => {
    const sk = mintWorldSkeleton(1234);
    const far = sk.provinces.find(p => sk.geo.nodes[p].parent === 'continent-1');
    const { geo, landfall, site } = mintLandfall(mintProvinceRegions(sk.geo, far).geo, far, { via: 'air' });

    const regionRun = await hydrateNode(geo, landfall, { detail: 2, complete: null });
    const siteRun = await hydrateNode(geo, site, { detail: 2, complete: null });

    // Both hydrate successfully (this is not about one failing) — but to
    // genuinely different templates, so a host that hydrates the wrong one
    // doesn't get an error, just silently wrong content.
    assert.ok(regionRun.ok && siteRun.ok);
    assert.ok('description' in regionRun.result, 'region template shape');
    assert.ok(!('description' in siteRun.result), 'site:landfall must not carry region fields');
    assert.ok('hook' in siteRun.result && 'digest' in siteRun.result);
  });
});

describe('travel days tick the world', () => {
  it('a crossing advances clocks; a stroll does not', () => {
    const clocks = [makeClock({ id: 'succession', label: 'the contested crown', segments: 4 })];
    const crossing = applyTravelClocks(clocks, { totalDays: 8 });
    assert.equal(crossing.clocks[0].filled, 2);
    const stroll = applyTravelClocks(clocks, { totalDays: 1 });
    assert.equal(stroll.clocks[0].filled, 0);
  });
});

describe('menace — honest danger', () => {
  it('every continent draws a tier; hints signpost, never scale', () => {
    const world = deriveBlueprint(null, 1, 'world');
    const cont = deriveBlueprint(world, 2, 'continent');
    assert.ok(MENACE_TIERS.includes(cont.menace));
    const hints = menaceHints(cont);
    assert.match(hints, new RegExp(cont.menace));
    assert.match(hints, /never state a tier or adjust any creature/);
    assert.equal(menaceHints({}), '');
  });
});

describe('whileYouWereGone', () => {
  it('digests fired clocks and superseded provisionals', () => {
    const clocks = [
      { id: 'a', label: 'quiet', segments: 4, filled: 1, fired: false },
      { id: 'b', label: 'boiled over', segments: 4, filled: 4, fired: true },
    ];
    const ledger = [
      makePatch({ turn: 1, target: 'r1', path: 'content', to: { x: 1 }, because: 'worldgen:provisional', source: 'worldgen' }),
      makePatch({ turn: 5, target: 'r1', path: 'content', to: { x: 2 }, because: 'worldgen', source: 'worldgen' }),
      makePatch({ turn: 6, target: 'r2', path: 'content', to: { y: 1 }, because: 'worldgen', source: 'worldgen' }),
    ];
    const recap = whileYouWereGone(clocks, ledger, { sinceTurn: 2 });
    assert.deepEqual(recap.firedClocks.map(c => c.id), ['b']);
    assert.deepEqual(recap.superseded, [{ target: 'r1', turn: 5 }]);
  });
});

describe('long single-edge crossings (the splitLeg fix)', () => {
  // A 40-day ocean lane is ONE edge — there is no waypoint to cut at, so
  // the planner must split by days. It used to recurse into path[1] of a
  // one-node path and emit legs with `from: undefined` and empty paths.
  const oceanGeo = () => {
    let geo = { nodes: {}, edges: [] };
    geo = { nodes: {
      a: { id: 'a', name: 'Homeport', kind: 'province', port: true, discovered: true },
      b: { id: 'b', name: 'Farshore', kind: 'province', port: true, discovered: true },
    }, edges: [{ from: 'a', to: 'b', direction: 'east', days: 40, kind: 'sea' }] };
    return geo;
  };

  it('splits a 40-day lane into day-chunks with real endpoints', () => {
    const plan = planJourney(oceanGeo(), 'a', 'b', { capabilities: { sea: true } });
    assert.ok(plan, 'the crossing plans');
    assert.equal(plan.totalDays, 40);
    assert.ok(plan.legs.length >= 3, 'a 40-day lane cannot be one leg');
    for (const leg of plan.legs) {
      assert.equal(leg.from, 'a');
      assert.equal(leg.to, 'b');
      assert.ok(Array.isArray(leg.path) && leg.path.length === 2, 'each chunk keeps the real path');
      assert.ok(leg.segments <= 8, 'no leg outruns the segment budget');
      assert.ok(leg.days >= 1);
    }
  });
});

describe('waygates — discovery-gated fast travel', () => {
  // The teleportation-circle pattern as data: every continent's middle
  // province carries a dormant waygate; gate edges are 0 days but the
  // planner refuses them until the party holds the `gate` capability AND
  // has discovered BOTH endpoints — "you must have seen the circle".
  const gated = () => {
    const sk = mintWorldSkeleton(1234);
    const gates = sk.provinces.filter(p => sk.geo.nodes[p].waygate);
    return { sk, gates };
  };

  it('every continent minted a dormant waygate, pairwise connected', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const sk = mintWorldSkeleton(seed);
      const gates = sk.provinces.filter(p => sk.geo.nodes[p].waygate);
      assert.equal(gates.length, sk.continents.length, `seed ${seed}`);
      const gateEdges = sk.geo.edges.filter(e => e.kind === 'gate');
      assert.equal(gateEdges.length, (gates.length * (gates.length - 1)) / 2);
      assert.ok(gateEdges.every(e => e.days === 0));
    }
  });

  it('dormant gates never shorten default routes', () => {
    const { sk, gates } = gated();
    if (gates.length < 2) return;
    const walked = routeBetween(sk.geo, gates[0], gates[1]);
    assert.ok(walked === null || walked.days > 0, 'no silent 0-day teleport');
  });

  it('capability without discovery stays closed; both together open a 0-day crossing with a toll', () => {
    const { sk, gates } = gated();
    assert.ok(gates.length >= 2, 'seed 1234 has two continents');
    const [a, b] = gates;

    const attuned = planJourney(sk.geo, a, b, { capabilities: { gate: true } });
    const attunedGate = attuned?.legs.some(l => l.mode === 'gate') ?? false;
    assert.equal(attunedGate, false, 'undiscovered endpoints stay closed');

    let geo = sk.geo;
    geo = { ...geo, nodes: { ...geo.nodes,
      [a]: { ...geo.nodes[a], discovered: true },
      [b]: { ...geo.nodes[b], discovered: true } } };
    const open = planJourney(geo, a, b, { capabilities: { gate: true } });
    assert.ok(open, 'the gate route plans');
    assert.equal(open.mode, 'gate');
    const gateLeg = open.legs.find(l => l.mode === 'gate');
    assert.equal(gateLeg.days, 0);
    assert.deepEqual(gateLeg.costHint, { tollGold: 25 });
    assert.ok(open.totalDays === 0, 'the crossing itself is instant');
    assert.ok(open.totalSegments >= 1, 'but still at least one scene');
  });

  it('sea legs carry the passage cost hint', () => {
    const sk = mintWorldSkeleton(1234);
    const { home, far } = crossContinentPair(sk);
    const plan = planJourney(sk.geo, home, far, { capabilities: { sea: true } });
    const seaLeg = plan.legs.find(l => l.mode === 'sea');
    assert.deepEqual(seaLeg.costHint, { passageGoldPerDay: 1 });
  });
});
