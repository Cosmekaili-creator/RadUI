// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers of the Users screens (no DOM, no network): login and password checks that mirror the account
// service (names.py, passwords.py; the service stays authoritative), the three access levels, the matrix model
// (rows = collections, columns = enabled non-admin accounts, capped), the lock-out guards of the account view and
// the reading of `GET effective`. Everything that comes from the server is only ever treated as text.

export const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
/** Logins the service refuses (names.py RESERVED_LOGINS), plus the `radui-` prefix. */
export const RESERVED_LOGINS = Object.freeze(['root', 'admin', 'administrator', 'radicale', 'radui', 'ui', 'api', 'web', 'sharing', 'token', 'anonymous', 'nobody', 'system']);
export const RESERVED_PREFIX = 'radui-';
export const MAX_DISPLAY_NAME = 64;
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD_BYTES = 72;
/** Rows are columns of the matrix; more than this many accounts need the filter (Q-R3-11). */
export const MATRIX_MAX_COLUMNS = 12;

/** The three levels of the rights model, as the account service names them. */
export const LEVELS = Object.freeze(['none', 'read', 'readwrite']);
/** Test-id suffix of an option: `perm-option-none|r|rw`. */
export const LEVEL_OPTION_ID = Object.freeze({ none: 'none', read: 'r', readwrite: 'rw' });

/** Error code for a login, or null. The input is compared as typed after lower-casing (the form lower-cases it). */
export function checkLogin(raw) {
  const v = String(raw ?? '');
  if (v === '') return 'required';
  if (!LOGIN_RE.test(v)) return 'pattern';
  if (RESERVED_LOGINS.includes(v) || v.startsWith(RESERVED_PREFIX)) return 'reserved';
  return null;
}

const hasHidden = (s) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s);

/** Error code for a display name, or null. */
export function checkDisplayName(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return 'required';
  if ([...v].length > MAX_DISPLAY_NAME) return 'long';
  if (hasHidden(v)) return 'control';
  return null;
}

/** Strength 0..4 of a typed password (a hint only: the service decides). */
export function strength(pw, login = '') {
  const s = String(pw ?? '');
  let score = 0;
  if (s.length >= 12) score++;
  if (s.length >= 16) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) score++;
  if (/[^A-Za-z0-9]/.test(s)) score++;
  if (s.length < 12) score = Math.min(score, 1);
  if (login && login.length > 2 && s.toLowerCase().includes(String(login).toLowerCase())) score = Math.min(score, 1);
  if (/^(.)\1+$/.test(s) || /^(password|motdepasse|123456|azerty|qwerty)/i.test(s)) score = 0;
  return score;
}

/** Error code for a typed password (the rules of passwords.py that can be checked here), or null. */
export function checkPassword(pw, login = '', encoder = new TextEncoder()) {
  const s = String(pw ?? '');
  if (s === '') return 'required';
  const bytes = encoder.encode(s).length;
  if (bytes < MIN_PASSWORD) return 'short';
  if (bytes > MAX_PASSWORD_BYTES) return 'long';
  if (login && s.toLowerCase().includes(String(login).toLowerCase())) return 'login';
  const classes = new Set([...s].map((c) => (/[a-z]/.test(c) ? 'l' : /[A-Z]/.test(c) ? 'u' : /\d/.test(c) ? 'd' : 'o'))).size;
  if ([...s].length < 16 && classes < 3) return 'weak';
  return null;
}

// ------------------------------------------------------------------ hrefs and grants

