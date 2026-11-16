// SPDX-License-Identifier: AGPL-3.0-or-later
// store/admin.js against a fake account service, a fake DAV client and a fake write path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../../../src/js/api.js';
import { DavError } from '../../../src/js/dav/http.js';
import { createActivityLog, createFeedback } from '../../../src/js/ui.js';
import { createReporter } from '../../../src/js/store/report.js';
import { createAdminStore, API_ERROR_CODES } from '../../../src/js/store/admin.js';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';

const PW = 'Sentinel-pw-123';
const acct = (login, extra = {}) => ({ login, displayName: login, type: 'person', admin: false, disabled: false, ownSpace: true, created: 'c', passwordChanged: null, ...extra });
const mut = (extra = {}) => ({ dryRun: false, noop: false, generation: 2, active: true, warning: null, pending: false, summary: null, confirmRequired: false, confirm: null, rights: { added: [], removed: [] }, effective: [], effectiveTruncated: false, account: null, grant: null, deleted: null, password: null, ...extra });
const err = (status, code, extra = {}) => new ApiError({ 400: 'badrequest', 401: 'auth', 403: 'forbidden', 404: 'notfound', 409: 'conflict', 422: 'validation', 429: 'ratelimited', 500: 'server', 503: 'unavailable' }[status], { status, code, ...extra });

function setup({ accounts = [acct('admin', { admin: true }), acct('alice'), acct('bob')], grants = [], collections = {}, me = 'admin' } = {}) {
  const log = [];
  const failures = [];
  const hit = (name, args) => {
    log.push(name + (args ? ' ' + args : ''));
    const i = failures.findIndex((f) => f.name === name);
    if (i >= 0) {
      const f = failures[i];
      if (--f.times <= 0) failures.splice(i, 1);
      throw f.error;
    }
  };
  const api = {
    accounts: async () => (hit('accounts'), accounts.map((a) => ({ ...a }))),
    grants: async () => (hit('grants'), grants.map((g) => ({ ...g }))),
    directory: async () => (hit('directory'), accounts.map((a) => ({ login: a.login, displayName: a.displayName, type: a.type }))),
    effective: async (l) => (hit('effective', l), [{ path: `${l}/*`, level: 'own', letters: 'RWrwDO' }]),
    createAccount: async (b, o = {}) => (hit(o.dryRun ? 'createAccount.dry' : 'createAccount', b.login), mut({ dryRun: !!o.dryRun, account: o.dryRun ? null : acct(b.login, { type: b.type || 'person' }), password: b.generate && !o.dryRun ? PW : null })),
    patchAccount: async (l, b, o = {}) => (hit(o.dryRun ? 'patch.dry' : 'patch', l), mut({ dryRun: !!o.dryRun, account: acct(l, b) })),
    resetPassword: async (l, b, o = {}) => (hit(o.dryRun ? 'password.dry' : 'password', l), mut({ dryRun: !!o.dryRun, password: b.generate && !o.dryRun ? PW : null })),
    deleteAccount: async (l, c, o = {}) => (hit(o.dryRun ? 'delete.dry' : 'delete', `${l} ${c}`), mut({ dryRun: !!o.dryRun, deleted: o.dryRun ? null : l })),
    putGrant: async (g, o = {}) => (hit(o.dryRun ? 'grant.dry' : 'grant', `${g.owner}/${g.collection}>${g.grantee}=${g.level}`), { grant: g.level === 'none' ? null : g, generation: 3, active: true, dryRun: !!o.dryRun }),
  };
  let listed = { ...collections };
  const principals = [];
  const client = {
    principal: async () => '/admin/',
    listCollections: async (home) => {
      hit('list', home);
      principals.push(home);
      const login = decodeURIComponent(home.split('/').filter(Boolean).pop());
      return (listed[login] || []).map((c) => ({ ...c }));
    },
  };
  const deleted = [];
  const writes = {
    deleteCollection: async (a) => {
      hit('deleteCollection', a.href);
      deleted.push(a);
      for (const k of Object.keys(listed)) listed[k] = listed[k].filter((c) => c.href !== a.href);
      return { ok: true, status: 'deleted' };
    },
  };
  const activity = createActivityLog();
  const feedback = createFeedback();
  const reporter = createReporter({ activity, feedback, t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k) });
  const refetches = [];
  const access = { me: { login: me }, refetch: async (o) => (refetches.push(o.reason), { ok: true }) };
  const sleeps = [];
  const store = createAdminStore({ api, client, access, writes, reporter, sleep: async (ms) => void sleeps.push(ms), now: () => 1_700_000_000_000 });
  const expected = (l) => (listed[l] || []).map((c) => ({ href: c.href, etag: c.etag || null }));
  return { expected, store, api, client, writes, log, failures, activity, feedback, refetches, sleeps, deleted, principals, setCollections: (c) => (listed = c) };
}
const book = (owner, name) => ({ href: `/${owner}/${name}/`, kind: 'addressbook', etag: `"e-${name}"`, displayName: name });

