// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the collections and import tests: the fake DOM, a translator over the real dictionaries,
// access-list entries shaped like the store's, a fake store context (access, writes, stores, export, import)
// and a screen context. No tests in here.
import { makeDom, one } from '../widgets/_dom.mjs';
import { createI18n } from '../_i18n-all.mjs';
import { createFeedback, createReadiness, writeGate } from '../../../src/js/ui.js';

export const doc = makeDom();
export const i18nEn = createI18n({ lang: 'en' });
export const i18nFr = createI18n({ lang: 'fr' });
export const flush = (n = 6) => (n <= 0 ? Promise.resolve() : new Promise((r) => setImmediate(r)).then(() => flush(n - 1)));

/** Empty the page and the write gate between tests. */
export function reset() {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
  writeGate.setReason('offline', null);
  writeGate.setReason('readonly', null);
  const main = doc.createElement('main');
  doc.body.append(main);
  return main;
}

export const tid = (id, root = doc.body) => one(root, id);
export const tidAll = (id, root = doc.body) => root.querySelectorAll(`[data-testid="${id}"]`);
export const text = (id, root = doc.body) => (tid(id, root) ? tid(id, root).textContent : null);

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** An entry of the access list. */
export function entry(over = {}) {
  const base = {
    href: '/alice/cal/',
    kind: 'calendar',
    name: 'cal',
    components: ['VEVENT', 'VTODO'],
    displayName: 'Family',
    color: '#0072B2',
    description: null,
    ctag: '"ctag-1"',
    syncToken: 'sync-token-1',
    etag: '"c1"',
    source: 'own',
    status: 'ok',
    owner: 'alice',
    level: 'own',
    ownerIsMe: true,
    readOnly: false,
  };
  const e = { ...base, ...over };
  e.label = e.displayName || e.name || e.href;
  return e;
}
export const book = (over = {}) => entry({ href: '/alice/book/', kind: 'addressbook', name: 'book', components: ['VCARD'], displayName: 'Contacts', color: null, ...over });
export const shared = (over = {}) => entry({ href: '/bob/team/', name: 'team', displayName: 'Team', owner: 'bob', source: 'grant', level: 'read', ownerIsMe: false, readOnly: true, ...over });

export function fakeAccess(list, { ownSpace = true, login = 'alice', refetchResult = null, homes = null } = {}) {
  let items = list.slice();
  const access = {
    me: { login },
    ownSpace,
    lastError: null,
    refetchCalls: [],
    load: async () => ({ ok: true }),
    refetch: async (o) => {
      access.refetchCalls.push(o);
      return refetchResult || { ok: true, error: null };
    },
    list: () => items.slice(),
    get: (href) => items.find((c) => c.href === href || c.href === href + '/' || c.href + '/' === href) || null,
    writable: (kind) => items.filter((c) => (!kind || c.kind === kind) && (c.level === 'own' || c.level === 'readwrite')),
    canCreateCollections: () => ownSpace,
    canManage: (x) => {
      const c = typeof x === 'string' ? access.get(x) : x;
      return Boolean(c) && c.level === 'own';
    },
    homeSets: async () => homes || { principal: '/alice/', calendarHomes: ['/alice/'], addressbookHomes: ['/alice/'] },
    remove: (href) => {
      items = items.filter((c) => c.href !== href);
    },
    set: (next) => {
      items = next.slice();
    },
  };
  return access;
}

/** A writes object whose collection functions record their calls and answer from `script`. */
export function fakeWrites(script = {}) {
  const calls = [];
  const w = { calls };
  for (const name of ['mkcol', 'mkcalendar', 'proppatch', 'deleteCollection']) {
    w[name] = async (args) => {
      calls.push({ name, args });
      let s = script[name];
      if (Array.isArray(s)) s = s.length > 1 ? s.shift() : s[0];
      if (typeof s === 'function') return s(args);
      if (s !== undefined) return s;
      return { ok: true, status: name === 'proppatch' ? 'saved' : name === 'deleteCollection' ? 'deleted' : 'created', message: '', href: args.href };
    };
  }
  return w;
}

