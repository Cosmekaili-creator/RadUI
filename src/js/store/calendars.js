// SPDX-License-Identifier: AGPL-3.0-or-later
// Calendar store manager (RUN3 D-R3-5.6). One item store per ENABLED calendar or task list: created on enable,
// disposed on disable and on sign-out; only enabled stores are registered with the scheduler, so only they are polled.
// Full collection sync (sync-collection, ETag listing as the fallback), never a time-range query (Q-R3-8).
//
// Stores hold server text and ETag only. For READING, this module parses each item once per ETag (cache keyed by
// href + etag, one entry per href, so a changed item replaces its entry); the parsed Item is never used for a write
// (writes re-open a fresh item, store/writes.js).
//
//   const cals = createCalendars({stores, scheduler, session, model});
//   cals.enable({href, kind: 'calendar'});  cals.disable(href);  cals.setEnabled([{href, kind}, ...]);
//   cals.occurrences(fromMs, toMs)  -> {occurrences, truncated, unreadable, loading}
//   cals.entries({kind: 'task'})    -> [{collection, href, etag, text, item}] for the enabled stores
//
// No DOM. The event model is loaded lazily (`ready()`, started by the first `enable`); until it is there `occurrences()` answers `loading: true`.

const DAY = 86400000;
export const DEFAULT_ITEM_LIMIT = 2000;

/**
 * @param {object} o
 * @param {object} o.stores store registry (createStores)
 * @param {object} [o.scheduler]
 * @param {object} [o.session] session container (disposal)
 * @param {{openItem: Function}} [o.model] injected for tests; lazily imported otherwise
 * @param {number} [o.limit] per-item occurrence limit (default 2000)
 */
export function createCalendars({ stores, scheduler = null, session = null, model = null, limit = DEFAULT_ITEM_LIMIT } = {}) {
  if (!stores) throw new TypeError('createCalendars needs the item stores');
  const enabled = new Map(); // href -> {store, off, kind}
  const cache = new Map(); // item href -> {etag, parsed}
  const listeners = new Set();
  let openItem = model ? model.openItem : null;
  let disposed = false;
  let readyPromise = model ? Promise.resolve() : null;
  // the model (ical.js) is loaded when the first calendar is enabled, never for a contacts-only session
  const load = () => readyPromise || (readyPromise = import('../model/item.js').then((m) => void (openItem = m.openItem)));
  const norm = (h) => (h.endsWith('/') ? h : h + '/');

  const emit = (ev) => {
    for (const fn of [...listeners]) {
      try {
        fn(ev);
      } catch {
        /* a failing subscriber must not break the others */
      }
    }
  };

  function parsed(entry) {
    const hit = cache.get(entry.href);
    if (hit && hit.etag === entry.etag) return hit.parsed;
    const p = openItem(entry.text);
    cache.set(entry.href, { etag: entry.etag, parsed: p });
    return p;
  }

  const api = {
    /** Starts loading the model if needed; resolves when it is there. */
    ready: load,
    /** Start (and poll) one calendar or task list. Idempotent. Returns its item store. */
    enable({ href, kind = 'calendar' }, callbacks = {}) {
      if (disposed) return null;
      const key = norm(href);
      const have = enabled.get(key);
      if (have && !have.store.disposed) return have.store;
      void load();
      const store = stores.open({ href: key, kind });
      const off = store.subscribe((ev) => emit({ ...ev, collection: key }));
      enabled.set(key, { store, off, kind });
      if (scheduler) void scheduler.enter(store, callbacks);
      emit({ type: 'toggle', collection: key, enabled: true });
      return store;
    },
    /** Stop polling and drop the store and its parse cache. */
    disable(href) {
      const key = norm(href);
      const e = enabled.get(key);
      if (!e) return false;
      enabled.delete(key);
      e.off();
      if (scheduler) scheduler.unregister(e.store);
      for (const h of e.store.hrefs()) cache.delete(h);
      stores.drop(key);
      emit({ type: 'toggle', collection: key, enabled: false });
      return true;
    },
    /** Make the enabled set exactly `list` ([{href, kind}]). */
    setEnabled(list) {
      const want = new Map(list.map((c) => [norm(c.href), c]));
      for (const key of [...enabled.keys()]) if (!want.has(key)) api.disable(key);
      for (const [, c] of want) api.enable(c);
    },
    isEnabled: (href) => enabled.has(norm(href)),
    enabledHrefs: () => [...enabled.keys()],
    store: (href) => (enabled.get(norm(href)) ? enabled.get(norm(href)).store : null),
    /** `fn({type: 'sync'|'write'|'state'|'toggle', collection, ...})`; returns the unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The parsed Item of a stored entry (cached per ETag): `{ok: true, ...Item}` or `{ok: false, reason}`. For reading only. */
    parse(entry) {
      if (!openItem) return { ok: false, reason: 'loading' };
      return parsed(entry);
    },
    /**
     * Entries of the enabled stores of a kind ('calendar' stores hold events and tasks, so filter by item kind):
     * `[{collection, href, etag, text, item}]` where `item` is the parsed Item or null when it cannot be read;
     * `unreadable` lists what could not be opened. `kind` is the ITEM kind: 'event' or 'task'.
     */
    entries({ kind = null } = {}) {
      const out = [];
      const unreadable = [];
      if (!openItem) return { entries: out, unreadable, loading: true };
      for (const [collection, e] of enabled) {
        for (const entry of e.store.list()) {
          const p = parsed(entry);
          if (!p.ok) {
            unreadable.push({ collection, href: entry.href, reason: p.reason });
            continue;
          }
          if (kind && p.kind !== kind) continue;
          out.push({ collection, href: entry.href, etag: entry.etag, text: entry.text, item: p });
        }
      }
      return { entries: out, unreadable, loading: false };
    },
    /**
     * Occurrences of every enabled calendar in [from, to) (ms instants). The window is padded by one day on both sides
     * (all-day and floating values compare by wall clock); callers lay out what they show. Each occurrence is the
     * model's (`start`, `end`, `allDay`, `source`, `recurrenceId`, ...) plus `collection`, `href`, `etag`, `uid`.
     * A series is expanded to at most `limit` occurrences (2,000): `truncated` is then true. Items that cannot be
     * opened are listed in `unreadable`; tasks are not occurrences.
     */
    occurrences(from, to, { limit: itemLimit = limit } = {}) {
      const res = { occurrences: [], truncated: false, unreadable: [], loading: false };
      if (!openItem) return { ...res, loading: true };
      const lo = Number.isFinite(from) ? from - DAY : -Infinity;
      const hi = Number.isFinite(to) ? to + DAY : Infinity;
      const { entries, unreadable } = api.entries({ kind: 'event' });
      res.unreadable = unreadable;
      for (const e of entries) {
        let ex;
        try {
          ex = e.item.expand({ from: lo, to: hi, limit: itemLimit });
        } catch {
          res.unreadable.push({ collection: e.collection, href: e.href, reason: 'expand-failed' });
          continue;
        }
        if (ex.truncated) res.truncated = true;
        for (const o of ex.occurrences) res.occurrences.push({ ...o, collection: e.collection, href: e.href, etag: e.etag, uid: e.item.uid });
      }
      res.occurrences.sort((a, b) => (a.start.instant ?? a.start.wallMs) - (b.start.instant ?? b.start.wallMs));
      return res;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const key of [...enabled.keys()]) api.disable(key);
      cache.clear();
      listeners.clear();
    },
  };
  if (session) session.onDispose(() => api.dispose());
  return api;
}
