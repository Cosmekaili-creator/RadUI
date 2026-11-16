// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../../../src/js/views/collections/form.js';
import { writeGate } from '../../../src/js/ui.js';
import { book, deferred, doc, entry, fakeStore, fakeWrites, flush, makeCtx, reset, shared, text, tid, tidAll } from './collections-helpers.mjs';
import { chooseRadio, fire, type } from '../widgets/_dom.mjs';

const ROUTES = {
  cal: { name: 'collection-new-calendar', query: {}, params: {} },
  book: { name: 'collection-new-addressbook', query: {}, params: {} },
  edit: (href) => ({ name: 'collection-edit', query: { href }, params: { href } }),
};

async function open({ route = ROUTES.cal, list = [], writes = fakeWrites(), ownSpace = true, restore = null, lang = 'en' } = {}) {
  const root = reset();
  const store = fakeStore({ list, writes, ownSpace });
  const ctx = makeCtx({ root, store, route, restore, lang });
  const ctl = mount(ctx);
  await flush();
  return { root, store, ctx, ctl, writes };
}
const submit = async () => {
  fire(tid('calendar-form') || tid('addressbook-form'), 'submit');
  await flush();
};
const fill = (id, v) => type(tid(id), v);

test('the calendar form has every field, the private notice and write-gated save', async () => {
  await open();
  assert.ok(tid('calendar-form'));
  for (const id of ['field-coll-name', 'field-coll-slug', 'field-coll-desc', 'field-color', 'field-color-custom', 'field-components', 'component-vevent', 'component-vtodo', 'private-notice', 'collection-save', 'collection-cancel']) assert.ok(tid(id), id);
  assert.equal(tidAll('field-color').length, 1);
  assert.equal(doc.body.querySelectorAll('input[type="radio"]').length, 8);
  for (const id of ['orange', 'skyblue', 'green', 'yellow', 'blue', 'vermillion', 'purple', 'black']) assert.ok(tid(`colour-${id}`), id);
  assert.match(text('private-notice'), /private to its owner until it is shared/);
  assert.equal(tid('colour-blue').checked, true, 'blue is the default');
  assert.equal(tid('component-vevent').checked, true);
  assert.equal(tid('component-vtodo').checked, false);
  assert.equal(tid('collection-advanced').tagName, 'DETAILS');
  assert.ok(tid('collection-advanced').querySelector('[data-testid="field-coll-slug"]'), 'the technical name is under Advanced');
  writeGate.setReason('offline', 'offline: changes disabled');
  assert.equal(tid('collection-save').disabled, true);
  writeGate.setReason('offline', null);
});

test('the address book form has no colour and no components', async () => {
  await open({ route: ROUTES.book });
  assert.ok(tid('addressbook-form'));
  assert.equal(tid('field-color'), null);
  assert.equal(tid('field-components'), null);
  assert.ok(tid('field-coll-name') && tid('field-coll-slug') && tid('field-coll-desc'));
  assert.match(text('collection-save'), /Create address book/);
});

test('every field has a label and an error line linked with aria-describedby', async () => {
  await open();
  for (const id of ['field-coll-name', 'field-coll-desc', 'field-coll-slug', 'field-color-custom']) {
    const el = tid(id);
    assert.ok(el.getAttribute('id'), id);
    assert.ok(doc.body.querySelector(`label[for="${el.getAttribute('id')}"]`), `${id} has a label`);
    assert.match(el.getAttribute('aria-describedby'), /-error/, id);
  }
});

test('the technical name follows the display name until it is edited', async () => {
  await open();
  fill('field-coll-name', 'Café du Matin');
  assert.equal(tid('field-coll-slug').value, 'cafe-du-matin');
  fill('field-coll-slug', 'my-own');
  fill('field-coll-name', 'Something else');
  assert.equal(tid('field-coll-slug').value, 'my-own');
});

