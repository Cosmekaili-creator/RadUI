// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `collections`: create a calendar and an address book (collisions, an orphan grant that is revoked before the
// create and one that cannot be revoked, a hostile colour), edit (and PROPPATCH 403 for a grantee), delete (typed name,
// export first with the group cards, a concurrent change answered 412, grants left behind), read-only and read-write
// grantees, an account without an own space, the deep links ?dialog=delete|import, and a French pass.
import {
  DICT, api, assertClean, check, cryptoUuid, dav, davGet, davPut, en, fr, go, info, listItems, makeBook, openPage, pageChecks, propName,
  ready, shot, signIn, sleep, spec, tid, uniq, unfold, vcard,
} from '../lib/common.mjs';
import { enc, waitFeedback } from '../lib/ui.mjs';
import { sessionEndCase } from '../lib/session.mjs';

/** Leave a form by its Cancel link; a changed form asks first and the answer is "Discard". */
async function leaveForm(page) {
  await page.getByTestId('collection-cancel').click();
  const d = page.getByTestId('dialog-discard');
  if (await d.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) await d.click();
  await page.waitForFunction(() => location.hash === '#/collections');
  await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
}

export const scenarios = {};
const rowOf = (page, href) => page.locator(`[data-testid="collection-row"][data-href="${href}"]`);
const PROP = (names) => `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/"><D:prop>${names}</D:prop></D:propfind>`;
async function props(user, href) {
  const r = await dav(user, 'PROPFIND', href, PROP('<D:displayname/><I:calendar-color/><C:supported-calendar-component-set/><C:calendar-description/><D:resourcetype/>'), { Depth: '0', 'Content-Type': 'application/xml' });
  const get = (re) => (re.exec(r.text) || [])[1] || '';
  return { status: r.status, text: r.text, name: get(/<(?:\w+:)?displayname>([^<]*)</), color: get(/<(?:\w+:)?calendar-color[^>]*>([^<]*)</), desc: get(/<(?:\w+:)?calendar-description[^>]*>([^<]*)</).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), comps: [...r.text.matchAll(/comp name="(\w+)"/g)].map((m) => m[1]) };
}
const grantsOf = async (owner) => (await api(owner, 'GET', `grants?owner=${owner}`)).json || [];
const MKCAL = (name) => `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>${name}</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
const person = (uid, fn, family, given) => vcard('3.0', [`FN:${fn}`, `N:${family};${given};;;`], { uid });

// ------------------------------------------------------------------------------------------------ list
scenarios.list = async (browser) => {
  for (const vp of [{ n: 'desktop', w: 1280, h: 800 }, { n: 'phone', w: 390, h: 844 }]) {
    const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h });
    try {
      await signIn(page, 'alice', '#/collections');
      await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="collection-count"]')].every((e) => e.getAttribute('aria-busy') === 'false'), null, { timeout: 30000 });
      const rows = await page.$$eval('[data-testid="collection-row"]', (rs) => rs.map((r) => ({ href: r.dataset.href, kind: r.dataset.kind, level: r.dataset.level, comps: r.dataset.components, count: r.querySelector('[data-testid="collection-count"]').dataset.count })));
      const want = spec.expect.alice.collections;
      check(JSON.stringify(rows.map((r) => r.href).sort()) === JSON.stringify(Object.keys(want).filter((h) => !spec.big[h]).sort()), `alice's own collections are listed: ${vp.n}`, rows.map((r) => r.href).join(','));
      for (const r of rows) check(r.level === 'own' && r.kind === want[r.href].kind && Number(r.count) === want[r.href].count, `${r.href}: own, ${want[r.href].kind}, ${want[r.href].count} items: ${vp.n}`, JSON.stringify(r));
      check(rows.find((r) => r.href === '/alice/cal-work/').comps === 'vevent' && rows.find((r) => r.href === '/alice/contacts/').comps === 'vcard', `data-components says what a collection holds: ${vp.n}`);
      const shared = await rowOf(page, '/alice/contacts40/').getByTestId('shared-with').textContent();
      check(/bob/.test(shared) && /read and write|read\/write|Read/i.test(shared), `"Shared with" names the grantee and the level for a shared own collection: ${vp.n}`, shared);
      check((await rowOf(page, '/alice/cal-work/').getByTestId('shared-with').textContent()).trim().length > 0, `a collection that is not shared says it is private: ${vp.n}`);
      await shot(page, `collections-list-${vp.n}-light-en`);
      await pageChecks(page, watch, `collections list ${vp.n}`);
      // technical details are folded away
      const tech = rowOf(page, '/alice/contacts/').getByTestId('collection-tech');
      await tech.locator('summary').click();
      check((await tech.getByTestId('collection-href').textContent()) === '/alice/contacts/', `the technical details show the address: ${vp.n}`);
      await assertClean(page, watch, `collections list scenario ${vp.n}`);
    } finally {
      await ctx.close();
    }
  }
};

