// SPDX-License-Identifier: AGPL-3.0-or-later
// Executes a `.vcf` import (D-R2-16, RUN2 plan 3.4). The plan comes from importplan.js (`planImport`); the
// duplicate policy is resolved here with `resolveImport`, which runs `checkSplit` and `checkNewItem` on every
// output; `checkNewItem` runs once more right before each PUT.
//
//  - 3 requests at a time; progress callbacks; Cancel stops after the requests in flight;
//  - there are no transactions: each item is atomic, the report says what happened to each;
//  - it stops at once (no new request) on 401, offline, network loss and 403;
//  - verification is ONE addressbook-multiget (calendar-multiget for `kind: 'calendar'`, RUN3) per chunk (never
//    one GET per item): the server text is compared with what was sent through the normalised projection of
//    verify.js (a server-added VTIMEZONE is not a mismatch) and handed to the store;
//  - the `skip` policy makes a re-run an idempotent resume: items that exist are skipped, a create that
//    meets an existing href (412) counts as skipped ("exists").
//  - a card with a multi-value NICKNAME is imported and REPORTED (the server keeps only the first value).
//
// No DOM. The file is decoded by the caller with decodeUtf8File().

import { checkNewItem } from '../model/fidelity.js';
import { resolveImport } from '../model/importplan.js';
import { classify } from './errors.js';
import { createReporter } from './report.js';
import { TOUCH_ALL, lostNicknames, verifyCalendar, verifyContact } from './verify.js';

/**
 * Decode an uploaded file as UTF-8 only (the server would silently decode anything else as ISO-8859-1 and
 * damage it) and strip a byte-order mark (the server answers 400 for BOM + BEGIN:VCARD).
 * @returns {{ok: true, text: string} | {ok: false, reason: 'not-utf8'}}
 */
export function decodeUtf8File(buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch {
    return { ok: false, reason: 'not-utf8' };
  }
}

const bump = (map, key) => {
  map[key] = (map[key] || 0) + 1;
};

/**
 * @param {object} o
 * @param {object} o.client DAV client
 * @param {string} o.collection address book (or calendar, with `kind: 'calendar'`) href
 * @param {'addressbook'|'calendar'} [o.kind]
 * @param {object} o.plan result of planImport
 * @param {'skip'|'replace'|'keep-both'} [o.policy]
 * @param {object} [o.store] item store of the target (receives the server texts)
 * @returns {{cancel: () => void, done: Promise<object>}}
 */
