// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../../../src/js/views/collections/screen.js';
import { openDeleteDialog } from '../../../src/js/views/collections/deletedialog.js';
import { book, doc, entry, fakeDav, fakeStore, fakeWrites, flush, makeCtx, reset, shared, text, tid } from './collections-helpers.mjs';
import { type } from '../widgets/_dom.mjs';

const cal = entry({ displayName: 'Family' });
const addr = book({ displayName: 'People' });

function setup({ list = [cal, addr, shared()], writes = fakeWrites(), dav, api = null, exportResult } = {}) {
  const root = reset();
  const store = fakeStore({ list, writes, exportResult });
  const d = dav || fakeDav({ counts: { '/alice/cal/': 7, '/alice/book/': 40 }, etag: '"etag-A"' });
  const ctx = makeCtx({ root, store, dav: d, api });
  return { root, store, ctx, dav: d, writes };
}
const confirmBtn = () => tid('dialog-confirm-delete');
const typeName = (v) => type(tid('field-confirm-name'), v);

test('the dialog shows a fresh count, the grantees who lose access, export first and a typed-name field', async () => {
  const api = { grants: async () => [{ owner: 'alice', collection: 'cal', grantee: 'bob', level: 'read' }, { owner: 'alice', collection: 'cal', grantee: 'carol', level: 'readwrite' }, { owner: 'alice', collection: 'other', grantee: 'zed', level: 'read' }] };
  const { ctx, store, dav } = setup({ api });
  const p = openDeleteDialog({ ctx, store, collection: cal });
  await flush();
  assert.ok(tid('dialog-delete-collection'));
  assert.equal(dav.state.listCalls.length, 1, 'the count is read when the dialog opens');
  assert.equal(tid('delete-count').getAttribute('data-count'), '7');
  assert.match(text('delete-count'), /7 items/);
  assert.equal(tid('delete-shared').getAttribute('data-count'), '2');
  assert.match(text('delete-shared'), /bob \(read\)/);
  assert.match(text('delete-shared'), /carol \(read and write\)/);
  assert.doesNotMatch(text('delete-shared'), /zed/, 'grants on other collections are not listed');
  assert.ok(tid('btn-export-first'));
  assert.ok(tid('field-confirm-name'));
  assert.equal(confirmBtn().disabled, true);
  tid('dialog-cancel').click();
  assert.deepEqual(await p, { deleted: false, cancelled: true });
});

test('the confirm button stays disabled until the exact display name is typed', async () => {
  const { ctx, store, writes } = setup();
  const p = openDeleteDialog({ ctx, store, collection: cal });
  await flush();
  for (const wrong of ['family', 'Family ', 'Fam', '']) {
    typeName(wrong);
    assert.equal(confirmBtn().disabled, true, JSON.stringify(wrong));
  }
  typeName('Family');
  assert.equal(confirmBtn().disabled, false);
  assert.match(confirmBtn().textContent, /^Delete .*Family/);
  tid('dialog-cancel').click();
  await p;
  assert.equal(writes.calls.length, 0);
});

test('a collection without a display name asks for its technical name', async () => {
  const bare = entry({ displayName: null, name: 'cal' });
  const { ctx, store } = setup({ list: [bare] });
  const p = openDeleteDialog({ ctx, store, collection: bare });
  await flush();
  assert.match(doc.body.querySelector('dialog').textContent, /no display name/);
  typeName('Family');
  assert.equal(confirmBtn().disabled, true);
  typeName('cal');
  assert.equal(confirmBtn().disabled, false);
  tid('dialog-cancel').click();
  await p;
});

test('the delete passes the ETag read when the dialog opened as expectedEtag', async () => {
  const { ctx, store, writes, dav } = setup();
  const p = openDeleteDialog({ ctx, store, collection: cal });
  await flush();
  typeName('Family');
  confirmBtn().click();
  const out = await p;
  assert.deepEqual(writes.calls, [{ name: 'deleteCollection', args: { href: '/alice/cal/', kind: 'calendar', expectedEtag: '"etag-A"' } }]);
  assert.equal(out.deleted, true);
  assert.equal(dav.state.getCalls.length, 1);
});