// ----------------------------------------------------------------------------------------------- create
scenarios['create-calendar'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await tid(page, 'btn-new-calendar').click();
    await page.getByTestId('calendar-form').waitFor();
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'field-coll-name', 'the create form focuses the name field');
    check(await tid(page, 'private-notice').isVisible(), 'the form says the new collection is private until shared');
    await shot(page, 'collection-form-calendar-new-desktop-light-en');
    // errors: empty name, no component, a hostile colour
    await tid(page, 'component-vevent').uncheck().catch(() => {});
    await tid(page, 'field-color-custom').fill('red;background:url(x)');
    await tid(page, 'collection-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    const summary = await tid(page, 'form-errors').textContent();
    check(/3 problems/.test(summary) || /problems? to fix/.test(summary), 'name, colour and components are reported together', summary);
    check((await tid(page, 'field-color-error').textContent()).includes(en['coll.err.colour']) && (await tid(page, 'field-coll-name').getAttribute('aria-invalid')) === 'true', 'the hostile colour "red;background:url(x)" is refused with a message; the name field is aria-invalid');
    const ids = await page.evaluate(() => ['field-coll-name'].map((t) => document.querySelector(`[data-testid="${t}"]`).getAttribute('aria-describedby')));
    check(ids[0] && ids[0].length > 0, 'the name field is described by its message (aria-describedby)', String(ids[0]));
    await shot(page, 'collection-form-calendar-errors-desktop-light-en');
    await pageChecks(page, watch, 'calendar form with errors');
    // collisions: the display name of an own collection, the technical name of one
    await tid(page, 'component-vevent').check();
    await tid(page, 'field-color-custom').fill('');
    await tid(page, 'field-coll-name').fill('personal');
    await tid(page, 'collection-save').click();
    await page.waitForFunction((t) => document.body.textContent.includes(t), en['coll.err.nameTaken'], { timeout: 5000 });
    check(true, 'a display name that an own collection already has is refused before any request');
    await tid(page, 'field-coll-name').fill('Another thing');
    await tid(page, 'collection-advanced').locator('summary').click();
    await tid(page, 'field-coll-slug').fill('cal-work');
    await tid(page, 'collection-save').click();
    await page.waitForFunction((t) => document.body.textContent.includes(t), en['coll.err.slugTaken'], { timeout: 5000 });
    check(true, 'a technical name that is taken is refused next to the technical-name field');
    await tid(page, 'field-coll-slug').fill('radui-gen-x');
    await tid(page, 'collection-save').click();
    await page.waitForFunction((t) => document.body.textContent.includes(t), en['coll.err.slug.reserved'], { timeout: 5000 });
    check(true, 'the reserved prefix radui-gen- is refused');
    await shot(page, 'collection-form-calendar-slug-error-desktop-light-en');
    // a good one: the slug follows the name; colour from the swatches; both component kinds
    const slug = uniq('plan');
    await leaveForm(page);
    await tid(page, 'btn-new-calendar').click();
    await page.getByTestId('calendar-form').waitFor();
    await tid(page, 'field-coll-name').fill('Plan: Q1 / Quarterly Review');
    await tid(page, 'collection-advanced').locator('summary').click();
    check((await tid(page, 'field-coll-slug').inputValue()) === 'plan-q1-quarterly-review', 'the technical name is derived from the display name (ASCII, lower case, dashes)', await tid(page, 'field-coll-slug').inputValue());
    await tid(page, 'field-coll-slug').fill(slug);
    await tid(page, 'field-coll-desc').fill('Quarterly plan <b>not bold</b>');
    await tid(page, 'colour-vermillion').check();
    await tid(page, 'component-vtodo').check();
    await shot(page, 'collection-form-calendar-filled-desktop-light-en');
    await tid(page, 'collection-save').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const p = await props('alice', `/alice/${slug}/`);
    check(p.status === 207 && p.name === 'Plan: Q1 / Quarterly Review' && /D55E00/i.test(p.color) && p.desc === 'Quarterly plan <b>not bold</b>' && p.comps.sort().join() === 'VEVENT,VTODO', 'the calendar exists on the server with name, colour, description and both component kinds', JSON.stringify({ n: p.name, c: p.color, d: p.desc, k: p.comps }));
    const row = rowOf(page, `/alice/${slug}/`);
    check((await row.getAttribute('data-components')) === 'vevent,vtodo' && (await row.getByTestId('collection-type').textContent()).includes('Events + Tasks'), 'the list shows it as "Events + Tasks"');
    check((await row.getByTestId('collection-desc').textContent()) === 'Quarterly plan <b>not bold</b>' && (await row.getByTestId('collection-desc').locator('b').count()) === 0, 'the description is shown as text, not as markup');
    check((await tid(page, 'status-text').textContent()).includes('private'), 'a persistent status says it is private until shared', await tid(page, 'status-text').textContent());
    await shot(page, 'collections-after-create-desktop-light-en');
    // the race: somebody else creates the name between opening the form and pressing Save
    await tid(page, 'btn-new-calendar').click();
    await page.getByTestId('calendar-form').waitFor();
    const race = uniq('race');
    await tid(page, 'field-coll-name').fill('Race ' + race);
    await tid(page, 'collection-advanced').locator('summary').click();
    await tid(page, 'field-coll-slug').fill(race);
    const mk = await dav('alice', 'MKCALENDAR', `/alice/${race}/`, MKCAL('taken first'), { 'Content-Type': 'application/xml' });
    check(mk.status === 201, 'another client creates the same technical name first');
    await tid(page, 'collection-save').click();
    await page.waitForFunction((t) => document.body.textContent.includes(t), en['coll.err.slugTaken'], { timeout: 10000 });
    check((await props('alice', `/alice/${race}/`)).name === 'taken first', 'the existing collection was not touched by the refused create');
    await assertClean(page, watch, 'create calendar');
  } finally {
    await ctx.close();
  }
};

