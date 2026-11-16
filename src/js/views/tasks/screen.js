// SPDX-License-Identifier: AGPL-3.0-or-later
// The tasks screen (RUN3 WP C1): `#/tasks?filter=open|today|overdue|done|all&sort=due|priority` is ONE merged list over
// every task list of the account (a calendar that accepts VTODO), with a toggle per list, filters with counts, a sort,
// one-tap complete / reopen and sub-tasks indented under their parent. `#/tasks/<key>?list=<href>` is the read-only
// detail (see detail.js). `mount(ctx)` answers at once; the data loads behind it and the screen root carries
// data-state="loading|ready|error" (the shell's readiness stays `loading` meanwhile) and data-sync="idle|running|error".
//
// Stable toggling (same model as the calendar): rows are keyed by href and inserted, removed or moved one by one
// (rows.js); switching a list on or off, a refresh after a sync or a write, and a filter or sort change never rebuild the
// list: scroll position and focus stay. A list is fetched only when first switched on (`tasklist-loading` on its toggle).
// Hash state: filter and sort. Hidden lists are a per-login preference (`tasks.hidden`), not in the URL.
//
// Every write goes through the store's write path (actions.js). Nothing here keeps an Item beyond a render.
// Test ids: tasks-screen, task-filter-<f>, task-sort, btn-new-task, tasklist-bar, tasklist-toggle (data-href),
// tasklist-loading, tasklist-failed, tasklist-live, tasks-status, task-list, task-row, task-complete, task-open,
// tasks-empty, tasks-nolist (btn-create-task-list), tasks-readonly, tasks-filter-empty, tasks-error, tasks-offline, btn-retry.

import { clear, fill, h, vars } from '../../ui.js';
import { classify, davErrorKey } from '../../store/errors.js';
import { todayIn } from '../../calendar/grid.js';
import { loadDisplayZone } from '../../calendar/tzprefs.js';
import { FILTERS, buildTree, countFilters, describeTask, parseFilter, parseSort } from '../../tasks/list.js';
import { createTaskActions } from './actions.js';
import { COLOUR_ALLOW, PREF, resolveDeps, normHref, newTaskHash, newTaskListHash, readTaskPrefs, taskEditHash, tasksHash } from './common.js';
import { buildTaskDetail } from './detail.js';
import { createRowTree } from './rows.js';
import { createTaskSource } from './source.js';

const textOfError = (t, e) => {
  const kind = e && typeof e.kind === 'string' && !e.name ? e.kind : classify(e).kind;
  return t(davErrorKey(kind));
};

export { resolveDeps };

// ---------------------------------------------------------------------------------------------------------------
// #/tasks

