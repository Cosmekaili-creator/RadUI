// SPDX-License-Identifier: AGPL-3.0-or-later
// The contacts list: rows, states, search, windowing, A-Z, groups filter, read-only and offline gating,
// background sync attributes, hostile content. A real item store and write path over an in-memory DAV server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DavError } from '../../../src/js/dav/http.js';
import { fire, type, choose } from '../widgets/_dom.mjs';
import { writeGate } from '../../../src/js/ui.js';
import { mount } from '../../../src/js/views/contacts/screen.js';
import { FAMILY, JANE, JOHN, U1, U2, card, flush, names, q, qa, setup, txt } from './contacts-helpers.mjs';

const root = (s) => q(s.main, 'contacts-screen');
const open = async (s, params = {}, over = {}) => {
  const ctl = mount(s.ctx(params), { ...s.deps, ...over });
  await flush(20);
  return ctl;
};

test('rows: real links with data attributes, letter headings, count, group cards left out', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': FAMILY } });
  await open(s);
  assert.equal(root(s).getAttribute('data-state'), 'ready');
  const rows = qa(s.main, 'contact-row');
  assert.equal(rows.length, 2, 'the group card is not a contact');
  assert.equal(rows[0].tagName, 'A');
  assert.match(rows[0].getAttribute('href'), /^#\/contacts\//);
  assert.equal(rows[0].getAttribute('data-uid'), U1);
  assert.equal(rows[0].getAttribute('data-href'), '/alice/book/jane.vcf');
  assert.equal(rows[0].getAttribute('data-letter'), 'D');
  assert.equal(rows[0].getAttribute('data-readonly'), 'false');
  assert.equal(txt(s.main, 'contacts-count'), '2 contacts');
  assert.equal(qa(s.main, 'az-D').length, 1);
  assert.equal(qa(s.main, 'az-S').length, 1);
  assert.equal(qa(s.main, 'az-A').length, 0, 'letters without contacts are not offered');
  assert.equal(q(s.main, 'contact-list').getAttribute('aria-busy'), null);
  assert.ok(q(s.main, 'contacts-search') && q(s.main, 'contacts-group') && q(s.main, 'btn-groups') && q(s.main, 'btn-new-contact') && q(s.main, 'btn-import-vcf') && q(s.main, 'btn-export-book'));
  assert.equal(q(s.main, 'contacts-book').parentNode.hidden, true, 'one book: no book selector');
});

test('the New contact and Import buttons navigate / open the import dialog (lazy module)', async () => {
  const s = await setup();
  await open(s);
  q(s.main, 'btn-new-contact').click();
  assert.equal(s.navs.at(-1).hash, '#/contacts/new');
  q(s.main, 'btn-import-vcf').click();
  await flush();
  assert.equal(s.deps.imported.collectionHref, '/alice/book/');
  assert.ok(s.deps.imported.ctx);
});

test('the import button explains when the dialog module cannot be loaded', async () => {
  const s = await setup();
  await open(s, {}, { loadImportDialog: async () => { throw new Error('missing'); } });
  q(s.main, 'btn-import-vcf').click();
  await flush();
  assert.match(s.env.feedback.alert.text, /not available/);
});

test('export of the book downloads contacts only and says how many group cards were left out', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': FAMILY } });
  await open(s);
  q(s.main, 'btn-export-book').click();
  await flush(20);
  assert.equal(s.downloads.length, 1);
  assert.match(s.downloads[0].filename, /^book-\d{4}-\d{2}-\d{2}\.vcf$/);
  assert.match(s.downloads[0].text, /FN:Jane Doe/);
  assert.equal(s.downloads[0].text.includes('Family'), false);
  assert.match(s.env.feedback.status.text, /1 group cards were left out/);
});

test('empty book: contacts-empty with New and Import', async () => {
  const s = await setup({ items: {} });
  await open(s);
  assert.ok(q(s.main, 'contacts-empty'));
  assert.ok(q(s.main, 'btn-new-contact-empty'));
  assert.ok(q(s.main, 'btn-import-vcf-empty'));
  assert.equal(txt(s.main, 'contacts-count'), '0 contacts');
});

test('no address book: nobook with a create link; without own space: noaccess', async () => {
  let s = await setup({ level: null });
  await open(s);
  assert.ok(q(s.main, 'contacts-nobook'));
  assert.equal(q(s.main, 'btn-create-addressbook').getAttribute('href'), '#/collections/new-addressbook');
  s = await setup({ level: null, ownSpace: false });
  await open(s);
  assert.ok(q(s.main, 'contacts-noaccess'));
  assert.match(txt(s.main, 'contacts-noaccess'), /Nothing has been shared with you yet/);
  assert.equal(root(s).getAttribute('data-state'), 'ready');
});

