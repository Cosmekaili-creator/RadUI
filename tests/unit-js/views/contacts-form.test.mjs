// SPDX-License-Identifier: AGPL-3.0-or-later
// The contact form: opening, minimal patches, no-change saves, validation, photos, duplicates, conflicts,
// unknown results, server-loss warnings, unsaved-input guard, language-switch snapshot, read-only states.
// The real write path runs over an in-memory DAV server; only the browser image APIs are faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DavError } from '../../../src/js/dav/http.js';
import { change, choose, chooseRadio, fire, type } from '../widgets/_dom.mjs';
import { mount } from '../../../src/js/views/contacts/form.js';
import { JANE, JOHN, U1, U2, card, doc, flush, q, qa, setup, txt } from './contacts-helpers.mjs';

const fx = (n) => readFileSync(new URL(`../../fixtures/vcf/${n}`, import.meta.url), 'utf8');
const EDIT = { name: 'contact-edit' };
const NEW = { name: 'contact-new' };
const dlg = (id) => q(doc.body, id);
const submit = async (s) => {
  fire(q(s.main, 'contact-form'), 'submit');
  await flush(40);
};
const spy = (s, name) => {
  const calls = [];
  const orig = s.storeCtx.writes[name];
  s.storeCtx.writes[name] = (a) => (calls.push(a), orig(a));
  return calls;
};
const open = async (s, params, route, over = {}, extra = {}) => {
  const ctl = mount(s.ctx(params, route, extra), { ...s.deps, ...over });
  await flush(20);
  return ctl;
};
const BIG = card(
  U1,
  'Jane Doe',
  ['N:Doe;Jane;;;', 'TEL;TYPE=CELL,PREF:+1 555 0100', 'TEL;TYPE=WORK:+1 555 0101', 'EMAIL;TYPE=HOME:jane@example.org', 'ADR;TYPE=HOME:;;12 Main St\\nApt 3;Town;;12345;Examplia', 'ORG:Example Org;Lab;Team', 'NICKNAME:JD', 'CATEGORIES:Club\\, Friends,Work', 'BDAY:1990-03-04', 'NOTE:Line one\\nLine two', ''].join('\n'),
);

test('opening an existing contact: every field shows what the card holds; textareas for address street and note', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  const f = q(s.main, 'contact-form');
  assert.ok(f);
  assert.equal(q(s.main, 'field-fn').value, 'Jane Doe');
  assert.equal(q(s.main, 'field-given').value, 'Jane');
  assert.equal(q(s.main, 'field-family').value, 'Doe');
  assert.equal(q(s.main, 'field-nickname').value, 'JD');
  assert.equal(q(s.main, 'field-org').value, 'Example Org');
  assert.equal(q(s.main, 'field-department').value, 'Lab');
  assert.equal(qa(s.main, 'phone-row').length, 2);
  assert.equal(qa(s.main, 'field-phone-value')[0].value, '+1 555 0100');
  assert.equal(qa(s.main, 'field-phone-type')[0].value, 'cell');
  assert.equal(qa(s.main, 'field-phone-pref')[0].checked, true);
  assert.equal(qa(s.main, 'email-row').length, 1);
  const street = q(s.main, 'field-address-street');
  assert.equal(street.tagName, 'TEXTAREA');
  assert.equal(street.value, '12 Main St\nApt 3');
  assert.equal(q(s.main, 'field-address-extended').tagName, 'TEXTAREA');
  assert.equal(q(s.main, 'field-note').tagName, 'TEXTAREA');
  assert.equal(q(s.main, 'field-note').value, 'Line one\nLine two');
  assert.deepEqual(qa(s.main, 'category-chip').map((c) => c.textContent.replace('×', '')), ['Club, Friends', 'Work']);
  assert.equal(q(s.main, 'field-bday-input').value, '03/04/1990');
  assert.ok(q(s.main, 'contact-save') && q(s.main, 'contact-cancel') && q(s.main, 'form-errors') && q(s.main, 'btn-choose-photo') && q(s.main, 'field-photo') && q(s.main, 'photo-status'));
  assert.equal(q(s.main, 'contact-cancel').getAttribute('href'), `#/contacts/${encodeURIComponent(U1)}`);
  assert.match(q(s.main, 'contact-form').getAttribute('aria-labelledby'), /cf-title/);
  assert.equal(txt(s.main, 'contact-form-screen').includes('Edit'), true);
});

