// SPDX-License-Identifier: AGPL-3.0-or-later
// src/sw.js in a node:vm sandbox: precache with hash verification, activation, the fetch allowlist,
// "nothing is written to a cache at runtime", and the message channel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_FILES, SCOPE, loadWorker, makeCaches, manifestFor, sha256 } from './_sw-harness.mjs';

const VERSION = '0123456789abcdef';
const CACHE = 'radui-shell-' + VERSION;
const u = (p) => new URL(p, SCOPE).href;
const text = async (res) => res.text();

async function installed(opts = {}) {
  const w = loadWorker(opts);
  await w.lifecycle('install');
  await w.lifecycle('activate');
  w.caches.log.length = 0;
  w.fetchLog.length = 0;
  return w;
}

// ------------------------------------------------------------------ install

test('install: every listed file is fetched with cache:reload, verified and stored in radui-shell-<version>', async () => {
  const w = loadWorker();
  await w.lifecycle('install');
  assert.deepEqual([...w.caches.store.keys()], [CACHE]);
  const cached = w.caches.store.get(CACHE);
  assert.deepEqual([...cached.keys()].sort(), Object.keys(APP_FILES).map(u).sort());
  assert.equal(await text(cached.get(u('js/app.js'))), APP_FILES['js/app.js']);
  assert.equal(w.fetchLog.length, Object.keys(APP_FILES).length);
  for (const f of w.fetchLog) {
    assert.equal(f.cache, 'reload');
    assert.equal(f.redirect, 'error');
  }
});

test('install: a hash mismatch fails the install and leaves no cache behind', async () => {
  const w = loadWorker({ serverOverrides: { [u('js/app.js')]: new Response('export default 999; // changed', { status: 200 }) } });
  await assert.rejects(w.lifecycle('install'), /hash mismatch for js\/app\.js/);
  assert.equal(w.caches.store.has(CACHE), false);
});

test('install: a missing file (404) fails the install', async () => {
  const w = loadWorker({ serverOverrides: { [u('css/app.css')]: new Response('gone', { status: 404 }) } });
  await assert.rejects(w.lifecycle('install'), /HTTP 404 for css\/app\.css/);
  assert.equal(w.caches.store.has(CACHE), false);
});

test('install: a network failure fails the install', async () => {
  const w = loadWorker({ serverOverrides: { [u('index.html')]: new TypeError('offline') } });
  await assert.rejects(w.lifecycle('install'));
  assert.equal(w.caches.store.has(CACHE), false);
});

test('install: a redirected file fails the install (redirect:error)', async () => {
  const w = loadWorker({ serverOverrides: { [u('js/pwa.js')]: new TypeError('redirect mode is set to error') } });
  await assert.rejects(w.lifecycle('install'));
});

test('install: a half-deployed tree (one new file, rest old) can never be cached', async () => {
  // the manifest describes version B; the server still serves the old copy of one file
  const newFiles = { ...APP_FILES, 'js/app.js': 'export default "B";' };
  const w = loadWorker({ files: newFiles, serverOverrides: { [u('js/app.js')]: new Response(APP_FILES['js/app.js'], { status: 200 }) } });
  await assert.rejects(w.lifecycle('install'), /hash mismatch/);
  assert.equal(w.caches.store.size, 0);
});

test('install: config.json (unpinned) is stored unverified and may be absent', async () => {
  const w = loadWorker({ serverOverrides: { [u('config.json')]: new Response('{"appTitle":"Deployment value"}', { status: 200 }) } });
  await w.lifecycle('install');
  assert.equal(await text(w.caches.store.get(CACHE).get(u('config.json'))), '{"appTitle":"Deployment value"}');

  const absent = loadWorker({ serverOverrides: { [u('config.json')]: new Response('', { status: 404 }) } });
  await absent.lifecycle('install');
  assert.equal(absent.caches.store.get(CACHE).has(u('config.json')), false);
  assert.equal(absent.caches.store.get(CACHE).size, Object.keys(APP_FILES).length - 1);
});

test('install: an invalid file list fails the install', async () => {
  for (const manifest of [
    null,
    { version: 'short', files: manifestFor(APP_FILES).files },
    { version: VERSION, files: [] },
    { version: VERSION, files: manifestFor({ 'css/app.css': 'x' }).files }, // no index.html
    { version: VERSION, files: [{ path: 'index.html', sha256: 'nothex' }] },
  ]) {
    const w = loadWorker({ manifest });
    await assert.rejects(w.lifecycle('install'));
    assert.equal(w.caches.store.size, 0);
  }
});

test('install: a failed re-install of the same version keeps the existing cache', async () => {
  const caches = makeCaches();
  const ok = loadWorker({ caches });
  await ok.lifecycle('install');
  const bad = loadWorker({ caches, serverOverrides: { [u('js/app.js')]: new Response('tampered', { status: 200 }) } });
  await assert.rejects(bad.lifecycle('install'));
  assert.equal(caches.store.has(CACHE), true);
  assert.equal(caches.store.get(CACHE).size, Object.keys(APP_FILES).length);
});

