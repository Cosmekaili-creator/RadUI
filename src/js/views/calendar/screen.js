// SPDX-License-Identifier: AGPL-3.0-or-later
// The calendar screen (RUN3 WP B3a): `#/calendar/<view>/<date>` (month, week, day, agenda; `q=` is the search) and the
// event detail page `#/events/<key>?cal=&occ=`. `mount(ctx)` answers at once; the data loads behind it and the
// screen root carries data-state="loading|ready|error" (the shell's readiness stays `loading` meanwhile) and
// data-sync="idle|running|error" for background syncs.
//
// Stable toggling (SPECS 4.1): a view is built once per period (skeleton), its event nodes are keyed; switching a
// calendar on or off flags nodes `is-off` or inserts/removes them one by one. The grid element, the scroller, focus and
// the open detail are NOT re-rendered. A calendar is fetched only when first switched on (`calendar-loading` on its row).
// Hash state: view, date, q (and, on desktop, ev/cal/occ for the open detail). Visible calendars and the fold state of
// the list are per-login preferences, not in the URL (links stay short; documented in docs/calendar-ui.md).
//
// Every write goes through the store's write path (actions.js). Nothing here keeps an Item beyond a render.

import { clear, h } from '../../ui.js';
import { addDays, dateMs, instantWindow, periodRange, todayIn } from '../../calendar/grid.js';
import { occurrenceText, searchOccurrences } from '../../calendar/search.js';
import { loadDisplayZone, saveDisplayZone, recentZones } from '../../calendar/tzprefs.js';
import { classify, davErrorKey } from '../../store/errors.js';
import { createAgendaView, searchDays } from './agenda.js';
import { createEventActions } from './actions.js';
import { buildBirthdayDetail } from './bdaylink.js';
import { createCallist } from './callist.js';
import { BIRTHDAYS_HREF, PREF, calendarHash, cleanQuery, eventHash, isPhone, newEventHash, parseView, periodLabel, readCalPrefs, PHONE_QUERY, sameHref } from './common.js';
import { buildDetail } from './detail.js';
import { loadDetailModel } from './detailmodel.js';
import { createMonthView } from './month.js';
import { createCalendarSource, eventCalendars } from './source.js';
import { createToolbar } from './toolbar.js';
import { FIRST_VISIBLE_HOUR, HOUR_PX, createWeekView } from './week.js';

export const DEFAULT_VIEW = 'week';
export const SEARCH_SPAN_DAYS = 366;

function safeStorage(win) {
  try {
    return win && win.localStorage ? win.localStorage : null;
  } catch {
    return null;
  }
}

/** The browser objects and timers the screens use; a test passes its own through `mount(ctx, deps)`. */
export function resolveDeps(deps = {}) {
  const win = deps.win || globalThis.window;
  const doc = deps.doc || globalThis.document;
  return {
    win,
    doc,
    now: () => Date.now(),
    storage: safeStorage(win),
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
    debounceMs: 250,
    isOnline: () => !win || !win.navigator || win.navigator.onLine !== false,
    actionDeps: {},
    ...deps,
  };
}

const textOfError = (t, e) => {
  const kind = e && typeof e.kind === 'string' && !e.name ? e.kind : classify(e).kind;
  return t(davErrorKey(kind));
};

// ---------------------------------------------------------------------------------------------------------------
// #/calendar/<view>/<date>

