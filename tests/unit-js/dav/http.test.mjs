// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, DavError, ConflictError, kindForStatus, normalizeHref, encodeSegment, joinPath, toLf, toCrlf, KINDS } from '../../../src/js/dav/http.js';
import { NS } from '../../../src/js/dav/xml.js';
import { makeFetch, recorded, ORIGIN, AUTH } from './_helpers.mjs';

// Like real fetch: rejects at once on an already aborted signal, or when it aborts later.
const hang = (call) => new Promise((_, rej) => {
  const fail = () => rej(new DOMException('aborted', 'AbortError'));
  if (call.init.signal.aborted) fail();
  else call.init.signal.addEventListener('abort', fail);
});

const tp = (handler, extra = {}) => {
  const fetchImpl = makeFetch(handler);
  return { fetchImpl, t: createTransport({ origin: ORIGIN, getAuth: () => AUTH, fetchImpl, timeoutMs: 2000, ...extra }) };
};

test('every request: no-store, credentials omit, explicit Authorization, same-origin URL', async () => {
  const { t, fetchImpl } = tp(() => ({ status: 207, body: '<x/>' }));
  const r = await t.request('PROPFIND', '/alice/', { depth: 1, headers: { 'Content-Type': 'application/xml' }, body: '<a/>' });
  assert.equal(r.status, 207);
  const c = fetchImpl.calls[0];
  assert.equal(c.url, ORIGIN + '/alice/');
  assert.equal(c.init.cache, 'no-store');
  assert.equal(c.init.credentials, 'omit');
  assert.equal(c.init.redirect, 'error');
  assert.equal(c.headers.authorization, AUTH);
  assert.equal(c.headers.depth, '1');
  assert.equal(c.headers['content-type'], 'application/xml');
  assert.equal(c.body, '<a/>');
  assert.ok(c.init.signal);
});

test('getAuth may be async; no header when it returns null; none at all without getAuth', async () => {
  const f1 = makeFetch(() => ({ status: 200, body: 'x' }));
  await createTransport({ origin: ORIGIN, getAuth: async () => AUTH, fetchImpl: f1 }).request('GET', '/a');
  assert.equal(f1.calls[0].headers.authorization, AUTH);
  const f2 = makeFetch(() => ({ status: 200, body: 'x' }));
  await createTransport({ origin: ORIGIN, getAuth: () => null, fetchImpl: f2 }).request('GET', '/a');
  assert.equal(f2.calls[0].headers.authorization, undefined);
  const f3 = makeFetch(() => ({ status: 200, body: 'x' }));
  await createTransport({ origin: ORIGIN, fetchImpl: f3 }).request('GET', '/a');
  assert.equal(f3.calls[0].headers.authorization, undefined);
});

test('relative mode: empty origin sends the bare path', async () => {
  const f = makeFetch(() => ({ status: 200, body: 'x' }));
  await createTransport({ fetchImpl: f }).request('GET', '/alice/a.ics');
  assert.equal(f.calls[0].url, '/alice/a.ics');
});

test('constructor validation', () => {
  assert.throws(() => createTransport({ origin: 'not a url', fetchImpl: () => {} }), TypeError);
  assert.throws(() => createTransport({ origin: ORIGIN + '/path', fetchImpl: () => {} }), TypeError);
  assert.throws(() => createTransport({ origin: ORIGIN, basePath: 'x', fetchImpl: () => {} }), TypeError);
  assert.equal(createTransport({ origin: ORIGIN + '/', fetchImpl: () => {} }).origin, ORIGIN);
});

test('status to kind mapping', () => {
  const table = { 200: null, 201: null, 204: null, 207: null, 400: 'invalid', 401: 'auth', 403: 'forbidden', 404: 'notfound', 405: 'invalid', 409: 'conflict', 410: 'notfound', 412: 'precondition', 413: 'toolarge', 415: 'invalid', 422: 'invalid', 429: 'invalid', 500: 'server', 502: 'server', 503: 'server', 501: 'server' };
  for (const [s, k] of Object.entries(table)) assert.equal(kindForStatus(Number(s)), k, s);
  for (const k of ['auth', 'forbidden', 'notfound', 'precondition', 'conflict', 'toolarge', 'network', 'server', 'invalid']) assert.ok(KINDS.includes(k));
});

test('non-2xx responses throw typed DavError carrying status and body', async () => {
  for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 500, 503]) {
    const { t } = tp(() => ({ status, body: 'text ' + status }));
    await assert.rejects(t.request('GET', '/a'), (e) => {
      assert.ok(e instanceof DavError);
      assert.equal(e.kind, kindForStatus(status));
      assert.equal(e.status, status);
      assert.equal(e.body, 'text ' + status);
      assert.equal(e.method, 'GET');
      assert.equal(e.path, '/a');
      return true;
    });
  }
});

