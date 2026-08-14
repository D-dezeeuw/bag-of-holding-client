// The world ledger — base ⊕ patches ⊕ views.
//
// Guards the property the whole memory architecture rests on: what the Game
// Master said in hour 2 is still true, still addressable, and still cheap to
// find in hour 60 — and it can never overrule what the dice decided.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makePatch, appendPatch, fold, foldAll, getPath, historyOf,
  dirtyTargets, recentCauses, compact, SCOPES, KINDS,
  digestScopeOf, causesFor,
} from '../src/ledger/patch.js';
import { makeId, slugSegment, isValidId, parentOf, kindOf, isUnder } from '../src/ledger/ids.js';

const MARA = 'region.emberfen.settlement.thornwick.npc.mara';
const CURTAINS = 'region.emberfen.castle.hall.detail.curtains';

const p = (over = {}) => makePatch({
  turn: 1, target: MARA, path: 'attitude', to: 'wary', kind: 'canon', ...over,
});

describe('entity ids', () => {
  it('builds nested ids from names', () => {
    const region = 'region.emberfen';
    const town   = makeId(region, 'settlement', 'Thorn Wick');
    assert.equal(town, 'region.emberfen.settlement.thorn-wick');
    assert.equal(makeId(town, 'npc', 'Mara Vell'), 'region.emberfen.settlement.thorn-wick.npc.mara-vell');
  });

  it('slugs LLM-supplied names safely', () => {
    assert.equal(slugSegment("The FarStay Inn!"), 'the-farstay-inn');
    assert.equal(slugSegment('  '), 'unnamed');
    assert.equal(slugSegment('Café Ürsel'), 'cafe-ursel');
  });

  it('validates, walks up, and reports kind', () => {
    assert.ok(isValidId(MARA));
    assert.ok(!isValidId('Region.Emberfen'));
    assert.ok(!isValidId(''));
    assert.equal(kindOf(MARA), 'npc');
    assert.equal(parentOf(MARA), 'region.emberfen.settlement.thornwick');
  });

  it('prefix matching respects segment boundaries', () => {
    assert.ok(isUnder(MARA, 'region.emberfen'));
    assert.ok(isUnder('region.emberfen', 'region.emberfen'));
    assert.ok(!isUnder('region.emberfenwood', 'region.emberfen'),
      'a longer name must not be treated as a child');
  });
});

describe('folding', () => {
  it('applies patches over a base record in order', () => {
    const base = { name: 'Mara', attitude: 'neutral', role: 'smith' };
    const out  = fold(base, [p({ to: 'wary' }), p({ turn: 2, to: 'hostile' })], MARA);
    assert.equal(out.attitude, 'hostile');
    assert.equal(out.role, 'smith', 'untouched fields survive');
  });

  it('writes nested paths', () => {
    const out = fold({}, [p({ path: 'relationship.player.trust', to: 3 })], MARA);
    assert.equal(getPath(out, 'relationship.player.trust'), 3);
  });

  it('ignores patches for other entities', () => {
    const out = fold({ attitude: 'neutral' }, [p({ target: CURTAINS, to: 'moldy' })], MARA);
    assert.equal(out.attitude, 'neutral');
  });

  it('mints entities that exist only in the ledger', () => {
    // The GM invented the mold; nothing generated it, so there is no base.
    const out = fold(undefined, [p({ target: CURTAINS, path: 'condition', to: 'moldy' })], CURTAINS);
    assert.equal(out.condition, 'moldy');
  });

  it('never lets a later canon patch overwrite a mechanical fact', () => {
    const out = fold({ hp: 7 }, [
      p({ kind: 'mechanical', path: 'hp', to: 2, turn: 1 }),
      p({ kind: 'canon',      path: 'hp', to: 7, turn: 2 }),
    ], MARA);
    assert.equal(out.hp, 2, 'the dice decide hit points, not the narrator');
  });
});