scenarios['create-addressbook'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await tid(page, 'btn-new-addressbook').click();
    await page.getByTestId('addressbook-form').waitFor();
    check((await tid(page, 'field-color').count()) === 0 && (await tid(page, 'field-components').count()) === 0, 'the address book form has no colour and no component choice');
    await shot(page, 'collection-form-addressbook-new-desktop-light-en');
    await tid(page, 'collection-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    check((await tid(page, 'form-errors').textContent()).length > 0, 'an empty name is reported');
    const slug = uniq('book');
    await tid(page, 'field-coll-name').fill('Élodie’s clients');
    await tid(page, 'collection-advanced').locator('summary').click();
    check((await tid(page, 'field-coll-slug').inputValue()) === 'elodie-s-clients', 'the technical name drops accents and punctuation', await tid(page, 'field-coll-slug').inputValue());
    await tid(page, 'field-coll-slug').fill(slug);
    await tid(page, 'collection-save').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const p = await props('alice', `/alice/${slug}/`);
    check(p.status === 207 && p.name === 'Élodie’s clients' && /addressbook/.test(p.text), 'the address book exists on the server', JSON.stringify({ n: p.name }));
    const row = rowOf(page, `/alice/${slug}/`);
    check((await row.getAttribute('data-kind')) === 'addressbook' && (await row.getByTestId('btn-open-collection').count()) === 1 && (await row.getByTestId('btn-import').count()) === 1, 'the new book offers Open and Import');
    await row.getByTestId('btn-open-collection').click();
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    check((await page.getByTestId('contacts-empty').count()) === 1, 'Open shows the empty address book with its "New contact" and "Import" actions');
    await shot(page, 'contacts-empty-desktop-light-en');
    await pageChecks(page, watch, 'empty address book');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------- orphan grants
scenarios['orphan-grants'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    // 1. an old collection was deleted behind the UI's back and left a grant to bob
    const name = uniq('orph');
    await makeBook('alice', name, 'Old one');
    check((await api('alice', 'PUT', 'grants', { owner: 'alice', collection: name, grantee: 'bob', level: 'read' })).status === 200, 'setup: alice shares a new book with bob');
    check((await dav('alice', 'DELETE', `/alice/${name}/`)).status === 200, 'setup: the book is deleted directly on the server; the grant stays behind');
    check((await grantsOf('alice')).some((g) => g.collection === name), 'setup: the orphan grant exists');
    await signIn(page, 'alice', '#/collections/new-addressbook');
    await tid(page, 'field-coll-name').fill('Fresh ' + name);
    await tid(page, 'collection-advanced').locator('summary').click();
    await tid(page, 'field-coll-slug').fill(name);
    await tid(page, 'collection-save').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    check(!(await grantsOf('alice')).some((g) => g.collection === name), 'creating a collection whose name has an orphan grant revokes that grant first: the new book is not silently shared with bob');
    check((await dav('bob', 'PROPFIND', `/alice/${name}/`, null, { Depth: '0' })).status === 403, 'bob cannot reach the new book');
    // 2. the same, but the grant cannot be revoked (the account service answers 500): the create is refused
    const name2 = uniq('orph');
    await makeBook('alice', name2, 'Old two');
    await api('alice', 'PUT', 'grants', { owner: 'alice', collection: name2, grantee: 'bob', level: 'read' });
    await dav('alice', 'DELETE', `/alice/${name2}/`);
    await go(page, '#/collections/new-addressbook');
    await page.route('**/api/grants', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }) : route.continue()));
    await tid(page, 'field-coll-name').fill('Refused ' + name2);
    await tid(page, 'collection-advanced').locator('summary').click();
    await tid(page, 'field-coll-slug').fill(name2);
    await tid(page, 'collection-save').click();
    await page.waitForFunction(() => /could not be removed/.test((document.querySelector('[data-testid="alert-text"]') || {}).textContent || ''), null, { timeout: 15000 }).catch(async (e) => {
      throw new Error(`no refusal text: alert "${(await tid(page, 'alert-text').textContent().catch(() => '')) || ''}", form errors "${((await tid(page, 'form-errors').textContent().catch(() => '')) || '').trim()}", hash ${await page.evaluate(() => location.hash)}`);
    });
    check((await dav('alice', 'PROPFIND', `/alice/${name2}/`, null, { Depth: '0' })).status === 404, 'the create was refused: the collection does not exist');
    check((await tid(page, 'alert-text').textContent()).includes(name2), 'a persistent alert names the left-over sharing', await tid(page, 'alert-text').textContent());
    await shot(page, 'collection-form-orphan-refused-desktop-light-en');
    await page.unroute('**/api/grants');
    watch.errors.length = 0; // the browser logs the deliberate 500
    watch.failed.length = 0;
    await assertClean(page, watch, 'orphan grants');
    await api('alice', 'PUT', 'grants', { owner: 'alice', collection: name2, grantee: 'bob', level: 'none' }); // clean up the grant left on purpose
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------------------ edit
scenarios.edit = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const slug = uniq('edit');
    const mk = await dav('alice', 'MKCALENDAR', `/alice/${slug}/`, MKCAL('Before name'), { 'Content-Type': 'application/xml' });
    check(mk.status === 201, 'setup: a calendar to edit');
    await signIn(page, 'alice', `#/collections/edit?href=${enc(`/alice/${slug}/`)}`);
    await page.getByTestId('calendar-form').waitFor();
    check(await tid(page, 'field-coll-name').inputValue() === 'Before name' && (await tid(page, 'coll-components-fixed').count()) === 1 && (await tid(page, 'rename-note').count()) === 1, 'the edit form shows the name, says the components are fixed and that the address does not change');
    check((await tid(page, 'field-coll-slug').count()) === 0, 'the technical name cannot be edited');
    await shot(page, 'collection-form-calendar-edit-desktop-light-en');
    await pageChecks(page, watch, 'calendar edit form');
    // nothing changed: nothing sent (F5): no PROPPATCH leaves the page, the status says so, the server keeps its (empty) colour
    const patches = [];
    const onReq = (r) => { if (r.method() === 'PROPPATCH') patches.push(r.url()); };
    page.on('request', onReq);
    await tid(page, 'collection-save').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    await sleep(500);
    page.off('request', onReq);
    const untouched = await props('alice', `/alice/${slug}/`);
    check(patches.length === 0 && untouched.color === '', 'saving an untouched edit form of a calendar with no colour sends no PROPPATCH and leaves the colour empty (F5)', `${patches.length} PROPPATCH, colour "${untouched.color}"`);
    check((await tid(page, 'status-text').textContent()).includes('No changes'), 'and says "No changes to save"', await tid(page, 'status-text').textContent());
    await go(page, `#/collections/edit?href=${enc(`/alice/${slug}/`)}`);
    await tid(page, 'field-coll-name').fill('After name');
    await tid(page, 'field-coll-desc').fill('Now with a description');
    await tid(page, 'colour-blue').check();
    await tid(page, 'collection-save').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    const p = await props('alice', `/alice/${slug}/`);
    check(p.name === 'After name' && p.desc === 'Now with a description' && /0072B2/i.test(p.color) && p.comps.join() === 'VEVENT', 'the server has the new name, description and colour; the component set is unchanged', JSON.stringify(p.comps) + p.name + p.color);
    check((await rowOf(page, `/alice/${slug}/`).getByTestId('collection-name').textContent()).trim() === 'After name', 'the list shows the new name at once');
    // a grantee: no edit offered; the deep link shows a refusal; PROPPATCH by the grantee is 403 at the server
    const patch = '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>hijacked</D:displayname></D:prop></D:set></D:propertyupdate>';
    const r = await dav('bob', 'PROPPATCH', '/alice/contacts40/', patch, { 'Content-Type': 'application/xml' });
    check(r.status === 403, 'PROPPATCH of an address book by a read-write grantee is 403 at the server', String(r.status));
    await assertClean(page, watch, 'edit collection');
  } finally {
    await ctx.close();
  }
  const b = await openPage(browser);
  try {
    await signIn(b.page, 'bob', `#/collections/edit?href=${enc('/alice/contacts40/')}`);
    await b.page.getByTestId('collection-denied').waitFor();
    check((await b.page.getByTestId('collection-denied').textContent()).includes(en['coll.notAllowed']) && (await b.page.getByTestId('calendar-form').count()) + (await b.page.getByTestId('addressbook-form').count()) === 0, 'a grantee who opens the edit link sees a refusal, not a form');
    await shot(b.page, 'collection-edit-denied-desktop-light-en');
    await pageChecks(b.page, b.watch, 'edit denied');
  } finally {
    await b.ctx.close();
  }
};