test('editing ONE field: exactly one saveItem call with base, baseFields and a minimal patch; one PUT with the opened ETag', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const calls = spy(s, 'saveItem');
  await open(s, { key: U1 }, EDIT);
  const opened = s.env.server.get('jane.vcf');
  type(q(s.main, 'field-title'), 'Chief');
  await flush();
  assert.deepEqual(s.dirty.at(-1), true, 'unsaved input is flagged to the shell');
  await submit(s);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].patch), ['title']);
  assert.deepEqual(calls[0].base, { text: opened.text, etag: opened.etag });
  assert.ok(calls[0].baseFields && calls[0].baseFields.uid === U1);
  assert.equal(s.env.server.callsOf('PUT').length, 1);
  const saved = s.env.server.get('jane.vcf').text;
  assert.match(saved, /TITLE:Chief/);
  assert.match(saved, /ADR;TYPE=HOME:;;12 Main St\\nApt 3;Town;;12345;Examplia/, 'the address survives byte for byte (line break included)');
  assert.match(saved, /ORG:Example Org;Lab;Team/);
  assert.match(saved, /CATEGORIES:Club\\, Friends,Work/);
  assert.equal(s.dirty.at(-1), false);
  assert.equal(s.navs.at(-1).hash, `#/contacts/${encodeURIComponent(U1)}`);
});

test('save with no change sends nothing and says so', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const calls = spy(s, 'saveItem');
  await open(s, { key: U1 }, EDIT);
  await submit(s);
  assert.equal(calls.length, 0);
  assert.equal(s.env.server.callsOf('PUT').length, 0);
  assert.equal(s.env.feedback.status.text, 'No changes to save.');
  assert.equal(s.navs.length, 0, 'the form stays open');
});

test('FN follows the name parts until it is edited; a typed FN is left alone', async () => {
  const s = await setup({ items: {} });
  await open(s, {}, NEW);
  type(q(s.main, 'field-given'), 'Ada');
  type(q(s.main, 'field-family'), 'Lovelace');
  assert.equal(q(s.main, 'field-fn').value, 'Ada Lovelace');
  type(q(s.main, 'field-fn'), 'Countess A.');
  type(q(s.main, 'field-family'), 'Byron');
  assert.equal(q(s.main, 'field-fn').value, 'Countess A.');
});

test('a card whose FN differs from its parts keeps its FN when a part is edited', async () => {
  const s = await setup({ items: { 'a.vcf': card(U1, 'Doc Jane', 'N:Doe;Jane;;;\n') } });
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-given'), 'Janet');
  assert.equal(q(s.main, 'field-fn').value, 'Doc Jane');
});

test('validation: messages next to the fields with aria-describedby, a summary with links, nothing sent', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const calls = spy(s, 'saveItem');
  await open(s, { key: U1 }, EDIT);
  type(qa(s.main, 'field-email-value')[0], 'not-an-address');
  type(qa(s.main, 'field-phone-value')[1], 'abc');
  await submit(s);
  assert.equal(calls.length, 0);
  const em = qa(s.main, 'field-email-value')[0];
  assert.equal(em.getAttribute('aria-invalid'), 'true');
  const errId = em.getAttribute('aria-describedby');
  const errEl = s.main.querySelector(`#${errId}`);
  assert.ok(errEl && !errEl.hidden);
  assert.match(errEl.textContent, /e-mail address such as name@example\.org/);
  assert.equal(qa(s.main, 'field-phone-value')[1].getAttribute('aria-invalid'), 'true');
  const summary = q(s.main, 'form-errors');
  assert.equal(summary.hidden, false);
  assert.equal(summary.getAttribute('role'), 'alert');
  assert.match(summary.textContent, /2 problems to correct/);
  assert.equal(qa(s.main, 'form-error-link').length, 2);
  assert.match(qa(s.main, 'form-error-link')[0].textContent, /Phone 2|E-mail 1/);
  assert.equal(doc.activeElement === em || doc.activeElement === qa(s.main, 'field-phone-value')[1], true, 'focus goes to the first problem');
  qa(s.main, 'form-error-link')[1].click();
  // correcting the problem and saving clears the messages
  type(em, 'jane@example.org');
  type(qa(s.main, 'field-phone-value')[1], '+1 555 0101');
  await submit(s);
  assert.equal(q(s.main, 'form-errors') === null || q(s.main, 'form-errors').hidden, true);
});