describe('foldAll over a location', () => {
  const bases = {
    [MARA]: { name: 'Mara', attitude: 'neutral' },
    'region.emberfen.settlement.thornwick.npc.dorn': { name: 'Dorn' },
    'region.saltmarch.npc.other': { name: 'Elsewhere' },
  };
  it('collects every entity under a prefix, base or ledger-born', () => {
    const out = foldAll(bases, [
      p({ to: 'hostile' }),
      p({ target: 'region.emberfen.settlement.thornwick.inn.privy.creature.ghoul', path: 'alive', to: true }),
    ], 'region.emberfen.settlement.thornwick');
    assert.equal(out[MARA].attitude, 'hostile');
    assert.ok(out['region.emberfen.settlement.thornwick.npc.dorn']);
    assert.ok(out['region.emberfen.settlement.thornwick.inn.privy.creature.ghoul'].alive);
    assert.ok(!Object.keys(out).some(id => id.startsWith('region.saltmarch')));
  });
});

describe('append gate — mechanical beats canon', () => {
  it('rejects a canon patch that contradicts mechanical state', () => {
    const { ledger } = appendPatch([], p({ kind: 'mechanical', path: 'hp', to: 2 }));
    const res = appendPatch(ledger, p({ kind: 'canon', path: 'hp', to: 7, turn: 2 }));
    assert.equal(res.ok, false);
    assert.match(res.reason, /contradicts mechanical/);
    assert.equal(res.conflict.to, 2);
  });

  it('accepts canon that agrees with mechanical state', () => {
    const { ledger } = appendPatch([], p({ kind: 'mechanical', path: 'hp', to: 2 }));
    assert.equal(appendPatch(ledger, p({ kind: 'canon', path: 'hp', to: 2, turn: 2 })).ok, true);
  });

  it('accepts canon on fields the engine never touched', () => {
    const { ledger } = appendPatch([], p({ kind: 'mechanical', path: 'hp', to: 2 }));
    const res = appendPatch(ledger, p({ kind: 'canon', path: 'mood', to: 'grieving', turn: 2 }));
    assert.equal(res.ok, true);
  });

  it('lets mechanical patches overwrite anything', () => {
    const { ledger } = appendPatch([], p({ kind: 'canon', path: 'hp', to: 7 }));
    assert.equal(appendPatch(ledger, p({ kind: 'mechanical', path: 'hp', to: 0, turn: 2 })).ok, true);
  });
});

describe('validation', () => {
  it('refuses malformed patches', () => {
    assert.throws(() => makePatch({ turn: 1, path: 'a', to: 1 }), /target/);
    assert.throws(() => makePatch({ turn: 1, target: MARA, to: 1 }), /field path/);
    assert.throws(() => makePatch({ turn: 1, target: MARA, path: 'a', to: 1, scope: 'galactic' }), /scope/);
    assert.throws(() => makePatch({ turn: 1, target: MARA, path: 'a', to: 1, kind: 'vibes' }), /kind/);
    assert.throws(() => makePatch({ target: MARA, path: 'a', to: 1 }), /turn/);
  });
  it('exposes its vocabularies', () => {
    assert.deepEqual([...SCOPES], ['local', 'regional', 'world']);
    assert.deepEqual([...KINDS], ['mechanical', 'canon']);
  });
});

describe('queries', () => {
  const ledger = [
    p({ turn: 1, path: 'condition', target: CURTAINS, to: 'moldy', scope: 'local',    because: 'damp has crept through the hall' }),
    p({ turn: 4, path: 'attitude',  to: 'hostile',    scope: 'regional', because: 'the player sided with the Iron Court' }),
    p({ turn: 9, path: 'ruler',     target: 'region.emberfen', to: 'none', scope: 'world', because: 'the duke was killed' }),
  ];

  it('returns one entity\'s whole history', () => {
    assert.equal(historyOf(ledger, CURTAINS).length, 1);
    assert.equal(historyOf(ledger, MARA).length, 1);
  });

  it('marks digests dirty at and above the patch scope', () => {
    const dirty = dirtyTargets(ledger);
    assert.ok(dirty.includes(MARA));
    assert.ok(dirty.includes('region.emberfen'), 'the region digest must re-render');
    assert.ok(!dirty.includes(CURTAINS), 'a local detail does not invalidate digests');
  });

  it('surfaces recent causes newest first', () => {
    const causes = recentCauses(ledger, { limit: 2 });
    assert.equal(causes.length, 2);
    assert.match(causes[0].because, /duke/);
    assert.match(causes[1].because, /Iron Court/);
  });

  it('filters causes by scope', () => {
    const world = recentCauses(ledger, { minScope: 'world' });
    assert.equal(world.length, 1);
  });
});

