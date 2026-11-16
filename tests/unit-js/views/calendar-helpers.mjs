// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the calendar screen tests (RUN3 WP B3a): the fake DOM, a REAL write path and item stores over
// the in-memory multi-calendar DAV server of the store tests, the calendars manager, a screen context shaped like
// the shell's, and small query helpers. No tests in here. All data is fictional (example.org, Europe/Paris,
// America/New_York, Asia/Kathmandu).
import { createI18n } from '../_i18n-all.mjs';
import { createReadiness, writeGate } from '../../../src/js/ui.js';
import { createCalendars } from '../../../src/js/store/calendars.js';
import { exportItem } from '../../../src/js/store/export.js';
import { createPrefs } from '../../../src/js/views/settings/prefs.js';
import { El, makeDom, fakeTimers, one } from '../widgets/_dom.mjs';
import { CAL_A, CAL_B, CAL_RO, makeCalEnv, model, override, single, unknownZone, weekly } from '../store/_cal.mjs';
import { fakeStorage } from '../store/_helpers.mjs';

export { CAL_A, CAL_B, CAL_RO, model, one, override, single, unknownZone, weekly };

// the fake DOM of the widget tests has no insertBefore / replaceChildren: add them (test-only)
if (!El.prototype.insertBefore) {
  El.prototype.insertBefore = function insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  };
}
if (!El.prototype.replaceChildren) {
  El.prototype.replaceChildren = function replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  };
}

export const doc = makeDom();
export const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
export const NOW = Date.parse('2026-06-03T10:00:00Z'); // a Wednesday
export const DISPLAY_TZ = 'Europe/Paris';

const wrap = (body) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example Corp//Calendar 1.0//EN\n${body}END:VCALENDAR\n`;

/** A flight: starts in Paris, ends in New York (two TZIDs, no VTIMEZONE: Intl knows both). */
export const flight = (uid, summary = 'Flight to New York') =>
  wrap(`BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=Europe/Paris:20260605T110000\nDTEND;TZID=America/New_York:20260605T133000\nSUMMARY:${summary}\nEND:VEVENT\n`);

/** A three-day all-day event, from 2026-06-02 to 2026-06-04 inclusive. */
export const allDay3 = (uid, summary = 'Conference') =>
  wrap(`BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART;VALUE=DATE:20260602\nDTEND;VALUE=DATE:20260605\nSUMMARY:${summary}\nEND:VEVENT\n`);

/** A floating event. */
export const floating = (uid, summary = 'Morning run') =>
  wrap(`BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART:20260606T070000\nDTEND:20260606T080000\nSUMMARY:${summary}\nEND:VEVENT\n`);

/** An event whose texts try to be markup. */
export const hostile = (uid) =>
  wrap(`BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=Europe/Paris:20260604T150000\nDTEND;TZID=Europe/Paris:20260604T160000\nSUMMARY:<img src=x onerror=alert(1)>\nLOCATION:<b>Room</b>\nURL:javascript:alert(1)\nDESCRIPTION:<script>x</script>\\nsecond line\nATTENDEE;CN=Pat Example;PARTSTAT=ACCEPTED:mailto:pat@example.org\nEND:VEVENT\n`);

export const BASE_ITEMS = () => ({
  [`${CAL_A}weekly.ics`]: weekly('weekly@example.org', { count: 40, overrides: override('weekly@example.org', '20260601T093000', { start: '20260601T143000', summary: 'Weekly sync (moved)' }) }),
  [`${CAL_A}lunch.ics`]: single('lunch@example.org', 'Lunch'),
  [`${CAL_A}flight.ics`]: flight('flight@example.org'),
  [`${CAL_A}conf.ics`]: allDay3('conf@example.org'),
  [`${CAL_A}run.ics`]: floating('run@example.org'),
  [`${CAL_A}mars.ics`]: unknownZone('mars@example.org'),
  [`${CAL_B}other.ics`]: single('other@example.org', 'Other calendar event', { start: '20260604T090000', end: '20260604T100000' }),
  [`${CAL_RO}shared.ics`]: single('shared@example.org', 'Shared lunch', { start: '20260605T120000', end: '20260605T130000' }),
});

/** Everything a calendar screen needs. */
export async function setup({ items = BASE_ITEMS(), lang = 'en', tz = DISPLAY_TZ, hidden = [], online = true, phone = false, prefsValues = {}, now = NOW, discover = null } = {}) {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
  writeGate.setReason('offline', null);
  writeGate.setReason('readonly', null);
  const env = await makeCalEnv({ items, load: false });
  if (discover) env.access.refetch = discover;
  const i18n = createI18n({ lang });
  const t = (k, p) => i18n.t(k, p);
  const tp = (k, n, p) => i18n.tp(k, n, p);
  env.reporter.setTranslator(t);
  const calendars = createCalendars({ stores: env.stores, scheduler: env.scheduler, session: env.session, model });
  const storeCtx = {
    session: env.session,
    reporter: env.reporter,
    access: env.access,
    stores: env.stores,
    scheduler: env.scheduler,
    writes: env.writes,
    calendars,
    setTranslator: (fn) => env.reporter.setTranslator(fn),
    exportItem: (opts) => exportItem({ reporter: env.reporter, ...opts }),
  };
  const prefsStorage = fakeStorage();
  const prefs = createPrefs({ storage: prefsStorage, login: 'alice' });
  if (hidden.length) prefs.set('cal.hidden', hidden);
  for (const [k, v] of Object.entries(prefsValues)) prefs.set(k, v);
  const timers = fakeTimers();
  const navs = [];
  const downloads = [];
  const main = doc.createElement('main');
  doc.body.append(main);
  const app = {
    lang,
    session: env.session,
    getStore: async () => storeCtx,
    readiness: createReadiness(() => {}),
    feedback: env.feedback,
    gate: writeGate,
    openItem: (text, kind) => model.openItem(text, kind),
    navigate: (hash, opts) => navs.push({ hash, opts }),
    setDirty: () => {},
    prefs: () => prefs,
    timeZone: tz,
    firstWeekday: 1,
  };
  const win = { matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }), navigator: { onLine: online } };
  const deps = {
    doc,
    win,
    now: () => now,
    storage: fakeStorage(),
    timers,
    debounceMs: 10,
    isOnline: () => online,
    actionDeps: { downloadText: (o) => (downloads.push(o), { ok: true, filename: o.filename, bytes: o.text.length }), loadScopeDialog: async () => ({}) },
  };
  const ctx = (params = {}, route = { name: 'calendar-view' }, extra = {}) => ({ root: main, t, tp, params, route, host: 'example.org', restore: null, signal: new AbortController().signal, app, ...extra });
  return { env, storeCtx, calendars, ctx, deps, navs, downloads, timers, t, tp, main, app, prefs, i18n };
}

export const WEEK = { view: 'week', date: '2026-06-03' };
export const all = (root, id) => root.querySelectorAll(`[data-testid="${id}"]`);
export const text = (root, id) => {
  const el = one(root, id);
  return el ? el.textContent : null;
};
export const keysOf = (root, id = 'event-chip') => [...new Set(all(root, id).map((n) => n.getAttribute('data-key')))];
export const offCount = (root) => root.all((e) => e.classList.contains('is-off')).length;
