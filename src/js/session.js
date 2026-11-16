// SPDX-License-Identifier: AGPL-3.0-or-later
// Session container (one per login). Everything that lives for the length of a
// login (stores, the sync scheduler, timers, event subscriptions, cached data)
// is registered here, so that ONE call, dispose(), stops and forgets all of it.
// dispose() runs on sign-out and on session expiry; a second login in the same
// tab starts from a fresh container and can never see the first login's data.
//
// No DOM: timers and storage are injected, so Node tests drive it with fakes.
//
// Registry API for the other layers:
//   session.register(store)       store may have dispose() / stop() / destroy(); called on dispose
//   session.onDispose(fn)         fn runs once at dispose (newest first); returns an unsubscribe function
//   session.setTimeout/setInterval(fn, ms)   tracked timers, cleared on dispose; return a cancel function
//   session.listen(target, type, fn, opts)   addEventListener removed on dispose; returns a remover
//   session.data                  a Map for cached data, cleared on dispose
//   session.lastBook / setLastBook(href)     the "last address book" preference, kept per login

export const LAST_BOOK_PREFIX = 'radui.lastbook.';

/** localStorage key of the last-book preference of one login (case-insensitive, never shared across logins). */
export function lastBookKey(login) {
  return LAST_BOOK_PREFIX + encodeURIComponent(String(login).toLowerCase());
}

const STOPPERS = ['dispose', 'stop', 'destroy'];

function stopOne(x) {
  for (const name of STOPPERS) {
    if (typeof x[name] === 'function') {
      x[name]();
      return;
    }
  }
}

/**
 * @param {object} o
 * @param {string} o.login
 * @param {Storage|null} [o.storage] localStorage (or a fake): only used for the last-book preference
 * @param {object} [o.timers] {setTimeout, clearTimeout, setInterval, clearInterval}
 */
export function createSession({ login, storage = null, timers = globalThis } = {}) {
  if (typeof login !== 'string' || login === '') throw new TypeError('a session needs a login');
  const stores = new Set();
  const disposers = [];
  const handles = new Set(); // cancel functions of live timers and listeners
  const data = new Map();
  let disposed = false;

  const safe = (fn) => {
    try {
      fn();
    } catch {
      /* one failing disposer must not leave the others running */
    }
  };

  const session = {
    login,
    data,
    get disposed() {
      return disposed;
    },
    /** Track a store (anything with dispose/stop/destroy). Registered after dispose, it is stopped at once. */
    register(store) {
      if (!store || typeof store !== 'object') throw new TypeError('register() needs an object');
      if (disposed) safe(() => stopOne(store));
      else stores.add(store);
      return store;
    },
    unregister(store) {
      return stores.delete(store);
    },
    onDispose(fn) {
      if (typeof fn !== 'function') throw new TypeError('onDispose() needs a function');
      if (disposed) {
        safe(fn);
        return () => {};
      }
      disposers.push(fn);
      return () => {
        const i = disposers.indexOf(fn);
        if (i >= 0) disposers.splice(i, 1);
      };
    },
    setTimeout(fn, ms) {
      if (disposed) return () => {};
      let id = null;
      const cancel = () => {
        if (id !== null) timers.clearTimeout(id);
        id = null;
        handles.delete(cancel);
      };
      id = timers.setTimeout(() => {
        handles.delete(cancel);
        id = null;
        fn();
      }, ms);
      handles.add(cancel);
      return cancel;
    },
    setInterval(fn, ms) {
      if (disposed) return () => {};
      let id = timers.setInterval(fn, ms);
      const cancel = () => {
        if (id !== null) timers.clearInterval(id);
        id = null;
        handles.delete(cancel);
      };
      handles.add(cancel);
      return cancel;
    },
    listen(target, type, fn, opts) {
      if (disposed) return () => {};
      target.addEventListener(type, fn, opts);
      const remove = () => {
        target.removeEventListener(type, fn, opts);
        handles.delete(remove);
      };
      handles.add(remove);
      return remove;
    },
    get lastBook() {
      try {
        return storage ? storage.getItem(lastBookKey(login)) : null;
      } catch {
        return null;
      }
    },
    setLastBook(href) {
      try {
        if (!storage || disposed) return false;
        if (href === null || href === undefined || href === '') storage.removeItem(lastBookKey(login));
        else storage.setItem(lastBookKey(login), String(href));
        return true;
      } catch {
        return false;
      }
    },
    /** Stop every timer, listener, store and subscription, then forget the cached data. Idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...handles]) safe(cancel);
      handles.clear();
      for (const s of [...stores].reverse()) safe(() => stopOne(s));
      stores.clear();
      for (const fn of disposers.splice(0).reverse()) safe(fn);
      data.clear();
    },
  };
  return session;
}

/**
 * Holds the current session of the tab. `ensure(login)` returns the session of that login
 * (a different login, or a disposed one, gets a fresh container after the old one was disposed);
 * `end()` disposes it. app.js ties both to the credential store, so sign-out and expiry
 * cannot leave a live session behind.
 */
export function createSessionHolder({ storage = null, timers = globalThis, onStart, onEnd } = {}) {
  let current = null;
  const holder = {
    get current() {
      return current && !current.disposed ? current : null;
    },
    ensure(login) {
      if (current && !current.disposed && current.login === login) return current;
      holder.end('replaced');
      current = createSession({ login, storage, timers });
      if (onStart) onStart(current);
      return current;
    },
    end(reason = 'ended') {
      const old = current;
      current = null;
      if (!old) return false;
      old.dispose();
      if (onEnd) onEnd(old, reason);
      return true;
    },
  };
  return holder;
}