test('install does not call skipWaiting; neither does activate', async () => {
  const w = loadWorker();
  await w.lifecycle('install');
  await w.lifecycle('activate');
  assert.equal(w.calls.skipWaiting, 0);
});

// ------------------------------------------------------------------ activate

test('activate: older radui-shell-* caches are deleted, others and the current one are kept, then clients.claim', async () => {
  const caches = makeCaches();
  await caches.open('radui-shell-aaaaaaaaaaaaaaaa');
  await caches.open('radui-shell-bbbbbbbbbbbbbbbb');
  await caches.open('another-app-cache');
  const w = loadWorker({ caches });
  await w.lifecycle('install');
  await w.lifecycle('activate');
  assert.deepEqual([...caches.store.keys()].sort(), ['another-app-cache', CACHE]);
  assert.equal(w.calls.claim, 1);
  assert.equal(w.calls.skipWaiting, 0);
});

// ------------------------------------------------------------------ fetch: served from the precache

test('fetch: a listed file is served cache-first, without touching the network', async () => {
  const w = await installed();
  const { handled, response } = await w.fetchEvent({ url: u('js/app.js') });
  assert.equal(handled, true);
  assert.equal(await text(response), APP_FILES['js/app.js']);
  assert.equal(w.fetchLog.length, 0);
});

test('fetch: a listed file missing from the cache goes to the network and is NOT stored', async () => {
  const w = await installed();
  w.caches.store.get(CACHE).delete(u('css/app.css'));
  const { handled, response } = await w.fetchEvent({ url: u('css/app.css') });
  assert.equal(handled, true);
  assert.equal(await text(response), APP_FILES['css/app.css']);
  assert.equal(w.fetchLog.length, 1);
  assert.equal(w.caches.store.get(CACHE).has(u('css/app.css')), false);
  assert.deepEqual(w.caches.log, []);
});

test('fetch: navigations to the scope root and to index.html are served from the cached index.html', async () => {
  const w = await installed();
  // the network has a NEWER index.html: it must not be used while the cache answers
  w.server.set(u('index.html'), () => new Response('<!doctype html><title>NEW</title>', { status: 200 }));
  for (const url of [SCOPE, u('index.html'), SCOPE + '?utm=1']) {
    const { handled, response } = await w.fetchEvent({ url, mode: 'navigate' });
    assert.equal(handled, true, url);
    assert.equal(await text(response), APP_FILES['index.html'], url);
  }
  assert.equal(w.fetchLog.length, 0);
});

test('fetch: a navigation on a cache miss uses the network', async () => {
  const w = await installed();
  w.caches.store.get(CACHE).delete(u('index.html'));
  w.server.set(SCOPE, () => new Response(APP_FILES['index.html'], { status: 200 })); // nginx serves index.html for the directory
  const { handled, response } = await w.fetchEvent({ url: SCOPE, mode: 'navigate' });
  assert.equal(handled, true);
  assert.equal(await text(response), APP_FILES['index.html']);
  assert.equal(w.fetchLog.length, 1);
  assert.equal(w.caches.store.get(CACHE).has(u('index.html')), false);
});

test('fetch: when the cache itself throws the network answers', async () => {
  const w = await installed();
  w.caches.match = async () => {
    throw new Error('storage failure');
  };
  const { response } = await w.fetchEvent({ url: u('js/app.js') });
  assert.equal(await text(response), APP_FILES['js/app.js']);
});

// ------------------------------------------------------------------ fetch: config.json is network-first

test('config.json: the network answer wins, the precached copy is the fallback', async () => {
  const w = await installed();
  w.server.set(u('config.json'), () => new Response('{"appTitle":"Live"}', { status: 200 }));
  assert.equal(await text((await w.fetchEvent({ url: u('config.json') })).response), '{"appTitle":"Live"}');

  w.server.set(u('config.json'), new TypeError('offline'));
  assert.equal(await text((await w.fetchEvent({ url: u('config.json') })).response), APP_FILES['config.json']);

  w.server.set(u('config.json'), () => new Response('bad gateway', { status: 502 }));
  assert.equal(await text((await w.fetchEvent({ url: u('config.json') })).response), APP_FILES['config.json']);
  assert.deepEqual(w.caches.log, []);
});

test('config.json: a 404 is passed on (the app then uses its defaults); offline without a copy is an error', async () => {
  const w = await installed();
  w.server.set(u('config.json'), () => new Response('', { status: 404 }));
  assert.equal((await w.fetchEvent({ url: u('config.json') })).response.status, 404);

  w.caches.store.get(CACHE).delete(u('config.json'));
  w.server.set(u('config.json'), new TypeError('offline'));
  const { response } = await w.fetchEvent({ url: u('config.json') });
  assert.equal(response.type, 'error');
});

// ------------------------------------------------------------------ fetch: the allowlist