export function mount(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  let { t, tp } = ctx;
  let current = ctx;
  const lang = app.lang || 'en';
  const login = app.session ? app.session.login : '';
  const prefs = app.prefs ? app.prefs() : null;
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  let P = readTaskPrefs(prefs, { firstWeekday: app.firstWeekday });
  let tz = loadDisplayZone(login, { storage: d.storage, defaultZone: app.timeZone });
  let disposed = false;
  const S = { status: 'loading', errorText: '', filter: 'open', sort: 'due', storeCtx: null, source: null, records: [], visibleRecords: [], counts: null, running: new Set(), syncError: false, busy: new Set(), queued: false, rendered: null };
  const offs = [];
  let loading = null;

  // ------------------------------------------------------------------ DOM
  const heading = h('h1', { class: 'page-title', id: 'tasks-title', tabindex: '-1' }, t('tasks.title'));
  const newWrap = h('div', { class: 'tasks__new' });
  const filterNav = h('nav', { class: 'seg seg--scroll', 'aria-label': t('tasks.filters'), testid: 'task-filters' });
  const filterLinks = new Map();
  for (const f of FILTERS) {
    const count = h('span', { class: 'seg__count', testid: `task-filter-${f}-count` }, '0');
    const link = h('a', { class: 'seg__item', href: tasksHash({ filter: f, sort: S.sort }), testid: `task-filter-${f}`, 'data-filter': f }, h('span', null, t(`tasks.filter.${f}`)), count);
    filterLinks.set(f, { link, count });
    filterNav.append(link);
  }
  const sortSel = h('select', { class: 'input input--compact', id: 'task-sort', testid: 'task-sort' }, h('option', { value: 'due' }, t('tasks.sort.due')), h('option', { value: 'priority' }, t('tasks.sort.priority')));
  sortSel.addEventListener('change', () => nav(tasksHash({ filter: S.filter, sort: sortSel.value })));
  const sortBox = h('div', { class: 'tasks__sort' }, h('label', { class: 'inline-label', for: 'task-sort' }, t('tasks.sortBy')), sortSel);
  const bar = h('div', { class: 'tasklist-bar', role: 'group', 'aria-label': t('tasks.lists'), testid: 'tasklist-bar' });
  const live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', testid: 'tasklist-live' });
  const statusLine = h('p', { class: 'tasks__status', role: 'status', testid: 'tasks-status' }, t('tasks.loadingStatus'));
  const stateBox = h('div', { class: 'tasks__state', hidden: true });
  const listEl = h('ul', { class: 'tasks tasks--root', testid: 'task-list', tabindex: '-1', 'aria-label': t('tasks.title') });
  const rootEl = h('section', { class: 'tasks-screen', testid: 'tasks-screen', 'data-state': 'loading', 'data-sync': 'idle', 'data-filter': S.filter, 'data-sort': S.sort, 'aria-labelledby': 'tasks-title' },
    h('div', { class: 'tasks__head' }, heading, newWrap),
    h('div', { class: 'tasks__toolbar' }, filterNav, sortBox),
    bar, live, statusLine, stateBox, listEl);
  ctx.root.append(rootEl);

  const listInfo = new Map(); // list href -> {name, color}, refreshed with the list bar
  const rows = createRowTree({ ul: listEl, t, lang, use24h: P.use24h, today: todayIn(tz, d.now()), listOf: (href) => listInfo.get(normHref(href)) || null, onComplete: (rec) => void complete(rec), showLists: true });
  const nav = (hash, opts) => app.navigate(hash, opts);
  const say = (text) => app.feedback.setStatus(text);
  const allLists = () => (S.source ? S.source.lists() : []);
  const isVisible = (rec) => !P.hidden.has(normHref(rec.collection));

  function readParams() {
    const p = current.params || {};
    S.filter = parseFilter(p.filter);
    S.sort = parseSort(p.sort);
  }

  // ------------------------------------------------------------------ rendering
  const defaultList = () => {
    if (!S.source) return null;
    const writable = S.source.writable();
    return writable.find((c) => !P.hidden.has(normHref(c.href))) || writable[0] || null;
  };

  function renderNew() {
    const w = S.source ? S.source.writable() : [];
    const lists = allLists();
    if (S.status !== 'ready' || !lists.length) {
      fill(newWrap);
      return;
    }
    if (w.length) {
      const dl = defaultList();
      fill(newWrap, h('a', { class: 'btn btn--primary', href: newTaskHash({ list: dl ? dl.href : '' }), testid: 'btn-new-task' }, t('tasks.new')));
    } else {
      fill(newWrap, h('button', { type: 'button', class: 'btn btn--primary', disabled: true, 'aria-disabled': 'true', testid: 'btn-new-task', 'aria-describedby': 'tasks-new-why' }, t('tasks.new')), h('p', { class: 'meta-line', id: 'tasks-new-why' }, t('tasks.newDisabled')));
    }
  }

  function renderBar() {
    const lists = allLists();
    listInfo.clear();
    for (const l of lists) listInfo.set(l.href, { name: l.name, color: l.color });
    const keep = new Set(lists.map((l) => l.href));
    for (const row of [...bar.children]) if (!keep.has(row.getAttribute('data-list'))) bar.removeChild(row);
    lists.forEach((l, i) => {
      let row = [...bar.children].find((r) => r.getAttribute('data-list') === l.href);
      if (!row) {
        const id = `tasklist-vis-${i}-${Math.abs(hashOf(l.href))}`;
        const cb = h('input', { type: 'checkbox', class: 'swatch-check', id, testid: 'tasklist-toggle', 'data-href': l.href });
        cb.addEventListener('change', () => void toggleList(l.href, cb.checked));
        const name = h('span', { class: 'tasklist__name' });
        const tags = h('span', { class: 'tasklist__tags' });
        const load = h('span', { class: 'tasklist__loading', testid: 'tasklist-loading', hidden: true }, t('tasks.loading'));
        const fail = h('span', { class: 'tasklist__failed', testid: 'tasklist-failed', hidden: true }, t('tasks.listFailed'));
        row = h('div', { class: 'tasklist', 'data-list': l.href }, cb, h('label', { for: id, class: 'tasklist__label' }, name, tags), load, fail);
        row._parts = { cb, name, tags, load, fail };
        bar.append(row);
      }
      const { cb, name, tags, load, fail } = row._parts;
      cb.checked = !P.hidden.has(l.href);
      cb.setAttribute('aria-label', l.name);
      name.textContent = l.name;
      tags.replaceChildren();
      if (!l.canWrite) tags.append(h('span', { class: 'tag tag--quiet' }, t('tasks.readOnlyTag')));
      if (l.owner && !l.ownerIsMe) tags.append(h('span', { class: 'tag tag--quiet' }, t('tasks.ownedBy', { owner: l.owner })));
      vars(cb, { '--cal': l.color }, COLOUR_ALLOW);
      load.hidden = !l.loading;
      fail.hidden = !l.failed;
      if (l.loading) row.setAttribute('aria-busy', 'true');
      else row.removeAttribute('aria-busy');
      if (bar.children[i] !== row) bar.insertBefore(row, bar.children[i] || null);
    });
    bar.hidden = lists.length === 0 || S.status !== 'ready';
  }

  function showState(testid, title, text, actions = [], role = null) {
    stateBox.hidden = false;
    stateBox.replaceChildren(h('div', { class: 'state', testid, role }, h('p', { class: 'state__title' }, title), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'state__actions' }, ...actions) : null));
  }
  function hideState() {
    stateBox.hidden = true;
    stateBox.replaceChildren();
  }

  function renderView() {
    const lists = allLists();
    const now = d.now();
    const res = S.source ? S.source.records({ tz, now }) : { records: [], unreadable: 0 };
    S.records = res.records;
    S.visibleRecords = res.records.filter(isVisible);
    S.counts = countFilters(S.visibleRecords);
    const tree = buildTree(res.records, { visible: isVisible, filter: S.filter, sort: S.sort });
    const today = todayIn(tz, now);
    rows.configure({ t, lang, use24h: P.use24h, today, showLists: lists.length > 1 });
    rows.sync(tree.roots, { busy: S.busy, doc: d.doc });
    const visibleLists = lists.filter((l) => !P.hidden.has(l.href));
    const loadedLists = visibleLists.filter((l) => l.loaded && !l.loading);

    // states above the list
    const canCreate = S.storeCtx ? S.storeCtx.access.canCreateCollections() : false;
    const anyWritable = lists.some((l) => l.canWrite);
    let showList = true;
    hideState();
    if (!lists.length) {
      showList = false;
      showState('tasks-nolist', t('tasks.nolist.title'), canCreate ? t('tasks.nolist.text') : t('tasks.nolist.noaccess'), canCreate ? [h('a', { class: 'btn btn--primary', href: newTaskListHash(), testid: 'btn-create-task-list' }, t('tasks.nolist.create'))] : []);
    } else if (!visibleLists.length) {
      showList = false;
      showState('tasks-filter-empty', t('tasks.noneShown'), null);
    } else if (!S.visibleRecords.length && loadedLists.length === visibleLists.length) {
      showList = false;
      showState('tasks-empty', t('tasks.empty.title'), anyWritable ? t('tasks.empty.text') : t('tasks.empty.readonly'), anyWritable ? [h('a', { class: 'btn btn--primary', href: newTaskHash({ list: (defaultList() || {}).href || '' }), testid: 'btn-new-task-empty' }, t('tasks.new'))] : []);
    } else if (!tree.total && S.visibleRecords.length) {
      showState('tasks-filter-empty', t(`tasks.none.${S.filter}`), null);
    }
    if (lists.length && !anyWritable) {
      const note = h('aside', { class: 'notice notice--quiet', testid: 'tasks-readonly' }, t('tasks.readOnlyNote'));
      if (stateBox.hidden) {
        stateBox.hidden = false;
        stateBox.replaceChildren(note);
      } else stateBox.append(note);
    }
    listEl.hidden = !showList || !tree.roots.length;

    // counts, status line, links
    for (const f of FILTERS) {
      const { link, count } = filterLinks.get(f);
      count.textContent = String(S.counts[f]);
      link.setAttribute('href', tasksHash({ filter: f, sort: S.sort }));
      if (f === S.filter) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    sortSel.value = S.sort;
    rootEl.setAttribute('data-filter', S.filter);
    rootEl.setAttribute('data-sort', S.sort);
    let text = t('tasks.statusLine', { open: tp('tasks.nOpen', S.counts.open, { n: S.counts.open }), overdue: tp('tasks.nOverdue', S.counts.overdue, { n: S.counts.overdue }), lists: tp('tasks.nLists', visibleLists.length, { n: visibleLists.length }) });
    if (S.filter !== 'open') text += ` ${t('tasks.statusShowing', { filter: t(`tasks.filter.${S.filter}`), n: tp('tasks.nTasks', tree.total, { n: tree.total }) })}`;
    if (res.unreadable) text += ` ${tp('tasks.unreadable', res.unreadable, { n: res.unreadable })}`;
    statusLine.textContent = text;
    S.rendered = { total: tree.total, flat: tree.roots.length };
  }

  function renderAll() {
    if (disposed) return;
    rootEl.setAttribute('data-state', S.status === 'loading' ? 'loading' : S.status === 'ready' ? 'ready' : 'error');
    renderBar();
    renderNew();
    if (S.status === 'ready') renderView();
    else if (S.status === 'loading') {
      statusLine.textContent = t('tasks.loadingStatus');
      listEl.hidden = true;
    } else {
      listEl.hidden = true;
      statusLine.textContent = S.errorText;
      showState(S.status === 'offline' ? 'tasks-offline' : 'tasks-error', S.errorText || t('tasks.err.generic'), null, [h('button', { type: 'button', class: 'btn', testid: 'btn-retry', on: { click: () => retry() } }, t('tasks.retry'))], 'alert');
    }
  }

  function refresh() {
    if (disposed) return;
    renderBar();
    renderNew();
    if (S.status === 'ready') renderView();
  }
  function scheduleRefresh() {
    if (S.queued || disposed) return;
    S.queued = true;
    Promise.resolve().then(() => {
      S.queued = false;
      refresh();
    });
  }

  // ------------------------------------------------------------------ toggles and writes
  async function toggleList(href, on) {
    const hidden = new Set(P.hidden);
    if (on) hidden.delete(href);
    else hidden.add(href);
    P = { ...P, hidden };
    if (prefs) prefs.set(PREF.hidden, [...hidden]);
    const list = allLists().find((l) => l.href === href);
    const name = list ? list.name : href;
    if (on && S.source && !S.source.isLoaded(href)) {
      const res = await S.source.load(href);
      if (!res.ok && !res.skipped) say(t('tasks.err.loadList', { name }));
    }
    if (disposed) return;
    refresh();
    const n = S.records.filter((r) => normHref(r.collection) === href).length;
    live.textContent = t(on ? 'tasks.shownN' : 'tasks.hiddenN', { name, n: tp('tasks.nTasks', n, { n }) });
  }

  async function complete(rec) {
    if (!S.storeCtx || S.busy.has(rec.href)) return;
    const actions = createTaskActions({ app, storeCtx: S.storeCtx, source: S.source, t, deps: { win: d.win, ...d.actionDeps } });
    S.busy.add(rec.href);
    refresh();
    try {
      await actions.toggleComplete(rec);
    } finally {
      S.busy.delete(rec.href);
      if (!disposed) refresh();
    }
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
      renderBar();
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
      if (S.source) S.source.dispose();
      S.source = createTaskSource({ storeCtx: S.storeCtx });
      if (access.lastError && !S.source.lists().length) throw access.lastError;
      offs.push(S.source.subscribe(onSourceEvent));
      S.status = 'ready';
      renderAll();
      const wanted = S.source.lists().filter((l) => !P.hidden.has(l.href));
      const results = await Promise.all(wanted.map((l) => S.source.load(l.href)));
      if (disposed) return;
      const failedAll = wanted.length > 0 && results.every((r) => !r.ok && !r.skipped);
      if (failedAll && !S.source.records({ tz, now: d.now() }).records.length) {
        S.status = d.isOnline() ? 'error' : 'offline';
        S.errorText = t(d.isOnline() ? 'tasks.err.loadAll' : 'tasks.err.offline');
      }
      done(S.status === 'ready');
    } catch (e) {
      if (disposed) return;
      S.status = d.isOnline() ? 'error' : 'offline';
      S.errorText = d.isOnline() ? textOfError(t, e) : t('tasks.err.offline');
      done(false);
    }
  }

  function done(ok) {
    renderAll();
    endLoad(ok);
  }

  function retry() {
    S.status = 'loading';
    S.errorText = '';
    renderAll();
    loading = load(true);
  }

  if (prefs) {
    offs.push(
      prefs.subscribe((name) => {
        // the hidden lists are applied in place by this screen itself; the calendar settings (24 h clock) change the texts
        if (disposed || (name && ![ 'cal.use24h', 'cal.firstWeekday' ].includes(name))) return;
        P = readTaskPrefs(prefs, { firstWeekday: app.firstWeekday });
        refresh();
      }),
    );
  }
  // "overdue" and "today" move on with the clock
  if (app.session && typeof app.session.setInterval === 'function') offs.push(app.session.setInterval(() => !disposed && S.status === 'ready' && refresh(), 60000));

  readParams();
  renderAll();
  loading = load();

  return {
    wide: true,
    get title() {
      return t('tasks.title');
    },
    async update(next) {
      current = next;
      t = next.t || t;
      readParams();
      if (loading) await loading;
      tz = loadDisplayZone(login, { storage: d.storage, defaultZone: app.timeZone });
      refresh();
    },
    dispose() {
      disposed = true;
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
          /* already gone */
        }
      }
      if (S.source) S.source.dispose();
      rows.clear();
      clear(rootEl);
      rootEl.remove();
    },
    // exposed for tests and agents
    _state: S,
    _rows: rows,
  };
}

