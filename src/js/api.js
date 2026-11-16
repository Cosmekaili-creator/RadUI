// SPDX-License-Identifier: AGPL-3.0-or-later
// Client for the account service ("admin backend"): me, me/access and the
// generic verbs later screens will use. The service's health endpoint is
// loopback-only behind the proxy, so the browser never calls it: the health
// view (`rightsActive`, `ok`) comes with `me`. Same transport rules as the DAV
// layer: same-origin paths only, `credentials: 'omit'` plus an explicit
// Authorization header (so the browser can never show its own password prompt),
// `cache: 'no-store'`, no redirects, typed errors, the `X-RadUI: 1` header on
// every mutating call. No DOM access; runs in Node.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const REL_PATH_RE = /^[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*\/?$/;

/** Error kinds, mapped from HTTP status and the backend's error code. */
export const API_ERROR_KINDS = Object.freeze([
  'auth', // 401
  'forbidden', // 403
  'notfound', // 404
  'conflict', // 409
  'badrequest', // 400, 415
  'validation', // 422
  'toolarge', // 413
  'ratelimited', // 429
  'unavailable', // 502, 503, 504
  'server', // other 5xx
  'network', // fetch failed, timed out or was redirected
  'invalid', // 2xx with an unusable body, or an unexpected status
]);

export class ApiError extends Error {
  /**
   * @param {string} kind one of API_ERROR_KINDS
   * @param {{status?: number, code?: string, field?: string, method?: string, path?: string,
   *          message?: string, retryAfter?: number, timeout?: boolean, cause?: unknown}} [info]
   */
  constructor(kind, info = {}) {
    super(info.message || `${kind}${info.status ? ' (HTTP ' + info.status + ')' : ''}`);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = info.status ?? null;
    this.code = info.code ?? null;
    this.field = info.field ?? null;
    this.method = info.method ?? null;
    this.path = info.path ?? null;
    this.retryAfter = info.retryAfter ?? null;
    this.timeout = Boolean(info.timeout);
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

export function kindForStatus(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notfound';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 415) return 'badrequest';
  if (status === 413) return 'toolarge';
  if (status === 422) return 'validation';
  if (status === 429) return 'ratelimited';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status >= 500) return 'server';
  return 'invalid';
}

/** Join the API base and a relative path, refusing anything that could leave the API prefix. */
export function apiPath(apiBase, rel, query) {
  if (typeof apiBase !== 'string' || !apiBase.startsWith('/') || apiBase.startsWith('//')) throw new TypeError('apiBase must be an absolute same-origin path');
  if (typeof rel !== 'string' || !REL_PATH_RE.test(rel)) throw new TypeError('invalid API path');
  for (const seg of rel.split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw new TypeError('invalid API path');
    }
    if (seg === '.' || seg === '..' || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) throw new TypeError('invalid API path');
  }
  const base = apiBase.endsWith('/') ? apiBase : apiBase + '/';
  let path = base + rel;
  if (query && typeof query === 'object') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) q.set(k, String(v));
    const s = q.toString();
    if (s) path += '?' + s;
  }
  return path;
}

function parseErrorBody(text) {
  try {
    const j = JSON.parse(text);
    const e = j && typeof j === 'object' ? j.error : null;
    if (e && typeof e === 'object') {
      return {
        code: typeof e.code === 'string' ? e.code.slice(0, 64) : null,
        field: typeof e.field === 'string' ? e.field.slice(0, 64) : null,
        message: typeof e.message === 'string' ? e.message.slice(0, 300) : null,
      };
    }
  } catch {
    /* not JSON: nginx error pages and the like */
  }
  return { code: null, field: null, message: null };
}

// ------------------------------------------------------------- normalisers

const str = (v) => (typeof v === 'string' ? v : null);

const bool = (v) => (typeof v === 'boolean' ? v : null);

/**
 * `GET me` -> {login, displayName, type, admin, ownSpace, generation, rightsActive, ok}.
 * `rightsActive` and `ok` are the account service's own health view (the health
 * endpoint itself is loopback-only behind the proxy); null when an older server omits them.
 */
export function normalizeMe(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.login !== 'string' || !json.login) {
    throw new ApiError('invalid', { message: 'unexpected answer for me' });
  }
  return {
    login: json.login,
    displayName: str(json.displayName) || json.login,
    type: json.type === 'bot' || json.type === 'person' ? json.type : null,
    admin: json.admin === true,
    ownSpace: json.ownSpace !== false,
    generation: Number.isInteger(json.generation) ? json.generation : null,
    rightsActive: bool(json.rightsActive),
    ok: bool(json.ok),
  };
}

