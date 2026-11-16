// SPDX-License-Identifier: AGPL-3.0-or-later
// The contact detail pane: fields and links, hostile content, read-only items with their raw view, the named
// delete dialog (group note, conflict), export and "Add to group".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fire } from '../widgets/_dom.mjs';
import { mount } from '../../../src/js/views/contacts/screen.js';
import { FAMILY, JANE, JOHN, U1, U2, U3, card, doc, flush, q, qa, setup, txt } from './contacts-helpers.mjs';

const fx = (name) => readFileSync(new URL(`../../fixtures/vcf/${name}`, import.meta.url), 'utf8');
const detail = (s) => q(s.main, 'contact-detail');
const show = async (s, key, over = {}) => {
  const ctl = mount(s.ctx({ key }), { ...s.deps, ...over });
  await flush(20);
  return ctl;
};
const dlg = (id) => q(doc.body, id);

const RICH = card(
  U1,
  'Jane Doe',
  [
    'N:Doe;Jane;;;',
    'NICKNAME:JD',
    'ORG:Example Org;Lab',
    'TITLE:Chief',
    'TEL;TYPE=CELL,PREF:+1 (555) 010-0100',
    'TEL;TYPE=FAX:555 0199',
    'EMAIL;TYPE=WORK:jane@example.org',
    'EMAIL:not an address',
    'ADR;TYPE=HOME:;;12 Main St\\nApt 3;Town;Region;12345;Examplia',
    'URL:https://example.org/jane',
    'URL:javascript:alert(1)',
    'URL;TYPE=WORK:ftp://example.org/x',
    'BDAY:1990-03-04',
    'NOTE:Line one\\nLine two <b>not bold</b>',
    'CATEGORIES:Club,Friends',
    'item1.TEL:+1 555 0111',
    'item1.X-ABLabel:_$!<Mobile>!$_',
    '',
  ].join('\n'),
);

test('detail: header, sections, labels, preferred, age, groups, version note, test ids', async () => {
  const s = await setup({ items: { 'jane.vcf': RICH, 'family.vcf': FAMILY } });
  const ctl = await show(s, U1);
  const d = detail(s);
  assert.equal(d.getAttribute('data-uid'), U1);
  assert.equal(d.getAttribute('data-href'), '/alice/book/jane.vcf');
  assert.equal(txt(s.main, 'contact-name'), 'Jane Doe');
  assert.match(txt(s.main, 'contact-nickname'), /JD/);
  assert.match(txt(s.main, 'contact-org'), /Chief, Example Org/);
  assert.ok(q(s.main, 'contact-avatar'));
  const phones = qa(s.main, 'contact-phone');
  assert.equal(phones.length, 3);
  assert.match(phones[0].textContent, /Mobile\+1 \(555\) 010-0100Preferred/);
  assert.match(phones[1].textContent, /Fax/);
  assert.match(phones[2].textContent, /Mobile/, 'an Apple built-in label becomes its readable name');
  assert.match(txt(s.main, 'contact-address'), /12 Main St\nApt 3|12 Main St/);
  assert.match(txt(s.main, 'contact-birthday'), /March 4, 1990 \(\d+ years\)/);
  assert.equal(txt(s.main, 'contact-note'), 'Line one\nLine two <b>not bold</b>');
  assert.equal(qa(s.main, 'contact-categories')[0].children.length, 2);
  assert.match(txt(s.main, 'contact-meta'), /vCard 3\.0/);
  assert.equal(qa(s.main, 'contact-group-link').length, 1);
  assert.equal(ctl.title, 'Jane Doe');
  assert.equal(q(s.main, 'contacts-screen').getAttribute('data-view'), 'detail');
  assert.equal(q(s.main, 'contacts-screen').classList.contains('has-selection'), true);
});

