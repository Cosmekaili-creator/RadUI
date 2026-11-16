// SPDX-License-Identifier: AGPL-3.0-or-later
// Administrator store: accounts, grants and the collections of every account, on top of the account
// service (api.js admin endpoints) and the DAV client (Depth-1 listing of a principal, which the
// administrator's own rights allow for every account). See docs/admin-ui.md.
//
// Rules:
//  - every MUTATION runs one at a time (an internal queue), a 429 is retried after its Retry-After (at most
//    twice, at most 60 s each, `sleep` injected);
//  - `preview*` sends the dry run (`?dryRun=1`, nothing is written, nothing is logged), `apply*` the real call;
//  - functions resolve with `{ok, status, message, ...}` and do not throw for expected failures (a TypeError
//    for a malformed argument is a programming error and is thrown);
//  - a password is returned to the caller in the result of createAccount / resetPassword ONCE and is never
//    kept in the store state, never given to the reporter (Activity, status, alert) and never logged;
//  - an Activity line (`account`, `grant`, `password`) is written per real mutation, without secrets;
//  - when a change concerns the signed-in account the access list is read again (`access.refetch`).
//
// No DOM, no timers of its own (the default `sleep` is a plain setTimeout promise).

import { ApiError, normalizeMutation } from '../api.js';
import { classify, leafOf } from './errors.js';

/** Error codes of docs/api.md "Errors" (plus the service's grant codes and the 202 warning) that have an `err.api.<code>` text. */
export const API_ERROR_CODES = Object.freeze([
  'bad_request',
  'missing_header',
  'unauthenticated',
  'forbidden',
  'not_found',
  'collection_not_found',
  'exists',
  'tombstoned',
  'lockout_last_admin',
  'lockout_self',
  'too_large',
  'unsupported_media_type',
  'validation',
  'unsupported_collection_name',
  'rate_limited',
  'internal',
  'radicale_unexpected',
  'busy',
  'model_corrupt',
  'grantee_disabled',
  'grantee_is_admin',
  'activation_pending',
]);

const MAX_RETRY_WAIT_S = 60;
const COLLECTION_PARALLELISM = 2;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byLogin = (a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0);

/** The `err.api.*` key for a classified error. */
export function apiErrorKey(c) {
  if (c.code && API_ERROR_CODES.includes(c.code)) return `err.api.${c.code}`;
  if (c.kind === 'network') return 'err.api.network';
  if (c.kind === 'auth') return 'err.api.unauthenticated';
  if (c.kind === 'forbidden') return 'err.api.forbidden';
  return 'err.api.unknown';
}

/**
 * @param {object} o
 * @param {object} o.api account-service client (api.js)
 * @param {object} o.client DAV client (`principal`, `listCollections`)
 * @param {object} [o.access] access store (`me`, `refetch`)
 * @param {object} [o.writes] write path (`deleteCollection`), needed for `deleteAccount({deleteData: true})`
 * @param {object} [o.reporter] store reporter (log / status / alert / text)
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep] a wait that rejects when the session ends
 * @param {() => boolean} [o.isDisposed] true once the session ended: a multi-step write stops before its next request (status `aborted`)
 */
