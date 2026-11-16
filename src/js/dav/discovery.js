// SPDX-License-Identifier: AGPL-3.0-or-later
// Discovery of everything the logged-in user can reach: the collections in the
// user's own home plus the collections granted by other accounts.
//
// Radicale does not list other accounts' collections, so grants come from the
// admin backend (api.meAccess(), injected by the caller). The backend being
// down or absent never hides the user's own collections.

import { DavError } from './http.js';
import { childHref } from './client.js';

const GRANT_PARALLELISM = 4;

function grantsOf(access) {
  if (Array.isArray(access)) return access;
  if (access && Array.isArray(access.grants)) return access.grants;
  return [];
}

function ownerOf(href) {
  const seg = href.split('/').filter(Boolean)[0];
  try {
    return seg ? decodeURIComponent(seg) : null;
  } catch {
    return seg || null;
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/**
 * Merge own and granted collections.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {{meAccess?: () => Promise<object|object[]>}|null} [api]
 * @returns {Promise<{
 *   collections: object[],
 *   apiError: Error|null,
 *   ownError: Error|null,
 * }>}
 *   Every entry has source ('own'|'grant'), status ('ok'|'missing'|'inaccessible'|'error'),
 *   owner and href; status 'ok' entries carry the full collection descriptor,
 *   grant entries also carry `grant` (the backend's record) and `level`.
 *   A 401 from Radicale is not swallowed: it rejects (the session is invalid).
 */
export async function discoverAccessible(client, api) {
  const transport = client.transport;
  const collections = [];
  const byHref = new Map();
  let ownError = null;
  let apiError = null;

  // own collections
  try {
    const { calendarHomes, addressbookHomes } = await client.homeSets();
    for (const home of new Set([...calendarHomes, ...addressbookHomes])) {
      for (const c of await client.listCollections(home)) {
        if (byHref.has(c.href)) continue;
        const entry = { ...c, source: 'own', status: 'ok', owner: ownerOf(c.href) };
        byHref.set(c.href, entry);
        collections.push(entry);
      }
    }
  } catch (e) {
    if (e instanceof DavError && e.kind === 'auth') throw e;
    ownError = e;
  }

  // grants from the backend
  let grants = [];
  if (api && typeof api.meAccess === 'function') {
    try {
      grants = grantsOf(await api.meAccess());
    } catch (e) {
      apiError = e;
    }
  }
  const pending = [];
  for (const g of grants) {
    if (!g || typeof g !== 'object') continue;
    let href;
    try {
      href = g.href
        ? transport.normalize(g.href)
        : childHref(childHref(transport.basePath, String(g.owner), { collection: true }), String(g.collection), { collection: true });
    } catch {
      continue; // a malformed grant record is ignored, never followed
    }
    if (!href.endsWith('/')) href += '/';
    if (byHref.has(href)) continue; // already listed as own
    const placeholder = { href, source: 'grant', status: 'error', owner: g.owner || ownerOf(href), level: g.level || null, grant: g };
    byHref.set(href, placeholder);
    pending.push(placeholder);
  }
  await pool(pending, GRANT_PARALLELISM, async (entry) => {
    try {
      const c = await client.getCollection(entry.href);
      Object.assign(entry, c, { status: 'ok' });
    } catch (e) {
      if (!(e instanceof DavError)) throw e;
      if (e.kind === 'auth') throw e;
      if (e.kind === 'notfound') entry.status = 'missing';
      else if (e.kind === 'forbidden') entry.status = 'inaccessible';
      else {
        entry.status = 'error';
        entry.error = { kind: e.kind, status: e.status };
      }
    }
  });
  for (const entry of pending) collections.push(entry);
  return { collections, apiError, ownError };
}