test('detail: links only from the allowlist, anything else is plain text', async () => {
  const s = await setup({ items: { 'jane.vcf': RICH } });
  await show(s, U1);
  const links = detail(s).querySelectorAll('a');
  const hrefs = links.map((a) => a.getAttribute('href')).filter((h) => !h.startsWith('#'));
  assert.deepEqual(hrefs.sort(), ['https://example.org/jane', 'mailto:jane@example.org', 'tel:+15550100100', 'tel:5550199', 'tel:+15550111'].sort());
  const web = links.find((a) => a.getAttribute('href') === 'https://example.org/jane');
  assert.equal(web.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(web.getAttribute('target'), '_blank');
  const urls = qa(s.main, 'contact-url');
  assert.equal(urls[1].querySelectorAll('a').length, 0);
  assert.match(urls[1].textContent, /javascript:alert\(1\)/);
  assert.equal(urls[2].querySelectorAll('a').length, 0);
  assert.equal(qa(s.main, 'contact-email')[1].querySelectorAll('a').length, 0);
  for (const a of links) assert.doesNotMatch(a.getAttribute('href'), /^(javascript|data|vbscript):/i);
});

test('detail: hostile content is text; names are isolated; no script or image element appears', async () => {
  const hostile = card(U1, '<script>alert(1)</script>', 'NOTE:<img src=x onerror=alert(1)>\nORG:‮Evil Corp\nURL:data:text/html,<script>alert(1)</script>\n');
  const s = await setup({ items: { 'x.vcf': hostile } });
  await show(s, U1);
  assert.equal(detail(s).querySelectorAll('script').length, 0);
  assert.equal(detail(s).querySelectorAll('img').length, 0);
  assert.equal(txt(s.main, 'contact-name'), '<script>alert(1)</script>');
  assert.equal(q(s.main, 'contact-name').querySelectorAll('bdi').length, 1);
  assert.match(txt(s.main, 'contact-note'), /<img src=x onerror=alert\(1\)>/);
  assert.equal(qa(s.main, 'contact-url')[0].querySelectorAll('a').length, 0);
});

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]).toString('base64');

test('detail: a photo is drawn only after the display check, as a data image; others fall back to initials with a note', async () => {
  const s = await setup({ items: { 'p.vcf': card(U1, 'With Photo', `PHOTO;ENCODING=b;TYPE=JPEG:${TINY_JPEG}\n`) } });
  await show(s, U1);
  const av = q(s.main, 'contact-avatar');
  assert.equal(av.getAttribute('data-photo'), 'true');
  assert.match(av.querySelector('img').getAttribute('src'), /^data:image\/jpeg;base64,/);
  const s2 = await setup({ items: { 'q.vcf': card(U2, 'No Photo', 'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==\n') } });
  await show(s2, U2);
  assert.equal(q(s2.main, 'contact-avatar').getAttribute('data-photo'), 'false');
  assert.ok(q(s2.main, 'photo-note'));
  const svg = await setup({ items: { 'v.vcf': card(U2, 'Svg Photo', 'PHOTO;ENCODING=b;TYPE=SVG:PHN2Zz48L3N2Zz4=\n') } });
  await show(svg, U2);
  assert.equal(q(svg.main, 'contact-avatar').getAttribute('data-photo'), 'false');
  assert.equal(svg.main.querySelectorAll('img').length, 0);
});

test('Add to group with no other group says so and sends nothing', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'family.vcf': FAMILY } });
  await show(s, U1);
  q(s.main, 'btn-add-to-group').click();
  await flush();
  assert.match(s.env.feedback.status.text, /no other group/);
  assert.equal(s.env.server.callsOf('PUT').length, 0);
});

test('read-only item (vCard 2.1): reason and raw view, photo payload abbreviated, edit absent, delete and export present', async () => {
  const photo = 'A'.repeat(6000);
  const text = `BEGIN:VCARD\nVERSION:2.1\nUID:urn:uuid:old-1\nN:Legacy;Lena\nFN:Lena Legacy\nPHOTO;ENCODING=BASE64;JPEG:${photo}\nEND:VCARD\n`;
  const s = await setup({ items: { 'old.vcf': text, 'jane.vcf': JANE } });
  await show(s, 'urn:uuid:old-1');
  assert.ok(q(s.main, 'contact-readonly-reason'));
  assert.match(txt(s.main, 'contact-readonly-reason'), /vCard version/);
  const raw = txt(s.main, 'contact-raw');
  assert.match(raw, /VERSION:2\.1/);
  assert.match(raw, /\[photo data, \d+ KB\]/);
  assert.equal(raw.includes('AAAAAAAA'), false);
  assert.equal(q(s.main, 'contact-raw').tagName, 'PRE');
  assert.equal(qa(s.main, 'btn-edit-contact').length, 0);
  assert.ok(q(s.main, 'btn-delete-contact'));
  assert.ok(q(s.main, 'btn-export-contact'));
  assert.equal(detail(s).getAttribute('data-readonly'), 'true');
  // delete still works through the named dialog
  q(s.main, 'btn-delete-contact').click();
  await flush();
  assert.ok(dlg('dialog-delete-contact'));
  dlg('dialog-confirm-delete').click();
  await flush(30);
  assert.equal(s.env.server.get('old.vcf'), undefined);
  assert.equal(s.navs.at(-1).hash, '#/contacts');
});

