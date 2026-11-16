// SPDX-License-Identifier: AGPL-3.0-or-later
// Search over the LOADED occurrences (summary, location, description). Folded: accents, case and typographic
// apostrophes do not matter; every word of the query must be found. No server request: everything enabled is
// loaded (Q-R3-8). No DOM.
//
//   searchOccurrences(occurrences, query, {limit, textOf})  -> {active, tokens, total, matches}
//   occurrenceText(occ)                                     {summary, location, description} of an occurrence

import { getText } from "../model/contentlines.js";
import { foldTokens, matchesTokens, foldText } from "../widgets/fold.js";

export const SEARCH_LIMIT = 200;
const cache = new WeakMap();

/** Text fields of an occurrence: a virtual one (birthday) has a title; a real one reads its VEVENT. */
export function occurrenceText(occ) {
  if (occ.virtual) return { summary: occ.title || "", location: "", description: "" };
  const c = occ.component;
  if (!c) return { summary: occ.summary || "", location: occ.location || "", description: occ.description || "" };
  return { summary: getText(c, "SUMMARY") || "", location: getText(c, "LOCATION") || "", description: getText(c, "DESCRIPTION") || "" };
}

function hayOf(occ, textOf) {
  const holder = occ.component || occ;
  let h = cache.get(holder);
  if (h === undefined) {
    const t = textOf(occ);
    h = foldText([t.summary, t.location, t.description].join("\n"));
    cache.set(holder, h);
  }
  return h;
}

/** Occurrences matching `query`, in the order given (callers pass them sorted by start); `total` is the match count before `limit`. */
export function searchOccurrences(occurrences, query, { limit = SEARCH_LIMIT, textOf = occurrenceText } = {}) {
  const tokens = foldTokens(String(query || ""));
  if (!tokens.length) return { active: false, tokens, total: 0, matches: [] };
  const all = occurrences.filter((o) => matchesTokens(hayOf(o, textOf), tokens));
  return { active: true, tokens, total: all.length, matches: all.slice(0, limit) };
}
