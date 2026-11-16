// SPDX-License-Identifier: AGPL-3.0-or-later
// RadUI service worker (classic worker). Design notes: docs/pwa.md.
//
// - Install: fetch every file of sw-manifest.js (bypassing the HTTP cache), check its SHA-256 and
//   store it in `radui-shell-<version>`. ANY failure or mismatch fails the install: one version of
//   the app is cached completely or not at all.
// - Activate: delete the older `radui-shell-*` caches.
// - No runtime caching: this worker never writes to a cache outside the install step.
// - Fetch is an ALLOWLIST (GET, same origin, inside the scope): listed files cache-first,
//   `config.json` network-first, navigations to the scope root served from the cached index.html.
//   Everything else (DAV, api/, unknown paths, other methods, other origins) is left untouched.
// - A new worker waits until the page sends {type: 'SKIP_WAITING'} (the update banner button).

'use strict';

importScripts('sw-manifest.js');

const PREFIX = 'radui-shell-';
const MANIFEST = self.RADUI_SW_MANIFEST;
const CACHE = PREFIX + (MANIFEST && MANIFEST.version);
const SCOPE = self.registration.scope;
const ORIGIN = new URL(SCOPE).origin;
const INDEX = new URL('index.html', SCOPE).href;
const BATCH = 6;

// absolute URL -> manifest entry. `sha256: null` marks a deployment-specific file (config.json):
// network-first, not verified.
const ENTRIES = new Map();
if (MANIFEST && Array.isArray(MANIFEST.files)) {
  for (const entry of MANIFEST.files) {
    if (entry && typeof entry.path === 'string') ENTRIES.set(new URL(entry.path, SCOPE).href, entry);
  }
}

function manifestProblem() {
  if (!MANIFEST || typeof MANIFEST.version !== 'string' || !/^[0-9a-f]{16}$/.test(MANIFEST.version)) return 'the file list has no valid version';
  if (!Array.isArray(MANIFEST.files) || MANIFEST.files.length === 0) return 'the file list is empty';
  for (const entry of MANIFEST.files) {
    if (!entry || typeof entry.path !== 'string') return 'a file list entry has no path';
    if (entry.sha256 !== null && !(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256))) return 'a file list entry has no valid hash: ' + entry.path;
  }
  if (!ENTRIES.has(INDEX)) return 'index.html is not in the file list';
  return null;
}

function toHex(buffer) {
  let out = '';
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, '0');
  return out;
}

// ------------------------------------------------------------------ install

async function precacheOne(cache, href, entry) {
  const pinned = entry.sha256 !== null;
  try {
    const response = await fetch(new Request(href, { cache: 'reload', credentials: 'same-origin', redirect: 'error' }));
    if (!response.ok || response.status !== 200) throw new Error('HTTP ' + response.status + ' for ' + entry.path);
    if (pinned) {
      const digest = toHex(await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer()));
      if (digest !== entry.sha256) throw new Error('hash mismatch for ' + entry.path);
    }
    await cache.put(href, response);
  } catch (error) {
    if (pinned) throw error;
    // an unpinned file (config.json) may be absent: the app then runs on defaults
  }
}

async function precache() {
  const problem = manifestProblem();
  if (problem) throw new Error(problem);
  const existed = await caches.has(CACHE);
  const cache = await caches.open(CACHE);
  try {
    const todo = Array.from(ENTRIES);
    for (let i = 0; i < todo.length; i += BATCH) {
      await Promise.all(todo.slice(i, i + BATCH).map(([href, entry]) => precacheOne(cache, href, entry)));
    }
  } catch (error) {
    if (!existed) await caches.delete(CACHE);
    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

// ------------------------------------------------------------------ activate

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// ------------------------------------------------------------------ fetch (allowlist)

async function cacheFirst(href, request) {
  try {
    const hit = await caches.match(href, { cacheName: CACHE });
    if (hit) return hit;
  } catch (error) {
    // cache unavailable: use the network
  }
  return fetch(request);
}

async function networkFirst(href, request) {
  let response = null;
  try {
    response = await fetch(request);
    if (response.status < 500) return response;
  } catch (error) {
    response = null;
  }
  try {
    const hit = await caches.match(href, { cacheName: CACHE });
    if (hit) return hit;
  } catch (error) {
    // cache unavailable
  }
  return response || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.origin !== ORIGIN || !url.href.startsWith(SCOPE)) return;
  if (request.headers && request.headers.has && request.headers.has('range')) return;
  const bare = url.origin + url.pathname;

  if (request.mode === 'navigate') {
    // The page itself: cache-first, so that a new index.html never runs against old modules.
    // The update banner performs the reload that moves to the new version.
    if (bare === SCOPE || bare === INDEX) event.respondWith(cacheFirst(INDEX, request));
    return;
  }

  if (url.search !== '') return;
  const entry = ENTRIES.get(bare);
  if (!entry) return;
  event.respondWith(entry.sha256 === null ? networkFirst(bare, request) : cacheFirst(bare, request));
});

// ------------------------------------------------------------------ messages from the page

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION') {
    const reply = { type: 'VERSION', version: MANIFEST ? MANIFEST.version : null, cache: CACHE };
    const port = event.ports && event.ports[0];
    if (port) port.postMessage(reply);
    else if (event.source && event.source.postMessage) event.source.postMessage(reply);
  }
});