export function startImport({ client, collection, kind = 'addressbook', plan, policy = 'skip', store = null, scheduler = null, reporter = createReporter(), gate = null, isOnline = () => true, onProgress = () => {}, concurrency = 3, chunkSize = 50, random, resolve = resolveImport, model = null, isDisposed = () => false } = {}) {
  let cancelled = false;
  // Cancelled by the caller, or the session ended (sign-out, expiry): no new request may be sent either way.
  const halted = () => cancelled || isDisposed();
  let modelPromise = model ? Promise.resolve(model) : null;
  const getModel = () => modelPromise || (modelPromise = import('../model/item.js'));
  const coll = collection.endsWith('/') ? collection : collection + '/';
  const isCalendar = kind === 'calendar';

  const done = (async () => {
    const resolved = resolve(plan, policy, { collectionHref: coll, random });
    const ops = resolved.operations;
    const report = {
      total: ops.length + resolved.skipped.length,
      created: 0,
      replaced: 0,
      skipped: resolved.skipped.length,
      failed: 0,
      notRun: 0,
      reasons: {},
      items: [],
      warnings: [],
      verify: { checked: 0, mismatched: [], failed: false },
      stopped: null,
      cancelled: false,
      ok: false,
    };
    for (const s of resolved.skipped) {
      report.items.push({ index: s.index, result: 'skipped', reason: s.reason });
      bump(report.reasons, s.reason);
    }
    for (const p of resolved.problems) report.warnings.push({ index: p.index, code: p.code });
    const doneCount = () => report.created + report.replaced + report.failed + (report.skipped - resolved.skipped.length);
    const progress = (phase) => {
      try {
        onProgress({ phase, done: doneCount(), total: ops.length, created: report.created, replaced: report.replaced, skipped: report.skipped, failed: report.failed });
      } catch {
        /* a failing view callback must not stop the import */
      }
    };
    const stop = (why) => {
      if (!report.stopped) report.stopped = why;
    };
    const record = (op, result, reason) => {
      report.items.push({ index: op.index, href: op.href, uid: op.uid, op: op.op, result, reason: reason || null });
      if (reason) bump(report.reasons, reason);
    };

    async function sendOne(op, okOps) {
      if (halted() || report.stopped) return false;
      if ((gate && gate.blocked) || !isOnline()) {
        stop('offline');
        return false;
      }
      try {
        checkNewItem(op.text, { requireProdid: false });
      } catch {
        report.failed++;
        record(op, 'failed', 'guard-failed');
        progress('uploading');
        return true;
      }
      try {
        const put = await client.putItem(op.href, op.text, op.op === 'create' ? { create: true } : { etag: op.etag });
        if (op.op === 'create') report.created++;
        else report.replaced++;
        record(op, op.op === 'create' ? 'created' : 'replaced');
        const lost = isCalendar ? [] : lostNicknames(op.text);
        if (lost.length) report.warnings.push({ index: op.index, href: op.href, code: 'nickname-truncated', values: lost });
        okOps.push({ op, etag: put.etag, nick: lost.length > 0 });
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'auth') {
          stop('auth');
          report.failed++;
          record(op, 'failed', 'auth');
        } else if (c.kind === 'network') {
          stop('network');
          report.failed++;
          record(op, 'failed', 'unknown-result');
        } else if (c.kind === 'forbidden') {
          stop('forbidden');
          report.failed++;
          record(op, 'failed', 'forbidden');
        } else if (c.kind === 'precondition') {
          if (op.op === 'create') {
            report.skipped++;
            record(op, 'skipped', 'exists');
          } else {
            report.failed++;
            record(op, 'failed', 'changed');
          }
        } else if (c.kind === 'conflict') {
          report.failed++;
          record(op, 'failed', 'uid-conflict');
        } else if (c.kind === 'toolarge') {
          report.failed++;
          record(op, 'failed', 'too-large');
        } else {
          report.failed++;
          record(op, 'failed', c.kind === 'server' ? 'server-error' : 'error');
        }
      }
      progress('uploading');
      return true;
    }

    async function verifyChunk(okOps) {
      if (!okOps.length) return;
      let got;
      try {
        const hrefs = okOps.map((x) => x.op.href);
        got = isCalendar ? await client.calendarMultiget(coll, hrefs) : await client.addressbookMultiget(coll, hrefs);
      } catch (e) {
        const c = classify(e);
        report.verify.failed = true;
        if (c.kind === 'auth') stop('auth');
        else if (c.kind === 'network') stop('network');
        return;
      }
      const m = await getModel();
      const byHref = new Map(got.items.map((i) => [i.href, i]));
      for (const { op, nick } of okOps) {
        const item = byHref.get(op.href);
        report.verify.checked++;
        if (!item) {
          report.verify.mismatched.push({ href: op.href, fields: ['missing'] });
          continue;
        }
        if (store) store.applyWrite(op.href, { etag: item.etag, text: item.text });
        let v;
        try {
          v = isCalendar ? verifyCalendar(m, { sentText: op.text, gotText: item.text, touched: TOUCH_ALL }) : verifyContact(m, { sentText: op.text, gotText: item.text });
        } catch {
          v = { ok: false, mismatched: [], unreadable: true };
        }
        let bad = v.mismatched;
        if (nick) bad = bad.filter((k) => k !== 'nickname'); // already reported as nickname-truncated
        if (!v.ok && (bad.length || v.unreadable)) report.verify.mismatched.push({ href: op.href, fields: v.unreadable ? ['unreadable'] : bad });
      }
      progress('verifying');
    }

    progress('start');
    for (let at = 0; at < ops.length; at += chunkSize) {
      if (halted() || report.stopped) break;
      const chunk = ops.slice(at, at + chunkSize);
      const okOps = [];
      let i = 0;
      const worker = async () => {
        while (i < chunk.length && !halted() && !report.stopped) {
          const op = chunk[i++];
          await sendOne(op, okOps);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, chunk.length) }, worker));
      if (!isDisposed()) await verifyChunk(okOps);
    }
    const attempted = report.items.filter((x) => x.op).length;
    report.notRun = ops.length - attempted;
    report.cancelled = halted();
    if (halted() && !report.stopped) report.stopped = 'cancelled';
    report.ok = report.failed === 0 && !report.stopped && report.verify.mismatched.length === 0;

    if (isDisposed()) return report; // the session is gone: nothing is written into the shell of the next login
    const detail = `${report.created} created, ${report.replaced} replaced, ${report.skipped} skipped, ${report.failed} failed${report.stopped ? ', stopped: ' + report.stopped : ''}`;
    reporter.log('import', coll.split('/').filter(Boolean).pop() || '', report.ok ? 'ok' : report.created + report.replaced ? 'info' : 'error', detail);
    if (report.verify.mismatched.length) {
      reporter.log('verify', coll.split('/').filter(Boolean).pop() || '', 'error', `${report.verify.mismatched.length} item(s) stored differently`);
      reporter.alert('store.err.importVerify', { count: report.verify.mismatched.length }, { persistent: true });
    } else if (report.stopped && report.stopped !== 'cancelled') {
      reporter.alert(`store.err.importStopped.${report.stopped}`, { done: doneCount(), total: ops.length }, { persistent: true });
    } else if (report.stopped === 'cancelled') {
      reporter.status('store.status.importCancelled', { done: doneCount(), total: ops.length });
    } else {
      reporter.status('store.status.importDone', { created: report.created, replaced: report.replaced, skipped: report.skipped, failed: report.failed });
    }
    if (scheduler && store && report.created + report.replaced > 0) scheduler.afterWrite(store);
    progress('end');
    return report;
  })();

  return { cancel: () => { cancelled = true; }, done };
}
