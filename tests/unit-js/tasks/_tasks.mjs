// SPDX-License-Identifier: AGPL-3.0-or-later
// Builders for the task tests (WP C1): fictional VTODO texts (example.org) and described records.
import { openItem } from '../../../src/js/model/item.js';
import { describeTask } from '../../../src/js/tasks/list.js';

export const wrap = (body, tz = '') => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example Corp//Tasks 1.0//EN\n${tz}${body}END:VCALENDAR\n`;

/** A VTODO text. `lines` are extra property lines (without the final newline). */
export const todoText = (uid, summary, lines = []) => wrap(`BEGIN:VTODO\nUID:${uid}\nDTSTAMP:20260101T000000Z\nSUMMARY:${summary}\n${lines.map((l) => `${l}\n`).join('')}END:VTODO\n`);

/** Described record of a task text in a list. */
export function rec(uid, summary, lines = [], { collection = '/alice/tasks/', tz = 'Europe/Paris', now = Date.parse('2026-06-03T10:00:00Z'), etag = '"1"' } = {}) {
  const item = openItem(todoText(uid, summary, lines));
  if (!item.ok) throw new Error(`cannot open ${uid}: ${item.reason}`);
  const r = describeTask({ href: `${collection}${uid}.ics`, collection, etag, item }, { tz, now });
  r.routeKey = uid;
  return r;
}
