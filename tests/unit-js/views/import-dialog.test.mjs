// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { guessEncoding, openImportDialog } from '../../../src/js/views/importdialog.js';
import { startImport } from '../../../src/js/store/importrun.js';
import { writeGate } from '../../../src/js/ui.js';
import { book, deferred, doc, entry, fakeItemStore, fakeStore, flush, makeCtx, reset, shared, text, tid, tidAll } from './collections-helpers.mjs';
import { chooseRadio, fire, pressEscape } from '../widgets/_dom.mjs';
import * as planMod from '../../../src/js/model/importplan.js';
import * as runMod from '../../../src/js/store/importrun.js';
import * as indexMod from '../../../src/js/contacts/index.js';

const LIBS = { planImport: planMod.planImport, resolveImport: planMod.resolveImport, LIMITS: planMod.LIMITS, decodeUtf8File: runMod.decodeUtf8File, summarize: indexMod.summarize };

const card = (uid, fn, extra = '', version = '3.0') => `BEGIN:VCARD\nVERSION:${version}\nUID:${uid}\nFN:${fn}\n${extra}END:VCARD\n`;
const enc = (s) => new TextEncoder().encode(s);
const EXISTING = { '/alice/book/jane.vcf': card('u-jane', 'Jane Doe', 'EMAIL:jane@example.org\n') };

function pick(content, name = 'contacts.vcf', { bytes = null, size = null } = {}) {
  const buf = bytes || enc(content);
  const input = tid('field-import-file');
  input.files = [{ name, size: size ?? buf.byteLength, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }];
  fire(input, 'change');
  return flush(10);
}

async function open({ list = [book({ displayName: 'People' }), book({ href: '/alice/work/', name: 'work', displayName: 'Work' }), entry(), shared({ kind: 'addressbook', href: '/bob/ro/', name: 'ro', components: ['VCARD'], displayName: 'Read only book', color: null })], texts = EXISTING, preset = '/alice/book/', itemStore, importScript, reloadOk = true, lang = 'en' } = {}) {
  const root = reset();
  const is = itemStore || fakeItemStore(texts, { reloadOk });
  const store = fakeStore({ list, itemStore: is, importScript });
  const ctx = makeCtx({ root, store, lang });
  const promise = openImportDialog({ ctx, collectionHref: preset, libs: LIBS });
  await flush(8);
  return { promise, store, ctx, is };
}
const rows = () => tidAll('import-row');
const states = () => rows().map((r) => r.getAttribute('data-state'));
const confirm = () => tid('dialog-import-confirm');
const close = async (p) => {
  tid('dialog-cancel').click();
  return p;
};

test('the dialog lists writable address books only and presets the target', async () => {
  const { promise } = await open();
  assert.ok(tid('dialog-import'));
  const opts = tid('field-import-target').all((e) => e.tagName === 'OPTION');
  assert.deepEqual(opts.map((o) => o.value), ['/alice/book/', '/alice/work/']);
  assert.equal(tid('field-import-target').value, '/alice/book/');
  assert.ok(tid('field-import-file'));
  assert.equal(confirm().disabled, true);
  assert.match(text('dialog-import-confirm'), /Nothing to import/);
  await close(promise);
});

test('collectionHref null leaves the choice to the person; an unwritable preset says so', async () => {
  const a = await open({ preset: null });
  assert.equal(tid('field-import-target').value, '/alice/book/');
  assert.equal(tid('import-target-note'), null);
  await close(a.promise);
  const b = await open({ preset: '/bob/ro/' });
  assert.ok(tid('import-target-note'));
  await close(b.promise);
});

test('no writable address book: a text explanation and nothing else', async () => {
  const { promise } = await open({ list: [entry(), shared({ kind: 'addressbook', href: '/bob/ro/', components: ['VCARD'], color: null })] });
  assert.ok(tid('import-no-target'));
  assert.equal(tid('field-import-file'), null);
  assert.equal(confirm(), null);
  await close(promise);
});