describe('compaction', () => {
  const bases = { [MARA]: { name: 'Mara', attitude: 'neutral' } };
  const ledger = [
    p({ turn: 1,  path: 'mood',     to: 'tired',   scope: 'local' }),
    p({ turn: 2,  path: 'mood',     to: 'annoyed', scope: 'local' }),
    p({ turn: 40, path: 'attitude', to: 'hostile', scope: 'regional', because: 'a betrayal' }),
    p({ turn: 41, path: 'mood',     to: 'furious', scope: 'local' }),
  ];

  it('folds old local patches into base and keeps the rest', () => {
    const out = compact(bases, ledger, { beforeTurn: 30 });
    assert.equal(out.foldedCount, 2);
    assert.equal(out.ledger.length, 2);
    assert.equal(out.bases[MARA].mood, 'annoyed', 'stale detail folded into base');
  });

  it('preserves the folded world exactly', () => {
    const before = fold(bases[MARA], ledger, MARA);
    const out    = compact(bases, ledger, { beforeTurn: 30 });
    const after  = fold(out.bases[MARA], out.ledger, MARA);
    assert.deepEqual(after, before, 'compaction must not change what is true');
  });

  it('keeps regional and world history forever', () => {
    const out = compact(bases, ledger, { beforeTurn: 100 });
    assert.ok(out.ledger.every(x => x.scope !== 'local'));
    assert.ok(out.ledger.some(x => x.because === 'a betrayal'));
  });

  it('is deterministic and idempotent', () => {
    const a = compact(bases, ledger, { beforeTurn: 30 });
    const b = compact(bases, ledger, { beforeTurn: 30 });
    assert.deepEqual(a, b);
    const twice = compact(a.bases, a.ledger, { beforeTurn: 30 });
    assert.equal(twice.foldedCount, 0);
  });

  it('is a no-op when nothing is stale', () => {
    const out = compact(bases, ledger, { beforeTurn: 0 });
    assert.equal(out.foldedCount, 0);
    assert.deepEqual(out.ledger, ledger);
  });
});

describe('the 80-hour property', () => {
  it('a fact from turn 2 still resolves after thousands of turns', () => {
    let ledger = [];
    ledger = appendPatch(ledger, p({ turn: 2, target: CURTAINS, path: 'condition', to: 'moldy',
      because: 'the GM described mould on the curtains' })).ledger;
    for (let turn = 3; turn < 3000; turn++) {
      ledger = appendPatch(ledger, p({ turn, target: MARA, path: 'mood', to: `m${turn}` })).ledger;
    }
    assert.equal(fold(undefined, ledger, CURTAINS).condition, 'moldy');

    // …and still after compaction folds the noise away.
    const out = compact({}, ledger, { beforeTurn: 2900 });
    assert.equal(fold(out.bases[CURTAINS], out.ledger, CURTAINS).condition, 'moldy');
  });
});

