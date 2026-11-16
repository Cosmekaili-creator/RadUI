// SPDX-License-Identifier: AGPL-3.0-or-later
// The administrator store of a signed-in session, built on demand by the Users screens and the sharing dialog
// (the shell does not provide one). ONE store per login session: it is cached on the session container, so the
// screens and the dialog share one mutation queue, and it is disposed with the session.
//
// Its waits (a 429 Retry-After) are session-aware: they reject when the session ends, so a loop waiting on the
// server stops instead of hanging (same pattern as the store context's own `sleep`).

import { createAdminStore } from '../../store/admin.js';

export const ADMIN_STORE_KEY = 'radui.admin-store';

function sessionSleep(session) {
  if (!session || typeof session.setTimeout !== 'function' || typeof session.onDispose !== 'function') return undefined; // the store's plain timer
  return (ms) =>
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
}

/**
 * @param {object} o
 * @param {object} o.app   screen app object (`api`, `dav`)
 * @param {object} o.store the store context (`session`, `access`, `writes`, `reporter`)
 * @param {() => number} [o.now]
 */
export function adminStoreFor({ app, store, now } = {}) {
  const session = store && store.session;
  const data = session && session.data instanceof Map ? session.data : null;
  const cached = data && data.get(ADMIN_STORE_KEY);
  if (cached && !(session && session.disposed)) return cached;
  const sleep = sessionSleep(session);
  const admin = createAdminStore({ api: app.api, client: app.dav, access: store.access, writes: store.writes, reporter: store.reporter, isDisposed: () => Boolean(session && session.disposed), ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) });
  if (data) {
    data.set(ADMIN_STORE_KEY, admin);
    if (typeof session.register === 'function') session.register(admin);
  }
  return admin;
}
