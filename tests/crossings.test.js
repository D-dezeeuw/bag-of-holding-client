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
import { mintProvinceRegions, portAnchorOf, mintLandfall, whileYouWereGone, promoteObserved } from '../src/worldgen/hydrate.js';
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
    const walk = routeBetween(sk.geo, home, far, { traversable: (e) => e.kind !== 'sea' });
    assert.equal(walk, null);
    const sail = routeBetween(sk.geo, home, far);
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
