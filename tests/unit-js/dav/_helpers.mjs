// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for the DAV unit tests: recorded Radicale responses and a fake fetch.
import { readFileSync, existsSync } from 'node:fs';

const FIX = new URL('./fixtures/', import.meta.url);
export const index = JSON.parse(readFileSync(new URL('index.json', FIX), 'utf8'));

/** Body of a recorded response ('' when the response had none). */
export function fx(name) {
  const u = new URL(name + '.xml', FIX);
  return existsSync(u) ? readFileSync(u, 'utf8') : '';
}

/** Raw text fixture such as get-event2.ics. */
export function fxFile(file) {
  return readFileSync(new URL(file, FIX), 'utf8');
}

/** A recorded response as a fake-fetch response spec. */
export function recorded(name, tweak) {
  const meta = index[name];
  if (!meta) throw new Error('unknown fixture ' + name);
  let body = fx(name);
  if (tweak) body = tweak(body);
  return { status: meta.status, headers: { ...meta.headers }, body };
}

export const etagOf = (name) => index[name].headers.etag;

/**
 * Fake fetch. handler({url, path, method, headers, body, init}) returns a
 * response spec {status, headers, body} (or a Response); every call is kept in
 * fetch.calls. Header names are lower-cased in call.headers.
 */
export function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const u = new URL(url, 'http://placeholder.invalid');
    const call = { url: String(url), path: u.pathname, method: init.method || 'GET', headers, body: init.body, init };
    calls.push(call);
    const r = await handler(call);
    if (r instanceof Response) return r;
    const status = r.status === undefined ? 200 : r.status;
    const nullBody = status === 204 || status === 205 || status === 304 || r.body === undefined || r.body === '';
    return new Response(nullBody ? null : r.body, { status, headers: r.headers || {} });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export const ORIGIN = 'http://dav.example.org';
export const AUTH = 'Basic YWxpY2U6c2VjcmV0'; // alice:secret (test value)
