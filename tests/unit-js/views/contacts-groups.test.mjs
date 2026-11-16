// SPDX-License-Identifier: AGPL-3.0-or-later
// The groups screens: list, create, rename, members (one PUT on the group card), unknown members kept,
// delete, read-only grantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { type, fire } from '../widgets/_dom.mjs';
import { mount } from '../../../src/js/views/contacts/groups.js';
import { FAMILY, JANE, JOHN, U1, U2, U3, card, doc, flush, q, qa, setup, txt } from './contacts-helpers.mjs';

const dlg = (id) => q(doc.body, id);
const open = async (s, params = {}, route = { name: 'groups' }) => {
  const ctl = mount(s.ctx(params, route), s.deps);
  await flush(20);
  return ctl;
};
const WITH_UNKNOWN = `BEGIN:VCARD\nVERSION:4.0\nUID:${U3}\nKIND:group\nFN:Family\nMEMBER:${U1}\nMEMBER:mailto:someone@example.org\nMEMBER:urn:uuid:99999999-0000-4000-8000-000000000000\nEND:VCARD\n`;
const BASE = { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': FAMILY };

test('list: group rows with member count and format, readable by test id; contacts are not listed', async () => {
  const s = await setup({ items: BASE });
  await open(s);
  assert.equal(q(s.main, 'groups-screen').getAttribute('data-state'), 'ready');
  const rows = qa(s.main, 'group-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].getAttribute('data-uid'), U3);
  assert.equal(rows[0].getAttribute('data-href'), '/alice/book/family.vcf');
  assert.match(rows[0].textContent, /Family.*1 member.*Apple format/);
  assert.match(rows[0].getAttribute('href'), /^#\/contacts\/groups\//);
  assert.ok(q(s.main, 'btn-new-group'));
});

test('empty book of groups: an empty state with the explanation', async () => {
  const s = await setup();
  await open(s);
  assert.ok(q(s.main, 'groups-empty'));
});

test('new group: validated name, ONE create PUT of a group card, then the group opens', async () => {
  const s = await setup({ items: BASE });
  await open(s);
  q(s.main, 'btn-new-group').click();
  const d = dlg('dialog-new-group');
  assert.ok(d && d.open);
  assert.equal(doc.activeElement, q(d, 'field-group-name'));
  q(d, 'dialog-create-group').click();
  await flush();
  assert.equal(s.env.server.callsOf('PUT').length, 0);
  assert.equal(q(d, 'field-group-name').getAttribute('aria-invalid'), 'true');
  type(q(d, 'field-group-name'), 'family');
  q(d, 'dialog-create-group').click();
  await flush();
  assert.equal(q(d, 'field-group-name').getAttribute('aria-invalid'), 'true', 'a second group with the same name is refused');
  type(q(d, 'field-group-name'), 'Book club');
  q(d, 'dialog-create-group').click();
  await flush(40);
  assert.equal(s.env.server.callsOf('PUT').length, 1);
  const created = [...s.env.server.items].find(([h]) => !/jane|john|family/.test(h));
  assert.match(created[1].text, /X-ADDRESSBOOKSERVER-KIND:group/, 'the form of the existing group cards is used');
  assert.match(created[1].text, /FN:Book club/);
  assert.match(s.navs.at(-1).hash, /^#\/contacts\/groups\//);
});

test('detail: rename, format note, members; every control is named with the group and member', async () => {
  const s = await setup({ items: BASE });
  await open(s, { key: U3 }, { name: 'group' });
  assert.ok(q(s.main, 'group-detail'));
  assert.equal(q(s.main, 'group-detail').getAttribute('data-uid'), U3);
  assert.match(txt(s.main, 'group-format-note'), /Apple/);
  assert.equal(qa(s.main, 'member-row').length, 1);
  assert.match(qa(s.main, 'btn-remove-member')[0].getAttribute('aria-label'), /Remove «.*Jane Doe.*» from «.*Family.*»/);
  const calls = [];
  const orig = s.storeCtx.writes.saveItem;
  s.storeCtx.writes.saveItem = (a) => (calls.push(a), orig(a));
  q(s.main, 'btn-rename-group').click();
  await flush(30);
  assert.equal(calls.length, 0, 'the same name is no change');
  type(q(s.main, 'field-group-rename'), 'Close family');
  fire(q(s.main, 'field-group-rename').parentNode.parentNode, 'submit');
  await flush(40);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].patch).sort(), ['fn']);
  assert.ok(calls[0].base.etag && calls[0].baseFields);
  assert.match(s.env.server.get('family.vcf').text, /FN:Close family/);
  assert.equal(s.env.server.get('jane.vcf').text, JANE.replace(/\r/g, ''), 'no contact card is written');
});

test('add a member: the picker lists non-members only (at most 50), ONE PUT on the group card', async () => {
  const s = await setup({ items: BASE });
  await open(s, { key: U3 }, { name: 'group' });
  s.env.server.calls.length = 0;
  q(s.main, 'btn-add-member').click();
  const d = dlg('member-picker');
  assert.ok(d);
  const opts = qa(d, 'member-option');
  assert.equal(opts.length, 1);
  assert.match(opts[0].getAttribute('aria-label'), /Add «.*John Smith.*» to «.*Family.*»/);
  type(q(d, 'field-member-search'), 'zzz');
  s.timers.advance(200);
  assert.equal(qa(d, 'member-option').length, 0);
  type(q(d, 'field-member-search'), 'john');
  s.timers.advance(200);
  qa(d, 'member-option')[0].click();
  await flush(40);
  assert.deepEqual(s.env.server.callsOf('PUT').map((c) => c.split('/').pop()), ['family.vcf']);
  assert.match(s.env.server.get('family.vcf').text, new RegExp(`X-ADDRESSBOOKSERVER-MEMBER:${U2}`));
  assert.equal(qa(s.main, 'member-row').length, 2);
});

test('the member picker never offers more than 50 results', async () => {
  const items = { 'family.vcf': FAMILY };
  for (let i = 0; i < 80; i += 1) items[`c${i}.vcf`] = card(`urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Person ${i}`);
  const s = await setup({ items });
  await open(s, { key: U3 }, { name: 'group' });
  q(s.main, 'btn-add-member').click();
  assert.equal(qa(dlg('member-picker'), 'member-option').length, 50);
});

test('remove a member and unknown members: one PUT; unknown members are shown and kept', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': WITH_UNKNOWN } });
  await open(s, { key: U3 }, { name: 'group' });
  assert.equal(qa(s.main, 'member-row').length, 1);
  assert.equal(qa(s.main, 'member-unknown-row').length, 2);
  assert.match(txt(s.main, 'group-format-note'), /vCard 4/);
  s.env.server.calls.length = 0;
  qa(s.main, 'btn-remove-member')[0].click();
  await flush(40);
  assert.equal(s.env.server.callsOf('PUT').length, 1);
  const text = s.env.server.get('family.vcf').text;
  assert.equal(text.includes(`MEMBER:${U1}`), false);
  assert.match(text, /MEMBER:mailto:someone@example\.org/);
  assert.match(text, /MEMBER:urn:uuid:99999999-0000-4000-8000-000000000000/);
  assert.equal(qa(s.main, 'member-unknown-row').length, 2);
});