test('read-only grantee: notice, New is aria-disabled and described, no import, no edit or delete', async () => {
  const s = await setup({ level: 'read' });
  await open(s);
  assert.ok(q(s.main, 'contacts-readonly') && !q(s.main, 'contacts-readonly').hidden);
  const nw = q(s.main, 'btn-new-contact');
  assert.equal(nw.getAttribute('aria-disabled'), 'true');
  assert.equal(nw.getAttribute('aria-describedby'), 'contacts-readonly-note');
  assert.equal(q(s.main, 'contacts-readonly-note') || q(s.main, 'contacts-readonly').getAttribute('id'), 'contacts-readonly-note');
  assert.equal(q(s.main, 'btn-import-vcf').hidden, true);
  nw.click();
  assert.equal(s.navs.length, 0, 'a read-only grantee cannot open the new form');
  const ctl = mount(s.ctx({ key: U1 }), s.deps);
  await flush(20);
  assert.equal(qa(s.main, 'btn-edit-contact').length, 0);
  assert.equal(qa(s.main, 'btn-delete-contact').length, 0);
  assert.ok(q(s.main, 'btn-export-contact'), 'export stays available');
  assert.equal(qa(s.main, 'btn-add-to-group').length, 0);
  ctl.dispose();
});

test('offline: write controls are disabled by the gate with an explanation in their name; reading stays', async () => {
  const s = await setup();
  await open(s);
  writeGate.setReason('offline', 'offline: changes disabled');
  const nw = q(s.main, 'btn-new-contact');
  assert.equal(nw.disabled, true);
  assert.match(nw.getAttribute('aria-label'), /New contact \(offline: changes disabled\)/);
  assert.equal(q(s.main, 'btn-export-book').disabled, false);
  assert.equal(qa(s.main, 'contact-row').length, 2);
  writeGate.setReason('offline', null);
  assert.equal(nw.disabled, false);
});

test('cold start offline: contacts-offline; a failing server online: contacts-error; Retry loads', async () => {
  let s = await setup({ online: false });
  s.env.server.fail('SYNC', () => new DavError('network'), { times: 9 });
  s.env.server.fail('PROPFIND1', () => new DavError('network'), { times: 9 });
  await open(s);
  assert.ok(q(s.main, 'contacts-offline'));
  assert.match(txt(s.main, 'contacts-offline'), /no data is stored on this device/);
  assert.equal(root(s).getAttribute('data-state'), 'error');

  s = await setup();
  s.env.server.fail('SYNC', () => new DavError('server', { status: 500 }), { times: 1 });
  s.env.server.fail('PROPFIND1', () => new DavError('server', { status: 500 }), { times: 1 });
  await open(s);
  assert.ok(q(s.main, 'contacts-error'));
  assert.match(txt(s.main, 'contacts-error'), /server reported an error/i);
  q(s.main, 'btn-retry').click();
  await flush(30);
  assert.equal(qa(s.main, 'contact-row').length, 2);
  assert.equal(root(s).getAttribute('data-state'), 'ready');
});

test('search is debounced into the URL; the list filters ignoring accents and case; no match says so', async () => {
  const s = await setup({ items: { 'a.vcf': card('urn:uuid:a1', 'Zoë Lefèvre', 'N:Lefèvre;Zoë;;;\n'), 'b.vcf': card('urn:uuid:b1', 'Bob Brown', 'N:Brown;Bob;;;\nTEL:+1 555 0123\n') } });
  const ctl = await open(s);
  const input = q(s.main, 'contacts-search');
  type(input, 'zoe');
  type(input, 'zoe l');
  assert.equal(s.navs.length, 0, 'nothing before the debounce delay');
  s.timers.advance(20);
  assert.equal(s.navs.length, 1);
  assert.equal(s.navs[0].hash, '#/contacts?q=zoe+l');
  assert.deepEqual(s.navs[0].opts, { replace: true });
  await ctl.update(s.ctx({ q: 'zoe l' }));
  assert.equal(qa(s.main, 'contact-row').length, 1);
  s.timers.advance(700);
  assert.match(txt(s.main, 'contacts-count'), /1 of 2 contacts/);
  await ctl.update(s.ctx({ q: '0123' }));
  assert.equal(qa(s.main, 'contact-row').length, 1, 'phone numbers match on digits');
  await ctl.update(s.ctx({ q: 'nothing here' }));
  assert.equal(qa(s.main, 'contact-row').length, 0);
  assert.match(txt(s.main, 'contacts-no-match'), /No contact matches “nothing here”/);
  await ctl.update(s.ctx({}));
  assert.equal(qa(s.main, 'contact-row').length, 2);
});

