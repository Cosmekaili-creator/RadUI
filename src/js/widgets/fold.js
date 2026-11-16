// SPDX-License-Identifier: AGPL-3.0-or-later
// Search folding shared by the pickers and the contact search: accents, case, ligatures and
// typographic apostrophes do not matter. DOM-free.

const MARKS_RE = /\p{M}/gu;
const APOSTROPHES_RE = /[‘’‛ʼ′`´]/g;
const LIGATURES = Object.freeze({ 'œ': 'oe', 'æ': 'ae', 'ß': 'ss' });
const LIGATURES_RE = /[œæß]/g;

/**
 * Fold a string for comparison: NFD, combining marks removed, lower case, oe/ae/ss ligatures
 * expanded, typographic apostrophes turned into a plain one. Non-strings give ''.
 * 'Œuvre' -> 'oeuvre', 'Zoë' -> 'zoe', 'Straße' -> 'strasse', 'D’Arc' -> "d'arc".
 */
export function foldText(value) {
  if (typeof value !== 'string' || value === '') return '';
  return value
    .normalize('NFD')
    .replace(MARKS_RE, '')
    .toLowerCase()
    .replace(LIGATURES_RE, (c) => LIGATURES[c])
    .replace(APOSTROPHES_RE, "'");
}

/** The folded, whitespace-split words of a query (no empty words). */
export function foldTokens(query) {
  return foldText(query).split(/\s+/u).filter(Boolean);
}

/** True when every query word occurs in the (already folded) haystack. An empty query matches. */
export function matchesTokens(foldedHaystack, tokens) {
  for (const token of tokens) if (!foldedHaystack.includes(token)) return false;
  return true;
}
