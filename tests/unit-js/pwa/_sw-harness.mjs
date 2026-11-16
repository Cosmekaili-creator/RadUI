// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs src/sw.js inside a node:vm sandbox with fake `self`, `caches` and `fetch`.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SW_SOURCE = fs.readFileSync(path.join(HERE, '..', '..', '..', 'src', 'sw.js'), 'utf8');
export const SCOPE = 'https://example.org/ui/';
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** The default fake app: path -> text. */
export const APP_FILES = Object.freeze({
  'index.html': '<!doctype html><title>x</title>',
  'config.json': '{"appTitle":"Fake"}',
  'css/app.css': 'body{}',
  'js/app.js': 'export default 1;',
  'js/pwa.js': 'export default 2;',
});

export function manifestFor(files, { version = '0123456789abcdef', unpinned = ['config.json'] } = {}) {
  const entries = Object.keys(files)
    .sort()
    .map((p) => ({ path: p, sha256: unpinned.includes(p) ? null : sha256(files[p]) }));
  return { version, files: entries };
}

export function manifestScript(manifest) {
  return `self.RADUI_SW_MANIFEST = Object.freeze(${JSON.stringify(manifest)});`;
}

/** Fake CacheStorage that records every mutation in `log`. */
export function makeCaches() {
  const store = new Map(); // name -> Map(url -> Response)
  const log = [];
  const urlOf = (req) => (typeof req === 'string' ? req : req.url);
  return {
    store,
    log,
    async has(name) {
      return store.has(name);
    },
    async keys() {
      return [...store.keys()];
    },
    async open(name) {
      if (!store.has(name)) {
        store.set(name, new Map());
        log.push({ op: 'create', name });
      }
      const entries = store.get(name);
      return {
        async put(req, res) {
          log.push({ op: 'put', name, url: urlOf(req) });
          entries.set(urlOf(req), res);
        },
        async match(req) {
          const r = entries.get(urlOf(req));
          return r ? r.clone() : undefined;
        },
        async keys() {
          return [...entries.keys()];
        },
      };
    },
    async delete(name) {
      log.push({ op: 'delete', name });
      return store.delete(name);
    },
    async match(req, opts = {}) {
      const names = opts.cacheName ? [opts.cacheName] : [...store.keys()];
      for (const n of names) {
        const r = store.has(n) ? store.get(n).get(urlOf(req)) : undefined;
        if (r) return r.clone();
      }
      return undefined;
    },
  };
}

/**
 * Loads sw.js. `server` maps an absolute URL to a Response, a function (request) -> Response, or
 * an Error (network failure). `fetchLog` records every request the worker makes.
 */
export function loadWorker({ files = APP_FILES, manifest, scope = SCOPE, version, serverOverrides = {}, caches = makeCaches() } = {}) {
  const man = manifest === undefined ? manifestFor(files, version ? { version } : {}) : manifest;
  const handlers = {};
  const fetchLog = [];
  const calls = { skipWaiting: 0, claim: 0 };
  const server = new Map();
  for (const [p, text] of Object.entries(files)) server.set(new URL(p, scope).href, () => new Response(text, { status: 200 }));
  for (const [u, v] of Object.entries(serverOverrides)) server.set(u, v);

  const fetchFn = async (req) => {
    const url = typeof req === 'string' ? req : req.url;
    fetchLog.push({ url, cache: req.cache, redirect: req.redirect, mode: req.mode });
    const v = server.get(url);
    if (v === undefined) return new Response('not found', { status: 404 });
    if (v instanceof Error) throw v;
    const res = typeof v === 'function' ? v(req) : v;
    return res.clone ? res.clone() : res;
  };

  const sandbox = {
    URL,
    Request,
    Response,
    Headers,
    crypto: crypto.webcrypto,
    caches,
    fetch: fetchFn,
    importScripts(name) {
      if (name !== 'sw-manifest.js') throw new Error('unexpected importScripts: ' + name);
      vm.runInContext(manifestScript(man), context);
    },
  };
  sandbox.self = sandbox;
  sandbox.registration = { scope };
  sandbox.clients = {
    async claim() {
      calls.claim += 1;
    },
  };
  sandbox.skipWaiting = async () => {
    calls.skipWaiting += 1;
  };
  sandbox.addEventListener = (type, fn) => {
    (handlers[type] = handlers[type] || []).push(fn);
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' });

  /** Dispatch an install/activate style event and wait for every waitUntil promise. */
  async function lifecycle(type) {
    const promises = [];
    for (const fn of handlers[type] || []) fn({ waitUntil: (p) => promises.push(p) });
    await Promise.all(promises);
  }

  /** Dispatch a fetch event; returns {handled, response}. */
  async function fetchEvent({ url, method = 'GET', mode = 'cors', headers = {} }) {
    let responded;
    const request = { url, method, mode, destination: mode === 'navigate' ? 'document' : '', headers: new Headers(headers) };
    for (const fn of handlers.fetch || []) fn({ request, respondWith: (p) => (responded = Promise.resolve(p)) });
    if (!responded) return { handled: false, response: null };
    return { handled: true, response: await responded };
  }

  function message(data, { port = null, source = null } = {}) {
    for (const fn of handlers.message || []) fn({ data, ports: port ? [port] : [], source });
  }

  return { handlers, caches, calls, fetchLog, server, manifest: man, lifecycle, fetchEvent, message, context, scope };
}