/** `GET me/access` -> {login, admin, ownSpace, principals, grants[]}. Malformed grants are dropped. */
export function normalizeAccess(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ApiError('invalid', { message: 'unexpected answer for me/access' });
  const grants = [];
  for (const g of Array.isArray(json.grants) ? json.grants : []) {
    if (!g || typeof g !== 'object' || typeof g.href !== 'string' || !g.href) continue;
    grants.push({
      href: g.href,
      owner: str(g.owner),
      collection: str(g.collection),
      level: g.level === 'readwrite' || g.level === 'read' ? g.level : null,
      grantedBy: str(g.grantedBy),
      created: str(g.created),
    });
  }
  return {
    login: str(json.login),
    admin: json.admin === true,
    ownSpace: json.ownSpace !== false,
    principals: Array.isArray(json.principals) ? json.principals.filter((p) => typeof p === 'string') : null,
    grants,
  };
}

/** `GET grants` -> [{owner, collection, grantee, level, grantedBy, created}]. Malformed records are dropped. */
export function normalizeGrants(json) {
  if (!Array.isArray(json)) throw new ApiError('invalid', { message: 'unexpected answer for grants' });
  const out = [];
  for (const g of json) {
    if (!g || typeof g !== 'object' || typeof g.owner !== 'string' || typeof g.collection !== 'string' || typeof g.grantee !== 'string') continue;
    out.push({
      owner: g.owner,
      collection: g.collection,
      grantee: g.grantee,
      level: g.level === 'readwrite' || g.level === 'read' ? g.level : null,
      grantedBy: str(g.grantedBy),
      created: str(g.created),
    });
  }
  return out;
}

/** Levels `PUT grants` accepts. */
export const GRANT_LEVELS = Object.freeze(['none', 'read', 'readwrite']);

/** Account logins the service accepts (docs/api.md, Authentication). */
export const ACCOUNT_LOGIN_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const num = (v) => (Number.isInteger(v) ? v : null);

function assertLogin(login) {
  if (typeof login !== 'string' || !ACCOUNT_LOGIN_RE.test(login)) throw new TypeError('invalid login');
  return login;
}

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('the body must be an object');
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/** One account record of `GET accounts`, `GET accounts/{login}` and mutation answers (never a hash). */
export function normalizeAccountRecord(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.login !== 'string' || !json.login) {
    throw new ApiError('invalid', { message: 'unexpected account record' });
  }
  return {
    login: json.login,
    displayName: str(json.displayName) || json.login,
    type: json.type === 'bot' || json.type === 'person' ? json.type : null,
    admin: json.admin === true,
    disabled: json.disabled === true,
    ownSpace: json.ownSpace !== false,
    created: str(json.created),
    passwordChanged: str(json.passwordChanged),
  };
}

/** `GET accounts` -> account records; malformed ones are dropped. */
export function normalizeAccounts(json) {
  if (!Array.isArray(json)) throw new ApiError('invalid', { message: 'unexpected answer for accounts' });
  const out = [];
  for (const a of json) {
    try {
      out.push(normalizeAccountRecord(a));
    } catch {
      /* dropped */
    }
  }
  return out;
}

/** `GET directory` -> [{login, displayName, type}] of enabled accounts. */
export function normalizeDirectory(json) {
  if (!Array.isArray(json)) throw new ApiError('invalid', { message: 'unexpected answer for directory' });
  const out = [];
  for (const a of json) {
    if (!a || typeof a !== 'object' || typeof a.login !== 'string' || !a.login) continue;
    out.push({ login: a.login, displayName: str(a.displayName) || a.login, type: a.type === 'bot' || a.type === 'person' ? a.type : null });
  }
  return out;
}

/** `GET effective/{login}` -> [{path, level, letters}]. */
export function normalizeEffective(json) {
  if (!Array.isArray(json)) throw new ApiError('invalid', { message: 'unexpected answer for effective' });
  const out = [];
  for (const e of json) {
    if (!e || typeof e !== 'object' || typeof e.path !== 'string') continue;
    out.push({ path: e.path, level: str(e.level), letters: str(e.letters) });
  }
  return out;
}

/**
 * Answer of a mutating endpoint (real or dry run). `pending` is true for the 202 case
 * (`active: false`, `warning: "activation_pending"`: the files are written, Radicale has not confirmed yet).
 * `password` is present only for a generated one and only in this answer: callers show it once and drop it.
 */