test('load(): accounts (sorted) and all grants; collections stay lazy', async () => {
  const t = setup({ grants: [{ owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' }] });
  const r = await t.store.load();
  assert.equal(r.ok, true);
  assert.deepEqual(r.accounts.map((a) => a.login), ['admin', 'alice', 'bob']);
  assert.equal(r.grants.length, 1);
  assert.deepEqual(r.collectionsByOwner, {});
  assert.deepEqual(t.log, ['accounts', 'grants']);
});

test('load({collections:true}) lists every enabled principal at Depth 1, two at a time, and tolerates one failing principal', async () => {
  const t = setup({ accounts: [acct('a1'), acct('a2'), acct('a3'), acct('a4'), acct('off', { disabled: true })], collections: { a1: [book('a1', 'x')], a3: [book('a3', 'y')] } });
  let running = 0;
  let peak = 0;
  const orig = t.client.listCollections;
  t.client.listCollections = async (home) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setImmediate(r));
    try {
      if (home === '/a2/') throw new DavError('server', { status: 500 });
      return await orig(home);
    } finally {
      running--;
    }
  };
  const r = await t.store.load({ collections: true });
  assert.equal(r.ok, true);
  assert.ok(peak <= 2 && peak >= 1, 'peak ' + peak);
  assert.deepEqual(Object.keys(r.collectionsByOwner).sort(), ['a1', 'a3', 'a4']);
  assert.equal(r.collectionsByOwner.a1[0].owner, 'a1');
  assert.ok(r.collectionErrors.a2);
  assert.ok(!('off' in r.collectionsByOwner));
});

test('loadCollections(login) is lazy and uses the admin principal\'s parent for the home href', async () => {
  const t = setup({ collections: { alice: [book('alice', 'cal')] } });
  const r = await t.store.loadCollections('alice');
  assert.equal(r.ok, true);
  assert.deepEqual(t.principals, ['/alice/']);
  assert.equal(t.store.state.collectionsByOwner.alice.length, 1);
});

test('load() failure is a result, not a throw', async () => {
  const t = setup();
  t.failures.push({ name: 'accounts', times: 1, error: err(403, 'forbidden') });
  const r = await t.store.load();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'forbidden');
  assert.equal(r.message, 'err.api.forbidden');
});

test('previewGrant is a dry run: nothing logged, state unchanged; applyGrant is the real call, logged and applied locally', async () => {
  const t = setup();
  await t.store.load();
  const g = { owner: 'alice', collection: 'book', grantee: 'bob', level: 'readwrite' };
  const p = await t.store.previewGrant(g);
  assert.equal(p.status, 'preview');
  assert.equal(p.dryRun, true);
  assert.equal(t.activity.size, 0);
  assert.equal(t.store.state.grants.length, 0);
  const a = await t.store.applyGrant(g);
  assert.equal(a.ok, true);
  assert.equal(a.status, 'ok');
  assert.deepEqual(t.log.slice(-2), ['grant.dry alice/book>bob=readwrite', 'grant alice/book>bob=readwrite']);
  assert.equal(t.store.state.grants.length, 1);
  assert.equal(t.activity.entries()[0].op, 'grant');
  await t.store.applyGrant({ ...g, level: 'none' });
  assert.equal(t.store.state.grants.length, 0);
});

test('mutations run one at a time, in call order', async () => {
  const t = setup();
  const order = [];
  const orig = t.api.putGrant;
  t.api.putGrant = async (g) => {
    order.push('start ' + g.grantee);
    await new Promise((r) => setTimeout(r, g.grantee === 'bob' ? 10 : 0));
    const r = await orig(g);
    order.push('end ' + g.grantee);
    return r;
  };
  const base = { owner: 'alice', collection: 'book', level: 'read' };
  await Promise.all([t.store.applyGrant({ ...base, grantee: 'bob' }), t.store.applyGrant({ ...base, grantee: 'carol' })]);
  assert.deepEqual(order, ['start bob', 'end bob', 'start carol', 'end carol']);
});

test('429 honours Retry-After (at most twice), then reports ratelimited; a wait above 60 s is not taken', async () => {
  const t = setup();
  t.failures.push({ name: 'grant', times: 2, error: err(429, 'rate_limited', { retryAfter: 7 }) });
  const g = { owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' };
  const ok = await t.store.applyGrant(g);
  assert.equal(ok.ok, true);
  assert.deepEqual(t.sleeps, [7000, 7000]);
  t.failures.push({ name: 'grant', times: 5, error: err(429, 'rate_limited', { retryAfter: 7 }) });
  const bad = await t.store.applyGrant(g);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 'rate_limited');
  t.failures.length = 0;
  t.sleeps.length = 0;
  t.failures.push({ name: 'grant', times: 1, error: err(429, 'rate_limited', { retryAfter: 600 }) });
  assert.equal((await t.store.applyGrant(g)).ok, false);
  assert.deepEqual(t.sleeps, []);
});

test('a wait that ends with the session stops the loop: status aborted, no alert', async () => {
  const t = setup();
  const s = createAdminStore({ api: t.api, client: t.client, reporter: createReporter({ feedback: t.feedback }), sleep: async () => { throw new Error('session ended'); } });
  t.failures.push({ name: 'grant', times: 3, error: err(429, 'rate_limited', { retryAfter: 1 }) });
  const r = await s.applyGrant({ owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' });
  assert.equal(r.status, 'aborted');
  assert.equal(t.feedback.alert, null);
  assert.equal(t.log.filter((l) => l.startsWith('grant ')).length, 1);
});

test('every documented API error code gives {ok:false, status: code, message: err.api.<code>} and an error Activity line', async () => {
  const cases = [
    [400, 'bad_request'], [400, 'missing_header'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [404, 'collection_not_found'],
    [409, 'exists'], [409, 'tombstoned'], [409, 'lockout_last_admin'], [409, 'lockout_self'], [422, 'validation'], [422, 'unsupported_collection_name'],
    [500, 'internal'], [503, 'busy'], [503, 'model_corrupt'], [429, 'rate_limited'],
  ];
  for (const [status, code] of cases) {
    const t = setup();
    t.failures.push({ name: 'createAccount', times: 3, error: err(status, code, { field: code === 'validation' ? 'login' : null, retryAfter: status === 429 ? 1 : null }) });
    const r = await t.store.createAccount({ login: 'new1', password: PW });
    assert.equal(r.ok, false, code);
    assert.equal(r.status, code);
    assert.equal(r.code, code);
    assert.equal(r.message, `err.api.${code}`);
    if (code === 'validation') assert.equal(r.field, 'login');
    assert.equal(t.activity.entries()[0].result, 'error');
    assert.equal(t.store.state.accounts.length, 0);
  }
});

test('network failure and an unknown code still give a translatable key', async () => {
  const t = setup();
  t.failures.push({ name: 'patch', times: 1, error: new ApiError('network', { message: 'network error' }) });
  const r = await t.store.applyAccountChange({ login: 'bob', patch: { disabled: true } });
  assert.equal(r.status, 'network');
  assert.equal(r.message, 'err.api.network');
  t.failures.push({ name: 'patch', times: 1, error: err(500, 'weird_new_code') });
  assert.match((await t.store.applyAccountChange({ login: 'bob', patch: { disabled: true } })).message, /^err\.api\.unknown/);
});

test('the dictionaries carry err.api.<code> for every code the store can name, in both languages', () => {
  for (const code of [...API_ERROR_CODES, 'network', 'unknown', 'data_left', 'data_changed']) {
    assert.ok(en[`err.api.${code}`], 'en ' + code);
    assert.ok(fr[`err.api.${code}`], 'fr ' + code);
  }
  assert.equal(en['err.api.activation_pending'], 'Saved; the server is still applying it.');
});

test('202 activation_pending is a success with status pending and the "still applying" status text', async () => {
  const t = setup();
  t.api.patchAccount = async (l, b) => mut({ active: false, warning: 'activation_pending', pending: true, account: acct(l, b) });
  const r = await t.store.applyAccountChange({ login: 'bob', patch: { disabled: true } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.equal(r.message, 'err.api.activation_pending');
  assert.equal(t.feedback.status.text, 'err.api.activation_pending');
  assert.equal(t.activity.entries()[0].result, 'ok');
});

test('createAccount: generated password only in the result, never in state, Activity, status or alerts', async () => {
  const t = setup();
  await t.store.load();
  const r = await t.store.createAccount({ login: 'new1', generate: true, type: 'bot' });
  assert.equal(r.ok, true);
  assert.equal(r.password, PW);
  assert.equal(t.store.state.accounts.some((a) => a.login === 'new1'), true);
  const dump = JSON.stringify({ state: t.store.state, act: t.activity.entries(), st: t.feedback.status, al: t.feedback.alert });
  assert.ok(!dump.includes(PW));
  const prev = await t.store.previewCreateAccount({ login: 'new2', generate: true });
  assert.equal(prev.dryRun, true);
  assert.equal(t.store.state.accounts.some((a) => a.login === 'new2'), false);
});

test('no password string reaches Activity, console, a URL or the reporter, in any flow', async () => {
  const seen = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[k] = console[k];
    console[k] = (...a) => seen.push(a.map(String).join(' '));
  }
  try {
    const t = setup();
    await t.store.load();
    await t.store.createAccount({ login: 'new1', password: PW });
    await t.store.resetPassword({ login: 'bob', password: PW });
    await t.store.resetPassword({ login: 'bob', generate: true });
    t.failures.push({ name: 'password', times: 1, error: err(422, 'validation', { field: 'password' }) });
    await t.store.resetPassword({ login: 'bob', password: PW });
    await t.store.previewCreateAccount({ login: 'new3', password: PW });
    await t.store.deleteAccount({ login: 'new1' });
    const dump = JSON.stringify({ act: t.activity.entries(), st: t.feedback.status, al: t.feedback.alert, log: t.log, state: t.store.state });
    assert.ok(!dump.includes(PW), 'dump');
    assert.ok(!seen.join('\n').includes(PW), 'console');
    assert.ok(t.activity.entries().some((e) => e.op === 'password'));
  } finally {
    Object.assign(console, saved);
  }
});

test('source of the store and the client: no console call, no password in a path', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['../../../src/js/store/admin.js', '../../../src/js/api.js']) {
    const src = readFileSync(path.join(here, f), 'utf8');
    assert.ok(!/console\./.test(src), f);
    assert.ok(!/innerHTML/.test(src), f);
  }
});

test('account change and password reset refetch the access list only when they concern the signed-in account', async () => {
  const t = setup();
  await t.store.load();
  await t.store.applyAccountChange({ login: 'bob', patch: { displayName: 'B' } });
  assert.deepEqual(t.refetches, []);
  await t.store.applyAccountChange({ login: 'admin', patch: { displayName: 'Adm' } });
  assert.deepEqual(t.refetches, ['admin']);
  await t.store.resetPassword({ login: 'admin', generate: true });
  assert.equal(t.refetches.length, 2);
  await t.store.applyGrant({ owner: 'alice', collection: 'book', grantee: 'admin', level: 'read' });
  assert.equal(t.refetches.length, 3);
  await t.store.applyGrant({ owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' });
  assert.equal(t.refetches.length, 3);
});

test('previewAccountChange reports confirmRequired and sends the dry run only', async () => {
  const t = setup();
  t.api.patchAccount = async (l, b, o) => mut({ dryRun: !!o?.dryRun, confirmRequired: true, summary: 'x' });
  const r = await t.store.previewAccountChange({ login: 'alice', patch: { ownSpace: false } });
  assert.equal(r.ok, true);
  assert.equal(r.confirmRequired, true);
  assert.equal(t.activity.size, 0);
});

test('lockout errors from the service come back as failures and change nothing', async () => {
  for (const code of ['lockout_last_admin', 'lockout_self']) {
    const t = setup();
    await t.store.load();
    t.failures.push({ name: 'patch', times: 1, error: err(409, code) });
    const r = await t.store.applyAccountChange({ login: 'admin', patch: { admin: false } });
    assert.equal(r.status, code);
    assert.equal(t.store.state.accounts.find((a) => a.login === 'admin').admin, true);
  }
});

test('deleteAccount keep data: one DELETE with confirm, no DAV call, state and Activity updated', async () => {
  const t = setup({ grants: [{ owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' }, { owner: 'bob', collection: 'c', grantee: 'alice', level: 'read' }] });
  await t.store.load();
  const r = await t.store.deleteAccount({ login: 'bob' });
  assert.equal(r.ok, true);
  assert.deepEqual(t.log.slice(2), ['delete bob bob']);
  assert.equal(t.deleted.length, 0);
  assert.equal(t.store.state.accounts.some((a) => a.login === 'bob'), false);
  assert.equal(t.store.state.grants.length, 0);
  assert.equal(t.activity.entries()[0].op, 'account');
});

test('deleteAccount refuses your own account before any request', async () => {
  const t = setup();
  const r = await t.store.deleteAccount({ login: 'admin', deleteData: true });
  assert.equal(r.status, 'lockout_self');
  assert.deepEqual(t.log, []);
});

test('deleteAccount with data: dry run first, collections deleted one by one with the listing ETag, then re-listed, then DELETE', async () => {
  const t = setup({ collections: { bob: [book('bob', 'one'), book('bob', 'two')] } });
  await t.store.load();
  const progress = [];
  const r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected: t.expected('bob'), onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(t.log.slice(2), ['delete.dry bob bob', 'list /bob/', 'deleteCollection /bob/one/', 'deleteCollection /bob/two/', 'list /bob/', 'delete bob bob']);
  assert.deepEqual(t.deleted.map((d) => [d.href, d.expectedEtag]), [['/bob/one/', '"e-one"'], ['/bob/two/', '"e-two"']]);
  assert.deepEqual(r.deletedCollections, ['/bob/one/', '/bob/two/']);
  assert.deepEqual(progress, ['list:0/0', 'delete:0/2', 'delete:1/2', 'account:2/2']);
});

test('deleteAccount with data stops at the FIRST failure and never calls the account DELETE', async () => {
  const t = setup({ collections: { bob: [book('bob', 'one'), book('bob', 'two'), book('bob', 'three')] } });
  await t.store.load();
  const orig = t.writes.deleteCollection;
  t.writes.deleteCollection = async (a) => (a.href === '/bob/two/' ? (t.deleted.push(a), { ok: false, status: 'changed', message: 'changed' }) : orig(a));
  const r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected: t.expected('bob') });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'data-left');
  assert.deepEqual(r.remaining, ['/bob/two/', '/bob/three/']);
  assert.deepEqual(r.deletedCollections, ['/bob/one/']);
  assert.equal(r.failed.href, '/bob/two/');
  assert.deepEqual(t.deleted.map((d) => d.href), ['/bob/one/', '/bob/two/']);
  assert.ok(!t.log.includes('delete bob bob'));
  assert.equal(t.store.state.accounts.some((a) => a.login === 'bob'), true);
  assert.match(t.feedback.alert.text, /err\.api\.data_left/);
  assert.match(t.feedback.alert.text, /two, three/);
});

test('deleteAccount with data: a thrown write failure result, a listing failure and a leftover all keep the account', async () => {
  // listing fails
  let t = setup({ collections: { bob: [book('bob', 'one')] } });
  t.failures.push({ name: 'list', times: 1, error: new DavError('server', { status: 500 }) });
  let r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected: t.expected('bob') });
  assert.equal(r.ok, false);
  assert.ok(!t.log.includes('delete bob bob'));
  assert.equal(t.deleted.length, 0);
  // the collection survives the delete (verification listing still shows it)
  t = setup({ collections: { bob: [book('bob', 'one')] } });
  t.writes.deleteCollection = async () => ({ ok: true, status: 'deleted' });
  r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected: t.expected('bob') });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'data-left');
  assert.ok(!t.log.includes('delete bob bob'));
});

test('deleteAccount with data: an ETag that changed since the dialog listing deletes nothing (no collection, no account)', async () => {
  const t = setup({ collections: { bob: [book('bob', 'one'), book('bob', 'two')] } });
  await t.store.load();
  const expected = t.expected('bob'); // what the dialog showed
  t.setCollections({ bob: [{ ...book('bob', 'one'), etag: '"e-one-changed"' }, book('bob', 'two')] }); // edited elsewhere before the confirmation
  const r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'changed');
  assert.equal(t.deleted.length, 0);
  assert.ok(!t.log.includes('delete bob bob'));
  assert.equal(t.store.state.accounts.some((a) => a.login === 'bob'), true);
  assert.equal(t.feedback.alert.scope, null); // persistent
  assert.match(t.feedback.alert.text, /err\.api\.data_changed/);
  assert.match(t.feedback.alert.text, /bob/);
});