test('a file that is not UTF-8 is refused with the likely encoding named', async () => {
  const { promise } = await open();
  const latin1 = Uint8Array.from([...enc('BEGIN:VCARD\nVERSION:3.0\nFN:Ren'), 0xe9, ...enc('e\nEND:VCARD\n')]);
  await pick(null, 'old.vcf', { bytes: latin1 });
  assert.equal(tid('import-error').hidden, false);
  assert.match(text('import-error'), /not UTF-8/);
  assert.match(text('import-error'), /ISO-8859-1 \/ Windows-1252/);
  assert.equal(rows().length, 0);
  assert.equal(confirm().disabled, true);
  const utf16 = Uint8Array.from([0xff, 0xfe, 0x42, 0, 0x45, 0, 0x47, 0, 0xe9, 0xd8]);
  await pick(null, 'u16.vcf', { bytes: utf16 });
  assert.match(text('import-error'), /UTF-16/);
  await close(promise);
});

test('guessEncoding', () => {
  assert.equal(guessEncoding(Uint8Array.from([0xfe, 0xff, 0, 0x41]).buffer), 'UTF-16');
  assert.equal(guessEncoding(Uint8Array.from([0x41, 0, 0x42, 0, 0x43, 0, 0x44, 0]).buffer), 'UTF-16');
  assert.equal(guessEncoding(Uint8Array.from([0x52, 0xe9, 0x6e, 0xe9]).buffer), 'ISO-8859-1 / Windows-1252');
});

test('.ics files are refused in the address book dialog, with a pointer to the calendar import', async () => {
  const { promise } = await open();
  await pick('BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:e1\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR\n', 'cal.ics');
  assert.match(text('import-error'), /calendar file \(\.ics\)/);
  assert.match(text('import-error'), /Open the import from a calendar/);
  assert.equal(rows().length, 0);
  await close(promise);
});

test('a file over the size limit is refused before it is read; an empty file and a file without cards are explained', async () => {
  const { promise } = await open();
  let read = false;
  const input = tid('field-import-file');
  input.files = [{ name: 'big.vcf', size: 11 * 1024 * 1024, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } }];
  fire(input, 'change');
  await flush();
  assert.equal(read, false);
  assert.match(text('import-error'), /larger than 10 MB/);
  await pick('', 'empty.vcf');
  assert.match(text('import-error'), /No cards were found/);
  await close(promise);
});

test('the target is read in full before the plan, and duplicates are known', async () => {
  const { promise, is, store } = await open();
  await pick(card('u-jane', 'Jane Doe') + card('u-new', 'Ada Lovelace') + card('u-new2', 'Alan Turing'));
  assert.deepEqual(is.calls, [{ reason: 'import' }], 'one full reload of the target book');
  assert.deepEqual(store.opened, [{ href: '/alice/book/', kind: 'addressbook' }]);
  assert.deepEqual(states(), ['duplicate', 'new', 'new']);
  assert.match(text('import-counts'), /2 new, 1 already in the address book/);
  assert.equal(tidAll('import-row')[0].getAttribute('data-uid'), 'u-jane');
  assert.match(text('import-summary'), /2 to create, 0 to replace, 1 skipped/);
  assert.equal(confirm().disabled, false);
  assert.equal(confirm().textContent, 'Import 2 items');
  assert.equal(tid('import-preview').getAttribute('aria-live'), 'polite');
  await close(promise);
});

test('every state has a text reason: invalid, unsupported (vCard 2.1), repeated in the file, duplicate', async () => {
  const { promise } = await open();
  const v21 = 'BEGIN:VCARD\nVERSION:2.1\nFN:Old Format\nEND:VCARD\n';
  const broken = 'BEGIN:VCARD\nVERSION:3.0\nUID:u-broken\nFN:Never closed\n';
  await pick(card('u-a', 'Alpha') + card('u-a', 'Alpha again') + v21 + card('u-jane', 'Jane Doe') + broken);
  assert.deepEqual(states(), ['new', 'file-duplicate', 'unsupported', 'duplicate', 'invalid']);
  const detail = (i) => rows()[i].querySelector('.import__notes').textContent;
  assert.match(detail(1), /same ID appears earlier/);
  assert.match(detail(2), /vCard 2\.1/);
  assert.match(detail(3), /already in the address book/);
  assert.match(detail(4), /no END:VCARD/);
  assert.match(rows()[2].textContent, /Not supported/);
  await close(promise);
});

