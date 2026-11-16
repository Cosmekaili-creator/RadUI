// SPDX-License-Identifier: AGPL-3.0-or-later
// Grant revocation helpers for the account service (addendum B4, D-R2-18).
//
//  - the grant list is ALWAYS re-read just before revoking (never the summary taken when a dialog
//    opened);
//  - revocation is sequential (the proxy rate-limits the service) and honours Retry-After on 429;
//  - after the loop the list is read once more: a grant that is still there is reported as failed,
//    whatever the individual answers said (an idempotent 422 for a grant that is already gone is
//    therefore not a failure);
//  - names the service refuses to handle (`unsupported_collection_name`) are flagged `unrevokable`.
//
// No DOM, no timers of its own: `sleep(ms)` is injected; if it rejects (the session ended) the loop stops and
// the result carries `aborted: true`.

import { classify } from './errors.js';

const MAX_RETRY_WAIT_S = 60;

/** Grants on one collection of `owner`, read fresh from the service. */
export async function grantsOn(api, owner, collection) {
  const all = await api.grants({ owner });
  return all.filter((g) => g.owner === owner && g.collection === collection && g.level);
}

/**
 * Revoke every grant on `owner/collection`.
 * @param {object} o
 * @param {{grants: Function, putGrant: Function}} o.api
 * @param {string} o.owner
 * @param {string} o.collection technical name (last path segment)
 * @param {(ms: number) => Promise<void>} o.sleep
 * @param {number} [o.maxAttempts] per grant, counting 429 retries
 * @param {(ev: object) => void} [o.onEvent] {grantee, ok, kind?, attempt}
 * @returns {Promise<{ok: boolean, listed: number, revoked: string[], failed: {grantee: string, kind: string, code: string|null, unrevokable: boolean}[], listError: object|null, unverified: boolean}>}
 */
export async function revokeGrants({ api, owner, collection, sleep, maxAttempts = 3, onEvent = () => {} }) {
  let list;
  try {
    list = await grantsOn(api, owner, collection);
  } catch (e) {
    const c = classify(e);
    return { ok: false, listed: 0, revoked: [], failed: [], listError: { kind: c.kind, status: c.status, code: c.code }, unverified: true };
  }
  if (!list.length) return { ok: true, listed: 0, revoked: [], failed: [], listError: null, unverified: false };
  const revoked = [];
  const errors = new Map();
  let aborted = false;
  outer: for (const g of list) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await api.putGrant({ owner, collection, grantee: g.grantee, level: 'none' });
        revoked.push(g.grantee);
        errors.delete(g.grantee);
        onEvent({ grantee: g.grantee, ok: true, attempt });
        break;
      } catch (e) {
        const c = classify(e);
        errors.set(g.grantee, c);
        onEvent({ grantee: g.grantee, ok: false, kind: c.kind, attempt });
        if (c.kind === 'ratelimited' && attempt < maxAttempts) {
          const s = Math.min(MAX_RETRY_WAIT_S, Math.max(0, c.retryAfter ?? 1));
          try {
            await sleep(s * 1000);
          } catch {
            aborted = true; // the session ended while waiting: stop at once, send nothing more
            break outer;
          }
          continue;
        }
        break;
      }
    }
  }
  if (aborted) return { ok: false, aborted: true, listed: list.length, revoked, failed: [], listError: null, unverified: true };
  // Confirm with a fresh read: what is still listed is what failed.
  let remaining = null;
  let unverified = false;
  try {
    remaining = new Set((await grantsOn(api, owner, collection)).map((g) => g.grantee));
  } catch {
    unverified = true;
  }
  const failedNames = remaining ? [...remaining] : [...errors.keys()];
  const failed = failedNames.map((grantee) => {
    const c = errors.get(grantee);
    return { grantee, kind: c ? c.kind : 'unknown', code: c ? c.code : null, unrevokable: Boolean(c && c.code === 'unsupported_collection_name') };
  });
  return { ok: failed.length === 0 && !unverified, listed: list.length, revoked, failed, listError: null, unverified };
}