test('deleteAccount with data: a collection added or removed since the dialog listing also counts as changed', async () => {
  for (const now of [[book('bob', 'one'), book('bob', 'two'), book('bob', 'new')], [book('bob', 'one')]]) {
    const t = setup({ collections: { bob: [book('bob', 'one'), book('bob', 'two')] } });
    const expected = t.expected('bob');
    t.setCollections({ bob: now });
    const r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected });
    assert.equal(r.status, 'changed');
    assert.equal(t.deleted.length, 0);
  }
});

test('deleteAccount with data needs the dialog listing (a programming error otherwise)', async () => {
  const t = setup({ collections: { bob: [book('bob', 'one')] } });
  await assert.rejects(t.store.deleteAccount({ login: 'bob', deleteData: true }), TypeError);
  assert.equal(t.deleted.length, 0);
});

test('deleteAccount stops with status aborted when the session ends between two requests', async () => {
  for (const stopAfter of ['list', 'deleteCollection']) {
    let disposed = false;
    const t = setup({ collections: { bob: [book('bob', 'one'), book('bob', 'two')] } });
    const s2 = createAdminStore({ api: t.api, client: { ...t.client, listCollections: async (h) => { const r = await t.client.listCollections(h); if (stopAfter === 'list') disposed = true; return r; } }, writes: { deleteCollection: async (a) => { const r = await t.writes.deleteCollection(a); if (stopAfter === 'deleteCollection') disposed = true; return r; } }, reporter: createReporter({ activity: createActivityLog(), feedback: createFeedback(), t: (k) => k }), isDisposed: () => disposed });
    const r = await s2.deleteAccount({ login: 'bob', deleteData: true, expected: t.expected('bob') });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'aborted');
    assert.ok(!t.log.includes('delete bob bob'));
    assert.equal(t.deleted.length, stopAfter === 'list' ? 0 : 1, stopAfter);
  }
});

