// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../../../src/js/views/collections/screen.js';
import { writeGate } from '../../../src/js/ui.js';
import { book, doc, entry, fakeAccess, fakeDav, fakeStore, flush, makeCtx, reset, shared, text, tid, tidAll } from './collections-helpers.mjs';
import { fire } from '../widgets/_dom.mjs';

const own = entry({ displayName: 'Family', description: 'Shared chores' });
const tasks = entry({ href: '/alice/todo/', name: 'todo', displayName: 'Chores', components: ['VTODO'], color: '#D55E00' });
const contacts = book();
const team = shared({ displayName: 'Team calendar', color: '#009E73' });
const teamRw = shared({ href: '/bob/notes/', name: 'notes', displayName: 'Notes', level: 'readwrite', readOnly: false });
const teamBook = shared({ href: '/bob/people/', name: 'people', kind: 'addressbook', components: ['VCARD'], displayName: 'Team book', level: 'read', color: null });

async function open({ list = [own, tasks, contacts, team, teamRw, teamBook], api = null, dav, ownSpace = true, route, store } = {}) {
  const root = reset();
  const st = store || fakeStore({ list, ownSpace });
  const ctx = makeCtx({ root, store: st, dav: dav || fakeDav({ counts: { '/alice/cal/': 12, '/alice/todo/': 1, '/alice/book/': 250 } }), api, route });
  const ctl = mount(ctx);
  await flush();
  return { root, ctx, ctl, st };
}
const rowFor = (href) => doc.body.querySelectorAll('[data-testid="collection-row"]').find((r) => r.getAttribute('data-href') === href);
const within = (row, id) => row.querySelector(`[data-testid="${id}"]`);

test('sections, rows and their data attributes', async () => {
  await open();
  assert.ok(tid('collections-screen'));
  assert.equal(tid('collections-screen').getAttribute('data-state'), 'ready');
  assert.equal(tidAll('collection-row', tid('collection-list-own')).length, 3);
  assert.equal(tidAll('collection-row', tid('collection-list-shared')).length, 3);
  assert.match(doc.body.textContent, /Shared with you/);
  const r = rowFor('/alice/cal/');
  assert.equal(r.getAttribute('data-kind'), 'calendar');
  assert.equal(r.getAttribute('data-owner'), 'alice');
  assert.equal(r.getAttribute('data-level'), 'own');
  assert.equal(r.getAttribute('data-components'), 'vevent,vtodo');
  assert.equal(within(r, 'collection-name').textContent, 'Family');
  assert.equal(within(r, 'collection-type').textContent, 'Events + Tasks');
  assert.equal(within(r, 'collection-desc').textContent, 'Shared chores');
  assert.equal(within(rowFor('/alice/todo/'), 'collection-type').textContent, 'Tasks');
  assert.equal(within(rowFor('/alice/book/'), 'collection-type').textContent, 'Address book');
  assert.equal(rowFor('/alice/book/').getAttribute('data-components'), 'vcard');
  assert.match(text('collections-summary'), /6 collections/);
});

test('calendars carry their colour as a custom property; address books do not', async () => {
  await open();
  const sw = rowFor('/alice/cal/').querySelector('.crow__swatch');
  assert.equal(sw.styleProps.get('--cal'), '#0072B2');
  assert.equal(rowFor('/alice/book/').querySelector('.crow__swatch').styleProps.size, 0);
});

test('actions per access level', async () => {
  await open();
  const ids = (href) => ['btn-open-collection', 'btn-edit-collection', 'btn-import', 'btn-export', 'btn-delete-collection'].filter((id) => within(rowFor(href), id));
  assert.deepEqual(ids('/alice/cal/'), ['btn-edit-collection', 'btn-import', 'btn-export', 'btn-delete-collection'], 'own calendar: the .ics import');
  assert.deepEqual(ids('/alice/book/'), ['btn-open-collection', 'btn-edit-collection', 'btn-import', 'btn-export', 'btn-delete-collection']);
  assert.deepEqual(ids('/bob/team/'), ['btn-export'], 'read-only calendar grantee: export only');
  assert.deepEqual(ids('/bob/notes/'), ['btn-import', 'btn-export'], 'read-write calendar grantee: import and export');
  assert.deepEqual(ids('/bob/people/'), ['btn-open-collection', 'btn-export'], 'read-only address book grantee: Open and Export only');
  const rwBook = shared({ href: '/bob/rw/', name: 'rw', kind: 'addressbook', components: ['VCARD'], level: 'readwrite', readOnly: false, color: null });
  await open({ list: [rwBook] });
  assert.deepEqual(['btn-open-collection', 'btn-import', 'btn-export'].filter((id) => within(rowFor('/bob/rw/'), id)), ['btn-open-collection', 'btn-import', 'btn-export']);
  assert.equal(within(rowFor('/bob/rw/'), 'btn-edit-collection'), null);
  assert.equal(within(rowFor('/bob/rw/'), 'btn-delete-collection'), null);
});