test('a 412 ("changed") re-opens the dialog with the new count and the new ETag', async () => {
  let etag = '"etag-A"';
  const dav = fakeDav({ counts: { '/alice/cal/': 7 }, etag: () => etag });
  const writes = fakeWrites({
    deleteCollection: [
      () => {
        etag = '"etag-B"';
        dav.listItemEtags = async () => Array.from({ length: 9 }, (_, i) => ({ href: `/alice/cal/${i}.ics`, etag: '"x"' }));
        return { ok: false, status: 'changed', message: 'This collection changed since you opened it (9 items now). Check and confirm again.', itemCount: 9, etag: '"etag-B"' };
      },
      { ok: true, status: 'deleted', message: '', href: '/alice/cal/', grantsLeft: false },
    ],
  });
  const { ctx, store } = setup({ writes, dav });
  const p = openDeleteDialog({ ctx, store, collection: cal });
  await flush();
  typeName('Family');
  confirmBtn().click();
  await flush(10);
  assert.ok(tid('dialog-delete-collection'), 'the dialog is open again');
  assert.match(text('delete-changed'), /changed since you opened this window \(9 items now\)/);
  assert.equal(tid('delete-count').getAttribute('data-count'), '9');
  assert.equal(confirmBtn().disabled, true, 'the name must be typed again');
  typeName('Family');
  confirmBtn().click();
  const out = await p;
  assert.equal(out.deleted, true);
  assert.deepEqual(writes.calls.map((c) => c.args.expectedEtag), ['"etag-A"', '"etag-B"']);
});

test('grants that could not be revoked are a persistent alert (global scope)', async () => {
  const writes = fakeWrites({ deleteCollection: { ok: true, status: 'deleted', message: '', href: '/alice/cal/', grantsLeft: true, revoke: { ok: false, failed: [{ grantee: 'bob', unrevokable: false }, { grantee: 'carol', unrevokable: true }] } } });
  const { ctx, store } = setup({ writes });
  const p = openDeleteDialog({ ctx, store, collection: cal });
  await flush();
  typeName('Family');
  confirmBtn().click();
  const out = await p;
  assert.equal(out.deleted, true);
  assert.match(ctx.app.feedback.alert.text, /"cal" was deleted, but its sharing could not be removed for: bob, carol \(cal\)\*/);
  assert.equal(ctx.app.feedback.alert.scope, null, 'it survives navigation');
});

test('an unreadable grant list after the delete is a persistent alert too', async () => {
  const writes = fakeWrites({ deleteCollection: { ok: true, status: 'deleted', message: '', grantsLeft: true, revoke: { ok: false, failed: [], listError: { kind: 'server' } } } });
  const { ctx, store } = setup({ writes });
  const p = openDeleteDialog({ ctx, store, collection: cal });
  await flush();
  typeName('Family');
  confirmBtn().click();
  await p;
  assert.match(ctx.app.feedback.alert.text, /sharing could not be checked/);
});