function hashOf(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) n = (n * 31 + s.charCodeAt(i)) | 0;
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// #/tasks/<key>?list=<href>   (the read-only detail)

export function mountTask(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  let { t, tp } = ctx;
  let current = ctx;
  const lang = app.lang || 'en';
  const login = app.session ? app.session.login : '';
  const prefs = app.prefs ? app.prefs() : null;
  const P = readTaskPrefs(prefs, { firstWeekday: app.firstWeekday });
  const tz = loadDisplayZone(login, { storage: d.storage, defaultZone: app.timeZone });
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  const rootEl = h('div', { class: 'task-screen', testid: 'task-screen', 'data-state': 'loading' }, h('p', { class: 'meta-line', role: 'status', testid: 'task-loading' }, t('tasks.loading')));
  ctx.root.append(rootEl);
  let disposed = false;
  let source = null;
  let storeCtx = null;
  let token = 0;
  let title = '';
  const nav = (hash, opts) => app.navigate(hash, opts);
  const back = () => tasksHash({});

  function stateNode(status, text) {
    const key = { notfound: 'tasks.detail.notfound', nolist: 'tasks.detail.nolist', unreadable: 'tasks.detail.unreadable', error: 'tasks.err.generic' }[status] || 'tasks.detail.notfound';
    return h('section', { class: 'task-detail task-detail--state', testid: 'task-notfound', 'data-reason': status, tabindex: '-1' }, h('p', { class: 'state__title', role: 'alert' }, text || t(key)), h('a', { class: 'btn', href: back(), testid: 'btn-back' }, t('tasks.detail.back')));
  }

  async function load() {
    const my = (token += 1);
    const p = current.params || {};
    try {
      storeCtx = await app.getStore();
      await storeCtx.access.load();
      if (disposed || my !== token) return;
      if (!source) {
        source = createTaskSource({ storeCtx });
        source.subscribe((ev) => {
          if (ev.type === 'write' && !disposed) void load();
        });
      }
      const res = await source.resolve({ key: typeof p.key === 'string' ? p.key : '', list: typeof p.list === 'string' ? p.list : '' });
      if (disposed || my !== token) return;
      let node;
      let ok = false;
      if (res.state === 'ok') {
        const now = d.now();
        const rec = describeTask({ href: res.entry.href, collection: res.collection.href, etag: res.entry.etag, item: res.item }, { tz, now });
        if (rec) {
          rec.routeKey = res.key;
          const canWrite = storeCtx.access.canWrite(res.collection);
          rec.listReadOnly = !canWrite;
          rec.readOnly = rec.readOnly || storeCtx.writes.isReadOnly(res.entry.href);
          title = rec.summary;
          const actions = createTaskActions({ app, storeCtx, source, t, deps: { win: d.win, ...d.actionDeps } });
          const model = { rec, item: res.item, entry: res.entry, collection: res.collection, canWrite, relatives: source.relatives(rec, { tz, now }) };
          node = buildTaskDetail({
            model,
            t,
            tp,
            lang,
            tz,
            use24h: P.use24h,
            backHash: back(),
            ops: {
              onComplete: async () => {
                await actions.toggleComplete(rec);
                if (!disposed) void load();
              },
              onDelete: async () => {
                const out = await actions.remove({ collection: res.collection.href, entry: res.entry, summary: rec.summary, uid: res.item.uid });
                if (out.done) nav(back());
              },
              editHash: model.canWrite && !rec.readOnly ? taskEditHash(rec.routeKey, { list: res.collection.href }) : null,
            },
          });
          ok = true;
        } else node = stateNode('unreadable');
      } else if (res.state === 'error') node = stateNode('error', textOfError(t, { kind: res.kind }));
      else node = stateNode(res.state);
      const hadFocus = rootEl.contains && d.doc && d.doc.activeElement && rootEl.contains(d.doc.activeElement);
      rootEl.replaceChildren(node);
      rootEl.setAttribute('data-state', ok ? 'ready' : 'error');
      endLoad(ok);
      const head = rootEl.querySelector('[data-testid="task-title"]');
      if (head && head.focus && !hadFocus) head.focus();
    } catch (e) {
      if (disposed) return;
      rootEl.replaceChildren(stateNode('error', textOfError(t, e)));
      rootEl.setAttribute('data-state', 'error');
      endLoad(false);
    }
  }
  void load();
  return {
    get title() {
      return title || t('tasks.title');
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