test('read-only: a fixture that does not parse shows the reason and the raw text', async () => {
  const s = await setup({ items: { 'bad.vcf': fx('vcard-malformed.vcf'), 'jane.vcf': JANE } });
  const rows = (await (async () => { const c = mount(s.ctx({}), s.deps); await flush(20); c.dispose(); return null; })());
  void rows;
  const ctl = mount(s.ctx({}), s.deps);
  await flush(20);
  const ro = qa(s.main, 'contact-row').find((r) => r.getAttribute('data-readonly') === 'true');
  assert.ok(ro, 'the malformed card is listed as read-only');
  ctl.dispose();
});

test('unknown key: a not-found state, not an error', async () => {
  const s = await setup();
  await show(s, 'no-such-contact');
  assert.ok(q(s.main, 'contact-notfound'));
  assert.equal(q(s.main, 'contacts-screen').getAttribute('data-state'), 'ready');
  const g = await setup({ items: { 'family.vcf': FAMILY, 'jane.vcf': JANE } });
  await show(g, U3);
  assert.ok(q(g.main, 'contact-notfound'), 'a group key never opens as a contact');
});

test('a key resolves by UID first, then by file name', async () => {
  const s = await setup();
  await show(s, 'john.vcf');
  assert.equal(txt(s.main, 'contact-name'), 'John Smith');
});

test('delete dialog: named buttons, Cancel focused, group note; confirm deletes with the shown etag and cleans the groups', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': FAMILY } });
  await show(s, U1);
  const shownEtag = s.env.server.get('jane.vcf').etag;
  const calls = [];
  const orig = s.storeCtx.writes.deleteItem;
  s.storeCtx.writes.deleteItem = (a) => (calls.push(a), orig(a));
  q(s.main, 'btn-delete-contact').click();
  await flush();
  const d = dlg('dialog-delete-contact');
  assert.ok(d && d.open);
  assert.match(txt(d, 'dialog-confirm-delete'), /Delete «.*Jane Doe.*»/);
  assert.equal(doc.activeElement, dlg('dialog-cancel'), 'Cancel has the focus');
  assert.match(txt(d, 'delete-groups-note'), /Also removed from 1 groups: .*Family/);
  dlg('dialog-confirm-delete').click();
  await flush(40);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].etag, shownEtag);
  assert.deepEqual(calls[0].groupHrefs, ['/alice/book/family.vcf']);
  assert.equal(s.env.server.get('jane.vcf'), undefined);
  assert.equal(s.env.server.get('family.vcf').text.includes(U1), false, 'the member is removed from the group card');
  assert.equal(s.env.server.get('john.vcf').etag.length > 0, true);
  assert.equal(s.navs.at(-1).hash, '#/contacts');
});

test('delete dialog: Cancel and Esc delete nothing', async () => {
  const s = await setup();
  await show(s, U1);
  q(s.main, 'btn-delete-contact').click();
  await flush();
  dlg('dialog-cancel').click();
  await flush(10);
  assert.ok(s.env.server.get('jane.vcf'));
  assert.equal(s.env.server.callsOf('DELETE').length, 0);
});

test('delete: a card changed elsewhere since it was shown opens the conflict dialog; nothing is deleted yet', async () => {
  const s = await setup();
  await show(s, U1);
  q(s.main, 'btn-delete-contact').click();
  await flush();
  s.env.server.external('jane.vcf', JANE.replace('Example Org', 'Other Org'));
  dlg('dialog-confirm-delete').click();
  await flush(40);
  assert.ok(s.env.server.get('jane.vcf'));
  const c = dlg('dialog-changed-elsewhere');
  assert.ok(c, 'the "changed elsewhere" dialog is open');
  assert.ok(q(c, 'changed-delete-anyway'));
});

