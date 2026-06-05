// settlement/economy.js — pure settlement economy / quest / dialogue helpers.
//
// Zero imports: trade math, the carried-inventory model, quest state
// transitions, and per-NPC dialogue memory are all pure functions of their
// arguments so they're unit-testable. The host wires these to its own state
// (gold on the character record, items on an inventory array, quests in a map,
// dialogue history on the NPC objects).
//
// Pairs with the worldgen blueprint's `settlementHints`, which constrains the AI
// that generates the settlements + NPCs this module then operates on.

export const DEFAULT_START_GOLD = 25;   // gp a fresh character carries
export const DEFAULT_REST_COST  = 5;    // gp for a night at an inn
export const DIALOGUE_MEMORY     = 6;   // exchanges kept per NPC
export const SECRET_MIN_EXCHANGES = 3;  // probing turns before a secret can slip

// kebab-case slug for stable ids derived from a display name.
export function slug(s) {
  return String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export function goldOf(record, startGold = DEFAULT_START_GOLD) {
  const g = record?.gold;
  return Number.isFinite(g) ? g : startGold;
}

// ─── Trade ────────────────────────────────────────────────────────────────────

// Can the PC afford `item`? Returns the post-purchase gold and the inventory
// line to add. Never mutates — the host commits the returned values.
export function resolvePurchase(record, item) {
  if (!item) return { ok: false, reason: 'no-item' };
  const gold  = goldOf(record);
  const price = Number.isFinite(item.price) ? item.price : 0;
  if (gold < price) return { ok: false, reason: 'insufficient-gold', short: price - gold, gold };
  return {
    ok: true,
    gold: gold - price,
    price,
    item: {
      id:          item.id ?? slug(item.name),
      name:        item.name,
      description: item.description ?? '',
      price,
      quantity:    1,
    },
  };
}

// Add an item to a carried inventory, stacking quantity by id. Pure.
export function addToInventory(inventory, item) {
  const inv = [...(inventory ?? [])];
  const idx = inv.findIndex(i => i.id === item.id);
  if (idx >= 0) {
    inv[idx] = { ...inv[idx], quantity: (inv[idx].quantity ?? 1) + (item.quantity ?? 1) };
  } else {
    inv.push({ ...item, quantity: item.quantity ?? 1 });
  }
  return inv;
}

// ─── Rest ─────────────────────────────────────────────────────────────────────

// Resting heals the PC to full. Costs `cost` gp (0 = free, e.g. no innkeeper).
export function resolveRest(record, maxHp, cost = DEFAULT_REST_COST) {
  const gold = goldOf(record);
  if (cost > 0 && gold < cost) return { ok: false, reason: 'insufficient-gold', short: cost - gold, gold };
  return { ok: true, gold: gold - cost, hpCurrent: maxHp, cost };
}

// ─── Quests ─────────────────────────────────────────────────────────────────

export function questId(npc) {
  return `quest-${slug(npc?.id ?? npc?.name)}`;
}

export function makeQuest(npc) {
  return {
    id:          questId(npc),
    npcId:       npc?.id ?? null,
    npcName:     npc?.name ?? '',
    factionId:   npc?.factionId ?? null,   // for faction reputation on completion
    description: npc?.questHook ?? '',
    status:      'active', // 'active' | 'completed' | 'failed'
  };
}

// Add a quest if not already tracked. Pure (returns a new map).
export function addQuest(quests, quest) {
  const q = quests ?? {};
  if (q[quest.id]) return q;
  return { ...q, [quest.id]: quest };
}

export function setQuestStatus(quests, id, status) {
  const q = quests ?? {};
  if (!q[id]) return q;
  return { ...q, [id]: { ...q[id], status } };
}

export function activeQuests(quests) {
  return Object.values(quests ?? {}).filter(q => q.status === 'active');
}

// ─── Dialogue memory ──────────────────────────────────────────────────────────

// Append an exchange line and keep only the last `max`.
export function pushDialogue(history, role, text, max = DIALOGUE_MEMORY) {
  const h = [...(history ?? []), { role, text }];
  return h.slice(-max);
}

// A secret can only surface after enough back-and-forth and only once.
export function canRevealSecret(npc, minExchanges = SECRET_MIN_EXCHANGES) {
  if (!npc?.secret || npc.secretRevealed) return false;
  const playerLines = (npc.dialogueHistory ?? []).filter(e => e.role === 'player').length;
  return playerLines >= minExchanges;
}
