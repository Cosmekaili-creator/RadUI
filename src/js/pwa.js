// SPDX-License-Identifier: AGPL-3.0-or-later
// Service-worker registration and the update flow (docs/pwa.md).
//
// - Registers `sw.js` (relative to the page) with {scope: './', updateViaCache: 'none'}; only on a
//   secure context or on localhost; does nothing when service workers are unavailable.
// - Asks the browser for a new worker when the page becomes visible, at most once an hour.
// - A waiting worker shows the persistent `banner-update`. Its button asks the shell's discard
//   confirmation first when a form has unsaved input, then posts SKIP_WAITING to the worker and
//   reloads when the new worker has taken control.
// - Never throws: every failure leaves the app running without the service worker.
//
// - Another tab applied an update (an unrequested controllerchange): this page still runs the OLD
//   modules while its lazy imports would now be served from the NEW cache, so the page marks itself
//   stale, closes the write gate ('update': "Reload to continue") and shows the banner until it reloads.
//
// Hook (js/app.js): initPwa({ win, doc, t, guarded: (fn) => leave.guarded(fn) });

import { writeGate } from './ui.js';

const HOUR_MS = 60 * 60 * 1000;
const STUCK_MS = 10000;
const VERSION_MS = 2000;

/** True on a secure context, or on a loopback host (where browsers allow service workers too). */
export function canRegister(win) {
  try {
    if (!win || !win.navigator || !win.navigator.serviceWorker) return false;
    if (win.isSecureContext === true) return true;
    const host = String((win.location && win.location.hostname) || '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * @param {object} app
 * @param {Window} app.win
 * @param {Document} app.doc
 * @param {(key: string) => string} [app.t] translator (the pwa.* keys)
 * @param {(fn: () => void) => unknown} [app.guarded] runs `fn` now, or after the user agreed to
 *   discard unsaved input (the shell's `leave.guarded`)
 * @param {{setReason: (reason: string, text: string|null) => void}} [app.gate] the write gate (default: the shell's)
 * @param {() => number} [app.now] clock, injectable for tests
 * @returns {{ready: Promise<boolean>, supported: boolean, version: () => Promise<string|null>, update: () => Promise<boolean>, dispose: () => void}}
 */
export function initPwa({ win = globalThis.window, doc = globalThis.document, t = (k) => k, guarded = (fn) => fn(), gate = writeGate, now = Date.now } = {}) {
  const handle = {
    supported: false,
    ready: Promise.resolve(false),
    version: async () => null,
    update: async () => false,
    dispose() {},
  };
  try {
    if (!canRegister(win) || !doc) return handle;
    handle.supported = true;

    const sw = win.navigator.serviceWorker;
    const banner = doc.getElementById('banner-update');
    const button = doc.getElementById('btn-reload-update');
    const label = banner && banner.querySelector ? banner.querySelector('span') : null;
    const cleanups = [];
    const listen = (target, type, fn) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      cleanups.push(() => {
        if (typeof target.removeEventListener === 'function') target.removeEventListener(type, fn);
      });
    };

    let reg = null;
    let hadController = Boolean(sw.controller);
    let requested = false;
    let reloading = false;
    let lastCheck = now();
    let stuckTimer = null;

    const showBanner = () => {
      if (banner) banner.hidden = false;
    };
    // Stale page: the app was updated in another tab. Writes stay closed until this page reloads.
    const markStale = () => {
      try {
        if (gate && typeof gate.setReason === 'function') gate.setReason('update', t('pwa.stale.gate'));
      } catch {
        // the banner below is still shown
      }
      if (label) {
        label.textContent = t('pwa.stale.text');
        if (typeof label.setAttribute === 'function') label.setAttribute('data-i18n', 'pwa.stale.text'); // survives a language switch
      }
      showBanner();
    };
    const reload = () => {
      if (reloading) return;
      reloading = true;
      try {
        win.location.reload();
      } catch {
        reloading = false;
      }
    };

    function watchInstalling(worker) {
      if (!worker) return;
      listen(worker, 'statechange', () => {
        // First install has no controller: that worker activates by itself and no banner is needed.
        if (worker.state === 'installed' && sw.controller) showBanner();
      });
    }

    // The banner button: the new worker is told to take over; the page reloads when it has.
    function apply() {
      requested = true;
      const waiting = reg && reg.waiting;
      if (waiting) {
        try {
          waiting.postMessage({ type: 'SKIP_WAITING' });
        } catch {
          // handled by the timer below
        }
        const setTimer = win.setTimeout ? win.setTimeout.bind(win) : setTimeout;
        if (stuckTimer === null) {
          stuckTimer = setTimer(() => {
            stuckTimer = null;
            if (!reloading && label) label.textContent = t('pwa.update.stuck');
          }, STUCK_MS);
        }
      } else {
        reload(); // the new worker already took control (another tab applied it)
      }
    }
    listen(button, 'click', () => {
      try {
        guarded(apply);
      } catch {
        // nothing to do: the banner stays
      }
    });

    listen(sw, 'controllerchange', () => {
      if (requested) {
        reload();
      } else if (!hadController) {
        hadController = true; // first install claimed this page: not an update
      } else {
        markStale(); // another tab applied an update: this page still runs the old modules
      }
    });

    listen(doc, 'visibilitychange', () => {
      try {
        if (doc.visibilityState !== 'visible' || !reg) return;
        const t0 = now();
        if (t0 - lastCheck < HOUR_MS) return;
        lastCheck = t0;
        Promise.resolve(reg.update()).catch(() => {});
      } catch {
        // ignore
      }
    });

    handle.update = async () => {
      try {
        if (!reg) return false;
        lastCheck = now();
        await reg.update();
        return true;
      } catch {
        return false;
      }
    };

    handle.version = () =>
      new Promise((resolve) => {
        try {
          const worker = reg && (reg.active || sw.controller);
          if (!worker || typeof win.MessageChannel !== 'function') return resolve(null);
          const channel = new win.MessageChannel();
          const timer = (win.setTimeout || setTimeout)(() => resolve(null), VERSION_MS);
          channel.port1.onmessage = (e) => {
            if (win.clearTimeout) win.clearTimeout(timer);
            resolve(e && e.data && typeof e.data.version === 'string' ? e.data.version : null);
          };
          worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
        } catch {
          resolve(null);
        }
      });

    handle.dispose = () => {
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
      if (stuckTimer !== null && win.clearTimeout) win.clearTimeout(stuckTimer);
      stuckTimer = null;
    };

    const start = async () => {
      try {
        reg = await sw.register('sw.js', { scope: './', updateViaCache: 'none' });
        lastCheck = now();
        hadController = Boolean(sw.controller);
        listen(reg, 'updatefound', () => watchInstalling(reg.installing));
        if (reg.waiting && sw.controller) showBanner();
        else if (reg.installing) watchInstalling(reg.installing);
        return true;
      } catch {
        return false;
      }
    };

    if (doc.readyState === 'complete') {
      handle.ready = start();
    } else {
      handle.ready = new Promise((resolve) => {
        listen(win, 'load', () => resolve(start()));
      });
    }
  } catch {
    // a failure here must never break the app
  }
  return handle;
}
