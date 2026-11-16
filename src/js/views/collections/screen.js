// SPDX-License-Identifier: AGPL-3.0-or-later
// `#/collections`: the list of calendars and address books the account can reach (own and shared), with
// open / edit / import / export / delete, and the delete and import dialogs addressed by the URL
// (`#/collections?dialog=delete|import&href=<collection href>`).
//
// mount(ctx) -> {title, update(ctx), dispose()}. Everything is read through `ctx.app.getStore()` (the store
// context of the session) and written through its `writes`; counts and the grant summary are read-only GETs.
//
// Test ids: collections-screen (data-state), collections-summary, btn-new-calendar, btn-new-addressbook,
// own-space-disabled, collections-error (+ btn-retry), collections-empty, collection-list-own,
// collection-list-shared, plus the row ids of list.js.

import { buildHash, collectionForParam } from '../../router.js';
import { fill, h } from '../../ui.js';
import { openDeleteDialog } from './deletedialog.js';
import { exportToFile } from './exporter.js';
import { openShareDialog } from './sharedialog.js';
import { adminStoreFor } from '../users/adminstore.js';
import { renderRow, loadCounts, setCount } from './list.js';
import { ensureAlert, ensureStatus, grantsByCollection, groupCollections, labelOf, leafOfHref } from './model.js';
import { isolate } from '../../widgets/avatar.js';

const FOCUS_REFRESH_MS = 10_000;

