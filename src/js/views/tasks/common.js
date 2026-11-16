// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers shared by the task screens (RUN3 WP C1). No DOM: preferences, hashes, the text of a due date, accessible names.
//
// Preferences (per login, through `app.prefs()`):
//   tasks.hidden     hrefs of the task lists the user switched off (default none)
//   cal.use24h       true | false | null (locale): the clock of the calendar settings, shared with the calendar
//   cal.firstWeekday 1 (Monday) .. 7 (Sunday) | null: first day of the week in the date picker

import { buildHash, hashFor } from '../../router.js';
import { isolate } from '../../widgets/avatar.js';

export const PREF = Object.freeze({ hidden: 'tasks.hidden' });
export const SHARED_PREF = Object.freeze({ use24h: 'cal.use24h', firstWeekday: 'cal.firstWeekday' });
/** Whitelist for every list colour that reaches the DOM through `vars`. */
export const COLOUR_ALLOW = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
export const FALLBACK_COLOUR = '#0072b2';

const norm = (href) => (String(href).endsWith('/') ? String(href) : `${href}/`);
export const sameHref = (a, b) => norm(a) === norm(b);
export const normHref = norm;
export { isolate };

export function readTaskPrefs(prefs, { firstWeekday = 1 } = {}) {
  const get = (name, fallback) => (prefs ? prefs.get(name, fallback) : fallback);
  const hidden = get(PREF.hidden, []);
  const fw = get(SHARED_PREF.firstWeekday, null);
  const h24 = get(SHARED_PREF.use24h, null);
  return {
    hidden: new Set(Array.isArray(hidden) ? hidden.filter((x) => typeof x === 'string').map(norm) : []),
    firstWeekday: Number.isInteger(fw) && fw >= 1 && fw <= 7 ? fw : Number.isInteger(firstWeekday) && firstWeekday >= 1 && firstWeekday <= 7 ? firstWeekday : 1,
    use24h: typeof h24 === 'boolean' ? h24 : null,
  };
}

// ------------------------------------------------------------------ hashes

export const cleanQuery = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
export const tasksHash = ({ filter, sort } = {}) => buildHash('/tasks', cleanQuery({ filter, sort }));
export const taskHash = (key, query) => hashFor('/tasks/:key', { key }, cleanQuery(query));
export const taskEditHash = (key, query) => hashFor('/tasks/:key/edit', { key }, cleanQuery(query));
export const newTaskHash = (query) => buildHash('/tasks/new', cleanQuery(query));
export const newTaskListHash = () => buildHash('/collections/new-calendar', { components: 'VTODO' });

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
const dayMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** "Tue 15 Sep" of an ISO date; the year is added when it is not `refYear`. */
export function dayText(iso, { lang = 'en', refYear = null } = {}) {
  const withYear = refYear !== null && Number(iso.slice(0, 4)) !== refYear;
  return fmt(lang, { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(dayMs(iso));
}
/** "17:00" of a wall clock (ms as if UTC). */
export const timeText = (wallMs, { lang = 'en', use24h = null } = {}) => fmt(lang, { hour: '2-digit', minute: '2-digit', ...cycle(use24h) }).format(wallMs);

/**
 * The due text of a record: `{text, overdue, today, none}`; "Overdue since Mon 14 Sep", "Due today 17:00",
 * "Due Tue 15 Sep". All-day and floating values are shown as they are; others in the display zone (`rec.due.wall`).
 */
export function dueText(rec, { t, lang = 'en', use24h = null, today = '' }) {
  const d = rec.due;
  if (!d) return { text: '', overdue: false, today: false, none: true };
  const refYear = today ? Number(today.slice(0, 4)) : null;
  const day = dayText(d.day, { lang, refYear });
  const time = d.allDay ? '' : timeText(d.wall, { lang, use24h });
  const full = time ? `${day} ${time}` : day;
  if (rec.overdue) return { text: t('tasks.overdueSince', { date: full }), overdue: true, today: false, none: false };
  if (rec.today) return { text: time ? t('tasks.dueTodayAt', { time }) : t('tasks.dueToday'), overdue: false, today: true, none: false };
  return { text: t('tasks.dueOn', { date: full }), overdue: false, today: false, none: false };
}

/** "Due Tue 15 Sep 17:00 (Europe/Paris)" style line for the detail: the date, the time and the zone of the value itself. */
export function whenLine(spec, { lang = 'en', use24h = null }) {
  if (!spec) return '';
  const day = dayText(spec.iso.slice(0, 10), { lang });
  if (spec.kind === 'date') return day;
  const time = timeText(dayMs(spec.iso.slice(0, 10)) + (+spec.iso.slice(11, 13) * 60 + +spec.iso.slice(14, 16)) * 60000, { lang, use24h });
  const zone = spec.kind === 'utc' ? 'UTC' : spec.kind === 'zoned' ? spec.tzid : '';
  return zone ? `${day} ${time} ${zone}` : `${day} ${time}`;
}

/** The accessible name of a row: "Title, Overdue since Mon 14 Sep, High priority, In progress, Work". */
export function accessibleName(rec, { t, due, listName }) {
  const parts = [rec.summary || t('tasks.untitled')];
  if (due && due.text) parts.push(due.text);
  if (rec.prio !== 'none') parts.push(t(`tasks.prio.${rec.prio}`));
  if (rec.status === 'IN-PROCESS') parts.push(rec.percent !== null && rec.percent !== undefined ? t('tasks.inProgressPct', { n: rec.percent }) : t('tasks.state.IN-PROCESS'));
  if (rec.status === 'COMPLETED') parts.push(t('tasks.state.COMPLETED'));
  if (rec.status === 'CANCELLED') parts.push(t('tasks.state.CANCELLED'));
  if (rec.recurring) parts.push(t('tasks.repeats'));
  if (listName) parts.push(listName);
  return parts.join(', ');
}

/** The data attributes every task node carries (SPECS 5, D-R3-4). */
export function nodeAttrs(rec, { listName = '' } = {}) {
  return {
    'data-uid': rec.uid || rec.routeKey || '',
    'data-href': rec.href || '',
    'data-list': rec.collection,
    'data-status': rec.status || 'NEEDS-ACTION',
    'data-readonly': rec.readOnly || rec.listReadOnly ? 'true' : 'false',
    'data-key': rec.routeKey || '',
    ...(listName ? { 'data-list-name': listName } : {}),
  };
}

/** 24-hour clock? The preference wins, else what the language uses. */
export function resolveUse24h(pref, lang) {
  if (typeof pref === 'boolean') return pref;
  try {
    const cycle = new Intl.DateTimeFormat(lang, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle !== 'h11' && cycle !== 'h12';
  } catch {
    return true;
  }
}

function safeStorage(win) {
  try {
    return win && win.localStorage ? win.localStorage : null;
  } catch {
    return null;
  }
}

/** The browser objects the screens use; a test passes its own through `mount(ctx, deps)`. */
export function resolveDeps(deps = {}) {
  const win = deps.win || globalThis.window;
  const doc = deps.doc || globalThis.document;
  return {
    win,
    doc,
    now: () => Date.now(),
    storage: safeStorage(win),
    isOnline: () => !win || !win.navigator || win.navigator.onLine !== false,
    actionDeps: {},
    ...deps,
  };
}