test('create a calendar: MKCALENDAR with the slug, colour, description and components, then back to the list', async () => {
  const { ctx, writes } = await open();
  fill('field-coll-name', 'Work & Play');
  fill('field-coll-desc', 'Meetings and fun');
  chooseRadio(tid('colour-green'), doc);
  tid('component-vtodo').checked = true;
  fire(tid('component-vtodo'), 'change');
  assert.equal(ctx.app.dirty.at(-1), true, 'the form is dirty');
  await submit();
  assert.equal(writes.calls.length, 1);
  assert.deepEqual(writes.calls[0], { name: 'mkcalendar', args: { home: '/alice/', name: 'work-play', displayName: 'Work & Play', color: '#009E73', description: 'Meetings and fun', components: ['VEVENT', 'VTODO'] } });
  assert.equal(ctx.app.dirty.at(-1), false, 'unsaved-input guard released before leaving');
  assert.equal(ctx.app.nav.at(-1).hash, '#/collections');
  assert.match(ctx.app.feedback.status.text, /private to you until it is shared/);
});

test('create an address book: MKCOL without colour or components; an empty description is not sent', async () => {
  const { writes, ctx } = await open({ route: ROUTES.book });
  fill('field-coll-name', 'Clients');
  await submit();
  assert.deepEqual(writes.calls[0], { name: 'mkcol', args: { home: '/alice/', name: 'clients', displayName: 'Clients', description: undefined } });
  assert.equal(ctx.app.nav.at(-1).hash, '#/collections');
});

test('an empty slug becomes calendar-<6 hex> (addressbook-<6 hex> for a book); an edited slug is used as typed', async () => {
  const a = await open();
  fill('field-coll-name', '日本語');
  await submit();
  assert.match(a.writes.calls[0].args.name, /^calendar-[0-9a-f]{6}$/);
  const b = await open({ route: ROUTES.book });
  fill('field-coll-name', '!!!');
  await submit();
  assert.match(b.writes.calls[0].args.name, /^addressbook-[0-9a-f]{6}$/);
  const c = await open();
  fill('field-coll-name', 'Whatever');
  fill('field-coll-slug', 'typed.name');
  await submit();
  assert.equal(c.writes.calls[0].args.name, 'typed.name');
});