export function createAdminStore({ api, client, access = null, writes = null, reporter = null, now = Date.now, sleep = defaultSleep, isDisposed = () => false } = {}) {
  if (!api) throw new TypeError('createAdminStore needs the account-service client');

  let accounts = [];
  let grants = [];
  let collectionsByOwner = {};
  let collectionErrors = {};
  let loadedAt = null;
  let queue = Promise.resolve();
  let principalBase = null;
  const listeners = new Set();
  const emit = (type) => {
    for (const fn of [...listeners]) {
      try {
        fn({ type });
      } catch {
        /* a failing subscriber must not break the others */
      }
    }
  };

  const text = (key, params) => (reporter ? reporter.text(key, params) : key);
  const log = (op, target, result, detail = '') => (reporter ? reporter.log(op, target, result, detail) : null);
  const myLogin = () => (access && access.me && access.me.login) || null;
  const iso = () => new Date(now()).toISOString();

  /** Failure result of a classified error. `quiet` skips the alert (dry runs: the dialog shows the text). */
  function failure(e, { quiet = false, extra = {} } = {}) {
    if (e && e.name === 'AbortedError') return { ok: false, status: 'aborted', kind: 'aborted', code: null, field: null, httpStatus: null, retryAfter: null, message: '', ...extra };
    const c = classify(e);
    if (c.kind === 'unknown') throw e; // a programming error, not an answer of the server
    const key = apiErrorKey(c);
    const message = quiet ? text(key) : reporter ? reporter.alert(key) : text(key);
    return { ok: false, status: c.code || c.kind, kind: c.kind, code: c.code, field: (e && e.field) || null, httpStatus: c.status, retryAfter: c.retryAfter, message, ...extra };
  }

  /** Run `fn`, waiting out a 429 (Retry-After) up to twice. */
  async function retrying(fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const c = classify(e);
        if (c.kind !== 'ratelimited' || attempt >= 3 || (c.retryAfter ?? 1) > MAX_RETRY_WAIT_S) throw e;
        try {
          await sleep(Math.max(0, c.retryAfter ?? 1) * 1000);
        } catch {
          throw Object.assign(new Error('session ended'), { name: 'AbortedError' }); // the session ended while waiting: stop
        }
      }
    }
  }

  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function refetchIfMe(...logins) {
    const me = myLogin();
    if (access && me && logins.includes(me)) await access.refetch({ reason: 'admin' });
  }

  function resultOf(m, extra = {}) {
    const status = m.dryRun ? 'preview' : m.noop ? 'noop' : m.pending ? 'pending' : 'ok';
    let message = '';
    if (status === 'pending') message = reporter ? reporter.status('err.api.activation_pending') : text('err.api.activation_pending');
    return { ok: true, status, message, ...m, ...extra };
  }

  /** A dry run: no queue, no log, no state change. */
  async function preview(run) {
    try {
      return resultOf(await retrying(run));
    } catch (e) {
      return failure(e, { quiet: true });
    }
  }

  /** A real change: queued, logged, state updated by `onOk`. */
  function mutate({ op, target, detail = '', run, onOk, concerns = [] }) {
    return serial(async () => {
      let m;
      try {
        m = await retrying(run);
      } catch (e) {
        const r = failure(e);
        log(op, target, 'error', r.code || r.kind);
        return r;
      }
      if (!m.noop && onOk) onOk(m);
      log(op, target, 'ok', m.noop ? 'no change' : m.pending ? `${detail} (activation pending)`.trim() : detail);
      if (!m.noop) emit('change');
      await refetchIfMe(...concerns);
      return resultOf(m);
    });
  }

  // ------------------------------------------------------------ loading

  const principalOf = async (login) => {
    if (!principalBase) {
      const p = String(await client.principal());
      const segs = p.split('/').filter(Boolean);
      principalBase = '/' + segs.slice(0, -1).join('/');
      if (principalBase !== '/') principalBase += '/';
    }
    return `${principalBase}${encodeURIComponent(login)}/`;
  };

  async function loadCollectionsFor(login) {
    try {
      const list = await client.listCollections(await principalOf(login));
      collectionsByOwner = { ...collectionsByOwner, [login]: list.map((c) => ({ ...c, owner: login })) };
      const { [login]: _gone, ...rest } = collectionErrors; // eslint-disable-line no-unused-vars
      collectionErrors = rest;
      return { ok: true, collections: collectionsByOwner[login] };
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'auth') throw e;
      collectionErrors = { ...collectionErrors, [login]: { kind: c.kind, status: c.status } };
      return { ok: false, kind: c.kind, collections: collectionsByOwner[login] || [] };
    }
  }

  async function pool(items, worker) {
    let next = 0;
    const run = async () => {
      while (next < items.length) await worker(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(COLLECTION_PARALLELISM, items.length) }, run));
  }

  const snapshot = () => ({ accounts: accounts.slice(), grants: grants.slice(), collectionsByOwner: { ...collectionsByOwner }, collectionErrors: { ...collectionErrors }, loadedAt });

  const store = {
    /**
     * Read the accounts and every grant. With `{collections: true}` also the collections of every enabled
     * account (Depth-1 PROPFIND of each principal, two at a time; for the permission matrix); otherwise use
     * `loadCollections(login)` lazily. A failing principal does not fail the load (see `collectionErrors`).
     * @returns {Promise<{ok: boolean, accounts: object[], grants: object[], collectionsByOwner: object, collectionErrors: object}>}
     */
    async load({ collections = false } = {}) {
      try {
        accounts = (await retrying(() => api.accounts())).sort(byLogin);
        grants = await retrying(() => api.grants());
        loadedAt = now();
      } catch (e) {
        return { ...failure(e, { quiet: true }), ...snapshot() };
      }
      emit('load');
      if (collections) {
        const logins = accounts.filter((a) => !a.disabled && a.ownSpace).map((a) => a.login);
        try {
          await pool(logins, loadCollectionsFor);
        } catch (e) {
          return { ...failure(e, { quiet: true }), ...snapshot() };
        }
        emit('collections');
      }
      return { ok: true, status: 'ok', ...snapshot() };
    },
    /** The collections of one account (lazy, for its own view). */
    async loadCollections(login) {
      try {
        const r = await loadCollectionsFor(login);
        emit('collections');
        return { ...r, status: r.ok ? 'ok' : r.kind };
      } catch (e) {
        return failure(e, { quiet: true });
      }
    },
    /** `GET effective/{login}`. */
    async effective(login) {
      try {
        return { ok: true, status: 'ok', effective: await retrying(() => api.effective(login)) };
      } catch (e) {
        return failure(e, { quiet: true });
      }
    },
    /** Enabled accounts (login, displayName, type), for pickers. */
    async directory() {
      try {
        return { ok: true, status: 'ok', directory: await retrying(() => api.directory()) };
      } catch (e) {
        return failure(e, { quiet: true });
      }
    },
    get state() {
      return snapshot();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      listeners.clear();
      accounts = [];
      grants = [];
      collectionsByOwner = {};
      collectionErrors = {};
    },

    // -------------------------------------------------------- grants

    /** Dry run of one grant change `{owner, collection, grantee, level}`. */
    previewGrant: (g) => preview(async () => normalizeMutation(await api.putGrant(g, { dryRun: true }))),
    /** The real grant change (level `none` revokes). */
    applyGrant(g) {
      const target = `${g.owner}/${g.collection} → ${g.grantee}`;
      return mutate({
        op: 'grant',
        target,
        detail: g.level,
        concerns: [g.grantee, g.owner],
        run: async () => normalizeMutation(await api.putGrant(g)),
        onOk: () => {
          const rest = grants.filter((x) => !(x.owner === g.owner && x.collection === g.collection && x.grantee === g.grantee));
          grants = g.level === 'none' ? rest : [...rest, { owner: g.owner, collection: g.collection, grantee: g.grantee, level: g.level, grantedBy: myLogin(), created: iso() }];
        },
      });
    },

    // -------------------------------------------------------- accounts

    /** Dry run of an account creation (body as `api.createAccount`). */
    previewCreateAccount: (body) => preview(() => api.createAccount(body, { dryRun: true })),
    /**
     * Create an account. A generated password is in `result.password` ONCE; the caller shows it in a
     * one-time dialog and drops it. Nothing about it is stored or logged here.
     */
    createAccount(body) {
      return mutate({
        op: 'account',
        target: body.login,
        detail: `created${body.type ? ' (' + body.type + ')' : ''}`,
        run: () => api.createAccount(body),
        onOk: (m) => {
          if (m.account) accounts = [...accounts.filter((a) => a.login !== m.account.login), m.account].sort(byLogin);
        },
      });
    },
    /** Dry run of a change: `{login, patch}`; the patch may carry `confirm` (see `result.confirmRequired`). */
    previewAccountChange: ({ login, patch }) => preview(() => api.patchAccount(login, patch, { dryRun: true })),
    applyAccountChange({ login, patch }) {
      return mutate({
        op: 'account',
        target: login,
        detail: `changed: ${Object.keys(patch).filter((k) => k !== 'confirm').join(', ')}`,
        concerns: [login],
        run: () => api.patchAccount(login, patch),
        onOk: (m) => {
          accounts = accounts.map((a) => (a.login === login ? (m.account ? m.account : { ...a, ...patch }) : a));
        },
      });
    },
    /** Set a password (`{login, password}`) or generate one (`{login, generate: true}`: `result.password`, once). */
    resetPassword({ login, password, generate }) {
      const body = generate ? { generate: true } : { password };
      return mutate({
        op: 'password',
        target: login,
        detail: generate ? 'generated' : 'set',
        concerns: [login],
        run: () => api.resetPassword(login, body),
        onOk: () => {
          accounts = accounts.map((a) => (a.login === login ? { ...a, passwordChanged: iso() } : a));
        },
      });
    },
    /**
     * Delete an account. With `deleteData` the account's collections are deleted FIRST (D-R3-11): a dry run of
     * the account deletion (lockout, unknown login), a fresh Depth-1 listing, then `writes.deleteCollection`
     * one at a time, stopping at the first failure, then a check that nothing is left; only then the real
     * `DELETE accounts/<login>`. A failure leaves the account in place and names what remains (persistent alert).
     * `expected` is the listing the confirmation dialog showed (`[{href, etag}]`): the fresh listing must match it
     * exactly (same hrefs, same ETags), otherwise nothing is deleted and the result is `changed`; the ETags sent
     * with the deletions are the dialog's, never the ones just re-read (that comparison would always pass).
     * A session that ended stops the sequence before its next request (`aborted`).
     * @param {{login: string, deleteData?: boolean, expected?: Array<{href: string, etag?: string|null}>|null, onProgress?: (p: {phase: string, done: number, total: number, href?: string}) => void}} o
     */
    deleteAccount({ login, deleteData = false, expected = null, onProgress = () => {} }) {
      return serial(async () => {
        const progress = (p) => {
          try {
            onProgress(p);
          } catch {
            /* a failing callback must not stop the deletion */
          }
        };
        const refuse = (r) => {
          log('account', login, 'error', r.code || r.status);
          return r;
        };
        const stopped = (deletedCollections) => refuse(failure(Object.assign(new Error('session ended'), { name: 'AbortedError' }), { extra: { deletedCollections } }));
        if (myLogin() === login) return refuse(failure(new ApiError('conflict', { status: 409, code: 'lockout_self' })));
        if (deleteData && !writes) throw new TypeError('deleting data needs the write path');
        if (deleteData && !Array.isArray(expected)) throw new TypeError('deleting data needs the listing the dialog showed (expected)');
        const deletedCollections = [];
        if (deleteData) {
          if (isDisposed()) return stopped(deletedCollections);
          try {
            await retrying(() => api.deleteAccount(login, login, { dryRun: true })); // nothing is deleted when the account itself cannot be
          } catch (e) {
            return refuse(failure(e));
          }
          progress({ phase: 'list', done: 0, total: 0 });
          if (isDisposed()) return stopped(deletedCollections);
          let list;
          try {
            list = await client.listCollections(await principalOf(login));
          } catch (e) {
            return refuse(failure(e, { extra: { deletedCollections } }));
          }
          const seen = new Map(expected.map((x) => [x.href, x.etag || null]));
          const same = list.length === seen.size && list.every((c) => seen.has(c.href) && seen.get(c.href) === (c.etag || null));
          if (!same) {
            const message = reporter ? reporter.alert('err.api.data_changed', { login }, { persistent: true }) : text('err.api.data_changed', { login });
            return refuse({ ok: false, status: 'changed', kind: 'changed', code: 'data_changed', field: null, httpStatus: null, retryAfter: null, message, deletedCollections });
          }
          const total = list.length;
          for (const c of list) {
            if (isDisposed()) return stopped(deletedCollections);
            progress({ phase: 'delete', done: deletedCollections.length, total, href: c.href });
            const r = await writes.deleteCollection({ href: c.href, kind: c.kind || null, expectedEtag: seen.get(c.href) });
            if (!r || r.ok !== true) {
              const remaining = list.filter((x) => !deletedCollections.includes(x.href)).map((x) => x.href);
              return refuse(dataLeft(login, remaining, { href: c.href, status: (r && r.status) || 'error', message: (r && r.message) || '' }, deletedCollections));
            }
            deletedCollections.push(c.href);
          }
          // Everything must really be gone before the account is.
          if (isDisposed()) return stopped(deletedCollections);
          let left;
          try {
            left = await client.listCollections(await principalOf(login));
          } catch (e) {
            return refuse(failure(e, { extra: { deletedCollections } }));
          }
          if (left.length) return refuse(dataLeft(login, left.map((x) => x.href), { href: left[0].href, status: 'still-there', message: '' }, deletedCollections));
          progress({ phase: 'account', done: total, total });
        }
        if (isDisposed()) return stopped(deletedCollections);
        let m;
        try {
          m = await retrying(() => api.deleteAccount(login, login));
        } catch (e) {
          return refuse(failure(e, { extra: { deletedCollections } }));
        }
        accounts = accounts.filter((a) => a.login !== login);
        grants = grants.filter((g) => g.owner !== login && g.grantee !== login);
        const { [login]: _c, ...restC } = collectionsByOwner; // eslint-disable-line no-unused-vars
        collectionsByOwner = restC;
        log('account', login, 'ok', deleteData ? `deleted with ${deletedCollections.length} collections` : 'deleted (data kept)');
        emit('change');
        return resultOf(m, { deletedCollections, dataDeleted: deleteData });
      });
    },
  };

  function dataLeft(login, remaining, failed, deletedCollections) {
    const names = remaining.map(leafOf).join(', ');
    const message = reporter ? reporter.alert('err.api.data_left', { login, count: remaining.length, names }, { persistent: true }) : text('err.api.data_left', { login, count: remaining.length, names });
    return { ok: false, status: 'data-left', kind: 'data-left', code: 'data_left', field: null, httpStatus: null, retryAfter: null, message, failed, remaining, deletedCollections };
  }

  return store;
}