export function normalizeMutation(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ApiError('invalid', { message: 'unexpected answer for a change' });
  const out = {
    dryRun: json.dryRun === true,
    noop: json.noop === true,
    generation: num(json.generation),
    active: bool(json.active),
    warning: str(json.warning),
    pending: json.active === false || json.warning === 'activation_pending',
    summary: str(json.summary),
    confirmRequired: json.confirmRequired === undefined || json.confirmRequired === null ? false : json.confirmRequired,
    confirm: str(json.confirm),
    rights: {
      added: Array.isArray(json.rights && json.rights.added) ? json.rights.added : [],
      removed: Array.isArray(json.rights && json.rights.removed) ? json.rights.removed : [],
    },
    effective: Array.isArray(json.effective)
      ? json.effective.filter((e) => e && typeof e === 'object').map((e) => ({ login: str(e.login), path: str(e.path), before: str(e.before), after: str(e.after) }))
      : [],
    effectiveTruncated: json.effectiveTruncated === true,
    account: null,
    grant: null,
    deleted: null,
    password: typeof json.password === 'string' ? json.password : null,
  };
  if (json.account && typeof json.account === 'object') {
    try {
      out.account = normalizeAccountRecord(json.account);
    } catch {
      /* leave null */
    }
  }
  if (json.grant && typeof json.grant === 'object') out.grant = normalizeGrants([json.grant])[0] || null;
  if (json.deleted !== undefined && json.deleted !== null) out.deleted = json.deleted;
  return out;
}

// ------------------------------------------------------------------ client

/**
 * @param {object} opts
 * @param {string} opts.apiBase absolute same-origin path of the API, e.g. what resolveBases() returned
 * @param {() => (string|null|Promise<string|null>)} [opts.getAuth] Authorization header value
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {() => void} [opts.onUnauthorized] called once per 401 answer
 */