// ---------------------------------------------------------------------------------------------- delete
async function deleteFixture() {
  const A = 'urn:uuid:' + cryptoUuid();
  const B = 'urn:uuid:' + cryptoUuid();
  const G = 'urn:uuid:' + cryptoUuid();
  const name = uniq('del');
  const group = vcard('3.0', ['X-ADDRESSBOOKSERVER-KIND:group', 'FN:Team', 'N:Team;;;;', `X-ADDRESSBOOKSERVER-MEMBER:${A}`], { uid: G });
  const href = await makeBook('alice', name, 'Doomed ' + name, [['a.vcf', person(A, 'Ann Alpha', 'Alpha', 'Ann')], ['b.vcf', person(B, 'Bert Beta', 'Beta', 'Bert')], ['g.vcf', group]]);
  return { name, href, label: 'Doomed ' + name };
}

scenarios.delete = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { acceptDownloads: true });
  try {
    const f = await deleteFixture();
    check((await api('alice', 'PUT', 'grants', { owner: 'alice', collection: f.name, grantee: 'bob', level: 'read' })).status === 200, 'setup: the book is shared with bob (read)');
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await rowOf(page, f.href).getByTestId('btn-delete-collection').click();
    const dlg = tid(page, 'dialog-delete-collection');
    await dlg.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="delete-count"]')?.dataset.count !== '', null, { timeout: 15000 });
    check((await tid(page, 'delete-count').getAttribute('data-count')) === '3' && (await tid(page, 'delete-count').textContent()).includes('3 items'), 'the dialog shows a fresh item count (3, the group card included)', await tid(page, 'delete-count').textContent());
    check((await tid(page, 'delete-shared').textContent()).includes('bob'), 'the dialog lists who loses access (bob)', await tid(page, 'delete-shared').textContent());
    const confirm = tid(page, 'dialog-confirm-delete');
    check(await confirm.isDisabled() && await page.evaluate(() => document.activeElement.dataset.testid) === 'field-confirm-name', 'the delete button is disabled and the typed-name field is focused (m7)');
    await shot(page, 'collection-delete-dialog-desktop-light-en');
    await pageChecks(page, watch, 'delete collection dialog');
    // export first: includes the group card
    const [dl] = await Promise.all([page.waitForEvent('download'), tid(page, 'btn-export-first').click()]);
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(await dl.path(), 'utf8');
    check((body.match(/BEGIN:VCARD/g) || []).length === 3 && body.includes('X-ADDRESSBOOKSERVER-KIND:group') && dl.suggestedFilename().endsWith('.vcf'), 'Export first downloads all three cards including the group card', `${(body.match(/BEGIN:VCARD/g) || []).length} cards, ${dl.suggestedFilename()}`);
    // typed name: wrong, wrong case, right
    await tid(page, 'field-confirm-name').fill(f.label.toUpperCase());
    check(await confirm.isDisabled(), 'a name that differs in case does not enable the button');
    await tid(page, 'field-confirm-name').fill(f.label.slice(0, -1));
    check(await confirm.isDisabled(), 'a partial name does not enable the button');
    await tid(page, 'field-confirm-name').fill(f.label);
    check(await confirm.isEnabled(), 'the exact name enables the button');
    await shot(page, 'collection-delete-dialog-typed-desktop-light-en');
    // Esc cancels
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    check((await dav('alice', 'PROPFIND', f.href, null, { Depth: '0' })).status === 207, 'Esc cancels: the collection is still there');
    // a concurrent change: the dialog read the collection ETag when it opened; another client adds a card
    await rowOf(page, f.href).getByTestId('btn-delete-collection').click();
    await dlg.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="delete-count"]')?.dataset.count !== '', null, { timeout: 15000 });
    check((await davPut('alice', `${f.href}late.vcf`, person('urn:uuid:' + cryptoUuid(), 'Late Arrival', 'Arrival', 'Late'))).status === 201, 'another client adds a card while the dialog is open');
    await tid(page, 'field-confirm-name').fill(f.label);
    await confirm.click();
    await tid(page, 'delete-changed').waitFor({ timeout: 15000 });
    const changed = await tid(page, 'delete-changed').textContent();
    check(/4 items/.test(changed) && (await dav('alice', 'PROPFIND', f.href, null, { Depth: '0' })).status === 207, 'the delete is refused (412): "changed since you opened this", the new count is 4, nothing was deleted', changed);
    await shot(page, 'collection-delete-dialog-changed-desktop-light-en');
    await tid(page, 'field-confirm-name').fill(f.label);
    await tid(page, 'dialog-confirm-delete').click();
    await dlg.waitFor({ state: 'detached', timeout: 30000 });
    await page.waitForFunction((h) => !document.querySelector(`[data-href="${h}"]`), f.href, { timeout: 15000 });
    check((await dav('alice', 'PROPFIND', f.href, null, { Depth: '0' })).status === 404, 'after confirming again the collection is deleted on the server');
    check(!(await grantsOf('alice')).some((g) => g.collection === f.name), 'the grant to bob was revoked after the delete (the name can be reused safely)');
    await assertClean(page, watch, 'delete collection');
  } finally {
    await ctx.close();
  }
};

