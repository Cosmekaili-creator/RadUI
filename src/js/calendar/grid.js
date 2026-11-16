// SPDX-License-Identifier: AGPL-3.0-or-later
// Calendar periods (RUN3 WP B1). Civil dates are ISO strings "YYYY-MM-DD" and never go through the
// local time zone: all arithmetic is on UTC milliseconds of the date itself. No DOM.
//
//   periodRange(view, date, {firstWeekday, phone})   {start, end(exclusive), days[], ...}
//   shiftDate(view, date, dir, {phone})              previous / next anchor date
//   instantWindow(range, tz, {pad})                  {from, to} instants for the event store
//   todayIn(tz, now)                                 today's date in the display zone

import { instantInZone } from "./tzprefs.js";

export const VIEWS = Object.freeze(["month", "week", "day", "agenda"]);
export const AGENDA_DAYS = 30;
export const PHONE_WEEK_DAYS = 3;
export const DAY_MS = 86400000;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const p2 = (n) => String(n).padStart(2, "0");

/** True for a real calendar date written YYYY-MM-DD. */
export function isValidDate(iso) {
  if (typeof iso !== "string") return false;
  const m = ISO_RE.exec(iso);
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}

/** UTC milliseconds of midnight of a date. Throws RangeError on an invalid date. */
export function dateMs(iso) {
  if (!isValidDate(iso)) throw new RangeError(`invalid date ${iso}`);
  const m = ISO_RE.exec(iso);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

export function isoOfMs(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export const addDays = (iso, n) => isoOfMs(dateMs(iso) + n * DAY_MS);
export const diffDays = (a, b) => Math.round((dateMs(b) - dateMs(a)) / DAY_MS);
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Add months, clamping the day to the end of the target month (31 Jan + 1 = 28/29 Feb). */
export function addMonths(iso, n) {
  const d = new Date(dateMs(iso));
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  return `${String(y).padStart(4, "0")}-${p2(m + 1)}-${p2(Math.min(d.getUTCDate(), daysInMonth(y, m + 1)))}`;
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function weekdayOf(iso) {
  const w = new Date(dateMs(iso)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** First day of the week that contains `iso` (`firstWeekday`: 1 = Monday ... 7 = Sunday). */
export function startOfWeek(iso, firstWeekday = 1) {
  const back = (weekdayOf(iso) - firstWeekday + 7) % 7;
  return addDays(iso, -back);
}

/** Today's date in a zone (an unknown zone falls back to UTC). */
export function todayIn(tz, now = Date.now()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  } catch {
    return isoOfMs(now);
  }
  const v = {};
  for (const p of parts) v[p.type] = p.value;
  return `${v.year.padStart(4, "0")}-${v.month}-${v.day}`;
}

/**
 * The days a view shows around `date`:
 *   month   full weeks (4 to 6 rows) that cover the month; `inMonth(iso)` says which days belong to it
 *   week    7 days from the start of the week; on a phone 3 days starting AT `date`
 *   day     the day
 *   agenda  30 days starting at `date`
 * Returns {view, date, start, end (exclusive), days, dayCount, month ('YYYY-MM' | null)}.
 */
export function periodRange(view, date, { firstWeekday = 1, phone = false } = {}) {
  if (!VIEWS.includes(view)) throw new RangeError(`unknown view ${view}`);
  dateMs(date);
  let start;
  let count;
  let month = null;
  if (view === "month") {
    const first = `${date.slice(0, 7)}-01`;
    start = startOfWeek(first, firstWeekday);
    const y = +date.slice(0, 4);
    const m = +date.slice(5, 7);
    count = Math.ceil((diffDays(start, first) + daysInMonth(y, m)) / 7) * 7;
    month = date.slice(0, 7);
  } else if (view === "week") {
    if (phone) {
      start = date;
      count = PHONE_WEEK_DAYS;
    } else {
      start = startOfWeek(date, firstWeekday);
      count = 7;
    }
  } else if (view === "day") {
    start = date;
    count = 1;
  } else {
    start = date;
    count = AGENDA_DAYS;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(start, i));
  return { view, date, start, end: addDays(start, count), days, dayCount: count, month };
}

/** Is `iso` inside the month a month range was built for? */
export const inMonth = (range, iso) => range.month !== null && iso.startsWith(range.month);

/** The anchor date after "previous" (dir -1) or "next" (+1). */
export function shiftDate(view, date, dir, { phone = false } = {}) {
  const s = dir < 0 ? -1 : 1;
  if (view === "month") return addMonths(date, s);
  if (view === "week") return addDays(date, s * (phone ? PHONE_WEEK_DAYS : 7));
  if (view === "day") return addDays(date, s);
  return addDays(date, s * AGENDA_DAYS);
}

/**
 * Instants [from, to) of a range in the display zone, widened by `pad` (default one day) on both
 * sides because all-day and floating values are compared by their wall clock as if it were UTC.
 */
export function instantWindow(range, tz, { pad = DAY_MS } = {}) {
  return {
    from: instantInZone(dateMs(range.start), tz) - pad,
    to: instantInZone(dateMs(range.end), tz) + pad,
  };
}

/** Does a range contain this date? */
export const rangeHas = (range, iso) => iso >= range.start && iso < range.end;
