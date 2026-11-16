// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP transport for the DAV layer: same-origin only, explicit credentials,
// typed errors. Runs unchanged in browsers and Node (needs fetch and
// AbortController).
//
// Rules enforced here:
//   - every request is sent with cache:'no-store', credentials:'omit' (so the
//     browser never shows a native login prompt) and an explicit Authorization
//     header taken from getAuth();
//   - hrefs received from the server are accepted only as same-origin paths
//     (see normalizeHref); absolute foreign URLs, protocol-relative URLs, '..'
//     segments, encoded slashes and backslashes are rejected;
//   - credentials are never logged, never put into errors, never retried: this
//     module performs no automatic retries at all (a 401 is reported once).

import { parseXml, NS } from './xml.js';

/** Error kinds, in the order they are derived from a status code. */
export const KINDS = Object.freeze([
  'auth',
  'forbidden',
  'notfound',
  'precondition',
  'conflict',
  'toolarge',
  'network',
  'server',
  'invalid',
]);

export class DavError extends Error {
  /**
   * @param {string} kind one of KINDS
   * @param {object} [info] { status, body, method, path, message, cause, timeout }
   */
  constructor(kind, info = {}) {
    super(info.message || kind + (info.status ? ' (HTTP ' + info.status + ')' : ''));
    this.name = 'DavError';
    this.kind = kind;
    this.status = info.status || 0;
    this.body = typeof info.body === 'string' ? info.body : '';
    this.method = info.method || '';
    this.path = info.path || '';
    if (info.timeout) this.timeout = true;
    if (info.cause) this.cause = info.cause;
    // Parsed DAV:error body (RFC 4918 16): kept for the caller (decision D5).
    this.xml = null;
    this.conditions = [];
    if (this.body && this.body.indexOf('<') >= 0) {
      try {
        const root = parseXml(this.body);
        this.xml = root;
        if (root.ns === NS.DAV && root.name === 'error') {
          this.conditions = root.children.map((c) => ({ ns: c.ns, name: c.name }));
        }
      } catch {
        /* a plain-text or malformed body: no parsed form */
      }
    }
  }

  /** True when the DAV:error body contains the precondition element {ns}name. */
  hasCondition(ns, name) {
    return this.conditions.some((c) => c.ns === ns && c.name === name);
  }

  toJSON() {
    return { name: this.name, kind: this.kind, status: this.status, method: this.method, path: this.path, message: this.message };
  }
}

/** A 412 on a write: the item changed (or already exists) on the server. */
export class ConflictError extends DavError {
  /**
   * @param {object} info DavError info plus { href, sentEtag } where sentEtag is
   *   the If-Match value sent, or null for a create (If-None-Match: *).
   */
  constructor(info = {}) {
    super('precondition', info);
    this.name = 'ConflictError';
    this.href = info.href || info.path || '';
    this.sentEtag = info.sentEtag === undefined ? null : info.sentEtag;
  }
}

/** Map an HTTP status to a DavError kind (null for success). */
export function kindForStatus(status) {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'notfound';
  if (status === 412) return 'precondition';
  if (status === 409) return 'conflict';
  if (status === 413) return 'toolarge';
  if (status >= 500) return 'server';
  return 'invalid';
}

// ------------------------------------------------------------------ text

