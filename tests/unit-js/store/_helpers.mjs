// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the store tests: a fake clock, a fake document/window, an in-memory DAV server that
// implements the client interface (with scriptable failures and an optional re-serialisation step like
// Radicale's), a fake account-service API, and an environment builder. No tests in here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictError, DavError } from '../../../src/js/dav/http.js';
import { ApiError } from '../../../src/js/api.js';
import { createSession } from '../../../src/js/session.js';
import { createActivityLog, createFeedback, createWriteGate } from '../../../src/js/ui.js';
import { createAccess } from '../../../src/js/store/access.js';
import { createStores } from '../../../src/js/store/itemstore.js';
import { createReporter } from '../../../src/js/store/report.js';
import { createScheduler } from '../../../src/js/store/scheduler.js';
import { createWrites } from '../../../src/js/store/writes.js';
import * as model from '../../../src/js/model/item.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const vcf = (name) => readFileSync(path.join(here, '../../fixtures/vcf', name), 'utf8');
export { model };

export const COLL = '/alice/book/';
export const lf = (t) => t.replace(/\r\n?/g, '\n');
export const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A card with the given fields (LF text; UID `urn:uuid:<uid>`). */
export function card(uid, fn, extra = '', version = '3.0') {
  return `BEGIN:VCARD\nVERSION:${version}\nPRODID:-//Example Contacts//Contacts 1.0//EN\nUID:${uid}\nFN:${fn}\n${extra}END:VCARD\n`;
}
export const groupCard = (uid, name, members, apple = true) =>
  `BEGIN:VCARD\nVERSION:${apple ? '3.0' : '4.0'}\nUID:${uid}\n${apple ? 'X-ADDRESSBOOKSERVER-KIND:group' : 'KIND:group'}\nFN:${name}\n${members.map((m) => `${apple ? 'X-ADDRESSBOOKSERVER-MEMBER' : 'MEMBER'}:${m}`).join('\n')}\nEND:VCARD\n`;

// ------------------------------------------------------------------ clock

export function createClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + ms, every: null });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + ms, every: ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        let best = null;
        for (const [id, tm] of timers) if (tm.at <= target && (!best || tm.at < best.tm.at)) best = { id, tm };
        if (!best) break;
        t = best.tm.at;
        if (best.tm.every) best.tm.at += best.tm.every;
        else timers.delete(best.id);
        best.tm.fn();
        await tick();
      }
      t = target;
      await tick();
    },
  };
  return clock;
}

export function fakeTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type });
    },
    count: (type) => (listeners.get(type) ? listeners.get(type).size : 0),
  };
}
export const fakeDoc = () => fakeTarget({ visibilityState: 'visible' });
export const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

// ------------------------------------------------------------------ DAV server

/** Radicale-like re-serialisation: VERSION/PRODID/UID first, the rest alphabetical, X-ABLabel upper-cased. */
export function radicaleLike(text) {
  const lines = lf(text).replace(/\n[ \t]/g, '').split('\n').filter(Boolean);
  const body = lines.slice(1, -1).map((l) => l.replace(/^((?:[A-Za-z0-9]+\.)?)X-ABLabel/, '$1X-ABLABEL').replace(/;type=/g, ';TYPE='));
  const rank = (l) => {
    const n = l.replace(/^[A-Za-z0-9]+\./, '').split(/[;:]/)[0].toUpperCase();
    return n === 'VERSION' ? '0' : n === 'PRODID' ? '1' : n === 'UID' ? '2' : '3' + n;
  };
  body.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  return [lines[0], ...body, lines[lines.length - 1]].join('\n') + '\n';
}