scenarios['delete-grants-left'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const f = await deleteFixture();
    await api('alice', 'PUT', 'grants', { owner: 'alice', collection: f.name, grantee: 'bob', level: 'readwrite' });
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await page.route('**/api/grants', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }) : route.continue()));
    await rowOf(page, f.href).getByTestId('btn-delete-collection').click();
    await tid(page, 'dialog-delete-collection').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="delete-count"]')?.dataset.count !== '', null, { timeout: 15000 });
    await tid(page, 'field-confirm-name').fill(f.label);
    await tid(page, 'dialog-confirm-delete').click();
    await tid(page, 'dialog-delete-collection').waitFor({ state: 'detached', timeout: 30000 });
    await page.waitForFunction(() => /sharing could not be removed/.test((document.querySelector('[data-testid="alert-text"]') || {}).textContent || ''), null, { timeout: 30000 });
    const alert = await tid(page, 'alert-text').textContent();
    check(alert.includes(f.name) && alert.includes('bob'), 'the collection is deleted but a persistent alert names the sharing that could not be removed and for whom', alert);
    await shot(page, 'collections-grants-left-alert-desktop-light-en');
    await page.unroute('**/api/grants');
    check((await dav('alice', 'PROPFIND', f.href, null, { Depth: '0' })).status === 404 && (await grantsOf('alice')).some((g) => g.collection === f.name), 'the data is gone and the grant is still in the account service (so an administrator can remove it)');
    await api('alice', 'PUT', 'grants', { owner: 'alice', collection: f.name, grantee: 'bob', level: 'none' });
    watch.errors.length = 0;
    watch.failed.length = 0;
    await assertClean(page, watch, 'delete with grants left');
  } finally {
    await ctx.close();
  }
};

