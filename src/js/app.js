// SPDX-License-Identifier: AGPL-3.0-or-later
// Application shell: loads config.json, wires the services (credential store,
// account-service client, DAV client), the session container, the hash router and
// the screens, and keeps the persistent chrome (header, navigation, banners, live
// regions, Activity panel, readiness attributes) up to date.
//
// Root element contract (SPECS 5.6): #app carries data-state="loading|ready|error"
// and aria-busy while requests are in flight, and data-route="<route name>".
//
// Not imported here at login time (m13): the data model and ical.js. Screens that
// need them are flagged `model: true` in js/screens.js; the shell loads them first.

import { loadConfig, loadBuildInfo, resolveBases } from './config.js';
import { createI18n, createDictionaryLoader, createLanguageSwitcher, pickLanguage, resolveTimeZone, resolveFirstWeekday, formatTime, DEFAULT_LANGUAGE } from './i18n.js';
import { createAuthStore, browserStorages, STORAGE_KEY } from './auth.js';
import { createApi } from './api.js';
import { createTransport } from './dav/http.js';
import { createClient } from './dav/client.js';
import { discoverAccessible } from './dav/discovery.js';
import { buildHash, createRouter, safeNext, ROUTES, LANDING_HASH } from './router.js';
import { familyOf, loadScreen } from './screens.js';
import { createSessionHolder } from './session.js';
import { createPrefs } from './views/settings/prefs.js';
import {
  PREF_LANG,
  PREF_THEME,
  applyTheme,
  createActivityLog,
  createFeedback,
  createLeaveGuard,
  createReadiness,
  fill,
  h,
  mountActivity,
  mountFeedback,
  openDialog,
  closeAllDialogs,
  disableWhileBusy,
  readTheme,
  safeGet,
  safeSet,
  writeGate,
} from './ui.js';
import { renderLogin } from './login.js';
import { initPwa } from './pwa.js';

/** Shown when no dictionary could be loaded at all (both languages, the page cannot translate itself). */
export const FATAL_TEXT = "The application could not start. Reload the page. / L'application n'a pas pu démarrer. Rechargez la page.";

export function renderNotFound({ root, t }) {
  root.append(
    h(
      'section',
      { class: 'notfound', testid: 'notfound-screen', 'aria-labelledby': 'notfound-title' },
      h('h1', { class: 'page-title', id: 'notfound-title', tabindex: '-1' }, t('notfound.title')),
      h('p', null, t('notfound.text')),
      h('a', { class: 'btn', href: '#/', testid: 'notfound-home' }, t('notfound.home')),
    ),
  );
  return { title: t('notfound.title') };
}

/** Localized name of weekday `n` (1 = Monday ... 7 = Sunday), drawn from a fixed reference week (2024-01-01 was a Monday). */
export function weekdayName(lang, n) {
  const day = Number.isInteger(n) && n >= 1 && n <= 7 ? n : 1;
  try {
    return new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, day)));
  } catch {
    return String(day);
  }
}

// ------------------------------------------------------------------ navigation

/**
 * The slices of Run 3 whose navigation entries are switched on. A slice's LAST work package adds its
 * name here (one line); until then its routes stay on the coming-soon page and its entries stay hidden.
 *   base      contacts, collections, diagnostics (always)
 *   3a        settings
 *   3a-users  the Users section (admins only); switched on with the `users` E2E suite
 *   3b        calendar (switched on after the `calendar` E2E suite passed)
 *   3c        tasks and the .ics import (switched on after the `tasks` and `import-export` E2E suites passed)
 */
export const ENABLED_SLICES = Object.freeze(['base', '3a', '3a-users', '3b', '3c']);

/**
 * Navigation entries, in desktop rail order. `family` is the screen family that makes the entry current;
 * `slice` gates it through ENABLED_SLICES; `admin` entries are offered to administrators only (the pages
 * themselves never rely on this: a non-admin who opens `#/users` gets `access-required`, and the backend
 * refuses anyway); `rail` entries are drawn in the desktop rail only (phones: bottom tabs Calendar, Tasks,
 * Contacts, Collections; Users and Settings live in the top bar there, see TOPBAR_ITEMS).
 */
