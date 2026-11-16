// SPDX-License-Identifier: AGPL-3.0-or-later
// Collection synchronisation as a pure state machine.
//
// syncStep(client, state) performs one synchronisation of one collection and
// returns the new state plus what changed. It never mutates its input, owns no
// timers and holds no hidden state: the caller decides when to call it (on
// focus, every 60 s, after a write) and keeps the returned state.
//
// Strategy:
//   1. sync-collection (RFC 6578) with the stored token (empty token for the
//      first run). Changed hrefs are fetched with multiget; removals come from
//      404 entries, or, after a full listing, from hrefs no longer present.
//   2. Decision D5, applied to every 403 body:
//        - DAV:valid-sync-token  -> drop the token and resync once with an
//          empty token; if that fails again, fall back to step 3 for this run;
//        - any other 403          -> access lost: status 'inaccessible' and
//          signals.refetchAccess (the caller reloads the backend's me/access).
//   3. Fallback (no sync support, or invalid token twice): compare the
//      collection's getctag; if it changed (or is not offered) list the ETags,
//      diff against the known ones and multiget the differences.

import { NS } from './xml.js';
import { DavError } from './http.js';

/** Fresh state for a collection ({href, kind: 'calendar'|'addressbook'}). */
export function createSyncState({ href, kind }) {
  if (kind !== 'calendar' && kind !== 'addressbook') throw new TypeError('kind must be calendar or addressbook');
  return { href, kind, status: 'ok', mode: 'sync', token: null, ctag: null, etags: {} };
}

/** Clear an 'inaccessible'/'missing' status (after the access list was refetched and the collection is back). */
export function resetStatus(state) {
  return { ...state, status: 'ok', token: null, ctag: null };
}

function classify(e) {
  if (!(e instanceof DavError)) return { type: 'fatal' };
  if (e.kind === 'auth') return { type: 'fatal' };
  if (e.kind === 'forbidden') return e.hasCondition(NS.DAV, 'valid-sync-token') ? { type: 'invalid-token' } : { type: 'inaccessible' };
  if (e.kind === 'notfound') return { type: 'missing' };
  if (e.kind === 'invalid' || (e.kind === 'server' && e.status === 501)) return { type: 'unsupported' };
  return { type: 'fatal' };
}

function lost(state, type) {
  const next = { ...state, status: type === 'missing' ? 'missing' : 'inaccessible' };
  return {
    state: next,
    upserted: [],
    removed: [],
    via: 'none',
    signals: { refetchAccess: true, inaccessible: type === 'inaccessible', missing: type === 'missing', tokenReset: false, fellBack: false },
  };
}

/**
 * One synchronisation step.
 * @returns {Promise<{
 *   state: object,
 *   upserted: {href: string, etag: string|null, text: string}[],
 *   removed: string[],
 *   via: 'sync'|'resync'|'ctag'|'etag-list'|'none',
 *   signals: {refetchAccess: boolean, inaccessible: boolean, missing: boolean, tokenReset: boolean, fellBack: boolean}
 * }>}
 * Network and server errors reject and leave the caller's state untouched;
 * a 401 rejects as well (the session is invalid).
 */
export async function syncStep(client, state) {
  if (state.status !== 'ok') {
    return { state, upserted: [], removed: [], via: 'none', signals: { refetchAccess: false, inaccessible: state.status === 'inaccessible', missing: state.status === 'missing', tokenReset: false, fellBack: false } };
  }
  const known = state.etags;
  const signals = { refetchAccess: false, inaccessible: false, missing: false, tokenReset: false, fellBack: false };
  const multiget = state.kind === 'calendar' ? client.calendarMultiget.bind(client) : client.addressbookMultiget.bind(client);

  let mode = state.mode;
  let token = state.token;
  let nextCtag = state.ctag;
  let listing = null; // {changedHrefs, removedHrefs, token?}
  let via = 'none';

  if (mode === 'sync') {
    let resynced = false;
    for (;;) {
      try {
        const sent = token || '';
        const res = await client.syncCollection(state.href, sent);
        const full = !sent;
        const listed = new Set();
        const changedHrefs = [];
        for (const c of res.changed) {
          listed.add(c.href);
          if (known[c.href] === undefined || known[c.href] !== c.etag) changedHrefs.push(c.href);
        }
        const removedHrefs = full
          ? Object.keys(known).filter((h) => !listed.has(h))
          : res.removed;
        listing = { changedHrefs, removedHrefs, token: res.token };
        nextCtag = null;
        via = resynced ? 'resync' : 'sync';
        break;
      } catch (e) {
        const c = classify(e);
        if (c.type === 'invalid-token') {
          if (!resynced) {
            resynced = true;
            if (token) signals.tokenReset = true;
            token = null;
            continue;
          }
          signals.fellBack = true;
          break;
        }
        if (c.type === 'unsupported') {
          mode = 'ctag';
          signals.fellBack = true;
          break;
        }
        if (c.type === 'inaccessible' || c.type === 'missing') return lost({ ...state, token: null }, c.type);
        throw e;
      }
    }
  }

  if (!listing) {
    // ctag, then ETag listing
    let coll;
    try {
      coll = await client.getCollection(state.href);
    } catch (e) {
      const c = classify(e);
      if (c.type === 'inaccessible' || c.type === 'missing') return lost({ ...state, token: null }, c.type);
      throw e;
    }
    if (state.ctag && coll.ctag && coll.ctag === state.ctag && Object.keys(known).length) {
      return { state: { ...state, mode, token: null }, upserted: [], removed: [], via: 'ctag', signals };
    }
    let list;
    try {
      list = await client.listItemEtags(state.href);
    } catch (e) {
      const c = classify(e);
      if (c.type === 'inaccessible' || c.type === 'missing') return lost({ ...state, token: null }, c.type);
      throw e;
    }
    const listed = new Set(list.map((i) => i.href));
    listing = {
      changedHrefs: list.filter((i) => known[i.href] === undefined || known[i.href] !== i.etag).map((i) => i.href),
      removedHrefs: Object.keys(known).filter((h) => !listed.has(h)),
      token: null,
    };
    nextCtag = coll.ctag || null;
    via = 'etag-list';
  }

  // fetch the changed items
  const etags = { ...known };
  const upserted = [];
  const removed = new Set(listing.removedHrefs);
  if (listing.changedHrefs.length) {
    let got;
    try {
      got = await multiget(state.href, listing.changedHrefs);
    } catch (e) {
      const c = classify(e);
      if (c.type === 'inaccessible' || c.type === 'missing') return lost({ ...state, token: null }, c.type);
      throw e;
    }
    for (const it of got.items) {
      upserted.push(it);
      etags[it.href] = it.etag;
    }
    for (const h of got.missing) removed.add(h);
  }
  for (const h of removed) delete etags[h];

  return {
    state: { ...state, mode, status: 'ok', token: listing.token || null, ctag: nextCtag, etags },
    upserted,
    removed: [...removed],
    via,
    signals,
  };
}