describe('digest re-rendering', () => {
  // dirtyTargets said WHICH digests went stale and the host had nothing to do
  // with the answer: the invalidation set was computed, exported, tested — and
  // read by nobody, so an hour-30 region digest still described hour zero.
  describe('digestScopeOf', () => {
    it('resolves a region', () => {
      assert.deepEqual(digestScopeOf('region.emberfen'),
        { kind: 'region', collection: 'regions', key: 'emberfen' });
    });

    it('resolves settlements and dungeons', () => {
      assert.deepEqual(digestScopeOf('region.emberfen.settlement.farstay'),
        { kind: 'settlement', collection: 'settlements', key: 'farstay' });
      assert.deepEqual(digestScopeOf('region.emberfen.dungeon.salt-mine'),
        { kind: 'dungeon', collection: 'dungeons', key: 'salt-mine' });
    });

    it('stops at place granularity — a curtain has no digest', () => {
      assert.equal(digestScopeOf(CURTAINS), null);
      assert.equal(digestScopeOf('region.emberfen.settlement.farstay.npc.mara'), null);
      assert.equal(digestScopeOf('region.emberfen.settlement.farstay.inn.privy'), null);
    });

    it('refuses what it cannot address', () => {
      for (const bad of [null, undefined, '', 'emberfen', 'region', 'region.']) {
        assert.equal(digestScopeOf(bad), null, `${JSON.stringify(bad)} must not resolve`);
      }
    });
  });

  describe('causesFor', () => {
    const INN   = 'region.emberfen.settlement.farstay';
    const GHOUL = `${INN}.creature.privy-ghoul`;
    const led = [
      p({ turn: 2,  target: INN,   path: 'mood',      to: 'uneasy',  because: 'a traveller went missing' }),
      p({ turn: 5,  target: GHOUL, path: 'escalated', to: true,      because: 'the ghoul took the stablehand' }),
      p({ turn: 9,  target: 'region.emberfen.settlement.other', path: 'x', to: 1, because: 'unrelated news' }),
      p({ turn: 11, target: INN,   path: 'reputation', to: 'poor',   because: 'nobody will stay the night' }),
    ];

    it('includes what happened inside the place, not only to it', () => {
      const causes = causesFor(led, INN);
      assert.ok(causes.includes('the ghoul took the stablehand'),
        'an event in the inn\'s privy is news about the settlement');
      assert.equal(causes.length, 3);
    });

    it('excludes siblings', () => {
      assert.ok(!causesFor(led, INN).includes('unrelated news'));
    });

    it('honours the watermark so a re-render only sees new news', () => {
      assert.deepEqual(causesFor(led, INN, { sinceTurn: 10 }), ['nobody will stay the night']);
    });

    it('caps the batch, keeping the most recent', () => {
      const causes = causesFor(led, INN, { limit: 1 });
      assert.deepEqual(causes, ['nobody will stay the night']);
    });

    it('skips patches with nothing to say', () => {
      assert.deepEqual(causesFor([p({ turn: 1, target: INN, path: 'x', to: 1, because: null })], INN), []);
    });
  });
});

// ─── The holes a verification audit demonstrated, pinned shut ───────────────
//
// Each of these is a probe that USED to succeed: precedence compared exact
// path strings only, and compaction reordered history and erased mechanical
// ownership. If any of these tests fails, colour can overwrite truth again.

describe('precedence is prefix-aware', () => {
  const mech = makePatch({ turn: 1, target: 'npc.gob', kind: 'mechanical', path: 'stats.hp', to: 2 });

  it('rejects a canon patch aimed one level UP (parent replaces the subtree)', () => {
    const { ledger } = appendPatch([], mech);
    const up = makePatch({ turn: 2, target: 'npc.gob', kind: 'canon', path: 'stats', to: { hp: 9 } });
    const res = appendPatch(ledger, up);
    assert.equal(res.ok, false);
  });

  it('rejects a canon patch aimed one level DOWN (child edits inside the fact)', () => {
    const mechParent = makePatch({ turn: 1, target: 'npc.gob', kind: 'mechanical', path: 'stats', to: { hp: 2 } });
    const { ledger } = appendPatch([], mechParent);
    const down = makePatch({ turn: 2, target: 'npc.gob', kind: 'canon', path: 'stats.hp', to: 9 });
    assert.equal(appendPatch(ledger, down).ok, false);
  });

  it('fold defends the same way against a hand-edited ledger', () => {
    const up = makePatch({ turn: 2, target: 'npc.gob', kind: 'canon', path: 'stats', to: { hp: 9 } });
    const view = fold({}, [mech, up], 'npc.gob');
    assert.equal(getPath(view, 'stats.hp'), 2, 'the dice-set value must survive');
  });

  it('still accepts canon on genuinely disjoint fields', () => {
    const { ledger } = appendPatch([], mech);
    const colour = makePatch({ turn: 2, target: 'npc.gob', kind: 'canon', path: 'mood', to: 'wary' });
    assert.equal(appendPatch(ledger, colour).ok, true);
  });
});