test('delete group: named dialog; only the group card is deleted', async () => {
  const s = await setup({ items: BASE });
  await open(s, { key: U3 }, { name: 'group' });
  q(s.main, 'btn-delete-group').click();
  await flush();
  const d = dlg('dialog-delete-group');
  assert.ok(d);
  assert.equal(doc.activeElement, q(d, 'dialog-cancel'));
  assert.match(txt(d, 'dialog-confirm-delete'), /Delete «.*Family.*»/);
  q(d, 'dialog-cancel').click();
  await flush();
  assert.ok(s.env.server.get('family.vcf'));
  q(s.main, 'btn-delete-group').click();
  await flush();
  q(dlg('dialog-delete-group'), 'dialog-confirm-delete').click();
  await flush(40);
  assert.equal(s.env.server.get('family.vcf'), undefined);
  assert.ok(s.env.server.get('jane.vcf') && s.env.server.get('john.vcf'));
  assert.equal(s.env.server.callsOf('DELETE').length, 1);
  assert.equal(s.navs.at(-1).hash, '#/contacts/groups');
});

test('a group changed elsewhere before delete opens the conflict dialog', async () => {
  const s = await setup({ items: BASE });
  await open(s, { key: U3 }, { name: 'group' });
  s.env.server.external('family.vcf', FAMILY.replace('FN:Family', 'FN:Family 2'));
  q(s.main, 'btn-delete-group').click();
  await flush();
  q(dlg('dialog-delete-group'), 'dialog-confirm-delete').click();
  await flush(40);
  assert.ok(s.env.server.get('family.vcf'));
  assert.ok(dlg('dialog-changed-elsewhere'));
});