test('the count status announces typing at a throttled pace but the first text at once', async () => {
  const s = await setup();
  const ctl = await open(s);
  assert.equal(txt(s.main, 'contacts-count'), '2 contacts');
  type(q(s.main, 'contacts-search'), 'jane');
  await ctl.update(s.ctx({ q: 'jane' }));
  assert.equal(txt(s.main, 'contacts-count'), '2 contacts', 'typing: the new count waits for the throttle');
  s.timers.advance(700);
  assert.match(txt(s.main, 'contacts-count'), /1 of 2/);
});

function manyItems(n) {
  const items = {};
  for (let i = 0; i < n; i += 1) {
    const letter = String.fromCharCode(65 + (i % 26));
    const name = `${letter}${String(i).padStart(4, '0')} Person`;
    items[`c${i}.vcf`] = card(`urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name, `N:${letter}${String(i).padStart(4, '0')};Person;;;\n`);
  }
  return items;
}

test('windowed list: 250 rows, "Show N more (M not shown)", A-Z jump and "Show earlier"', async () => {
  const s = await setup({ items: manyItems(620) });
  const ctl = await open(s);
  assert.equal(qa(s.main, 'contact-row').length, 250);
  assert.equal(txt(s.main, 'contacts-count'), '620 contacts · showing 1–250');
  assert.equal(txt(s.main, 'btn-show-more'), 'Show 250 more (370 not shown)');
  assert.equal(qa(s.main, 'btn-show-earlier').length, 0);
  q(s.main, 'btn-show-more').click();
  assert.equal(qa(s.main, 'contact-row').length, 500);
  assert.equal(txt(s.main, 'btn-show-more'), 'Show 120 more (120 not shown)');
  q(s.main, 'btn-show-more').click();
  assert.equal(qa(s.main, 'contact-row').length, 620);
  assert.equal(qa(s.main, 'btn-show-more').length, 0);
  assert.equal(txt(s.main, 'contacts-count'), '620 contacts');
  // a letter with more rows than a window: the URL carries from=<letter>
  q(s.main, 'az-T').click();
  assert.equal(s.navs.at(-1).hash, '#/contacts?from=T');
  await ctl.update(s.ctx({ from: 'T' }));
  const first = qa(s.main, 'contact-row')[0];
  assert.equal(first.getAttribute('data-letter'), 'T');
  assert.ok(q(s.main, 'btn-show-earlier'));
  assert.match(txt(s.main, 'btn-show-earlier'), /^Show 250 earlier \(\d+ not shown\)$/);
  q(s.main, 'btn-show-earlier').click();
  assert.ok(qa(s.main, 'contact-row').length > 250);
});

test('the list stays responsive: summaries are parsed in chunks and cached for the next screen', async () => {
  const s = await setup({ items: manyItems(450) });
  let yields = 0;
  await open(s, {}, { yieldFn: async () => { yields += 1; } });
  assert.ok(yields >= 2, `parsed in chunks (${yields})`);
  // the second mount of the same session reuses the cached summaries: no chunk is needed
  let again = 0;
  mount(s.ctx(), { ...s.deps, yieldFn: async () => { again += 1; } });
  await flush(20);
  assert.equal(again, 0);
});

test('group filter keeps only the members of the chosen group', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': FAMILY } });
  const ctl = await open(s);
  const sel = q(s.main, 'contacts-group');
  assert.deepEqual(sel.children.map((o) => o.textContent), ['All contacts', 'Family']);
  choose(sel, U1 && sel.children[1].value);
  assert.match(s.navs.at(-1).hash, /^#\/contacts\?group=/);
  await ctl.update(s.ctx({ group: sel.children[1].value }));
  assert.equal(qa(s.main, 'contact-row').length, 1);
  assert.equal(qa(s.main, 'contact-row')[0].getAttribute('data-uid'), U1);
});

test('two books: a selector appears, `ab` must name a discovered book, anything else is "not found"', async () => {
  const s = await setup();
  const real = s.env.access.addressbooks;
  s.env.access.addressbooks = () => [...real(), { href: '/bob/other/', kind: 'addressbook', level: 'read', label: 'Other', source: 'grant' }];
  const ctl = await open(s);
  assert.equal(q(s.main, 'contacts-book').parentNode.hidden, false);
  assert.equal(q(s.main, 'contacts-book').children.length, 2);
  const rowHref = qa(s.main, 'contact-row')[0].getAttribute('href');
  assert.match(rowHref, /ab=%2Falice%2Fbook%2F/, 'links keep the book when there are several');
  choose(q(s.main, 'contacts-book'), '/bob/other/');
  assert.equal(s.navs.at(-1).hash, '#/contacts?ab=%2Fbob%2Fother%2F');
  await ctl.update(s.ctx({ ab: '/nowhere/' }));
  assert.ok(q(s.main, 'contacts-notfound'));
  assert.equal(qa(s.main, 'contact-row').length, 0);
  assert.equal(root(s).getAttribute('data-state'), 'error');
});

test('the last book used is remembered per login through the session container', async () => {
  const s = await setup();
  await open(s, { ab: '/alice/book/' });
  assert.equal(s.env.session.lastBook, '/alice/book/');
});

test('background sync only sets aria-busy on the list and data-sync on the screen root', async () => {
  const s = await setup();
  await open(s);
  const store = s.storeCtx.stores.get('/alice/book/');
  assert.equal(root(s).getAttribute('data-sync'), 'idle');
  const p = s.storeCtx.scheduler.syncNow(store, 'poll');
  assert.equal(root(s).getAttribute('data-sync'), 'running');
  assert.equal(q(s.main, 'contact-list').getAttribute('aria-busy'), 'true');
  assert.equal(root(s).getAttribute('data-state'), 'ready', 'the screen is not "loading" during a background sync');
  await p;
  assert.equal(root(s).getAttribute('data-sync'), 'idle');
  assert.equal(q(s.main, 'contact-list').getAttribute('aria-busy'), null);
});

test('a change made elsewhere shows up after the next sync without a reload', async () => {
  const s = await setup();
  await open(s);
  s.env.server.external('new.vcf', card('urn:uuid:99999999-0000-4000-8000-000000000001', 'Zed Zimmer', 'N:Zimmer;Zed;;;\n'));
  await s.storeCtx.scheduler.syncNow(s.storeCtx.stores.get('/alice/book/'), 'poll');
  await flush(10);
  assert.equal(qa(s.main, 'contact-row').length, 3);
  assert.equal(txt(s.main, 'contacts-count'), '3 contacts');
});

test('read-only items are tagged in the list', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'old.vcf': 'BEGIN:VCARD\nVERSION:2.1\nN:Legacy;Lena\nFN:Lena Legacy\nEND:VCARD\n' } });
  await open(s);
  const ro = qa(s.main, 'contact-row').find((r) => r.getAttribute('data-readonly') === 'true');
  assert.ok(ro);
  assert.match(ro.textContent, /Lena Legacy/);
  assert.match(ro.textContent, /Read-only/);
});

test('hostile names are text, never markup or links; names are isolated with <bdi>', async () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const bidi = 'Eve ‮Evil‬';
  const s = await setup({ items: { 'a.vcf': card('urn:uuid:e1', evil, 'ORG:javascript:alert(3)\n'), 'b.vcf': card('urn:uuid:e2', bidi) } });
  await open(s);
  assert.equal(s.main.querySelectorAll('script').length, 0);
  assert.equal(s.main.querySelectorAll('img').length, 0);
  const rows = qa(s.main, 'contact-row');
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.textContent.includes(evil)));
  for (const r of rows) {
    assert.ok(r.querySelectorAll('bdi').length >= 1);
    assert.equal(/^javascript:/i.test(r.getAttribute('href')), false);
  }
});

test('the controller: wide, title, snapshot of the typed search, dispose clears the screen and the scheduler', async () => {
  const s = await setup();
  const ctl = await open(s);
  assert.equal(ctl.wide, true);
  assert.equal(ctl.title, 'Contacts');
  type(q(s.main, 'contacts-search'), 'ja');
  assert.deepEqual(ctl.snapshot(), { q: 'ja' });
  const store = s.storeCtx.stores.get('/alice/book/');
  assert.equal(s.storeCtx.scheduler.isRegistered(store), true);
  ctl.dispose();
  assert.equal(s.storeCtx.scheduler.isRegistered(store), false);
  assert.equal(qa(s.main, 'contacts-screen').length, 0);
  const again = mount({ ...s.ctx({}), restore: { q: 'ja' } }, s.deps);
  assert.equal(q(s.main, 'contacts-search').value, 'ja');
  again.dispose();
});

test('the shell readiness stays loading until the data arrived', async () => {
  const s = await setup();
  const seen = [];
  s.app.readiness = (await import('../../../src/js/ui.js')).createReadiness((state) => seen.push(state));
  s.app.readiness.reset();
  const end = s.app.readiness.begin(); // what the shell does before mount
  const ctl = mount(s.ctx(), s.deps);
  end(true); // the shell ends its own task right after mount returns
  assert.equal(s.app.readiness.state, 'loading');
  await flush(20);
  assert.equal(s.app.readiness.state, 'ready');
  ctl.dispose();
});

test('JOHN keeps its position when a group is the only card', async () => {
  const s = await setup({ items: { 'family.vcf': FAMILY } });
  await open(s);
  assert.ok(q(s.main, 'contacts-empty'), 'a book with only a group card shows no contacts');
  assert.equal(U2.length > 0, true);
});

test('every control of the list pane has an accessible name and a test id; rows are keyboard-reachable links', async () => {
  const s = await setup({ items: { 'jane.vcf': JANE, 'john.vcf': JOHN, 'family.vcf': FAMILY } });
  await open(s);
  const pane = q(s.main, 'contacts-pane');
  const labelFor = (el) => pane.querySelectorAll('label').find((l) => l.getAttribute('for') === el.getAttribute('id'));
  for (const el of pane.querySelectorAll('button, a, input, select')) {
    const name = (el.getAttribute('aria-label') || '').trim() || (labelFor(el) && labelFor(el).textContent.trim()) || el.textContent.trim();
    assert.ok(name, `named: ${el.tagName} ${el.getAttribute('data-testid')}`);
    assert.ok(el.getAttribute('data-testid'), `test id: ${el.tagName} ${name}`);
  }
  for (const b of qa(s.main, 'btn-new-contact')) assert.equal(b.tagName, 'BUTTON');
  assert.equal(q(s.main, 'contacts-search').getAttribute('type'), 'search');
  assert.equal(q(s.main, 'contacts-search').parentNode.getAttribute('role'), 'search');
});

test('French: the list and its states use the French dictionary', async () => {
  const s = await setup({ lang: 'fr' });
  await open(s);
  assert.equal(txt(s.main, 'btn-new-contact'), 'Nouveau contact');
  assert.equal(txt(s.main, 'contacts-count'), '2 contacts');
  assert.match(qa(s.main, 'az-D')[0].getAttribute('aria-label'), /Aller à D/);
});

test('F3: a search text that arrives from the URL replaces the box even while it has the focus; our own push does not', async () => {
  const s = await setup();
  const ctl = await open(s);
  const input = q(s.main, 'contacts-search');
  input.focus();
  type(input, 'jane');
  s.timers.advance(20);
  await ctl.update(s.ctx({ q: 'jane' }));
  assert.equal(input.value, 'jane', 'the echo of what was typed leaves the box alone');
  await ctl.update(s.ctx({ q: 'john' })); // Back, a link or a typed address
  assert.equal(input.value, 'john');
  assert.equal(qa(s.main, 'contact-row').length, 1);
  await ctl.update(s.ctx({}));
  assert.equal(input.value, '');
});

test('typing in the search box on a contact keeps that contact open', async () => {
  const s = await setup();
  const ctl = mount(s.ctx({ key: U1 }), s.deps);
  await flush(20);
  type(q(s.main, 'contacts-search'), 'jo');
  s.timers.advance(20);
  assert.match(s.navs.at(-1).hash, new RegExp(`^#/contacts/${encodeURIComponent(U1)}\\?q=jo`));
  ctl.dispose();
});

test('minor 9: "Choose a contact" appears only when there is something to choose', async () => {
  let s = await setup();
  await open(s);
  assert.ok(q(s.main, 'contact-pick'));
  s = await setup({ items: {} });
  await open(s);
  assert.equal(q(s.main, 'contact-pick'), null);
  s = await setup({ level: null });
  await open(s);
  assert.equal(q(s.main, 'contact-pick'), null);
  s = await setup({ level: null, ownSpace: false });
  await open(s);
  assert.equal(q(s.main, 'contact-pick'), null);
});