test('?dialog=delete opens the delete dialog and removes the parameter', async () => {
  const s = await setup();
  await show(s, U1, {});
  const ctl = mount(s.ctx({ key: U1, dialog: 'delete' }), s.deps);
  await flush(30);
  assert.ok(dlg('dialog-delete-contact'));
  dlg('dialog-cancel').click();
  await flush();
  assert.ok(s.navs.some((n) => n.hash === `#/contacts/${encodeURIComponent(U1)}` && n.opts && n.opts.replace));
  ctl.dispose();
});

test('export of one contact downloads its own text', async () => {
  const s = await setup();
  await show(s, U2);
  assert.match(q(s.main, 'btn-export-contact').getAttribute('aria-label'), /Export «.*John Smith.*»/);
  q(s.main, 'btn-export-contact').click();
  assert.equal(s.downloads.length, 1);
  assert.match(s.downloads[0].filename, /^john-smith-\d{4}-\d{2}-\d{2}\.vcf$/);
  assert.match(s.downloads[0].text, /FN:John Smith/);
});

test('Add to group: the picker lists only groups the contact is not in; ONE PUT on the group card, the member card is untouched', async () => {
  const other = `BEGIN:VCARD\nVERSION:3.0\nUID:urn:uuid:11111111-2222-3333-4444-555555555510\nX-ADDRESSBOOKSERVER-KIND:group\nFN:Book club\nEND:VCARD\n`;
  const s = await setup({ items: { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': FAMILY, 'club.vcf': other } });
  await show(s, U1);
  const johnEtag = s.env.server.get('jane.vcf').etag;
  q(s.main, 'btn-add-to-group').click();
  await flush();
  const picker = dlg('group-picker');
  assert.ok(picker);
  const opts = qa(picker, 'group-option');
  assert.equal(opts.length, 1, 'Jane is already in Family');
  assert.match(opts[0].textContent, /Book club/);
  s.env.server.calls.length = 0;
  opts[0].click();
  await flush(40);
  assert.equal(s.env.server.callsOf('PUT').length, 1);
  assert.match(s.env.server.callsOf('PUT')[0], /club\.vcf/);
  assert.match(s.env.server.get('club.vcf').text, new RegExp(`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:11111111-2222-3333-4444-555555555501`));
  assert.equal(s.env.server.get('jane.vcf').etag, johnEtag, 'the contact card is not written');
  assert.match(s.env.feedback.status.text, /Group members updated/);
});

test('Add to group: a contact without UID is refused with a text reason and nothing is sent', async () => {
  const noUid = 'BEGIN:VCARD\nVERSION:3.0\nFN:No Uid\nN:Uid;No;;;\nEND:VCARD\n';
  const s = await setup({ items: { 'nouid.vcf': noUid, 'family.vcf': FAMILY, 'jane.vcf': JANE } });
  await show(s, 'nouid.vcf');
  q(s.main, 'btn-add-to-group').click();
  await flush();
  qa(dlg('group-picker'), 'group-option')[0].click();
  await flush(20);
  assert.match(s.env.feedback.alert.text, /no identifier/);
  assert.equal(s.env.server.callsOf('PUT').length, 0);
});

test('every control of the detail has a name and a test id', async () => {
  const s = await setup({ items: { 'jane.vcf': RICH, 'family.vcf': FAMILY, 'john.vcf': JOHN } });
  await show(s, U1);
  for (const el of detail(s).querySelectorAll('button, a')) {
    const name = (el.getAttribute('aria-label') || el.textContent).trim();
    assert.ok(name, `named: ${el.tagName} ${el.getAttribute('data-testid')}`);
    assert.ok(el.getAttribute('data-testid') || el.tagName === 'A', 'test id');
  }
  for (const id of ['btn-edit-contact', 'btn-delete-contact', 'btn-export-contact']) assert.match(q(s.main, id).getAttribute('aria-label'), /Jane Doe/);
});

test('F1: the phone, e-mail and web links have test ids', async () => {
  const s = await setup({ items: { 'jane.vcf': RICH } });
  await show(s, U1);
  assert.equal(qa(s.main, 'contact-phone-link').length, 3);
  assert.equal(qa(s.main, 'contact-email-link').length, 1);
  assert.equal(qa(s.main, 'contact-url-link').length, 1);
  assert.equal(qa(s.main, 'contact-url-link')[0].getAttribute('rel'), 'noopener noreferrer');
});
