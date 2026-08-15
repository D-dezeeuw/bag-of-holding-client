// tests/thread-shape.test.js — the acceptance gate for the campaign shape
// that drove the depth phases:
//
//   "Faction A is at war with Faction B and Faction C. The player starts as
//    a peasant in B and grows into the hero who crosses to A's heartland to
//    defeat the King of Faction A — with lore all along the way."
//
// A feasibility probe against the pre-Phase-A engine found seven places this
// story could be TOLD but not HELD. Each phase turns some assertions green;
// the `todo` blocks at the bottom name what is still prose-only. When the
// last todo flips to a real test, the engine holds the whole thread.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bakeCartridge, cellsOf, entityIdsOf,
  adjustReputationWithRipples, standingFor,
  planJourney, gazetteerOf, coerceBeatLocation,
  plantSetup, emptyThread,
} from '../index.js';

// Hunt a seed whose genesis rolls the full premise: a faction with two
// enemies, on a different continent from at least one of them. The relations
// pass guarantees ONE enemy pair for every seed; the two-front war is a roll.
// Determinism still holds — the found seed is a constant for a given library
// version, and every assertion below is exact once it is found.
async function bakeWarWorld() {
  for (let seed = 1; seed <= 40; seed++) {
    const cart = await bakeCartridge(seed);
    const { factions } = cart.data;
    const aggressor = factions.find(f => f.enemies.length >= 2);
    if (!aggressor) continue;
    const enemy = factions.find(f => f.id === aggressor.enemies[0]);
    const continentOf = (f, geo) => geo.nodes[f.territory[0]]?.parent;
    if (continentOf(aggressor, cart.data.geo) !== continentOf(enemy, cart.data.geo)) {
      return { cart, aggressor, enemy };
    }
  }
  assert.fail('no seed in 1..40 rolled a cross-continent two-front war — the vocabulary regressed');
}

const { cart, aggressor: A, enemy: B } = await bakeWarWorld();
const data = cart.data;

describe('the powers exist and the engine can hold them', () => {
  it('factions are tree entities: addressable, cell-resolvable, in the artifact', () => {
    const ids = entityIdsOf(data);
    for (const f of data.factions) {
      assert.ok(ids.has(f.id), `${f.id} must be addressable`);
      assert.equal(cellsOf(data, f.id).faction, f);
    }
    assert.ok(data.factions.length >= 3, 'a world of powers, not a duel');
  });

  it('the war has state: who, how hot, what about, and where it is felt', () => {
    assert.ok(data.warState, 'a two-front world is not at peace');
    const wars = data.warState.wars.filter(w => w.between.includes(A.id));
    assert.ok(wars.length >= 2, 'A fights on two fronts');
    for (const war of wars) {
      assert.ok(['cold', 'raiding', 'open'].includes(war.intensity));
      assert.ok(war.cause.length > 0, 'every war is about something concrete');
      assert.ok(war.front.length > 0, 'every war is felt somewhere real');
      for (const p of war.front) assert.ok(data.geo.nodes[p], `front province ${p} exists`);
    }
    assert.equal(cellsOf(data, 'world').warState, data.warState, 'the war is a cell');
  });

  it('the King of Faction A is a stored fact: a crown with A as sovereign', () => {
    const throne = data.lore.crowns.find(c =>
      c.factionRelations.some(r => r.factionId === A.id && r.stance === 'sovereign'));
    assert.ok(throne, `some crown is ${A.name}'s throne`);
    // At most one sovereign per crown, everywhere.
    for (const crown of data.lore.crowns) {
      const sovereigns = crown.factionRelations.filter(r => r.stance === 'sovereign');
      assert.ok(sovereigns.length <= 1, `${crown.id} has ${sovereigns.length} sovereigns`);
    }
    // The throne stands in A's own territory — the target the hero crosses to.
    const throneProvince = throne.id.replace(/\.crown$/, '');
    assert.ok(A.territory.includes(throneProvince));
  });

  it('the crossing is real: B\'s home to A\'s heartland is a plannable journey', () => {
    const from = B.territory[0];
    const to = A.territory[0];
    const journey = planJourney(data.geo, from, to, { capabilities: { sea: true } });
    assert.ok(journey && journey.totalDays >= 1, 'the hero can actually get there');
    assert.equal(planJourney(data.geo, from, to, {}), null,
      'and not without a ship — the crossing is a gate, not decoration');
  });

  it('striking A ripples: B warms to the hero who hurts their enemy', () => {
    let rep = {};
    rep = adjustReputationWithRipples(rep, data.factions, A.id, -60);
    assert.equal(standingFor(rep, A.id), 'enemy', 'A remembers');
    assert.ok(rep[B.id] > 0, `B (${B.name}) warms toward A's enemy`);
    assert.equal(rep[B.id], 30, 'damped by the enemy ripple, exactly');
    // And the inverse arc: helping B directly angers A.
    let rep2 = adjustReputationWithRipples({}, data.factions, B.id, 40);
    assert.ok(rep2[A.id] < 0, 'A resents those who prop up its enemies');
  });

  it('beats still ground to real places, legends still pay the arc', () => {
    const gaz = gazetteerOf(data.geo, { legends: data.lore.legends });
    const beat = coerceBeatLocation(
      { id: 'b-final', dramaticPurpose: 'face the King', preferredLocation: 'somewhere in the heartland' },
      gaz);
    assert.ok(data.geo.nodes[beat.preferredLocation] ?? gaz.some(g => g.id === beat.preferredLocation));
    const thread = plantSetup(emptyThread(), {
      id: 'the-kings-name', clue: 'a requisition seal none of the elders recognise',
      paysInto: 'kill-the-king', dueByAct: 4, turn: 1,
    });
    assert.equal(thread.payoffs.length, 1);
  });
});

describe('what the engine still cannot hold (flips green phase by phase)', () => {
  it('phase B: the war ADVANCES while the player travels (fronts mint clocks)', { todo: true }, () => {
    // mintWarState gives the war a front; nothing yet mints a clock from it,
    // so whileYouWereGone still has nothing to report after a crossing.
  });

  it('phase E′: a beat binds to a POWER — cast carries the crown/faction id', { todo: true }, () => {
    // BEAT_SCHEMA still has no cast field; directive() reads beat.cast, which
    // nothing produces. "Defeat the King" is not yet a checkable target.
  });

  it('phase E′: a payoff references entities by id, not by label', { todo: true }, () => {
    // plantSetup({ paysInto }) is still a free string; nothing ties
    // 'kill-the-king' to the crown entity the first test found.
  });

  it('phase D: the King is a PERSON — an npc entity with voice and wants', { todo: true }, () => {
    // data.npcs is still empty at genesis; the crown names a house, not a
    // face the table can hate.
  });
});