export function mount(ctx) {
  const { root, t, tp, app, signal } = ctx;
  let current = ctx;
  let store = null;
  let grants = { state: 'none' };
  let rows = [];
  let loaded = false;
  let disposed = false;
  let activeDialog = null;
  let lastLoad = 0;
  let countAbort = null;
  const counts = new Map(); // href -> last known count
  const now = () => (app.now ? app.now() : Date.now());

  const feedback = app.feedback;
  const lang = app.lang || 'en';

  // ------------------------------------------------------------------ frame
  const summary = h('p', { class: 'page-sub muted', testid: 'collections-summary' });
  const newCalendar = h('button', { type: 'button', class: 'btn btn--primary', testid: 'btn-new-calendar', write: true, on: { click: () => app.navigate('#/collections/new-calendar') } }, t('coll.newCalendar'));
  const newBook = h('button', { type: 'button', class: 'btn', testid: 'btn-new-addressbook', write: true, on: { click: () => app.navigate('#/collections/new-addressbook') } }, t('coll.newAddressbook'));
  const createBar = h('div', { class: 'toolbar__end' }, newCalendar, newBook);
  const ownSpaceOff = h('aside', { class: 'notice notice--quiet', testid: 'own-space-disabled', hidden: true }, t('coll.ownSpaceOff'));
  const errorText = h('p', { testid: 'collections-error-text' });
  const retry = h('button', { type: 'button', class: 'btn', testid: 'btn-retry', on: { click: () => load({ reason: 'retry' }) } }, t('coll.retry'));
  const errorBox = h('div', { class: 'notice notice--warn', testid: 'collections-error', hidden: true }, errorText, retry);
  const emptyText = h('p', { testid: 'collections-empty-text' });
  const emptyBox = h('div', { class: 'collections__empty', testid: 'collections-empty', hidden: true }, emptyText);
  const ownList = h('ul', { class: 'crows', testid: 'collection-list-own' });
  const ownNone = h('p', { class: 'muted', testid: 'collections-own-empty', hidden: true }, t('coll.ownNone'));
  const ownSection = h('section', { class: 'crows-section', 'aria-labelledby': 'coll-own-h', hidden: true }, h('h2', { class: 'section-title', id: 'coll-own-h' }, t('coll.own')), ownNone, ownList);
  const sharedList = h('ul', { class: 'crows', testid: 'collection-list-shared' });
  const sharedSection = h('section', { class: 'crows-section', 'aria-labelledby': 'coll-shared-h', hidden: true }, h('h2', { class: 'section-title', id: 'coll-shared-h' }, t('coll.sharedWithYou')), h('p', { class: 'muted small' }, t('coll.sharedWithYouNote')), sharedList);
  const screenEl = h(
    'section',
    { class: 'collections', testid: 'collections-screen', 'data-state': 'loading', 'aria-busy': 'true', 'aria-labelledby': 'collections-title' },
    h('h1', { class: 'page-title', id: 'collections-title', tabindex: '-1' }, t('coll.title')),
    h('div', { class: 'toolbar' }, summary, createBar),
    ownSpaceOff,
    errorBox,
    emptyBox,
    ownSection,
    sharedSection,
  );
  root.append(screenEl);

  function setState(state) {
    screenEl.setAttribute('data-state', state);
    screenEl.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }

  // ----------------------------------------------------------------- loading
  async function readGrants() {
    const owner = String((store.access.me && store.access.me.login) || (store.session && store.session.login) || '').toLowerCase();
    if (!app.api || typeof app.api.grants !== 'function' || !owner) return { state: 'none' };
    try {
      return { state: 'ok', byName: grantsByCollection(await app.api.grants({ owner }), owner) };
    } catch (e) {
      if (e && e.kind === 'auth') return { state: 'none' };
      return e && e.kind === 'notfound' ? { state: 'none' } : { state: 'unavailable' };
    }
  }

  async function load({ reason = 'enter' } = {}) {
    const end = app.readiness.begin();
    setState('loading');
    errorBox.hidden = true;
    let ok = false;
    try {
      store = store || (await app.getStore());
      const res = await store.access.refetch({ reason: `collections-${reason}` });
      if (disposed || signal.aborted) return end(true);
      if (!res.ok) {
        showError(res.error);
        return end(false);
      }
      if (res.error && store.access.list().length === 0) {
        showError(res.error); // the own listing failed and nothing else is reachable: not "no collection"
        return end(false);
      }
      grants = await readGrants();
      if (disposed || signal.aborted) return end(true);
      lastLoad = now();
      loaded = true;
      render();
      ok = true;
    } catch (e) {
      if (disposed || signal.aborted) return end(true);
      if (e && e.kind === 'auth') return end(true); // the shell's session-expiry path takes over
      showError(e);
      return end(false);
    }
    setState('ready');
    end(ok);
    applyRoute(current.route);
  }

  function showError() {
    errorText.textContent = t('coll.error');
    errorBox.hidden = false;
    emptyBox.hidden = true;
    ownSection.hidden = true;
    sharedSection.hidden = true;
    setState('error');
  }

  // ------------------------------------------------------------------ render
  const handlers = {
    edit: (c) => app.navigate(buildHash('/collections/edit', { href: c.href })),
    import: (c) => app.navigate(buildHash('/collections', { dialog: 'import', href: c.href })),
    delete: (c) => app.navigate(buildHash('/collections', { dialog: 'delete', href: c.href })),
    share: (c) => app.navigate(buildHash('/collections', { dialog: 'share', href: c.href })),
    export: (c) => doExport(c),
  };

  function render() {
    if (countAbort) countAbort.abort();
    countAbort = new AbortController();
    const list = store.access.list();
    const canCreate = store.access.canCreateCollections();
    createBar.hidden = !canCreate;
    ownSpaceOff.hidden = canCreate;
    errorBox.hidden = true;
    const { own, shared } = groupCollections(list, lang);
    rows = [];
    const build = (c) => {
      const r = renderRow(c, { t, tp, grants, handlers });
      const known = counts.get(c.href);
      if (known !== undefined) setCount(r.count, known, { t, tp });
      else rows.push({ c, count: r.count });
      return r.el;
    };
    fill(ownList, own.map(build));
    fill(sharedList, shared.map(build));
    ownSection.hidden = !canCreate;
    ownNone.hidden = own.length > 0;
    sharedSection.hidden = shared.length === 0;
    const none = list.length === 0;
    emptyBox.hidden = !none;
    if (none) emptyText.textContent = canCreate ? t('coll.empty') : t('coll.emptyShared');
    summary.textContent = tp('coll.summary', list.length);
    if (rows.length) startCounts(rows.slice(), countAbort.signal);
  }

  function startCounts(todo, sig) {
    loadCounts(todo, {
      dav: app.dav,
      signal: sig,
      t,
      tp,
      onCount: (c, n) => {
        if (n !== null) counts.set(c.href, n);
      },
    }).catch(() => {});
  }

  function refreshCountOf(href) {
    counts.delete(href);
    const el = ownList.querySelector(`[data-href="${href.replace(/["\\]/g, '')}"]`) || sharedList.querySelector(`[data-href="${href.replace(/["\\]/g, '')}"]`);
    const c = store.access.get(href);
    if (!el || !c) return;
    const countEl = el.querySelector('[data-testid="collection-count"]');
    countEl.setAttribute('aria-busy', 'true');
    countEl.textContent = t('coll.count.pending');
    startCounts([{ c, count: countEl }], countAbort ? countAbort.signal : undefined);
  }

  // ------------------------------------------------------------------ export
  async function doExport(c) {
    const end = app.readiness.begin();
    ensureStatus(feedback, t('coll.export.running', { name: isolate(labelOf(c)) }));
    const out = await exportToFile({ store, collection: c, t });
    if (disposed) return end(true);
    if (out.ok) ensureStatus(feedback, out.text);
    else if (out.status !== 'auth') ensureAlert(feedback, out.text);
    end(out.ok);
  }

  // ----------------------------------------------------------------- dialogs
  function closeRoute() {
    const q = (current.route && current.route.query) || {};
    if (q.dialog && !disposed) app.navigate('#/collections', { replace: true });
  }

  async function runDelete(c) {
    activeDialog = { kind: 'delete', href: c.href };
    let out;
    try {
      out = await openDeleteDialog({ ctx: current, store, collection: c });
    } finally {
      activeDialog = null;
    }
    if (disposed) return;
    if (out.deleted) {
      counts.delete(c.href);
      render();
    }
    closeRoute();
  }

  async function runImport(c) {
    activeDialog = { kind: 'import', href: c.href };
    try {
      const { openImportDialog } = await import('../importdialog.js');
      await openImportDialog({ ctx: current, collectionHref: c.href });
    } finally {
      activeDialog = null;
    }
    if (disposed) return;
    refreshCountOf(c.href);
    closeRoute();
  }

  async function runShare(c) {
    activeDialog = { kind: 'share', href: c.href };
    let out;
    try {
      const admin = adminStoreFor({ app, store });
      out = await openShareDialog({
        t,
        tp,
        app,
        admin,
        isAdmin: typeof app.isAdmin === 'function' && app.isAdmin() === true,
        collection: { owner: c.owner || (store.access.me && store.access.me.login) || '', name: leafOfHref(c.href), href: c.href, displayName: c.displayName || '' },
      });
    } catch {
      ensureAlert(feedback, t('share.loadFailed'));
    } finally {
      activeDialog = null;
    }
    if (disposed) return;
    if (out && out.applied > 0) {
      grants = await readGrants(); // the "Shared with" line of every row is read again
      if (!disposed) render();
    }
    closeRoute();
  }

  function applyRoute(route) {
    if (!loaded || disposed || !route) return;
    const q = route.query || {};
    if (!q.dialog) return;
    if (activeDialog && activeDialog.kind === q.dialog && activeDialog.href === q.href) return;
    if (activeDialog) return;
    if (q.dialog !== 'delete' && q.dialog !== 'import' && q.dialog !== 'share') return closeRoute();
    const c = collectionForParam(q.href, store.access.list());
    if (!c) {
      ensureAlert(feedback, t('coll.notFound'));
      return closeRoute();
    }
    if (q.dialog === 'share') {
      if (c.level !== 'own') {
        ensureAlert(feedback, t('coll.notAllowed'));
        return closeRoute();
      }
      runShare(c);
    } else if (q.dialog === 'delete') {
      if (c.level !== 'own') {
        ensureAlert(feedback, t('coll.notAllowed'));
        return closeRoute();
      }
      runDelete(c);
    } else {
      // address books (.vcf) and calendars (.ics, WP C2) can be imported into; the dialog chooses the file kind from the target
      if (!(c.level === 'own' || c.level === 'readwrite')) {
        ensureAlert(feedback, t('coll.notAllowed'));
        return closeRoute();
      }
      runImport(c);
    }
  }

  // ------------------------------------------------------------------ events
  let removeFocus = null;
  const win = typeof globalThis.window === 'object' ? globalThis.window : null;
  if (win && app.session && typeof app.session.listen === 'function') {
    removeFocus = app.session.listen(win, 'focus', () => {
      if (loaded && !disposed && !activeDialog && now() - lastLoad > FOCUS_REFRESH_MS) load({ reason: 'focus' });
    });
  }

  load({ reason: 'enter' });

  return {
    title: t('coll.title'),
    update(next) {
      current = next;
      applyRoute(next.route);
    },
    dispose() {
      disposed = true;
      if (countAbort) countAbort.abort();
      if (typeof removeFocus === 'function') removeFocus();
    },
  };
}