test('Open of an address book goes to the contacts screen with that book', async () => {
  await open();
  const a = within(rowFor('/alice/book/'), 'btn-open-collection');
  assert.equal(a.getAttribute('href'), '#/contacts?ab=%2Falice%2Fbook%2F');
});

test('badges: owner and read-only', async () => {
  await open();
  assert.equal(within(rowFor('/bob/team/'), 'coll-owner').textContent, 'Owned by bob');
  assert.ok(within(rowFor('/bob/team/'), 'coll-readonly'));
  assert.equal(within(rowFor('/bob/notes/'), 'coll-readonly'), null);
  assert.equal(within(rowFor('/alice/cal/'), 'coll-owner'), null);
  assert.equal(within(rowFor('/alice/cal/'), 'coll-readonly'), null);
});

test('accessible names of the row buttons name their collection', async () => {
  await open();
  const r = rowFor('/alice/cal/');
  assert.match(within(r, 'btn-edit-collection').getAttribute('aria-label'), /^Edit .*Family/);
  assert.match(within(r, 'btn-export').getAttribute('aria-label'), /^Export .*Family/);
  assert.match(within(r, 'btn-delete-collection').getAttribute('aria-label'), /^Delete .*Family/);
  assert.match(within(rowFor('/alice/book/'), 'btn-import').getAttribute('aria-label'), /^Import into .*Contacts/);
});

test('counts load lazily, two at a time, with aria-busy and data-count', async () => {
  const dav = fakeDav({ counts: { '/alice/cal/': 12, '/alice/todo/': 1, '/alice/book/': 250, '/bob/team/': 3, '/bob/notes/': 0, '/bob/people/': 7 } });
  const root = reset();
  const ctx = makeCtx({ root, store: fakeStore({ list: [own, tasks, contacts, team, teamRw, teamBook] }), dav });
  mount(ctx);
  await flush(2);
  const early = tidAll('collection-count');
  assert.ok(early.some((e) => e.getAttribute('aria-busy') === 'true'), 'busy while counting');
  await flush(12);
  assert.equal(dav.state.maxInflight, 2);
  assert.equal(dav.state.listCalls.length, 6);
  const c = within(rowFor('/alice/cal/'), 'collection-count');
  assert.equal(c.getAttribute('aria-busy'), 'false');
  assert.equal(c.getAttribute('data-count'), '12');
  assert.equal(c.textContent, '12 items');
  assert.equal(within(rowFor('/alice/todo/'), 'collection-count').textContent, '1 item');
  assert.equal(within(rowFor('/bob/notes/'), 'collection-count').getAttribute('data-count'), '0');
});

test('a failing count marks that row only', async () => {
  const { } = await open({ dav: fakeDav({ counts: { '/alice/cal/': 2 }, failCount: ['/alice/todo/'] }) });
  await flush(10);
  const bad = within(rowFor('/alice/todo/'), 'collection-count');
  assert.equal(bad.getAttribute('data-state'), 'error');
  assert.equal(bad.getAttribute('data-count'), '');
  assert.equal(within(rowFor('/alice/cal/'), 'collection-count').getAttribute('data-count'), '2');
});

test('shared-with summary from the grants, for own collections only', async () => {
  const api = { grants: async () => [{ owner: 'alice', collection: 'cal', grantee: 'carol', level: 'readwrite' }, { owner: 'alice', collection: 'cal', grantee: 'bob', level: 'read' }] };
  await open({ api });
  const sw = within(rowFor('/alice/cal/'), 'shared-with');
  assert.match(sw.textContent, /Shared with:\s*bob \(read\), carol \(read and write\)/);
  assert.equal(sw.getAttribute('data-count'), '2');
  assert.match(within(rowFor('/alice/todo/'), 'shared-with').textContent, /Private to you until it is shared/);
  assert.equal(within(rowFor('/bob/team/'), 'shared-with'), null);
  assert.equal(tidAll('btn-share').length, 3, 'a Share button on each row you own');
  assert.equal(within(rowFor('/bob/team/'), 'btn-share'), null, 'and none on what is shared with you');
});

