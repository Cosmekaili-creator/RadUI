// SPDX-License-Identifier: AGPL-3.0-or-later
// Credential store. The Authorization header value ("Basic ...") is kept in
// sessionStorage by default (it survives a reload but dies with the tab) and in
// localStorage when the user ticks "Stay signed in on this device". Every
// storage access is wrapped in try/catch (private windows, blocked site data,
// quota errors) with an in-memory fallback, so the page still works, only
// without persistence. The header value is handed out by getAuth() alone: it is
// never part of describe(), toJSON(), errors or logs.
//
// No cookies and no tokens in URLs: this store is the only place a credential
// lives.

export const STORAGE_KEY = 'radui.auth';
const HEADER_RE = /^Basic [A-Za-z0-9+/]+={0,2}$/;
const MAX_HEADER = 1024; // the backend rejects longer headers anyway
const MAX_LOGIN = 64;

/** Basic-auth header value for a login and password (UTF-8, as Radicale expects). */
export function encodeBasic(login, password) {
  if (typeof login !== 'string' || typeof password !== 'string') throw new TypeError('login and password must be strings');
  if (login.includes(':')) throw new RangeError('a login cannot contain a colon');
  const bytes = new TextEncoder().encode(`${login}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

/** The user name inside a Basic header value ('' when it cannot be read). */
function loginOfHeader(header) {
  try {
    const bin = atob(header.slice(6));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const i = text.indexOf(':');
    return i < 0 ? '' : text.slice(0, i);
  } catch {
    return '';
  }
}

function attempt(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function parseRecord(text) {
  if (typeof text !== 'string' || !text) return null;
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.h !== 'string' || rec.h.length > MAX_HEADER || !HEADER_RE.test(rec.h)) return null;
  const login = typeof rec.u === 'string' && rec.u.length <= MAX_LOGIN ? rec.u : '';
  return { header: rec.h, login };
}

/**
 * @param {object} [opts]
 * @param {Storage|null} [opts.session] sessionStorage (or a fake)
 * @param {Storage|null} [opts.local] localStorage (or a fake)
 * @param {string} [opts.key]
 */
export function createAuthStore({ session = null, local = null, key = STORAGE_KEY } = {}) {
  let memory = null; // {header, login}: only used when persisting failed
  const listeners = new Set();
  const notify = () => {
    for (const fn of [...listeners]) attempt(() => fn(describe()));
  };

  const read = (storage) => (storage ? attempt(() => parseRecord(storage.getItem(key))) : null);
  const write = (storage, text) => {
    if (!storage) return false;
    try {
      storage.setItem(key, text);
    } catch {
      return false;
    }
    // Read it back: a storage that accepts writes but throws on reads is as good as none.
    const back = read(storage);
    if (back !== null && JSON.stringify({ h: back.header, u: back.login }) === text) return true;
    remove(storage);
    return false;
  };
  const remove = (storage) => {
    if (storage) attempt(() => storage.removeItem(key));
  };

  /** Current record and where it lives. */
  function current() {
    const s = read(session);
    if (s) return { ...s, where: 'session' };
    const l = read(local);
    if (l) return { ...l, where: 'local' };
    if (memory) return { ...memory, where: 'memory' };
    return null;
  }

  function describe() {
    const c = current();
    return c ? { signedIn: true, login: c.login, where: c.where } : { signedIn: false, login: null, where: null };
  }

  return {
    /**
     * Store a credential. `stay` selects localStorage instead of sessionStorage.
     * Never throws because of storage; returns where the value ended up
     * ('session' | 'local' | 'memory').
     */
    signIn(header, { login = '', stay = false } = {}) {
      if (typeof header !== 'string' || header.length > MAX_HEADER || !HEADER_RE.test(header)) throw new TypeError('invalid Authorization header value');
      const rec = JSON.stringify({ h: header, u: String(login).slice(0, MAX_LOGIN) });
      // Clear everything first so a value never lingers in the storage the user did not choose.
      remove(session);
      remove(local);
      memory = null;
      let where = null;
      if (stay && write(local, rec)) where = 'local';
      else if (write(session, rec)) where = 'session';
      if (!where) {
        memory = { header, login: String(login).slice(0, MAX_LOGIN) };
        where = 'memory';
      }
      notify();
      return where;
    },

    /**
     * Replace the stored credential in place (the user changed their own password): same storage kind
     * (session, local or memory) and same display login as before, so nothing about the sign-in choice
     * changes. `login` is the user name used in the header (default: the one inside the current header).
     * Returns where the value ended up, or null when nobody is signed in. If the original storage refuses
     * the write, the old record is removed and the new one is kept in memory.
     */
    replaceCredential(login, password) {
      const cur = current();
      if (!cur) return null;
      const name = typeof login === 'string' && login ? login : loginOfHeader(cur.header);
      if (!name) throw new TypeError('a login is required');
      const header = encodeBasic(name, password);
      if (header.length > MAX_HEADER || !HEADER_RE.test(header)) throw new TypeError('invalid Authorization header value');
      const rec = JSON.stringify({ h: header, u: cur.login });
      let where = null;
      if (cur.where === 'session' && write(session, rec)) where = 'session';
      else if (cur.where === 'local' && write(local, rec)) where = 'local';
      if (!where) {
        remove(session);
        remove(local);
        memory = { header, login: cur.login };
        where = 'memory';
      } else {
        memory = null;
      }
      notify();
      return where;
    },

    /** The Authorization header value, or null. Used by the DAV and API transports. */
    getAuth() {
      const c = current();
      return c ? c.header : null;
    },

    getLogin() {
      const c = current();
      return c ? c.login : null;
    },

    isSignedIn() {
      return current() !== null;
    },

    /** {signedIn, login, where}: safe to log and to show. */
    describe,

    /** Forget the credential everywhere (both storages and memory). */
    logout() {
      remove(session);
      remove(local);
      memory = null;
      notify();
    },

    /** Called with describe() after every sign-in and sign-out. Returns an unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    toJSON() {
      return describe();
    },
  };
}

/** The browser's storages, each only if the property access itself does not throw. */
export function browserStorages(win = globalThis) {
  return {
    session: attempt(() => win.sessionStorage),
    local: attempt(() => win.localStorage),
  };
}