/** The store context the screens get from `app.getStore()`. */
export function fakeStore({ list = [], ownSpace = true, writes = fakeWrites(), exportResult = null, access = null, itemStore = null, importScript = null } = {}) {
  const acc = access || fakeAccess(list, { ownSpace });
  const exportCalls = [];
  const importCalls = [];
  const opened = [];
  const store = {
    session: { login: 'alice' },
    access: acc,
    writes,
    exportCalls,
    importCalls,
    opened,
    stores: {
      open: (o) => {
        opened.push(o);
        return itemStore || fakeItemStore();
      },
    },
    exportCollection: async (opts) => {
      exportCalls.push(opts);
      if (typeof exportResult === 'function') return exportResult(opts);
      return exportResult || { ok: true, status: 'ok', filename: 'family-2026-11-13.ics', mime: 'text/calendar;charset=utf-8', text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', count: 3, groupsExcluded: 0, empty: false, kind: opts.collection.kind };
    },
    startImport: (opts) => {
      importCalls.push(opts);
      if (importScript) return importScript(opts);
      return { cancel() {}, done: Promise.resolve({ created: 0, replaced: 0, skipped: 0, failed: 0, total: 0, items: [], notRun: 0, warnings: [], verify: { checked: 0, mismatched: [], failed: false }, stopped: null, cancelled: false, ok: true }) };
    },
  };
  return store;
}

/** An item store holding `texts` ({href: text}); `reload` can be made to fail. */
export function fakeItemStore(texts = {}, { reloadOk = true } = {}) {
  const calls = [];
  return {
    calls,
    reload: async (o) => {
      calls.push(o);
      return reloadOk ? { ok: true } : { ok: false, error: { kind: 'network' } };
    },
    list: () => Object.entries(texts).map(([href, t]) => ({ href, etag: `"${href}"`, text: t })),
  };
}

/** dav client fake: counts listItemEtags concurrency. */
export function fakeDav({ counts = {}, etag = '"coll-etag-1"', failCount = [], failCollection = false, gate = null } = {}) {
  const state = { inflight: 0, maxInflight: 0, listCalls: [], getCalls: [] };
  const dav = {
    state,
    async listItemEtags(href) {
      state.listCalls.push(href);
      state.inflight++;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      try {
        if (gate) await gate(href);
        else await new Promise((r) => setImmediate(r));
        if (failCount.includes(href)) {
          const e = new Error('boom');
          e.name = 'DavError';
          e.kind = 'server';
          throw e;
        }
        const n = counts[href] ?? 0;
        return Array.from({ length: n }, (_, i) => ({ href: `${href}${i}.vcf`, etag: `"${i}"` }));
      } finally {
        state.inflight--;
      }
    },
    async getCollection(href) {
      state.getCalls.push(href);
      if (failCollection) throw Object.assign(new Error('gone'), { name: 'DavError', kind: 'notfound' });
      return { href, etag: typeof etag === 'function' ? etag(href) : etag };
    },
  };
  return dav;
}

/** The ctx of a screen. `route` is {name, query}. */
export function makeCtx({ root, store, dav = fakeDav(), api = null, route = { name: 'collections', query: {}, params: {} }, lang = 'en', restore = null } = {}) {
  const i18n = lang === 'fr' ? i18nFr : i18nEn;
  const feedback = createFeedback();
  feedback.enterScreen('collections');
  const nav = [];
  const dirty = [];
  const abort = new AbortController();
  const app = {
    feedback,
    readiness: createReadiness(() => {}),
    dav,
    api,
    lang,
    navigate: (hash, opts) => nav.push({ hash, opts }),
    setDirty: (v) => dirty.push(Boolean(v)),
    getStore: async () => store,
    session: null,
    nav,
    dirty,
  };
  return { root, t: (k, p) => i18n.t(k, p), tp: (k, n, p) => i18n.tp(k, n, p), params: route.params || {}, route, host: 'example.org', restore, signal: abort.signal, app, abort };
}
