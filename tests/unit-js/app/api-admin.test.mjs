// SPDX-License-Identifier: AGPL-3.0-or-later
// api.js admin endpoints: paths, verbs, headers, bodies, dry runs, normalisation and error mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, normalizeMutation, normalizeAccounts, normalizeAccountRecord, normalizeDirectory, normalizeEffective } from '../../../src/js/api.js';
import { makeFetch, json } from './_helpers.mjs';

const AUTH = 'Basic YWRtaW46c2VjcmV0';
const ACCOUNT = { login: 'bob', displayName: 'Bob', type: 'person', admin: false, disabled: false, ownSpace: true, created: '2026-01-01T00:00:00Z', passwordChanged: null };
const apiWith = (handler) => {
  const f = makeFetch(handler);
  return { api: createApi({ apiBase: '/ui/api/', getAuth: () => AUTH, fetchImpl: f }), f };
};

test('GET directory, accounts, account(login), effective(login): paths, no X-RadUI, normalised', async () => {
  const { api, f } = apiWith(({ path }) => {
    if (path.endsWith('/directory')) return json(200, [{ login: 'bob', displayName: 'Bob', type: 'person' }, { nope: 1 }, null]);
    if (path.endsWith('/accounts')) return json(200, [ACCOUNT, { login: 5 }, { login: 'bot-1', type: 'bot', admin: 'yes', hash: 'secret-hash' }]);
    if (path.endsWith('/accounts/bob')) return json(200, ACCOUNT);
    if (path.endsWith('/effective/bob')) return json(200, [{ path: 'bob/*', level: 'own', letters: 'RWrwDO' }, { level: 'x' }]);
    return json(404, { error: { code: 'not_found' } });
  });
  assert.deepEqual(await api.directory(), [{ login: 'bob', displayName: 'Bob', type: 'person' }]);
  const accounts = await api.accounts();
  assert.deepEqual(accounts.map((a) => a.login), ['bob', 'bot-1']);
  assert.equal(accounts[1].admin, false, 'only a literal true counts');
  assert.equal('hash' in accounts[1], false, 'unknown fields are not carried over');
  assert.deepEqual(await api.account('bob'), ACCOUNT);
  assert.deepEqual(await api.effective('bob'), [{ path: 'bob/*', level: 'own', letters: 'RWrwDO' }]);
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ['GET /ui/api/directory', 'GET /ui/api/accounts', 'GET /ui/api/accounts/bob', 'GET /ui/api/effective/bob']);
  for (const c of f.calls) {
    assert.equal(c.headers['x-radui'], undefined);
    assert.equal(c.headers.authorization, AUTH);
    assert.equal(c.body, undefined);
  }
});

test('unexpected shapes are ApiError invalid', async () => {
  assert.throws(() => normalizeAccounts({}), (e) => e instanceof ApiError && e.kind === 'invalid');
  assert.throws(() => normalizeDirectory(null), ApiError);
  assert.throws(() => normalizeEffective('x'), ApiError);
  assert.throws(() => normalizeAccountRecord({}), ApiError);
  assert.throws(() => normalizeMutation(null), ApiError);
  const { api } = apiWith(() => ({ status: 200 }));
  await assert.rejects(api.createAccount({ login: 'bob' }), (e) => e.kind === 'invalid');
});