test('fetch: everything outside the allowlist passes through untouched (respondWith is never called)', async () => {
  const w = await installed();
  const passes = [
    { url: 'https://example.org/alice/contacts/' }, // DAV path, same origin
    { url: 'https://example.org/alice/contacts/card.vcf' },
    { url: 'https://example.org/.sharing/grants' },
    { url: 'https://example.org/' },
    { url: 'https://example.org/ui' },
    { url: u('api/me') },
    { url: u('api/') },
    { url: u('nope.js') }, // unknown path inside the scope
    { url: u('sw.js') },
    { url: u('sw-manifest.js') },
    { url: u('js/') },
    { url: u('js/app.js') + '?v=2' }, // a query string is a deliberate bypass
    { url: u('js/app.js'), headers: { range: 'bytes=0-9' } },
    { url: u('js/app.js'), method: 'POST' },
    { url: u('js/app.js'), method: 'PUT' },
    { url: u('js/app.js'), method: 'DELETE' },
    { url: u('js/app.js'), method: 'HEAD' },
    { url: u('index.html'), method: 'POST', mode: 'navigate' },
    { url: u('other/page'), mode: 'navigate' }, // navigation to something that is not the app page
    { url: u('api/me'), mode: 'navigate' },
    { url: 'https://evil.example.com/ui/js/app.js' }, // cross-origin
    { url: 'https://example.org:8443/ui/js/app.js' }, // other port = other origin
    { url: 'http://example.org/ui/js/app.js' },
    { url: 'https://example.org/ui-other/js/app.js' }, // sibling path, not the scope
    { url: 'not a url' },
  ];
  for (const p of passes) {
    const r = await w.fetchEvent(p);
    assert.equal(r.handled, false, JSON.stringify(p));
  }
  assert.equal(w.fetchLog.length, 0);
});

test('nothing is ever written to a cache at runtime', async () => {
  const w = await installed(); // the log is cleared after install and activate
  const requests = [
    { url: u('js/app.js') },
    { url: u('css/app.css') },
    { url: SCOPE, mode: 'navigate' },
    { url: u('config.json') },
    { url: 'https://example.org/alice/contacts/' },
    { url: u('api/me') },
    { url: u('unknown.js') },
    { url: u('js/app.js'), method: 'PUT' },
  ];
  w.caches.store.get(CACHE).delete(u('js/pwa.js'));
  requests.push({ url: u('js/pwa.js') }); // a miss
  w.server.set(u('config.json'), () => new Response('{"appTitle":"Changed"}', { status: 200 }));
  for (const r of requests) await w.fetchEvent(r);
  w.message({ type: 'GET_VERSION' }, { port: { postMessage() {} } });
  assert.deepEqual(w.caches.log, []);
  assert.equal(w.caches.store.size, 1);
  assert.equal(w.caches.store.get(CACHE).size, Object.keys(APP_FILES).length - 1);
});

// ------------------------------------------------------------------ messages

test('skipWaiting only happens on a SKIP_WAITING message', async () => {
  const w = await installed();
  w.message({ type: 'SOMETHING_ELSE' });
  w.message(null);
  w.message('SKIP_WAITING');
  w.message({});
  assert.equal(w.calls.skipWaiting, 0);
  w.message({ type: 'SKIP_WAITING' });
  assert.equal(w.calls.skipWaiting, 1);
});

test('GET_VERSION answers on the message port, or on the source client', async () => {
  const w = await installed();
  const onPort = [];
  w.message({ type: 'GET_VERSION' }, { port: { postMessage: (m) => onPort.push(m) } });
  assert.deepEqual(JSON.parse(JSON.stringify(onPort)), [{ type: 'VERSION', version: VERSION, cache: CACHE }]);
  const onSource = [];
  w.message({ type: 'GET_VERSION' }, { source: { postMessage: (m) => onSource.push(m) } });
  assert.equal(onSource[0].version, VERSION);
  w.message({ type: 'GET_VERSION' }); // nobody to answer: no throw
});

// ------------------------------------------------------------------ with the real generator

test('the worker installs a tree described by tools/build-sw-manifest.py', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radui-sw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'run', 'sw-manifest.js');
  const tree = { ...APP_FILES, 'icons/README.md': '# not listed', 'package.json': '{}', 'sw.js': '// not listed' };
  for (const [p, body] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true });
    fs.writeFileSync(path.join(src, p), body);
  }
  const run = spawnSync('python3', ['-I', path.join(repo, 'tools', 'build-sw-manifest.py'), '--src', src, '--out', out], { encoding: 'utf8' });
  if (run.error) return t.skip('python3 is not available');
  assert.equal(run.status, 0, run.stderr);

  const vm = await import('node:vm');
  const holder = { self: {} };
  vm.runInNewContext(fs.readFileSync(out, 'utf8'), holder);
  const manifest = JSON.parse(JSON.stringify(holder.self.RADUI_SW_MANIFEST));
  assert.deepEqual(manifest.files.map((f) => f.path), Object.keys(APP_FILES).sort());
  assert.equal(manifest.files.find((f) => f.path === 'js/app.js').sha256, sha256(APP_FILES['js/app.js']));
  const w = loadWorker({ manifest });
  await w.lifecycle('install');
  assert.equal(w.caches.store.get('radui-shell-' + manifest.version).size, Object.keys(APP_FILES).length);
});
