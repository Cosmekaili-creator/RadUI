// SPDX-License-Identifier: AGPL-3.0-or-later
// Sync scheduler (D-R2-6). It decides WHEN a registered store syncs; the store does the work.
//
// Triggers:   entering the screen (when the last successful sync is older than 10 s, or there is none),
//             window focus, `visibilitychange` to visible, every 60 s while visible, after each write.
// Rules:      only registered stores are polled; never two syncs of one store at once; nothing at all
//             while the page is hidden (the timers are cancelled when it becomes hidden); errors back
//             off 60 -> 120 -> 300 s for the poll timer, a success resets it; nothing is polled while
//             offline (`isOnline()`), without counting that as an error.
// Lifetime:   every timer and listener is owned by the session container, so sign-out and session
//             expiry stop all of it (the scheduler registers itself and is disposed with the session).
// Background syncs NEVER touch the global `data-state`: they report through the callbacks given to
//             register(): `onBusy(bool)` (aria-busy on the list) and `onSync('idle'|'running'|'error')`
//             (data-sync on the screen root). `domCallbacks()` builds a pair that sets those attributes.
//
// No DOM access: timers and listeners come from the session, the document and window are injected.

export const DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  enterMinAgeMs: 10_000,
  backoffMs: Object.freeze([60_000, 120_000, 300_000]),
  minGapMs: 1_000,
  writeDelayMs: 300,
});