test('a new contact needs a name, a given or family name or an organisation', async () => {
  const s = await setup({ items: {} });
  const calls = spy(s, 'createItem');
  await open(s, {}, NEW);
  await submit(s);
  assert.equal(calls.length, 0);
  assert.match(txt(s.main, 'form-errors'), /Enter a name or an organisation/);
  assert.equal(q(s.main, 'field-fn').getAttribute('aria-invalid'), 'true');
});

test('birthday: typed with a real date check; a future date and a non-date are refused', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const calls = spy(s, 'saveItem');
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-bday-input'), '31/02/1990');
  await submit(s);
  assert.equal(calls.length, 0);
  assert.equal(q(s.main, 'form-errors').hidden, false);
  type(q(s.main, 'field-bday-input'), '01/01/2999');
  change(q(s.main, 'field-bday-input'));
  await submit(s);
  assert.match(txt(s.main, 'form-errors'), /future/);
  type(q(s.main, 'field-bday-input'), '1991-03-05');
  change(q(s.main, 'field-bday-input'));
  await submit(s);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].patch.bday, { year: 1991, month: 3, day: 5 });
  assert.match(s.env.server.get('jane.vcf').text, /BDAY:1991-03-05/);
});

test('new contact: create with phone and e-mail rows, FN composed, version 3.0 for an empty book, redirect to the new contact', async () => {
  const s = await setup({ items: {} });
  const calls = spy(s, 'createItem');
  await open(s, {}, NEW);
  type(q(s.main, 'field-given'), 'Ada');
  type(q(s.main, 'field-family'), 'Lovelace');
  q(s.main, 'btn-add-phone').click();
  type(q(s.main, 'field-phone-value'), '+44 20 7946 0000');
  q(s.main, 'btn-add-email').click();
  type(q(s.main, 'field-email-value'), 'ada@example.org');
  assert.equal(q(s.main, 'field-email-type').value, 'home');
  await submit(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].version, '3.0');
  assert.equal(calls[0].fields.fn, 'Ada Lovelace');
  const [href] = [...s.env.server.items.keys()];
  const text = s.env.server.items.get(href).text;
  assert.match(text, /VERSION:3\.0/);
  assert.match(text, /TEL;TYPE=CELL:\+44 20 7946 0000/);
  assert.match(text, /EMAIL;TYPE=HOME:ada@example\.org/);
  const uid = /UID:(.*)/.exec(text)[1];
  assert.equal(s.navs.at(-1).hash, `#/contacts/${encodeURIComponent(uid)}`);
});

test('a new contact in a vCard 4.0 book is a 4.0 card (majority version)', async () => {
  const s = await setup({ items: { 'a.vcf': card(U2, 'Four Oh', '', '4.0'), 'b.vcf': card('urn:uuid:b', 'Four Two', '', '4.0') } });
  const calls = spy(s, 'createItem');
  await open(s, {}, NEW);
  type(q(s.main, 'field-fn'), 'Brand New');
  await submit(s);
  assert.equal(calls[0].version, '4.0');
});

test('the duplicate hint links to a contact with the same name, e-mail or phone and never blocks', async () => {
  const s = await setup();
  await open(s, {}, NEW);
  const hint = q(s.main, 'duplicate-hint');
  assert.equal(hint.hidden, true);
  type(q(s.main, 'field-fn'), 'Jane Doe');
  s.timers.advance(400);
  assert.equal(hint.hidden, false);
  assert.equal(hint.getAttribute('role'), 'status');
  assert.match(hint.querySelector('a').getAttribute('href'), /^#\/contacts\//);
  type(q(s.main, 'field-fn'), 'Somebody Else');
  s.timers.advance(400);
  assert.equal(hint.hidden, true);
});

// ------------------------------------------------------------------------------------------------ photos

const fakePhoto = { mime: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]).toString('base64'), bytes: 2048, width: 16, height: 16 };

