// SPDX-License-Identifier: AGPL-3.0-or-later
// THE ONLY WRITE PATH. Views and the contacts layer never call a DAV write method (PUT, DELETE,
// MKCOL, MKCALENDAR, PROPPATCH); a unit test scans them for it. Every write goes through here:
//
//   write gate (offline / read-only) -> level check -> a FRESH openItem(text) for this attempt (M2: no
//   Item is ever reused, so a failed write cannot leave unsent edits behind) -> item.update(patch) ->
//   item.save() (writer + fidelity guard, or checkNewItem for new items) -> {changed:false} sends NO
//   request -> PUT with If-Match / If-None-Match -> re-GET -> write verification (M8) -> store update
//   -> Activity line -> status text.
//
// Nothing here throws for an expected failure: every function resolves with a result
//   {ok: boolean, status: string, ...}  (`message` is the text that was shown to the user).
// ok statuses:   saved, created, deleted, unchanged, reloaded, copied, already-deleted, moved
// failure statuses: blocked, readonly, forbidden, notfound, deleted-elsewhere, conflict, changed-elsewhere,
//   toolarge, auth, unknown-result, server-error, fidelity, invalid, no-uid, nickname-loss, needs-confirmation,
//   exists, orphan-grants, grants-unchecked, changed, not-allowed, error,
//   split-incomplete (both halves of a split exist), move-incomplete (the copy and the original both exist),
//   tail-mismatch, copy-mismatch, copy-unverified.
//
// Events and tasks (RUN3 D-R3-5): applyOps (operation lists, replayed on theirs after a 412), splitWrite ("this and
// following": tail first, then the truncated original, compensation only when that PUT is known not applied),
// moveItem (copy the exact text, verify, then delete the source). See store/calops.js for the operations.
//
// A `patch` is a plain object (keys of Item.fields()) or a function `(fields) => patch` that is called
// with the fields of the FRESH item of each attempt. Entries that name an existing row carry the `prop` of
// the item they were read from: pass `baseFields` (the fields they came from) so the rows can be mapped to
// the fresh item, or - simpler - pass a builder function.

import { childHref } from '../dav/client.js';
import { newUuid } from '../uuid.js';
import { canSaveAsCopy, diffOwned, rebaseMembership, rebasePatch } from '../model/conflict.js';
import { memberMatches, memberUri, pickGroupForm, pickNewCardVersion } from '../model/vcard.js';
import { applyOpsToItem, checkOps, isRecurring, needsEventLib, occurrencesOfOps, opNameOf } from './calops.js';
import { classify, isResultUnknown, leafOf } from './errors.js';
import { revokeGrants } from './grants.js';
import { createReporter } from './report.js';
import { TOUCH_ALL, diffCalendarProjections, keysOfPatch, lostNicknames, occurrenceKey, projectCalendarItem, touchedOfOps, verifyCalendar, verifyContact } from './verify.js';

const NAME_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9._@~+-]{0,126}[A-Za-z0-9._@+-])?$/;
const RESERVED_PREFIX = 'radui-gen-';
const LIST_KEYS = ['tel', 'email', 'adr', 'url'];

/** Technical collection name check, mirroring the backend (names.py) plus the reserved prefix. Returns an error code or null. */
export function validateCollectionName(name) {
  if (typeof name !== 'string' || !name) return 'empty';
  if (name.toLowerCase().startsWith(RESERVED_PREFIX)) return 'reserved';
  if (!NAME_RE.test(name)) return 'pattern';
  return null;
}

class Refusal extends Error {
  constructor(status, reason) {
    super(`${status}: ${reason}`);
    this.name = 'Refusal';
    this.status = status;
    this.reason = reason;
  }
}

const withSlash = (h) => (h.endsWith('/') ? h : h + '/');
const unfoldText = (t) => String(t).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
const GROUP_RE = /^(?:[A-Za-z0-9-]+\.)?(?:X-ADDRESSBOOKSERVER-)?KIND(?:;[^:]*)?:\s*group\s*$/im;
export const isGroupText = (t) => GROUP_RE.test(unfoldText(t));
const uidOfText = (t) => {
  const m = /^(?:[A-Za-z0-9-]+\.)?UID(?:;[^:]*)?:(.*)$/im.exec(unfoldText(t));
  return m ? m[1].trim() : null;
};
const memberValues = (t) => [...unfoldText(t).matchAll(/^(?:[A-Za-z0-9-]+\.)?(?:X-ADDRESSBOOKSERVER-)?MEMBER(?:;[^:]*)?:(.*)$/gim)].map((m) => m[1].trim());

const rowSig = (key, e) => JSON.stringify([key === 'adr' ? e.value : String(e.value ?? ''), [...(e.types || [])].map((t) => String(t).toLowerCase()).sort(), Boolean(e.pref), e.label ?? null]);

/** Were `viewFields` read from the item whose fresh fields are `freshFields` (same UID, same rows)? */
function sameBase(viewFields, freshFields) {
  if ((viewFields.uid || null) !== (freshFields.uid || null)) return false;
  for (const key of LIST_KEYS) {
    const a = viewFields[key] || [];
    const b = freshFields[key] || [];
    if (a.length !== b.length || a.some((e, i) => rowSig(key, e) !== rowSig(key, b[i]))) return false;
  }
  return true;
}

/**
 * Re-map the rows of a patch (entries carrying the `prop` of the item they were read from) onto the fresh item's
 * rows. Refused (`base-mismatch`) unless `viewFields` were read from the very text the fresh item was opened from:
 * mapping rows by position between two different versions would write values onto the wrong rows.
 */
function remapPatch(patch, viewFields, freshFields) {
  if (!viewFields) return patch;
  if (!sameBase(viewFields, freshFields)) throw new Refusal('invalid', 'base-mismatch');
  const out = { ...patch };
  for (const key of LIST_KEYS) {
    if (!Array.isArray(patch[key])) continue;
    out[key] = patch[key].map((e) => {
      if (!e || !e.prop) return e;
      const i = (viewFields[key] || []).findIndex((v) => v.prop === e.prop);
      const target = i >= 0 ? (freshFields[key] || [])[i] : null;
      if (!target) throw new Refusal('invalid', 'entry-not-found');
      return { ...e, prop: target.prop };
    });
  }
  return out;
}

