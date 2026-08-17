// === Initiative tracker reference UI (the kernel roadmap's 4.1.0 row) ===
//
// A web component that consumes encounter state and renders a turn UI.
// Reference example, not part of the engine — it lands in the client
// for the same boundary reason the prompt scaffolding did.
//
// The component splits so this repo's node tests cover the parts that
// can be wrong:
//
//   - `initiativeViewModel(state)` — PURE. Sorts, marks the active
//     turn, derives hp bars and condition chips, counts the round.
//   - `rollEncounterInitiative(participants, { roll })` — PURE. The
//     adapter from real kernel shapes (Adventures.encounterParticipants
//     emits { id, name, hp, hpMax, dexterity, side }) to tracker
//     state; the roll is INJECTED so the engine-bound
//     Combat.rollInitiative puts every d20 in the roll log.
//   - `<boh-initiative-tracker>` — the element. Registered only where
//     custom elements exist (`defineInitiativeTracker` is a no-op in
//     node). Since 0.30.0 it carries its own shadow-DOM styles and a
//     built-in "Next turn" control, so it is usable with ZERO host
//     CSS; ::part() hooks (advance, combatant, name, hp, condition)
//     stay open for themers. Emits 'advance-turn' /
//     'select-combatant' upward; the host owns everything else.
//
// State shape (host-owned, engine-adjacent):
//   { participants: [{ id, name, initiative, hp, hpMax, side?,
//       conditions?, statBlockId? }], turnIndex?, round? }

export function initiativeViewModel(state = {}) {
  const participants = Array.isArray(state.participants) ? state.participants : [];
  const order = [...participants]
    .map((p, arrival) => ({ p, arrival }))
    .sort((a, b) =>
      (b.p.initiative ?? 0) - (a.p.initiative ?? 0)
      // Stable tie-break: arrival order, so equal rolls don't reshuffle
      // between renders (a tracker that jitters is worse than none).
      || a.arrival - b.arrival)
    .map(({ p }) => p);

  const count = order.length;
  const turnIndex = count === 0 ? 0 : ((state.turnIndex ?? 0) % count + count) % count;

  return Object.freeze({
    round: Math.max(1, state.round ?? 1),
    count,
    active: count ? order[turnIndex].id : null,
    rows: Object.freeze(order.map((p, i) => Object.freeze({
      id: p.id,
      name: p.name ?? p.id,
      initiative: p.initiative ?? 0,
      side: p.side ?? 'party',
      active: i === turnIndex,
      // Hp as a bar fraction, clamped — downed combatants render at 0
      // and stay listed (death saves happen ON the tracker, not off it).
      hpFraction: p.hpMax > 0 ? Math.max(0, Math.min(1, (p.hp ?? 0) / p.hpMax)) : null,
      hp: p.hp ?? null,
      hpMax: p.hpMax ?? null,
      downed: p.hpMax > 0 && (p.hp ?? 0) <= 0,
      conditions: Object.freeze([...(p.conditions ?? [])]),
    }))),
  });
}

/** Advance to the next turn: wraps, and bumps the round on wrap. */
export function advanceTurn(state = {}) {
  const count = (state.participants ?? []).length;
  if (count === 0) return { ...state, turnIndex: 0, round: state.round ?? 1 };
  const next = ((state.turnIndex ?? 0) + 1) % count;
  return {
    ...state,
    turnIndex: next,
    round: (state.round ?? 1) + (next === 0 ? 1 : 0),
  };
}

/**
 * Build tracker state from encounter participants (the exact shape
 * `Adventures.encounterParticipants` emits) by rolling initiative for
 * each. The roll is injected — pass the engine-bound
 * `Combat.rollInitiative` so every d20 lands in the roll log:
 *
 *   const state = rollEncounterInitiative(
 *     [...party, ...Adventures.encounterParticipants(scene, engine.monsters)],
 *     { roll: engine.Combat.rollInitiative });
 */
export function rollEncounterInitiative(participants = [], { roll } = {}) {
  if (typeof roll !== 'function') {
    throw new Error('rollEncounterInitiative: an injected roll function is required (pass the engine-bound Combat.rollInitiative)');
  }
  return {
    round: 1,
    turnIndex: 0,
    participants: participants.map((p) => ({
      ...p,
      initiative: roll({ dexterity: p.dexterity ?? 10 }),
    })),
  };
}