test('photo: choose goes through processPhoto only, shows the preview and sends the re-encoded image; remove sends null', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE } });
  const calls = spy(s, 'saveItem');
  const processed = [];
  await open(s, { key: U1 }, EDIT, { processPhoto: async (file) => (processed.push(file), fakePhoto), photoApi: {} });
  const input = q(s.main, 'field-photo');
  assert.equal(input.getAttribute('accept'), 'image/jpeg,image/png,image/webp,image/gif');
  assert.equal(q(s.main, 'btn-remove-photo').hidden, true);
  input.files = [{ name: 'me.jpg', size: 10, type: 'image/jpeg' }];
  fire(input, 'change');
  assert.equal(q(s.main, 'contact-save').disabled, true, 'Save waits for the photo');
  await flush();
  assert.equal(processed.length, 1);
  assert.equal(q(s.main, 'contact-save').disabled, false);
  assert.equal(q(s.main, 'photo-preview').getAttribute('data-photo'), 'true');
  assert.match(txt(s.main, 'photo-status'), /Photo ready \(16×16, 2 KB\)/);
  assert.equal(q(s.main, 'btn-remove-photo').hidden, false);
  await submit(s);
  assert.equal(calls[0].patch.photo.mime, 'image/jpeg');
  assert.equal(calls[0].patch.photo.base64, fakePhoto.base64);
  assert.match(s.env.server.get('jane.vcf').text, /PHOTO;ENCODING=b;TYPE=JPEG:/);
  // now remove it
  const s2 = await setup({ items: { 'p.vcf': s.env.server.get('jane.vcf').text } });
  const c2 = spy(s2, 'saveItem');
  await open(s2, { key: U1 }, EDIT);
  assert.equal(q(s2.main, 'btn-remove-photo').hidden, false);
  q(s2.main, 'btn-remove-photo').click();
  assert.match(txt(s2.main, 'photo-status'), /removed when you save/);
  await submit(s2);
  assert.equal(c2[0].patch.photo, null);
  assert.equal(/PHOTO/.test(s2.env.server.get('p.vcf').text), false);
});

test('photo: a refused file shows the reason and changes nothing', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE } });
  const calls = spy(s, 'saveItem');
  const { PhotoError } = await import('../../../src/js/contacts/photo.js');
  await open(s, { key: U1 }, EDIT, { processPhoto: async () => { throw new PhotoError('unsupported-type'); }, photoApi: {} });
  const input = q(s.main, 'field-photo');
  input.files = [{ name: 'x.svg', size: 10, type: 'image/svg+xml' }];
  fire(input, 'change');
  await flush();
  assert.match(txt(s.main, 'photo-status'), /Choose a JPEG, PNG, WebP or GIF/);
  await submit(s);
  assert.equal(calls.length, 0, 'no photo, no other change: nothing to save');
});

// ------------------------------------------------------------------------------------------------ conflicts and failures

test('a real conflict opens the conflict dialog; "Overwrite with mine" saves on top of their version', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  s.env.server.external('jane.vcf', BIG.replace('Example Org', 'Other Org'));
  await submit(s);
  const d = dlg('dialog-conflict');
  assert.ok(d, 'the conflict dialog is open');
  assert.ok(qa(d, 'conflict-field-row').length >= 1);
  assert.equal(s.env.server.get('jane.vcf').text.includes('TITLE'), false, 'nothing was overwritten yet');
  q(d, 'conflict-overwrite').click();
  await flush(60);
  const t = s.env.server.get('jane.vcf').text;
  assert.match(t, /TITLE:Chief/);
  assert.match(t, /ORG:Other Org/, 'their change survives');
  assert.equal(s.navs.at(-1).hash, `#/contacts/${encodeURIComponent(U1)}`);
});

test('a lost response: the second save finds the change already on the server and counts as saved', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  s.env.server.failAfter('PUT', new DavError('network'));
  await submit(s);
  assert.match(txt(s.main, 'form-errors'), /not saved/);
  assert.match(s.env.feedback.alert.text, /Result unknown/);
  assert.equal(s.navs.length, 0);
  assert.match(s.env.server.get('jane.vcf').text, /TITLE:Chief/, 'the first attempt did go through');
  const etagAfterFirst = s.env.server.get('jane.vcf').etag;
  await submit(s);
  assert.equal(dlg('dialog-conflict'), null, 'no conflict dialog for an already-saved change');
  assert.equal(s.navs.at(-1).hash, `#/contacts/${encodeURIComponent(U1)}`);
  assert.equal(s.env.server.get('jane.vcf').etag, etagAfterFirst, 'the second attempt was refused (412) and wrote nothing');
});

