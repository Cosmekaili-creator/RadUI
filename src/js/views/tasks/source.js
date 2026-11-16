// SPDX-License-Identifier: AGPL-3.0-or-later
// The data layer of the task screens (RUN3 WP C1, no DOM): which task lists exist for the account, which are loaded
// (enabled in ctx.calendars: one polled store each), the described task records, and the lookup of one task by route key.
//
// The stores hold server text only; this module parses for READING (calendars.parse, cached per ETag). Nothing here
// writes. A list becomes "loaded" when it is first switched on: only then it is fetched and polled. Hidden lists stay
// loaded while the screen is open (showing them again is instant, and a child task can find its parent there); they are
// released when the screen is disposed. Same model as views/calendar/source.js.

import { collectionForParam } from '../../router.js';
import { describeTask, makeTaskKeyer } from '../../tasks/list.js';
import { COLOUR_ALLOW, FALLBACK_COLOUR, normHref } from './common.js';

const MAX_KEY = 255;
const leaf = (href) => {
  const s = String(href).split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Calendars of the account that accept tasks (a component set that is unknown counts as accepting them). */
export function taskLists(access) {
  return access.calendars().filter((c) => !Array.isArray(c.components) || c.components.length === 0 || c.components.includes('VTODO'));
}

/**
 * @param {object} o
 * @param {object} o.storeCtx store context (access, stores, calendars, writes)
 */
export function createTaskSource({ storeCtx }) {
  const { access, calendars: cals } = storeCtx;
  const enabledHere = new Set();
  const loading = new Set();
  const failed = new Map();
  const listeners = new Set();
  let disposed = false;
  const emit = (ev) => {
    for (const fn of [...listeners]) {
      try {
        fn(ev);
      } catch {
        /* a failing subscriber must not break the others */
      }
    }
  };
  const off = cals.subscribe((ev) => emit(ev));
  const list = () => taskLists(access);

  const source = {
    /** The lists shown: [{href, name, color, level, canWrite, owner, ownerIsMe, loaded, loading, failed}]. */
    lists() {
      return list().map((c) => ({
        href: normHref(c.href),
        name: c.label || c.displayName || c.name || c.href,
        color: typeof c.color === 'string' && COLOUR_ALLOW.test(c.color.trim()) ? c.color.trim() : FALLBACK_COLOUR,
        level: c.level,
        canWrite: access.canWrite(c),
        ownerIsMe: Boolean(c.ownerIsMe),
        owner: c.owner || null,
        loaded: cals.isEnabled(c.href),
        loading: loading.has(normHref(c.href)),
        failed: failed.get(normHref(c.href)) || null,
      }));
    },
    /** Lists the account may write tasks in (targets of a new task). */
    writable: () => list().filter((c) => access.canWrite(c)),
    isReadOnly: (href) => !access.canWrite(href),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Switch a list on: enable, fetch it once. Resolves `{ok}`; a failure is remembered on the row. */
    async load(href) {
      const key = normHref(href);
      if (disposed) return { ok: false };
      if (cals.isEnabled(key)) {
        const st = cals.store(key);
        if (st && st.loaded) return { ok: true };
      }
      loading.add(key);
      failed.delete(key);
      emit({ type: 'loading', collection: key });
      const store = cals.enable({ href: key, kind: 'calendar' });
      enabledHere.add(key);
      let res = { ok: false };
      try {
        await cals.ready();
        res = store ? await store.sync({ reason: 'load' }) : { ok: false };
      } catch (e) {
        res = { ok: false, kind: (e && e.kind) || 'unknown' };
      }
      loading.delete(key);
      if (!res.ok && !res.skipped) failed.set(key, res.kind || 'unknown');
      emit({ type: 'loaded', collection: key, ok: Boolean(res.ok) });
      return res;
    },
    isLoaded: (href) => cals.isEnabled(href) && Boolean(cals.store(href) && cals.store(href).loaded),

    /**
     * The described tasks of every loaded list (hidden ones included: parents are looked up there; the screen filters
     * by visibility). Each record gets `routeKey` (UID when unique in its list, else the file name) and `listReadOnly`.
     */
    records({ tz, now }) {
      const { entries, unreadable, loading: modelLoading } = cals.entries({ kind: 'task' });
      const records = [];
      let skipped = unreadable.filter((u) => enabledHere.has(u.collection)).length;
      for (const e of entries) {
        if (!enabledHere.has(e.collection)) continue;
        const rec = describeTask({ href: e.href, collection: e.collection, etag: e.etag, item: e.item }, { tz, now });
        if (rec) records.push(rec);
        else skipped += 1;
      }
      const keyer = makeTaskKeyer(records);
      for (const r of records) {
        r.routeKey = keyer(r);
        r.listReadOnly = source.isReadOnly(r.collection);
      }
      return { records, unreadable: skipped, loadingModel: modelLoading };
    },
    /** The current stored `{text, etag}` of a task (the base of a one-tap write), or null. */
    baseOf(href) {
      for (const key of enabledHere) {
        const st = cals.store(key);
        const e = st ? st.get(href) : null;
        if (e) return { text: e.text, etag: e.etag };
      }
      return null;
    },

    /**
     * Find a task by route key in a list: `{state: 'ok', entry, item, collection}` or `{state: 'notfound' | 'nolist' |
     * 'unreadable' | 'error', ...}`. `list` must match a discovered list (never guessed); the list is loaded first.
     */
    async resolve({ key, list: listParam }) {
      const coll = collectionForParam(listParam, list());
      if (!coll) return { state: 'nolist' };
      if (typeof key !== 'string' || key === '' || key.length > MAX_KEY) return { state: 'notfound', collection: coll };
      const res = await source.load(coll.href);
      if (!res.ok && !res.skipped && !(cals.store(coll.href) && cals.store(coll.href).size)) return { state: 'error', collection: coll, kind: res.kind || 'unknown' };
      await cals.ready();
      const store = cals.store(coll.href);
      const parsed = (store ? store.list() : []).map((entry) => ({ entry, p: cals.parse(entry) }));
      const byUid = parsed.filter((x) => x.p.ok && x.p.kind === 'task' && x.p.uid === key);
      const hit = byUid.length === 1 ? byUid[0] : parsed.find((x) => leaf(x.entry.href) === key) || null;
      if (!hit) return { state: 'notfound', collection: coll };
      if (!hit.p.ok) return { state: 'unreadable', collection: coll, entry: hit.entry, reason: hit.p.reason || 'parse-error' };
      if (hit.p.kind !== 'task') return { state: 'notfound', collection: coll };
      return { state: 'ok', collection: coll, entry: hit.entry, item: hit.p, key };
    },
    /** The parent and children of a task among the loaded lists, for the detail (read-only). */
    relatives(rec, { tz, now }) {
      const { records } = source.records({ tz, now });
      const same = (r) => r.collection === rec.collection;
      const parent = rec.parentUids.map((u) => records.find((r) => r.uid === u && same(r)) || records.find((r) => r.uid === u)).find(Boolean) || records.find((r) => r.childUids.includes(rec.uid) && same(r)) || null;
      const children = records.filter((r) => r !== rec && (r.parentUids.includes(rec.uid) || rec.childUids.includes(r.uid)) && r.collection === rec.collection);
      return { parent, children, missingParent: !parent && rec.parentUids.length > 0 };
    },
    dispose() {
      disposed = true;
      off();
      listeners.clear();
      for (const key of enabledHere) cals.disable(key);
      enabledHere.clear();
    },
  };
  return source;
}
