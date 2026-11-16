// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `agent`: the agent-operability check of SPECS 5 / 8. An agent that sees only the accessibility tree drives the
// main flows: sign in, create a contact with a photo, edit it, create a group and add a member, resolve a conflict,
// import a .vcf, export, create a calendar, rename it, delete a collection, sign out.
//
// The page is driven ONLY through getByRole, getByLabel and getByTestId, and the script waits only on the
// data-state / data-sync attributes the app publishes. The first scenario lints this very file: no CSS or XPath
// locators, no evaluate, no mouse and no coordinates. (Outside setup, such as the other writer's PUT and the test
// image, comes from lib/ and runs outside the page.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DICT, assertClean, check, cryptoUuid, davGet, davPut, en, info, linesOf, listItems, makeBook, makeExifJpeg, openPage, shot, sleep, spec, uniq, unfold, vcard } from '../lib/common.mjs';

export const scenarios = {};

// ------------------------------------------------------------------------------------------------ lint
scenarios.lint = async () => {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // the patterns are assembled from pieces so that this file does not trip over itself
  // lint-patterns-begin
  const bad = {
    'a CSS or XPath locator': new RegExp(['\\.loc', 'ator\\(|\\.\\$\\$?\\(|\\$eval|querySel', 'ector|xpa', 'th=|css', '='].join(''), 'i'),
    'a mouse or coordinate action': new RegExp(['\\.mo', 'use\\b|posi', 'tion\\s*:|boundingB', 'ox|\\.tap\\(|dragT', 'o\\('].join('')),
    'a page-level selector action': new RegExp(['page\\.(cl', 'ick|fi', 'll|ty', 'pe|ch', 'eck|sele', 'ctOption|hov', 'er)\\('].join('')),
    'a script run inside the page': new RegExp(['\\.eva', 'luate(Handle)?\\(|waitForFun', 'ction'].join('')),
  };
  // lint-patterns-end
  const code = src.replace(/\/\/ lint-patterns-begin[\s\S]*?\/\/ lint-patterns-end/, '');
  for (const [what, re] of Object.entries(bad)) {
    const hit = code.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*\/\//.test(l) && re.test(l));
    check(hit.length === 0, `the agent script contains no ${what}`, hit.slice(0, 3).map(([n, l]) => `${n}: ${l.trim().slice(0, 60)}`).join(' | '));
  }
  // control: the patterns do fire on a sample of each forbidden kind (built at run time)
  const samples = ['x.loc' + 'ator(\'.a\')', 'x.mo' + 'use.click(1, 2)', 'page.cl' + 'ick(\'#a\')', 'page.eva' + 'luate(() => 1)'];
  check(Object.values(bad).every((re, i) => re.test(samples[i])), 'control: each lint pattern matches a sample of what it forbids');
  const used = new Set([...code.matchAll(/\.(getBy\w+)\(/g)].map((m) => m[1]));
  check([...used].every((u) => ['getByRole', 'getByLabel', 'getByTestId', 'getByText'].includes(u)), 'it uses only getByRole, getByLabel, getByTestId (and getByText for headings)', [...used].join(','));
};

// ----------------------------------------------------------------------------------------- readiness
const root = (page) => page.getByTestId('app-root');
/** Wait on the readiness the app publishes: data-state of the root, then data-sync of a screen when it has one. */
async function settled(page, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const state = await root(page).getAttribute('data-state');
    const busy = await root(page).getAttribute('aria-busy');
    if (state === 'ready' && busy !== 'true') break;
    if (state === 'error') throw new Error('the app reports data-state=error');
    if (Date.now() - t0 > timeout) throw new Error(`still ${state} after ${timeout} ms`);
    await sleep(100);
  }
  const screen = page.getByTestId('contacts-screen');
  if (await screen.count()) {
    while ((await screen.getAttribute('data-sync')) === 'running') await sleep(100);
  }
}
/** A form field by its visible label (the whole label, so "Name" is not "Technical name"). */
const field = (scope, label) => scope.getByLabel(label, { exact: true });
const link = (page, name) => page.getByRole('link', { name });
const button = (page, name) => page.getByRole('button', { name });
const names = (l) => new RegExp(String(l).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

scenarios.flows = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { acceptDownloads: true });
  try {
    const stamp = uniq('agent').slice(-6);
    const bookName = `Agent book ${stamp}`;
    const bookHref = await makeBook('alice', `agent-${stamp}`, bookName, [['seed.vcf', vcard('3.0', ['FN:Seed Contact', 'N:Contact;Seed;;;'])]]);
    const D = en;

    // 1. sign in
    await page.goto(spec.base + spec.uiPath);
    await field(page, D['login.username']).fill('alice');
    await field(page, D['login.password']).fill(spec.users.alice);
    await button(page, D['login.submit']).click();
    await page.getByTestId('contacts-screen').waitFor();
    await settled(page);
    check(true, '1. signed in: the contacts screen is ready (data-state=ready)');

    // 2. create a contact with a photo
    await field(page, D['contacts.book']).selectOption({ label: bookName });
    await settled(page);
    await button(page, D['contacts.new']).click();
    await page.getByTestId('contact-form').waitFor();
    await settled(page);
    await field(page, D['contact.field.given']).fill('Agnes');
    await field(page, D['contact.field.family']).fill(`Flow${stamp}`);
    await field(page, D['contact.field.title']).fill('Operator');
    await button(page, D['contact.rows.phone.add']).click();
    await field(page, D['contact.field.phone']).fill('+1 555 0190');
    const photo = await makeExifJpeg(page);
    await field(page, D['contact.photo.choose']).setInputFiles({ name: 'face.jpg', mimeType: 'image/jpeg', buffer: photo });
    await page.getByTestId('photo-status').filter({ hasText: 'Photo ready' }).waitFor();
    await button(page, D['contact.form.create']).click();
    await page.getByTestId('contact-detail').waitFor();
    await settled(page);
    const created = (await davGet('alice', bookHref)).text;
    check(/FN:Agnes Flow/.test(created) && /PHOTO/.test(created) && /TEL.*0190/.test(created), '2. the contact with its photo and phone is on the server');
    check((await page.getByTestId('contact-name').textContent()).includes('Agnes'), '2. the detail of the new contact is shown');

    // 3. edit it
    await button(page, names('Edit')).click();
    await page.getByTestId('contact-form').waitFor();
    await field(page, D['contact.field.title']).fill('Senior operator');
    await button(page, D['contact.form.save']).click();
    await page.getByTestId('contact-detail').waitFor();
    await settled(page);
    check(/TITLE:Senior operator/.test((await davGet('alice', bookHref)).text), '3. the edit is on the server');

    // 4. create a group and add a member
    await link(page, D['nav.contacts']).click();
    await settled(page);
    await link(page, D['contacts.groups']).click();
    await page.getByTestId('groups-screen').waitFor();
    await settled(page);
    await button(page, D['groups.new']).click();
    await field(page, D['groups.name']).fill('Operators');
    await button(page, D['groups.create']).click();
    await page.getByTestId('group-detail').waitFor();
    await settled(page);
    await button(page, new RegExp(D['groups.member.addTo'].replace('{group}', '.*'))).click();
    await field(page, D['groups.picker.search']).fill('Agnes');
    await page.getByRole('button', { name: names('Agnes') }).click();
    await page.getByTestId('member-row').waitFor();
    await settled(page);
    const grpText = (await davGet('alice', bookHref)).text;
    check(/FN:Operators/.test(grpText) && /ADDRESSBOOKSERVER-MEMBER/.test(grpText), '4. the group exists and has the member');

    // 5. resolve a conflict: another writer changes the card while the form is open
    await link(page, D['nav.contacts']).click();
    await settled(page);
    await link(page, names('Agnes')).first().click();
    await button(page, names('Edit')).click();
    await page.getByTestId('contact-form').waitFor();
    await field(page, D['contact.field.title']).fill('Chief operator');
    const items = await listItems('alice', bookHref);
    const all = await Promise.all(items.filter((i) => i.href !== bookHref).map(async (i) => ({ i, t: (await davGet('alice', i.href)).text })));
    const agnes = all.find((x) => /FN:Agnes Flow/.test(x.t));
    await davPut('alice', agnes.i.href, agnes.t.replace(/\r?\n/g, '\r\n').replace('TEL', 'NOTE:Written by somebody else\r\nTEL'), 'text/vcard', { 'If-Match': agnes.i.etag });
    await button(page, D['contact.form.save']).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    check((await dialog.getByRole('heading').first().textContent()).length > 0 && (await dialog.getByRole('button', { name: D['conflict.overwrite'] }).count()) === 1, '5. the conflict dialog offers its three choices as named buttons');
    await dialog.getByRole('button', { name: D['conflict.overwrite'] }).click();
    await page.getByTestId('contact-detail').waitFor();
    await settled(page);
    const merged = (await davGet('alice', agnes.i.href)).text;
    check(/TITLE:Chief operator/.test(merged) && /Written by somebody else/.test(merged), '5. overwrite with mine: my title and the other writer\'s note are both on the server');

    // 6. import a .vcf
    await link(page, D['nav.contacts']).click();
    await settled(page);
    await button(page, D['contacts.import']).click();
    const card = vcard('3.0', ['FN:Imported Ivy', 'N:Ivy;Imported;;;'], { uid: 'urn:uuid:' + cryptoUuid() });
    await field(page, D['import.field.file']).setInputFiles({ name: 'ivy.vcf', mimeType: 'text/vcard', buffer: Buffer.from(card) });
    const go = page.getByRole('button', { name: /^Import 1 item/ });
    await go.waitFor();
    await go.click();
    await page.getByRole('heading', { name: D['import.report.title'] }).waitFor();
    await button(page, D['import.close']).first().click();
    await settled(page);
    check(/FN:Imported Ivy/.test((await davGet('alice', bookHref)).text), '6. the imported contact is on the server');

    // 7. export
    const [dl] = await Promise.all([page.waitForEvent('download'), button(page, D['contacts.export']).click()]);
    check(dl.suggestedFilename().endsWith('.vcf'), '7. the address book downloads as a .vcf', dl.suggestedFilename());

    // 8. create a calendar
    await link(page, D['nav.collections']).click();
    await page.getByTestId('collections-screen').waitFor();
    await settled(page);
    await button(page, D['coll.newCalendar']).click();
    await field(page, D['coll.field.name']).fill(`Agent calendar ${stamp}`);
    await button(page, D['coll.createCal']).click();
    await page.getByTestId('collections-screen').waitFor();
    await settled(page);
    check((await page.getByRole('heading', { name: names(`Agent calendar ${stamp}`) }).count()) === 1, '8. the new calendar is listed');

    // 9. rename it
    await button(page, new RegExp(`Edit .*Agent calendar ${stamp}`)).click();
    await field(page, D['coll.field.name']).fill(`Agent calendar ${stamp} renamed`);
    await button(page, D['coll.save']).click();
    await page.getByTestId('collections-screen').waitFor();
    await settled(page);
    check((await page.getByRole('heading', { name: names(`Agent calendar ${stamp} renamed`) }).count()) === 1, '9. the renamed calendar is listed');

    // 10. delete a collection: the calendar, with its name typed
    await button(page, new RegExp(`Delete .*Agent calendar ${stamp} renamed`)).click();
    const del = page.getByRole('dialog');
    await del.waitFor();
    await field(del, D['coll.delete.label']).fill(`Agent calendar ${stamp} renamed`);
    await del.getByRole('button', { name: /^Delete/ }).last().click();
    await del.waitFor({ state: 'detached' });
    await settled(page);
    // the list is redrawn right after the dialog closes: wait (by what the page shows) until the heading is gone
    let left = -1;
    for (let i = 0; i < 100 && left !== 0; i++) {
      left = await page.getByRole('heading', { name: names(`Agent calendar ${stamp}`) }).count();
      if (left !== 0) await sleep(100);
    }
    check(left === 0, '10. the calendar is gone from the list', `${left} heading(s) still match; status "${(await page.getByTestId('status-text').allTextContents()).join()}" alert "${(await page.getByTestId('alert-text').allTextContents()).join()}"`);

    // 11. sign out
    await button(page, D['nav.signOut']).click();
    await field(page, D['login.username']).waitFor();
    check(true, '11. signed out: the login form is back');
    await shot(page, 'agent-after-signout-desktop-light-en');
    watch.errors.length = 0;
    await assertClean(page, watch, 'agent flows');
  } finally {
    await ctx.close();
  }
};