test('read-only grantee: groups and members are shown, nothing can be written', async () => {
  const s = await setup({ items: BASE, level: 'read' });
  await open(s);
  assert.equal(qa(s.main, 'btn-new-group').length, 0);
  assert.ok(q(s.main, 'groups-readonly'));
  s.dirty.length = 0;
  const ctl = await open(s, { key: U3 }, { name: 'group' });
  for (const id of ['btn-add-member', 'btn-remove-member', 'btn-delete-group', 'btn-rename-group']) assert.equal(qa(s.main, id).length, 0, id);
  assert.equal(q(s.main, 'field-group-rename').disabled, true);
  assert.equal(qa(s.main, 'member-row').length, 1);
  ctl.dispose();
});

test('unknown group key and unknown book: not-found states', async () => {
  const s = await setup({ items: BASE });
  await open(s, { key: 'nope' }, { name: 'group' });
  assert.ok(q(s.main, 'group-notfound'));
  const t = await setup({ items: BASE });
  await open(t, { ab: '/nowhere/' });
  assert.ok(q(t.main, 'contacts-notfound'));
});

test('hostile group and member names are text', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = await setup({ items: { 'jane.vcf': card(U1, evil), 'family.vcf': FAMILY.replace('Family', '<script>x</script>') } });
  await open(s, { key: U3 }, { name: 'group' });
  assert.equal(s.main.querySelectorAll('script').length + s.main.querySelectorAll('img').length, 0);
  assert.match(txt(s.main, 'member-row'), /<img src=x/);
});

test('F1: member links have a test id', async () => {
  const s = await setup({ items: BASE });
  await open(s, { key: U3 }, { name: 'group' });
  assert.equal(qa(s.main, 'group-member-link').length, 1);
});

test('minor 5: the rename starts from the card as drawn with the field; a change made elsewhere since is a conflict, not an overwrite', async () => {
  const s = await setup({ items: BASE });
  await open(s, { key: U3 }, { name: 'group' });
  const drawnEtag = s.env.server.get('family.vcf').etag;
  const calls = [];
  const orig = s.storeCtx.writes.saveItem;
  s.storeCtx.writes.saveItem = (a) => (calls.push(a), orig(a));
  s.env.server.external('family.vcf', FAMILY.replace('FN:Family', 'FN:Someone elses name')); // nobody synced yet
  type(q(s.main, 'field-group-rename'), 'My name');
  fire(q(s.main, 'field-group-rename').parentNode.parentNode, 'submit');
  await flush(40);
  assert.equal(calls[0].base.etag, drawnEtag, 'the base is the one captured when the field was drawn');
  assert.ok(dlg('dialog-conflict'), 'a conflict, not a silent overwrite');
  assert.match(s.env.server.get('family.vcf').text, /Someone elses name/);
});