/** `/alice/cal/` -> 'alice' (first path segment, decoded). */
export function ownerOfHref(href) {
  const seg = String(href || '').split('/').filter(Boolean)[0] || '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** `/alice/cal/` -> 'cal' (last path segment, decoded). */
export function nameOfHref(href) {
  const segs = String(href || '').split('/').filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The `owner/name` path text of a collection. */
export const pathOf = (owner, name) => `${owner}/${name}`;

/** Same collection href ignoring a trailing slash and case-insensitive owner segment. */
export function sameHref(a, b) {
  const norm = (h) => String(h || '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** Level a grantee holds on `owner/collection` according to the grant list. */
export function levelOf(grants, owner, collection, grantee) {
  const g = (grants || []).find((x) => x.owner === owner && x.collection === collection && x.grantee === grantee);
  return g && (g.level === 'read' || g.level === 'readwrite') ? g.level : 'none';
}

/** Accept the URL spellings `r` / `rw` next to the service's names; null for anything else. */
export function parseLevel(value) {
  const v = String(value ?? '').toLowerCase();
  if (v === 'none' || v === 'read' || v === 'readwrite') return v;
  if (v === 'r') return 'read';
  if (v === 'rw') return 'readwrite';
  return null;
}

// ------------------------------------------------------------------ accounts

export const adminCount = (accounts) => (accounts || []).filter((a) => a.admin && !a.disabled).length;

/**
 * Lock-out guards of the account view. The service refuses these changes too (`lockout_self`,
 * `lockout_last_admin`); the page disables the buttons and says why instead of letting the person hit the error.
 * @returns {{self: boolean, lastAdmin: boolean, locked: boolean, reason: 'self'|'lastAdmin'|null}}
 */
export function guardFor(account, accounts, myLogin) {
  const self = Boolean(account) && account.login === myLogin;
  const lastAdmin = Boolean(account) && account.admin === true && !account.disabled && adminCount(accounts) <= 1;
  return { self, lastAdmin, locked: self || lastAdmin, reason: self ? 'self' : lastAdmin ? 'lastAdmin' : null };
}

/** `2 accounts` summary data: {total, disabled}. */
export function countAccounts(accounts) {
  const list = accounts || [];
  return { total: list.length, disabled: list.filter((a) => a.disabled).length };
}

const foldText = (s) => String(s ?? '').normalize('NFC').toLowerCase();

/** Accounts whose login or display name contains `q` (case-insensitive); an empty query keeps all. */
export function filterAccounts(accounts, q) {
  const needle = foldText(q).trim();
  if (!needle) return (accounts || []).slice();
  return (accounts || []).filter((a) => foldText(a.login).includes(needle) || foldText(a.displayName).includes(needle));
}

// ------------------------------------------------------------------ matrix

/**
 * The permission matrix: rows are the collections of every enabled account (owner/name, sorted), columns the
 * enabled non-admin accounts. At most `cap` columns are visible; `filter` narrows the columns first.
 * @returns {{rows: object[], columns: object[], totalColumns: number, hiddenColumns: number}}
 */
export function buildMatrix({ accounts, collectionsByOwner, filter = '', cap = MATRIX_MAX_COLUMNS } = {}) {
  const eligible = (accounts || []).filter((a) => !a.disabled && !a.admin).sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
  const matching = filterAccounts(eligible, filter);
  const columns = matching.slice(0, cap);
  const rows = [];
  for (const owner of Object.keys(collectionsByOwner || {}).sort()) {
    for (const c of collectionsByOwner[owner] || []) {
      const name = nameOfHref(c.href);
      rows.push({ owner, name, href: c.href, kind: c.kind, displayName: c.displayName || '', color: c.color || null, path: pathOf(owner, name) });
    }
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { rows, columns, totalColumns: eligible.length, matchingColumns: matching.length, hiddenColumns: matching.length - columns.length };
}

// ------------------------------------------------------------------ effective access

const WHY = Object.freeze({ own: 'owner', 'grant-r': 'grant', 'grant-rw': 'grant', admin: 'admin', principal: 'principal', 'principal-ro': 'principal', root: 'root', none: 'none' });
const SHOWN_LEVELS = new Set(['own', 'grant-r', 'grant-rw', 'admin', 'none']);

/**
 * Rows of `GET effective/{login}` worth showing: own space, grants, admin reach and "none". The root, the principal
 * folders and the service's own probe path are left out (they say nothing about collections).
 * @returns {{path: string, level: string, why: string, canView: boolean, canChange: boolean}[]}
 */
export function effectiveRows(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r.path !== 'string') continue;
    if (!SHOWN_LEVELS.has(r.level)) continue;
    if (r.path === '/' || /radui-probe/.test(r.path)) continue;
    const letters = String(r.letters || '');
    out.push({ path: r.path, level: r.level, why: WHY[r.level] || 'none', canView: letters.includes('r'), canChange: letters.includes('w') });
  }
  return out;
}

/** Number of effective rows that give at least read access. */
export const reachableCount = (rows) => effectiveRows(rows).filter((r) => r.canView).length;

// ------------------------------------------------------------------ sorting and formatting

/** Date text of an ISO timestamp (medium date in the page language); '' when missing or invalid. */
export function dateText(iso, lang = 'en') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  } catch {
    return String(iso).slice(0, 10);
  }
}

/** A display label for the one-time dialog and messages: the login. */
export const labelOfAccount = (a) => (a && a.login) || '';
