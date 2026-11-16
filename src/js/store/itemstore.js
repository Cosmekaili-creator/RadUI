// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-collection item store. It holds the SERVER TEXT AND ETAG of every item and nothing else
// (addendum B2 / M2): never an `Item`, so a failed write can never leave unsent edits behind.
// Views and the write path open a fresh `openItem(text)` whenever they need one.
//
//  - sync: the existing `syncStep` (sync-collection first, ETag listing as fallback, decision D5);
//    changed items arrive through multiget; one sync of a store at a time;
//  - summary index: an optional `indexer(text, href)` is called for every item that arrives (the
//    contacts index is built by the contacts layer from the text); `{upsert, remove, clear}`
//    objects are accepted too;
//  - events: `subscribe(fn)` gets {type: 'sync'|'write'|'state', ...};
//  - `refresh({reason})` is a sync; `reload()` forgets the sync state and lists everything again;
//  - the write path reports its results through `applyWrite` / `applyDelete`; a sync that was
//    running while an item was written never overwrites that item with its older view of it.
//
// No DOM, no timers: the scheduler decides when to sync.

import { createSyncState, resetStatus, syncStep } from '../dav/sync.js';
import { classify } from './errors.js';

function normaliseIndexer(indexer) {
  if (!indexer) return null;
  if (typeof indexer === 'function') return { upsert: indexer, remove: null, clear: null };
  const upsert = indexer.upsert || indexer.index || null;
  return { upsert, remove: indexer.remove || null, clear: indexer.clear || null };
}

/**
 * @param {object} o
 * @param {object} o.client DAV client
 * @param {string} o.href collection href (ends with `/`)
 * @param {'calendar'|'addressbook'} o.kind
 * @param {Function|object} [o.indexer]
 * @param {() => number} [o.now] ms clock (injected for tests)
 * @param {object} [o.reporter] store/report.js reporter (Activity lines for syncs)
 * @param {(signals: object, store: object) => void} [o.onAccessSignal] called when a sync says access changed
 */