test('shared-with: unavailable when the grants cannot be read, absent without an account service', async () => {
  await open({ api: { grants: async () => { throw Object.assign(new Error('x'), { kind: 'server' }); } } });
  assert.equal(within(rowFor('/alice/cal/'), 'shared-with').getAttribute('data-state'), 'unavailable');
  await open({ api: { grants: async () => { throw Object.assign(new Error('x'), { kind: 'notfound' }); } } });
  assert.equal(within(rowFor('/alice/cal/'), 'shared-with'), null);
});

test('technical details: href, CTag and sync token', async () => {
  await open();
  const tech = within(rowFor('/alice/cal/'), 'collection-tech');
  assert.equal(tech.tagName, 'DETAILS');
  assert.equal(within(tech, 'collection-href').textContent, '/alice/cal/');
  assert.equal(within(tech, 'collection-ctag').textContent, '"ctag-1"');
  assert.equal(within(tech, 'collection-sync-token').textContent, 'sync-token-1');
});

test('hostile names, descriptions and colours are shown as text and never applied', async () => {
  const evil = entry({ href: '/alice/evil/', name: 'evil', displayName: '<img src=x onerror=alert(1)>', description: '<script>alert(2)</script>', color: 'red;background:url(x)' });
  await open({ list: [evil] });
  const r = rowFor('/alice/evil/');
  assert.equal(within(r, 'collection-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(within(r, 'collection-desc').textContent, '<script>alert(2)</script>');
  assert.equal(r.all((e) => e.tagName === 'IMG' || e.tagName === 'SCRIPT').length, 0);
  assert.equal(r.querySelector('.crow__swatch').styleProps.size, 0, 'the colour was rejected');
  assert.equal(r.querySelector('.crow__swatch').getAttribute('style'), null);
});

test('create buttons follow the own-space rule', async () => {
  await open();
  assert.ok(tid('btn-new-calendar') && tid('btn-new-addressbook'));
  assert.equal(tid('btn-new-calendar').parentNode.hidden, false);
  assert.equal(tid('own-space-disabled').hidden, true);
  await open({ ownSpace: false, list: [team] });
  assert.equal(tid('own-space-disabled').hidden, false);
  assert.equal(tid('btn-new-calendar').parentNode.hidden, true);
  assert.equal(tid('collection-list-own').parentNode.hidden, true, 'no own section without own space');
  assert.equal(tid('collections-screen').getAttribute('data-state'), 'ready');
});

test('the create buttons navigate to the forms', async () => {
  const { ctx } = await open();
  tid('btn-new-calendar').click();
  tid('btn-new-addressbook').click();
  assert.deepEqual(ctx.app.nav.map((n) => n.hash), ['#/collections/new-calendar', '#/collections/new-addressbook']);
});

test('edit, import and delete are routes (deep-linkable dialogs)', async () => {
  const { ctx } = await open();
  within(rowFor('/alice/cal/'), 'btn-edit-collection').click();
  within(rowFor('/alice/book/'), 'btn-import').click();
  within(rowFor('/alice/cal/'), 'btn-delete-collection').click();
  assert.deepEqual(ctx.app.nav.map((n) => n.hash), ['#/collections/edit?href=%2Falice%2Fcal%2F', '#/collections?dialog=import&href=%2Falice%2Fbook%2F', '#/collections?dialog=delete&href=%2Falice%2Fcal%2F']);
});

test('write controls follow the write gate (offline, read-only)', async () => {
  await open();
  writeGate.setReason('offline', 'offline: changes disabled');
  for (const id of ['btn-new-calendar', 'btn-edit-collection', 'btn-delete-collection', 'btn-import']) {
    const el = tid(id);
    assert.equal(el.disabled, true, id);
    assert.match(el.getAttribute('aria-label'), /offline: changes disabled/, id);
  }
  assert.equal(within(rowFor('/alice/cal/'), 'btn-export').disabled, false, 'export only reads');
  assert.equal(within(rowFor('/alice/cal/'), 'btn-share').disabled, false, 'Share only opens the dialog; its Apply button is the gated one');
  writeGate.setReason('offline', null);
  assert.equal(tid('btn-new-calendar').disabled, false);
});

test('empty states: own space, and nothing shared', async () => {
  await open({ list: [] });
  assert.equal(tid('collections-empty').hidden, false);
  assert.match(text('collections-empty-text'), /no calendar or address book yet/);
  await open({ list: [], ownSpace: false });
  assert.match(text('collections-empty-text'), /Nothing has been shared with you yet/);
});

test('error state with retry', async () => {
  const root = reset();
  let fail = true;
  const store = fakeStore({ list: [own] });
  store.access.refetch = async () => (fail ? { ok: false, error: new Error('down') } : { ok: true, error: null });
  const ctx = makeCtx({ root, store });
  mount(ctx);
  await flush();
  assert.equal(tid('collections-screen').getAttribute('data-state'), 'error');
  assert.equal(tid('collections-error').hidden, false);
  assert.equal(tidAll('collection-row').length, 0);
  fail = false;
  tid('btn-retry').click();
  await flush();
  assert.equal(tid('collections-error').hidden, true);
  assert.equal(tid('collections-screen').getAttribute('data-state'), 'ready');
  assert.equal(tidAll('collection-row').length, 1);
});

test('a failed getStore is an error state, not a crash', async () => {
  const root = reset();
  const ctx = makeCtx({ root, store: fakeStore() });
  ctx.app.getStore = async () => {
    throw new Error('no store');
  };
  mount(ctx);
  await flush();
  assert.equal(tid('collections-screen').getAttribute('data-state'), 'error');
});

test('export of a calendar downloads through the store and says so', async () => {
  const root = reset();
  const store = fakeStore({ list: [own] });
  const ctx = makeCtx({ root, store });
  const anchors = [];
  const realCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const e = realCreate(tag);
    if (tag === 'a') anchors.push(e);
    return e;
  };
  globalThis.document = doc;
  try {
    mount(ctx);
    await flush();
    within(rowFor('/alice/cal/'), 'btn-export').click();
    await flush();
  } finally {
    delete globalThis.document;
    doc.createElement = realCreate;
  }
  assert.equal(store.exportCalls.length, 1);
  assert.equal(store.exportCalls[0].includeGroups, false);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].getAttribute('download'), 'family-2026-11-13.ics');
  assert.match(ctx.app.feedback.status.text, /Exported 3 items to family-2026-11-13\.ics/);
});