export const NAV_ITEMS = Object.freeze([
  Object.freeze({ id: 'nav-calendar', hash: '#/calendar', family: 'calendar', key: 'nav.calendar', slice: '3b' }),
  Object.freeze({ id: 'nav-tasks', hash: '#/tasks', family: 'tasks', key: 'nav.tasks', slice: '3c' }),
  Object.freeze({ id: 'nav-contacts', hash: '#/contacts', family: 'contacts', key: 'nav.contacts', slice: 'base' }),
  Object.freeze({ id: 'nav-collections', hash: '#/collections', family: 'collections', key: 'nav.collections', slice: 'base' }),
  Object.freeze({ id: 'nav-users', hash: '#/users', family: 'users', key: 'nav.users', slice: '3a-users', admin: true, rail: true }),
  Object.freeze({ id: 'nav-settings', hash: '#/settings', family: 'settings', key: 'nav.settings', slice: '3a', rail: true }),
  Object.freeze({ id: 'nav-debug', hash: '#/debug', family: 'debug', key: 'nav.debug', slice: 'base', rail: true }),
]);

/** Phone top-bar shortcuts (hidden from 900 px, where the rail has the same entries). */
export const TOPBAR_ITEMS = Object.freeze([
  Object.freeze({ id: 'topbar-users', hash: '#/users', family: 'users', key: 'nav.users', slice: '3a-users', admin: true }),
  Object.freeze({ id: 'topbar-settings', hash: '#/settings', family: 'settings', key: 'nav.settings', slice: '3a' }),
]);

/** Is an entry offered to this user? */
export function navVisible(item, { admin = false, slices = ENABLED_SLICES } = {}) {
  return slices.includes(item.slice) && (!item.admin || admin === true);
}

/** The id of the navigation entry that is current for a resolved route, or null (login, coming soon, not found, hidden entry). */
export function navCurrent(route, opts = {}) {
  if (!route || !route.screen) return null;
  const family = familyOf(route.screen);
  const item = NAV_ITEMS.find((n) => n.family === family);
  return item && navVisible(item, opts) ? item.id : null;
}

function setHidden(el, hidden) {
  el.hidden = hidden;
  const li = el.parentElement;
  if (li && li.tagName === 'LI') li.hidden = hidden; // an empty list item would still take a column of the tab bar
}

/**
 * Show or hide the navigation and mark the current entry (`aria-current="page"`).
 * @param {(id: string) => HTMLElement|null} getEl
 * @param {object} route
 * @param {boolean} signedIn
 * @param {{admin?: boolean, slices?: readonly string[]}} [opts]
 */