test('Export first on an address book asks for the groups too and says so', async () => {
  const { ctx, store } = setup({ exportResult: { ok: true, status: 'ok', filename: 'people-2026-11-13.vcf', mime: 'text/vcard;charset=utf-8', text: 'BEGIN:VCARD\r\nEND:VCARD\r\n', count: 12, groupsExcluded: 0, empty: false, kind: 'addressbook' } });
  const p = openDeleteDialog({ ctx, store, collection: addr });
  await flush();
  globalThis.document = doc;
  try {
    tid('btn-export-first').click();
    await flush();
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(store.exportCalls.map((c) => c.includeGroups), [true]);
  assert.equal(store.exportCalls[0].collection.href, '/alice/book/');
  assert.match(text('delete-export-status'), /Exported 12 items to people-2026-11-13\.vcf/);
  assert.match(text('delete-export-status'), /Group cards are included/);
  assert.equal(tid('btn-export-first').disabled, false);
  assert.match(text('dialog-delete-collection'), /also contains the group cards/);
  tid('dialog-cancel').click();
  await p;
});

test('if the export reports excluded groups, the dialog shows it', async () => {
  const { ctx, store } = setup({ exportResult: { ok: true, status: 'ok', filename: 'people.vcf', mime: 'text/vcard', text: 'BEGIN:VCARD\r\nEND:VCARD\r\n', count: 3, groupsExcluded: 2, empty: false, kind: 'addressbook' } });
  const p = openDeleteDialog({ ctx, store, collection: addr });
  await flush();
  globalThis.document = doc;
  try {
    tid('btn-export-first').click();
    await flush();
  } finally {
    delete globalThis.document;
  }
  assert.match(text('delete-export-status'), /2 group cards were left out/);
  tid('dialog-cancel').click();
  await p;
});

test('a delete the server refuses is an alert and the collection stays', async () => {
  const writes = fakeWrites({ deleteCollection: { ok: false, status: 'forbidden', message: 'You do not have permission to do this. Your access was checked again.' } });
  const { ctx, store } = setup({ writes });
  const p = openDeleteDialog({ ctx, store, collection: cal });
  await flush();
  typeName('Family');
  confirmBtn().click();
  const out = await p;
  assert.equal(out.deleted, false);
  assert.match(ctx.app.feedback.alert.text, /permission/);
});

test('nothing is deleted when the collection cannot be read first', async () => {
  const { ctx, store, writes } = setup({ dav: fakeDav({ failCollection: true }) });
  const out = await openDeleteDialog({ ctx, store, collection: cal });
  assert.equal(out.deleted, false);
  assert.equal(out.error, true);
  assert.equal(doc.body.querySelector('dialog'), null);
  assert.match(ctx.app.feedback.alert.text, /Nothing was deleted/);
  assert.equal(writes.calls.length, 0);
});

test('a hostile display name is isolated text in the title and the typed name is the raw name', async () => {
  const evil = entry({ displayName: '<b>x</b>' });
  const { ctx, store } = setup({ list: [evil] });
  const p = openDeleteDialog({ ctx, store, collection: evil });
  await flush();
  assert.equal(doc.body.querySelector('dialog').all((e) => e.tagName === 'B').length, 0);
  typeName('<b>x</b>');
  assert.equal(confirmBtn().disabled, false);
  tid('dialog-cancel').click();
  await p;
});

test('through the screen: ?dialog=delete opens it, a successful delete drops the row and leaves the dialog route', async () => {
  const writes = fakeWrites({ deleteCollection: ({ href }) => { store.access.remove(href); return { ok: true, status: 'deleted', message: '', href, grantsLeft: false }; } });
  const root = reset();
  const store = fakeStore({ list: [cal, addr], writes });
  const dav = fakeDav({ counts: { '/alice/cal/': 2, '/alice/book/': 3 } });
  const ctx = makeCtx({ root, store, dav, route: { name: 'collections', query: { dialog: 'delete', href: '/alice/cal/' }, params: {} } });
  mount(ctx);
  await flush(8);
  assert.ok(tid('dialog-delete-collection'));
  typeName('Family');
  confirmBtn().click();
  await flush(10);
  assert.equal(writes.calls.length, 1);
  assert.deepEqual(ctx.app.nav.at(-1), { hash: '#/collections', opts: { replace: true } });
  assert.equal(doc.body.querySelectorAll('[data-testid="collection-row"]').length, 1);
});

test('through the screen: cancelling the dialog also leaves the dialog route', async () => {
  const root = reset();
  const store = fakeStore({ list: [cal] });
  const ctx = makeCtx({ root, store, route: { name: 'collections', query: { dialog: 'delete', href: '/alice/cal/' }, params: {} } });
  mount(ctx);
  await flush(8);
  tid('dialog-cancel').click();
  await flush(6);
  assert.equal(store.writes.calls.length, 0);
  assert.deepEqual(ctx.app.nav.at(-1), { hash: '#/collections', opts: { replace: true } });
});