export function createWrites({
  client,
  api = null,
  stores,
  access = null,
  scheduler = null,
  reporter = createReporter(),
  gate = null,
  login = null,
  model = null,
  random = newUuid,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date(),
  isDisposed = () => false,
} = {}) {
  if (!client) throw new TypeError('createWrites needs the DAV client');
  if (!stores) throw new TypeError('createWrites needs the item stores');
  let modelPromise = model ? Promise.resolve(model) : null;
  const getModel = () => modelPromise || (modelPromise = import('../model/item.js'));
  let eventLibPromise = null;
  const getEventLib = () => eventLibPromise || (eventLibPromise = import('../model/event.js'));
  let fidelityPromise = null;
  const getFidelity = () => fidelityPromise || (fidelityPromise = import('../model/fidelity.js'));
  const readOnlyItems = new Map(); // href -> ETag refused by the fidelity guard: read-only until the item's ETag changes
  /** The session ended: a multi-step write stops before its next request (nothing is written into the next login's shell). */
  const aborted = (op, href, extra = {}) => {
    log(op, href, 'error', 'aborted: session ended');
    return { ok: false, status: 'aborted', message: '', href, ...extra };
  };
  const parentOf = (h) => h.slice(0, h.lastIndexOf('/') + 1);
  /** Is this version of the item flagged read-only? A different ETag (a fixed server version arrived) clears the flag. */
  function flagged(href, etag) {
    if (!readOnlyItems.has(href)) return false;
    const st = stores.get(parentOf(href));
    const cur = st ? st.get(href) : null;
    const recorded = readOnlyItems.get(href);
    if ((etag && etag !== recorded) || (cur && cur.etag !== recorded)) {
      readOnlyItems.delete(href);
      return false;
    }
    return true;
  }

  /** The owner of an href: the first segment AFTER the configured Radicale base path (`/radicale/alice/x/` -> alice). */
  const ownerOfHref = (h) => {
    let path = String(h || '');
    const base = (client.transport && client.transport.basePath) || '/';
    if (base !== '/' && path.startsWith(base)) path = path.slice(base.length);
    const seg = path.split('/').filter(Boolean)[0];
    try {
      return seg ? decodeURIComponent(seg).toLowerCase() : '';
    } catch {
      return '';
    }
  };
  const ownerLogin = () => String((access && access.me && access.me.login) || login || '').toLowerCase();

  // ------------------------------------------------------------ small helpers

  function collOf(c) {
    const href = withSlash(typeof c === 'string' ? c : c.href);
    const known = access ? access.get(href) : null;
    const st = stores.get(href);
    const kind = (typeof c === 'object' && c.kind) || (known && known.kind) || (st && st.kind) || null;
    return { href, kind, known, st };
  }
  const itemKind = (coll) => (coll.kind === 'addressbook' ? 'contact' : undefined);
  const ext = (coll) => (coll.kind === 'calendar' ? 'ics' : 'vcf');

  function say(status, ok, key, params, extra = {}, { alert = !ok, persistent = false } = {}) {
    const message = alert ? reporter.alert(key, params, { persistent }) : key ? reporter.status(key, params) : '';
    return { ok, status, message, ...extra };
  }

  /** Gate and level checks. Returns a refusal result or null. */
  function guard(coll, { manage = false } = {}) {
    if (gate && gate.blocked) {
      const reason = (gate.reasons && gate.reasons[0]) || 'offline';
      return say('blocked', false, reason === 'offline' ? 'store.err.offline' : 'store.err.readonly', undefined, { reason });
    }
    if (coll.known) {
      const allowed = manage ? coll.known.level === 'own' : coll.known.level === 'own' || coll.known.level === 'readwrite';
      if (!allowed) return say('readonly', false, 'store.err.noAccess', undefined, { reason: 'level', level: coll.known.level });
    }
    return null;
  }

  const log = (op, href, result, detail) => reporter.log(op, leafOf(href), result, detail);

  async function refreshAfterFailure(st) {
    if (!st) return;
    try {
      await st.refresh({ reason: 'write-failed' });
    } catch {
      /* best effort */
    }
  }

  /** A failure of a request (not a 412, which the callers handle). */
  async function remoteFailure(err, { op, href, coll, retry = null, gone = true }) {
    const c = classify(err);
    const st = coll && coll.st;
    const base = { href, kind: c.kind, httpStatus: c.status };
    switch (c.kind) {
      case 'auth':
        return { ok: false, status: 'auth', message: '', ...base };
      case 'forbidden':
        log(op, href, 'error', '403');
        if (access) await access.refetch({ reason: '403' });
        return say('forbidden', false, 'err.dav.forbidden', undefined, { ...base, level: access ? access.levelOf(coll.href) : null });
      case 'notfound':
        if (gone && st) {
          st.applyDelete(href);
          log(op, href, 'error', '404');
          return say('deleted-elsewhere', false, 'store.err.deletedElsewhere', undefined, base);
        }
        log(op, href, 'error', '404');
        return say('notfound', false, 'err.dav.notfound', undefined, base);
      case 'toolarge':
        log(op, href, 'error', '413');
        return say('toolarge', false, 'err.dav.toolarge', undefined, base);
      case 'network':
      case 'server':
        log(op, href, 'error', c.kind + (c.status ? ' ' + c.status : ''));
        await refreshAfterFailure(st);
        return say(c.kind === 'network' ? 'unknown-result' : 'server-error', false, c.kind === 'network' ? 'store.err.unknownResult' : 'store.err.serverReloaded', undefined, { ...base, ...(retry ? { retry } : {}) });
      default:
        log(op, href, 'error', c.kind + (c.status ? ' ' + c.status : ''));
        return say('error', false, 'err.dav.unknown', undefined, base);
    }
  }

  /** A failure before anything was sent (open, update, save). */
  function localFailure(e, { op, href, text, etag = null }) {
    const c = classify(e);
    if (e instanceof Refusal) {
      if (e.status === 'readonly') return say('readonly', false, 'store.err.readonly', undefined, { href, reason: e.reason });
      return say(e.status, false, 'store.err.invalid', { reason: e.reason }, { href, reason: e.reason });
    }
    if (c.kind === 'fidelity') {
      readOnlyItems.set(href, etag);
      const problems = c.problems || [];
      log(op, href, 'error', 'fidelity ' + problems.map((p) => p.code).join(','));
      return say('fidelity', false, 'err.fidelity', undefined, { href, problems, exportText: text || null });
    }
    if (c.kind === 'readonly') return say('readonly', false, 'store.err.readonly', undefined, { href, reason: c.reason });
    if (c.kind === 'field') return say('invalid', false, 'store.err.invalid', { reason: c.message }, { href, reason: c.message });
    throw e;
  }

  async function openFresh(coll, text, spec) {
    const m = await getModel();
    const r = m.openItem(text, itemKind(coll));
    if (!r.ok) throw new Refusal('readonly', r.reason);
    if (r.readOnly) throw new Refusal('readonly', r.readOnlyReason);
    const baseFields = r.fields();
    let patch = null;
    if (spec) patch = typeof spec.patch === 'function' ? spec.patch(baseFields) : remapPatch(spec.patch || {}, spec.baseFields, baseFields);
    return { item: r, baseFields, patch };
  }

  /** Re-read the item after a successful PUT, verify it, hand the server text to the store. */
  async function confirm({ coll, href, put, sentText, keys, op, accepted = [], touched = null }) {
    const st = coll.st;
    let got = null;
    try {
      got = await client.getItem(href);
    } catch {
      /* the write went through; a failed read-back (a 401 included) is reported below */
    }
    const result = { etag: (got && got.etag) || put.etag, text: got ? got.text : null, verified: null, mismatched: [] };
    if (!got) {
      log('verify', href, 'error', 'read-back failed');
      if (st) await refreshAfterFailure(st);
      return result;
    }
    if (st) st.applyWrite(href, { etag: result.etag, text: got.text });
    if (coll.kind === 'addressbook' || coll.kind === 'calendar') {
      const m = await getModel();
      let v;
      try {
        v = coll.kind === 'calendar' ? verifyCalendar(m, { sentText, gotText: got.text, touched: touched || TOUCH_ALL }) : verifyContact(m, { sentText, gotText: got.text, keys, acceptedNicknames: accepted });
      } catch {
        v = { ok: false, mismatched: [], unreadable: true };
      }
      result.verified = v.ok;
      result.mismatched = v.mismatched;
      if (!v.ok) {
        log('verify', href, 'error', v.unreadable ? 'unreadable' : v.mismatched.join(','));
        reporter.alert('store.err.verify', { name: leafOf(href), fields: v.unreadable ? '?' : v.mismatched.join(', ') }, { persistent: true });
      }
    }
    if (scheduler && st) scheduler.afterWrite(st);
    return result;
  }

  /** A card text that the server would damage (NICKNAME list): refuse unless the caller confirmed. */
  function nicknameGuard(coll, text, accept) {
    if (coll.kind !== 'addressbook') return null;
    const lost = lostNicknames(text);
    if (!lost.length || accept) return null;
    log('update', '', 'error', 'nickname-loss');
    return say('nickname-loss', false, 'store.err.nicknameLoss', { values: lost.join(', ') }, { lost });
  }

  /** The nickname values the caller accepted to lose for this text (verification must not report them). */
  const acceptedFor = (coll, text, accept) => (accept && coll.kind === 'addressbook' ? lostNicknames(text) : []);

  // ------------------------------------------------------------ conflicts

  function deletedElsewhere({ coll, href, base, spec }) {
    const st = coll.st;
    if (st) st.applyDelete(href);
    log('conflict', href, 'info', 'deleted elsewhere');
    return say('deleted-elsewhere', false, 'store.err.deletedElsewhere', undefined, {
      href,
      collection: coll.href,
      base: base ? { text: base.text, etag: base.etag } : null,
      mine: { patchSpec: spec ? spec.patch : null, baseFields: spec ? spec.baseFields : null },
      canCopy: Boolean(base && spec) && !isGroupText(base.text),
    });
  }

  /** Build the ConflictResult after a 412. `base` is the {text, etag} the edit started from. */
  async function conflictFor({ coll, href, base, spec }) {
    let theirs;
    try {
      theirs = await client.getItem(href);
    } catch (e) {
      if (classify(e).kind === 'notfound') return deletedElsewhere({ coll, href, base, spec });
      return remoteFailure(e, { op: 'update', href, coll });
    }
    const m = await getModel();
    let rows = [];
    let rb = { patch: {}, unmappable: [], applied: [], noop: true };
    let theirsOpen = true;
    let isGroup = false;
    try {
      const mine = await openFresh(coll, base.text, spec);
      mine.item.update(mine.patch, { strict: true });
      const other = await openFresh(coll, base.text, spec);
      const t = m.openItem(theirs.text, itemKind(coll));
      isGroup = isGroupText(base.text);
      if (!t.ok || t.readOnly) theirsOpen = false;
      else {
        const theirsFields = t.fields();
        rows = diffOwned(other.baseFields, mine.item.fields(), theirsFields);
        rb = rebasePatch(other.baseFields, other.patch, theirsFields);
      }
    } catch (e) {
      return localFailure(e, { op: 'conflict', href, text: base.text, etag: base.etag });
    }
    if (coll.st) coll.st.applyWrite(href, { etag: theirs.etag, text: theirs.text });
    log('conflict', href, 'info', '412');
    return say('conflict', false, 'store.err.conflict', undefined, {
      href,
      collection: coll.href,
      base: { text: base.text, etag: base.etag },
      theirs: { text: theirs.text, etag: theirs.etag },
      mine: { patchSpec: spec.patch, baseFields: spec.baseFields },
      rows,
      unmappable: rb.unmappable,
      notes: rb.notes || [],
      applied: rb.applied,
      noop: rb.noop,
      bothChanged: rows.some((r) => r.both),
      isGroup,
      theirsReadable: theirsOpen,
      canOverwrite: theirsOpen,
      canCopy: !isGroup && canSaveAsCopy({ group: { isGroup } }),
    });
  }

  // ------------------------------------------------------------ item writes

  async function putUpdate({ coll, href, bodyText, etag, keys, base, spec, op = 'update', okStatus = 'saved', statusKey = 'store.status.saved', accepted = [], touched = null, onConflict = null, onGone = null }) {
    let put;
    try {
      put = await client.putItem(href, bodyText, { etag });
    } catch (e) {
      if (classify(e).kind === 'precondition') return onConflict ? onConflict() : conflictFor({ coll, href, base, spec });
      if (onGone && classify(e).kind === 'notfound') return onGone();
      return remoteFailure(e, { op, href, coll });
    }
    const c = await confirm({ coll, href, put, sentText: bodyText, keys, op, accepted, touched });
    log(op, href, 'ok', c.verified === false ? 'verify-mismatch' : '');
    const res = say(okStatus, true, statusKey, undefined, { href, etag: c.etag, text: c.text, verified: c.verified, mismatched: c.mismatched }, { alert: false });
    return res;
  }

  const hasBase = (b) => Boolean(b) && typeof b.text === 'string' && b.text !== '' && typeof b.etag === 'string' && b.etag !== '';
  const baseRequired = (href) => say('invalid', false, 'store.err.invalid', { reason: 'base-required' }, { href, reason: 'base-required' });

  /**
   * Save a change to an existing item. `base = {text, etag}` is MANDATORY: the version the edit started from (keep
   * it from the moment the form opens). The store's current copy is never an implicit base: after a background
   * sync it may be another client's version, and rows would be written onto the wrong places.
   */
  async function saveItem({ collection, href, patch, baseFields = null, base = null, acceptNicknameLoss = false }) {
    const coll = collOf(collection);
    const refused = guard(coll);
    if (refused) return refused;
    if (!hasBase(base)) return baseRequired(href);
    const baseEntry = base;
    if (flagged(href, baseEntry.etag)) return say('readonly', false, 'store.err.readonly', undefined, { href, reason: 'fidelity' });
    // an event or a task: a plain patch is one `patch` operation (so a 412 replays it on theirs)
    if (coll.kind === 'calendar' && patch && typeof patch === 'object') return applyOps({ collection: coll.href, href, base: baseEntry, ops: [{ type: 'patch', fields: patch }] });
    const spec = { patch, baseFields };
    let prepared;
    let out;
    try {
      prepared = await openFresh(coll, baseEntry.text, spec);
      prepared.item.update(prepared.patch, { strict: true });
      out = prepared.item.save();
    } catch (e) {
      return localFailure(e, { op: 'update', href, text: baseEntry.text, etag: baseEntry.etag });
    }
    if (!out.changed) return say('unchanged', true, 'store.status.unchanged', undefined, { href, changed: false }, { alert: false });
    const nick = nicknameGuard(coll, out.text, acceptNicknameLoss);
    if (nick) return { ...nick, href };
    return putUpdate({ coll, href, bodyText: out.text, etag: baseEntry.etag, keys: keysOfPatch(prepared.patch), base: baseEntry, spec, accepted: acceptedFor(coll, out.text, acceptNicknameLoss) });
  }

  const newHrefFor = (coll, uid) => childHref(coll.href, `${uid}.${ext(coll)}`);

  /** PUT a NEW resource (If-None-Match: *), with the retry rule: a 412 on a RETRY is verified by a GET. */
  async function putNew({ coll, href, uid, text, keys, op = 'create', statusKey = 'store.status.created', okStatus = 'created', isRetry = false, accepted = [] }) {
    const attempt = { href, uid, text };
    let put;
    try {
      put = await client.putItem(href, text, { create: true });
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'precondition') {
        if (isRetry) {
          let got = null;
          try {
            got = await client.getItem(href);
          } catch (e2) {
            return remoteFailure(e2, { op, href, coll, retry: attempt });
          }
          let same = false;
          if (coll.kind === 'addressbook') {
            const m = await getModel();
            try {
              same = verifyContact(m, { sentText: text, gotText: got.text, keys }).ok;
            } catch {
              same = false;
            }
          } else if (coll.kind === 'calendar') {
            // addendum m2: Radicale re-serialises, so a retry is recognised by the projection, never by the bytes
            const m = await getModel();
            try {
              same = verifyCalendar(m, { sentText: text, gotText: got.text, touched: TOUCH_ALL }).ok;
            } catch {
              same = false;
            }
          } else same = unfoldText(got.text).trim() === unfoldText(text).trim();
          if (same) {
            if (coll.st) coll.st.applyWrite(href, { etag: got.etag, text: got.text });
            if (scheduler && coll.st) scheduler.afterWrite(coll.st);
            log(op, href, 'ok', 'recovered');
            return say(okStatus, true, statusKey, undefined, { href, uid, etag: got.etag, text: got.text, verified: true, mismatched: [], recovered: true }, { alert: false });
          }
        }
        log(op, href, 'error', '412');
        return say('exists', false, 'store.err.exists', undefined, { href, uid });
      }
      if (c.kind === 'conflict') {
        log(op, href, 'error', '409');
        return say('exists', false, 'store.err.uidConflict', undefined, { href, uid });
      }
      return remoteFailure(e, { op, href, coll, retry: attempt, gone: false });
    }
    const c = await confirm({ coll, href, put, sentText: text, keys, op, accepted });
    log(op, href, 'ok', c.verified === false ? 'verify-mismatch' : '');
    return say(okStatus, true, statusKey, undefined, { href, uid, etag: c.etag, text: c.text, verified: c.verified, mismatched: c.mismatched }, { alert: false });
  }

  function versionFor(coll) {
    const texts = coll.st ? coll.st.list().map((e) => (/^VERSION:\s*(\d\.\d)/im.exec(e.text) || [])[1] || '') : [];
    return pickNewCardVersion(texts);
  }

  async function groupFormFor(coll) {
    const m = await getModel();
    const texts = coll.st ? coll.st.list() : [];
    const cards = [];
    for (const e of texts) {
      if (isGroupText(e.text)) {
        const r = m.openItem(e.text, 'contact');
        if (r.ok) cards.push(r);
      } else cards.push((/^VERSION:\s*(\d\.\d)/im.exec(e.text) || [])[1] || '');
    }
    return pickGroupForm(cards);
  }

  /**
   * Create a contact (`fields`), or a group card (`group: {name, memberUids, form?}`). Pass the `retry` of a
   * failed attempt's result to repeat it with the SAME href and UID: a 412 then means the first attempt worked.
   */
  async function createItem({ collection, kind = null, fields = {}, group = null, version = null, retry = null, acceptNicknameLoss = false }) {
    const coll = collOf(collection);
    const refused = guard(coll);
    if (refused) return refused;
    let attempt = retry;
    let keys = group ? ['fn', 'kind', 'members'] : keysOfPatch(fields);
    if (!attempt) {
      try {
        const m = await getModel();
        const uid = random();
        let item;
        if (group) item = m.createGroupItem(group.name, group.memberUids || [], { uid, form: group.form || (await groupFormFor(coll)) });
        else item = m.createItem(kind || (coll.kind === 'calendar' ? 'event' : 'contact'), fields, { uid, version: version || versionFor(coll) });
        const out = item.save();
        attempt = { href: newHrefFor(coll, uid), uid, text: out.text };
      } catch (e) {
        return localFailure(e, { op: 'create', href: '', text: null });
      }
    }
    const nick = nicknameGuard(coll, attempt.text, acceptNicknameLoss);
    if (nick) return nick;
    return putNew({ coll, href: attempt.href, uid: attempt.uid, text: attempt.text, keys, isRetry: Boolean(retry), accepted: acceptedFor(coll, attempt.text, acceptNicknameLoss) });
  }

  /** Save base + patch as a NEW item (new UID, new href, If-None-Match). Group cards are refused. */
  async function copyItem({ collection, href, patch = {}, baseFields = null, base = null, retry = null, acceptNicknameLoss = false, ops = null }) {
    const coll = collOf(collection);
    const refused = guard(coll);
    if (refused) return refused;
    let attempt = retry;
    let keys = keysOfPatch(typeof patch === 'function' ? {} : patch);
    if (!attempt) {
      if (!hasBase(base)) return baseRequired(href);
      const baseEntry = base;
      if (isGroupText(baseEntry.text)) return say('not-allowed', false, 'store.err.copyGroup', undefined, { href });
      if (ops) {
        // an event or task conflict: my operations on the base, saved as a NEW item (never for a series)
        try {
          const m = await getModel();
          const r = m.openItem(baseEntry.text, itemKind(coll));
          if (!r.ok) throw new Refusal('readonly', r.reason);
          if (r.readOnly) throw new Refusal('readonly', r.readOnlyReason);
          if (isRecurring(r)) return say('not-allowed', false, 'store.err.copyRecurring', undefined, { href });
          applyOpsToItem(r, ops, { lib: needsEventLib(ops) ? await getEventLib() : null, now: now() });
          const uid = random();
          const out = r.asCopy({ uid }).save({ now: now() });
          attempt = { href: newHrefFor(coll, uid), uid, text: out.text };
        } catch (e) {
          return localFailure(e, { op: 'create', href, text: null, etag: baseEntry.etag });
        }
      } else {
        try {
          const prepared = await openFresh(coll, baseEntry.text, { patch, baseFields });
          prepared.item.update(prepared.patch, { strict: true });
          keys = keysOfPatch(prepared.patch);
          const uid = random();
          const copy = prepared.item.asCopy({ uid });
          const out = copy.save();
          attempt = { href: newHrefFor(coll, uid), uid, text: out.text };
        } catch (e) {
          return localFailure(e, { op: 'create', href, text: null, etag: baseEntry.etag });
        }
      }
    }
    const nick = nicknameGuard(coll, attempt.text, acceptNicknameLoss);
    if (nick) return nick;
    return putNew({ coll, href: attempt.href, uid: attempt.uid, text: attempt.text, keys, op: 'create', okStatus: 'copied', statusKey: 'store.status.copied', isRetry: Boolean(retry), accepted: acceptedFor(coll, attempt.text, acceptNicknameLoss) });
  }

  // ------------------------------------------------------------ events and tasks (RUN3 D-R3-5)

  /** Open `text` fresh, apply `ops`, save. Throws what the model throws (FieldError, SeriesError, ReadOnlyError, FidelityError). */
  async function runOps(coll, text, ops) {
    const m = await getModel();
    const r = m.openItem(text, itemKind(coll));
    if (!r.ok) throw new Refusal('readonly', r.reason);
    if (r.readOnly) throw new Refusal('readonly', r.readOnlyReason);
    const lib = needsEventLib(ops) ? await getEventLib() : null;
    applyOpsToItem(r, ops, { lib, now: now() });
    return { item: r, out: r.save({ now: now() }) };
  }

  /** A fresh event with the head of a split applied and the tail built: {item, headOut, tailText, tailUid}. */
  async function prepareSplit(coll, text, { rid, tailFields, exceptions }) {
    const m = await getModel();
    const lib = await getEventLib();
    const r = m.openItem(text, itemKind(coll));
    if (!r.ok) throw new Refusal('readonly', r.reason);
    if (r.readOnly) throw new Refusal('readonly', r.readOnlyReason);
    if (r.kind !== 'event') throw new Refusal('invalid', 'not-an-event');
    if (!rid || typeof rid !== 'object') throw new Refusal('invalid', 'rid-required');
    // On a replay (Overwrite after a 412) the series may no longer produce this occurrence (BYDAY changed elsewhere,
    // occurrence deleted): splitting there would cut at a wrong place. SeriesError makes the row unmappable.
    if (!lib.isOccurrence(r.root, rid, { zones: r.zones })) throw new lib.SeriesError('occurrence-not-found', 'that occurrence no longer exists');
    const { tail, tailUid } = lib.splitSeries(r.root, rid, { newUid: random(), tailPatch: tailFields && Object.keys(tailFields).length ? tailFields : undefined, exceptions: exceptions || 'keep', zones: r.zones });
    const tailItem = new m.Item({ kind: 'event', root: tail, raw: null, baseline: undefined, isNew: true, tz: r.tz, warnings: r.warnings });
    const tailOut = tailItem.save({ now: now() });
    const headOut = r.save({ now: now() });
    return { item: r, headOut, tailText: tailOut.text, tailUid };
  }

  const describeReplayFailure = (op, e) => ({ field: op, op: 'replay', reason: (e && e.code) || (e && e.message) || 'error', base: '', mine: '' });

  /**
   * The item was deleted by another client (a 404 on the PUT or on the GET after a 412): the `deleted-elsewhere` result
   * of an event/task write. `mine` is {ops} | {split} | {move}; an ops edit of a non-recurring item can still be saved as a copy.
   */
  async function calendarGone({ coll, href, base, mine }) {
    const m = await getModel();
    const baseItem = m.openItem(base.text, itemKind(coll));
    const kind = baseItem.ok ? baseItem.kind : 'event';
    const canCopy = Boolean(mine.ops) && baseItem.ok && canSaveAsCopy(kind, isRecurring(baseItem));
    return { ...deletedElsewhere({ coll, href, base, spec: null }), mine, canCopy };
  }

  /** The conflict result of an event/task write: `mine` is {ops} | {split} | {move}. Overwrite replays it on theirs. */
  async function calendarConflict({ coll, href, base, mine }) {
    let theirs;
    try {
      theirs = await client.getItem(href);
    } catch (e) {
      if (classify(e).kind === 'notfound') return calendarGone({ coll, href, base, mine });
      return remoteFailure(e, { op: 'update', href, coll });
    }
    const m = await getModel();
    const baseItem = m.openItem(base.text, itemKind(coll));
    const theirsItem = m.openItem(theirs.text, itemKind(coll));
    const theirsOpen = theirsItem.ok && !theirsItem.readOnly;
    const kind = baseItem.ok ? baseItem.kind : theirsItem.ok ? theirsItem.kind : 'event';
    const recurring = isRecurring(baseItem) || isRecurring(theirsItem);
    let rows = [];
    const unmappable = [];
    if (baseItem.ok && theirsItem.ok) {
      try {
        let mineItem = baseItem;
        if (mine.ops) {
          const r = await runOps(coll, base.text, mine.ops);
          if (r.out.changed) mineItem = m.openItem(r.out.text, itemKind(coll));
        } else if (mine.split) {
          mineItem = m.openItem((await prepareSplit(coll, base.text, mine.split)).headOut.text, itemKind(coll));
        }
        const zones = baseItem.kind === 'event' ? baseItem.zones : null;
        const occurrences = mine.ops && zones ? occurrencesOfOps(mine.ops).map((rid) => ({ key: occurrenceKey(rid, zones), label: rid.iso })) : [];
        rows = diffOwned(kind, projectCalendarItem(baseItem), projectCalendarItem(mineItem), projectCalendarItem(theirsItem), { occurrences });
      } catch {
        rows = [];
      }
      // can my operations still be applied to their version? One that cannot is listed and blocks Overwrite (never guessed)
      if (theirsOpen) {
        try {
          if (mine.ops) {
            const t = m.openItem(theirs.text, itemKind(coll));
            const lib = needsEventLib(mine.ops) ? await getEventLib() : null;
            for (const op of mine.ops) {
              try {
                applyOpsToItem(t, [op], { lib, now: now() });
              } catch (e) {
                if (e instanceof Refusal) throw e;
                unmappable.push(describeReplayFailure(op.type, e));
                break;
              }
            }
          } else if (mine.split) {
            await prepareSplit(coll, theirs.text, mine.split);
          }
        } catch (e) {
          unmappable.push(describeReplayFailure(mine.split ? 'split' : 'ops', e));
        }
      }
    }
    if (coll.st) coll.st.applyWrite(href, { etag: theirs.etag, text: theirs.text });
    log('conflict', href, 'info', '412');
    const canCopy = Boolean(mine.ops) && baseItem.ok && canSaveAsCopy(kind, recurring);
    return say('conflict', false, 'store.err.conflict', undefined, {
      href,
      collection: coll.href,
      kind,
      base: { text: base.text, etag: base.etag },
      theirs: { text: theirs.text, etag: theirs.etag },
      mine,
      rows,
      unmappable,
      notes: [],
      applied: [],
      noop: false,
      bothChanged: rows.some((r) => r.both),
      isGroup: false,
      theirsReadable: theirsOpen,
      canOverwrite: theirsOpen && unmappable.length === 0,
      canCopy,
    });
  }

  /**
   * Apply an operation list to an event or task (RUN3 D-R3-5.1). `base = {text, etag}` is mandatory, as for saveItem.
   * Every attempt re-opens a fresh item from `base.text`; a 412 returns a conflict whose Overwrite replays the same
   * operations on their version (an operation that cannot be replayed is listed in `unmappable` and Overwrite is
   * disabled for it). No change: no request.
   * @param {{collection: string, href: string, base: {text: string, etag: string}, ops: object[], op?: string}} o
   */
  async function applyOps({ collection, href, base = null, ops, op = null, statusKey = 'store.status.saved' }) {
    const coll = collOf(collection);
    const refused = guard(coll);
    if (refused) return refused;
    if (!hasBase(base)) return baseRequired(href);
    if (flagged(href, base.etag)) return say('readonly', false, 'store.err.readonly', undefined, { href, reason: 'fidelity' });
    const bad = checkOps(ops);
    if (bad) return say('invalid', false, 'store.err.invalid', { reason: bad }, { href, reason: bad });
    const opName = op || opNameOf(ops);
    let prepared;
    try {
      prepared = await runOps(coll, base.text, ops);
    } catch (e) {
      return localFailure(e, { op: opName, href, text: base.text, etag: base.etag });
    }
    if (!prepared.out.changed) return say('unchanged', true, 'store.status.unchanged', undefined, { href, changed: false }, { alert: false });
    const kind = prepared.item.kind;
    return putUpdate({
      coll,
      href,
      bodyText: prepared.out.text,
      etag: base.etag,
      base,
      op: opName,
      statusKey,
      touched: touchedOfOps(ops, kind),
      onConflict: () => calendarConflict({ coll, href, base, mine: { ops } }),
      onGone: () => calendarGone({ coll, href, base, mine: { ops } }),
    });
  }

  /** DELETE a resource this write created, with its own ETag. 404 counts as gone. */
  async function removeCreated(coll, href, etag) {
    if (!etag) return { ok: false, reason: 'no-etag' };
    try {
      await client.deleteItem(href, etag);
    } catch (e) {
      if (classify(e).kind !== 'notfound') return { ok: false, reason: classify(e).kind, status: classify(e).status };
    }
    if (coll.st) coll.st.applyDelete(href);
    return { ok: true };
  }

  const KNOWN_NOT_APPLIED = new Set(['precondition', 'forbidden', 'notfound', 'toolarge', 'auth']);

  /**
   * "This and following" (RUN3 D-R3-5.2, addendum C1/m3). `rid` is the TimeSpec of the first occurrence of the new
   * series. Order: (a) build head and tail from a fresh item; (b) create the tail (If-None-Match), read it back and
   * verify; (c) PUT the truncated original with If-Match (base.etag), read it back and verify.
   * The tail is deleted again ONLY when (c) is known not to have been applied (412, 403, 404, 413, 401), or when the GET
   * after a network error / 5xx shows the original unchanged. When it cannot be known nothing is deleted and a persistent
   * alert names both resources. Overwrite after a 412 replays the split on their version.
   * @param {{collection: string, href: string, base: {text: string, etag: string}, rid: object, tailFields?: object, exceptions?: 'keep'|'remove'|'remove-orphans'}} o
   */
  async function splitWrite({ collection, href, base = null, rid, tailFields = {}, exceptions = 'keep', statusKey = 'store.status.split' }) {
    const coll = collOf(collection);
    const refused = guard(coll);
    if (refused) return refused;
    if (!hasBase(base)) return baseRequired(href);
    if (flagged(href, base.etag)) return say('readonly', false, 'store.err.readonly', undefined, { href, reason: 'fidelity' });
    const splitSpec = { rid, tailFields, exceptions };
    let plan;
    try {
      plan = await prepareSplit(coll, base.text, splitSpec);
    } catch (e) {
      return localFailure(e, { op: 'split', href, text: base.text, etag: base.etag });
    }
    const tailHref = newHrefFor(coll, plan.tailUid);
    const m = await getModel();
    const both = { head: leafOf(href), tail: leafOf(tailHref) };
    const incomplete = (reason) => {
      reporter.alert('store.err.splitCompensation', both, { persistent: true });
      log('split', href, 'error', `both exist: ${reason}`);
      return { ok: false, status: 'split-incomplete', message: reporter.text('store.err.splitCompensation', both), href, tailHref, reason };
    };
    const unknown = async () => {
      reporter.alert('store.err.splitUnknown', both, { persistent: true });
      log('split', href, 'error', 'result unknown');
      await refreshAfterFailure(coll.st);
      return { ok: false, status: 'unknown-result', message: reporter.text('store.err.splitUnknown', both), href, tailHref };
    };

    // (b) the tail first
    if (isDisposed()) return aborted('split', href);
    let tailPut;
    try {
      tailPut = await client.putItem(tailHref, plan.tailText, { create: true });
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'precondition' || c.kind === 'conflict') {
        log('split', tailHref, 'error', String(c.status || 'exists'));
        return say('exists', false, c.kind === 'conflict' ? 'store.err.uidConflict' : 'store.err.exists', undefined, { href, tailHref });
      }
      if (!isResultUnknown(c.kind)) return remoteFailure(e, { op: 'split', href, coll, gone: false });
      // the tail may exist: look before deciding (the original is untouched either way)
      let found = null;
      try {
        found = await client.getItem(tailHref);
      } catch (e2) {
        if (classify(e2).kind !== 'notfound') return unknown();
      }
      if (!found) return remoteFailure(e, { op: 'split', href, coll, gone: false });
      tailPut = { etag: found.etag };
    }
    let tailGot = null;
    try {
      tailGot = await client.getItem(tailHref);
    } catch {
      /* the PUT's ETag is used */
    }
    const tailEtag = (tailGot && tailGot.etag) || tailPut.etag || null;
    if (tailGot) {
      let v;
      try {
        v = verifyCalendar(m, { sentText: plan.tailText, gotText: tailGot.text, touched: TOUCH_ALL });
      } catch {
        v = { ok: false, mismatched: [], unreadable: true };
      }
      if (!v.ok) {
        reporter.alert('store.err.verify', { name: leafOf(tailHref), fields: v.unreadable ? '?' : v.mismatched.join(', ') }, { persistent: true });
        log('verify', tailHref, 'error', v.unreadable ? 'unreadable' : v.mismatched.join(','));
        const comp = await removeCreated(coll, tailHref, tailEtag);
        if (!comp.ok) return incomplete('tail-verify');
        return { ok: false, status: 'tail-mismatch', message: reporter.text('store.err.verify', { name: leafOf(tailHref), fields: v.mismatched.join(', ') }), href, tailHref, mismatched: v.mismatched };
      }
    }

    // (c) the truncated original (the tail already exists: reported, the next login sees both resources)
    if (isDisposed()) return aborted('split', href, { tailHref });
    let headPut = null;
    let headGot = null;
    try {
      headPut = await client.putItem(href, plan.headOut.text, { etag: base.etag });
    } catch (e) {
      const c = classify(e);
      let notApplied = KNOWN_NOT_APPLIED.has(c.kind);
      if (!notApplied) {
        // network loss or 5xx: the PUT may have been applied. Ask the server.
        let cur = null;
        try {
          cur = await client.getItem(href);
        } catch {
          return unknown();
        }
        if (cur.etag === base.etag) notApplied = true;
        else {
          let relation = 'other';
          try {
            const a = projectCalendarItem(m.openItem(base.text, itemKind(coll)));
            const b = projectCalendarItem(m.openItem(cur.text, itemKind(coll)));
            const h = projectCalendarItem(m.openItem(plan.headOut.text, itemKind(coll)));
            if (diffCalendarProjections(a, b, TOUCH_ALL).length === 0) relation = 'base';
            else if (diffCalendarProjections(h, b, TOUCH_ALL).length === 0) relation = 'head';
          } catch {
            relation = 'other';
          }
          if (relation === 'base') notApplied = true;
          else if (relation === 'head') {
            headPut = { etag: cur.etag };
            headGot = cur;
          } else return unknown();
        }
      }
      if (notApplied) {
        const comp = await removeCreated(coll, tailHref, tailEtag);
        if (!comp.ok) return incomplete(comp.reason || 'delete-failed');
        log('split', href, 'error', `${c.kind}${c.status ? ' ' + c.status : ''}: tail removed`);
        if (c.kind === 'precondition') return calendarConflict({ coll, href, base, mine: { split: splitSpec } });
        if (!KNOWN_NOT_APPLIED.has(c.kind)) {
          await refreshAfterFailure(coll.st);
          return say(c.kind === 'network' ? 'unknown-result' : 'server-error', false, c.kind === 'network' ? 'store.err.unknownResult' : 'store.err.serverReloaded', undefined, { href, kind: c.kind, httpStatus: c.status });
        }
        return remoteFailure(e, { op: 'split', href, coll });
      }
    }
    const touchedHead = { master: ['rrule', 'exdates'], occurrences: [], overrideSet: true, allOverrides: false };
    const c = await confirm({ coll, href, put: headPut, sentText: plan.headOut.text, op: 'split', touched: touchedHead });
    if (coll.st && tailGot) coll.st.applyWrite(tailHref, { etag: tailEtag, text: tailGot.text });
    if (scheduler && coll.st) scheduler.afterWrite(coll.st);
    log('split', href, 'ok', `tail ${leafOf(tailHref)}`);
    return say('saved', true, statusKey, undefined, { href, tailHref, tailUid: plan.tailUid, etag: c.etag, text: c.text, tail: { href: tailHref, etag: tailEtag, text: tailGot ? tailGot.text : null }, verified: c.verified, mismatched: c.mismatched }, { alert: false });
  }

  /**
   * Move an event or task to another calendar (RUN3 D-R3-5.3, addendum M5): PUT the EXACT server text (no writer)
   * to `to` with If-None-Match and the same file name (a uuid name when that name is taken by something else), read it
   * back and compare the projections, then DELETE the source with If-Match (base.etag). A 412 at that DELETE removes
   * the copy again and returns the normal conflict ("nothing moved"); another failure leaves both and raises a
   * persistent alert. Needs write access on both collections and a target that supports the component.
   * @param {{from: string, to: string, href: string, base: {text: string, etag: string}}} o
   */
  async function moveItem({ from, to, href, base = null }) {
    const src = collOf(from);
    const dst = collOf(to);
    const refused = guard(src) || guard(dst);
    if (refused) return refused;
    if (src.href === dst.href) return say('invalid', false, 'store.err.invalid', { reason: 'same-collection' }, { href, reason: 'same-collection' });
    if (!hasBase(base)) return baseRequired(href);
    if (flagged(href, base.etag)) return say('readonly', false, 'store.err.readonly', undefined, { href, reason: 'fidelity' });
    const m = await getModel();
    const r = m.openItem(base.text);
    if (!r.ok || r.readOnly) return say('readonly', false, 'store.err.readonly', undefined, { href, reason: r.ok ? r.readOnlyReason : r.reason });
    const need = r.kind === 'task' ? 'VTODO' : 'VEVENT';
    const comps = dst.known && Array.isArray(dst.known.components) ? dst.known.components : null;
    if ((comps && comps.length && !comps.includes(need)) || (dst.kind && dst.kind !== 'calendar')) {
      return say('not-allowed', false, 'store.err.moveUnsupported', undefined, { href, reason: 'component' });
    }
    try {
      (await getFidelity()).checkNewItem(base.text, { requireProdid: false });
    } catch (e) {
      return localFailure(e, { op: 'move', href, text: base.text, etag: base.etag });
    }
    const names = { name: leafOf(href), from: leafOf(src.href), to: leafOf(dst.href) };

    // copy
    let newHref = childHref(dst.href, leafOf(href));
    let copyEtag = null;
    let copyText = null;
    let copied = false;
    for (let attempt = 1; attempt <= 2 && !copied; attempt++) {
      if (isDisposed()) return aborted('move', href);
      try {
        const put = await client.putItem(newHref, base.text, { create: true });
        copyEtag = put.etag || null;
        copied = true;
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'precondition') {
          let got = null;
          try {
            got = await client.getItem(newHref);
          } catch (e2) {
            if (classify(e2).kind !== 'notfound') return remoteFailure(e2, { op: 'move', href, coll: dst, gone: false });
          }
          if (got) {
            let same = false;
            try {
              same = verifyCalendar(m, { sentText: base.text, gotText: got.text, touched: TOUCH_ALL }).ok;
            } catch {
              same = false;
            }
            if (same) {
              copyEtag = got.etag;
              copyText = got.text;
              copied = true; // already copied by an earlier attempt
              continue;
            }
          }
          if (attempt === 1) {
            newHref = childHref(dst.href, `${random()}.ics`);
            continue;
          }
          log('move', newHref, 'error', '412');
          return say('exists', false, 'store.err.exists', undefined, { href, to: dst.href });
        }
        if (c.kind === 'conflict') {
          log('move', newHref, 'error', '409');
          return say('exists', false, 'store.err.uidConflict', undefined, { href, to: dst.href });
        }
        return remoteFailure(e, { op: 'move', href, coll: dst, gone: false });
      }
    }
    let got = null;
    if (copyText === null) {
      try {
        got = await client.getItem(newHref);
        copyEtag = got.etag || copyEtag;
        copyText = got.text;
      } catch {
        /* handled below */
      }
    }
    if (copyText === null) {
      reporter.alert('store.err.moveUnverified', names, { persistent: true });
      log('move', href, 'error', 'copy not verified');
      await refreshAfterFailure(dst.st);
      return { ok: false, status: 'copy-unverified', message: reporter.text('store.err.moveUnverified', names), href, newHref };
    }
    let v;
    try {
      v = verifyCalendar(m, { sentText: base.text, gotText: copyText, touched: TOUCH_ALL });
    } catch {
      v = { ok: false, mismatched: [], unreadable: true };
    }
    if (!v.ok) {
      reporter.alert('store.err.verify', { name: leafOf(newHref), fields: v.unreadable ? '?' : v.mismatched.join(', ') }, { persistent: true });
      log('verify', newHref, 'error', v.unreadable ? 'unreadable' : v.mismatched.join(','));
      const comp = await removeCreated(dst, newHref, copyEtag);
      if (!comp.ok) {
        reporter.alert('store.err.moveBothExist', names, { persistent: true });
        return { ok: false, status: 'move-incomplete', message: reporter.text('store.err.moveBothExist', names), href, newHref };
      }
      return { ok: false, status: 'copy-mismatch', message: reporter.text('store.err.verify', { name: leafOf(newHref), fields: v.mismatched.join(', ') }), href, newHref, mismatched: v.mismatched };
    }
    if (dst.st) dst.st.applyWrite(newHref, { etag: copyEtag, text: copyText });

    // delete the source
    const bothExist = async (why) => {
      reporter.alert('store.err.moveBothExist', names, { persistent: true });
      log('move', href, 'error', `both exist: ${why}`);
      await refreshAfterFailure(src.st);
      if (scheduler && dst.st) scheduler.afterWrite(dst.st);
      return { ok: false, status: 'move-incomplete', message: reporter.text('store.err.moveBothExist', names), href, newHref, reason: why };
    };
    if (isDisposed()) return aborted('move', href, { newHref });
    try {
      await client.deleteItem(href, base.etag);
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'precondition') {
        const comp = await removeCreated(dst, newHref, copyEtag);
        if (!comp.ok) return bothExist('copy-not-removed');
        return calendarConflict({ coll: src, href, base, mine: { move: { to: dst.href } } });
      }
      if (c.kind === 'auth') return { ok: false, status: 'auth', message: '', href };
      if (c.kind !== 'notfound') {
        let gone = false;
        if (isResultUnknown(c.kind)) {
          try {
            await client.getItem(href);
          } catch (e2) {
            gone = classify(e2).kind === 'notfound';
          }
        }
        if (!gone) return bothExist(c.kind + (c.status ? ' ' + c.status : ''));
      }
    }
    if (src.st) src.st.applyDelete(href);
    if (scheduler) {
      if (src.st) scheduler.afterWrite(src.st);
      if (dst.st) scheduler.afterWrite(dst.st);
    }
    log('move', href, 'ok', `→ ${leafOf(dst.href)}`);
    return say('moved', true, 'store.status.moved', undefined, { href: newHref, from: src.href, to: dst.href, etag: copyEtag, text: copyText }, { alert: false });
  }

  // ------------------------------------------------------------ conflict resolutions

  /** Take their version: discard my change, the store already holds theirs. */
  function resolveReload(conflict) {
    const coll = collOf(conflict.collection);
    if (coll.st) coll.st.applyWrite(conflict.href, { etag: conflict.theirs.etag, text: conflict.theirs.text });
    log('conflict', conflict.href, 'info', 'reload');
    return say('reloaded', true, 'store.status.reloaded', undefined, { href: conflict.href, etag: conflict.theirs.etag, text: conflict.theirs.text }, { alert: false });
  }

  /**
   * Re-apply MY change on THEIR version (row-level three-way merge, conflict.js). Operations that cannot be
   * mapped are listed in the conflict (`unmappable`); without `confirmUnmappable: true` nothing is sent.
   * A second 412 returns a new ConflictResult.
   */
  async function resolveOverwrite(conflict, { confirmUnmappable = false, acceptNicknameLoss = false } = {}) {
    if (conflict.mine && (conflict.mine.ops || conflict.mine.split || conflict.mine.move)) return overwriteCalendar(conflict);
    if (!conflict.canOverwrite) return say('not-allowed', false, 'store.err.invalid', { reason: 'their version is read-only' }, { href: conflict.href });
    const coll = collOf(conflict.collection);
    const guarded = guard(coll);
    if (guarded) return guarded;
    const spec = { patch: conflict.mine.patchSpec, baseFields: conflict.mine.baseFields };
    let theirsItem;
    let rb;
    let out;
    try {
      const base = await openFresh(coll, conflict.base.text, spec);
      theirsItem = await openFresh(coll, conflict.theirs.text, null);
      rb = rebasePatch(base.baseFields, base.patch, theirsItem.baseFields);
      if (rb.unmappable.length && !confirmUnmappable) return say('needs-confirmation', false, 'store.err.needsConfirmation', undefined, { href: conflict.href, unmappable: rb.unmappable });
      theirsItem.item.update(rb.patch, { strict: true });
      out = theirsItem.item.save();
    } catch (e) {
      return localFailure(e, { op: 'update', href: conflict.href, text: conflict.theirs.text, etag: conflict.theirs.etag });
    }
    if (!out.changed) {
      if (coll.st) coll.st.applyWrite(conflict.href, { etag: conflict.theirs.etag, text: conflict.theirs.text });
      // "identical on the server" only when nothing was left out; after dropped (unmappable) changes it is a plain "no changes"
      return say('unchanged', true, rb.unmappable.length ? 'store.status.unchanged' : 'conflict.status.identical', undefined, { href: conflict.href, changed: false }, { alert: false });
    }
    const nick = nicknameGuard(coll, out.text, acceptNicknameLoss);
    if (nick) return { ...nick, href: conflict.href };
    const res = await putUpdate({
      coll,
      href: conflict.href,
      bodyText: out.text,
      etag: conflict.theirs.etag,
      keys: keysOfPatch(rb.patch),
      base: conflict.base,
      spec,
      okStatus: 'saved',
      statusKey: 'store.status.overwritten',
      accepted: acceptedFor(coll, out.text, acceptNicknameLoss),
    });
    if (res.ok) log('conflict', conflict.href, 'info', 'overwrite');
    return res;
  }

  /** Overwrite for an event or task conflict: replay my operations (or split, or move) on THEIR version. */
  async function overwriteCalendar(conflict) {
    const coll = collOf(conflict.collection);
    const guarded = guard(coll);
    if (guarded) return guarded;
    if (!conflict.canOverwrite) return say('not-allowed', false, 'store.err.invalid', { reason: 'their version cannot be changed by this app' }, { href: conflict.href });
    const base = { text: conflict.theirs.text, etag: conflict.theirs.etag };
    const mine = conflict.mine;
    let res;
    if (mine.ops) res = await applyOps({ collection: coll.href, href: conflict.href, base, ops: mine.ops, statusKey: 'store.status.overwritten' });
    else if (mine.split) res = await splitWrite({ collection: coll.href, href: conflict.href, base, ...mine.split, statusKey: 'store.status.overwritten' });
    else res = await moveItem({ from: coll.href, to: mine.move.to, href: conflict.href, base });
    if (res.ok) log('conflict', conflict.href, 'info', 'overwrite');
    return res;
  }

  /** Save my version as a copy (new UID, new href). Disabled for group cards; works after a deletion elsewhere too. */
  function resolveCopy(conflict, { acceptNicknameLoss = false } = {}) {
    if (conflict.isGroup || (conflict.canCopy === false)) return Promise.resolve(say('not-allowed', false, 'store.err.copyGroup', undefined, { href: conflict.href }));
    log('conflict', conflict.href, 'info', 'copy');
    if (conflict.mine && conflict.mine.ops) return copyItem({ collection: conflict.collection, href: conflict.href, ops: conflict.mine.ops, base: conflict.base });
    return copyItem({ collection: conflict.collection, href: conflict.href, patch: conflict.mine.patchSpec, baseFields: conflict.mine.baseFields, base: conflict.base, acceptNicknameLoss });
  }

  // ------------------------------------------------------------ groups

  /**
   * Add or remove members of a group card with exactly ONE PUT on the group card (member cards are never
   * written). `delta = {add: [uri|uid], remove: [uri|uid]}`. On a 412 the delta is replayed ONCE on their
   * member list; a second 412 is reported.
   */
  async function putGroupMembers({ collection, href, delta, base = null, quiet = false }) {
    const coll = collOf(collection);
    const refused = guard(coll);
    if (refused) return refused;
    const add = (delta && delta.add) || [];
    const remove = (delta && delta.remove) || [];
    if (add.some((u) => typeof u !== 'string' || !u.trim())) return say('no-uid', false, 'store.err.noUid', undefined, { href });
    const wanted = { add: add.map((u) => memberUri(u.trim())), remove: remove.map((u) => String(u).trim()).filter(Boolean) };
    let entry = base || (coll.st && coll.st.get(href));
    if (!entry) return say('notfound', false, 'err.dav.notfound', undefined, { href });
    if (flagged(href, entry.etag)) return say('readonly', false, 'store.err.readonly', undefined, { href, reason: 'fidelity' });
    let d = wanted;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let out;
      try {
        const p = await openFresh(coll, entry.text, null);
        if (!p.baseFields.group || !p.baseFields.group.isGroup) throw new Refusal('invalid', 'not-a-group');
        p.item.update({ membersDelta: d }, { strict: true });
        out = p.item.save();
      } catch (e) {
        return localFailure(e, { op: 'update', href, text: entry.text, etag: entry.etag });
      }
      if (!out.changed) return say('unchanged', true, 'store.status.unchanged', undefined, { href, changed: false }, { alert: false });
      let put;
      try {
        put = await client.putItem(href, out.text, { etag: entry.etag });
      } catch (e) {
        if (classify(e).kind !== 'precondition') return remoteFailure(e, { op: 'update', href, coll });
        if (attempt === 2) {
          log('conflict', href, 'error', '412 again');
          return say('conflict', false, 'store.err.groupChangedAgain', undefined, { href, membership: true });
        }
        let theirs;
        try {
          theirs = await client.getItem(href);
        } catch (e2) {
          if (classify(e2).kind === 'notfound') return deletedElsewhere({ coll, href, base: entry, spec: null });
          return remoteFailure(e2, { op: 'update', href, coll });
        }
        const rb = rebaseMembership(wanted, memberValues(theirs.text));
        log('conflict', href, 'info', 'membership rebased');
        entry = { text: theirs.text, etag: theirs.etag };
        if (!rb.changed) {
          if (coll.st) coll.st.applyWrite(href, entry);
          return say('unchanged', true, 'store.status.unchanged', undefined, { href, changed: false }, { alert: false });
        }
        d = rb.delta;
        continue;
      }
      const c = await confirm({ coll, href, put, sentText: out.text, keys: ['members'], op: 'update' });
      log('update', href, 'ok', c.verified === false ? 'verify-mismatch' : 'members');
      return say('saved', true, quiet ? '' : 'store.status.membersSaved', undefined, { href, etag: c.etag, text: c.text, verified: c.verified, mismatched: c.mismatched }, { alert: false });
    }
    return say('error', false, 'err.dav.unknown', undefined, { href });
  }

  function groupsWithMember(st, uid) {
    if (!st || !uid) return [];
    return st
      .list()
      .filter((e) => isGroupText(e.text) && memberValues(e.text).some((v) => memberMatches(v, uid)))
      .map((e) => e.href);
  }

  /**
   * Delete an item. A contact: DELETE first, then ONE PUT per group that lists it (cleanup; `groupHrefs`
   * overrides the search in the store). `etag` is MANDATORY: the ETag of the version the user was shown (never the
   * store's latest, which a sync may have replaced). A 412 returns `changed-elsewhere` with their version; use
   * resolveDeleteAnyway() to delete with the fresh ETag.
   */
  async function deleteItem({ collection, href, etag = null, uid = null, groupHrefs = null }) {
    const coll = collOf(collection);
    const refused = guard(coll);
    if (refused) return refused;
    if (typeof etag !== 'string' || !etag) return say('invalid', false, 'store.err.invalid', { reason: 'etag-required' }, { href, reason: 'etag-required' });
    const entry = coll.st && coll.st.get(href);
    const useEtag = etag;
    const text = entry ? entry.text : null;
    const isGroup = text ? isGroupText(text) : false;
    const theUid = uid || (text ? uidOfText(text) : null);
    let already = false;
    try {
      await client.deleteItem(href, useEtag);
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'precondition') {
        let theirs;
        try {
          theirs = await client.getItem(href);
        } catch (e2) {
          if (classify(e2).kind !== 'notfound') return remoteFailure(e2, { op: 'delete', href, coll });
          already = true;
        }
        if (!already) {
          if (coll.st) coll.st.applyWrite(href, { etag: theirs.etag, text: theirs.text });
          log('conflict', href, 'info', 'delete 412');
          return say('changed-elsewhere', false, 'store.err.changedBeforeDelete', undefined, { href, collection: coll.href, theirs: { text: theirs.text, etag: theirs.etag }, uid: theUid });
        }
      } else if (c.kind === 'notfound') already = true;
      else return remoteFailure(e, { op: 'delete', href, coll });
    }
    if (coll.st) coll.st.applyDelete(href);
    log('delete', href, 'ok', already ? 'already gone' : '');
    const cleanup = [];
    if (coll.kind === 'addressbook' && !isGroup && theUid) {
      const targets = groupHrefs || groupsWithMember(coll.st, theUid);
      for (const g of targets) {
        const r = await putGroupMembers({ collection: coll.href, href: g, delta: { remove: [theUid] }, quiet: true });
        cleanup.push({ href: g, ok: r.ok, status: r.status });
        if (r.status === 'auth' || r.status === 'blocked') break;
      }
    }
    const failedGroups = cleanup.filter((c) => !c.ok);
    if (scheduler && coll.st) scheduler.afterWrite(coll.st);
    if (failedGroups.length) {
      return say('deleted', true, 'store.err.cleanupGroups', { count: failedGroups.length }, { href, cleanup, cleanupFailed: failedGroups.length, alreadyDeleted: already }, { alert: true });
    }
    return say(already ? 'already-deleted' : 'deleted', true, 'store.status.deleted', undefined, { href, cleanup, cleanupFailed: 0 }, { alert: false });
  }

  /** "Delete anyway" after a changed-elsewhere answer: delete with the fresh ETag. */
  function resolveDeleteAnyway(result) {
    return deleteItem({ collection: result.collection, href: result.href, etag: result.theirs.etag, uid: result.uid });
  }

  // ------------------------------------------------------------ collections

  /** Create-time grant check (addendum B4): grants left over from an earlier collection of this name are revoked first. */
  async function orphanCheck(name, href) {
    if (!api) return null;
    const owner = ownerOfHref(href) || ownerLogin();
    if (!owner) return null;
    const r = await revokeGrants({ api, owner, collection: name, sleep, onEvent: (ev) => reporter.log('revoke', `${name} → ${ev.grantee}`, ev.ok ? 'ok' : 'error', ev.ok ? 'create-time' : ev.kind) });
    if (r.aborted) return { ok: false, status: 'aborted', message: '' };
    if (r.listError) {
      if (r.listError.kind === 'notfound') return null; // no account service: nothing can be shared
      return say('grants-unchecked', false, 'store.err.grantsCheck', { name }, { name });
    }
    if (r.listed > 0 && !r.ok) return say('orphan-grants', false, 'store.err.orphanGrants', { name }, { name, failed: r.failed }, { persistent: true });
    return null;
  }

  async function createCollection(kind, { home, name, props }) {
    const bad = validateCollectionName(name);
    if (bad) return say('invalid', false, 'store.err.invalid', { reason: bad }, { reason: bad });
    const blocked = guard({ known: null });
    if (blocked) return blocked;
    if (access && !access.canCreateCollections()) return say('forbidden', false, 'err.dav.forbidden', undefined, { reason: 'own-space' });
    const href = childHref(withSlash(home), name, { collection: true });
    const op = kind === 'calendar' ? 'mkcalendar' : 'mkcol';
    // No revocation may ever run against a collection that exists: a name known to the access list, or one the
    // probe finds, is "exists" before any grant is touched. Only a 404 lets the orphan-grant check start.
    const exists = () => {
      log(op, href, 'error', 'exists');
      return say('exists', false, 'store.err.collectionExists', undefined, { href, field: 'name' });
    };
    if (access && access.get(href)) return exists();
    try {
      await client.getCollection(href);
      return exists();
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'auth') return { ok: false, status: 'auth', message: '', href };
      if (c.kind !== 'notfound') return { ...say('grants-unchecked', false, 'store.err.grantsCheck', { name }, { name }), href };
    }
    const stop = await orphanCheck(name, href);
    if (stop) return { ...stop, href };
    try {
      if (kind === 'calendar') await client.mkcalendar(href, props);
      else await client.mkAddressbook(href, props);
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'conflict' || c.status === 405 || c.status === 409) {
        log(op, href, 'error', String(c.status || 'exists'));
        return say('exists', false, 'store.err.collectionExists', undefined, { href, field: 'name' });
      }
      return remoteFailure(e, { op, href, coll: { href, st: null }, gone: false });
    }
    log(op, href, 'ok');
    if (access) await access.refetch({ reason: 'collection-created' });
    return say('created', true, 'store.status.collectionCreated', undefined, { href, name }, { alert: false });
  }

  /** MKCALENDAR in `home` (the own calendar home). props: {displayName, color, description, components}. */
  const mkcalendar = ({ home, name, displayName, color, description, components }) => createCollection('calendar', { home, name, props: { displayName, color, description, components } });
  /** Extended MKCOL creating an address book. props: {displayName, description}. */
  const mkcol = ({ home, name, displayName, description }) => createCollection('addressbook', { home, name, props: { displayName, description } });

  /** Rename / describe / recolour (`null` removes). Owner only. */
  async function proppatch({ href, kind, changes }) {
    const coll = collOf({ href, kind });
    const refused = guard(coll, { manage: true });
    if (refused) return refused;
    try {
      await client.proppatch(coll.href, kind || coll.kind, changes);
    } catch (e) {
      return remoteFailure(e, { op: 'proppatch', href: coll.href, coll, gone: false });
    }
    log('proppatch', coll.href, 'ok');
    if (access) access.patchCollection(coll.href, changes);
    return say('saved', true, 'store.status.collectionSaved', undefined, { href: coll.href }, { alert: false });
  }

  async function revokeAfterDelete(href, name) {
    if (!api) return { ok: true, listed: 0, revoked: [], failed: [] };
    // The owner is the first segment of the href: an administrator deleting another account's collection
    // (admin "delete data") must never revoke the grants of a same-named collection of their own.
    const owner = ownerOfHref(href) || ownerLogin();
    const r = await revokeGrants({ api, owner, collection: name, sleep, onEvent: (ev) => reporter.log('revoke', `${name} → ${ev.grantee}`, ev.ok ? 'ok' : 'error', ev.ok ? '' : ev.kind) });
    if (r.aborted) return r; // the session ended while waiting: nothing is reported into the next login's screen
    if (r.listError) {
      if (r.listError.kind !== 'notfound') reporter.alert('store.err.revokeCheck', { name }, { persistent: true });
    } else if (!r.ok) {
      const names = r.failed.map((f) => (f.unrevokable ? `${f.grantee} (${name})*` : f.grantee)).join(', ') || name;
      reporter.alert('store.err.revokeLeft', { name, names }, { persistent: true });
    }
    return r;
  }

  /**
   * Delete a collection (owner only). The ETag is re-read just before; with `expectedEtag` (the one the dialog
   * showed) a difference answers `changed` with the fresh item count instead of deleting; a 412 does the same.
   * Grants are revoked AFTER the delete (fresh list, sequential, Retry-After honoured); what cannot be revoked
   * is reported in a persistent alert.
   */
  async function deleteCollection({ href, kind = null, expectedEtag = null }) {
    const coll = collOf({ href, kind });
    const refused = guard(coll, { manage: true });
    if (refused) return refused;
    const name = leafOf(coll.href);
    const changed = async (fresh) => {
      let count = null;
      try {
        count = (await client.listItemEtags(coll.href)).length;
      } catch (e) {
        if (classify(e).kind === 'auth') return { ok: false, status: 'auth', message: '' };
      }
      log('delete', coll.href, 'info', 'changed since opened');
      return say('changed', false, 'store.err.collectionChanged', { count: count ?? '?' }, { href: coll.href, itemCount: count, etag: fresh ? fresh.etag : null });
    };
    let fresh = null;
    let already = false;
    try {
      fresh = await client.getCollection(coll.href);
    } catch (e) {
      if (classify(e).kind === 'notfound') already = true;
      else return remoteFailure(e, { op: 'delete', href: coll.href, coll, gone: false });
    }
    if (!already) {
      if (!fresh.etag) return say('error', false, 'err.dav.unknown', undefined, { href: coll.href });
      if (expectedEtag && expectedEtag !== fresh.etag) return changed(fresh);
      try {
        await client.deleteCollection(coll.href, fresh.etag);
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'precondition') {
          let again = null;
          try {
            again = await client.getCollection(coll.href);
          } catch {
            /* keep null */
          }
          return changed(again);
        }
        if (c.kind === 'notfound') already = true;
        else return remoteFailure(e, { op: 'delete', href: coll.href, coll, gone: false });
      }
    }
    log('delete', coll.href, 'ok', already ? 'already gone' : '');
    stores.drop(coll.href);
    if (access) access.remove(coll.href);
    const revoke = await revokeAfterDelete(coll.href, name);
    if (access) await access.refetch({ reason: 'collection-deleted' });
    const leftover = !revoke.ok && !(revoke.listError && revoke.listError.kind === 'notfound');
    return say('deleted', true, 'store.status.collectionDeleted', undefined, { href: coll.href, revoke, grantsLeft: leftover }, { alert: false });
  }

  return {
    saveItem,
    createItem,
    copyItem,
    deleteItem,
    putGroupMembers,
    applyOps,
    splitWrite,
    moveItem,
    mkcol,
    mkcalendar,
    proppatch,
    deleteCollection,
    resolveReload,
    resolveOverwrite,
    resolveCopy,
    resolveDeleteAnyway,
    /** True once the fidelity guard refused this item: read-only for the rest of the session. */
    isReadOnly: (href) => flagged(href, null),
    readOnlyHrefs: () => [...readOnlyItems.keys()].filter((h) => flagged(h, null)),
  };
}