// ----------------------------------------------------------------- grantees and deep links
scenarios['read-only'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'agent-1', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const ro = rowOf(page, '/bob/bob-book/');
    check((await ro.getAttribute('data-level')) === 'read' && (await ro.getByTestId('coll-readonly').count()) === 1 && (await ro.getByTestId('coll-owner').textContent()).includes('bob'), 'a read grant: the row says read-only and who owns it');
    check((await ro.getByTestId('btn-open-collection').count()) === 1 && (await ro.getByTestId('btn-export').count()) === 1 && (await ro.getByTestId('btn-edit-collection').count()) === 0 && (await ro.getByTestId('btn-import').count()) === 0 && (await ro.getByTestId('btn-delete-collection').count()) === 0, 'a read-only grantee sees Open and Export only');
    const rw = rowOf(page, '/alice/contacts/');
    check((await rw.getAttribute('data-level')) === 'readwrite' && (await rw.getByTestId('btn-import').count()) === 1 && (await rw.getByTestId('btn-edit-collection').count()) === 0 && (await rw.getByTestId('btn-delete-collection').count()) === 0, 'a read-write grantee sees Open, Import and Export, but neither Edit nor Delete');
    const cal = rowOf(page, '/alice/cal-work/');
    check((await cal.getByTestId('btn-import').count()) === 1 && (await cal.getByTestId('btn-open-collection').count()) === 0 && (await cal.getByTestId('btn-export').count()) === 1, 'a calendar offers Import and Export (no Open: only address books have one)');
    check((await tid(page, 'collection-list-shared').isVisible()) && (await tid(page, 'btn-new-calendar').count()) === 1, 'the list has a "Shared with you" section; agent-1 has its own space, so it can create');
    await shot(page, 'collections-list-grantee-desktop-light-en');
    await pageChecks(page, watch, 'collections list as grantee');
    // deep links: delete is refused for a grantee, import is refused for a read-only one, unknown hrefs are not found
    await go(page, `#/collections?dialog=delete&href=${enc('/alice/contacts/')}`);
    await page.waitForFunction((t) => (document.querySelector('[data-testid="alert-text"]') || {}).textContent?.includes(t), en['coll.notAllowed'], { timeout: 10000 });
    check((await page.getByTestId('dialog-delete-collection').count()) === 0 && await page.evaluate(() => location.hash) === '#/collections', 'the delete deep link of a granted collection shows "not allowed", opens no dialog and drops the parameters');
    await go(page, `#/collections?dialog=import&href=${enc('/bob/bob-book/')}`);
    await page.waitForFunction((t) => (document.querySelector('[data-testid="alert-text"]') || {}).textContent?.includes(t), en['coll.notAllowed'], { timeout: 10000 });
    check((await page.getByTestId('dialog-import').count()) === 0, 'the import deep link of a read-only book is refused');
    await go(page, `#/collections?dialog=delete&href=${enc('/nobody/nothing/')}`);
    await page.waitForFunction((t) => (document.querySelector('[data-testid="alert-text"]') || {}).textContent?.includes(t), en['coll.notFound'], { timeout: 10000 });
    check(true, 'an unknown href in a deep link says "not found" (nothing is fetched from it)');
    await assertClean(page, watch, 'collections read-only');
  } finally {
    await ctx.close();
  }
};

