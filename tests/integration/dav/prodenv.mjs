// SPDX-License-Identifier: AGPL-3.0-or-later
// Environment of the STORE integration tests: the production-plugin stack of stack.py (alice administrator and
// owner, bob, agent-1) and one REAL `createStoreContext` per signed-in account. Throwaway instances only; the
// tests skip with a clear message when the environment variables are not set (run tests/integration/dav/run.sh).
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createApi } from '../../../src/js/api.js';
import { createClient } from '../../../src/js/dav/client.js';
import { createTransport } from '../../../src/js/dav/http.js';
import { createSession } from '../../../src/js/session.js';
import { createStoreContext } from '../../../src/js/store/index.js';
import { createActivityLog, createFeedback, createWriteGate } from '../../../src/js/ui.js';

export const RADICALE = process.env.RADUI_TEST_PROD_RADICALE || '';
const API = process.env.RADUI_TEST_PROD_API || '';
const API_BASE = process.env.RADUI_TEST_PROD_API_BASE || '';
const API_ORIGIN = process.env.RADUI_TEST_PROD_API_ORIGIN || '';
const PW_FILE = process.env.RADUI_TEST_PROD_PASSWORDS_FILE || '';

export const SKIP = RADICALE && API && API_BASE && API_ORIGIN && PW_FILE
  ? false
  : 'skipped: no production-plugin stack (run tests/integration/dav/run.sh, or tests/integration/dav/stack.py run -- node --test ...)';

/** test() that is skipped, with a clear message, when the stack is not there. `opts.skip` adds a second reason. */
export const itp = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [b || {}, a] : [a || {}, b];
  return test(name, { ...opts, skip: SKIP || opts.skip || false }, fn);
};

/** The 2,000-contact scale test is skipped when RADUI_IT_SKIP_SCALE is set (any non-empty value). */
export const SKIP_SCALE = process.env.RADUI_IT_SKIP_SCALE ? 'skipped: RADUI_IT_SKIP_SCALE is set' : false;