export function mount(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  let { t, tp } = ctx;
  let current = ctx;
  const lang = app.lang || 'en';
  const login = app.session ? app.session.login : '';
  const prefs = app.prefs ? app.prefs() : null;
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  let P = readCalPrefs(prefs, { firstWeekday: app.firstWeekday });
  let tz = loadDisplayZone(login, { storage: d.storage, defaultZone: app.timeZone });
  let disposed = false;
  const S = { status: 'loading', errorText: '', view: DEFAULT_VIEW, date: todayIn(tz, d.now()), q: '', ev: null, badRoute: false, phone: isPhone(d.win), storeCtx: null, source: null, obj: null, sig: null, records: [], running: new Set(), syncError: false, panelKey: null, panelSig: null, panelToken: 0, panelModel: null, shown: 0, seen: [] };
  let queued = false;
  let loading = null;
  const offs = [];

  // ------------------------------------------------------------------ DOM
  const toolbar = createToolbar({
    t,
    lang,
    firstWeekday: P.firstWeekday,
    ops: {
      onSearch: (value) => pushSearch(value, false),
      onSearchNow: (value) => pushSearch(value, true),
      onJump: (iso) => {
        if (iso !== S.date) nav(calendarHash(S.view, iso, cleanQuery({ q: S.q })));
      },
      onZone: (zone) => changeZone(zone),
    },
    deps: { win: d.win, doc: d.doc, timers: d.timers, login, storage: d.storage, tp, now: d.now },
  });
  const callist = createCallist({
    t,
    state: P.listState,
    ops: {
      onToggle: (href, on) => toggleCalendar(href, on),
      onHideDup: (on) => setHideDup(on),
      onState: (state) => {
        P = { ...P, listState: state };
        rootEl.setAttribute('data-list-state', state);
        if (prefs) prefs.set(PREF.listState, state);
      },
    },
  });
  const statusLine = h('p', { class: 'cal__status', role: 'status', testid: 'cal-status' });
  const stateBox = h('div', { class: 'cal__state', hidden: true });
  const content = h('div', { class: 'cal__content', testid: 'cal-content' });
  const panel = h('aside', { class: 'cal__panel', hidden: true, testid: 'event-panel', 'aria-label': t('cal.detail.panel') });
  const rootEl = h('div', { class: 'cal', testid: 'calendar-screen', 'data-state': 'loading', 'data-sync': 'idle', 'data-view': S.view, 'data-list-state': P.listState }, callist.el, h('div', { class: 'cal__body' }, toolbar.el, statusLine, stateBox, content), panel);
  ctx.root.append(rootEl);

  const nav = (hash, opts) => app.navigate(hash, opts);
  const say = (text) => app.feedback.setStatus(text);
  const allCals = () => (S.source ? S.source.calendars() : []);
  const visible = (rec) => !P.hidden.has(rec.calendar);
  const exactUse24h = () => P.use24h;

  // ------------------------------------------------------------------ route parameters
  function readParams() {
    const p = current.params || {};
    const pv = parseView(p);
    S.badRoute = !pv;
    S.view = pv ? pv.view : DEFAULT_VIEW;
    S.date = pv ? pv.date : todayIn(tz, d.now());
    S.q = typeof p.q === 'string' ? p.q.slice(0, 200) : '';
    S.ev = typeof p.ev === 'string' && p.ev && typeof p.cal === 'string' && p.cal ? { key: p.ev.slice(0, 255), cal: p.cal, occ: typeof p.occ === 'string' ? p.occ.slice(0, 40) : '' } : null;
  }

  // ------------------------------------------------------------------ rendering
  const defaultCalendar = () => {
    if (!S.source) return null;
    const writable = S.source.writable();
    const shown = writable.find((c) => !P.hidden.has(c.href.endsWith('/') ? c.href : `${c.href}/`));
    return shown || writable[0] || null;
  };

  function rangeOf() {
    return periodRange(S.view, S.date, { firstWeekday: P.firstWeekday, phone: S.phone });
  }

  function renderList() {
    const cals = allCals();
    const bdayAvailable = Boolean(S.source) && P.birthdays && S.source.hasAddressBooks();
    callist.render({
      calendars: cals,
      hidden: P.hidden,
      birthdays: { available: bdayAvailable, shown: !P.hidden.has(BIRTHDAYS_HREF), loading: S.source ? S.source.isBirthdaysLoading() : false, failed: false, hideDup: P.hideDup, color: '#a64a85' },
    });
  }

  function showState(kind, text, actions = []) {
    stateBox.hidden = false;
    content.hidden = true;
    stateBox.replaceChildren(h('div', { class: 'state', testid: kind, role: kind === 'calendar-error' ? 'alert' : null }, h('p', { class: 'state__title' }, text), actions.length ? h('div', { class: 'state__actions' }, ...actions) : null));
  }

  function renderState() {
    const cals = allCals();
    const canCreate = S.storeCtx ? S.storeCtx.access.canCreateCollections() : false;
    if (S.status === 'loading') {
      stateBox.hidden = true;
      stateBox.replaceChildren();
      content.hidden = false;
      return;
    }
    if (S.status === 'error' || S.status === 'offline') {
      showState(S.status === 'offline' ? 'calendar-offline' : 'calendar-error', S.errorText || t('cal.err.generic'), [h('button', { type: 'button', class: 'btn', testid: 'btn-retry', on: { click: () => retry() } }, t('cal.retry'))]);
      return;
    }
    if (!cals.length) {
      if (canCreate) showState('calendar-empty', t('cal.empty.own'), [h('a', { class: 'btn btn--primary', href: '#/collections/new-calendar', testid: 'btn-new-calendar' }, t('cal.empty.create'))]);
      else showState('calendar-noaccess', t('cal.empty.noaccess'));
      return;
    }
    stateBox.hidden = true;
    stateBox.replaceChildren();
    content.hidden = false;
  }

  function computeRecords(range, search) {
    const span = search ? { start: addDays(S.date, -SEARCH_SPAN_DAYS), end: addDays(S.date, SEARCH_SPAN_DAYS + 1) } : range;
    const win = instantWindow(span, tz);
    const res = S.source.records({
      from: win.from,
      to: win.to,
      range: span,
      tz,
      use24h: exactUse24h(),
      lang,
      birthdays: P.birthdays && S.source.isBirthdaysLoaded() ? { show: true, hideDup: P.hideDup } : null,
    });
    let records = res.records;
    let total = 0;
    if (search) {
      const found = searchOccurrences(records, S.q, { textOf: (rec) => occurrenceText(rec.occ) });
      records = found.matches;
      total = found.total;
    }
    return { ...res, records, total };
  }

  function buildObject(range, search, days) {
    const base = { t, tp, lang, tz, use24h: exactUse24h() };
    const today = todayIn(tz, d.now());
    if (search) return createAgendaView({ ...base, days, search: true, today });
    if (S.view === 'month') return createMonthView({ ...base, phone: S.phone, range, query: {} });
    if (S.view === 'agenda') return createAgendaView({ ...base, days: range.days, today });
    return createWeekView({ ...base, view: S.view, range, query: {} });
  }

  function renderView() {
    if (!S.source || S.status !== 'ready') return;
    const search = S.q.trim() !== '';
    const range = rangeOf();
    const comp = computeRecords(range, search);
    S.records = comp.records;
    S.truncated = comp.truncated;
    S.unreadable = comp.unreadable.length;
    const days = search ? searchDays(comp.records, tz) : range.days;
    const sig = search ? ['search', days.join(','), tz, P.use24h, lang].join('|') : [S.view, range.start, range.end, S.phone, tz, P.use24h, lang, P.firstWeekday, S.view === 'month' && S.phone ? S.date : ''].join('|');
    if (sig !== S.sig || !S.obj) {
      const scroll = S.obj && S.obj.scroller ? S.obj.scroller.scrollTop : null;
      if (S.obj) S.obj.dispose();
      S.obj = buildObject(range, search, days);
      S.sig = sig;
      clear(content);
      content.append(S.obj.el);
      // a scroller keeps its place across periods; a fresh one opens at the first working hour (an element that is not in the page yet cannot be scrolled, so it is done here)
      if (S.obj.scroller) S.obj.scroller.scrollTop = scroll !== null ? scroll : FIRST_VISIBLE_HOUR * HOUR_PX;
    }
    const out = S.obj.apply({ records: comp.records, visible, now: d.now() });
    S.shown = out.shown;
    rootEl.setAttribute('data-view', S.view);
    // status line
    const calCount = allCals().filter((c) => !P.hidden.has(c.href) && c.loaded).length + (P.birthdays && S.source.isBirthdaysLoaded() && !P.hidden.has(BIRTHDAYS_HREF) ? 1 : 0);
    const visibleRecs = comp.records.filter(visible);
    const inRange = search ? visibleRecs : visibleRecs.filter((r) => r.times.startWall < dateMs(range.end) && (r.times.endWall > dateMs(range.start) || r.times.startWall >= dateMs(range.start)));
    const keys = new Set(inRange.map((r) => r.key));
    let text = search ? t('cal.statusSearch', { count: tp('cal.nEvents', keys.size, { n: keys.size }), q: S.q.trim() }) : t('cal.statusLine', { period: periodLabel(S.view, range, { t, lang }), events: tp('cal.nEvents', keys.size, { n: keys.size }), calendars: tp('cal.nCalendars', calCount, { n: calCount }) });
    if (search && comp.total > comp.records.length) text += ` ${t('cal.searchLimited', { n: comp.records.length })}`;
    if (comp.truncated) text += ` ${t('cal.truncated')}`;
    if (S.unreadable) text += ` ${tp('cal.unreadable', S.unreadable, { n: S.unreadable })}`;
    statusLine.textContent = text;
    S.seen = [...new Set(comp.records.filter((r) => r.start && r.start.tzid).map((r) => r.start.tzid))];
  }

  function renderToolbar() {
    const range = rangeOf();
    const w = allWritable();
    const dc = defaultCalendar();
    toolbar.update({
      view: S.view,
      date: S.date,
      range,
      q: S.q,
      tz,
      recents: recentZones(login, { storage: d.storage }),
      seenZones: S.seen,
      phone: S.phone,
      canCreate: S.status === 'ready' && w,
      createReason: S.status === 'ready' && !w ? t('cal.readOnlyNote') : null,
      newHref: newEventHash(cleanQuery({ date: S.date, cal: dc ? dc.href : '' })),
    });
  }
  const allWritable = () => Boolean(S.source) && S.source.writable().length > 0;

  function renderAll() {
    if (disposed) return;
    rootEl.setAttribute('data-state', S.status === 'loading' ? 'loading' : ['ready', 'empty', 'noaccess'].includes(S.status) ? 'ready' : 'error');
    renderState();
    renderList();
    if (S.status === 'ready') renderView();
    else if (S.status !== 'loading') statusLine.textContent = S.errorText || '';
    else statusLine.textContent = t('cal.loadingStatus');
    renderToolbar();
  }

  function refresh() {
    if (disposed) return;
    renderList();
    if (S.status === 'ready') renderView();
    renderToolbar();
    if (S.ev) void showPanel(false);
  }
  function scheduleRefresh() {
    if (queued || disposed) return;
    queued = true;
    Promise.resolve().then(() => {
      queued = false;
      refresh();
    });
  }

  // ------------------------------------------------------------------ toggles, zone, search
  async function toggleCalendar(href, on) {
    const hidden = new Set(P.hidden);
    if (on) hidden.delete(href);
    else hidden.add(href);
    P = { ...P, hidden };
    if (prefs) prefs.set(PREF.hidden, [...hidden]);
    const isBday = href === BIRTHDAYS_HREF;
    const name = isBday ? t('cal.birthdays') : (allCals().find((c) => sameHref(c.href, href)) || { name: href }).name;
    if (on && S.source) {
      if (isBday) {
        if (!S.source.isBirthdaysLoaded()) {
          renderList();
          await S.source.loadBirthdays();
        }
      } else if (!S.source.isLoaded(href)) {
        const res = await S.source.load(href);
        if (!res.ok && !res.skipped) say(t('cal.err.loadCalendar', { name }));
      }
    }
    if (disposed) return;
    refresh();
    const n = new Set(S.records.filter((r) => r.calendar === href).map((r) => r.key)).size;
    callist.announce(t(on ? 'cal.shownN' : 'cal.hiddenN', { name, n: tp('cal.nEvents', n, { n }) }));
  }

  function setHideDup(on) {
    P = { ...P, hideDup: on };
    if (prefs) prefs.set(PREF.hideDup, on);
    refresh();
    const n = new Set(S.records.filter((r) => r.virtual).map((r) => r.key)).size;
    callist.announce(t(on ? 'cal.bday.dupHiddenN' : 'cal.bday.dupShownN', { n: tp('cal.nEvents', n, { n }) }));
  }

  function changeZone(zone) {
    if (zone === tz) return;
    saveDisplayZone(login, zone, { storage: d.storage });
    tz = zone;
    S.sig = null;
    say(t('cal.tz.changed', { zone }));
    refresh();
  }

  let searchTimer = null;
  function pushSearch(value, now) {
    if (searchTimer) {
      d.timers.clearTimeout(searchTimer);
      searchTimer = null;
    }
    const go = () => {
      searchTimer = null;
      if (disposed) return;
      const q = value.trim() ? value : '';
      if (q === S.q) return;
      nav(calendarHash(S.view, S.date, cleanQuery({ q, ev: S.ev && S.ev.key, cal: S.ev && S.ev.cal, occ: S.ev && S.ev.occ })), { replace: true });
    };
    if (now) go();
    else searchTimer = d.timers.setTimeout(go, d.debounceMs);
  }

  // ------------------------------------------------------------------ the detail panel (desktop)
  const closedHash = () => calendarHash(S.view, S.date, cleanQuery({ q: S.q }));
  const closePanel = () => nav(closedHash());

  async function showPanel(focus) {
    const ev = S.ev;
    if (!ev || !S.source) {
      panel.hidden = true;
      panel.replaceChildren();
      S.panelKey = null;
      S.panelSig = null;
      rootEl.classList.remove('has-panel');
      return;
    }
    if (S.phone) {
      nav(eventHash(ev.key, cleanQuery({ cal: ev.cal, occ: ev.occ })), { replace: true });
      return;
    }
    const key = `${ev.cal}|${ev.key}|${ev.occ}`;
    const token = (S.panelToken += 1);
    const first = S.panelKey !== key;
    S.panelKey = key;
    panel.hidden = false;
    rootEl.classList.add('has-panel');
    if (first) panel.replaceChildren(h('p', { class: 'meta-line', testid: 'event-loading', role: 'status' }, t('cal.loading')));
    const cx = { t, lang, tz, use24h: exactUse24h() };
    let res;
    try {
      res = await loadDetailModel({ source: S.source, storeCtx: S.storeCtx, params: { key: ev.key, cal: ev.cal, occ: ev.occ }, cx });
    } catch (e) {
      res = { status: 'error', text: textOfError(t, e) };
    }
    if (disposed || token !== S.panelToken) return;
    const sig = `${key}|${res.status}|${res.model ? res.model.entry.etag : res.rec ? res.rec.key : ''}|${tz}|${P.use24h}|${lang}|${res.text || ''}`;
    if (!first && sig === S.panelSig) return;
    S.panelSig = sig;
    const node = renderDetailNode(res, { page: false });
    panel.replaceChildren(node);
    S.panelModel = res.model || null;
    const title = panel.querySelector('[data-testid="event-title"]') || panel.querySelector('[data-testid="event-notfound"]');
    if ((first || focus) && title && title.focus) title.focus();
  }

  function detailOps(getModel, afterRemove) {
    const actions = createEventActions({ app, storeCtx: S.storeCtx, source: S.source, t, deps: { win: d.win, doc: d.doc, ...d.actionDeps } });
    return {
      onEdit: async () => {
        const hash = await actions.editTarget(getModel());
        if (hash) nav(hash);
      },
      onDelete: async () => {
        const r = await actions.remove(getModel());
        if (r.done) afterRemove();
      },
      onMove: async () => {
        const r = await actions.move(getModel());
        if (r.done) afterRemove();
      },
      onExport: () => actions.exportIt(getModel()),
      onClose: closePanel,
    };
  }

  function renderDetailNode(res, { page }) {
    if (res.status === 'ready') {
      const model = res.model;
      return buildDetail({ model, t, tp, lang, tz, use24h: exactUse24h(), page, ops: detailOps(() => model, closePanel) });
    }
    if (res.status === 'birthday') return buildBirthdayDetail(res.rec, { t, ops: { onClose: closePanel } });
    return stateNode(res, t, closePanel);
  }

  // ------------------------------------------------------------------ loading
  function onSourceEvent(ev) {
    if (ev.type === 'state') {
      if (ev.syncing) S.running.add(ev.collection);
      else S.running.delete(ev.collection);
      rootEl.setAttribute('data-sync', S.running.size ? 'running' : S.syncError ? 'error' : 'idle');
      return;
    }
    if (ev.type === 'sync') {
      S.syncError = ev.ok === false;
      rootEl.setAttribute('data-sync', S.running.size ? 'running' : S.syncError ? 'error' : 'idle');
      if (ev.ok === false || ev.changed) scheduleRefresh();
      return;
    }
    if (ev.type === 'loading' || ev.type === 'loaded') {
      renderList();
      if (ev.type === 'loaded') scheduleRefresh();
      return;
    }
    if (ev.type === 'write') scheduleRefresh();
  }

  async function load(force = false) {
    try {
      if (!S.storeCtx) S.storeCtx = await app.getStore();
      if (disposed) return;
      const { access } = S.storeCtx;
      if (force) await access.refetch({ reason: 'retry' });
      else await access.load();
      if (disposed) return;
      if (access.lastError && !eventCalendars(access).length) throw access.lastError;
      if (S.source) S.source.dispose();
      S.source = createCalendarSource({ storeCtx: S.storeCtx, app, t });
      offs.push(S.source.subscribe(onSourceEvent));
      const cals = S.source.calendars();
      S.status = 'ready';
      renderAll();
      const wanted = cals.filter((c) => !P.hidden.has(c.href));
      const results = await Promise.all(wanted.map((c) => S.source.load(c.href)));
      if (disposed) return;
      if (P.birthdays && S.source.hasAddressBooks() && !P.hidden.has(BIRTHDAYS_HREF)) await S.source.loadBirthdays();
      if (disposed) return;
      const failedAll = wanted.length > 0 && results.every((r) => !r.ok && !r.skipped);
      if (failedAll && S.source.records({ from: 0, to: 1, range: rangeOf(), tz, lang, use24h: null }).records.length === 0) {
        S.status = d.isOnline() ? 'error' : 'offline';
        S.errorText = t(d.isOnline() ? 'cal.err.loadAll' : 'cal.err.offline');
      }
      done(S.status === 'ready');
    } catch (e) {
      if (disposed) return;
      S.status = d.isOnline() ? 'error' : 'offline';
      S.errorText = d.isOnline() ? textOfError(t, e) : t('cal.err.offline');
      done(false);
    }
  }

  function done(ok) {
    renderAll();
    endLoad(ok);
    if (S.ev) void showPanel(false);
  }

  function retry() {
    S.status = 'loading';
    S.errorText = '';
    renderAll();
    loading = load(true);
  }

  // phone <-> desktop
  if (d.win && typeof d.win.matchMedia === 'function') {
    try {
      const mq = d.win.matchMedia(PHONE_QUERY);
      const onMediaChange = () => {
        const next = isPhone(d.win);
        if (next === S.phone) return;
        S.phone = next;
        S.sig = null;
        refresh();
      };
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', onMediaChange);
        offs.push(() => mq.removeEventListener('change', onMediaChange));
      }
    } catch {
      /* no media query support */
    }
  }
  if (prefs) {
    offs.push(
      prefs.subscribe((name) => {
        // list state, visible calendars and the duplicates box are applied in place by this screen itself
        if (disposed || (name && (!String(name).startsWith('cal.') || [PREF.listState, PREF.hidden, PREF.hideDup].includes(name)))) return;
        const before = P;
        P = readCalPrefs(prefs, { firstWeekday: app.firstWeekday });
        if (before.birthdays !== P.birthdays && P.birthdays && S.source && !P.hidden.has(BIRTHDAYS_HREF)) void S.source.loadBirthdays();
        callist.setState(P.listState);
        rootEl.setAttribute('data-list-state', P.listState);
        S.sig = null;
        refresh();
      }),
    );
  }
  // the red "now" line moves while the screen is open
  if (app.session && typeof app.session.setInterval === 'function') offs.push(app.session.setInterval(() => S.obj && S.obj.tick(d.now()), 60000));

  readParams();
  if (ctx.restore && typeof ctx.restore.q === 'string' && !S.q) S.q = ctx.restore.q;
  callist.setState(P.listState);
  renderAll();
  loading = load();
  if (S.badRoute) Promise.resolve().then(() => !disposed && nav(calendarHash(DEFAULT_VIEW, S.date), { replace: true }));

  return {
    wide: true,
    full: true,
    get title() {
      return t('cal.title');
    },
    async update(next) {
      current = next;
      t = next.t || t;
      readParams();
      if (S.badRoute) {
        nav(calendarHash(DEFAULT_VIEW, S.date), { replace: true });
        return;
      }
      if (loading) await loading;
      const end = app.readiness ? app.readiness.begin() : () => {};
      refresh();
      if (!S.ev) {
        S.panelKey = null;
        void showPanel(false);
      }
      end(true);
    },
    snapshot: () => ({ q: toolbar.search.value }),
    dispose() {
      disposed = true;
      if (searchTimer) d.timers.clearTimeout(searchTimer);
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
          /* already gone */
        }
      }
      if (S.source) S.source.dispose();
      if (S.obj) S.obj.dispose();
      clear(rootEl);
      rootEl.remove();
    },
    // exposed for tests and agents
    _state: S,
    openEvent: (rec) => nav(calendarHash(S.view, S.date, cleanQuery({ q: S.q, ev: rec.routeKey, cal: rec.calendar, occ: rec.occParam }))),
  };
}