scenarios['deep-links'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const f = await deleteFixture();
    await signIn(page, 'alice');
    await page.goto(`${spec.base}${spec.uiPath}#/collections?dialog=delete&href=${enc(f.href)}`);
    await ready(page);
    await tid(page, 'dialog-delete-collection').waitFor({ timeout: 20000 });
    check((await tid(page, 'dialog-delete-collection').textContent()).includes(f.label), 'a reload on ?dialog=delete&href=... opens the delete dialog of that collection');
    await tid(page, 'dialog-cancel').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    check(true, 'cancelling the dialog removes dialog and href from the URL');
    await go(page, `#/collections?dialog=import&href=${enc(f.href)}`);
    await tid(page, 'dialog-import').waitFor({ timeout: 20000 });
    check((await tid(page, 'field-import-target').count()) === 1 || (await tid(page, 'import-no-target').count()) === 0, 'the import deep link opens the import dialog');
    await shot(page, 'import-dialog-deep-link-desktop-light-en');
    await tid(page, 'dialog-cancel').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    await assertClean(page, watch, 'deep links');
  } finally {
    await ctx.close();
  }
};

scenarios['no-own-space'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'carol', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    check(await tid(page, 'own-space-disabled').isVisible() && (await tid(page, 'collections-empty').count()) === 1 && await tid(page, 'btn-new-calendar').isHidden(), 'an account without an own space: an explanation, the empty state and no create button');
    for (const hash of ['#/collections/new-calendar', '#/collections/new-addressbook']) {
      await go(page, hash);
      await page.getByTestId('collection-denied').waitFor();
      check((await page.getByTestId('calendar-form').count()) + (await page.getByTestId('addressbook-form').count()) === 0, `${hash} shows a refusal, not a form`);
    }
    await shot(page, 'collection-create-denied-desktop-light-en');
    await pageChecks(page, watch, 'create denied');
  } finally {
    await ctx.close();
  }
};