test('a recorded 403 keeps its parsed body (D5): DAV:valid-sync-token', async () => {
  const { t } = tp(() => recorded('sync-invalid-token'));
  await assert.rejects(t.request('REPORT', '/alice/work/'), (e) => {
    assert.equal(e.kind, 'forbidden');
    assert.equal(e.status, 403);
    assert.ok(e.xml && e.xml.name === 'error');
    assert.deepEqual(e.conditions, [{ ns: NS.DAV, name: 'valid-sync-token' }]);
    assert.ok(e.hasCondition(NS.DAV, 'valid-sync-token'));
    assert.ok(!e.hasCondition(NS.DAV, 'need-privileges'));
    return true;
  });
});

test('a recorded plain-text 403 has no conditions', async () => {
  const { t } = tp(() => recorded('sync-forbidden'));
  await assert.rejects(t.request('REPORT', '/alice/work/'), (e) => e.kind === 'forbidden' && e.xml === null && e.conditions.length === 0 && /forbidden/.test(e.body));
});

test('a hostile error body never breaks error construction', async () => {
  const { t } = tp(() => ({ status: 403, body: '<!DOCTYPE x><error xmlns="DAV:"><a/></error>' }));
  await assert.rejects(t.request('GET', '/a'), (e) => e.kind === 'forbidden' && e.xml === null);
});

test('network failure is typed and not retried', async () => {
  let n = 0;
  const { t } = tp(() => { n++; throw new TypeError('fetch failed'); });
  await assert.rejects(t.request('GET', '/a'), (e) => e.kind === 'network' && e.status === 0 && e.cause instanceof TypeError);
  assert.equal(n, 1);
});

test('timeout aborts via AbortController and reports kind network with timeout flag', async () => {
  const { t } = tp(hang, { timeoutMs: 30 });
  await assert.rejects(t.request('GET', '/a'), (e) => e.kind === 'network' && e.timeout === true);
});

test('per-request timeout override and caller abort signal', async () => {
  const { t } = tp(hang, { timeoutMs: 60000 });
  await assert.rejects(t.request('GET', '/a', { timeoutMs: 20 }), (e) => e.timeout === true);
  const ac = new AbortController();
  const p = t.request('GET', '/a', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.kind === 'network' && !e.timeout);
});

test('a 401 is reported once, never retried; onUnauthorized fires once', async () => {
  let hook = 0;
  const { t, fetchImpl } = tp(() => ({ status: 401, body: 'no' }), { onUnauthorized: () => { hook++; throw new Error('hook failure is swallowed'); } });
  await assert.rejects(t.request('GET', '/a'), (e) => e.kind === 'auth');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(hook, 1);
});

test('credentials never appear in errors, JSON or console output', async () => {
  const seen = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...a) => seen.push(a.join(' '));
  }
  try {
    for (const status of [401, 403, 500]) {
      const { t } = tp(() => ({ status, body: 'nope' }));
      await t.request('GET', '/a').catch((e) => {
        assert.ok(!JSON.stringify(e).includes(AUTH));
        assert.ok(!String(e.stack).includes(AUTH));
        assert.ok(!e.message.includes('YWxpY2U'));
      });
    }
    const { t } = tp(() => { throw new Error('socket'); });
    await t.request('GET', '/a').catch((e) => assert.ok(!JSON.stringify(e).includes(AUTH)));
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(seen, []);
});

