// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the Users and sharing-dialog tests: an account-service fake that records every call (the real
// admin store runs on top of it, so previews, queues and error mapping are the real ones), a DAV client fake that
// lists the principals, a store context and a screen context. No tests in here.
import { ApiError, normalizeMutation } from '../../../src/js/api.js';
import { createReporter } from '../../../src/js/store/report.js';
import { createFeedback, createReadiness } from '../../../src/js/ui.js';
import { createI18n } from '../_i18n-all.mjs';
import { doc, flush, reset, tid, tidAll, text } from './collections-helpers.mjs';

export { doc, flush, reset, tid, tidAll, text };
export const i18n = { en: createI18n({ lang: 'en' }), fr: createI18n({ lang: 'fr' }) };
/** Text without the bidi isolation marks `isolate()` puts around names. */
export const plain = (s) => String(s ?? '').replace(/[\u2066-\u2069]/g, '');
export const tFor = (lang = 'en') => (k, p) => i18n[lang].t(k, p);

export const acct = (login, over = {}) => ({ login, displayName: login[0].toUpperCase() + login.slice(1), type: 'person', admin: false, disabled: false, ownSpace: true, created: '2026-03-04T12:00:00Z', passwordChanged: '2026-03-05T12:00:00Z', ...over });
export const coll = (href, over = {}) => ({ href, kind: href.includes('book') ? 'addressbook' : 'calendar', name: href.split('/').filter(Boolean).pop(), displayName: '', color: null, components: ['VEVENT'], etag: '"e1"', ...over });
export const grant = (owner, collection, grantee, level = 'read') => ({ owner, collection, grantee, level, grantedBy: owner, created: '2026-03-06T12:00:00Z' });

/** An account service fake. `calls` records `METHOD(args)` strings in order; `fail` makes a method throw an ApiError. */
export function fakeApi({ accounts = [], grants = [], directory = null, effective = {}, fail = {}, password = null } = {}) {
  const state = { accounts: accounts.map((a) => ({ ...a })), grants: grants.map((g) => ({ ...g })) };
  const calls = [];
  const bodies = [];
  const maybeFail = (name, ...args) => {
    const f = fail[name];
    if (!f) return;
    const e = typeof f === 'function' ? f(...args) : f;
    if (e) throw e;
  };
  const mut = (extra = {}) => normalizeMutation({ generation: 7, active: true, ...extra });
  const api = {
    calls,
    bodies,
    state,
    async accounts() {
      calls.push('accounts');
      maybeFail('accounts');
      return state.accounts.map((a) => ({ ...a }));
    },
    async grants(q) {
      calls.push(`grants(${q ? JSON.stringify(q) : ''})`);
      maybeFail('grants', q);
      return state.grants.filter((g) => (!q || !q.owner || g.owner === q.owner) && (!q || !q.grantee || g.grantee === q.grantee)).map((g) => ({ ...g }));
    },
    async directory() {
      calls.push('directory');
      maybeFail('directory');
      return directory || state.accounts.filter((a) => !a.disabled).map((a) => ({ login: a.login, displayName: a.displayName, type: a.type }));
    },
    async effective(login) {
      calls.push(`effective(${login})`);
      maybeFail('effective', login);
      return effective[login] || [{ path: `/${login}/*`, level: 'own', letters: 'rwDO' }];
    },
    async putGrant(g, { dryRun = false } = {}) {
      calls.push(`putGrant(${dryRun ? 'dry' : 'real'}:${g.owner}/${g.collection}:${g.grantee}:${g.level})`);
      bodies.push({ method: 'putGrant', ...g, dryRun });
      maybeFail('putGrant', g, dryRun);
      if (dryRun) return { dryRun: true, noop: false, summary: 'Grant', generation: 7, active: true, rights: { added: [], removed: [] }, effective: [{ login: g.grantee, path: `/${g.owner}/${g.collection}`, before: 'none', after: g.level }] };
      state.grants = state.grants.filter((x) => !(x.owner === g.owner && x.collection === g.collection && x.grantee === g.grantee));
      if (g.level !== 'none') state.grants.push({ ...g, grantedBy: g.owner, created: '2026-03-07T12:00:00Z' });
      return { grant: g.level === 'none' ? null : { ...g, grantedBy: g.owner, created: '2026-03-07T12:00:00Z' }, generation: 8, active: true };
    },
    async createAccount(body, { dryRun = false } = {}) {
      calls.push(`createAccount(${dryRun ? 'dry' : 'real'}:${body.login})`);
      bodies.push({ method: 'createAccount', ...body, dryRun });
      maybeFail('createAccount', body);
      const rec = { login: body.login, displayName: body.displayName, type: body.type || 'person', admin: body.admin === true, disabled: false, ownSpace: body.ownSpace !== false, created: '2026-03-08T12:00:00Z', passwordChanged: '2026-03-08T12:00:00Z' };
      if (dryRun) return mut({ dryRun: true, summary: 'Create' });
      state.accounts.push(rec);
      return mut({ account: rec, ...(body.generate ? { password: password || 'Abcde-Fghjk-Lmnpq-Rstuv' } : {}) });
    },
    async patchAccount(login, body, { dryRun = false } = {}) {
      calls.push(`patchAccount(${dryRun ? 'dry' : 'real'}:${login}:${JSON.stringify(body)})`);
      bodies.push({ method: 'patchAccount', login, ...body, dryRun });
      maybeFail('patchAccount', login, body, dryRun);
      const a = state.accounts.find((x) => x.login === login);
      if (dryRun) return mut({ dryRun: true, summary: 'Change', ...(fail.confirmRequired && body.ownSpace === false ? { confirmRequired: fail.confirmRequired } : {}) });
      const { confirm, ...patch } = body; // eslint-disable-line no-unused-vars
      Object.assign(a, patch);
      return mut({ account: { ...a } });
    },
    async resetPassword(login, body) {
      calls.push(`resetPassword(${login})`);
      bodies.push({ method: 'resetPassword', login, ...body });
      maybeFail('resetPassword', login);
      return mut(body.generate ? { password: password || 'Wxyz2-3456a-Bcdef-Ghjkm' } : {});
    },
    async deleteAccount(login, confirm, { dryRun = false } = {}) {
      calls.push(`deleteAccount(${dryRun ? 'dry' : 'real'}:${login})`);
      bodies.push({ method: 'deleteAccount', login, confirm, dryRun });
      maybeFail('deleteAccount', login, dryRun);
      if (dryRun) return mut({ dryRun: true, summary: 'Delete' });
      state.accounts = state.accounts.filter((a) => a.login !== login);
      state.grants = state.grants.filter((g) => g.owner !== login && g.grantee !== login);
      return mut({ deleted: login });
    },
  };
  return api;
}

