// SPDX-License-Identifier: AGPL-3.0-or-later
// The collections the signed-in account can reach, with the access LEVEL of each.
//
//   level 'own'       a collection of the account itself, ONLY while `me.ownSpace` is true (m10:
//                     with ownSpace off the owner has no rule on it and it is not offered)
//   level 'readwrite' a grant with level readwrite
//   level 'read'      a grant with level read (also the answer for a grant without a usable level)
//
// The level comes from `GET me` and `GET me/access` ONLY. The DAV privilege list is never used to
// decide anything (a read-write grantee is shown `write-properties` yet may not PROPPATCH): the
// `privileges` field is dropped from the entries on purpose. When the server answers 403 to a write
// the caller refetches (`refetch({reason: '403'})`) and the level is recomputed.
//
// No DOM. `discover` and the API are injected, so unit tests use fakes.

import { discoverAccessible } from '../dav/discovery.js';

export const LEVELS = Object.freeze(['read', 'readwrite', 'own']);

/** May the account write items (and import) in this collection? */
export const canWrite = (c) => Boolean(c) && (c.level === 'readwrite' || c.level === 'own');
/** May the account edit, delete or share the collection itself? Only the owner. */
export const canManage = (c) => Boolean(c) && c.level === 'own';

/**
 * Pure: build the accessible list from the account facts and one discovery result.
 * @param {{me: object|null, discovery: {collections: object[]}}} input `me` is null for a limited
 *   (DAV-only) sign-in: own space is then assumed, the server stays the authority.
 * @returns {{collections: object[], problems: object[], ownSpace: boolean}}
 */
export function buildAccessList({ me, discovery }) {
  const ownSpace = me ? me.ownSpace !== false : true;
  const collections = [];
  const problems = [];
  for (const entry of (discovery && discovery.collections) || []) {
    if (!entry || entry.status !== 'ok') {
      problems.push({ href: entry ? entry.href : null, owner: entry ? entry.owner : null, source: entry ? entry.source : null, status: entry ? entry.status : 'error', reason: 'unavailable' });
      continue;
    }
    let level;
    if (entry.source === 'own') {
      if (!ownSpace) {
        problems.push({ href: entry.href, owner: entry.owner, source: 'own', status: 'ok', reason: 'own-space-disabled' });
        continue;
      }
      level = 'own';
    } else {
      level = entry.level === 'readwrite' ? 'readwrite' : 'read';
    }
    // eslint-disable-next-line no-unused-vars
    const { privileges, ...rest } = entry;
    collections.push({
      ...rest,
      level,
      ownerIsMe: entry.source === 'own',
      readOnly: level === 'read',
      label: entry.displayName || entry.name || entry.href,
    });
  }
  return { collections, problems, ownSpace };
}

/**
 * @param {object} o
 * @param {{me: Function, meAccess: Function}} o.api
 * @param {object} o.client DAV client (discovery runs on it)
 * @param {object} [o.session] session container: `lastBook` / `setLastBook` keep the per-login preference
 * @param {Function} [o.discover] defaults to discoverAccessible(client, {meAccess})
 */