// ----------------------------------------------------------------------------------------- French pass
scenarios.french = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { lang: 'fr', w: 390, h: 844, scheme: 'dark' });
  try {
    const f = await deleteFixture();
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="collection-count"]')].every((e) => e.getAttribute('aria-busy') === 'false'), null, { timeout: 30000 });
    check((await tid(page, 'btn-new-calendar').textContent()).trim() === fr['coll.newCalendar'], 'the collections screen is in French');
    await shot(page, 'collections-list-phone-dark-fr');
    await pageChecks(page, watch, 'collections list fr');
    await tid(page, 'btn-new-calendar').click();
    await page.getByTestId('calendar-form').waitFor();
    await tid(page, 'collection-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    check((await tid(page, 'form-errors').textContent()).includes(fr['coll.err.name.required']), 'the name error is in French');
    await shot(page, 'collection-form-calendar-errors-phone-dark-fr');
    await pageChecks(page, watch, 'calendar form errors fr');
    await go(page, '#/collections');
    await rowOf(page, f.href).getByTestId('btn-delete-collection').click();
    await tid(page, 'dialog-delete-collection').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="delete-count"]')?.dataset.count !== '', null, { timeout: 15000 });
    await shot(page, 'collection-delete-dialog-phone-dark-fr');
    await pageChecks(page, watch, 'delete dialog fr');
    await tid(page, 'dialog-cancel').click();
    await assertClean(page, watch, 'collections french');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------ the session ends with the dialog open (review M1)
const deleteCase = (way) => (browser) => sessionEndCase(browser, {
  way,
  label: `collection delete dialog, session ended by ${way === 'password' ? 'a password reset (401)' : 'a sign-out in another tab'}`,
  dialog: 'dialog-delete-collection',
  prepare: async (user) => {
    const name = uniq('delse');
    const href = await makeBook(user, name, 'Doomed ' + name, [['a.vcf', person('urn:uuid:' + cryptoUuid(), 'Ann Alpha', 'Alpha', 'Ann')]]);
    return { href, label: 'Doomed ' + name };
  },
  open: async (page, f) => {
    await go(page, '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await rowOf(page, f.href).getByTestId('btn-delete-collection').click();
    await tid(page, 'dialog-delete-collection').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="delete-count"]')?.dataset.count !== '', null, { timeout: 15000 });
    await tid(page, 'field-confirm-name').fill(f.label);
  },
  trigger: async (page) => { await tid(page, 'dialog-confirm-delete').click(); },
});
scenarios['session-end-password'] = deleteCase('password');
scenarios['session-end-tab'] = deleteCase('tab');