export function createApi({ apiBase, getAuth, fetchImpl, timeoutMs = 15000, onUnauthorized } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new TypeError('no fetch implementation available');
  apiPath(apiBase, 'x'); // validates the base

  /**
   * One request. `rel` is relative to the API base. Resolves with the parsed
   * JSON body (null for an empty one) for 2xx; throws ApiError otherwise.
   */
  async function request(method, rel, { query, body, signal } = {}) {
    const upper = String(method).toUpperCase();
    const path = apiPath(apiBase, rel, query);
    const headers = { Accept: 'application/json' };
    let auth = null;
    if (getAuth) auth = await getAuth();
    if (auth) headers.Authorization = auth;
    let payload;
    if (MUTATING.has(upper)) {
      headers['X-RadUI'] = '1';
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const info = { method: upper, path: path.split('?')[0] };
    let resp;
    let text = '';
    try {
      try {
        resp = await doFetch(path, {
          method: upper,
          headers,
          body: payload,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: ctrl.signal,
        });
        text = await resp.text();
        if (text.length > MAX_RESPONSE_CHARS) throw new ApiError('invalid', { ...info, status: resp.status, message: 'response too large' });
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError('network', { ...info, timeout: timedOut, message: timedOut ? 'request timed out' : 'network error', cause: e });
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (resp.status >= 200 && resp.status < 300) {
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new ApiError('invalid', { ...info, status: resp.status, message: 'the answer is not JSON', cause: e });
      }
    }
    const err = parseErrorBody(text);
    const retryRaw = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
    const retry = retryRaw === null || retryRaw === undefined || String(retryRaw).trim() === '' ? NaN : Number(retryRaw);
    if (resp.status === 401 && onUnauthorized) {
      try {
        onUnauthorized();
      } catch {
        /* a failing hook must not mask the error */
      }
    }
    throw new ApiError(kindForStatus(resp.status), {
      ...info,
      status: resp.status,
      code: err.code,
      field: err.field,
      message: err.message || undefined,
      retryAfter: Number.isFinite(retry) && retry >= 0 ? retry : null,
    });
  }

  const dry = (opts) => {
    const { dryRun, ...rest } = opts || {};
    return dryRun ? { ...rest, query: { ...(rest.query || {}), dryRun: 1 } } : rest;
  };

  async function putGrant({ owner, collection, grantee, level }, opts) {
    if (!GRANT_LEVELS.includes(level)) throw new TypeError('level must be none, read or readwrite');
    for (const [k, v] of Object.entries({ owner, collection, grantee })) {
      if (typeof v !== 'string' || !v) throw new TypeError(`${k} is required`);
    }
    return request('PUT', 'grants', { ...dry(opts), body: { owner, collection, grantee, level } });
  }

  const enc = (login) => encodeURIComponent(assertLogin(login));

  return {
    apiBase,
    request,
    get: (rel, opts) => request('GET', rel, opts),
    post: (rel, body, opts) => request('POST', rel, { ...opts, body }),
    put: (rel, body, opts) => request('PUT', rel, { ...opts, body }),
    patch: (rel, body, opts) => request('PATCH', rel, { ...opts, body }),
    del: (rel, body, opts) => request('DELETE', rel, { ...opts, body }),
    async me(opts) {
      return normalizeMe(await request('GET', 'me', opts));
    },
    async meAccess(opts) {
      return normalizeAccess(await request('GET', 'me/access', opts));
    },
    /**
     * `GET grants?owner=&grantee=`: the grants on collections owned by `owner` (a non-admin may only
     * ask for their own login; without `owner` the service answers for the caller).
     */
    async grants({ owner, grantee } = {}, opts) {
      return normalizeGrants(await request('GET', 'grants', { ...opts, query: { owner, grantee } }));
    },
    /**
     * `PUT grants {owner, collection, grantee, level}` (idempotent; `level: 'none'` revokes; `{dryRun: true}`
     * plans without writing). Resolves with the service's raw answer `{grant, generation, active, warning?}`.
     */
    putGrant,
    /** Revoke one grant (`PUT grants` with level none). */
    revokeGrant: ({ owner, collection, grantee }, opts) => putGrant({ owner, collection, grantee, level: 'none' }, opts),
    // ---- admin endpoints (the service refuses them for non-admins with 403). Mutating calls take
    // `{dryRun: true}` and answer with normalizeMutation(). Passwords travel only in request bodies.
    /** `GET directory`: enabled accounts, [{login, displayName, type}]. */
    async directory(opts) {
      return normalizeDirectory(await request('GET', 'directory', opts));
    },
    /** `GET accounts`. */
    async accounts(opts) {
      return normalizeAccounts(await request('GET', 'accounts', opts));
    },
    /** `GET accounts/{login}`. */
    async account(login, opts) {
      return normalizeAccountRecord(await request('GET', `accounts/${enc(login)}`, opts));
    },
    /** `POST accounts` `{login, displayName, type?, admin?, ownSpace?, password | generate: true}`. */
    async createAccount(body, opts) {
      const b = pick(body, ['login', 'displayName', 'type', 'admin', 'ownSpace', 'password', 'generate']);
      assertLogin(b.login);
      return normalizeMutation(await request('POST', 'accounts', { ...dry(opts), body: b }));
    },
    /** `PATCH accounts/{login}` with any of displayName, type, admin, ownSpace, disabled, confirm. */
    async patchAccount(login, body, opts) {
      const b = pick(body, ['displayName', 'type', 'admin', 'ownSpace', 'disabled', 'confirm']);
      return normalizeMutation(await request('PATCH', `accounts/${enc(login)}`, { ...dry(opts), body: b }));
    },
    /** `POST accounts/{login}/password` with `{password}` or `{generate: true}`. */
    async resetPassword(login, body, opts) {
      const b = pick(body, ['password', 'generate']);
      return normalizeMutation(await request('POST', `accounts/${enc(login)}/password`, { ...dry(opts), body: b }));
    },
    /** `DELETE accounts/{login}` with `{confirm: "<login>"}`. */
    async deleteAccount(login, confirm, opts) {
      if (typeof confirm !== 'string' || !confirm) throw new TypeError('confirm is required');
      return normalizeMutation(await request('DELETE', `accounts/${enc(login)}`, { ...dry(opts), body: { confirm } }));
    },
    /** `GET effective/{login}`: [{path, level, letters}] as Radicale's own rights engine sees them. */
    async effective(login, opts) {
      return normalizeEffective(await request('GET', `effective/${enc(login)}`, opts));
    },
  };
}

// ---------------------------------------------------------------- login

/** Why a sign-in attempt failed. `reason`: 'bad-credentials' | 'rate-limited' | 'unavailable'. */
export class LoginError extends Error {
  constructor(reason, { cause, retryAfter = null } = {}) {
    super(`login failed: ${reason}`);
    this.name = 'LoginError';
    this.reason = reason;
    this.retryAfter = retryAfter;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Check a candidate credential. `api` and `dav` must send the candidate header
 * (their getAuth returns it); nothing is stored here.
 *
 * 1. Ask the account service (`me`). A 401 means wrong credentials, a 429
 *    means rate-limited: both stop here.
 * 2. Any other failure (network, 404, 502, 503, ...) means the account service
 *    is not there: fall back to a DAV principal lookup. A 401 there means wrong
 *    credentials; any other failure means the server is unavailable.
 *
 * @param {{api: {me(): Promise<object>}, dav: {principal(): Promise<string>}}} deps
 * @returns {Promise<{via: 'backend'|'dav', limited: boolean, me: object|null, principal: string|null, fallbackReason: string|null}>}
 */
export async function attemptLogin({ api, dav }) {
  let backendError = null;
  try {
    const me = await api.me();
    return { via: 'backend', limited: false, me, principal: null, fallbackReason: null };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.kind === 'auth') throw new LoginError('bad-credentials', { cause: e });
    if (e.kind === 'ratelimited') throw new LoginError('rate-limited', { cause: e, retryAfter: e.retryAfter });
    backendError = e;
  }
  try {
    const principal = await dav.principal();
    return { via: 'dav', limited: true, me: null, principal, fallbackReason: backendError.kind };
  } catch (e) {
    if (e && e.name === 'DavError' && e.kind === 'auth') throw new LoginError('bad-credentials', { cause: e });
    throw new LoginError('unavailable', { cause: e });
  }
}