test('validation: required name, long name, no components, bad colour, bad slug: nothing is sent', async () => {
  const { writes, ctx } = await open();
  await submit();
  assert.equal(writes.calls.length, 0);
  assert.equal(tid('field-coll-name-error').hidden, false);
  assert.match(text('field-coll-name-error'), /Enter a name/);
  assert.equal(tid('field-coll-name').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.activeElement, tid('field-coll-name'), 'focus goes to the first problem');
  assert.match(ctx.app.feedback.alert.text, /1 problem to fix/);
  fill('field-coll-name', 'x'.repeat(101));
  tid('component-vevent').checked = false;
  fill('field-color-custom', 'red;background:url(x)');
  fill('field-coll-slug', 'radui-gen-1');
  await submit();
  assert.equal(writes.calls.length, 0);
  assert.match(text('field-coll-name-error'), /at most 100/);
  assert.match(text('field-components-error'), /at least one/);
  assert.match(text('field-color-error'), /#RRGGBB/);
  assert.match(text('field-coll-slug-error'), /reserved/);
  assert.equal(tid('collection-advanced').open, true, 'Advanced opens when the technical name is the problem');
  assert.match(ctx.app.feedback.alert.text, /4 problems to fix/);
  assert.match(text('form-errors'), /4 problems/);
});

test('a hostile custom colour is never sent; a valid one is', async () => {
  const { writes } = await open();
  fill('field-coll-name', 'Hostile');
  fill('field-color-custom', 'red;background:url(x)');
  await submit();
  assert.equal(writes.calls.length, 0);
  fill('field-color-custom', '#12ab9F');
  await submit();
  assert.equal(writes.calls[0].args.color, '#12ab9F');
  assert.equal(tid('colour-blue').checked, false, 'the custom colour replaces the radio choice');
});

test('collisions are checked against the access list before MKCALENDAR', async () => {
  const { writes } = await open({ list: [entry({ href: '/alice/family/', name: 'family', displayName: 'Family Cal' }), shared({ displayName: 'Team' })] });
  fill('field-coll-name', 'family cal');
  await submit();
  assert.equal(writes.calls.length, 0);
  assert.match(text('field-coll-name-error'), /already have a collection with this name/);
  fill('field-coll-name', 'Family');
  await submit();
  assert.equal(writes.calls.length, 0);
  assert.match(text('field-coll-name-error'), /same technical name already exists/);
  fill('field-coll-name', 'Other');
  fill('field-coll-slug', 'family');
  await submit();
  assert.match(text('field-coll-slug-error'), /already have a collection with this technical name/);
  assert.equal(writes.calls.length, 0);
  fill('field-coll-name', 'Team');
  fill('field-coll-slug', 'team');
  await submit();
  assert.equal(writes.calls.length, 1, 'a collection shared with you does not block the name');
});

test('the store answering "exists" (405/409) becomes a field error and keeps the form', async () => {
  const writes = fakeWrites({ mkcalendar: { ok: false, status: 'exists', message: 'A collection with this name already exists.', field: 'name' } });
  const { ctx } = await open({ writes });
  fill('field-coll-name', 'Fresh');
  await submit();
  assert.equal(writes.calls.length, 1);
  assert.match(text('field-coll-name-error'), /technical name already exists/);
  assert.equal(tid('collection-advanced').open, true);
  assert.equal(ctx.app.nav.length, 0, 'still on the form');
  assert.equal(tid('collection-save').disabled, false, 'save is available again');
  fill('field-coll-slug', 'other');
  const w2 = writes.calls.length;
  await submit();
  assert.equal(writes.calls.length, w2 + 1);
  assert.equal(writes.calls.at(-1).args.name, 'other');
});

test('orphan grants: the store refuses; the form says so in text and stays open', async () => {
  const msg = 'Sharing left over from an earlier collection named "old" could not be removed, so the new collection was not created.';
  const writes = fakeWrites({ mkcol: { ok: false, status: 'orphan-grants', message: msg, name: 'old' } });
  const { ctx } = await open({ route: ROUTES.book, writes });
  fill('field-coll-name', 'old');
  await submit();
  assert.equal(ctx.app.feedback.alert.text, msg);
  assert.equal(text('form-errors'), msg);
  assert.equal(tid('form-errors').hidden, false);
  assert.equal(ctx.app.nav.length, 0);
  const unchecked = fakeWrites({ mkcol: { ok: false, status: 'grants-unchecked', message: 'Could not check whether the name "old" is still shared, so the collection was not created.' } });
  const again = await open({ route: ROUTES.book, writes: unchecked });
  fill('field-coll-name', 'old');
  await submit();
  assert.match(text('form-errors'), /Could not check whether/);
  assert.equal(again.ctx.app.nav.length, 0);
});

test('save is disabled while the request runs, so a double click sends one request', async () => {
  const gate = deferred();
  const writes = fakeWrites({ mkcol: () => gate.promise });
  const { ctx } = await open({ route: ROUTES.book, writes });
  fill('field-coll-name', 'Slow');
  fire(tid('addressbook-form'), 'submit');
  fire(tid('addressbook-form'), 'submit');
  await flush();
  assert.equal(tid('collection-save').disabled, true);
  assert.equal(tid('addressbook-form').getAttribute('aria-busy'), 'true');
  assert.equal(writes.calls.length, 1);
  gate.resolve({ ok: true, status: 'created', message: '' });
  await flush();
  assert.equal(ctx.app.nav.at(-1).hash, '#/collections');
});

test('an account without own space cannot create', async () => {
  await open({ ownSpace: false });
  assert.ok(tid('collection-denied'));
  assert.equal(tid('calendar-form'), null);
  assert.ok(tid('btn-back-collections'));
});

test('edit: name, description and colour only; components and the URL segment are fixed and said so', async () => {
  const { writes, ctx } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ displayName: 'Family', description: 'Chores', color: '#0072B2' })] });
  assert.equal(tid('field-coll-name').value, 'Family');
  assert.equal(tid('field-coll-desc').value, 'Chores');
  assert.equal(tid('colour-blue').checked, true);
  assert.equal(tid('field-components'), null);
  assert.equal(tid('field-coll-slug'), null);
  assert.match(text('coll-components-fixed'), /Events \+ Tasks.*cannot be changed/);
  assert.match(text('rename-note'), /only the display name/);
  assert.equal(text('coll-technical'), 'cal');
  assert.equal(tid('private-notice'), null);
  assert.match(doc.body.querySelector('h1').textContent, /Edit .*Family/);
  fill('field-coll-name', 'Family 2');
  chooseRadio(tid('colour-orange'), doc);
  fill('field-coll-desc', '');
  await submit();
  assert.deepEqual(writes.calls[0], { name: 'proppatch', args: { href: '/alice/cal/', kind: 'calendar', changes: { displayName: 'Family 2', description: null, color: '#E69F00' } } });
  assert.equal(ctx.app.nav.at(-1).hash, '#/collections');
});

