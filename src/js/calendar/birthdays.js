// SPDX-License-Identifier: AGPL-3.0-or-later
// The "Birthdays" virtual calendar (SPECS 4.1b). Read-only, client side, nothing is written. No DOM.
//
//   birthdayOccurrences(contacts, {from, to, hideKeys})  yearly all-day occurrences in [from, to) (ISO dates)
//   bdayOfCardDate(d)                                     vcard.js parseCardDate() -> {year?, month, day} | null
//   yearlyAllDayKeys(items)                               the real calendars' yearly all-day events, for the duplicate filter
//   isDuplicate(bday, keys)                               name + month/day match
//
// A contact summary is {uid, key, ab, fn, bday: {year?, month, day}}. LEAP RULE: a 29 February birthday falls
// on 28 February in a year that is not a leap year (documented in docs/calendar.md). The age is shown only when
// the birth year is known (a `--MM-DD` birthday has none) and is the year of the occurrence minus the birth year.

import { foldText } from "../widgets/fold.js";
import { DAY_MS, daysInMonth, isoOfMs } from "./grid.js";

const p2 = (n) => String(n).padStart(2, "0");

/** {year|null, month, day} from vcard.js parseCardDate output ({year, month, day, raw} | {text:true}); null when not a date. */
export function bdayOfCardDate(d) {
  if (!d || d.text || !Number.isInteger(d.month) || !Number.isInteger(d.day)) return null;
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) return null;
  return { year: Number.isInteger(d.year) && d.year > 0 ? d.year : null, month: d.month, day: d.day };
}

/** Folded name for the duplicate comparison: no accents, case or punctuation, single spaces. */
export function normName(s) {
  return foldText(String(s || ""))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function dateIn(year, month, day) {
  const d = month === 2 && day === 29 && daysInMonth(year, 2) < 29 ? 28 : Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${p2(month)}-${p2(d)}`;
}

/**
 * Occurrences in [from, to) (ISO dates, `to` exclusive). Each is a read-only all-day event shaped for the layout
 * modules: {id, virtual:true, readOnly:true, uid, key, ab, title, date, age, allDay, start, end} where start and
 * end are TimeInfos of kind 'date' (end exclusive). `hideKeys` is the list from yearlyAllDayKeys (real yearly
 * all-day events): matching birthdays are left out.
 */
export function birthdayOccurrences(contacts, { from, to, hideKeys = null } = {}) {
  const out = [];
  const y0 = +from.slice(0, 4);
  const y1 = +to.slice(0, 4);
  for (const c of contacts || []) {
    const b = c && c.bday;
    if (!b || !Number.isInteger(b.month) || !Number.isInteger(b.day)) continue;
    if (hideKeys && isDuplicate(c, hideKeys)) continue;
    for (let y = y0; y <= y1; y++) {
      if (b.year && y <= b.year) continue; // the day of birth itself is not a birthday
      const date = dateIn(y, b.month, b.day);
      if (date < from || date >= to) continue;
      const wall = Date.parse(`${date}T00:00:00Z`);
      const info = (ms) => ({ kind: "date", iso: isoOfMs(ms), wallMs: ms, instant: null, tzid: null, tzClass: null });
      out.push({
        id: `bday:${c.ab || ""}:${c.uid || c.key}:${y}`,
        virtual: true,
        readOnly: true,
        uid: c.uid,
        key: c.key,
        ab: c.ab,
        title: c.fn,
        date,
        age: b.year ? y - b.year : null,
        allDay: true,
        start: info(wall),
        end: info(wall + DAY_MS),
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : normName(a.title) < normName(b.title) ? -1 : 1));
  return out;
}

/**
 * Keys {name, month, day} of the yearly all-day events of real calendars: `items` are opened Items (events) or
 * {summary, start: {month, day}} objects. Only an all-day master with FREQ=YEARLY (any interval) counts.
 */
export function yearlyAllDayKeys(items) {
  const out = [];
  for (const it of items || []) {
    let summary;
    let iso;
    if (it && it.kind === "event") {
      const f = it.fields();
      if (!f.allDay || !f.rrule || !/(?:^|;)FREQ=YEARLY(?:;|$)/i.test(f.rrule)) continue;
      summary = f.summary;
      iso = f.start.iso;
    } else if (it && it.summary !== undefined && it.month && it.day) {
      summary = it.summary;
      iso = `0000-${p2(it.month)}-${p2(it.day)}`;
    } else continue;
    const name = normName(summary);
    if (name) out.push({ name, month: +iso.slice(5, 7), day: +iso.slice(8, 10) });
  }
  return out;
}

/** Same month/day and the event title contains the contact's folded name as whole words. */
export function isDuplicate(contact, keys) {
  const b = contact.bday;
  const name = normName(contact.fn);
  if (!b || !name) return false;
  const padded = ` ${name} `;
  return keys.some((k) => k.month === b.month && k.day === b.day && ` ${k.name} `.includes(padded));
}