test('hints about possible duplicates and generated IDs are shown per row', async () => {
  const { promise } = await open();
  const noUid = 'BEGIN:VCARD\nVERSION:3.0\nFN:Nameless Id\nEND:VCARD\n';
  await pick(card('u-other', 'Jane Doe') + card('u-mail', 'Someone', 'EMAIL:jane@example.org\n') + noUid);
  assert.match(rows()[0].textContent, /Same name as an existing card with another ID: .*Jane Doe/);
  assert.match(rows()[1].textContent, /Same e-mail address as an existing card with another ID: .*Jane Doe/);
  assert.match(rows()[2].textContent, /had no ID, so one is generated/);
  assert.deepEqual(states(), ['new', 'new', 'new']);
  await close(promise);
});

test('hostile names in the file are shown as text', async () => {
  const { promise } = await open();
  await pick(card('u-x', '<img src=x onerror=alert(1)>'));
  assert.equal(rows()[0].querySelector('bdi').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(tid('import-preview').all((e) => e.tagName === 'IMG').length, 0);
  await close(promise);
});

test('policies: shown only when there are duplicates; the summary and the button follow', async () => {
  const { promise } = await open();
  await pick(card('u-new', 'Ada'));
  assert.equal(tid('import-policy').hidden, true);
  await pick(card('u-jane', 'Jane Doe') + card('u-new', 'Ada'));
  assert.equal(tid('import-policy').hidden, false);
  for (const id of ['policy-skip', 'policy-replace', 'policy-keep']) assert.ok(tid(id), id);
  assert.equal(tid('policy-skip').checked, true, 'skip is the default');
  assert.match(text('import-summary'), /1 to create, 0 to replace, 1 skipped/);
  assert.equal(confirm().textContent, 'Import 1 item');
  chooseRadio(tid('policy-replace'), doc);
  assert.match(text('import-summary'), /1 to create, 1 to replace, 0 skipped/);
  assert.equal(confirm().textContent, 'Import 2 items');
  chooseRadio(tid('policy-keep'), doc);
  assert.match(text('import-summary'), /2 to create, 0 to replace, 0 skipped/);
  await close(promise);
});

test('lossy cards: a warning on the row; replacing one needs an explicit, listed confirmation', async () => {
  const { promise, store } = await open();
  const lossy = card('u-jane', 'Jane Doe', 'NOTE:one, two\n');
  await pick(lossy + card('u-new', 'Ada'));
  assert.match(rows()[0].textContent, /The server would cut or drop: NOTE/);
  chooseRadio(tid('policy-replace'), doc);
  assert.equal(tid('import-lossy').hidden, false);
  assert.equal(tidAll('import-lossy-confirm').length, 1);
  assert.match(text('import-lossy'), /Replace anyway: .*Jane Doe.* \(damaged: NOTE\)/);
  assert.equal(tid('import-lossy-confirm').checked, false);
  assert.match(text('import-summary'), /1 to create, 0 to replace, 1 skipped\./);
  assert.match(text('import-summary'), /1 replacements are skipped until you confirm them/);
  assert.equal(confirm().textContent, 'Import 1 item');
  tid('import-lossy-confirm').checked = true;
  fire(tid('import-lossy-confirm'), 'change');
  assert.match(text('import-summary'), /1 to create, 1 to replace, 0 skipped/);
  assert.equal(confirm().textContent, 'Import 2 items');
  // the confirmed UID reaches the import
  confirm().click();
  await flush();
  const opts = store.importCalls[0];
  const withConfirm = opts.resolve(opts.plan, 'replace', { collectionHref: '/alice/book/' });
  assert.deepEqual(withConfirm.operations.map((o) => o.op).sort(), ['create', 'replace']);
  await flush(4);
  await close(promise);
});

test('without the confirmation the lossy replacement is not in the resolved operations', async () => {
  const { promise, store } = await open();
  await pick(card('u-jane', 'Jane Doe', 'NOTE:one, two\n'));
  chooseRadio(tid('policy-replace'), doc);
  assert.equal(confirm().disabled, true, 'nothing left to import');
  await close(promise);
  assert.equal(store.importCalls.length, 0);
});

test('creating a lossy NEW card is flagged in the summary but allowed', async () => {
  const { promise } = await open();
  await pick(card('u-new', 'Ada', 'NOTE:a, b\n'));
  assert.match(text('import-summary'), /1 new cards will be stored with some data cut or dropped/);
  assert.equal(confirm().disabled, false);
  await close(promise);
});

test('the preview is windowed: 100 rows first, then Show more', async () => {
  const { promise } = await open({ texts: {} });
  let big = '';
  for (let i = 0; i < 230; i++) big += card(`u-${i}`, `Person ${i}`);
  await pick(big);
  assert.equal(rows().length, 100);
  assert.match(text('import-preview-note'), /Showing 100 of 230/);
  tid('btn-import-more').click();
  assert.equal(rows().length, 230);
  assert.equal(tid('btn-import-more').hidden, true);
  assert.equal(confirm().textContent, 'Import 230 items');
  await close(promise);
});

test('a failed read of the target book stops before any plan', async () => {
  const { promise } = await open({ reloadOk: false });
  await pick(card('u-new', 'Ada'));
  assert.match(text('import-error'), /could not be read, so duplicates cannot be detected/);
  assert.equal(rows().length, 0);
  assert.equal(confirm().disabled, true);
  await close(promise);
});

test('changing the target re-reads that book and re-plans', async () => {
  const stores = { '/alice/book/': fakeItemStore(EXISTING), '/alice/work/': fakeItemStore({}) };
  const root = reset();
  const store = fakeStore({ list: [book({ displayName: 'People' }), book({ href: '/alice/work/', name: 'work', displayName: 'Work' })] });
  store.stores.open = (o) => stores[o.href];
  const ctx = makeCtx({ root, store });
  const promise = openImportDialog({ ctx, collectionHref: '/alice/book/', libs: LIBS });
  await flush(8);
  await pick(card('u-jane', 'Jane Doe'));
  assert.deepEqual(states(), ['duplicate']);
  tid('field-import-target').value = '/alice/work/';
  fire(tid('field-import-target'), 'change');
  await flush(10);
  assert.deepEqual(states(), ['new']);
  assert.equal(stores['/alice/work/'].calls.length, 1);
  await close(promise);
});

test('running: progress bar and text, Cancel, then a report with one row per item', async () => {
  const run = deferred();
  let cancelled = 0;
  let progressCb = null;
  const importScript = (opts) => {
    progressCb = opts.onProgress;
    return { cancel: () => cancelled++, done: run.promise };
  };
  const { promise, store, ctx } = await open({ importScript });
  await pick(card('u-1', 'One') + card('u-2', 'Two') + card('u-3', 'Three') + card('u-jane', 'Jane Doe'));
  confirm().click();
  await flush();
  assert.equal(store.importCalls.length, 1);
  assert.equal(store.importCalls[0].collection, '/alice/book/');
  assert.equal(store.importCalls[0].policy, 'skip');
  assert.ok(tid('import-progress'));
  assert.equal(tid('import-progress').getAttribute('role'), 'progressbar');
  assert.ok(tid('import-progress-text'));
  assert.equal(tid('import-preview').hidden, true);
  assert.equal(tid('dialog-cancel').disabled, true, 'the dialog cannot be closed mid-run');
  assert.equal(pressEscape(tid('dialog-import')), 'blocked-by-cancel');
  progressCb({ phase: 'uploading', done: 2, total: 3 });
  assert.equal(tid('import-progress').getAttribute('aria-valuenow'), '2');
  assert.match(text('import-progress-text'), /2 of 3 done/);
  tid('btn-import-cancel').click();
  assert.equal(cancelled, 1);
  assert.equal(tid('import-progress-box').getAttribute('data-state'), 'cancelling');
  run.resolve({
    total: 4, created: 2, replaced: 0, skipped: 1, failed: 1, notRun: 0, cancelled: true, stopped: 'cancelled', ok: false, warnings: [], verify: { checked: 2, mismatched: [], failed: false },
    items: [
      { index: 3, result: 'skipped', reason: 'kept-existing' },
      { index: 0, href: '/alice/book/u-1.vcf', uid: 'u-1', op: 'create', result: 'created', reason: null },
      { index: 1, href: '/alice/book/u-2.vcf', uid: 'u-2', op: 'create', result: 'created', reason: null },
      { index: 2, href: '/alice/book/u-3.vcf', uid: 'u-3', op: 'create', result: 'failed', reason: 'server-error' },
    ],
  });
  await flush();
  assert.equal(tid('import-progress-box').getAttribute('data-state'), 'cancelled');
  assert.equal(tid('import-report').hidden, false);
  const reportRows = tidAll('import-report-row');
  assert.deepEqual(reportRows.map((r) => r.getAttribute('data-result')), ['failed', 'skipped', 'created', 'created'], 'problems first');
  assert.match(reportRows[0].textContent, /Three.*Failed.*server reported an error/);
  assert.match(reportRows[1].textContent, /Jane Doe.*Skipped.*existing card is kept/);
  assert.match(text('import-report-summary'), /2 created, 0 replaced, 1 skipped, 1 failed/);
  assert.match(text('import-report-stopped'), /cancelled/);
  assert.equal(tid('dialog-cancel').textContent, 'Close');
  assert.equal(tid('dialog-cancel').disabled, false);
  assert.equal(confirm().hidden, true);
  const out = await close(promise);
  assert.equal(out.done, true);
  assert.equal(out.report.created, 2);
  assert.equal(ctx.app.readiness.state, 'ready');
});

test('a run that stopped early says why in the report', async () => {
  const importScript = () => ({ cancel() {}, done: Promise.resolve({ total: 3, created: 1, replaced: 0, skipped: 0, failed: 1, notRun: 1, cancelled: false, stopped: 'network', ok: false, warnings: [{ code: 'nickname-truncated', index: 0 }], verify: { checked: 1, mismatched: [{ href: '/x', fields: ['note'] }], failed: false }, items: [{ index: 0, op: 'create', result: 'created', reason: null }, { index: 1, op: 'create', result: 'failed', reason: 'unknown-result' }] }) });
  const { promise } = await open({ importScript });
  await pick(card('u-1', 'One') + card('u-2', 'Two') + card('u-3', 'Three'));
  confirm().click();
  await flush(8);
  assert.equal(tid('import-progress-box').getAttribute('data-state'), 'error');
  assert.match(text('import-report-stopped'), /connection was lost\. 1 items were not sent/);
  assert.match(text('import-report-verify'), /1 imported cards were stored differently/);
  assert.match(text('import-report-warnings'), /several nicknames/);
  await close(promise);
});

test('a thrown import is a text error, not a hang', async () => {
  const importScript = () => ({ cancel() {}, done: Promise.reject(new Error('boom')) });
  const { promise } = await open({ importScript });
  await pick(card('u-1', 'One'));
  confirm().click();
  await flush(8);
  assert.match(text('import-error'), /could not be run/);
  assert.equal(tid('dialog-cancel').disabled, false);
  await close(promise);
});

test('the confirm button follows the write gate (offline)', async () => {
  const { promise } = await open();
  await pick(card('u-1', 'One'));
  writeGate.setReason('offline', 'offline: changes disabled');
  assert.equal(confirm().disabled, true);
  assert.match(confirm().getAttribute('aria-label'), /offline: changes disabled/);
  writeGate.setReason('offline', null);
  await close(promise);
});

test('with the real import runner: create, duplicate skipped, report rows, store told', async () => {
  const client = {
    putCalls: [],
    async putItem(href, text, opts) {
      client.putCalls.push({ href, opts });
      return { etag: `"e${client.putCalls.length}"` };
    },
    async addressbookMultiget(coll, hrefs) {
      return { items: hrefs.map((h) => ({ href: h, etag: '"m"', text: client.sent.get(h) })) };
    },
    sent: new Map(),
  };
  const origPut = client.putItem;
  client.putItem = async (href, text, opts) => {
    client.sent.set(href, text.replace(/\r\n/g, '\n'));
    return origPut(href, text, opts);
  };
  const importScript = (opts) => startImport({ client, store: null, ...opts });
  const { promise, ctx } = await open({ importScript });
  await pick(card('u-jane', 'Jane Doe') + card('u-new', 'Ada Lovelace') + card('u-new2', 'Alan Turing'));
  confirm().click();
  await flush(30);
  assert.equal(client.putCalls.length, 2);
  assert.ok(client.putCalls.every((c) => c.opts.create));
  assert.equal(tid('import-progress-box').getAttribute('data-state'), 'done');
  assert.deepEqual(tidAll('import-report-row').map((r) => r.getAttribute('data-result')).sort(), ['created', 'created', 'skipped']);
  assert.match(text('import-report-summary'), /2 created, 0 replaced, 1 skipped, 0 failed/);
  assert.equal(ctx.app.readiness.state, 'ready');
  await close(promise);
});

test('French strings', async () => {
  const { promise } = await open({ lang: 'fr' });
  assert.match(doc.body.querySelector('dialog').textContent, /Importer des contacts/);
  await pick(card('u-jane', 'Jane Doe') + card('u-new', 'Ada'));
  assert.equal(confirm().textContent, 'Importer 1 élément');
  assert.match(text('import-summary'), /1 à créer/);
  await close(promise);
});

test('closing the dialog resolves with done: false', async () => {
  const { promise } = await open();
  const out = await close(promise);
  assert.deepEqual(out, { done: false, report: null });
});

test('without injected libs the dialog loads the model itself and still opens', async () => {
  const root = reset();
  const store = fakeStore({ list: [book({ displayName: 'People' })] });
  const ctx = makeCtx({ root, store });
  const promise = openImportDialog({ ctx, collectionHref: '/alice/book/' });
  for (let i = 0; i < 200 && !tid('dialog-import'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(tid('dialog-import'));
  assert.ok(promise.dialog, 'the controller is exposed');
  await close(promise);
});

test('the element ids of the file field are per dialog, not fixed strings (test ids unchanged)', async () => {
  const a = await open();
  const ids = () => ['field-import-file', 'import-file-name'].map((k) => tid(k).getAttribute('id'));
  const first = ids();
  const labelId = doc.body.querySelector(`label[for="${tid('field-import-file').getAttribute('id')}"].field__label`).getAttribute('id');
  assert.ok(first.every((i) => i && !/^import-file(-name)?$/.test(i)), 'no fixed ids');
  assert.ok(labelId && labelId !== 'import-file-label');
  a.promise.catch(() => {});
  await open();
  const second = ids();
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[1], second[1]);
});

test('the file input is visually hidden but kept (name, test id, label); a translated button and file-name text are shown', async () => {
  const { promise } = await open();
  const input = tid('field-import-file');
  assert.match(input.getAttribute('class'), /input--file-native/);
  assert.equal(input.getAttribute('type'), 'file');
  const fieldLabel = doc.body.querySelector(`label[for="${input.getAttribute('id')}"].field__label`);
  assert.ok(fieldLabel, 'the field label still points at the input');
  assert.equal(input.getAttribute('aria-labelledby'), fieldLabel.getAttribute('id'), 'the accessible name stays the field label');
  const btn = tid('btn-choose-file');
  assert.equal(btn.tagName, 'LABEL');
  assert.equal(btn.getAttribute('for'), input.getAttribute('id'));
  assert.equal(btn.textContent, 'Choose a file');
  assert.equal(tid('import-file-name').textContent, 'No file chosen');
  assert.ok(input.getAttribute('aria-describedby').split(' ').includes(tid('import-file-name').getAttribute('id')), 'the file-name text describes the input');
  const css = readFileSync(new URL('../../../src/css/collections.css', import.meta.url), 'utf8');
  assert.match(css, /\.input--file-native:focus-visible ~ \.file-pick__btn/);
  await pick(card('u-new', 'Ada'));
  assert.match(tid('import-file-name').textContent, /contacts\.vcf/);
  const cell = rows()[0].children[3];
  assert.equal(cell.getAttribute('class'), null, 'the grid is on an inner div, not on the cell');
  assert.ok(cell.querySelector('.import__notes'));
  await close(promise);
});
