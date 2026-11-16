// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, LoginError, attemptLogin, apiPath, kindForStatus, normalizeMe, normalizeAccess } from '../../../src/js/api.js';
import { createTransport, DavError } from '../../../src/js/dav/http.js';
import { createClient } from '../../../src/js/dav/client.js';
import { makeFetch, json } from './_helpers.mjs';
import { recorded } from '../dav/_helpers.mjs';

const AUTH = 'Basic YWxpY2U6c2VjcmV0';
const ME = { login: 'alice', displayName: 'Alice', type: 'person', admin: false, ownSpace: true, generation: 4, rightsActive: true, ok: true };
const apiWith = (handler, extra = {}) => createApi({ apiBase: '/ui/api/', getAuth: () => AUTH, fetchImpl: makeFetch(handler), ...extra });

test('GET me: path, headers, transport options, normalised result', async () => {
  const f = makeFetch(() => json(200, ME));
  const api = createApi({ apiBase: '/ui/api/', getAuth: () => AUTH, fetchImpl: f });
  assert.deepEqual(await api.me(), ME);
  const c = f.calls[0];
  assert.equal(c.path, '/ui/api/me');
  assert.equal(c.method, 'GET');
  assert.equal(c.headers.authorization, AUTH);
  assert.equal(c.headers['x-radui'], undefined);
  assert.equal(c.init.credentials, 'omit');
  assert.equal(c.init.cache, 'no-store');
  assert.equal(c.init.redirect, 'error');
  assert.ok(!c.url.startsWith('http'));
});

test('no Authorization header when there is no credential', async () => {
  const f = makeFetch(() => json(200, ME));
  await createApi({ apiBase: '/api/', fetchImpl: f }).me();
  assert.equal('authorization' in f.calls[0].headers, false);
});

test('mutating calls carry X-RadUI and a JSON body; GETs do not', async () => {
  const f = makeFetch(() => json(200, { ok: true }));
  const api = createApi({ apiBase: '/api/', getAuth: () => AUTH, fetchImpl: f });
  await api.post('accounts', { login: 'bob' });
  await api.put('grants', { a: 1 }, { query: { dryRun: 1 } });
  await api.patch('accounts/bob', { disabled: true });
  await api.del('accounts/bob', { confirm: 'bob' });
  await api.get('accounts');
  const [post, put, patch, del, get] = f.calls;
  for (const c of [post, put, patch, del]) {
    assert.equal(c.headers['x-radui'], '1', c.method);
    assert.equal(c.headers['content-type'], 'application/json');
  }
  assert.equal(post.body, '{"login":"bob"}');
  assert.equal(put.search, '?dryRun=1');
  assert.equal(get.headers['x-radui'], undefined);
  assert.equal(get.body, undefined);
});

test('me/access is normalised; malformed grants are dropped', async () => {
  const api = apiWith((c) =>
    c.path.endsWith('/me/access')
      ? json(200, { login: 'bob', admin: false, ownSpace: false, grants: [{ href: '/alice/work/', owner: 'alice', collection: 'work', level: 'readwrite', grantedBy: 'alice', created: 'x' }, { owner: 'x' }, null, 'junk'] })
      : json(200, { ok: true }),
  );
  const access = await api.meAccess();
  assert.equal(access.ownSpace, false);
  assert.equal(access.grants.length, 1);
  assert.equal(access.grants[0].level, 'readwrite');
  assert.equal(api.health, undefined, 'the browser has no health call (the endpoint is loopback-only)');
});

test('error mapping by status', async () => {
  const cases = [
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'notfound'],
    [409, 'conflict'],
    [400, 'badrequest'],
    [413, 'toolarge'],
    [415, 'badrequest'],
    [422, 'validation'],
    [429, 'ratelimited'],
    [500, 'server'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
    [302, 'invalid'],
  ];
  for (const [status, kind] of cases) {
    assert.equal(kindForStatus(status), kind);
    const api = apiWith(() => ({ status, body: '<html>proxy error</html>' }));
    await assert.rejects(api.me(), (e) => e instanceof ApiError && e.kind === kind && e.status === status && e.path === '/ui/api/me');
  }
});

test('backend error bodies give code, field and message; Retry-After is read', async () => {
  const api = apiWith(() => json(422, { error: { code: 'validation', message: 'bad login', field: 'login' } }));
  await assert.rejects(api.post('accounts', {}), (e) => e.kind === 'validation' && e.code === 'validation' && e.field === 'login' && e.message === 'bad login');
  const limited = apiWith(() => json(429, { error: { code: 'rate_limited' } }, { 'retry-after': '12' }));
  await assert.rejects(limited.me(), (e) => e.kind === 'ratelimited' && e.retryAfter === 12);
});

test('401 calls onUnauthorized once; a throwing hook does not mask the error', async () => {
  let n = 0;
  const api = apiWith(() => ({ status: 401 }), {
    onUnauthorized: () => {
      n += 1;
      throw new Error('hook');
    },
  });
  await assert.rejects(api.me(), (e) => e.kind === 'auth');
  assert.equal(n, 1);
});