export function createAccess({ api, client, session = null, discover = discoverAccessible } = {}) {
  let me = null;
  let list = [];
  let problems = [];
  let ownSpace = true;
  let loaded = false;
  let lastError = null;
  let inflight = null;
  let disposed = false;
  let homes = null;
  const listeners = new Set();
  const emit = (ev) => {
    for (const fn of [...listeners]) {
      try {
        fn(ev);
      } catch {
        /* a failing subscriber must not break the others */
      }
    }
  };

  async function run(reason) {
    let meResult = null;
    let meError = null;
    try {
      meResult = await api.me();
    } catch (e) {
      meError = e;
      if (e && e.name === 'ApiError' && e.kind === 'auth') throw e;
    }
    const discovery = await discover(client, api);
    return { meResult, meError, discovery, reason };
  }

  const access = {
    /** (Re)load `me`, `me/access` and the discovery. Concurrent calls share one run. Never rejects. */
    refetch({ reason = 'refetch' } = {}) {
      if (disposed) return Promise.resolve({ ok: false, error: new Error('disposed') });
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const r = await run(reason);
          if (disposed) return { ok: false, error: new Error('disposed') };
          me = r.meResult;
          const built = buildAccessList({ me, discovery: r.discovery });
          list = built.collections;
          problems = built.problems;
          ownSpace = built.ownSpace;
          loaded = true;
          lastError = r.discovery.ownError || null;
          emit({ type: 'access', reason, count: list.length });
          return { ok: true, error: lastError, apiError: r.discovery.apiError || null, meError: r.meError || null };
        } catch (e) {
          lastError = e;
          emit({ type: 'error', reason, error: e });
          return { ok: false, error: e };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    load(opts) {
      return loaded && !(opts && opts.force) ? Promise.resolve({ ok: true, error: lastError }) : access.refetch({ reason: (opts && opts.reason) || 'load' });
    },
    get loaded() {
      return loaded;
    },
    get me() {
      return me;
    },
    get ownSpace() {
      return ownSpace;
    },
    get lastError() {
      return lastError;
    },
    /** All accessible collections (copies of the entries are not made: treat them as read-only). */
    list: () => list.slice(),
    problems: () => problems.slice(),
    get: (href) => (typeof href === 'string' ? list.find((c) => c.href === href || c.href === href + '/' || c.href + '/' === href) || null : null),
    byKind: (kind) => list.filter((c) => c.kind === kind),
    addressbooks: () => list.filter((c) => c.kind === 'addressbook'),
    calendars: () => list.filter((c) => c.kind === 'calendar'),
    /** Collections of a kind the account may write items in. */
    writable: (kind) => list.filter((c) => (!kind || c.kind === kind) && canWrite(c)),
    /** The level of a collection, or null when it is not in the list (the server stays the authority). */
    levelOf(x) {
      const c = typeof x === 'string' ? access.get(x) : x;
      return c ? c.level : null;
    },
    canWrite: (x) => canWrite(typeof x === 'string' ? access.get(x) : x),
    canManage: (x) => canManage(typeof x === 'string' ? access.get(x) : x),
    /** Own space switched on: may the account create collections at all? */
    canCreateCollections: () => ownSpace,
    /** Home sets for creating collections (own principal), read once. */
    async homeSets() {
      if (!homes) homes = await client.homeSets();
      return homes;
    },
    /** Local update after a successful PROPPATCH (displayName, color, description). */
    patchCollection(href, changes) {
      const i = list.findIndex((c) => c.href === href);
      if (i < 0) return false;
      const next = { ...list[i] };
      for (const k of ['displayName', 'color', 'description']) if (Object.prototype.hasOwnProperty.call(changes, k)) next[k] = changes[k] === null ? null : changes[k];
      next.label = next.displayName || next.name || next.href;
      list = [...list.slice(0, i), next, ...list.slice(i + 1)];
      emit({ type: 'access', reason: 'patch', count: list.length });
      return true;
    },
    /** Local removal after a successful DELETE of a collection. */
    remove(href) {
      const n = list.length;
      list = list.filter((c) => c.href !== href);
      if (list.length !== n) emit({ type: 'access', reason: 'remove', count: list.length });
      return list.length !== n;
    },
    /**
     * The address book to open first: the last one used by this login (when it is still accessible),
     * else the first own book, else the first granted one; null when there is none.
     */
    defaultBook() {
      const books = access.addressbooks();
      if (!books.length) return null;
      const last = session ? session.lastBook : null;
      const remembered = last ? books.find((b) => b.href === last) : null;
      return remembered || books.find((b) => b.level === 'own') || books[0];
    },
    setLastBook(href) {
      return session ? session.setLastBook(href) : false;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      listeners.clear();
      list = [];
      problems = [];
      me = null;
      homes = null;
    },
  };
  return access;
}
