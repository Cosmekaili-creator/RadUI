// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the conflict dialog tests: the fake DOM, a translator over the real dictionaries, conflict
// results shaped like the store's, and a scriptable `writes` object. No tests in here.
import { makeDom, one } from '../widgets/_dom.mjs';
import { createI18n } from '../_i18n-all.mjs';
import { writeGate } from '../../../src/js/ui.js';

export const doc = makeDom();
export const tEn = createI18n({ lang: 'en' }).t;
export const tFr = createI18n({ lang: 'fr' }).t;
export const flush = (n = 4) => (n <= 0 ? Promise.resolve() : new Promise((r) => setImmediate(r)).then(() => flush(n - 1)));

/** Empty the page and the write gate between tests; returns a focused "opener" button. */
export function reset() {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
  writeGate.setReason('offline', null);
  writeGate.setReason('readonly', null);
  const op = doc.createElement('button');
  doc.body.append(op);
  op.focus();
  return op;
}

export const HREF = '/alice/book/a.vcf';
export const COLL = '/alice/book/';

export const rowTitle = { field: 'title', kind: 'text', mine: 'Mine', theirs: 'Theirs', both: true, changedMine: true, changedTheirs: true };
export const rowTel = { field: 'tel', kind: 'list', mine: ['+1 555 0100 (cell)', '+1 555 0111 (work)'], theirs: ['+1 555 0100 (cell)'], both: false, changedMine: true, changedTheirs: false };
export const rowPhoto = { field: 'photo', kind: 'photo', mine: 'unchanged', theirs: 'changed', both: false, changedMine: false, changedTheirs: true };

/** A store ConflictResult (status 'conflict'). */
export function conflictResult(over = {}) {
  return {
    ok: false,
    status: 'conflict',
    message: 'This item was changed elsewhere. Choose how to continue.',
    href: HREF,
    collection: COLL,
    base: { text: 'BASE', etag: '"1"' },
    theirs: { text: 'THEIRS', etag: '"2"' },
    mine: { patchSpec: { title: 'Mine' }, baseFields: {} },
    rows: [rowTitle, rowTel, rowPhoto],
    unmappable: [],
    notes: [],
    applied: [],
    noop: false,
    bothChanged: true,
    isGroup: false,
    theirsReadable: true,
    canOverwrite: true,
    canCopy: true,
    ...over,
  };
}

export const deletedResult = (over = {}) => ({
  ok: false,
  status: 'deleted-elsewhere',
  message: 'This item was deleted elsewhere. It was removed from the list.',
  href: HREF,
  collection: COLL,
  base: { text: 'BASE', etag: '"1"' },
  mine: { patchSpec: { title: 'Mine' }, baseFields: {} },
  canCopy: true,
  ...over,
});

export const changedResult = (over = {}) => ({
  ok: false,
  status: 'changed-elsewhere',
  message: 'This item was changed elsewhere before it was deleted. Nothing was deleted.',
  href: HREF,
  collection: COLL,
  theirs: { text: 'THEIRS', etag: '"2"' },
  uid: 'urn:uuid:11111111-2222-3333-4444-555555555501',
  ...over,
});

export const okResult = (status, over = {}) => ({ ok: true, status, message: '', href: HREF, ...over });

/**
 * A `writes` stand-in. `script` maps a method name to a result, a function (conflict, options) -> result|Promise,
 * or an array of those used one after another. Every call is recorded in `calls`.
 */
export function fakeWrites(script = {}) {
  const calls = [];
  const next = (name, args) => {
    calls.push({ name, args });
    let s = script[name];
    if (Array.isArray(s)) s = s.length > 1 ? s.shift() : s[0];
    if (typeof s === 'function') return s(...args);
    return s === undefined ? okResult(name) : s;
  };
  const w = { calls };
  for (const name of ['resolveReload', 'resolveOverwrite', 'resolveCopy', 'resolveDeleteAnyway']) w[name] = (...args) => next(name, args);
  return w;
}

/** A promise settled from outside. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

export const feedbackFake = () => {
  const log = [];
  return { log, dismiss: (kind) => log.push(['dismiss', kind]), setStatus: (text) => log.push(['status', text]), setAlert: (text) => log.push(['alert', text]) };
};

export const dialogOf = () => doc.body.querySelector('dialog');
export const tid = (id) => one(doc.body, id);
export const tidAll = (id) => doc.body.querySelectorAll(`[data-testid="${id}"]`);
export const text = (id) => (tid(id) ? tid(id).textContent : null);
/** Rows of the diff table as [field, data-both, mine text, theirs text]. */
export const rowsOf = () => tidAll('conflict-field-row').map((r) => [r.getAttribute('data-field'), r.getAttribute('data-both'), r.children[1].textContent, r.children[2].textContent]);
