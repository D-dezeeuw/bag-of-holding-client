// narrative/factions.js — pure faction-reputation math.
//
// Zero imports: reputation is a plain map ({ [factionId]: number } in
// [-100, 100]). These helpers clamp adjustments, bucket a score into a standing,
// and derive consequences (merchant prices, hostility). The host applies the
// shifts (e.g. accepting/completing a faction's quest) and reads the standing
// for dialogue tone and shop prices.
//
// Pairs with the worldgen blueprint's `factionsHints`, which constrains the AI
// that generates the factions this module then tracks.

export const REP_MIN = -100;
export const REP_MAX = 100;

// Standing thresholds (inclusive at the bound).
export const THRESHOLDS = Object.freeze({
  nemesis:  -80,  // ≤ -80
  enemy:    -50,  // ≤ -50
  ally:      50,  // ≥ 50
  champion:  80,  // ≥ 80
});

export function clampRep(v) {
  const n = Math.round(Number.isFinite(v) ? v : 0);
  return Math.max(REP_MIN, Math.min(REP_MAX, n));
}

export function reputationOf(map, factionId) {
  const v = map?.[factionId];
  return Number.isFinite(v) ? v : 0;
}

// Returns a new reputation map with `factionId` shifted by `delta` (clamped).
export function adjustReputation(map, factionId, delta) {
  if (!factionId) return map ?? {};
  return { ...(map ?? {}), [factionId]: clampRep(reputationOf(map, factionId) + delta) };
}

export function standing(rep) {
  const r = Number.isFinite(rep) ? rep : 0;
  if (r <= THRESHOLDS.nemesis) return 'nemesis';
  if (r <= THRESHOLDS.enemy)   return 'enemy';
  if (r >= THRESHOLDS.champion) return 'champion';
  if (r >= THRESHOLDS.ally)     return 'ally';
  return 'neutral';
}

export function standingFor(map, factionId) {
  return standing(reputationOf(map, factionId));
}

// Merchant price multiplier for a given standing (allies get a discount,
// enemies a markup). Neutral is 1.0.
export function priceModifier(stand) {
  switch (stand) {
    case 'champion': return 0.8;
    case 'ally':     return 0.9;
    case 'enemy':    return 1.25;
    case 'nemesis':  return 1.5;
    default:         return 1.0;
  }
}

// Apply the standing's price multiplier to a base price (rounded, min 1).
export function adjustPrice(basePrice, stand) {
  const p = Math.round((Number.isFinite(basePrice) ? basePrice : 0) * priceModifier(stand));
  return Math.max(1, p);
}

// Hostile standings refuse service / may attack.
export function isHostile(stand) {
  return stand === 'enemy' || stand === 'nemesis';
}
