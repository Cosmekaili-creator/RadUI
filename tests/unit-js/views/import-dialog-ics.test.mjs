// SPDX-License-Identifier: AGPL-3.0-or-later
// The import dialog for calendars (.ics, RUN3 C2): targets, kind, preview rows and notes, policies, lossy confirmation,
// the run through store.startImport with kind 'calendar', the report notes, French strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openImportDialog } from '../../../src/js/views/importdialog.js';
import { startImport } from '../../../src/js/store/importrun.js';
import { book, doc, entry, fakeItemStore, fakeStore, flush, makeCtx, reset, shared, text, tid, tidAll } from './collections-helpers.mjs';
import { chooseRadio, fire } from '../widgets/_dom.mjs';
import * as planMod from '../../../src/js/model/importplan.js';
import * as icsMod from '../../../src/js/model/importics.js';
import * as runMod from '../../../src/js/store/importrun.js';
import * as indexMod from '../../../src/js/contacts/index.js';

const LIBS = { planImport: planMod.planImport, planIcsImport: planMod.planIcsImport, calendarUidOf: icsMod.calendarUidOf, resolveImport: planMod.resolveImport, LIMITS: planMod.LIMITS, decodeUtf8File: runMod.decodeUtf8File, summarize: indexMod.summarize };
const FIX = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../fixtures/ics/import');
const fx = (name) => readFileSync(path.join(FIX, `import-${name}.ics`), 'utf8');
const enc = (s) => new TextEncoder().encode(s);
const ev = (uid, summary = 'Event', extra = '') => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example//EN\nBEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART:20260401T080000Z\nSUMMARY:${summary}\n${extra}END:VEVENT\nEND:VCALENDAR\n`;
const EXISTING = { '/alice/cal/a.ics': ev('series-a@example.org', 'Old weekly review'), '/alice/cal/b.ics': ev('comma-summary@example.org', 'Old fruit') };

function pick(content, name = 'cal.ics') {
  const buf = enc(content);
  const input = tid('field-import-file');
  input.files = [{ name, size: buf.byteLength, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }];
  fire(input, 'change');
  return flush(10);
}