export class FakeServer {
  constructor({ collection = COLL, kind = 'addressbook', transform = null } = {}) {
    this.collection = collection;
    this.kind = kind;
    this.transform = transform;
    this.items = new Map();
    this.tombstones = [];
    this.v = 0;
    this.e = 0;
    this.calls = [];
    this.failures = [];
    this.afterFailures = [];
    this.collEtag = '"c0"';
    this.exists = true;
    this.syncSupported = true;
    this.otherCollections = new Set();
    this.client = this._client();
  }
  href(name) {
    return this.collection + name;
  }
  seed(name, text) {
    const href = this.href(name);
    this.items.set(href, { text: lf(text), etag: `"e${++this.e}"`, v: ++this.v });
    this.collEtag = `"c${this.v}"`;
    return href;
  }
  /** Another client writes (or deletes with null). */
  external(name, text) {
    const href = this.href(name);
    if (text === null) {
      this.items.delete(href);
      this.tombstones.push({ href, v: ++this.v });
    } else this.seed(name, text);
    this.collEtag = `"c${this.v}"`;
    return href;
  }
  get(name) {
    return this.items.get(this.href(name));
  }
  /** Fail the next `times` calls of `method` (optionally only for hrefs matching `when`). */
  fail(method, error, { times = 1, when = null } = {}) {
    this.failures.push({ method, error, times, when });
  }
  /** The operation is APPLIED, then the client sees an error (a lost response). */
  failAfter(method, error) {
    this.afterFailures.push({ method, error });
  }
  _after(method) {
    const i = this.afterFailures.findIndex((f) => f.method === method);
    if (i >= 0) throw this.afterFailures.splice(i, 1)[0].error;
  }
  callsOf(method) {
    return this.calls.filter((c) => c.startsWith(method + ' '));
  }
  _hit(method, href) {
    this.calls.push(`${method} ${href}`);
    const i = this.failures.findIndex((f) => f.method === method && (!f.when || f.when(href)));
    if (i >= 0) {
      const f = this.failures[i];
      if (--f.times <= 0) this.failures.splice(i, 1);
      throw typeof f.error === 'function' ? f.error() : f.error;
    }
  }
  _client() {
    const s = this;
    const bump = () => {
      s.collEtag = `"c${s.v}"`;
    };
    return {
      transport: { normalize: (h) => h },
      async getItem(href) {
        s._hit('GET', href);
        const it = s.items.get(href);
        if (!it) throw new DavError('notfound', { status: 404 });
        return { href, etag: it.etag, text: it.text, contentType: 'text/vcard' };
      },
      async putItem(href, text, opts = {}) {
        s._hit('PUT', href);
        const it = s.items.get(href);
        if (opts.create && it) throw new ConflictError({ status: 412, href, sentEtag: null });
        if (!opts.create) {
          if (!opts.etag) throw new TypeError('putItem needs exactly one of {etag} or {create: true}');
          if (!it || it.etag !== opts.etag) throw new ConflictError({ status: 412, href, sentEtag: opts.etag });
        }
        const stored = lf(s.transform ? s.transform(lf(text), href) : text);
        s.items.set(href, { text: stored, etag: `"e${++s.e}"`, v: ++s.v });
        bump();
        s._after('PUT');
        return { href, etag: s.items.get(href).etag, created: !it };
      },
      async deleteItem(href, etag) {
        s._hit('DELETE', href);
        const it = s.items.get(href);
        if (!it) throw new DavError('notfound', { status: 404 });
        if (it.etag !== etag) throw new ConflictError({ status: 412, href, sentEtag: etag });
        s.items.delete(href);
        s.tombstones.push({ href, v: ++s.v });
        bump();
        return { href };
      },
      async getCollection(href) {
        s._hit('PROPFIND0', href);
        if (href === s.collection) {
          if (!s.exists) throw new DavError('notfound', { status: 404 });
          return { href, kind: s.kind, etag: s.collEtag, ctag: s.collEtag, displayName: 'Book', components: [] };
        }
        if (s.otherCollections.has(href)) return { href, kind: s.kind, etag: '"o1"', ctag: '"o1"', displayName: 'Other', components: [] };
        throw new DavError('notfound', { status: 404 });
      },
      async listItemEtags(href) {
        s._hit('PROPFIND1', href);
        return [...s.items].map(([h, it]) => ({ href: h, etag: it.etag }));
      },
      async syncCollection(href, token) {
        s._hit('SYNC', href);
        if (!s.syncSupported) throw new DavError('invalid', { status: 501 });
        const from = token ? Number(String(token).replace('tok:', '')) : 0;
        const changed = [...s.items].filter(([, it]) => it.v > from).map(([h, it]) => ({ href: h, etag: it.etag }));
        const removed = token ? s.tombstones.filter((t) => t.v > from).map((t) => t.href) : [];
        return { token: `tok:${s.v}`, changed, removed };
      },
      async addressbookMultiget(href, hrefs) {
        s._hit('MULTIGET', href);
        const items = [];
        const missing = [];
        for (const h of hrefs) {
          const it = s.items.get(h);
          if (it) items.push({ href: h, etag: it.etag, text: it.text });
          else missing.push(h);
        }
        return { items, missing };
      },
      async getCollectionText(href) {
        s._hit('GETCOLL', href);
        const text = [...s.items.values()].map((i) => i.text).join('');
        return { href, etag: s.collEtag, text, contentType: 'text/vcard', kind: text ? 'addressbook' : 'empty' };
      },
      async mkAddressbook(href, props) {
        s._hit('MKCOL', href);
        if (s.otherCollections.has(href)) throw new DavError('invalid', { status: 405 });
        s.otherCollections.add(href);
        s.lastProps = props;
        return { href };
      },
      async mkcalendar(href, props) {
        s._hit('MKCALENDAR', href);
        if (s.otherCollections.has(href)) throw new DavError('conflict', { status: 409 });
        s.otherCollections.add(href);
        s.lastProps = props;
        return { href };
      },
      async proppatch(href, kind, changes) {
        s._hit('PROPPATCH', href);
        s.lastPatch = changes;
        return { href };
      },
      async deleteCollection(href, etag) {
        s._hit('DELETECOLL', href);
        if (etag !== s.collEtag) throw new ConflictError({ status: 412, href, sentEtag: etag });
        s.exists = false;
        s.items.clear();
        return { href };
      },
      async homeSets() {
        return { principal: '/alice/', calendarHomes: ['/alice/'], addressbookHomes: ['/alice/'] };
      },
    };
  }
}