/** The "not found" family of states of an event, as a node with a close/back control. */
function stateNode(res, t, onClose) {
  const key = { notfound: 'cal.detail.notfound', occurrence: 'cal.detail.occurrenceGone', nocalendar: 'cal.detail.nocalendar', unreadable: 'cal.detail.unreadable', error: 'cal.detail.error' }[res.status] || 'cal.detail.notfound';
  return h(
    'section',
    { class: 'event-detail event-detail--state', testid: 'event-notfound', 'data-reason': res.status, tabindex: '-1' },
    h('p', { class: 'state__title', role: 'alert' }, res.text || t(key)),
    res.status === 'unreadable' && res.entry ? h('pre', { class: 'prose', testid: 'event-raw' }, String(res.entry.text).slice(0, 100000)) : null,
    onClose ? h('button', { type: 'button', class: 'btn', testid: 'btn-close-detail', on: { click: () => onClose() } }, t('cal.closeDetail')) : h('a', { class: 'btn', href: '#/calendar', testid: 'btn-back' }, t('cal.detail.back')),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// #/events/<key>?cal=&occ=   (the detail as a page: phones, deep links)

export function mountEvent(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  let { t, tp } = ctx;
  let current = ctx;
  const lang = app.lang || 'en';
  const login = app.session ? app.session.login : '';
  const prefs = app.prefs ? app.prefs() : null;
  const P = readCalPrefs(prefs, { firstWeekday: app.firstWeekday });
  const tz = loadDisplayZone(login, { storage: d.storage, defaultZone: app.timeZone });
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  const rootEl = h('div', { class: 'cal-event', testid: 'event-screen', 'data-state': 'loading' }, h('p', { class: 'meta-line', role: 'status', testid: 'event-loading' }, t('cal.loading')));
  ctx.root.append(rootEl);
  let disposed = false;
  let source = null;
  let token = 0;
  let title = '';
  const nav = (hash, opts) => app.navigate(hash, opts);

  async function load() {
    const my = (token += 1);
    const p = current.params || {};
    try {
      const storeCtx = await app.getStore();
      await storeCtx.access.load();
      if (disposed || my !== token) return;
      if (!source) source = createCalendarSource({ storeCtx, app, t });
      const cx = { t, lang, tz, use24h: P.use24h };
      const res = await loadDetailModel({ source, storeCtx, params: { key: typeof p.key === 'string' ? p.key : '', cal: typeof p.cal === 'string' ? p.cal : '', occ: typeof p.occ === 'string' ? p.occ.slice(0, 40) : '' }, cx });
      if (disposed || my !== token) return;
      const rec = res.model ? res.model.rec : res.rec;
      const date = rec ? new Date(rec.times.startWall).toISOString().slice(0, 10) : null;
      const back = date ? calendarHash('week', date) : '#/calendar';
      title = rec ? rec.title : '';
      let node;
      if (res.status === 'ready') {
        const model = res.model;
        const actions = createEventActions({ app, storeCtx, source, t, deps: { win: d.win, doc: d.doc, ...d.actionDeps } });
        node = buildDetail({
          model,
          t,
          tp,
          lang,
          tz,
          use24h: P.use24h,
          page: true,
          backHash: back,
          ops: {
            onEdit: async () => {
              const hash = await actions.editTarget(model);
              if (hash) nav(hash);
            },
            onDelete: async () => {
              const r = await actions.remove(model);
              if (r.done) nav(back);
            },
            onMove: async () => {
              const r = await actions.move(model);
              if (r.done) nav(back);
            },
            onExport: () => actions.exportIt(model),
          },
        });
      } else if (res.status === 'birthday') {
        node = h('div', null, h('a', { class: 'link detail__back', href: back, testid: 'btn-back' }, t('cal.detail.back')), buildBirthdayDetail(res.rec, { t }));
      } else node = stateNode(res, t, null);
      rootEl.replaceChildren(node);
      rootEl.setAttribute('data-state', res.status === 'ready' || res.status === 'birthday' ? 'ready' : 'error');
      endLoad(res.status === 'ready' || res.status === 'birthday');
      const heading = rootEl.querySelector('[data-testid="event-title"]');
      if (heading && heading.focus) heading.focus();
    } catch (e) {
      if (disposed) return;
      rootEl.replaceChildren(stateNode({ status: 'error', text: textOfError(t, e) }, t, null));
      rootEl.setAttribute('data-state', 'error');
      endLoad(false);
    }
  }
  void load();
  return {
    get title() {
      return title || t('cal.title');
    },
    async update(next) {
      current = next;
      t = next.t || t;
      await load();
    },
    dispose() {
      disposed = true;
      if (source) source.dispose();
      clear(rootEl);
      rootEl.remove();
    },
  };
}
