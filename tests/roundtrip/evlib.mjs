// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers of the event round trip (ui-ops-events.test.mjs): the REAL store write path (store/writes.js) over the
// throwaway Radicale without an access list (so the server alone decides), a counting DAV client, and a semantic
// "what changed" report between two served texts. No tests in here.
import { createWrites } from "../../src/js/store/writes.js";
import { flatDiff } from "./compare.mjs";
import { countingEnv, newCollection } from "./uilib.mjs";

export { countingEnv };

/** A fresh calendar of the account; returns its href. */
export const newCalendar = (env, tag = "ev") => newCollection(env, "event", tag);

/** The write path of the app over the throwaway server: no stores, no access list. */
export function makeWrites(env) {
  const stores = { get: () => null, open: () => null };
  return createWrites({ client: env.client, stores });
}

/** Collection argument of the write path for a calendar href (the kind picks `.ics` names). */
export const calOf = (href) => ({ href, kind: "calendar" });

/** What changed between two texts, managed properties (DTSTAMP, SEQUENCE, LAST-MODIFIED) ignored: sorted line lists. */
export function delta(before, after) {
  const d = flatDiff(before, after, { ignoreManaged: true });
  const fmt = (e) => `${e.path.replace(/^VCALENDAR\//, "")} | ${e.head}:${e.value}`;
  return { removed: d.onlyA.map(fmt).sort(), added: d.onlyB.map(fmt).sort() };
}

/** Property names touched by a delta (both sides), grouped by component path without RECURRENCE-ID suffix. */
export function touched(before, after) {
  const d = flatDiff(before, after, { ignoreManaged: true });
  return [...new Set([...d.onlyA, ...d.onlyB].map((e) => e.name))].sort();
}

/** PUT a text as a new item and read it back as the server holds it. */
export async function putServed(env, col, text, name = "item") {
  const href = `${col}${name}.ics`;
  await env.client.putItem(href, text, { create: true });
  const served = await env.client.getItem(href);
  return { href, served: { text: served.text, etag: served.etag } };
}

/** Every resource of a calendar: [{href, etag, text}] sorted by href. */
export async function entriesOf(env, col) {
  const list = await env.client.listItemEtags(col);
  if (!list.length) return [];
  const { items } = await env.client.calendarMultiget(col, list.map((x) => x.href));
  return items.map((i) => ({ href: i.href, etag: i.etag, text: i.text })).sort((a, b) => (a.href < b.href ? -1 : 1));
}