test('unknown result on create: the form locks and the retry reuses the SAME href and UID (no duplicate card)', async () => {
  const s = await setup({ items: {} });
  const calls = spy(s, 'createItem');
  await open(s, {}, NEW);
  type(q(s.main, 'field-fn'), 'Retry Rita');
  s.env.server.failAfter('PUT', new DavError('network'));
  await submit(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].retry, null);
  assert.equal(s.env.server.items.size, 1, 'the first attempt was applied');
  const fieldset = q(s.main, 'contact-form').querySelector('fieldset');
  assert.equal(fieldset.disabled, true, 'the fields cannot be edited while a retry is pending');
  assert.equal(txt(s.main, 'contact-save'), 'Try again');
  await submit(s);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].retry && calls[1].retry.href && calls[1].retry.uid, 'the retry token of the result is passed back');
  assert.equal(s.env.server.items.size, 1, 'still ONE card');
  assert.equal(s.navs.at(-1).hash, `#/contacts/${encodeURIComponent(calls[1].retry.uid)}`);
});

test('Save is disabled while a request is in flight and a second submit sends nothing', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const orig = s.storeCtx.writes.saveItem;
  let release;
  let n = 0;
  s.storeCtx.writes.saveItem = (a) => (n += 1, new Promise((res) => { release = () => res(orig(a)); }));
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  fire(q(s.main, 'contact-form'), 'submit');
  await flush();
  assert.equal(q(s.main, 'contact-save').disabled, true);
  assert.equal(q(s.main, 'contact-form').getAttribute('aria-busy'), 'true');
  fire(q(s.main, 'contact-form'), 'submit');
  await flush();
  assert.equal(n, 1);
  release();
  await flush(40);
  assert.equal(q(s.main, 'contact-save').disabled, false);
});

test('a multi-value NICKNAME: a warning before saving; Cancel sends nothing; confirming passes acceptNicknameLoss', async () => {
  const s = await setup({ items: { 'n.vcf': fx('vcard30-multi-nickname.vcf') } });
  const calls = spy(s, 'saveItem');
  const uid = 'urn:uuid:22222222-3333-4444-5555-000000000011';
  await open(s, { key: uid }, EDIT);
  assert.match(txt(s.main, 'contact-form'), /2 more nicknames/);
  type(q(s.main, 'field-title'), 'Boss');
  await submit(s);
  const d = dlg('dialog-nickname-loss');
  assert.ok(d);
  assert.match(d.textContent, /Nicky.*Nine|Nicky, Nine/);
  assert.equal(calls.length, 0);
  q(d, 'dialog-cancel').click();
  await flush();
  assert.equal(calls.length, 0);
  await submit(s);
  q(dlg('dialog-nickname-loss'), 'dialog-confirm-loss').click();
  await flush(60);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].acceptNicknameLoss, true);
});

test('a failed save keeps the form open with the reason and sends the user to it (no alert is lost off-screen)', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  s.env.server.fail('PUT', new DavError('forbidden', { status: 403 }));
  await submit(s);
  assert.equal(s.navs.length, 0);
  assert.match(txt(s.main, 'form-errors'), /not saved/);
  assert.match(txt(s.main, 'form-errors'), /permission/);
  assert.equal(doc.activeElement, q(s.main, 'form-errors'));
});

// ------------------------------------------------------------------------------------------------ rows, dates, categories

test('rows: adding and removing, preferred radio, custom label, type select keeps other TYPE tokens', async () => {
  const text = card(U1, 'Jane Doe', 'N:Doe;Jane;;;\nTEL;TYPE=CELL,VOICE:+1 555 0100\nTEL;TYPE=WORK:+1 555 0101\n');
  const s = await setup({ items: { 'jane.vcf': text } });
  const calls = spy(s, 'saveItem');
  await open(s, { key: U1 }, EDIT);
  assert.equal(qa(s.main, 'btn-remove-phone')[1].getAttribute('aria-label'), 'Remove phone 2');
  choose(qa(s.main, 'field-phone-type')[0], 'home');
  chooseRadio(qa(s.main, 'field-phone-pref')[1], doc);
  q(s.main, 'btn-add-phone').click();
  assert.equal(qa(s.main, 'phone-row').length, 3);
  type(qa(s.main, 'field-phone-value')[2], '+1 555 0102');
  choose(qa(s.main, 'field-phone-type')[2], 'custom');
  type(qa(s.main, 'field-phone-custom')[2], 'Boat');
  await submit(s);
  assert.equal(calls.length, 1);
  const t = s.env.server.get('jane.vcf').text;
  assert.match(t, /TEL;TYPE=(?:HOME,VOICE|VOICE,HOME):\+1 555 0100/i, 'VOICE survives a type change');
  assert.match(t, /\+1 555 0101/);
  assert.match(t, /Boat/);
});

