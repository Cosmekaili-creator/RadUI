// SPDX-License-Identifier: AGPL-3.0-or-later
// The contacts screen (`#/contacts`, `#/contacts/<key>`): list pane + detail pane over one address book.
// mount(ctx) answers at once with a controller; the data loads behind it and the screen root carries
// data-state="loading|ready|error" (the shell's global readiness is held open meanwhile). Background syncs only
// set aria-busy on `contact-list` and data-sync on the screen root.
//
// Every write goes through the store's write path (ctx.app.getStore().writes). Nothing here keeps an Item.

import { h, clear } from '../../ui.js';
import { domCallbacks } from '../../store/scheduler.js';
import { classify, davErrorKey } from '../../store/errors.js';
import { LETTERS, WINDOW_SIZE, buildList, azIndex, resolveKey, windowRows } from '../../contacts/index.js';
import { addMemberPatch, affectedGroups, groupsOf, memberKeys } from '../../contacts/groups.js';
import { canDisplayPhoto } from '../../contacts/photo.js';
import { confirmDialog } from '../../widgets/dialogs.js';
import { openPicker } from '../../widgets/picker.js';
import { debounce } from '../../widgets/timing.js';
import { isolate } from '../../widgets/avatar.js';
import { bookParams, createBookData, isReadOnlyBook, pickBook } from './bookdata.js';
import { cleanQuery, contactHash, editHash, fmtNumber, listHash, makeKeyer, nameOf, resolveDeps } from './common.js';
import { createListPane } from './list.js';
import { createDetailPane } from './detail.js';

const NEW_HASH = '#/contacts/new';

export { makeKeyer };

