// SPDX-License-Identifier: AGPL-3.0-or-later
// Wiring of the store layer for ONE session: access list, item stores, scheduler, write path, import and
// export, all owned by the session container (they stop and are forgotten when it is disposed, on sign-out
// and on session expiry). The shell (or a screen, on first use) calls this once per login and keeps the result
// in `session.data`.

import { createAccess } from './access.js';
import { createCalendars } from './calendars.js';
import { exportCollection, exportItem } from './export.js';
import { startImport } from './importrun.js';
import { createStores } from './itemstore.js';
import { createReporter } from './report.js';
import { createScheduler } from './scheduler.js';
import { createWrites } from './writes.js';

/**
 * @param {object} o
 * @param {object} o.session the session container (js/session.js)
 * @param {object} o.client DAV client
 * @param {object} [o.api] account-service client (me, meAccess, grants, putGrant)
 * @param {object} [o.activity] activity log of the shell
 * @param {object} [o.feedback] feedback store of the shell
 * @param {Function} [o.t] translator (replace it with reporter.setTranslator when the language changes)
 * @param {object} [o.gate] write gate (app.gate)
 * @param {object} [o.doc] document (visibility), {object} [o.win] window (focus)
 * @param {Function} [o.isOnline] () => boolean
 * @param {object} [o.model] {openItem, createItem, createGroupItem}; lazily imported when absent
 */
export function createStoreContext({ session, client, api = null, activity = null, feedback = null, t = null, gate = null, doc = null, win = null, isOnline = () => true, now = Date.now, model = null, random, scheduling = {} } = {}) {
  if (!session) throw new TypeError('createStoreContext needs the session container');
  const reporter = createReporter({ activity, feedback, t });
  const access = createAccess({ api, client, session });
  session.register(access);
  const stores = createStores({ client, session, now, reporter, onAccessSignal: () => void access.refetch({ reason: 'sync-signal' }) });
  const scheduler = createScheduler({ session, doc, win, now, isOnline, ...scheduling });
  // A wait that ends with the session REJECTS, so a revoke loop waiting on Retry-After stops instead of hanging.
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      if (session.disposed) return reject(new Error('session ended'));
      const cancel = session.setTimeout(() => {
        off();
        resolve();
      }, ms);
      const off = session.onDispose(() => {
        cancel();
        reject(new Error('session ended'));
      });
    });
  const writes = createWrites({ client, api, stores, access, scheduler, reporter, gate, login: session.login, model, random, sleep, isDisposed: () => session.disposed });
  const calendars = createCalendars({ stores, scheduler, session, model });
  return {
    session,
    reporter,
    access,
    stores,
    scheduler,
    writes,
    /** The enabled calendars and task lists (RUN3): enable/disable, occurrences(from, to), entries({kind}). */
    calendars,
    setTranslator: (fn) => reporter.setTranslator(fn),
    /** Start a `.vcf` import into `collection` (an address book href): {cancel, done}. */
    /** The import is tied to the session: disposing it cancels the run, and the worker stops on `session.disposed`. */
    startImport: (opts) => {
      const h = startImport({ client, store: stores.get(opts.collection), scheduler, reporter, gate, isOnline, model, random, isDisposed: () => session.disposed, ...opts });
      const off = session.onDispose(() => h.cancel());
      h.done.finally(off);
      return h;
    },
    exportCollection: (opts) => exportCollection({ client, reporter, store: stores.get(opts.collection.href), ...opts }),
    exportItem: (opts) => exportItem({ reporter, ...opts }),
  };
}
