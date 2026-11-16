// SPDX-License-Identifier: AGPL-3.0-or-later
// The data layer shared by the contact screens (no DOM): which address book is open, the summaries of its
// cards (one per item version, cached on the session container so list -> form -> list does not parse every
// card again), the group cards, and change notifications from the item store. The store holds server text
// and ETag only; nothing here keeps an `Item`.

import { collectionForParam } from '../../router.js';
import { readGroups } from '../../contacts/groups.js';
import { splitBook, summarize } from '../../contacts/index.js';

export const INDEX_PREFIX = 'radui.contacts.index:';
const CHUNK = 200;

const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Which address book a screen shows.
 * @returns {{state: 'ok', book, books}|{state: 'nobook'|'noaccess'|'notfound'|'error', books: object[]}}
 *   `ab` must match a discovered collection (collectionForParam), else `notfound`.
 */
export function pickBook(access, params = {}) {
  const books = access.addressbooks();
  // an offline cold start has no book list: that is an error/offline state, not a book that "was not found"
  if (!books.length && access.lastError) return { state: 'error', books, error: access.lastError };
  const wanted = params.ab;
  if (typeof wanted === 'string' && wanted !== '') {
    const hit = collectionForParam(wanted, books);
    return hit ? { state: 'ok', book: hit, books } : { state: 'notfound', books };
  }
  if (!books.length) {
    if (access.lastError) return { state: 'error', books, error: access.lastError };
    return { state: access.canCreateCollections() ? 'nobook' : 'noaccess', books };
  }
  return { state: 'ok', book: access.defaultBook(), books };
}

/** Is the book read-only for this account (a grant of level read)? */
export const isReadOnlyBook = (book) => !book || !(book.level === 'own' || book.level === 'readwrite');

/** Query parameters that keep a link in the same book when more than one is reachable. */
export const bookParams = (book, books) => (books && books.length > 1 && book ? { ab: book.href } : {});

/**
 * @param {object} o
 * @param {object} o.storeCtx the store context (ctx.app.getStore())
 * @param {object} o.session session container (cache)
 * @param {object} o.book the collection entry
 * @param {() => Promise<void>} [o.yieldFn] lets the page breathe between chunks of parsing
 */
export function createBookData({ storeCtx, session, book, yieldFn = defaultYield }) {
  const store = storeCtx.stores.open({ href: book.href, kind: 'addressbook' });
  const cacheKey = INDEX_PREFIX + store.href;
  let cache = session.data.get(cacheKey);
  if (!cache) {
    cache = new Map(); // href -> {etag, summary}
    session.data.set(cacheKey, cache);
  }
  let all = [];
  let groupMemo = { key: null, groups: [] };
  let running = null;
  let again = false;
  let disposed = false;
  const listeners = new Set();

  async function build() {
    const entries = store.list();
    const seen = new Set();
    const next = [];
    let parsed = 0;
    for (const e of entries) {
      seen.add(e.href);
      let rec = cache.get(e.href);
      if (!rec || rec.etag !== e.etag) {
        rec = { etag: e.etag, summary: summarize(e.text, { href: e.href, etag: e.etag }) };
        cache.set(e.href, rec);
        parsed += 1;
        if (parsed % CHUNK === 0) {
          await yieldFn();
          if (disposed) return;
        }
      }
      next.push(rec.summary);
    }
    for (const h of [...cache.keys()]) if (!seen.has(h)) cache.delete(h);
    all = next;
  }

  const data = {
    book,
    store,
    /** Rebuild the summaries from the store (cheap when nothing changed). Calls are serialised. */
    refresh() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          await build();
        } while (again && !disposed);
      })().finally(() => {
        running = null;
      });
      return running;
    },
    /** Every card summary, group cards included. */
    get all() {
      return all;
    },
    get contacts() {
      return splitBook(all).contacts;
    },
    /** Group data (readGroups) for the current cards, recomputed only when a group card changed. */
    groups() {
      const gs = all.filter((s) => s.isGroup);
      const key = gs.map((s) => `${s.href}\n${s.etag}`).join('\u0000') + '\u0001' + all.length;
      if (key !== groupMemo.key) {
        const entries = gs.map((s) => store.get(s.href)).filter(Boolean);
        groupMemo = { key, groups: readGroups(entries, all) };
      }
      return groupMemo.groups;
    },
    entry: (href) => store.get(href),
    /** `fn({type})` after the store changed through a sync or a write. Returns the unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      off();
      listeners.clear();
    },
  };
  const off = store.subscribe((ev) => {
    if (disposed) return;
    if (ev.type === 'write' || (ev.type === 'sync' && (ev.changed || ev.ok === false))) for (const fn of [...listeners]) fn(ev);
  });
  return data;
}