test('network failure, timeout, redirect and bad bodies', async () => {
  const net = createApi({
    apiBase: '/api/',
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(net.me(), (e) => e.kind === 'network' && !e.timeout);

  const slow = createApi({ apiBase: '/api/', timeoutMs: 20, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
  await assert.rejects(slow.me(), (e) => e.kind === 'network' && e.timeout === true);

  await assert.rejects(apiWith(() => ({ status: 200, body: '<html>' })).me(), (e) => e.kind === 'invalid');
  await assert.rejects(apiWith(() => json(200, { nope: 1 })).me(), (e) => e.kind === 'invalid');
  await assert.rejects(apiWith(() => json(200, [])).me(), (e) => e.kind === 'invalid');
  assert.equal(await apiWith(() => ({ status: 204 })).get('x'), null);
});

test('an aborted signal cancels the request', async () => {
  const ctrl = new AbortController();
  const api = createApi({ apiBase: '/api/', fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
  const p = api.me({ signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, (e) => e.kind === 'network');
});

test('apiPath keeps requests inside the API prefix (same-origin paths only)', () => {
  assert.equal(apiPath('/ui/api/', 'me/access'), '/ui/api/me/access');
  assert.equal(apiPath('/ui/api', 'accounts', { a: 1, b: undefined }), '/ui/api/accounts?a=1');
  for (const bad of ['', '/me', '../me', 'a/../b', 'a//b', 'https://x.example/', 'a?b', 'a#b', '%2e%2e/b', 'a%2Fb', '%zz', 'a b', '..', '.']) assert.throws(() => apiPath('/api/', bad), TypeError, bad);
  for (const bad of ['', 'api/', '//host/api/', 'https://h/api/']) assert.throws(() => apiPath(bad, 'me'), TypeError, bad);
  assert.throws(() => createApi({ apiBase: 'relative/', fetchImpl: () => {} }), TypeError);
});

test('normalisers', () => {
  assert.equal(normalizeMe({ login: 'x' }).displayName, 'x');
  assert.equal(normalizeMe({ login: 'x', type: 'alien', admin: 'yes' }).admin, false);
  assert.throws(() => normalizeMe({}), ApiError);
  assert.throws(() => normalizeAccess(null), ApiError);
  assert.equal(normalizeAccess({ principals: ['a', 3] }).principals.length, 1);
  // health view carried by `me`: booleans only, null when absent (older server) or malformed
  const m = normalizeMe({ login: 'x', rightsActive: true, ok: false });
  assert.equal(m.rightsActive, true);
  assert.equal(m.ok, false);
  const old = normalizeMe({ login: 'x' });
  assert.equal(old.rightsActive, null);
  assert.equal(old.ok, null);
  assert.equal(normalizeMe({ login: 'x', rightsActive: 'yes', ok: 1 }).rightsActive, null);
  assert.equal(normalizeMe({ login: 'x', rightsActive: 'yes', ok: 1 }).ok, null);
});

// ------------------------------------------------------------ login flow

const davClientFor = (handler) => createClient(createTransport({ basePath: '/', getAuth: () => AUTH, fetchImpl: makeFetch(handler) }));

test('login: the account service answers -> via backend, full account info', async () => {
  const api = apiWith(() => json(200, ME));
  const dav = { principal: async () => assert.fail('must not be called') };
  const r = await attemptLogin({ api, dav });
  assert.equal(r.via, 'backend');
  assert.equal(r.limited, false);
  assert.equal(r.me.login, 'alice');
});

test('login: 401 from the account service means bad credentials and never tries DAV', async () => {
  const api = apiWith(() => ({ status: 401 }));
  let davCalled = false;
  await assert.rejects(
    attemptLogin({ api, dav: { principal: async () => (davCalled = true) } }),
    (e) => e instanceof LoginError && e.reason === 'bad-credentials',
  );
  assert.equal(davCalled, false);
});

test('login: 429 is reported as rate-limited, no fallback', async () => {
  const api = apiWith(() => json(429, { error: { code: 'rate_limited' } }, { 'retry-after': '30' }));
  await assert.rejects(
    attemptLogin({ api, dav: { principal: async () => assert.fail('no fallback') } }),
    (e) => e.reason === 'rate-limited' && e.retryAfter === 30,
  );
});

test('login: network error, 404, 502, 503, 500 and 403 fall back to a DAV principal lookup', async () => {
  const outcomes = [
    () => {
      throw new TypeError('down');
    },
    () => ({ status: 404, body: 'not found' }),
    () => ({ status: 502 }),
    () => ({ status: 503 }),
    () => ({ status: 500 }),
    () => ({ status: 403 }),
  ];
  for (const out of outcomes) {
    const api = apiWith(out);
    const dav = davClientFor(() => recorded('propfind-principal'));
    const r = await attemptLogin({ api, dav });
    assert.equal(r.via, 'dav');
    assert.equal(r.limited, true);
    assert.equal(r.me, null);
    assert.ok(r.principal.startsWith('/'));
    assert.ok(r.fallbackReason);
  }
});

test('login: fallback with wrong credentials -> bad-credentials; DAV down too -> unavailable', async () => {
  const api = apiWith(() => ({ status: 502 }));
  await assert.rejects(attemptLogin({ api, dav: davClientFor(() => recorded('unauthenticated')) }), (e) => e.reason === 'bad-credentials' && e.cause instanceof DavError);
  await assert.rejects(attemptLogin({ api, dav: davClientFor(() => ({ status: 503, body: '' })) }), (e) => e.reason === 'unavailable');
  await assert.rejects(
    attemptLogin({
      api,
      dav: davClientFor(() => {
        throw new TypeError('down');
      }),
    }),
    (e) => e.reason === 'unavailable',
  );
});