test('mutating endpoints: verb, path, X-RadUI, JSON body limited to the documented fields, ?dryRun=1', async () => {
  const { api, f } = apiWith(({ method }) => (method === 'DELETE' ? json(200, { deleted: 'bob', generation: 9, active: true }) : json(200, { account: ACCOUNT, generation: 8, active: true })));
  await api.createAccount({ login: 'bob', displayName: 'Bob', type: 'person', generate: true, hash: 'x', extra: 1 });
  await api.createAccount({ login: 'bob', password: 'pw' }, { dryRun: true });
  await api.patchAccount('bob', { disabled: true, confirm: 'bob', evil: 1 });
  await api.patchAccount('bob', { admin: true }, { dryRun: true });
  await api.resetPassword('bob', { generate: true });
  await api.resetPassword('bob', { password: 'pw', generate: false }, { dryRun: true });
  await api.deleteAccount('bob', 'bob');
  await api.deleteAccount('bob', 'bob', { dryRun: true });
  await api.putGrant({ owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' }, { dryRun: true });
  const got = f.calls.map((c) => [c.method, c.path + c.search, c.body === undefined ? null : JSON.parse(c.body)]);
  assert.deepEqual(got, [
    ['POST', '/ui/api/accounts', { login: 'bob', displayName: 'Bob', type: 'person', generate: true }],
    ['POST', '/ui/api/accounts?dryRun=1', { login: 'bob', password: 'pw' }],
    ['PATCH', '/ui/api/accounts/bob', { disabled: true, confirm: 'bob' }],
    ['PATCH', '/ui/api/accounts/bob?dryRun=1', { admin: true }],
    ['POST', '/ui/api/accounts/bob/password', { generate: true }],
    ['POST', '/ui/api/accounts/bob/password?dryRun=1', { password: 'pw', generate: false }],
    ['DELETE', '/ui/api/accounts/bob', { confirm: 'bob' }],
    ['DELETE', '/ui/api/accounts/bob?dryRun=1', { confirm: 'bob' }],
    ['PUT', '/ui/api/grants?dryRun=1', { owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' }],
  ]);
  for (const c of f.calls) {
    assert.equal(c.headers['x-radui'], '1', c.path);
    assert.equal(c.headers['content-type'], 'application/json');
    assert.equal(c.headers.authorization, AUTH);
    assert.equal(c.init.credentials, 'omit');
  }
});

test('passwords travel only in bodies, never in a path or query', async () => {
  const { api, f } = apiWith(() => json(200, { account: ACCOUNT, generation: 1, active: true }));
  await api.createAccount({ login: 'bob', password: 'Sentinel-pw-123' });
  await api.resetPassword('bob', { password: 'Sentinel-pw-123' }, { dryRun: true });
  for (const c of f.calls) assert.ok(!c.url.includes('Sentinel'), c.url);
});

test('login and argument validation happens before any request', async () => {
  const { api, f } = apiWith(() => json(200, {}));
  await assert.rejects(api.account('../me'), TypeError);
  await assert.rejects(api.account('Bob'), TypeError);
  await assert.rejects(api.account('a/b'), TypeError);
  await assert.rejects(api.effective(''), TypeError);
  await assert.rejects(api.createAccount({ displayName: 'x' }), TypeError);
  await assert.rejects(api.createAccount(null), TypeError);
  await assert.rejects(api.deleteAccount('bob', ''), TypeError);
  await assert.rejects(api.patchAccount('x y', {}), TypeError);
  assert.equal(f.calls.length, 0);
});

test('normalizeMutation: dry-run report, generated password, noop, 202 activation_pending', () => {
  const dry = normalizeMutation({ dryRun: true, noop: false, summary: 'Create account agent-2 (bot)', generation: 7, rights: { added: [{ user: '^agent-2$', collection: '^agent-2$', permissions: 'RW' }], removed: [] }, effective: [{ login: 'agent-2', path: 'agent-2/*', before: 'none', after: 'own' }], effectiveTruncated: false });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.summary, 'Create account agent-2 (bot)');
  assert.equal(dry.rights.added.length, 1);
  assert.deepEqual(dry.effective[0], { login: 'agent-2', path: 'agent-2/*', before: 'none', after: 'own' });
  assert.equal(dry.pending, false);
  const created = normalizeMutation({ account: ACCOUNT, password: 'generated-1', generation: 8, active: true });
  assert.equal(created.password, 'generated-1');
  assert.equal(created.account.login, 'bob');
  assert.equal(normalizeMutation({ account: ACCOUNT, generation: 8, active: true }).password, null);
  const pending = normalizeMutation({ generation: 9, active: false, warning: 'activation_pending', grant: { owner: 'a', collection: 'b', grantee: 'c', level: 'read' } });
  assert.equal(pending.pending, true);
  assert.equal(pending.warning, 'activation_pending');
  assert.equal(pending.grant.grantee, 'c');
  assert.equal(normalizeMutation({ noop: true, generation: 3, active: true }).noop, true);
  assert.equal(normalizeMutation({ dryRun: true, confirmRequired: true }).confirmRequired, true);
  assert.equal(normalizeMutation({ generation: 1, active: true }).confirmRequired, false);
  assert.equal(normalizeMutation({ deleted: 'bob', generation: 1, active: true }).deleted, 'bob');
});

test('a 202 answer is a success with pending set', async () => {
  const { api } = apiWith(() => json(202, { generation: 5, active: false, warning: 'activation_pending', account: ACCOUNT }));
  const m = await api.patchAccount('bob', { disabled: true });
  assert.equal(m.pending, true);
  assert.equal(m.active, false);
});

test('every documented error code maps to ApiError with kind, code, field and retryAfter', async () => {
  const table = [
    [400, 'bad_request', 'badrequest'], [400, 'missing_header', 'badrequest'], [401, 'unauthenticated', 'auth'], [403, 'forbidden', 'forbidden'],
    [404, 'not_found', 'notfound'], [404, 'collection_not_found', 'notfound'], [409, 'exists', 'conflict'], [409, 'tombstoned', 'conflict'],
    [409, 'lockout_last_admin', 'conflict'], [409, 'lockout_self', 'conflict'], [413, 'too_large', 'toolarge'], [415, 'unsupported_media_type', 'badrequest'],
    [422, 'validation', 'validation'], [422, 'unsupported_collection_name', 'validation'], [429, 'rate_limited', 'ratelimited'], [500, 'internal', 'server'],
    [502, 'radicale_unexpected', 'unavailable'], [503, 'busy', 'unavailable'], [503, 'model_corrupt', 'unavailable'],
  ];
  for (const [status, code, kind] of table) {
    const { api } = apiWith(() => json(status, { error: { code, message: 'm', field: code === 'validation' ? 'login' : undefined } }, status === 429 ? { 'retry-after': '12' } : {}));
    await assert.rejects(api.createAccount({ login: 'bob' }), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.kind, kind, code);
      assert.equal(e.code, code);
      assert.equal(e.status, status);
      assert.equal(e.field, code === 'validation' ? 'login' : null);
      assert.equal(e.retryAfter, status === 429 ? 12 : null);
      return true;
    });
  }
});

test('an error never carries the request body (no password in the error)', async () => {
  const { api } = apiWith(() => json(422, { error: { code: 'validation', message: 'bad', field: 'password' } }));
  await assert.rejects(api.createAccount({ login: 'bob', password: 'Sentinel-pw-123' }), (e) => {
    assert.ok(!JSON.stringify({ m: e.message, f: e.field, c: e.code, p: e.path }).includes('Sentinel'));
    return true;
  });
});

test('putGrant keeps working without options and revokeGrant sends level none', async () => {
  const { api, f } = apiWith(() => json(200, { grant: null, generation: 2, active: true }));
  await api.revokeGrant({ owner: 'alice', collection: 'book', grantee: 'bob' });
  assert.equal(f.calls[0].search, '');
  assert.equal(JSON.parse(f.calls[0].body).level, 'none');
});