/** Normalise CRLF and lone CR to LF (the in-memory form of item text). */
export function toLf(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/** Convert any line-ending mix to CRLF (the on-the-wire form of item text). */
export function toCrlf(text) {
  return toLf(text).replace(/\n/g, '\r\n');
}

// ------------------------------------------------------------------ paths

/** Percent-encode one path segment (stricter than encodeURIComponent). */
export function encodeSegment(segment) {
  let enc;
  try {
    enc = encodeURIComponent(String(segment));
  } catch (e) {
    throw new DavError('invalid', { message: 'path segment is not valid Unicode', cause: e });
  }
  return enc.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Build '/a/b/' style path from raw (unencoded) segments. */
export function joinPath(segments, { trailingSlash = false } = {}) {
  const parts = segments.map((s) => {
    if (s === '' || s === '.' || s === '..' || /[\/\\\u0000]/.test(s)) {
      throw new DavError('invalid', { message: 'invalid path segment' });
    }
    return encodeSegment(s);
  });
  return '/' + parts.join('/') + (trailingSlash && parts.length ? '/' : '');
}

function bad(message) {
  return new DavError('invalid', { message });
}

/**
 * Validate a server-supplied href and return the canonical same-origin path
 * (segments decoded and re-encoded with encodeSegment, trailing slash kept).
 * Throws DavError('invalid') for anything else.
 *
 * @param {string} href
 * @param {string} [origin] expected origin ('' accepts paths only)
 * @param {string} [basePath] when not '/', the path must lie under it
 */
export function normalizeHref(href, origin = '', basePath = '/') {
  if (typeof href !== 'string' || !href) throw bad('empty href');
  if (href.length > 4096) throw bad('href too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\\]/.test(href)) throw bad('forbidden character in href');
  let path = href;
  if (/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(href)) {
    if (!origin) throw bad('absolute URL not allowed');
    let u;
    try {
      u = new URL(href);
    } catch {
      throw bad('malformed absolute URL');
    }
    let o;
    try {
      o = new URL(origin).origin;
    } catch {
      throw bad('invalid transport origin');
    }
    if (u.origin !== o || u.username || u.password) throw bad('href is not same-origin');
    path = href.slice(u.origin.length);
    if (u.username || u.password) throw bad('credentials in href');
  } else if (href.startsWith('//')) {
    throw bad('protocol-relative href');
  }
  if (path.charAt(0) !== '/') throw bad('href must be an absolute path');
  if (path.indexOf('?') >= 0 || path.indexOf('#') >= 0) throw bad('query or fragment in href');
  const raw = path.split('/');
  raw.shift(); // leading empty
  if (raw.length === 1 && raw[0] === '') raw.pop(); // the root path '/'
  const trailing = raw.length > 1 && raw[raw.length - 1] === '';
  if (trailing) raw.pop();
  const out = [];
  for (const seg of raw) {
    if (seg === '') throw bad('empty path segment');
    let dec;
    try {
      dec = decodeURIComponent(seg);
    } catch {
      throw bad('malformed percent-encoding');
    }
    if (dec === '.' || dec === '..') throw bad('dot segment in href');
    if (/[\/\\\u0000-\u001F]/.test(dec)) throw bad('encoded separator or control character in href');
    out.push(encodeSegment(dec));
  }
  const canon = out.length ? '/' + out.join('/') + (trailing ? '/' : '') : '/';
  if (basePath && basePath !== '/') {
    const base = basePath.endsWith('/') ? basePath : basePath + '/';
    if (canon !== base.slice(0, -1) && !canon.startsWith(base)) throw bad('href outside the base path');
  }
  return canon;
}

// -------------------------------------------------------------- transport

/**
 * @param {object} opts
 * @param {string} [opts.origin]    e.g. 'https://example.org'; '' (default) means
 *                                  paths relative to the page origin
 * @param {string} [opts.basePath]  Radicale base path, '/' by default
 * @param {() => (string|null|Promise<string|null>)} [opts.getAuth]
 *                                  returns the Authorization header value
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs] per-request timeout, default 30000
 * @param {number} [opts.maxResponseBytes] default 64 MiB (checked on Content-Length)
 * @param {() => void} [opts.onUnauthorized] called once per 401 response
 */
export function createTransport({
  origin = '',
  basePath = '/',
  getAuth,
  fetchImpl,
  timeoutMs = 30000,
  maxResponseBytes = 64 * 1024 * 1024,
  onUnauthorized,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new TypeError('no fetch implementation available');
  if (origin) {
    let o;
    try {
      o = new URL(origin);
    } catch {
      throw new TypeError('invalid origin');
    }
    if (o.origin === 'null' || o.pathname !== '/' || o.search || o.hash) throw new TypeError('origin must be scheme://host[:port]');
    origin = o.origin;
  }
  if (!basePath.startsWith('/')) throw new TypeError('basePath must start with /');
  const base = basePath.endsWith('/') ? basePath : basePath + '/';

  const normalize = (href) => normalizeHref(href, origin, base);

  /**
   * Send a request. path must be an already canonical same-origin path.
   * @returns {Promise<{status:number, text:string, headers:Headers, path:string, header:(n:string)=>string|null}>}
   *   Resolves for every 2xx status; any other status throws DavError.
   */
  async function request(method, path, { headers = {}, body, depth, timeoutMs: t, signal, allowStatus } = {}) {
    const canon = normalize(path);
    const h = { ...headers };
    if (depth !== undefined && depth !== null) h.Depth = String(depth);
    let auth = null;
    if (getAuth) auth = await getAuth();
    if (auth) h.Authorization = auth;

    const ctrl = new AbortController();
    let timedOut = false;
    const limit = t || timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, limit);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const info = { method, path: canon };
    let resp;
    let text = '';
    try {
      try {
        resp = await doFetch(origin + canon, {
          method,
          headers: h,
          body: body === undefined ? undefined : body,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: ctrl.signal,
        });
        const len = Number(resp.headers.get('content-length'));
        if (Number.isFinite(len) && len > maxResponseBytes) {
          throw new DavError('toolarge', { ...info, status: resp.status, message: 'response too large' });
        }
        text = await resp.text();
        if (text.length > maxResponseBytes) {
          throw new DavError('toolarge', { ...info, status: resp.status, message: 'response too large' });
        }
      } catch (e) {
        if (e instanceof DavError) throw e;
        if (timedOut) throw new DavError('network', { ...info, timeout: true, message: 'request timed out', cause: e });
        throw new DavError('network', { ...info, message: 'network error', cause: e });
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    const kind = kindForStatus(resp.status);
    if (kind && !(allowStatus && allowStatus.includes(resp.status))) {
      if (resp.status === 401 && onUnauthorized) {
        try {
          onUnauthorized();
        } catch {
          /* a failing hook must not mask the error */
        }
      }
      throw new DavError(kind, { ...info, status: resp.status, body: text });
    }
    return {
      status: resp.status,
      text,
      headers: resp.headers,
      path: canon,
      header: (n) => resp.headers.get(n),
    };
  }

  return { origin, basePath: base, request, normalize };
}