// Baked default styles (shadow DOM). Class hooks + ::part() stay open
// so a themed host can override without forking the element.
const TRACKER_CSS = `
  :host { display: block; font: 14px/1.4 system-ui, sans-serif; color: #e8e4da; }
  .advance { margin: 0 0 .5rem; padding: .35rem .8rem; border-radius: 6px;
    border: 1px solid #666; background: #2c2c38; color: inherit; cursor: pointer; }
  .advance:hover { background: #3a3a4a; }
  .round { margin-left: .6rem; color: #9a947f; font-size: .85em; }
  ol { list-style: none; margin: 0; padding: 0; }
  .combatant { display: flex; align-items: center; gap: .6rem;
    padding: .35rem .6rem; border-left: 3px solid transparent; border-radius: 4px; }
  .combatant.party { border-left-color: #6a9c6a; }
  .combatant.foe { border-left-color: #9c6a6a; }
  .combatant.active { background: #32323f; }
  .combatant.downed .name { text-decoration: line-through; opacity: .6; }
  .name { flex: 1; }
  .hp { position: relative; min-width: 5.5rem; text-align: center; font-size: .85em;
    padding: .1rem .4rem; border-radius: 4px; background: #202028; overflow: hidden; }
  .hp::before { content: ''; position: absolute; inset: 0;
    width: calc(var(--hp, 0) * 100%); background: #3f5d3f; z-index: -1; }
  .condition { font-size: .75em; padding: .05rem .4rem; border-radius: 999px;
    background: #4a3f5d; }
`;

/**
 * Register `<boh-initiative-tracker>` when the platform supports it.
 * Returns the element class in the browser and `null` in node — safe
 * to call unconditionally from a host bundle.
 */
export function defineInitiativeTracker(tagName = 'boh-initiative-tracker') {
  const CE = globalThis.customElements;
  const HTMLEl = globalThis.HTMLElement;
  if (!CE || !HTMLEl) return null;
  if (CE.get(tagName)) return CE.get(tagName);

  class InitiativeTracker extends HTMLEl {
    #state = { participants: [] };
    #root;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback() { this.#render(); }

    /** The host pushes fresh encounter state; the tracker re-renders. */
    setState(state) {
      this.#state = state ?? { participants: [] };
      this.#render();
      return this;
    }

    advance() {
      this.setState(advanceTurn(this.#state));
      this.dispatchEvent(new CustomEvent('advance-turn', {
        detail: initiativeViewModel(this.#state), bubbles: true, composed: true,
      }));
    }

    #render() {
      const vm = initiativeViewModel(this.#state);
      this.#root.textContent = '';

      const style = document.createElement('style');
      style.textContent = TRACKER_CSS;
      this.#root.appendChild(style);

      const button = document.createElement('button');
      button.className = 'advance';
      button.setAttribute('part', 'advance');
      button.textContent = 'Next turn ▸';
      button.addEventListener('click', () => this.advance());
      const round = document.createElement('span');
      round.className = 'round';
      round.textContent = `round ${vm.round}`;
      this.#root.appendChild(button);
      this.#root.appendChild(round);

      const list = document.createElement('ol');
      list.className = 'boh-initiative';
      list.dataset.round = String(vm.round);
      for (const row of vm.rows) {
        const item = document.createElement('li');
        item.className = [
          'combatant', row.side, row.active ? 'active' : '', row.downed ? 'downed' : '',
        ].filter(Boolean).join(' ');
        item.setAttribute('part', 'combatant');
        item.dataset.id = row.id;
        const name = document.createElement('span');
        name.className = 'name';
        name.setAttribute('part', 'name');
        name.textContent = `${row.initiative} · ${row.name}`;
        item.appendChild(name);
        if (row.hpFraction !== null) {
          const bar = document.createElement('span');
          bar.className = 'hp';
          bar.setAttribute('part', 'hp');
          bar.style.setProperty('--hp', String(row.hpFraction));
          bar.textContent = `${row.hp}/${row.hpMax}`;
          item.appendChild(bar);
        }
        for (const condition of row.conditions) {
          const chip = document.createElement('span');
          chip.className = 'condition';
          chip.setAttribute('part', 'condition');
          chip.textContent = condition;
          item.appendChild(chip);
        }
        item.addEventListener('click', () => this.dispatchEvent(new CustomEvent('select-combatant', {
          detail: { id: row.id }, bubbles: true, composed: true,
        })));
        list.appendChild(item);
      }
      this.#root.appendChild(list);
    }
  }

  CE.define(tagName, InitiativeTracker);
  return InitiativeTracker;
}
