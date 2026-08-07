// src/ledger/ids.js — hierarchical entity ids.
//
// Every fact in the world belongs to something addressable. Ids are dotted
// paths that mirror containment:
//
//   region.emberfen
//   region.emberfen.settlement.thornwick
//   region.emberfen.settlement.thornwick.npc.mara
//   region.emberfen.settlement.thornwick.inn.privy.detail.curtains
//
// Two properties matter and both fall out of the shape:
//   • prefix matching gives you "everything in this place" for free, which is
//     how the scope assembler collects what a location knows;
//   • ids are stable across saves, so a patch written in hour 2 still resolves
//     in hour 60. Nothing may key off display names — those get rewritten by
//     the narrator, and a renamed tavern must not orphan its history.

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Slugify arbitrary text (an LLM-supplied name) into one id segment.
export function slugSegment(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'unnamed';
}

// Build a child id: makeId('region.emberfen', 'settlement', 'Thorn Wick')
//   → 'region.emberfen.settlement.thorn-wick'
export function makeId(parentId, kind, name) {
  const seg = `${slugSegment(kind)}.${slugSegment(name)}`;
  return parentId ? `${parentId}.${seg}` : seg;
}

export function isValidId(id) {
  if (typeof id !== 'string' || !id) return false;
  return id.split('.').every(s => SEGMENT.test(s));
}

export function parentOf(id) {
  const parts = String(id ?? '').split('.');
  return parts.length > 2 ? parts.slice(0, -2).join('.') : null;
}

// The kind segment of an id ('npc' for '...settlement.thornwick.npc.mara').
export function kindOf(id) {
  const parts = String(id ?? '').split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

// Is `id` inside `prefix` (or equal to it)? Segment-aware, so
// 'region.ember' is not treated as a prefix of 'region.emberfen'.
export function isUnder(id, prefix) {
  if (!id || !prefix) return false;
  return id === prefix || id.startsWith(`${prefix}.`);
}