export const apiError = (kind, info = {}) => new ApiError(kind, info);

/** DAV client fake: `homes` maps a principal href ('/alice/') to its collections. */
export function fakeClient(homes = {}) {
  const calls = [];
  return {
    calls,
    async principal() {
      return '/alice/';
    },
    async listCollections(home) {
      calls.push(home);
      const list = homes[home];
      if (list instanceof Error) throw list;
      return (list || []).map((c) => ({ ...c }));
    },
  };
}

/** Everything a Users screen or the share dialog needs from `app` and from the store context. */
export function fixture({ login = 'alice', admin = true, accounts = null, grants = [], homes = null, apiOver = {}, lang = 'en', route = { name: 'users', query: {}, params: {} }, effective = {}, fail = {} } = {}) {
  const accts = accounts || [acct('alice', { admin: true }), acct('bob'), acct('carol'), acct('agent-1', { type: 'bot' })];
  const api = fakeApi({ accounts: accts, grants, effective, fail });
  Object.assign(api, apiOver);
  const homeMap = homes || { '/alice/': [coll('/alice/work/', { displayName: 'Work' }), coll('/alice/book/', { displayName: 'People' })], '/bob/': [coll('/bob/notes/'), coll('/bob/book/', { displayName: 'Bob book' })], '/carol/': [], '/agent-1/': [] };
  const client = fakeClient(homeMap);
  const feedback = createFeedback();
  feedback.enterScreen('users');
  const activity = [];
  const tr = tFor(lang);
  const reporter = createReporter({ activity: { add: (e) => activity.push(e) }, feedback, t: tr });
  const deleted = [];
  const writes = {
    failOn: null,
    async deleteCollection({ href }) {
      if (writes.failOn === href) return { ok: false, status: 'forbidden', message: 'refused' };
      deleted.push(href);
      for (const k of Object.keys(homeMap)) homeMap[k] = homeMap[k].filter((c) => c.href !== href);
      return { ok: true, status: 'deleted', message: '', href };
    },
  };
  const exportCalls = [];
  const store = {
    session: { login, data: new Map(), disposed: false },
    access: { me: { login }, refetchCalls: [], async refetch(o) { this.refetchCalls.push(o); return { ok: true }; }, list: () => [] },
    writes,
    reporter,
    exportCalls,
    async exportCollection(opts) {
      exportCalls.push(opts);
      return { ok: true, status: 'ok', filename: 'x.ics', mime: 'text/calendar', text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', count: 1, groupsExcluded: 0, empty: false };
    },
  };
  const nav = [];
  const dirty = [];
  const abort = new AbortController();
  const me = { login, displayName: login, type: 'person', admin };
  const app = {
    feedback,
    readiness: createReadiness(() => {}),
    api,
    dav: client,
    lang,
    gate: { blocked: false },
    navigate: (hash, opts) => nav.push({ hash, opts }),
    setDirty: (v) => dirty.push(Boolean(v)),
    getStore: async () => store,
    getMe: async () => me,
    isAdmin: () => admin,
    session: store.session,
    nav,
    dirty,
  };
  const i = i18n[lang];
  const ctxFor = (root, r = route, restore = null) => ({ root, t: (k, p) => i.t(k, p), tp: (k, n, p) => i.tp(k, n, p), params: r.params || {}, route: r, host: 'example.org', restore, signal: abort.signal, app });
  return { api, client, homeMap, writes, app, store, feedback, activity, deleted, nav, dirty, accts, ctxFor, me, t: tr, tp: (k, n, p) => i.tp(k, n, p) };
}
