// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers shared by the calendar screens (RUN3 WP B3a). No DOM: preferences, hashes, the record of one
// occurrence (what the views draw), accessible names and date/time text. Everything is drawn in the display
// zone `tz`; all-day and floating values are never shifted (calendar/layout.js decides).
//
// Preferences (per login, through `app.prefs()`; WP B3b's Settings section writes the same names):
//   cal.firstWeekday   1 (Monday) .. 7 (Sunday) | null (config / locale)
//   cal.use24h         true | false | null (locale)
//   cal.birthdays      show the Birthdays calendar (default true)
//   cal.hideDupBirthdays   hide birthdays already present as a yearly all-day event (default true)
//   cal.hidden         hrefs of the calendars the user switched off (default none)
//   cal.listState      'open' | 'rail' | 'hidden' (desktop list column; default 'open')

import { buildHash, hashFor } from '../../router.js';
import { getText } from '../../model/contentlines.js';
import { dateMs, isValidDate } from '../../calendar/grid.js';
import { displayTimes } from '../../calendar/layout.js';
import { occParamOf } from '../../calendar/scope.js';

export const PREF = Object.freeze({
  firstWeekday: 'cal.firstWeekday',
  use24h: 'cal.use24h',
  birthdays: 'cal.birthdays',
  hideDup: 'cal.hideDupBirthdays',
  hidden: 'cal.hidden',
  listState: 'cal.listState',
});
export const BIRTHDAYS_HREF = 'birthdays';
export const LIST_STATES = Object.freeze(['open', 'rail', 'hidden']);
/** Whitelist for every calendar colour that reaches the DOM through `vars`. */
export const COLOUR_ALLOW = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
export const NUMBER_ALLOW = /^-?\d{1,5}(?:\.\d{1,3})?$/;
export const PHONE_QUERY = '(max-width: 899px)';
export const FALLBACK_COLOUR = '#0072b2';

const norm = (href) => (String(href).endsWith('/') ? String(href) : `${href}/`);
export const sameHref = (a, b) => norm(a) === norm(b);

/** Resolved calendar preferences. `config` = {firstWeekday} from the shell (config or locale). */
export function readCalPrefs(prefs, { firstWeekday = 1 } = {}) {
  const get = (name, fallback) => (prefs ? prefs.get(name, fallback) : fallback);
  const fw = get(PREF.firstWeekday, null);
  const h24 = get(PREF.use24h, null);
  const hidden = get(PREF.hidden, []);
  const state = get(PREF.listState, 'open');
  return {
    firstWeekday: Number.isInteger(fw) && fw >= 1 && fw <= 7 ? fw : Number.isInteger(firstWeekday) && firstWeekday >= 1 && firstWeekday <= 7 ? firstWeekday : 1,
    use24h: typeof h24 === 'boolean' ? h24 : null,
    birthdays: get(PREF.birthdays, true) !== false,
    hideDup: get(PREF.hideDup, true) !== false,
    hidden: new Set(Array.isArray(hidden) ? hidden.filter((x) => typeof x === 'string').map((x) => (x === BIRTHDAYS_HREF ? x : norm(x))) : []),
    listState: LIST_STATES.includes(state) ? state : 'open',
  };
}