test('export of an empty collection downloads nothing; a failed export is an alert', async () => {
  const root = reset();
  const store = fakeStore({ list: [own], exportResult: { ok: true, status: 'ok', empty: true, count: 0, kind: 'calendar', text: '', filename: 'x.ics', mime: 'text/calendar' } });
  const ctx = makeCtx({ root, store });
  mount(ctx);
  await flush();
  within(rowFor('/alice/cal/'), 'btn-export').click();
  await flush();
  assert.match(ctx.app.feedback.status.text, /nothing to export/);
  store.exportCollection = async () => ({ ok: false, status: 'error', message: 'The export failed.' });
  within(rowFor('/alice/cal/'), 'btn-export').click();
  await flush();
  assert.equal(ctx.app.feedback.alert.text, 'The export failed.');
});

test('an address book export reports the group cards it left out', async () => {
  const root = reset();
  const store = fakeStore({ list: [contacts], exportResult: { ok: true, status: 'ok', filename: 'contacts-2026-11-13.vcf', mime: 'text/vcard;charset=utf-8', text: 'BEGIN:VCARD\r\nEND:VCARD\r\n', count: 5, groupsExcluded: 2, empty: false, kind: 'addressbook' } });
  const ctx = makeCtx({ root, store });
  globalThis.document = doc;
  try {
    mount(ctx);
    await flush();
    within(rowFor('/alice/book/'), 'btn-export').click();
    await flush();
  } finally {
    delete globalThis.document;
  }
  assert.match(ctx.app.feedback.status.text, /2 group cards were left out/);
});

test('entering with ?dialog=import for a collection that does not exist shows a text error and leaves the dialog route', async () => {
  const { ctx } = await open({ route: { name: 'collections', query: { dialog: 'import', href: '/nobody/x/' }, params: {} } });
  assert.equal(ctx.app.feedback.alert.text, 'This collection was not found.');
  assert.deepEqual(ctx.app.nav.at(-1), { hash: '#/collections', opts: { replace: true } });
  assert.equal(doc.body.querySelector('dialog'), null);
});