// ------------------------------------------------------------------ account-service fake

export class FakeApi {
  constructor({ login = 'alice', ownSpace = true, grants = [] } = {}) {
    this.login = login;
    this.ownSpace = ownSpace;
    this.grantList = grants; // [{owner, collection, grantee, level}]
    this.calls = [];
    this.failures = [];
    this.putFailures = [];
    this.accessGrants = [];
  }
  fail(method, error, times = 1) {
    this.failures.push({ method, error, times });
  }
  _check(method) {
    this.calls.push(method);
    const i = this.failures.findIndex((f) => f.method === method);
    if (i >= 0) {
      const f = this.failures[i];
      if (--f.times <= 0) this.failures.splice(i, 1);
      throw f.error;
    }
  }
  async me() {
    this._check('me');
    return { login: this.login, displayName: this.login, type: 'person', admin: false, ownSpace: this.ownSpace, generation: 1, rightsActive: true, ok: true };
  }
  async meAccess() {
    this._check('meAccess');
    return { login: this.login, admin: false, ownSpace: this.ownSpace, principals: null, grants: this.accessGrants };
  }
  async grants({ owner } = {}) {
    this._check('grants');
    return this.grantList.filter((g) => !owner || g.owner === owner).map((g) => ({ grantedBy: owner, created: null, ...g }));
  }
  async putGrant({ owner, collection, grantee, level }) {
    this._check('putGrant');
    this.calls.push(`putGrant ${collection} ${grantee} ${level}`);
    if (level === 'none') this.grantList = this.grantList.filter((g) => !(g.owner === owner && g.collection === collection && g.grantee === grantee));
    return { grant: null, generation: 2, active: true };
  }
}
export const apiError = (kind, info = {}) => new ApiError(kind, info);

// ------------------------------------------------------------------ environment

/**
 * One session with a store of one address book, a real write path over the fake server.
 * opts: items {name: text}, transform, api (FakeApi), level ('own' | 'readwrite' | 'read' | null = unknown), load (default true)
 */
export async function makeEnv({ items = {}, transform = null, api = new FakeApi(), level = 'own', load = true, withDoc = true, modelImpl = model } = {}) {
  const clock = createClock();
  const server = new FakeServer({ transform });
  for (const [name, text] of Object.entries(items)) server.seed(name, text);
  const session = createSession({ login: 'alice', storage: fakeStorage(), timers: clock });
  const activity = createActivityLog({ now: () => new Date(clock.now()) });
  const feedback = createFeedback();
  const reporter = createReporter({ activity, feedback, t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k) });
  const gate = createWriteGate();
  const discover = async () => ({
    collections: level
      ? [{ href: COLL, kind: 'addressbook', name: 'book', displayName: 'Book', source: level === 'own' ? 'own' : 'grant', level: level === 'own' ? undefined : level, owner: 'alice', status: 'ok', components: ['VCARD'] }]
      : [],
    apiError: null,
    ownError: null,
  });
  const access = createAccess({ api, client: server.client, session, discover });
  await access.refetch({ reason: 'test' });
  const accessCalls = { n: 0 };
  const origRefetch = access.refetch;
  access.refetch = (o) => {
    accessCalls.n++;
    return origRefetch(o);
  };
  const stores = createStores({ client: server.client, session, now: clock.now, reporter });
  const store = stores.open({ href: COLL, kind: 'addressbook' });
  const doc = withDoc ? fakeDoc() : null;
  const win = fakeTarget();
  const scheduler = createScheduler({ session, doc, win, now: clock.now });
  const writes = createWrites({
    client: server.client,
    api,
    stores,
    access,
    scheduler,
    reporter,
    gate,
    login: 'alice',
    model: modelImpl,
    random: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
    sleep: (ms) => {
      env.slept.push(ms);
      return Promise.resolve();
    },
  });
  if (load) await store.sync({ reason: 'load' });
  const env = { clock, server, session, activity, feedback, reporter, gate, access, accessCalls, stores, store, scheduler, writes, api, doc, win, slept: [] };
  return env;
}

export const lastActivity = (env) => env.activity.entries()[0];
export const ops = (env) => env.activity.entries().map((e) => `${e.op}:${e.result}`);

/** The {text, etag} a form would have kept when it opened (the store's copy right now). */
export const baseOf = (env, href) => {
  const e = env.store.get(href);
  return e ? { text: e.text, etag: e.etag } : null;
};
export const etagOf = (env, href) => (env.store.get(href) ? env.store.get(href).etag : null);