export function applyNav(getEl, route, signedIn, opts = {}) {
  const nav = getEl('main-nav');
  if (nav) nav.hidden = !signedIn;
  const signOut = getEl('btn-sign-out');
  if (signOut) signOut.hidden = !signedIn;
  const current = signedIn ? navCurrent(route, opts) : null;
  for (const item of NAV_ITEMS) {
    const el = getEl(item.id);
    if (!el) continue;
    setHidden(el, !(signedIn && navVisible(item, opts)));
    if (item.id === current) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  for (const item of TOPBAR_ITEMS) {
    const el = getEl(item.id);
    if (!el) continue;
    el.hidden = !(signedIn && navVisible(item, opts));
    if (!el.hidden && route && route.screen && familyOf(route.screen) === item.family) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  return current;
}

const STORE_KEY = 'radui.store';

/**
 * `ctx.app.getStore()`: ONE store context per login session (cached on the session container, disposed with it).
 * Lazy: store/index.js and the data model load on the first call. Concurrent calls share one promise.
 * @param {object} o
 * @param {() => object|null} o.currentSession
 * @param {() => Promise<object>} o.loadModel
 * @param {() => object} o.deps {client, api, activity, feedback, t, gate, doc, win, isOnline}
 * @param {() => Promise<object>} [o.importStore]
 */
export function createStoreGetter({ currentSession, loadModel, deps, importStore = () => import('./store/index.js') }) {
  const getStore = async () => {
    const session = currentSession();
    if (!session) throw new Error('not signed in');
    let rec = session.data.get(STORE_KEY);
    if (!rec) {
      rec = { ctx: null, promise: null };
      rec.promise = (async () => {
        const [mod, model] = await Promise.all([importStore(), loadModel()]);
        if (session.disposed) throw new Error('session ended');
        rec.ctx = mod.createStoreContext({ session, model, ...deps() });
        return rec.ctx;
      })();
      session.data.set(STORE_KEY, rec);
      rec.promise.catch(() => {
        if (session.data.get(STORE_KEY) === rec) session.data.delete(STORE_KEY); // a failed start can be retried
      });
    }
    return rec.promise;
  };
  /** Hand the (new) translator to the live context after a language change. */
  getStore.setTranslator = (t) => {
    const session = currentSession();
    const rec = session && session.data.get(STORE_KEY);
    if (rec && rec.ctx) rec.ctx.setTranslator(t);
  };
  return getStore;
}

export async function boot({ win = window, doc = document } = {}) {
  const $ = (id) => doc.getElementById(id);
  const appEl = $('app');
  const main = $('main');
  const storages = browserStorages(win);

  // Theme first, so there is no flash of the wrong theme after the script loads.
  applyTheme(doc.documentElement, readTheme(storages.local));

  const readiness = createReadiness((state) => {
    appEl.setAttribute('data-state', state);
    appEl.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  });

  // No dictionary is imported by this file: the active language is loaded below, before the first render.
  const dictionaries = createDictionaryLoader();
  let i18n = createI18n({ lang: DEFAULT_LANGUAGE });
  try {
    // ---- configuration
    const { config, warnings, source } = await loadConfig();
    const bases = resolveBases(config, doc.baseURI);
    const wanted = pickLanguage({ stored: safeGet(storages.local, PREF_LANG), configured: config.defaultLanguage, browser: win.navigator.languages || [win.navigator.language] });
    // Await the active language before anything renders; on failure fall back to English; both failing
    // is the error state (the catch below shows the bilingual static text).
    let lang = wanted;
    let loadedDict;
    try {
      loadedDict = await dictionaries.load(lang);
    } catch (err) {
      if (lang === DEFAULT_LANGUAGE) throw err;
      lang = DEFAULT_LANGUAGE;
      loadedDict = await dictionaries.load(lang);
    }
    i18n.addDictionary(lang, loadedDict);
    i18n.setLang(lang);
    const timeZone = resolveTimeZone(config.defaultTimeZone);
    const firstWeekday = resolveFirstWeekday(config.firstWeekday, i18n.lang);
    const t = (k, p) => i18n.t(k, p);

    // ---- services
    const activity = createActivityLog();
    const feedback = createFeedback();
    const auth = createAuthStore(storages);
    let router = null;
    let screen = null; // {abort, ctl, route, placeholder}
    let restore = null;
    let forceRemount = false;
    let lastRoute = null;

    // One container per login: stores, scheduler, timers and subscriptions die with it (M9).
    const sessions = createSessionHolder({
      storage: storages.local,
      timers: win,
      onEnd() {
        closeAllDialogs(); // no dialog (conflict, import, delete, picker, discard) outlives the session
        unmountScreen();
        fill(main);
        activity.clear();
        feedback.clear();
      },
    });
    const currentSession = () => (auth.isSignedIn() ? sessions.ensure(auth.getLogin() || '') : null);

    // The data model (with ical.js) is loaded on demand, never at login (m13).
    let modelPromise = null;
    let model = null;
    const loadModel = () => {
      if (!modelPromise) modelPromise = import('./model/item.js').then((m) => (model = m));
      return modelPromise;
    };

    function expireSession() {
      if (!auth.isSignedIn()) return;
      const here = router && router.current ? safeNext(router.current) : null;
      leave.reset();
      auth.logout(); // ends the session container (subscription below)
      activity.add({ op: 'session', result: 'error', detail: 'expired' });
      router.navigate(buildHash('/login', { next: here }), { replace: true });
      feedback.setStatus(t('login.expired'), { scope: 'login' });
    }

    const apiFor = (getAuth, onUnauthorized) => createApi({ apiBase: bases.apiBase, getAuth, onUnauthorized });
    const davFor = (getAuth, onUnauthorized) => createClient(createTransport({ basePath: bases.radicaleBase, getAuth, onUnauthorized }));
    const api = apiFor(() => auth.getAuth(), expireSession);
    const dav = davFor(() => auth.getAuth(), expireSession);

    function doSignOut(messageKey = 'login.signedOut') {
      leave.reset();
      sessions.end('signed-out');
      auth.logout();
      activity.add({ op: 'logout', result: 'ok' });
      router.navigate('#/login', { replace: true });
      feedback.setStatus(t(messageKey), { scope: 'login' });
    }

    // `GET me` once per login (cached on the session container, gone with it): the shell needs `admin`
    // to decide which entries to offer. A failure leaves it null (no admin entries) and is not retried.
    const ME_KEY = 'radui.me';
    function getMe({ refresh = false } = {}) {
      const session = currentSession();
      if (!session) return Promise.resolve(null);
      let rec = session.data.get(ME_KEY);
      if (!rec || refresh) {
        rec = { value: null, promise: null };
        const mine = rec;
        rec.promise = api
          .me()
          .then((me) => {
            mine.value = me;
            return me;
          })
          .catch(() => null)
          .then((me) => {
            if (!session.disposed) updateChrome(lastRoute);
            return me;
          });
        session.data.set(ME_KEY, rec);
      }
      return rec.promise;
    }
    // Per-login preferences (Settings): ONE object per login session, so a change reaches every screen at once.
    const PREFS_KEY = 'radui.prefs';
    function prefsForSession() {
      const session = currentSession();
      if (!session) return null;
      let prefs = session.data.get(PREFS_KEY);
      if (!prefs) {
        prefs = createPrefs({ storage: storages.local, login: session.login });
        session.data.set(PREFS_KEY, prefs);
      }
      return prefs;
    }
    const isAdmin = () => {
      const session = sessions.current;
      const rec = session && session.data.get(ME_KEY);
      return Boolean(rec && rec.value && rec.value.admin === true);
    };

    // ---- unsaved input guard (D-R2-22)
    function confirmDiscard({ discard, cancel }) {
      openDialog({
        testid: 'dialog-discard-changes',
        title: t('shell.discard.title'),
        description: t('shell.discard.text'),
        focus: 'cancel',
        win,
        actions: [
          { testid: 'dialog-discard', label: t('shell.discard.confirm'), kind: 'danger', onClick: () => discard() },
          { testid: 'dialog-keep-editing', label: t('shell.discard.keep'), kind: 'primary', cancel: true },
        ],
        onClose: () => cancel(),
      });
    }
    const leave = createLeaveGuard({ win, confirmDiscard, navigate: (hash) => router.navigate(hash, { force: true }) });
    const signOut = () => leave.guarded(doSignOut);

    const getStore = createStoreGetter({
      currentSession,
      loadModel,
      deps: () => ({ client: dav, api, activity, feedback, t, gate: writeGate, doc, win, isOnline: () => win.navigator.onLine !== false }),
    });

    let buildInfoPromise = null; // build-info.json, fetched once, only when About is shown
    const screenApp = {
      auth,
      getStore,
      api,
      dav,
      activity,
      feedback,
      readiness,
      signOut,
      /** Sign out at once (no unsaved-input prompt) and show the text of `messageKey` on the login screen. */
      signOutWith: (messageKey) => doSignOut(messageKey),
      getMe,
      isAdmin,
      prefs: prefsForSession,
      setLanguage: (code) => applyLanguage(code),
      buildInfo: () => (buildInfoPromise ||= loadBuildInfo()),
      gate: writeGate,
      loadModel,
      openItem: (text, kind) => {
        if (!model) throw new Error('the data model is not loaded yet (await app.loadModel())');
        return model.openItem(text, kind);
      },
      discover: (client, a) => discoverAccessible(client, { meAccess: () => a.meAccess() }),
      candidate: (header) => ({ api: apiFor(() => header), dav: davFor(() => header) }),
      navigate: (hash, opts) => router.navigate(hash, opts),
      setDirty: (v) => leave.setDirty(v),
      setLeaveHook: (fn) => leave.setHook(fn),
    };
    const configInfo = () => [
      ['debug.config.appBase', bases.appBase],
      ['debug.config.apiBase', bases.apiBase],
      ['debug.config.radicaleBase', bases.radicaleBase],
      ['debug.config.language', i18n.lang],
      ['debug.config.timeZone', timeZone],
      ['debug.config.firstWeekday', weekdayName(i18n.lang, firstWeekday)],
    ];
    const appForScreen = () => ({ ...screenApp, session: currentSession(), lang: i18n.lang, sourceUrl: config.sourceUrl, timeZone, firstWeekday: resolveFirstWeekday(config.firstWeekday, i18n.lang), configInfo: configInfo(), configWarnings: warnings, debug: config.debug === true });

    // ---- chrome
    const feedbackView = mountFeedback(feedback, { statusEl: $('status-region'), alertEl: $('alert-region'), t });
    const activityView = mountActivity(activity, { listEl: $('activity-list'), emptyEl: $('activity-empty'), t, formatTime: (iso) => formatTime(iso, { lang: i18n.lang, timeZone, withSeconds: true }) });

    function translateStatic() {
      doc.documentElement.setAttribute('lang', i18n.lang);
      for (const el of doc.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
      for (const el of doc.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.getAttribute('data-i18n-label')));
      $('lang-select').value = i18n.lang;
      $('theme-select').value = readTheme(storages.local);
      syncOnline();
    }

    function updateChrome(route) {
      const who = auth.describe();
      const user = $('header-user');
      user.hidden = !who.signedIn;
      const signedInAs = who.signedIn ? t('shell.signedInAs', { login: who.login || '' }) : '';
      user.textContent = signedInAs;
      // Under 480 px the text is not drawn (css); the name stays available to assistive technology.
      if (signedInAs) {
        user.setAttribute('role', 'group');
        user.setAttribute('aria-label', signedInAs);
      } else {
        user.removeAttribute('role');
        user.removeAttribute('aria-label');
      }
      appEl.classList.toggle('has-nav', who.signedIn);
      if (who.signedIn) getMe(); // starts the one-time `me` load; the chrome is drawn again when it lands
      applyNav($, route, who.signedIn, { admin: isAdmin() });
      $('app-title').textContent = config.appTitle;
    }

    // ---- offline: banner + global write gate (the PWA module may drive the same gate)
    function syncOnline() {
      const online = win.navigator.onLine !== false;
      $('banner-offline').hidden = online;
      writeGate.setReason('offline', online ? null : t('shell.write.offline'));
    }
    win.addEventListener('online', syncOnline);
    win.addEventListener('offline', syncOnline);

    // ---- screens
    let first = true;
    let routeSeq = 0;
    const inline = { login: renderLogin, notfound: renderNotFound };

    function unmountScreen() {
      if (!screen) return;
      const old = screen;
      screen = null;
      old.abort.abort();
      try {
        if (typeof old.ctl.dispose === 'function') old.ctl.dispose();
      } catch (e) {
        if (win.console) win.console.error(e && e.name ? `${e.name}: ${e.message}` : 'screen dispose failed');
      }
      leave.reset();
      main.classList.remove('main--wide', 'main--full');
    }

    const screenCtx = (route, abort) => ({
      root: main,
      t,
      tp: (k, n, p) => i18n.tp(k, n, p),
      params: route.params,
      route,
      host: win.location.host,
      signal: abort.signal,
      app: appForScreen(),
    });

    async function onRoute(route) {
      lastRoute = route;
      const mySeq = ++routeSeq;
      const family = familyOf(route.screen);
      feedback.enterScreen(family);
      readiness.reset();
      const end = readiness.begin();
      appEl.setAttribute('data-route', route.name);

      // Same screen, other route: update in place, keep scroll position, search text and focus.
      if (screen && !forceRemount && !screen.placeholder && screen.route.screen === route.screen && typeof screen.ctl.update === 'function') {
        try {
          screen.route = route;
          await screen.ctl.update({ ...screenCtx(route, screen.abort), signal: screen.abort.signal });
        } catch (e) {
          end(false);
          feedback.setAlert(t('shell.fatal'));
          activity.add({ op: 'config', target: route.name, result: 'error', detail: String((e && e.name) || 'error') });
          throw e;
        }
        if (mySeq !== routeSeq) return;
        if (screen.ctl.title) doc.title = `${screen.ctl.title} - ${config.appTitle}`;
        updateChrome(route);
        end(true);
        return;
      }

      let loaded;
      try {
        loaded = await loadScreen(route.screen, { inline });
        if (loaded.model) await loadModel();
      } catch (e) {
        if (mySeq === routeSeq) {
          end(false);
          feedback.setAlert(t('shell.fatal'));
          activity.add({ op: 'config', target: route.name, result: 'error', detail: String((e && e.name) || 'error') });
        }
        throw e;
      }
      if (mySeq !== routeSeq) return; // a newer navigation took over while the module loaded

      unmountScreen();
      const abort = new AbortController();
      fill(main);
      const snap = restore;
      restore = null;
      forceRemount = false;
      let ctl;
      try {
        ctl = loaded.render({ ...screenCtx(route, abort), restore: snap });
      } catch (e) {
        end(false);
        feedback.setAlert(t('shell.fatal'));
        activity.add({ op: 'config', target: route.name, result: 'error', detail: String((e && e.name) || 'error') });
        throw e;
      }
      screen = { abort, ctl: ctl || {}, route, placeholder: loaded.placeholder };
      if (ctl && typeof ctl.canLeave === 'function') leave.setHook((to) => ctl.canLeave(to));
      // `wide` (split views) and `full` (calendar) both use the whole main width from 900 px (layout.css).
      main.classList.toggle('main--wide', Boolean(ctl && ctl.wide));
      main.classList.toggle('main--full', Boolean(ctl && (ctl.full || ctl.wide)));
      doc.title = ctl && ctl.title ? `${ctl.title} - ${config.appTitle}` : config.appTitle;
      updateChrome(route);
      if (!first && !main.contains(doc.activeElement)) main.focus();
      first = false;
      end(true);
    }

    router = createRouter({
      win,
      routes: ROUTES,
      onRoute,
      canLeave: (change) => leave.canLeave(change),
      guard(route) {
        const signedIn = auth.isSignedIn();
        if (route.root) return signedIn ? LANDING_HASH : '#/login';
        if (route.route && route.route.auth && !signedIn) return buildHash('/login', { next: buildHash(route.path, route.query) });
        if (route.name === 'login' && signedIn) return safeNext(route.params.next) || LANDING_HASH;
        return null;
      },
    });
    auth.subscribe((who) => {
      if (who.signedIn) sessions.ensure(who.login || '');
      else sessions.end('signed-out');
      updateChrome(lastRoute);
    });
    if (auth.isSignedIn()) sessions.ensure(auth.getLogin() || '');
    // Signed out in another tab: this tab's session ends too.
    win.addEventListener('storage', (e) => {
      if ((e.key === null || e.key === STORAGE_KEY) && !auth.isSignedIn() && sessions.current) {
        leave.reset();
        sessions.end('signed-out');
        router.navigate('#/login', { replace: true });
      }
    });

    // ---- controls
    function rerenderScreen() {
      restore = screen && typeof screen.ctl.snapshot === 'function' ? screen.ctl.snapshot() : null;
      forceRemount = true; // strings change: redraw instead of update()
      router.refresh();
    }
    // Loads the dictionary (busy state meanwhile), then switches. The only write is this device's language
    // preference; a failed load changes nothing and says so.
    const applyLanguage = createLanguageSwitcher({
      i18n,
      loader: dictionaries,
      begin: () => readiness.begin(),
      onApplied: afterLanguageApplied,
      onFailed() {
        $('lang-select').value = i18n.lang;
        feedback.setAlert(t('shell.language.loadFailed'), { scope: null });
        rerenderScreen(); // radios and the select go back to the language in use
      },
    });
    function afterLanguageApplied() {
      safeSet(storages.local, PREF_LANG, i18n.lang);
      translateStatic();
      getStore.setTranslator(t);
      feedbackView.render();
      activityView.render();
      rerenderScreen();
    }
    $('lang-select').addEventListener('change', (e) => applyLanguage(e.target.value));
    disableWhileBusy(main, $('lang-select')); // no redraw while a save or create is in flight
    $('theme-select').addEventListener('change', (e) => {
      const v = e.target.value;
      safeSet(storages.local, PREF_THEME, v);
      applyTheme(doc.documentElement, readTheme(storages.local));
    });
    $('btn-sign-out').addEventListener('click', () => signOut());
    const panel = $('activity-panel');
    const toggle = $('activity-toggle');
    const setPanel = (open) => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) $('activity-title').focus();
      else toggle.focus();
    };
    toggle.addEventListener('click', () => setPanel(panel.hidden));
    $('activity-close').addEventListener('click', () => setPanel(false));
    $('skip-link').addEventListener('click', () => main.focus());

    translateStatic();
    updateChrome(null);
    if (source === 'file' || warnings.length) {
      activity.add({ op: 'config', target: 'config.json', result: warnings.length ? 'error' : 'ok', detail: warnings.length ? `${warnings.length} warning(s)` : '' });
    }
    initPwa({ win, doc, t, guarded: (fn) => leave.guarded(fn) });
    await router.start();
  } catch (e) {
    readiness.fail();
    const alertEl = $('alert-region');
    if (alertEl && !alertEl.firstChild) alertEl.textContent = i18n.has('shell.fatal') ? i18n.t('shell.fatal') : FATAL_TEXT;
    if (win.console) win.console.error(e && e.name ? `${e.name}: ${e.message}` : 'startup failed');
  }
}

if (typeof document !== 'undefined' && document.getElementById('app')) boot();