test('removing a row removes that property only', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  qa(s.main, 'btn-remove-phone')[1].click();
  await submit(s);
  const t = s.env.server.get('jane.vcf').text;
  assert.equal(t.includes('555 0101'), false);
  assert.match(t, /555 0100/);
  assert.match(t, /ADR;TYPE=HOME:;;12 Main St\\nApt 3/);
});

test('categories are chips: add with Enter or the button, remove with its named button; a comma stays inside the category', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const calls = spy(s, 'saveItem');
  await open(s, { key: U1 }, EDIT);
  const input = q(s.main, 'field-categories');
  type(input, 'Book club, east');
  const ev = fire(input, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, true, 'Enter never submits the form');
  assert.equal(qa(s.main, 'category-chip').length, 3);
  assert.equal(qa(s.main, 'btn-remove-category')[1].getAttribute('aria-label').includes('Work'), true);
  qa(s.main, 'btn-remove-category')[1].click();
  await submit(s);
  assert.deepEqual(calls[0].patch.categories, ['Club, Friends', 'Book club, east']);
  assert.match(s.env.server.get('jane.vcf').text, /CATEGORIES:Club\\, Friends,Book club\\, east/);
});

test('anniversary: writable on vCard 4.0, read-only with a note on 3.0', async () => {
  const s3 = await setup({ items: { 'a.vcf': fx('vcard30-anniversary-xabdate.vcf') } });
  const uid3 = /UID:(.*)/.exec(fx('vcard30-anniversary-xabdate.vcf'))[1].trim();
  await open(s3, { key: uid3 }, EDIT);
  const ro = q(s3.main, 'field-anniversary');
  assert.equal(ro.getAttribute('readonly') !== null || ro.readOnly === true, true);
  assert.match(txt(s3.main, 'contact-form'), /vCard 3\.0, which has no anniversary field/);
  const s4 = await setup({ items: { 'b.vcf': fx('vcard40-anniversary.vcf') } });
  const uid4 = /UID:(.*)/.exec(fx('vcard40-anniversary.vcf'))[1].trim();
  await open(s4, { key: uid4 }, EDIT);
  assert.ok(q(s4.main, 'field-anniversary-input'), 'a typed date field');
});

test('a text-valued birthday stays read-only until Replace is chosen', async () => {
  const s = await setup({ items: { 'a.vcf': fx('vcard30-text-bday.vcf') } });
  const uid = /UID:(.*)/.exec(fx('vcard30-text-bday.vcf'))[1].trim();
  const calls = spy(s, 'saveItem');
  await open(s, { key: uid }, EDIT);
  assert.ok(q(s.main, 'btn-replace-bday'));
  type(q(s.main, 'field-title'), 'X');
  await submit(s);
  assert.equal('bday' in calls[0].patch, false, 'the text value is not rewritten');
});

test('a card with an empty ADR row and an unrelated edit: the empty row is not removed', async () => {
  const text = fx('vcard30-empty-rows.vcf');
  const uid = /UID:(.*)/.exec(text)[1].trim();
  const s = await setup({ items: { 'e.vcf': text } });
  const calls = spy(s, 'saveItem');
  await open(s, { key: uid }, EDIT);
  type(q(s.main, 'field-title'), 'Edited');
  await submit(s);
  assert.deepEqual(Object.keys(calls[0].patch), ['title']);
});

// ------------------------------------------------------------------------------------------------ guard, snapshot, states

test('the unsaved-input guard: dirty while the form differs, clean again after reverting', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  await flush();
  assert.equal(s.dirty.at(-1), true);
  type(q(s.main, 'field-title'), '');
  await flush();
  assert.equal(s.dirty.at(-1), false);
});

