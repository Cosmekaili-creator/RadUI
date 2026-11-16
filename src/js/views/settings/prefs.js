// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-login preferences kept in the browser (localStorage, every access in try/catch with an in-memory
// fallback: a private window or blocked site data must never break a screen). Keys are
// `radui.pref.<login>.<name>`; the login part is lower-cased and URI-encoded so two accounts on one
// device never see each other's choices and "forget this device" can remove exactly one account's set.
// Values are JSON. A change reaches every subscriber at once (no reload): the calendar listens for its
// settings (time zone, first weekday, 24 h clock, birthdays) through `subscribe`.
//
// No DOM: the storage is injected (Node tests pass a fake).

export const PREF_PREFIX = 'radui.pref.';

/** localStorage key of one preference of one login. */
export function prefKey(login, name) {
  return `${PREF_PREFIX}${encodeURIComponent(String(login).toLowerCase())}.${name}`;
}

/**
 * @param {object} o
 * @param {Storage|null} [o.storage] localStorage (or a fake with getItem/setItem/removeItem[/key/length])
 * @param {string} o.login
 */
export function createPrefs({ storage = null, login } = {}) {
  if (typeof login !== 'string' || login === '') throw new TypeError('preferences need a login');
  const memory = new Map(); // what could not be persisted (and what was set while the storage failed)
  const listeners = new Set();
  const prefix = prefKey(login, '');
  const notify = (name, value) => {
    for (const fn of [...listeners]) {
      try {
        fn(name, value);
      } catch {
        /* a failing listener must not stop the others */
      }
    }
  };
  const prefs = {
    /** The stored value of `name`, or `fallback` when unset, unreadable or not valid JSON. */
    get(name, fallback = null) {
      let raw = null;
      try {
        raw = storage ? storage.getItem(prefix + name) : null;
      } catch {
        raw = null;
      }
      if (raw === null && memory.has(name)) raw = memory.get(name);
      if (raw === null || raw === undefined) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    /** Store `value` (any JSON value). Returns true when it was persisted, false when only kept in memory. */
    set(name, value) {
      const raw = JSON.stringify(value);
      let persisted = false;
      try {
        if (storage) {
          storage.setItem(prefix + name, raw);
          persisted = true;
        }
      } catch {
        persisted = false;
      }
      if (persisted) memory.delete(name);
      else memory.set(name, raw);
      notify(name, value);
      return persisted;
    },
    remove(name) {
      memory.delete(name);
      try {
        if (storage) storage.removeItem(prefix + name);
      } catch {
        /* nothing to do */
      }
      notify(name, undefined);
    },
    /** Remove one raw storage key that belongs to this login but not to the preference set (for example the last address book). */
    removeKey(key) {
      try {
        if (storage) storage.removeItem(key);
      } catch {
        /* nothing to do */
      }
    },
    /** Remove every preference of this login (and the in-memory copies). Returns how many keys were removed. */
    clearAll() {
      memory.clear();
      let removed = 0;
      try {
        if (storage && typeof storage.key === 'function' && typeof storage.length === 'number') {
          const keys = [];
          for (let i = 0; i < storage.length; i += 1) {
            const k = storage.key(i);
            if (typeof k === 'string' && k.startsWith(prefix)) keys.push(k);
          }
          for (const k of keys) {
            storage.removeItem(k);
            removed += 1;
          }
        }
      } catch {
        /* a blocked storage has nothing of ours to remove */
      }
      notify(null, undefined);
      return removed;
    },
    /** Called with (name, value) after every change; (null, undefined) after clearAll. Returns an unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return prefs;
}