let passwords = null;
function passwordOf(login) {
  if (!passwords) {
    passwords = Object.fromEntries(
      readFileSync(PW_FILE, 'utf8').trim().split('\n').map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
  }
  return passwords[login];
}

export const basic = (login) => 'Basic ' + Buffer.from(`${login}:${passwordOf(login)}`).toString('base64');

/** Raw authenticated DAV request that bypasses every layer of the application. */
export const rawDav = (login, path, init = {}) =>
  fetch(RADICALE + path, { ...init, headers: { Authorization: basic(login), ...(init.headers || {}) }, credentials: 'omit', cache: 'no-store' });

const settle = () => new Promise((r) => setImmediate(r));

/**
 * One signed-in account: a DAV client and an account-service client (both recording every request in `calls`) and,
 * with `store: true` (default), a real store context. `account.dispose()` ends the session (timers, stores).
 * calls: [{via: 'dav' | 'api', method, path, status, body?}] in request order. `hook(call)` (async) runs after each DAV
 * response and before the app sees it: a test uses it to make ANOTHER client act at an exact moment.
 */
export function account(login, { store = true, t = (k) => k, hook = null } = {}) {
  const auth = basic(login);
  const calls = [];
  const davFetch = async (url, init = {}) => {
    const resp = await fetch(url, init);
    const call = { via: 'dav', method: init.method || 'GET', path: new URL(url).pathname, status: resp.status };
    calls.push(call);
    if (hook) await hook(call); // another client acting right after this response (before the app sees it)
    return resp;
  };
  const apiFetch = async (path, init = {}) => {
    const headers = { ...(init.headers || {}), Origin: API_ORIGIN };
    const resp = await fetch(API + path, { ...init, headers });
    calls.push({ via: 'api', method: init.method || 'GET', path: path.split('?')[0], query: path.includes('?') ? path.slice(path.indexOf('?') + 1) : '', status: resp.status, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    return resp;
  };
  const transport = createTransport({ origin: RADICALE, getAuth: () => auth, fetchImpl: davFetch, timeoutMs: 120000 });
  const client = createClient(transport);
  const api = createApi({ apiBase: API_BASE, getAuth: () => auth, fetchImpl: apiFetch, timeoutMs: 30000 });
  const a = {
    login,
    calls,
    client,
    api,
    /** Requests of one kind since `mark` (an index in `calls`). */
    since: (mark = 0, { via, method, path } = {}) => calls.slice(mark).filter((c) => (!via || c.via === via) && (!method || c.method === method) && (!path || (path instanceof RegExp ? path.test(c.path) : c.path === path))),
    mark: () => calls.length,
    puts: (mark = 0) => calls.slice(mark).filter((c) => c.via === 'dav' && c.method === 'PUT'),
    session: null,
    ctx: null,
    activity: null,
    feedback: null,
    gate: null,
    async dispose() {
      if (a.session) a.session.dispose();
      await settle();
    },
  };
  if (store) {
    a.session = createSession({ login, storage: null });
    a.activity = createActivityLog();
    a.feedback = createFeedback();
    a.gate = createWriteGate();
    a.ctx = createStoreContext({ session: a.session, client, api, activity: a.activity, feedback: a.feedback, t, gate: a.gate, isOnline: () => true });
  }
  return a;
}

/** Collection href of an account's own collection. */
export const homeOf = (login) => `/${login}/`;

let counter = 0;
/** A unique collection name for one test. */
export const uniqueName = (tag = 'it') => `${tag}-${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Grant `grantee` access to `<owner>/<name>` through the account service (as the owner). */
export const grant = (owner, name, grantee, level) => account(owner, { store: false }).api.putGrant({ owner, collection: name, grantee, level });

/**
 * Create an address book of `owner` through DAV, with optional grants {bob: 'readwrite', 'agent-1': 'read'}.
 * Returns {name, href}.
 */
export async function newBook(owner, grants = {}, { tag = 'book', kind = 'addressbook' } = {}) {
  const name = uniqueName(tag);
  const href = `${homeOf(owner)}${name}/`;
  const c = account(owner, { store: false }).client;
  if (kind === 'calendar') await c.mkcalendar(href, { displayName: name, components: ['VEVENT'] });
  else await c.mkAddressbook(href, { displayName: name });
  for (const [who, level] of Object.entries(grants)) await grant(owner, name, who, level);
  return { name, href };
}

/** A new store of `href` with its first sync done. */
export async function openStore(a, href, kind = 'addressbook') {
  const store = a.ctx.stores.open({ href, kind });
  const r = await store.sync({ reason: 'load' });
  if (!r.ok) throw new Error(`first sync failed: ${JSON.stringify(r.error || r)}`);
  return store;
}

// ---------------------------------------------------------------------------
// Fictional data

export const uuid = (n) => `7c2e3f00-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const urn = (n) => `urn:uuid:${uuid(n)}`;

/** A fictional vCard (CRLF). `n` makes the UID; `extra` are further content lines (each ends with CRLF). */
export function vcard(n, fn, extra = '', version = '3.0') {
  const [given, family] = fn.split(' ');
  return `BEGIN:VCARD\r\nVERSION:${version}\r\nPRODID:-//Example Contacts//Contacts 1.0//EN\r\nUID:${urn(n)}\r\nFN:${fn}\r\nN:${family || ''};${given};;;\r\n${extra}END:VCARD\r\n`;
}

export const appleGroup = (n, name, members) =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Example Contacts//Contacts 1.0//EN\r\nUID:${urn(n)}\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nFN:${name}\r\nN:${name};;;;\r\n${members.map((m) => `X-ADDRESSBOOKSERVER-MEMBER:${m}\r\n`).join('')}END:VCARD\r\n`;
export const rfcGroup = (n, name, members) =>
  `BEGIN:VCARD\r\nVERSION:4.0\r\nPRODID:-//Example Contacts//Contacts 1.0//EN\r\nUID:${urn(n)}\r\nKIND:group\r\nFN:${name}\r\n${members.map((m) => `MEMBER:${m}\r\n`).join('')}END:VCARD\r\n`;

export const event = (id, summary, start = '20260601T090000Z', tz = null) => {
  const dt = (s) => (tz ? `;TZID=${tz}:` + s : ':' + s);
  const zone = tz ? `BEGIN:VTIMEZONE\r\nTZID:${tz}\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n` : '';
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example Calendar//Calendar 1.0//EN\r\n${zone}BEGIN:VEVENT\r\nUID:${id}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART${dt(start)}\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
};

/** Run `fn(i)` for i in [0, count) with at most `limit` in flight (10 at most: the test rules). */
export async function pool(count, fn, limit = 8) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, 10, count) }, async () => {
    while (next < count) {
      const i = next++;
      await fn(i);
    }
  });
  await Promise.all(lanes);
}

/** Every card of a book as the server holds it (one listing, one multiget): [{href, etag, text}] sorted by href. */
export async function serverCards(client, href) {
  const list = await client.listItemEtags(href);
  const out = [];
  for (let i = 0; i < list.length; i += 100) {
    const { items } = await client.addressbookMultiget(href, list.slice(i, i + 100).map((x) => x.href));
    out.push(...items.map((x) => ({ href: x.href, etag: x.etag, text: x.text })));
  }
  return out.sort((a, b) => (a.href < b.href ? -1 : 1));
}

export const lf = (s) => String(s).replace(/\r\n?/g, '\n');
export const unfold = (s) => lf(s).replace(/\n[ \t]/g, '');
export const lines = (s) => unfold(s).split('\n').filter(Boolean);
export const membersOf = (text) => lines(text).filter((l) => /^(?:X-ADDRESSBOOKSERVER-)?MEMBER[:;]/i.test(l)).map((l) => l.slice(l.indexOf(':') + 1)).sort();