test('snapshot/restore (language switch): typed input, added rows, chips and the opened base survive', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const ctl = await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  q(s.main, 'btn-add-phone').click();
  type(qa(s.main, 'field-phone-value')[2], '+1 555 0102');
  type(q(s.main, 'field-categories'), 'Extra');
  fire(q(s.main, 'field-categories'), 'keydown', { key: 'Enter' });
  const openedEtag = s.env.server.get('jane.vcf').etag;
  const snap = ctl.snapshot();
  assert.equal(snap.base.etag, openedEtag);
  s.env.server.external('jane.vcf', BIG.replace('Example Org', 'Other Org')); // a sync meanwhile
  await s.storeCtx.scheduler.syncNow(s.storeCtx.stores.get('/alice/book/'), 'poll');
  ctl.dispose();
  const calls = spy(s, 'saveItem');
  await open(s, { key: U1 }, EDIT, {}, { restore: snap });
  assert.equal(q(s.main, 'field-title').value, 'Chief');
  assert.equal(qa(s.main, 'phone-row').length, 3);
  assert.equal(qa(s.main, 'field-phone-value')[2].value, '+1 555 0102');
  assert.equal(qa(s.main, 'category-chip').length, 3);
  await flush();
  assert.equal(s.dirty.at(-1), true);
  await submit(s);
  assert.equal(calls[0].base.etag, openedEtag, 'the save still starts from the version the form first opened with');
  assert.ok(dlg('dialog-conflict'), 'so the change made elsewhere is a conflict, not a silent overwrite');
});

test('states: read-only book, read-only item, unknown contact, unknown book, group card', async () => {
  let s = await setup({ level: 'read' });
  await open(s, { key: U1 }, EDIT);
  assert.ok(q(s.main, 'contact-form-readonly'));
  assert.equal(q(s.main, 'contact-form'), null);
  s = await setup({ items: { 'old.vcf': 'BEGIN:VCARD\nVERSION:2.1\nUID:old-1\nN:Legacy;Lena\nFN:Lena Legacy\nEND:VCARD\n' } });
  await open(s, { key: 'old-1' }, EDIT);
  assert.ok(q(s.main, 'contact-form-readonly'));
  assert.match(txt(s.main, 'contact-form-readonly'), /vCard version/);
  s = await setup();
  await open(s, { key: 'nope' }, EDIT);
  assert.ok(q(s.main, 'contact-notfound'));
  await open(s, { key: U1, ab: '/elsewhere/' }, EDIT);
  assert.ok(q(s.main, 'contact-form-notfound'));
  const g = await setup({ items: { 'f.vcf': 'BEGIN:VCARD\nVERSION:3.0\nUID:g1\nX-ADDRESSBOOKSERVER-KIND:group\nFN:Family\nEND:VCARD\n', 'jane.vcf': JANE } });
  await open(g, { key: 'g1' }, EDIT);
  assert.ok(q(g.main, 'contact-notfound'), 'a group card never opens in the contact form');
});

test('every control of the form has a name and a test id', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  const f = q(s.main, 'contact-form');
  const labelFor = (el) => f.querySelectorAll('label').find((l) => l.getAttribute('for') && l.getAttribute('for') === el.getAttribute('id'));
  for (const el of f.querySelectorAll('input, select, textarea, button, a')) {
    const type = el.getAttribute('type');
    const lbl = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && f.querySelector(`#${el.getAttribute('aria-labelledby').split(' ')[0]}`)) || labelFor(el) || el.textContent.trim();
    assert.ok(lbl, `named: ${el.tagName} ${el.getAttribute('data-testid')} ${type}`);
    assert.ok(el.getAttribute('data-testid'), `test id: ${el.tagName} ${type} ${el.textContent.slice(0, 20)}`);
  }
});

test('hostile values are put into fields as text and never interpreted', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = await setup({ items: { 'e.vcf': card(U1, evil, `NOTE:${evil}\n`) } });
  await open(s, { key: U1 }, EDIT);
  assert.equal(s.main.querySelectorAll('img').length, 0);
  assert.equal(q(s.main, 'field-fn').value, evil);
  assert.equal(q(s.main, 'field-note').value, evil);
});

// ------------------------------------------------------------------------------------------------ QC fix order A

test('F4: an impossible birthday on blur moves nothing, and the first Create click still works', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  const form = q(s.main, 'contact-form');
  const shape = () => form.all(() => true).map((n) => `${n.tagName}${n.getAttribute('data-testid') || ''}${n.hidden ? '!' : ''}`).join('|');
  const before = shape();
  type(q(s.main, 'field-bday-input'), '31/02/1990');
  change(q(s.main, 'field-bday-input')); // the blur that precedes the click on Create
  assert.equal(shape(), before, 'no node appeared, vanished or was shown/hidden by the blur');
  assert.equal(q(s.main, 'field-bday-error').getAttribute('data-visible'), 'true');
  assert.equal(q(s.main, 'field-bday-input').getAttribute('aria-invalid'), 'true');
  const calls = spy(s, 'saveItem');
  fire(form, 'submit'); // the very first click
  await flush(20);
  assert.equal(calls.length, 0);
  assert.equal(q(s.main, 'form-errors').hidden, false, 'the click reached the form and its summary says what is wrong');
});