export function mount(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  let { t, tp } = ctx;
  const lang = app.lang || 'en';
  const rootEl = h('div', { class: 'split', testid: 'contacts-screen', 'data-state': 'loading', 'data-sync': 'idle', 'data-view': 'list' });
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  let disposed = false;
  let current = ctx;
  let S = { storeCtx: null, pick: null, data: null, loading: null, q: '', typedQ: '', forceQ: false, group: '', from: undefined, size: WINDOW_SIZE, key: '', typing: false, status: 'loading', errorText: '', detail: null, offLists: [] };
  let unsubscribe = null;
  let unregisterStore = null;

  const params = () => current.params || {};
  const bookQuery = () => (S.pick && S.pick.state === 'ok' ? bookParams(S.pick.book, S.pick.books) : {});
  const nav = (hash, opts) => app.navigate(hash, opts);
  const say = (kind, text) => (kind === 'alert' ? app.feedback.setAlert(text) : app.feedback.setStatus(text));
  const readOnly = () => !S.pick || S.pick.state !== 'ok' || isReadOnlyBook(S.pick.book);

  // ------------------------------------------------------------------ list model

  function listModel() {
    const data = S.data;
    const base = { books: S.pick ? S.pick.books : [], book: S.pick && S.pick.book, readOnly: readOnly(), canCreateBook: S.storeCtx ? S.storeCtx.access.canCreateCollections() : false, errorText: S.errorText, q: S.q, group: S.group, typing: S.typing, forceQ: S.forceQ };
    if (S.status !== 'ready' || !data) return { ...base, status: S.status };
    const groups = data.groups();
    const g = groups.find((x) => x.key === S.group);
    const { rows, total } = buildList(data.all, { query: S.q, members: g ? memberKeys(g) : null, lang });
    const win = windowRows(rows, { from: S.from === undefined ? 0 : S.from, size: S.size });
    const keyer = makeKeyer(data.all);
    const q = cleanQuery({ ...bookQuery(), q: S.q.trim() ? S.q : '', group: S.group });
    S.rows = rows;
    S.lastWin = win;
    const sel = S.key ? resolveKey(S.key, data.all) : null;
    return {
      ...base,
      status: 'ready',
      groups: groups.map((x) => ({ key: x.key, name: x.name })),
      total,
      rows,
      win,
      az: azIndex(rows),
      filtered: Boolean(S.q.trim() || g),
      selectedHref: sel ? sel.href : null,
      hashFor: (s) => contactHash(keyer(s), q),
    };
  }

  // ------------------------------------------------------------------ detail model

  function selectedSummary() {
    if (!S.key || !S.data) return null;
    const s = resolveKey(S.key, S.data.all);
    return s && !s.isGroup ? s : null;
  }

  function detailModel() {
    const linkQuery = bookQuery();
    const backQuery = cleanQuery({ ...linkQuery, q: S.q.trim() ? S.q : '', group: S.group });
    if (!S.key) return { status: S.status === 'ready' && S.data && S.data.contacts.length > 0 ? 'none' : 'blank', linkQuery, backQuery };
    if (S.status !== 'ready' || !S.data) return { status: S.status === 'loading' ? 'loading' : 'notfound', linkQuery, backQuery };
    const summary = selectedSummary();
    const entry = summary ? S.data.entry(summary.href) : null;
    if (!summary || !entry) return { status: 'notfound', linkQuery, backQuery };
    let rec = S.detail;
    if (!rec || rec.href !== entry.href || rec.etag !== entry.etag) {
      let r = null;
      try {
        r = app.openItem(entry.text, 'contact');
      } catch {
        r = null;
      }
      const fields = r && r.ok ? r.fields() : null;
      const fidelity = S.storeCtx.writes.isReadOnly(entry.href);
      const reason = !r || !r.ok ? (r && r.reason) || 'parse-error' : r.readOnly ? r.readOnlyReason : fidelity ? 'fidelity' : null;
      rec = { href: entry.href, etag: entry.etag, text: entry.text, fields, reason, photo: r && r.ok ? canDisplayPhoto(r) : null };
      S.detail = rec;
    }
    const groups = S.data.groups();
    const mine = summary.uid ? groupsOf(groups, summary.uid) : [];
    return {
      status: 'ready',
      summary,
      name: nameOf(summary, t),
      uid: summary.uid,
      href: entry.href,
      etag: entry.etag,
      text: entry.text,
      fields: rec.fields,
      reason: rec.reason,
      photo: rec.photo,
      canWrite: !readOnly(),
      noEdit: Boolean(rec.reason),
      canAddToGroup: groups.length > 0 && !rec.reason,
      groupLinks: mine.map((g) => ({ key: g.key, name: g.name })),
      linkQuery,
      backQuery,
    };
  }

  // ------------------------------------------------------------------ operations

  const ops = {
    onBook(href) {
      if (S.storeCtx) S.storeCtx.access.setLastBook(href);
      nav(listHash({ ab: href }));
    },
    onSearch(value) {
      S.typing = true;
      S.typedQ = value;
      pushSearch(value);
    },
    onGroup(key) {
      nav(listHash(cleanQuery({ ab: params().ab, q: S.q, group: key })), { replace: true });
    },
    onNew() {
      if (readOnly()) {
        const note = rootEl.querySelector('[data-testid="contacts-readonly"]');
        if (note && note.focus) note.focus();
        return;
      }
      nav(NEW_HASH + hashQuery(bookQuery()));
    },
    onImport: () => openImport(),
    onExport: () => exportBook(),
    onJump(letter) {
      if (S.rows && S.rows.length <= WINDOW_SIZE) {
        S.from = undefined;
        focusLetter(letter);
        return;
      }
      nav(listHash(cleanQuery({ ab: params().ab, q: S.q, group: S.group, from: letter })), { replace: true });
    },
    onMore(nextSize) {
      S.size = nextSize;
      renderAll();
    },
    onEarlier(from) {
      const w = S.lastWin;
      S.size = w ? w.end - from : S.size;
      S.from = from;
      renderAll();
    },
    onRetry() {
      S.status = 'loading';
      S.errorText = '';
      renderAll();
      S.loading = load(true);
    },
  };

  const hashQuery = (q) => {
    const s = new URLSearchParams(cleanQuery(q)).toString();
    return s ? `?${s}` : '';
  };

  const pushSearch = debounce(
    (value) => {
      if (disposed) return;
      const query = cleanQuery({ ab: params().ab, q: value.trim() ? value : '', group: S.group });
      nav(S.key ? contactHash(S.key, query) : listHash(query), { replace: true });
    },
    d.debounceMs,
    d.timers,
  );

  function focusLetter(letter) {
    const id = `letter-${letter === '#' ? 'hash' : letter}`;
    const el = rootEl.querySelector(`#${id}`);
    if (el) {
      if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
      if (el.focus) el.focus({ preventScroll: true });
    }
  }

  async function openImport() {
    if (readOnly() || !S.pick || S.pick.state !== 'ok') return;
    try {
      const mod = await d.loadImportDialog();
      await mod.openImportDialog({ ctx: current, collectionHref: S.pick.book.href });
    } catch {
      say('alert', t('contacts.import.unavailable'));
    }
  }

  async function exportBook() {
    if (!S.pick || S.pick.state !== 'ok') return;
    const res = await S.storeCtx.exportCollection({ collection: S.pick.book });
    if (!res || !res.ok) return;
    const out = d.downloadText({ text: res.text, mime: res.mime, filename: res.filename, doc: d.doc, win: d.win });
    if (!out.ok) say('alert', t('contacts.export.failed'));
    else if (res.groupsExcluded > 0) say('status', t('contacts.export.done', { count: fmtNumber(lang, res.count), groups: fmtNumber(lang, res.groupsExcluded) }));
  }

  function exportContact() {
    const m = detailModel();
    if (m.status !== 'ready') return;
    const res = S.storeCtx.exportItem({ text: m.text, displayName: m.name, kind: 'addressbook', target: m.uid || '' });
    const out = d.downloadText({ text: res.text, mime: res.mime, filename: res.filename, doc: d.doc, win: d.win });
    if (!out.ok) say('alert', t('contacts.export.failed'));
  }

  async function deleteContact() {
    const m = detailModel();
    if (m.status !== 'ready' || !m.canWrite) return;
    const aff = m.uid ? affectedGroups(S.data.groups(), m.uid) : { count: 0, names: [], groups: [] };
    const named = isolate(m.name);
    const note = aff.count ? h('p', { class: 'notice', testid: 'delete-groups-note' }, t('contact.delete.groups', { count: aff.count, names: aff.names.map((n) => isolate(n)).join(', ') })) : null;
    const yes = await confirmDialog({
      testid: 'dialog-delete-contact',
      confirmTestid: 'dialog-confirm-delete',
      cancelTestid: 'dialog-cancel',
      title: t('contact.delete.title', { name: named }),
      message: t('contact.delete.text'),
      confirmLabel: t('contact.deleteNamed', { name: named }),
      cancelLabel: t('dialog.cancel'),
      danger: true,
      write: true,
      body: note ? [note] : [],
      t,
      win: d.win,
    });
    stripDialog();
    if (!yes) return;
    const writes = S.storeCtx.writes;
    let res = await writes.deleteItem({ collection: S.pick.book.href, href: m.href, etag: m.etag, uid: m.uid, groupHrefs: aff.groups.map((g) => g.href) });
    if (res.status === 'changed-elsewhere') {
      res = await d.openConflictDialog({ conflict: res, t, writes, label: m.name, feedback: app.feedback, win: d.win });
      if (res && res.status === 'reloaded') {
        await refreshAndRender();
        return;
      }
    }
    if (res && res.ok && (res.status === 'deleted' || res.status === 'already-deleted')) nav(listHash(cleanQuery({ ab: params().ab, q: S.q, group: S.group })));
  }

  async function addToGroup() {
    const m = detailModel();
    if (m.status !== 'ready' || !m.canWrite) return;
    const groups = S.data.groups();
    const mine = new Set(m.groupLinks.map((g) => g.key));
    const options = groups.filter((g) => !mine.has(g.key)).map((g) => ({ id: g.href, label: g.name, sublabel: tp('groups.members', g.memberCount, { n: fmtNumber(lang, g.memberCount) }), disabled: g.readOnly }));
    if (!options.length) {
      say('status', t('contact.addToGroup.none'));
      return;
    }
    const chosen = await openPicker({ name: 'group', title: t('contact.addToGroupTitle', { name: isolate(m.name) }), description: t('contact.addToGroupText'), searchLabel: t('groups.picker.search'), options, t, tp, win: d.win, timers: d.timers });
    if (!chosen || !chosen.length) return;
    const group = groups.find((g) => g.href === chosen[0]);
    if (!group) return;
    const patch = addMemberPatch(group, m.summary);
    if (!patch.ok) {
      say('alert', t(patch.key));
      return;
    }
    if (patch.noop) {
      say('status', t('contact.addToGroup.already'));
      return;
    }
    const e = S.data.entry(group.href);
    await S.storeCtx.writes.putGroupMembers({ collection: S.pick.book.href, href: group.href, delta: patch.patch.membersDelta, base: e ? { text: e.text, etag: e.etag } : undefined });
  }

  function stripDialog() {
    if (params().dialog) nav(S.key ? contactHash(S.key, cleanQuery({ ab: params().ab })) : listHash(cleanQuery({ ab: params().ab })), { replace: true });
  }

  // ------------------------------------------------------------------ rendering

  const listPane = createListPane({
    t,
    tp,
    lang,
    ops,
    deps: { timers: d.timers },
  });
  const detailPane = createDetailPane({
    t,
    tp,
    lang,
    ops: { onEdit: () => nav(editHash(S.key, cleanQuery(bookQuery()))), onDelete: () => deleteContact(), onExport: () => exportContact(), onAddToGroup: () => addToGroup() },
    deps: { now: d.now },
  });
  rootEl.append(listPane.el, detailPane.el);
  ctx.root.append(rootEl);
  if (ctx.restore && typeof ctx.restore.q === 'string') listPane.search.value = ctx.restore.q;

  function renderAll() {
    if (disposed) return;
    const lm = listModel();
    listPane.render(lm);
    S.typing = false;
    S.forceQ = false;
    detailPane.render(detailModel());
    const selected = Boolean(S.key);
    rootEl.setAttribute('data-view', selected ? 'detail' : 'list');
    rootEl.classList.toggle('has-selection', selected);
    rootEl.setAttribute('data-state', S.status === 'loading' ? 'loading' : ['ready', 'nobook', 'noaccess'].includes(S.status) ? 'ready' : 'error');
  }

  async function refreshAndRender() {
    if (S.data) await S.data.refresh();
    renderAll();
  }

  // ------------------------------------------------------------------ loading

  function readParams() {
    const p = params();
    S.key = typeof p.key === 'string' ? p.key : '';
    S.q = typeof p.q === 'string' ? p.q : '';
    S.group = typeof p.group === 'string' ? p.group : '';
    const from = p.from;
    S.from = typeof from === 'string' && LETTERS.includes(from) ? from : /^\d{1,7}$/.test(String(from || '')) ? Number(from) : undefined;
    if (typeof p.from === 'string' && LETTERS.includes(p.from)) S.size = WINDOW_SIZE;
  }

  function release() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (unregisterStore) unregisterStore();
    unregisterStore = null;
    if (S.data) S.data.dispose();
    S.data = null;
  }

  async function load(force = false) {
    const prev = S.pick && S.pick.state === 'ok' ? S.pick.book.href : null;
    try {
      if (!S.storeCtx) S.storeCtx = await app.getStore();
      if (disposed) return;
      const { access } = S.storeCtx;
      if (force) await access.refetch({ reason: 'retry' });
      else await access.load();
      if (disposed) return;
      const pick = pickBook(access, params());
      S.pick = pick;
      if (pick.state !== 'ok') {
        release();
        if (pick.state === 'error') return fail(pick.error);
        S.status = pick.state;
        return done(true);
      }
      if (prev !== pick.book.href || !S.data || force) {
        release();
        S.data = createBookData({ storeCtx: S.storeCtx, session: app.session, book: pick.book, yieldFn: d.yieldFn });
        if (params().ab) access.setLastBook(pick.book.href);
      }
      const store = S.data.store;
      if (!store.loaded || force) {
        const res = await store.sync({ reason: 'load' });
        if (disposed) return;
        if (!res.ok && store.size === 0) return fail(res.error || res);
      }
      await S.data.refresh();
      if (disposed) return;
      if (!unsubscribe) {
        unsubscribe = S.data.subscribe(() => refreshAndRender());
        unregisterStore = S.storeCtx.scheduler.register(store, domCallbacks({ listEl: listPane.list, rootEl }));
        S.storeCtx.scheduler.enter(store, domCallbacks({ listEl: listPane.list, rootEl }));
      }
      S.status = 'ready';
      S.errorText = '';
      done(true);
    } catch (e) {
      if (!disposed) fail(e);
    }
  }

  function fail(err) {
    const kind = err && typeof err.kind === 'string' && !err.name ? err.kind : classify(err).kind;
    S.status = d.isOnline() ? 'error' : 'offline';
    S.errorText = t(davErrorKey(kind));
    done(false);
  }

  function done(ok) {
    renderAll();
    endLoad(ok);
    if (ok) handleDialog();
  }

  /** `?dialog=delete` (on a contact) and `?dialog=import` open their dialog; the parameter is then removed. */
  async function handleDialog() {
    const dialog = params().dialog;
    if (S.status !== 'ready' || !dialog) return;
    if (dialog === 'delete' && S.key) await deleteContact();
    else if (dialog === 'import') {
      stripDialog();
      await openImport();
    }
  }

  readParams();
  if (ctx.restore && typeof ctx.restore.q === 'string' && !S.q) S.q = ctx.restore.q;
  S.typedQ = S.q;
  renderAll();
  S.loading = load();

  return {
    wide: true,
    get title() {
      const s = selectedSummary();
      return s ? nameOf(s, t) : t('contacts.title');
    },
    /** Same screen, other route: keep the DOM (scroll, search text, focus), reload only when the book changed. */
    async update(next) {
      current = next;
      t = next.t || t;
      readParams();
      // A search text that arrives from the URL (Back, a link, a typed address) and is not what the user last typed
      // replaces the box even while it has the focus; our own debounced push of the typed text does not.
      if (S.q !== (S.typedQ.trim() ? S.typedQ : '')) {
        S.forceQ = true;
        S.typedQ = S.q;
      }
      const wanted = next.params && typeof next.params.ab === 'string' ? next.params.ab : '';
      if (S.loading) await S.loading;
      const bare = (x) => String(x).replace(/\/$/, '');
      const needReload = !S.pick || S.pick.state !== 'ok' || (wanted !== '' && bare(S.pick.book.href) !== bare(wanted));
      if (needReload) {
        S.status = 'loading';
        S.key = '';
        readParams();
        renderAll();
        S.loading = load();
        await S.loading;
      } else {
        const end = app.readiness ? app.readiness.begin() : () => {};
        renderAll();
        end(true);
      }
      await handleDialog();
    },
    snapshot: () => ({ q: listPane.search.value }),
    dispose() {
      disposed = true;
      pushSearch.cancel();
      release();
      listPane.dispose();
      clear(rootEl);
      rootEl.remove();
    },
  };
}