test('edit: only changed properties are sent, and no request at all when nothing changed', async () => {
  const { writes, ctx } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ displayName: 'Family', color: '#0072B2FF' })] });
  await submit();
  assert.equal(writes.calls.length, 0, 'an untouched form (even with an alpha colour) sends nothing');
  assert.match(ctx.app.feedback.status.text, /No changes to save/);
  assert.equal(ctx.app.nav.at(-1).hash, '#/collections');
  const second = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ displayName: 'Family' })] });
  fill('field-coll-desc', 'New text');
  await submit();
  assert.deepEqual(second.writes.calls[0].args.changes, { description: 'New text' });
});

test('edit a custom colour: shown in the custom field, kept unless changed', async () => {
  const { writes } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ color: '#123456' })] });
  assert.equal(tid('field-color-custom').value, '#123456');
  assert.equal(doc.body.querySelectorAll('input[type="radio"]').filter((r) => r.checked).length, 0);
  fill('field-coll-name', 'Renamed');
  await submit();
  assert.deepEqual(writes.calls[0].args.changes, { displayName: 'Renamed' });
});

test('edit an address book: no colour', async () => {
  const { writes } = await open({ route: ROUTES.edit('/alice/book/'), list: [book({ displayName: 'People' })] });
  assert.ok(tid('addressbook-form'));
  assert.equal(tid('field-color'), null);
  fill('field-coll-name', 'People 2');
  await submit();
  assert.deepEqual(writes.calls[0].args, { href: '/alice/book/', kind: 'addressbook', changes: { displayName: 'People 2' } });
});

test('renaming to the name of another own collection is refused; to its own name is fine', async () => {
  const list = [entry({ displayName: 'Family' }), entry({ href: '/alice/x/', name: 'x', displayName: 'Work' })];
  const { writes } = await open({ route: ROUTES.edit('/alice/cal/'), list });
  fill('field-coll-name', 'work');
  await submit();
  assert.equal(writes.calls.length, 0);
  assert.match(text('field-coll-name-error'), /already have a collection with this name/);
  fill('field-coll-name', 'FAMILY');
  await submit();
  assert.equal(writes.calls.length, 1);
});

test('PROPPATCH refused with 403 for someone who may not: a text error, and a denied state once the level is gone', async () => {
  const writes = fakeWrites({ proppatch: { ok: false, status: 'forbidden', message: 'You do not have permission to do this. Your access was checked again.' } });
  const { ctx, store } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry()], writes });
  fill('field-coll-name', 'Renamed');
  await submit();
  assert.equal(writes.calls.length, 1);
  assert.equal(ctx.app.feedback.alert.text, 'You do not have permission to do this. Your access was checked again.');
  assert.ok(tid('collection-form-screen'));
  assert.ok(tid('calendar-form'), 'still the owner: the form stays');
  // the access refetch after the 403 took the manage right away
  store.access.set([entry({ level: 'readwrite' })]);
  await submit();
  assert.ok(tid('collection-denied'));
  assert.equal(tid('calendar-form'), null);
});

test('edit: unknown, shared or read-only collections show a text state', async () => {
  await open({ route: ROUTES.edit('/nobody/none/'), list: [entry()] });
  assert.ok(tid('collection-notfound'));
  await open({ route: ROUTES.edit('/bob/team/'), list: [shared()] });
  assert.ok(tid('collection-denied'));
  await open({ route: { name: 'collection-edit', query: {}, params: {} }, list: [entry()] });
  assert.ok(tid('collection-notfound'), 'no href at all');
});

