// SPDX-License-Identifier: AGPL-3.0-or-later
// Classification of everything a store operation can throw, so that the write path
// and the sync code decide on ONE vocabulary. The classes are matched by name (not
// imported) so this module stays free of the data model and of ical.js.
//
// kinds: auth, forbidden, notfound, toolarge, precondition (412), conflict (409),
//        network (also timeouts), server (5xx), ratelimited (429), fidelity,
//        readonly, field (an invalid patch), invalid, unknown

const DAV_KINDS = {
  auth: 'auth',
  forbidden: 'forbidden',
  notfound: 'notfound',
  precondition: 'precondition',
  conflict: 'conflict',
  toolarge: 'toolarge',
  network: 'network',
  server: 'server',
  invalid: 'invalid',
};

const API_KINDS = {
  auth: 'auth',
  forbidden: 'forbidden',
  notfound: 'notfound',
  conflict: 'conflict',
  toolarge: 'toolarge',
  ratelimited: 'ratelimited',
  unavailable: 'server',
  server: 'server',
  network: 'network',
  badrequest: 'invalid',
  validation: 'invalid',
  invalid: 'invalid',
};

/**
 * @returns {{kind: string, status: number|null, code: string|null, retryAfter: number|null, message: string}}
 */
export function classify(e) {
  const name = e && e.name;
  const base = { status: (e && e.status) || null, code: (e && e.code) || null, retryAfter: null, message: e && e.message ? String(e.message) : '' };
  if (name === 'ConflictError') return { ...base, kind: 'precondition' };
  if (name === 'DavError') return { ...base, kind: DAV_KINDS[e.kind] || 'unknown' };
  if (name === 'ApiError') return { ...base, kind: API_KINDS[e.kind] || 'unknown', retryAfter: e.retryAfter ?? null };
  if (name === 'FidelityError') return { ...base, kind: 'fidelity', problems: e.problems || [] };
  if (name === 'ReadOnlyError') return { ...base, kind: 'readonly', reason: e.reason || null };
  if (name === 'FieldError' || name === 'ValueError' || name === 'SeriesError') return { ...base, kind: 'field' };
  if (name === 'LoginError') return { ...base, kind: 'auth' };
  return { ...base, kind: 'unknown' };
}

/** The `err.dav.*` dictionary key for an error class. */
export function davErrorKey(kind) {
  switch (kind) {
    case 'auth':
      return 'err.dav.auth';
    case 'forbidden':
      return 'err.dav.forbidden';
    case 'notfound':
      return 'err.dav.notfound';
    case 'toolarge':
      return 'err.dav.toolarge';
    case 'network':
      return 'err.dav.network';
    case 'server':
      return 'err.dav.server';
    default:
      return 'err.dav.unknown';
  }
}

/** True for errors after which the outcome of a write is not known (the request may have been applied). */
export const isResultUnknown = (kind) => kind === 'network' || kind === 'server';

/** Last path segment of an href, decoded (for Activity targets and file names). */
export function leafOf(href) {
  const segs = String(href || '').split('/').filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