test('F6: after a save that ends in a closed dialog (focus lost to the body), Save has the focus again', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  s.env.server.external('jane.vcf', BIG.replace('Example Org', 'Other Org'));
  doc.activeElement = doc.body; // Save was disabled while the request ran: the browser dropped the focus
  await submit(s);
  const d = dlg('dialog-conflict');
  assert.ok(d);
  q(d, 'conflict-cancel').click();
  await flush(30);
  assert.equal(dlg('dialog-conflict'), null);
  assert.equal(doc.activeElement, q(s.main, 'contact-save'));
});

test('a failure nobody planned for becomes a persistent text, not an uncaught rejection', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  s.storeCtx.writes.saveItem = async () => {
    throw new Error('boom');
  };
  type(q(s.main, 'field-title'), 'Chief');
  await submit(s);
  assert.match(s.env.feedback.alert.text, /unexpected error/);
  assert.equal(s.env.feedback.alert.scope, null, 'global: it survives navigation');
  assert.match(txt(s.main, 'form-errors'), /unexpected error/);
  assert.equal(q(s.main, 'contact-save').disabled, false, 'the form is usable again');
  assert.equal(s.navs.length, 0);
});

test('F1: the "more" toggles have test ids', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  await open(s, { key: U1 }, EDIT);
  assert.equal(qa(s.main, 'name-more-toggle').length, 1);
  assert.equal(qa(s.main, 'address-more-toggle').length, 1);
});

test('minor 6: a save that ends after the form was redrawn does nothing (no stray navigation)', async () => {
  const s = await setup({ items: { 'jane.vcf': BIG } });
  const orig = s.storeCtx.writes.saveItem;
  let release;
  s.storeCtx.writes.saveItem = (a) => new Promise((res) => { release = () => res(orig(a)); });
  const ctl = await open(s, { key: U1 }, EDIT);
  type(q(s.main, 'field-title'), 'Chief');
  fire(q(s.main, 'contact-form'), 'submit');
  await flush();
  ctl.dispose();
  release();
  await flush(40);
  assert.equal(s.navs.length, 0);
});

test('minor 6: a create in flight when the screen is redrawn is not repeated; the new form adopts its answer', async () => {
  const s = await setup({ items: {} });
  const orig = s.storeCtx.writes.createItem;
  let release;
  const calls = [];
  s.storeCtx.writes.createItem = (a) => (calls.push(a), new Promise((res) => { release = () => res(orig(a)); }));
  const ctl = await open(s, {}, NEW);
  type(q(s.main, 'field-fn'), 'Once Only');
  fire(q(s.main, 'contact-form'), 'submit');
  await flush();
  const snap = ctl.snapshot();
  assert.equal(snap.pendingCreate, true);
  ctl.dispose();
  await open(s, {}, NEW, {}, { restore: snap });
  assert.equal(q(s.main, 'contact-form').querySelector('fieldset').disabled, true, 'the new form waits');
  assert.equal(q(s.main, 'contact-save').disabled, true);
  fire(q(s.main, 'contact-form'), 'submit');
  await flush();
  assert.equal(calls.length, 1, 'a second create is not started');
  release();
  await flush(40);
  assert.equal(s.env.server.items.size, 1);
  const uid = /UID:(.*)/.exec([...s.env.server.items.values()][0].text)[1];
  assert.equal(s.navs.at(-1).hash, `#/contacts/${encodeURIComponent(uid)}`, 'the redrawn form follows the answer of the first request');
});

test('minor 6: after a lost answer in flight, the redrawn form adopts the retry token', async () => {
  const s = await setup({ items: {} });
  const orig = s.storeCtx.writes.createItem;
  let release;
  s.storeCtx.writes.createItem = (a) => new Promise((res) => { release = () => res(orig(a)); });
  const ctl = await open(s, {}, NEW);
  type(q(s.main, 'field-fn'), 'Lost Answer');
  s.env.server.failAfter('PUT', new DavError('network'));
  fire(q(s.main, 'contact-form'), 'submit');
  await flush();
  const snap = ctl.snapshot();
  ctl.dispose();
  await open(s, {}, NEW, {}, { restore: snap });
  release();
  await flush(40);
  assert.equal(txt(s.main, 'contact-save'), 'Try again');
  assert.equal(q(s.main, 'contact-form').querySelector('fieldset').disabled, true);
});