test('foreign or malformed paths are rejected before any request is sent', async () => {
  const { t, fetchImpl } = tp(() => ({ status: 200, body: 'x' }));
  for (const p of ['//evil.example.net/x', 'http://evil.example.net/x', 'https://dav.example.org/x', '/a/../b', '/a/%2e%2e/b', 'relative', '', '/a\\b', '/a?x=1']) {
    await assert.rejects(t.request('GET', p), (e) => e.kind === 'invalid', p);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('oversized responses are refused (Content-Length and body)', async () => {
  const { t } = tp(() => ({ status: 200, body: 'x', headers: { 'content-length': '999999999' } }), { maxResponseBytes: 1000 });
  await assert.rejects(t.request('GET', '/a'), (e) => e.kind === 'toolarge');
  const { t: t2 } = tp(() => ({ status: 200, body: 'x'.repeat(2000) }), { maxResponseBytes: 1000 });
  await assert.rejects(t2.request('GET', '/a'), (e) => e.kind === 'toolarge');
});

test('allowStatus lets a caller inspect a specific non-2xx status', async () => {
  const { t } = tp(() => ({ status: 404, body: 'gone' }));
  const r = await t.request('GET', '/a', { allowStatus: [404] });
  assert.equal(r.status, 404);
});

test('ConflictError carries href and sentEtag', () => {
  const e = new ConflictError({ href: '/a/b.ics', sentEtag: '"x"', status: 412 });
  assert.equal(e.kind, 'precondition');
  assert.ok(e instanceof DavError);
  assert.equal(e.href, '/a/b.ics');
  assert.equal(e.sentEtag, '"x"');
  assert.equal(new ConflictError({ href: '/a' }).sentEtag, null);
});

test('normalizeHref: accepted forms', () => {
  const O = 'http://dav.example.org';
  assert.equal(normalizeHref('/', O), '/');
  assert.equal(normalizeHref('/alice/', O), '/alice/');
  assert.equal(normalizeHref('/alice/work/e1.ics', O), '/alice/work/e1.ics');
  assert.equal(normalizeHref('http://dav.example.org/alice/work/', O), '/alice/work/');
  assert.equal(normalizeHref('HTTP://DAV.EXAMPLE.ORG/alice/', O), '/alice/');
  assert.equal(normalizeHref('/alice/My%20Cal%20%2B%C3%A9%20%40~x/o1.ics', O), '/alice/My%20Cal%20%2B%C3%A9%20%40~x/o1.ics');
  // canonical re-encoding makes equivalent spellings equal
  assert.equal(normalizeHref('/alice/a@b+c d/', O), '/alice/a%40b%2Bc%20d/');
  assert.equal(normalizeHref('/alice/a%40b/', O), normalizeHref('/alice/a@b/', O));
  assert.equal(normalizeHref('/a/%7Efoo', O), '/a/~foo');
  assert.equal(normalizeHref('/a/b', ''), '/a/b');
});

test('normalizeHref: rejected forms', () => {
  const O = 'http://dav.example.org';
  const bad = [
    '', null, undefined, 5, 'alice/', '//evil.example.net/x', '//dav.example.org/x', 'http://evil.example.net/x', 'https://dav.example.org/x',
    'http://dav.example.org:81/x', 'http://user:pw@dav.example.org/x', 'ftp://dav.example.org/x', 'javascript:alert(1)', 'data:text/plain,x',
    '/a/../b', '/a/./b', '/a/%2e%2e/b', '/a/%2E%2E/', '/..', '/a/%2e/b', '/a%2Fb', '/a%2fb/c', '/a%5Cb', '/a\\b', '/a//b', '//', '/a/%zz', '/a/%',
    '/a?q=1', '/a#f', '/a\nb', '/a\u0000b', '/a%00b', '/a%0Ab', '/' + 'x'.repeat(5000),
  ];
  for (const h of bad) assert.throws(() => normalizeHref(h, O), (e) => e instanceof DavError && e.kind === 'invalid', JSON.stringify(h));
  assert.throws(() => normalizeHref('http://dav.example.org/x', ''), DavError, 'absolute URL without a configured origin');
});

test('normalizeHref honours the base path', () => {
  assert.equal(normalizeHref('/dav/alice/', '', '/dav/'), '/dav/alice/');
  assert.equal(normalizeHref('/dav/', '', '/dav/'), '/dav/');
  assert.equal(normalizeHref('/dav', '', '/dav/'), '/dav');
  assert.throws(() => normalizeHref('/other/alice/', '', '/dav/'), DavError);
  assert.throws(() => normalizeHref('/davx/alice/', '', '/dav/'), DavError);
  const t = createTransport({ origin: ORIGIN, basePath: '/dav', fetchImpl: () => {} });
  assert.equal(t.basePath, '/dav/');
  assert.throws(() => t.normalize('/alice/'), DavError);
  assert.equal(t.normalize('http://dav.example.org/dav/alice/'), '/dav/alice/');
});

test('encodeSegment and joinPath: odd collection names', () => {
  assert.equal(encodeSegment('My Cal'), 'My%20Cal');
  assert.equal(encodeSegment('a+b'), 'a%2Bb');
  assert.equal(encodeSegment('a@b'), 'a%40b');
  assert.equal(encodeSegment('a~b'), 'a~b');
  assert.equal(encodeSegment("it's (1)*!"), 'it%27s%20%281%29%2A%21');
  assert.equal(encodeSegment('été'), '%C3%A9t%C3%A9');
  assert.equal(encodeSegment('中文'), '%E4%B8%AD%E6%96%87');
  assert.equal(encodeSegment('\u{1F600}'), '%F0%9F%98%80');
  assert.equal(encodeSegment('50%'), '50%25');
  assert.equal(encodeSegment('a/b'), 'a%2Fb');
  assert.throws(() => encodeSegment('\ud800'), DavError);
  assert.equal(joinPath(['alice', 'My Cal +é @~x'], { trailingSlash: true }), '/alice/My%20Cal%20%2B%C3%A9%20%40~x/');
  assert.equal(joinPath(['alice', 'a.ics']), '/alice/a.ics');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000']) assert.throws(() => joinPath(['alice', bad]), DavError, JSON.stringify(bad));
  // round trip through normalizeHref
  for (const name of ['My Cal +é @~x', "a'b", '100%', 'a b', '中', '(x)']) {
    const p = joinPath(['alice', name], { trailingSlash: true });
    assert.equal(normalizeHref(p, ORIGIN), p);
    assert.equal(decodeURIComponent(p.split('/')[2]), name);
  }
});

test('line-ending helpers', () => {
  assert.equal(toLf('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(toCrlf('a\nb\r\nc\rd\n'), 'a\r\nb\r\nc\r\nd\r\n');
  assert.equal(toCrlf(toLf('x\r\ny')), 'x\r\ny');
});