/** Callbacks that mirror the sync state onto two elements (anything with setAttribute/removeAttribute). */
export function domCallbacks({ listEl = null, rootEl = null } = {}) {
  return {
    onBusy(busy) {
      if (!listEl) return;
      if (busy) listEl.setAttribute('aria-busy', 'true');
      else listEl.removeAttribute ? listEl.removeAttribute('aria-busy') : listEl.setAttribute('aria-busy', 'false');
    },
    onSync(state) {
      if (rootEl) rootEl.setAttribute('data-sync', state);
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.session session container (timers and listeners)
 * @param {{visibilityState?: string, hidden?: boolean, addEventListener: Function}|null} [o.doc]
 * @param {{addEventListener: Function}|null} [o.win]
 * @param {() => number} [o.now]
 * @param {() => boolean} [o.isOnline]
 */
export function createScheduler({ session, doc = null, win = null, now = Date.now, isOnline = () => true, intervalMs = DEFAULTS.intervalMs, enterMinAgeMs = DEFAULTS.enterMinAgeMs, backoffMs = DEFAULTS.backoffMs, minGapMs = DEFAULTS.minGapMs, writeDelayMs = DEFAULTS.writeDelayMs } = {}) {
  if (!session) throw new TypeError('the scheduler needs the session container');
  const entries = new Map(); // store -> entry
  let stopped = false;

  const visible = () => {
    if (!doc) return true;
    if (typeof doc.visibilityState === 'string') return doc.visibilityState === 'visible';
    return doc.hidden !== true;
  };
  const call = (fn, arg) => {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch {
      /* a failing view callback must not stop the scheduler */
    }
  };
  const delayFor = (entry) => (entry.errors > 0 ? backoffMs[Math.min(entry.errors, backoffMs.length) - 1] : intervalMs);

  function cancelTimers(entry) {
    if (entry.timer) entry.timer();
    entry.timer = null;
    if (entry.writeTimer) entry.writeTimer();
    entry.writeTimer = null;
  }

  function scheduleNext(entry) {
    if (stopped || entries.get(entry.store) !== entry) return;
    if (entry.timer) entry.timer();
    entry.timer = null;
    if (!visible() || entry.fatal) return;
    entry.timer = session.setTimeout(() => {
      entry.timer = null;
      if (stopped || !visible()) return;
      run(entry, 'poll');
    }, delayFor(entry));
  }

  function run(entry, reason) {
    if (stopped || entries.get(entry.store) !== entry) return Promise.resolve(null);
    if (entry.running) {
      if (reason === 'write') entry.again = true;
      return entry.promise;
    }
    if (!visible()) return Promise.resolve(null);
    if (!isOnline()) {
      scheduleNext(entry);
      return Promise.resolve(null);
    }
    entry.running = true;
    call(entry.callbacks.onBusy, true);
    call(entry.callbacks.onSync, 'running');
    entry.promise = (async () => {
      let res = null;
      try {
        res = await entry.store.sync({ reason });
      } catch {
        res = { ok: false, kind: 'unknown' };
      }
      entry.running = false;
      entry.promise = null;
      entry.lastEnd = now();
      if (res && res.skipped === 'disposed') return res;
      if (res && res.ok) entry.errors = 0;
      else {
        entry.errors++;
        if (res && res.fatal) entry.fatal = true; // a 401: the session is ending, stop polling
      }
      call(entry.callbacks.onBusy, false);
      call(entry.callbacks.onSync, res && res.ok ? 'idle' : 'error');
      if (entry.again && !stopped) {
        entry.again = false;
        run(entry, 'write');
      } else scheduleNext(entry);
      return res;
    })();
    return entry.promise;
  }

  // A trigger that comes from the user's surroundings (focus, becoming visible): skip it when a sync
  // just finished, so a tab switch that fires both events costs one request.
  function trigger(entry, reason) {
    if (entry.running) return entry.promise;
    if (entry.lastEnd && now() - entry.lastEnd < minGapMs) {
      scheduleNext(entry);
      return Promise.resolve(null);
    }
    return run(entry, reason);
  }

  function onVisibility() {
    if (stopped) return;
    if (!visible()) {
      for (const e of entries.values()) cancelTimers(e);
      return;
    }
    for (const e of entries.values()) trigger(e, 'visible');
  }
  function onFocus() {
    if (stopped || !visible()) return;
    for (const e of entries.values()) trigger(e, 'focus');
  }
  if (doc) session.listen(doc, 'visibilitychange', onVisibility);
  if (win) session.listen(win, 'focus', onFocus);

  const scheduler = {
    /**
     * Start polling a store (the open address book). Does not sync by itself: call enter() for the
     * entering-the-screen sync. Returns the function that unregisters it.
     */
    register(store, callbacks = {}) {
      if (stopped) return () => {};
      const old = entries.get(store);
      if (old) {
        old.callbacks = callbacks;
        return () => scheduler.unregister(store);
      }
      const entry = { store, callbacks, running: false, promise: null, errors: 0, timer: null, writeTimer: null, lastEnd: 0, again: false, fatal: false };
      entries.set(store, entry);
      call(callbacks.onSync, 'idle');
      scheduleNext(entry);
      return () => scheduler.unregister(store);
    },
    unregister(store) {
      const e = entries.get(store);
      if (!e) return false;
      cancelTimers(e);
      entries.delete(store);
      return true;
    },
    /** Register (or re-register) and sync if the store was never synced or its last sync is over 10 s old. */
    enter(store, callbacks = {}) {
      scheduler.register(store, callbacks);
      const entry = entries.get(store);
      if (!entry || !visible()) return Promise.resolve(null);
      const age = store.lastSync ? now() - store.lastSync : Infinity;
      if (age > enterMinAgeMs) return run(entry, 'enter');
      scheduleNext(entry);
      return Promise.resolve(null);
    },
    /** A write went through: sync soon (calls close together share one sync). */
    afterWrite(store) {
      const entry = entries.get(store);
      if (!entry || stopped) return;
      if (entry.writeTimer) entry.writeTimer();
      entry.writeTimer = session.setTimeout(() => {
        entry.writeTimer = null;
        run(entry, 'write');
      }, writeDelayMs);
    },
    /** Sync now whatever the age (a user pressed Retry). */
    syncNow(store, reason = 'manual') {
      const entry = entries.get(store);
      return entry ? run(entry, reason) : store.sync({ reason });
    },
    isRegistered: (store) => entries.has(store),
    /** {running, errors, fatal, nextDelayMs} for diagnostics and tests. */
    state(store) {
      const e = entries.get(store);
      return e ? { running: e.running, errors: e.errors, fatal: e.fatal, nextDelayMs: delayFor(e), timerArmed: Boolean(e.timer) } : null;
    },
    get stopped() {
      return stopped;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const e of entries.values()) cancelTimers(e);
      entries.clear();
    },
  };
  scheduler.dispose = scheduler.stop;
  session.register(scheduler);
  return scheduler;
}