test('hostile display name and description in the edit form stay text (values, not markup)', async () => {
  await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ displayName: '"><script>alert(1)</script>', description: '<img src=x onerror=alert(2)>', color: 'red;background:url(x)' })] });
  assert.equal(tid('field-coll-name').value, '"><script>alert(1)</script>');
  assert.equal(doc.body.all((e) => e.tagName === 'SCRIPT' || e.tagName === 'IMG').length, 0);
  assert.equal(tid('field-color-custom').value, '', 'a hostile colour is not even offered back');
});

test('snapshot and restore keep typed input across a language switch', async () => {
  const first = await open();
  fill('field-coll-name', 'Draft');
  fill('field-coll-desc', 'Half written');
  chooseRadio(tid('colour-purple'), doc);
  const snap = first.ctl.snapshot();
  assert.ok(snap && snap.fields.length > 5);
  const second = await open({ restore: snap, lang: 'fr' });
  assert.equal(tid('field-coll-name').value, 'Draft');
  assert.equal(tid('field-coll-desc').value, 'Half written');
  assert.equal(tid('colour-purple').checked, true);
  assert.equal(second.ctx.app.dirty.at(-1), true);
  assert.match(text('private-notice'), /privée/);
});

test('the form is clean again when the input is put back (no false unsaved-changes prompt)', async () => {
  const { ctx } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ displayName: 'Family' })] });
  fill('field-coll-name', 'Other');
  assert.equal(ctx.app.dirty.at(-1), true);
  fill('field-coll-name', 'Family');
  assert.equal(ctx.app.dirty.at(-1), false);
});

test('update() redraws the form for another route of the same screen', async () => {
  const { ctl, ctx, root } = await open();
  assert.ok(tid('calendar-form'));
  ctl.update({ ...ctx, root, route: ROUTES.book });
  await flush();
  assert.ok(tid('addressbook-form'));
  assert.equal(tidAll('collection-form-screen').length, 1);
});

test('the cancel control is a link back to the list', async () => {
  await open();
  assert.equal(tid('collection-cancel').getAttribute('href'), '#/collections');
});

test('edit: a calendar without a colour is not given the default colour by an untouched save', async () => {
  const { writes, ctx } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ color: null, displayName: 'Plain' })] });
  assert.equal(doc.body.querySelectorAll('input[type="radio"]').filter((r) => r.checked).length, 0, 'no swatch is pre-selected');
  assert.equal(ctx.app.dirty.at(-1) ?? false, false);
  await submit();
  assert.equal(writes.calls.length, 0, 'no PROPPATCH');
  assert.match(ctx.app.feedback.status.text, /No changes to save/);
  assert.equal(ctx.app.nav.at(-1).hash, '#/collections');
});

test('edit: a description stored with CRLF is not rewritten when untouched', async () => {
  const { writes, ctx } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ description: 'Line one\r\nLine two' })] });
  assert.equal(tid('field-coll-desc').value, 'Line one\nLine two');
  assert.equal(ctx.app.dirty.at(-1) ?? false, false, 'not dirty');
  await submit();
  assert.equal(writes.calls.length, 0);
  assert.match(ctx.app.feedback.status.text, /No changes to save/);
});

test('edit: a name with surrounding spaces on the server is not rewritten when untouched', async () => {
  const { writes } = await open({ route: ROUTES.edit('/alice/cal/'), list: [entry({ displayName: '  Padded name ' })] });
  await submit();
  assert.equal(writes.calls.length, 0);
});

test('edit: one real change sends only that property (CRLF description, padded name, no colour on the server)', async () => {
  const list = [entry({ displayName: ' Padded ', description: 'a\r\nb', color: null })];
  const a = await open({ route: ROUTES.edit('/alice/cal/'), list });
  fill('field-coll-name', 'Renamed ');
  await submit();
  assert.deepEqual(a.writes.calls[0].args.changes, { displayName: 'Renamed' });
  const b = await open({ route: ROUTES.edit('/alice/cal/'), list });
  fill('field-coll-desc', 'a\nb\nc');
  await submit();
  assert.deepEqual(b.writes.calls[0].args.changes, { description: 'a\nb\nc' });
  const c = await open({ route: ROUTES.edit('/alice/cal/'), list });
  chooseRadio(tid('colour-green'), doc);
  await submit();
  assert.deepEqual(c.writes.calls[0].args.changes, { color: '#009E73' });
});