describe('compaction preserves order, kind and history', () => {
  it('a kept regional patch older than folded local ones does not re-apply on top', () => {
    // regional says rumoured-dead at turn 1; mechanical local says alive at
    // turn 5. Live fold: alive. The old compactor folded only the local patch
    // into base and re-applied the kept regional one after — rumoured-dead.
    const patches = [
      makePatch({ turn: 1, target: 'npc.wight', kind: 'canon', scope: 'regional', path: 'status', to: 'rumoured-dead', because: 'tavern talk' }),
      makePatch({ turn: 5, target: 'npc.wight', kind: 'mechanical', scope: 'local', path: 'status', to: 'alive' }),
    ];
    const before = fold({}, patches, 'npc.wight');
    const { bases, ledger } = compact({}, patches, { beforeTurn: 10 });
    const after = fold(bases['npc.wight'], ledger, 'npc.wight');
    assert.deepEqual(after.status, before.status, 'compaction must not change what is true');
  });

  it('mechanical ownership survives compaction at the append gate and the fold', () => {
    const patches = [
      makePatch({ turn: 1, target: 'npc.gob', kind: 'mechanical', path: 'stats.hp', to: 2 }),
    ];
    const { bases, ledger } = compact({}, patches, { beforeTurn: 10 });
    const lie = makePatch({ turn: 11, target: 'npc.gob', kind: 'canon', path: 'stats.hp', to: 99 });
    assert.equal(appendPatch(ledger, lie, bases).ok, false, 'the gate must consult the base');
    const lieUp = makePatch({ turn: 11, target: 'npc.gob', kind: 'canon', path: 'stats', to: { hp: 99 } });
    assert.equal(appendPatch(ledger, lieUp, bases).ok, false, 'prefix-aware against the base too');
    const view = fold(bases['npc.gob'], [...ledger, lie], 'npc.gob');
    assert.equal(getPath(view, 'stats.hp'), 2, 'fold defends even if the lie got recorded');
  });

  it('kept patches stay citable as history but never apply twice', () => {
    const patches = [
      makePatch({ turn: 1, target: 'region.emberfen', kind: 'canon', scope: 'regional', path: 'threat', to: 'rising', because: 'the ghoul was ignored' }),
      makePatch({ turn: 2, target: 'region.emberfen', kind: 'mechanical', scope: 'local', path: 'visited', to: true }),
    ];
    const { bases, ledger, foldedCount } = compact({}, patches, { beforeTurn: 10 });
    assert.equal(foldedCount, 2);
    assert.equal(ledger.length, 1, 'the regional patch survives as history');
    assert.equal(ledger[0].folded, true);
    assert.ok(recentCauses(ledger, { minScope: 'regional' }).some(c => /ghoul/.test(c.because)),
      'history stays citable');
    // Applying the survivor again must be a no-op: the base already has it.
    const view = fold(bases['region.emberfen'], ledger, 'region.emberfen');
    assert.equal(view.threat, 'rising');
    // Re-compacting is idempotent — folded markers are not re-folded.
    const again = compact(bases, ledger, { beforeTurn: 20 });
    assert.equal(again.foldedCount, 0);
  });
});

describe('setPath safety', () => {
  it('preserves arrays instead of exploding them into keyed objects', () => {
    const base = { inventory: ['sword', 'rope'] };
    const p = makePatch({ turn: 1, target: 'pc', kind: 'mechanical', path: 'inventory.0', to: 'axe' });
    const view = fold(base, [p], 'pc');
    assert.ok(Array.isArray(view.inventory), 'the list must stay a list');
    assert.deepEqual(view.inventory, ['axe', 'rope']);
  });

  it('refuses prototype-chain and malformed paths at makePatch', () => {
    assert.throws(() => makePatch({ turn: 1, target: 'pc', path: '__proto__.polluted', to: 1 }), /forbidden/);
    assert.throws(() => makePatch({ turn: 1, target: 'pc', path: 'a..b', to: 1 }), /empty segment/);
    assert.throws(() => makePatch({ turn: 1, target: 'pc', path: 'a.constructor.b', to: 1 }), /forbidden/);
  });
});
