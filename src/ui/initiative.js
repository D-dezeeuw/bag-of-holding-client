// === Initiative tracker reference UI (the kernel roadmap's 4.1.0 row) ===
//
// A tiny web component that consumes encounter state and renders a turn
// UI. Reference example, not part of the engine — it lands in the
// client for the same boundary reason the prompt scaffolding did.
//
// The component splits in two so this repo's node tests cover the part
// that can be wrong:
//
//   - `initiativeViewModel(state)` — PURE. Sorts, marks the active
//     turn, derives hp bars and condition chips, counts the round.
//     Everything a layout needs, nothing a DOM needs.
//   - `<boh-initiative-tracker>` — the thin element. Registered only
//     when the platform HAS custom elements (`defineInitiativeTracker`
//     is a no-op in node), renders the view model with plain DOM calls,
//     and emits 'advance-turn' / 'select-combatant' events upward. No
//     framework, no styles beyond a class per state.
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

    /** The host pushes fresh encounter state; the tracker re-renders. */
    setState(state) {
      this.#state = state ?? { participants: [] };
      this.#render();
      return this;
    }

    advance() {
      this.setState(advanceTurn(this.#state));
      this.dispatchEvent(new CustomEvent('advance-turn', {
        detail: initiativeViewModel(this.#state), bubbles: true,
      }));
    }

    #render() {
      const vm = initiativeViewModel(this.#state);
      this.textContent = '';
      const list = document.createElement('ol');
      list.className = 'boh-initiative';
      list.dataset.round = String(vm.round);
      for (const row of vm.rows) {
        const item = document.createElement('li');
        item.className = [
          'combatant', row.side, row.active ? 'active' : '', row.downed ? 'downed' : '',
        ].filter(Boolean).join(' ');
        item.dataset.id = row.id;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${row.initiative} · ${row.name}`;
        item.appendChild(name);
        if (row.hpFraction !== null) {
          const bar = document.createElement('span');
          bar.className = 'hp';
          bar.style.setProperty('--hp', String(row.hpFraction));
          bar.textContent = `${row.hp}/${row.hpMax}`;
          item.appendChild(bar);
        }
        for (const condition of row.conditions) {
          const chip = document.createElement('span');
          chip.className = 'condition';
          chip.textContent = condition;
          item.appendChild(chip);
        }
        item.addEventListener('click', () => this.dispatchEvent(new CustomEvent('select-combatant', {
          detail: { id: row.id }, bubbles: true,
        })));
        list.appendChild(item);
      }
      this.appendChild(list);
    }
  }

  CE.define(tagName, InitiativeTracker);
  return InitiativeTracker;
}