test('deleteAccount with data: the preflight dry run (lockout, unknown login) stops before any collection is deleted', async () => {
  const t = setup({ collections: { bob: [book('bob', 'one')] } });
  t.failures.push({ name: 'delete.dry', times: 1, error: err(409, 'lockout_last_admin') });
  const r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected: t.expected('bob') });
  assert.equal(r.status, 'lockout_last_admin');
  assert.equal(t.deleted.length, 0);
  assert.ok(!t.log.some((l) => l.startsWith('list')));
});

test('deleteAccount: a failing account DELETE after the data went reports it and keeps the state', async () => {
  const t = setup({ collections: { bob: [book('bob', 'one')] } });
  await t.store.load();
  t.failures.push({ name: 'delete', times: 1, error: err(503, 'busy') });
  const r = await t.store.deleteAccount({ login: 'bob', deleteData: true, expected: t.expected('bob') });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'busy');
  assert.deepEqual(r.deletedCollections, ['/bob/one/']);
  assert.equal(t.store.state.accounts.some((a) => a.login === 'bob'), true);
});

test('effective() and directory() pass through', async () => {
  const t = setup();
  assert.equal((await t.store.effective('bob')).effective[0].letters, 'RWrwDO');
  assert.equal((await t.store.directory()).directory.length, 3);
});

test('subscribe receives change events; a programming error (TypeError) is thrown, not swallowed', async () => {
  const t = setup();
  const seen = [];
  const off = t.store.subscribe((e) => seen.push(e.type));
  await t.store.load();
  await t.store.applyGrant({ owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' });
  off();
  assert.deepEqual(seen, ['load', 'change']);
  t.api.putGrant = async () => { throw new TypeError('bad'); };
  await assert.rejects(t.store.applyGrant({ owner: 'a', collection: 'b', grantee: 'c', level: 'read' }), TypeError);
  // and the queue is not stuck afterwards
  t.api.putGrant = async (g) => ({ grant: g, generation: 1, active: true });
  assert.equal((await t.store.applyGrant({ owner: 'a', collection: 'b', grantee: 'c', level: 'read' })).ok, true);
});