export function createItemStore({ client, href, kind, indexer = null, now = Date.now, reporter = null, onAccessSignal = null } = {}) {
  let state = createSyncState({ href, kind });
  const items = new Map();
  const idx = normaliseIndexer(indexer);
  const listeners = new Set();
  const writtenDuringSync = new Set();
  let inflight = null;
  let disposed = false;
  let loaded = false;
  let lastSync = 0;
  let lastError = null;
  let errorStreak = 0;
  let indexErrors = 0;
  let syncs = 0;

  const emit = (ev) => {
    for (const fn of [...listeners]) {
      try {
        fn(ev);
      } catch {
        /* a failing subscriber must not break the others */
      }
    }
  };
  const safe = (fn) => {
    try {
      fn();
    } catch {
      indexErrors++;
    }
  };
  const label = () => {
    const segs = href.split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : href;
  };
  const index = (text, h) => {
    if (idx && idx.upsert) safe(() => idx.upsert(text, h));
  };
  const unindex = (h) => {
    if (idx && idx.remove) safe(() => idx.remove(h));
  };
  const entry = (h, etag, text) => Object.freeze({ href: h, etag, text });

  function apply(res, { reset }) {
    const touched = new Set(writtenDuringSync);
    const upserted = [];
    const removed = [];
    if (reset) {
      items.clear();
      if (idx && idx.clear) safe(() => idx.clear());
    }
    let needFull = false;
    for (const u of res.upserted) {
      if (touched.has(u.href)) {
        // a local write is newer than this sync's view; if the server's version is another one, list everything
        // again next time (an empty token) so the difference is fetched then
        const mine = items.get(u.href);
        if (!mine || mine.etag !== u.etag) needFull = true;
        continue;
      }
      items.set(u.href, entry(u.href, u.etag, u.text));
      index(u.text, u.href);
      upserted.push(u.href);
    }
    for (const h of res.removed) {
      if (touched.has(h) && items.has(h)) {
        needFull = true;
        continue;
      }
      if (items.delete(h)) {
        unindex(h);
        removed.push(h);
      }
    }
    // The sync state must agree with what the store holds for the items written meanwhile.
    const etags = { ...res.state.etags };
    for (const h of touched) {
      const mine = items.get(h);
      if (mine) etags[h] = mine.etag;
      else delete etags[h];
    }
    state = { ...res.state, etags, ...(needFull ? { token: null } : {}) };
    return { upserted, removed };
  }

  function sync({ reason = 'manual', reset = false } = {}) {
    if (disposed) return Promise.resolve({ ok: false, skipped: 'disposed', reason });
    if (inflight) return inflight;
    const p = (async () => {
      writtenDuringSync.clear();
      syncs++;
      emit({ type: 'state', syncing: true, reason });
      try {
        const start = reset ? createSyncState({ href, kind }) : state;
        const res = await syncStep(client, start);
        if (disposed) return { ok: false, skipped: 'disposed', reason };
        const { upserted, removed } = apply(res, { reset });
        loaded = loaded || res.state.status === 'ok';
        lastSync = now();
        lastError = null;
        const hadErrors = errorStreak > 0;
        errorStreak = 0;
        const signals = res.signals;
        const result = { ok: true, reason, via: res.via, status: res.state.status, upserted, removed, changed: upserted.length + removed.length > 0, signals, recovered: hadErrors };
        if (reporter && (result.changed || reason === 'load' || reason === 'manual' || hadErrors)) {
          reporter.log('sync', label(), 'ok', `+${upserted.length} -${removed.length} ${res.via}`);
        }
        emit({ type: 'sync', ...result });
        if (signals && signals.refetchAccess && onAccessSignal) {
          try {
            onAccessSignal(signals, store);
          } catch {
            /* the access refetch is best effort */
          }
        }
        return result;
      } catch (e) {
        if (disposed) return { ok: false, skipped: 'disposed', reason };
        const c = classify(e);
        lastError = { kind: c.kind, status: c.status, message: c.message };
        errorStreak++;
        if (reporter && errorStreak === 1) reporter.log('sync', label(), 'error', c.kind + (c.status ? ' ' + c.status : ''));
        const result = { ok: false, reason, error: lastError, kind: c.kind, fatal: c.kind === 'auth' };
        emit({ type: 'sync', ...result });
        return result;
      }
    })().finally(() => {
      inflight = null;
      writtenDuringSync.clear();
      emit({ type: 'state', syncing: false, reason });
    });
    inflight = p;
    return p;
  }

  const store = {
    href,
    kind,
    sync,
    /** Same as sync({reason}); the name the views use. */
    refresh: ({ reason = 'refresh' } = {}) => sync({ reason }),
    /** Forget the sync token and the known ETags, list and fetch everything again. */
    reload: ({ reason = 'reload' } = {}) => sync({ reason, reset: true }),
    /** After the access list was refetched and the collection is reachable again. */
    revive() {
      state = resetStatus(state);
    },
    get(h) {
      return items.get(h) || null;
    },
    has: (h) => items.has(h),
    list: () => [...items.values()],
    hrefs: () => [...items.keys()],
    get size() {
      return items.size;
    },
    get syncing() {
      return inflight !== null;
    },
    get loaded() {
      return loaded;
    },
    /** ms clock value of the last successful sync, 0 when there was none. */
    get lastSync() {
      return lastSync;
    },
    get lastError() {
      return lastError;
    },
    get errorStreak() {
      return errorStreak;
    },
    /** 'ok' | 'inaccessible' | 'missing' (from the sync state). */
    get status() {
      return state.status;
    },
    get syncToken() {
      return state.token;
    },
    get syncCount() {
      return syncs;
    },
    get indexErrors() {
      return indexErrors;
    },
    get disposed() {
      return disposed;
    },

    /** The write path stored a new server version of an item (text and ETag as GET returned them). */
    applyWrite(h, { etag, text }) {
      if (disposed) return null;
      const e = entry(h, etag, text);
      items.set(h, e);
      index(text, h);
      state = { ...state, etags: { ...state.etags, [h]: etag } };
      if (inflight) writtenDuringSync.add(h);
      emit({ type: 'write', op: 'put', href: h });
      return e;
    },
    /** The write path (or a sync) found the item gone. */
    applyDelete(h) {
      if (disposed) return false;
      const had = items.delete(h);
      if (had) unindex(h);
      if (h in state.etags) {
        const etags = { ...state.etags };
        delete etags[h];
        state = { ...state, etags };
      }
      if (inflight) writtenDuringSync.add(h);
      if (had) emit({ type: 'write', op: 'delete', href: h });
      return had;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      items.clear();
      if (idx && idx.clear) safe(() => idx.clear());
      listeners.clear();
    },
  };
  return store;
}

/**
 * The stores of one session, one per collection. Disposing the session disposes them all
 * (they are registered with it) and `stores.all()` is empty afterwards.
 */
export function createStores({ client, session = null, now = Date.now, reporter = null, onAccessSignal = null } = {}) {
  const byHref = new Map();
  const norm = (h) => (h.endsWith('/') ? h : h + '/');
  const registry = {
    /** The store of a collection, created on first use. `indexer` is used only when it is created. */
    open({ href, kind }, { indexer = null } = {}) {
      const key = norm(href);
      let s = byHref.get(key);
      if (!s || s.disposed) {
        s = createItemStore({ client, href: key, kind, indexer, now, reporter, onAccessSignal });
        byHref.set(key, s);
        if (session) session.register(s);
      }
      return s;
    },
    get: (href) => byHref.get(norm(href)) || null,
    /** Dispose and forget one store (a deleted collection). */
    drop(href) {
      const key = norm(href);
      const s = byHref.get(key);
      if (!s) return false;
      byHref.delete(key);
      s.dispose();
      if (session) session.unregister(s);
      return true;
    },
    all: () => [...byHref.values()],
    dispose() {
      for (const s of byHref.values()) s.dispose();
      byHref.clear();
    },
  };
  if (session) session.onDispose(() => registry.dispose());
  return registry;
}