async function open({ list = [entry({ href: '/alice/cal/', name: 'cal', displayName: 'Family' }), entry({ href: '/alice/tasks/', name: 'tasks', displayName: 'Tasks', components: ['VTODO'] }), book({ displayName: 'People' }), shared({ href: '/bob/ro/', name: 'ro', displayName: 'Read only', components: ['VEVENT'] })], texts = EXISTING, preset = '/alice/cal/', kind, importScript, lang = 'en' } = {}) {
  const root = reset();
  const is = fakeItemStore(texts);
  const store = fakeStore({ list, itemStore: is, importScript });
  const ctx = makeCtx({ root, store, lang });
  const promise = openImportDialog({ ctx, collectionHref: preset, kind, libs: LIBS });
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

test('the kind follows the preset calendar: calendar texts, .ics file filter, writable calendars only', async () => {
  const { promise, store } = await open();
  assert.match(doc.body.querySelector('dialog').textContent, /Import events and tasks/);
  const opts = tid('field-import-target').all((e) => e.tagName === 'OPTION');
  assert.deepEqual(opts.map((o) => o.value), ['/alice/cal/', '/alice/tasks/']);
  assert.equal(tid('field-import-target').value, '/alice/cal/');
  assert.match(tid('field-import-file').getAttribute('accept'), /\.ics/);
  assert.match(doc.body.querySelector('dialog').textContent, /Calendar file \(\.ics\)/);
  assert.deepEqual(store.opened, []);
  await close(promise);
});

test('without a preset, `kind` chooses the targets; no writable calendar says so', async () => {
  const a = await open({ preset: null, kind: 'calendar' });
  assert.equal(tid('field-import-target').all((e) => e.tagName === 'OPTION').length, 2);
  await close(a.promise);
  const b = await open({ preset: null, kind: 'calendar', list: [book(), shared({ href: '/bob/ro/', name: 'ro', components: ['VEVENT'] })] });
  assert.ok(tid('import-no-target'));
  assert.match(text('import-no-target'), /no calendar you can write to/);
  await close(b.promise);
});

test('a .vcf file is refused in the calendar dialog', async () => {
  const { promise } = await open();
  await pick('BEGIN:VCARD\nVERSION:3.0\nUID:u\nFN:X\nEND:VCARD\n', 'people.vcf');
  assert.match(text('import-error'), /contacts file \(\.vcf\)/);
  assert.equal(rows().length, 0);
  await close(promise);
});

test('the preview lists every item with its state, kind, series info and notes; duplicates are found by UID in the full reload', async () => {
  const { promise, is, store } = await open();
  await pick(fx('recurring-overrides') + fx('method-request') + fx('mixed-components'), 'big.ics');
  assert.deepEqual(is.calls, [{ reason: 'import' }]);
  assert.deepEqual(store.opened, [{ href: '/alice/cal/', kind: 'calendar' }]);
  assert.equal(states()[0], 'duplicate', 'series-a is already in the calendar');
  const notes = (i) => rows()[i].querySelector('.import__notes').textContent;
  assert.match(notes(0), /Event · Repeats · Changed occurrences: 2/);
  assert.match(notes(0), /already in the calendar/);
  assert.equal(rows()[0].getAttribute('data-uid'), 'series-a@example.org');
  const text2 = rows().map((r) => r.textContent).join('\n');
  assert.match(text2, /invitation method \(\W?REQUEST\W?\) is dropped/);
  assert.match(text2, /\W?VJOURNAL\W? entries are not imported/);
  assert.match(text2, /\W?VFREEBUSY\W? entries are not imported/);
  assert.match(text2, /share this ID/);
  assert.match(text2, /Only changed occurrences are present/);
  assert.match(text2, /missing VERSION or PRODID line is added/);
  assert.equal(rows().find((r) => r.getAttribute('data-component') === 'VJOURNAL').getAttribute('data-state'), 'unsupported');
  assert.match(text('import-counts'), /already in the calendar/);
  assert.match(text('import-file-info'), /entries found/);
  assert.ok(!tid('import-policy').hidden, 'duplicates exist: the policy choice is shown');
  assert.match(text('import-summary'), /to create, 0 to replace, \d+ skipped/);
  await close(promise);
});

test('an unknown time zone is flagged on its row and still imported', async () => {
  const { promise } = await open();
  await pick(fx('unknown-tzid'));
  assert.deepEqual(states(), ['new', 'new', 'new']);
  assert.match(rows()[0].textContent, /Time zone not known here \(\W?Nowhere\/Example\W?\)/);
  assert.match(text('import-summary'), /3 to create/);
  await close(promise);
});

test('replacing a lossy item needs a ticked, listed confirmation (calendar wording)', async () => {
  const { promise } = await open();
  await pick(fx('unescaped-comma'));
  assert.deepEqual(states(), ['duplicate', 'new', 'new']);
  assert.match(rows()[0].textContent, /server would cut or drop: SUMMARY/);
  chooseRadio(tid('policy-replace'), doc);
  await flush(2);
  assert.ok(!tid('import-lossy').hidden);
  assert.match(tid('import-lossy').textContent, /Replacing would damage these items/);
  assert.match(text('import-summary'), /2 to create, 0 to replace, 1 skipped/);
  assert.match(text('import-summary'), /replacements are skipped until you confirm/);
  const box = tid('import-lossy-confirm');
  box.checked = true;
  fire(box, 'change');
  await flush(2);
  assert.match(text('import-summary'), /2 to create, 1 to replace, 0 skipped/);
  await close(promise);
});

test('the run goes through store.startImport with kind calendar; the report names the dropped METHOD and the skipped components', async () => {
  const sent = [];
  const client = {
    async putItem(href, text, opts) {
      sent.push({ href, text, opts });
      return { etag: `"p${sent.length}"` };
    },
    async calendarMultiget(coll, hrefs) {
      return { items: hrefs.map((h) => ({ href: h, etag: '"x"', text: sent.find((s) => s.href === h).text.replace(/\r\n/g, '\n') })), missing: [] };
    },
  };
  const importScript = (opts) => startImport({ client, store: null, ...opts });
  const { promise, store } = await open({ importScript });
  await pick(fx('method-request') + fx('mixed-components'));
  confirm().click();
  await flush(30);
  assert.equal(store.importCalls.length, 1);
  assert.equal(store.importCalls[0].kind, 'calendar');
  assert.equal(store.importCalls[0].collection, '/alice/cal/');
  assert.ok(sent.length >= 5 && sent.every((s) => s.opts.create && !/METHOD/.test(s.text) && /\r\n/.test(s.text)));
  assert.equal(tid('import-progress-box').getAttribute('data-state'), 'done');
  assert.match(text('import-report-summary'), /created/);
  assert.match(text('import-report-notes'), /2 items carried an invitation method/);
  assert.match(text('import-report-notes'), /2 entries that are neither events nor tasks were not imported/);
  assert.ok(tidAll('import-report-row').some((r) => r.getAttribute('data-result') === 'created'));
  // the Result column keeps its words whole (CSS class import__result on the header and on every result cell)
  const resultCells = tidAll('import-report-row').map((r) => r.children[1]);
  assert.ok(resultCells.length > 0 && resultCells.every((c) => /\bimport__result\b/.test(c.getAttribute('class') || '')));
  assert.equal(tid('import-report-table').querySelectorAll('th').filter((th) => /\bimport__result\b/.test(th.getAttribute('class') || '')).length, 1, 'the header of the Result column');
  await close(promise);
});

test('a fatal plan (no calendar in the file) is explained in calendar words; an address book dialog is unchanged', async () => {
  const { promise } = await open();
  await pick('just some text\n', 'x.ics');
  assert.match(text('import-error'), /No calendar was found in this file/);
  await close(promise);
  const b = await open({ preset: '/alice/book/', texts: {} });
  assert.match(doc.body.querySelector('dialog').textContent, /Import contacts/);
  assert.match(tid('field-import-file').getAttribute('accept'), /\.vcf/);
  assert.deepEqual(b.store.opened, []);
  await close(b.promise);
});

test('French strings for the calendar kind', async () => {
  const { promise } = await open({ lang: 'fr' });
  assert.match(doc.body.querySelector('dialog').textContent, /Importer des événements et des tâches/);
  await pick(fx('method-request'));
  assert.match(rows()[0].textContent, /méthode d’invitation \(\W?REQUEST\W?\)/);
  assert.equal(confirm().textContent, 'Importer 2 éléments');
  await close(promise);
});
