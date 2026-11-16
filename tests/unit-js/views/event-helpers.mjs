// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the event form tests (WP B3b): the fake DOM, a REAL write path over the fake calendar server of the
// store tests (several calendars, one item map), a calendar manager, and a screen context shaped like the shell's.
// No tests in here.
import { readFileSync } from 'node:fs';
import { createI18n } from '../_i18n-all.mjs';
import { createReadiness, writeGate } from '../../../src/js/ui.js';
import { createCalendars } from '../../../src/js/store/calendars.js';
import { makeDom, fakeTimers, one } from '../widgets/_dom.mjs';
import { CAL_A, CAL_B, CAL_RO, baseOf, makeCalEnv, model } from '../store/_cal.mjs';

export { CAL_A, CAL_B, CAL_RO, baseOf, one, model };
export const doc = makeDom();
export const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
export const fx = (name) => readFileSync(new URL(`../../fixtures/ics/${name}`, import.meta.url), 'utf8');
export const q = (root, id) => root.querySelector(`[data-testid="${id}"]`);
export const qa = (root, id) => root.querySelectorAll(`[data-testid="${id}"]`);
export const dlg = (id) => q(doc.body, id);

/** Everything a form needs: a store context over the fake server, a shell-like ctx builder and spies. */
export async function setup({ items = {}, lang = 'en', prefs = null, online = true } = {}) {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
  writeGate.setReason('offline', null);
  writeGate.setReason('readonly', null);
  const env = await makeCalEnv({ items, load: false });
  const i18n = createI18n({ lang });
  const t = (k, p) => i18n.t(k, p);
  const tp = (k, n, p) => i18n.tp(k, n, p);
  env.reporter.setTranslator(t);
  const calendars = createCalendars({ stores: env.stores, scheduler: env.scheduler, session: env.session, model });
  const storeCtx = { session: env.session, reporter: env.reporter, access: env.access, stores: env.stores, scheduler: env.scheduler, writes: env.writes, calendars, setTranslator: (fn) => env.reporter.setTranslator(fn) };
  const timers = fakeTimers();
  const navs = [];
  const dirty = [];
  const main = doc.createElement('main');
  doc.body.append(main);
  const store = new Map();
  const prefStore = prefs || { get: (name, fallback) => (store.has(name) ? store.get(name) : fallback), set: (n, v) => store.set(n, v), remove: (n) => store.delete(n), subscribe: () => () => {} };
  const app = {
    lang,
    session: env.session,
    getStore: async () => storeCtx,
    readiness: createReadiness(() => {}),
    feedback: env.feedback,
    gate: writeGate,
    openItem: (text, kind) => model.openItem(text, kind),
    navigate: (hash, opts) => navs.push({ hash, opts }),
    setDirty: (v) => dirty.push(Boolean(v)),
    prefs: () => prefStore,
    firstWeekday: 1,
    timeZone: 'Europe/Paris',
  };
  const deps = { doc, win: {}, timers, isOnline: () => online, now: () => new Date(Date.UTC(2026, 5, 15, 8, 0, 0)), storage: memoryStorage() };
  const ctx = (params = {}, route = { name: 'event-edit' }, extra = {}) => ({ root: main, t, tp, params, route, host: 'example.org', restore: null, signal: new AbortController().signal, app, ...extra });
  return { env, storeCtx, ctx, deps, navs, dirty, timers, t, tp, main, app, i18n, prefs: prefStore, calendars };
}

export function memoryStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null };
}