export const isPhone = (win) => {
  try {
    return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia(PHONE_QUERY).matches);
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ hashes

const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
export const calendarHash = (view, date, query) => hashFor('/calendar/:view/:date', { view, date }, clean(query));
export const eventHash = (key, query) => hashFor('/events/:key', { key }, clean(query));
export const newEventHash = (query) => buildHash('/events/new', clean(query));
export const contactHash = (key, ab) => hashFor('/contacts/:key', { key }, clean({ ab }));
export const cleanQuery = clean;

export const VIEWS = Object.freeze(['month', 'week', 'day', 'agenda']);
/** `{view, date}` of a route, or null when either is invalid (the screen then redirects to today). */
export function parseView(params) {
  const view = params && params.view;
  const date = params && params.date;
  return VIEWS.includes(view) && isValidDate(date) ? { view, date } : null;
}

// ------------------------------------------------------------------ text

const fmtCache = new Map();
function fmt(lang, opts) {
  const k = `${lang}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(lang, { timeZone: 'UTC', ...opts });
    } catch {
      f = new Intl.DateTimeFormat('en', { timeZone: 'UTC', ...opts });
    }
    fmtCache.set(k, f);
  }
  return f;
}
const cycle = (use24h) => (use24h === true ? { hourCycle: 'h23' } : use24h === false ? { hourCycle: 'h12' } : {});

/** "09:30" of a wall clock (ms as if UTC). */
export const timeText = (wallMs, { lang = 'en', use24h = null } = {}) => fmt(lang, { hour: '2-digit', minute: '2-digit', ...cycle(use24h) }).format(wallMs);
/** "Tue 18 Nov" of a wall clock or a date. */
export const dayText = (wallMs, { lang = 'en' } = {}) => fmt(lang, { weekday: 'short', day: 'numeric', month: 'short' }).format(wallMs);
export const longDayText = (wallMs, { lang = 'en' } = {}) => fmt(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(wallMs);
export const dateText = (iso, opts, lang = 'en') => fmt(lang, opts).format(dateMs(iso));
export const dayOf = (iso) => Number(iso.slice(8, 10));

/** The loud period heading as {main, sub} text. */
export function periodText(view, range, { lang = 'en' } = {}) {
  if (view === 'day') return { main: dateText(range.start, { weekday: 'long' }, lang), sub: dateText(range.start, { day: 'numeric', month: 'long', year: 'numeric' }, lang) };
  if (view === 'month') return { main: dateText(range.date, { month: 'long' }, lang), sub: dateText(range.date, { year: 'numeric' }, lang) };
  const last = range.days[range.days.length - 1];
  const sameMonth = range.start.slice(0, 7) === last.slice(0, 7);
  const main = sameMonth ? `${dayOf(range.start)}–${dayOf(last)} ${dateText(range.start, { month: 'long' }, lang)}` : `${dateText(range.start, { day: 'numeric', month: 'short' }, lang)} – ${dateText(last, { day: 'numeric', month: 'short' }, lang)}`;
  return { main, sub: dateText(last, { year: 'numeric' }, lang) };
}

/** "Week of 16 Nov 2026" style label used by the status line. */
export function periodLabel(view, range, { t, lang = 'en' } = {}) {
  const long = (iso) => dateText(iso, { day: 'numeric', month: 'short', year: 'numeric' }, lang);
  if (view === 'month') return dateText(range.date, { month: 'long', year: 'numeric' }, lang);
  if (view === 'day') return dateText(range.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, lang);
  if (view === 'agenda') return t('cal.period.agenda', { from: long(range.start), to: long(range.days[range.days.length - 1]) });
  return t('cal.period.week', { date: long(range.start) });
}

// ------------------------------------------------------------------ occurrence records

/**
 * The description of one occurrence that the views draw. `cx` = {t, lang, tz, use24h, calendars: Map(href -> {name, color}),
 * keyOf(href) -> route key | null}. `occ` is an occurrence of calendars.occurrences() or of birthdayOccurrences().
 * The record keeps the fields layout.js needs (start, end, allDay, href, uid) next to the display data.
 */
export function describeOccurrence(occ, cx) {
  const virtual = Boolean(occ.virtual);
  const href = virtual ? BIRTHDAYS_HREF : norm(occ.collection || occ.href.replace(/[^/]*$/, ''));
  const cal = cx.calendars.get(href) || { name: href, color: FALLBACK_COLOUR };
  const comp = occ.component || null;
  const summary = virtual ? occ.title || '' : comp ? getText(comp, 'SUMMARY') || '' : '';
  const status = comp && comp.prop('STATUS') ? comp.prop('STATUS').value.trim().toUpperCase() : null;
  const location = comp ? getText(comp, 'LOCATION') || '' : '';
  const recurring = !virtual && occ.source !== 'single';
  const ridIso = virtual ? occ.date : (occ.recurrenceId || occ.start).iso;
  const times = displayTimes(occ, cx.tz);
  const key = virtual ? occ.id : `${occ.href}#${ridIso}`;
  const rec = {
    id: key,
    key,
    occ,
    start: occ.start,
    end: occ.end,
    allDay: times.allDay,
    href: occ.href || null,
    uid: occ.uid || null,
    collection: href,
    calendar: href,
    calendarName: cal.name,
    color: cal.color,
    virtual,
    readOnly: virtual || Boolean(cx.readOnly && cx.readOnly(href)),
    title: summary || (virtual ? '' : cx.t('cal.untitled')),
    untitled: !summary && !virtual,
    status: status === 'TENTATIVE' || status === 'CANCELLED' ? status : null,
    location,
    recurring,
    unknownZone: times.unknownZone,
    floating: times.floating,
    age: virtual ? occ.age : null,
    occParam: virtual ? occ.date : recurring ? occParamOf(occ) : 'single',
    routeKey: virtual ? occ.key : cx.keyOf(occ.href),
    ab: virtual ? occ.ab : null,
    times,
  };
  if (virtual && occ.age !== null && occ.age !== undefined) rec.title = cx.t('cal.bday.withAge', { name: summary, age: occ.age });
  rec.when = whenText(rec, cx);
  rec.name = accessibleName(rec, cx);
  rec.sort = times.startWall;
  return rec;
}

/** "Tue 18 Nov 09:00–09:30" | "Tue 18 Nov, all day" | "Tue 18 Nov 22:00 – Wed 19 Nov 01:00". */
export function whenText(rec, { t, lang = 'en', use24h = null }) {
  const { startWall, endWall, allDay } = rec.times;
  if (allDay) {
    const last = endWall - 86400000;
    if (last > startWall) return t('cal.when.allDayRange', { from: dayText(startWall, { lang }), to: dayText(last, { lang }) });
    return t('cal.when.allDay', { day: dayText(startWall, { lang }) });
  }
  const s = timeText(startWall, { lang, use24h });
  const e = timeText(endWall, { lang, use24h });
  const sameDay = Math.floor(startWall / 86400000) === Math.floor(endWall / 86400000);
  if (endWall === startWall) return `${dayText(startWall, { lang })} ${s}`;
  if (sameDay) return `${dayText(startWall, { lang })} ${s}–${e}`;
  return `${dayText(startWall, { lang })} ${s} – ${dayText(endWall, { lang })} ${e}`;
}

/** The accessible name: "Title, Tue 18 Nov 09:30–10:30, Work" plus status, repeat and zone notes. */
export function accessibleName(rec, { t }) {
  const parts = [rec.title, rec.when, rec.calendarName];
  if (rec.status) parts.push(t(`cal.status.${rec.status}`));
  if (rec.recurring) parts.push(t('cal.repeats'));
  if (rec.virtual) parts.push(t('cal.readOnly'));
  if (rec.unknownZone) parts.push(t('cal.zoneUnknown'));
  return parts.join(', ');
}

/** The route of an event detail page. */
export function detailHashOf(rec) {
  return eventHash(rec.routeKey || '', { cal: rec.calendar, occ: rec.occParam });
}

/** Query parameters that open the detail panel inside a calendar hash (desktop). */
export const panelQuery = (rec) => ({ ev: rec.routeKey || '', cal: rec.calendar, occ: rec.occParam });

/** The data attributes every event node carries (SPECS 5, D-R3-4). */
export function nodeAttrs(rec) {
  return {
    'data-uid': rec.uid || rec.routeKey || '',
    'data-href': rec.href || '',
    'data-calendar': rec.calendar,
    'data-occurrence': rec.occParam,
    'data-key': rec.key,
    'data-readonly': rec.readOnly || rec.unknownZone ? 'true' : 'false',
  };
}