test('dialogs the account may not use are refused in text', async () => {
  const { ctx } = await open({ route: { name: 'collections', query: { dialog: 'delete', href: '/bob/team/' }, params: {} } });
  assert.equal(ctx.app.feedback.alert.text, 'You are not allowed to do this with this collection.');
  assert.equal(doc.body.querySelector('dialog'), null);
  // a read-only share: no import (an address book or a calendar alike)
  const second = await open({ route: { name: 'collections', query: { dialog: 'import', href: '/bob/people/' }, params: {} } });
  assert.equal(second.ctx.app.feedback.alert.text, 'You are not allowed to do this with this collection.');
});

test('?dialog=import is allowed for a calendar of the account too (the .ics import, WP C2): no "not allowed" text, the dialog opens on that calendar', async () => {
  const { ctx } = await open({ route: { name: 'collections', query: { dialog: 'import', href: '/alice/cal/' }, params: {} } });
  for (let i = 0; i < 300 && !tid('dialog-import'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(tid('dialog-import'));
  assert.equal(tid('field-import-target').value, '/alice/cal/');
  assert.equal(ctx.app.feedback.alert, null, 'no "not allowed" alert');
  tid('dialog-cancel').click();
  await flush(6);
});

test('French strings are used when the language is French', async () => {
  const root = reset();
  const ctx = makeCtx({ root, store: fakeStore({ list: [own, contacts] }), lang: 'fr' });
  mount(ctx);
  await flush();
  assert.equal(text('collections-summary'), '2 collections');
  assert.equal(within(rowFor('/alice/book/'), 'collection-type').textContent, 'Carnet d’adresses');
  assert.equal(within(rowFor('/alice/cal/'), 'btn-export').textContent, 'Exporter');
});

test('dispose stops the counts and removes listeners', async () => {
  const root = reset();
  const dav = fakeDav({ counts: {} });
  const ctx = makeCtx({ root, store: fakeStore({ list: [own, tasks, contacts, team, teamRw, teamBook] }), dav });
  const ctl = mount(ctx);
  await flush(2);
  ctl.dispose();
  await flush(10);
  assert.ok(dav.state.listCalls.length < 6, 'no new request after dispose');
});

test('update() with a dialog route opens the dialog after mount, without a remount', async () => {
  const { ctx, ctl } = await open({ list: [own, contacts] });
  assert.equal(doc.body.querySelector('dialog'), null);
  const before = tid('collections-screen');
  ctl.update({ ...ctx, route: { name: 'collections', query: { dialog: 'delete', href: '/alice/cal/' }, params: {} } });
  await flush(8);
  assert.ok(tid('dialog-delete-collection'));
  assert.equal(tid('collections-screen'), before, 'same screen element');
  tid('dialog-cancel').click();
  await flush(4);
});

test('?dialog=import opens the import dialog for that address book (and leaves the route when it closes)', async () => {
  const { ctx } = await open({ list: [contacts], route: { name: 'collections', query: { dialog: 'import', href: '/alice/book/' }, params: {} } });
  for (let i = 0; i < 300 && !tid('dialog-import'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(tid('dialog-import'));
  assert.equal(tid('field-import-target').value, '/alice/book/');
  tid('dialog-cancel').click();
  await flush(6);
  assert.deepEqual(ctx.app.nav.at(-1), { hash: '#/collections', opts: { replace: true } });
});

test('the list refreshes on window focus, at most every 10 seconds', async () => {
  const listeners = [];
  globalThis.window = {};
  try {
    const root = reset();
    const store = fakeStore({ list: [own] });
    const ctx = makeCtx({ root, store });
    let clock = 1_000;
    ctx.app.now = () => clock;
    ctx.app.session = { listen: (target, type, fn) => { listeners.push({ type, fn }); return () => listeners.splice(0); } };
    const ctl = mount(ctx);
    await flush();
    assert.equal(store.access.refetchCalls.length, 1);
    assert.equal(listeners[0].type, 'focus');
    clock += 3_000;
    listeners[0].fn();
    await flush();
    assert.equal(store.access.refetchCalls.length, 1, 'too soon');
    clock += 20_000;
    listeners[0].fn();
    await flush();
    assert.equal(store.access.refetchCalls.length, 2);
    ctl.dispose();
    assert.equal(listeners.length, 0, 'the listener is removed on dispose');
  } finally {
    delete globalThis.window;
  }
});
