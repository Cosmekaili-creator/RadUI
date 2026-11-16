// SPDX-License-Identifier: AGPL-3.0-or-later
// Resolves what the event detail shows (RUN3 WP B3a, no DOM): the item behind a route key, the occurrence the `occ`
// parameter designates, the record the views draw, and why the event is read-only (the calendar is read-only for
// this account, an unknown time zone, a fidelity refusal). `cal` must match a discovered calendar and `key` is the
// UID (when unique in the calendar) or the file name; nothing is fetched from an address typed into the URL.

import { describeOccurrence, BIRTHDAYS_HREF } from './common.js';
import { birthdayOccurrences } from '../../calendar/birthdays.js';
import { addDays } from '../../calendar/grid.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {object} o
 * @param {object} o.source createCalendarSource(...)
 * @param {object} o.storeCtx
 * @param {{key: string, cal: string, occ?: string}} o.params
 * @param {{t: Function, lang: string, tz: string, use24h: boolean|null}} o.cx
 * @returns {Promise<{status: 'ready'|'birthday'|'notfound'|'nocalendar'|'occurrence'|'unreadable'|'error', model?: object, rec?: object}>}
 */
export async function loadDetailModel({ source, storeCtx, params, cx }) {
  const { key, cal, occ } = params;
  if (cal === BIRTHDAYS_HREF) {
    await source.loadBirthdays();
    return loadBirthday({ source, key, occ, cx });
  }
  const r = await source.resolveEvent({ key, cal, occParam: occ });
  if (r.state !== 'ok') return { status: r.state === 'unreadable' ? 'unreadable' : r.state, collection: r.collection || null, entry: r.entry || null, reason: r.reason || null, kind: r.kind || null };
  if (!r.occ) return { status: 'notfound', collection: r.collection };
  const { entry, item, collection } = r;
  const full = { ...cx, calendars: source.calendarMap(), keyOf: () => key, readOnly: source.isReadOnly };
  const rec = describeOccurrence({ ...r.occ, collection: collection.href, href: entry.href, etag: entry.etag, uid: item.uid }, full);
  const canWrite = storeCtx.access.canWrite(collection);
  let readOnlyReason = null;
  if (!canWrite) readOnlyReason = 'calendar';
  else if (item.readOnly) readOnlyReason = item.readOnlyReason || 'read-only';
  else if (storeCtx.writes.isReadOnly(entry.href)) readOnlyReason = 'fidelity';
  const canMove = canWrite && !item.readOnly && source.writable().some((c) => c.href.replace(/\/$/, '') !== collection.href.replace(/\/$/, ''));
  return { status: 'ready', model: { rec, item, occ: r.occ, entry, collection, canWrite, canMove, readOnlyReason } };
}

function loadBirthday({ source, key, occ, cx }) {
  if (typeof occ !== 'string' || !ISO_DATE.test(occ)) return { status: 'occurrence' };
  const contacts = source.birthdayContacts().filter((c) => c.key === key);
  if (!contacts.length) return { status: 'notfound' };
  const found = birthdayOccurrences(contacts, { from: occ, to: addDays(occ, 1) })[0];
  if (!found) return { status: 'occurrence' };
  const full = { ...cx, calendars: source.calendarMap(), keyOf: () => key, readOnly: source.isReadOnly };
  return { status: 'birthday', rec: describeOccurrence(found, full) };
}
