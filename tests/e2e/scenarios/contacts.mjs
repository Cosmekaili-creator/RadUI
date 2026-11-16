// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `contacts`: the contact list (search, A-Z, windowing), the detail, create (with a real JPEG with EXIF
// orientation 6), edit (the card differs only in the edited property, checked through a DAV GET), field errors,
// birthdays (typed and picked, EN and FR), the duplicate hint, delete, a read-only grantee, an account without an
// own space, offline, a language switch with typed input, and a keyboard-only create.
// Every scenario makes its own address book through DAV, so none depends on another.
import {
  DICT, UI, assertClean, check, cryptoUuid, davGet, davPut, decodePhoto, en, focusVisible, fr, go, info, lineDiff,
  linesOf, listItems, login, makeBook, makeExifJpeg, openPage, overflow, pageChecks, propName, ready, shot, shotViewport, signIn,
  sleep, spec, tid, uniq, unfold, vcard, waitRows, waitNames, feedback,
} from '../lib/common.mjs';
import { L, addRow, bookQ, cardByUid, detailHash, editHash, enc, listHash, newHash, newItems, openBook, openDetail, rowByName, rowsOf, saveContact, waitFeedback } from '../lib/ui.mjs';

export const scenarios = {};
const CORE = spec.core['3.0'];
const BOOK3 = '/alice/contacts/';
const BIG = '/alice/big-book/';

/** A fresh vCard 3.0 book of alice with a few named cards. Returns {href, uids}. */
async function scratchBook(user = 'alice', cards = []) {
  const name = uniq('e2e');
  const href = await makeBook(user, name, 'Scratch ' + name, cards.map((c, i) => [`c${i}.vcf`, c.text]));
  return { href, name };
}
const card3 = (props, uid) => vcard('3.0', props, { uid: uid || 'urn:uuid:' + cryptoUuid() });

const RICH = (uid) => card3([
  'PRODID:-//Example//E2E//EN', 'FN:Rita Rich', 'N:Rich;Rita;;;', 'ORG:Example Org;Research', 'TITLE:Analyst',
  'TEL;TYPE=CELL,pref:+1 555 0140', 'item1.TEL:+1 555 0141', 'item1.X-ABLabel:Studio line',
  'EMAIL;TYPE=INTERNET,WORK:rita@example.org', 'ADR;TYPE=WORK:;;1 Example Road;Sampletown;;00001;Exampleland',
  'URL:https://example.org/rita', 'BDAY:1985-06-30', 'CATEGORIES:friends,colleagues', 'NOTE:First line\\nSecond line\\, with comma',
  'X-CUSTOM-FLAG:keep-me',
], uid);

// ------------------------------------------------------------------------------------------------ list
scenarios.list = async (browser) => {
  for (const vp of [{ n: 'desktop', w: 1280, h: 800 }, { n: 'phone', w: 390, h: 844 }]) {
    const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h });
    try {
      await signIn(page, 'alice');
      await openBook(page, BOOK3);
      const rows = await rowsOf(page);
      const names = rows.map((r) => r.name);
      check(await tid(page, 'contacts-count').textContent() === '33 contacts', `the count says 33 contacts (group cards are not counted): ${vp.n}`, await tid(page, 'contacts-count').textContent());
      check(rows.length === 33, `33 rows, group cards are not listed: ${vp.n}`, String(rows.length));
      check(!names.includes('Family') && !names.includes('Book club'), `group cards are not in the list: ${vp.n}`);
      const order = names.join('|');
      check(order.indexOf('Abe Archer') < order.indexOf('Carl Baker') && order.indexOf('Carl Baker') < order.indexOf('Jane Doe') && order.indexOf('Jane Doe') < order.indexOf('Jane Dorsey') && order.indexOf('Jane Dorsey') < order.indexOf('Élodie Dubois'), `rows are sorted by family name, the accented name sorts as E/D (Doe, Dorsey, Dubois, Dupont): ${vp.n}`);
      const letters = [...new Set(rows.map((r) => r.letter))];
      check(letters.includes('#') && letters.indexOf('#') === letters.length - 1, `a name outside A-Z is filed under # at the end: ${vp.n}`, letters.join(''));
      check(rows.find((r) => r.name === 'Agent 007 Example').letter === '#', `"Agent 007 Example" (family name starts with a digit) is under #: ${vp.n}`);
      check(rows.find((r) => r.name === 'Élodie Dubois').letter === 'D' && rows.find((r) => r.name === 'Cœur Dupont').letter === 'D', `Élodie Dubois and Cœur Dupont are under D (accents and ligatures folded): ${vp.n}`);
      const az = await page.$$eval('[data-testid="az-index"] button', (b) => b.map((x) => x.dataset.testid));
      check(az.includes('az-A') && az.includes('az-D') && az.includes('az-hash') && !az.includes('az-X'), `the A-Z index offers present letters and # only: ${vp.n}`, az.join(','));
      await shot(page, `contacts-list-${vp.n}-light-en`);
      await pageChecks(page, watch, `contact list ${vp.n}`);
      // search: accents, ligatures, digits of a phone number, no match, clear
      const search = tid(page, 'contacts-search');
      const names1 = async () => (await rowsOf(page)).map((r) => r.name);
      await search.fill('elodie');
      await waitNames(page, ['Élodie Dubois']);
      check(true, `search "elodie" finds Élodie (accents ignored): ${vp.n}`);
      check(await page.evaluate(() => location.hash.includes('q=elodie')), `the search text is in the URL (deep link): ${vp.n}`);
      await search.fill('coeur');
      await waitNames(page, ['Cœur Dupont']);
      check(true, `search "coeur" finds Cœur (ligature folded): ${vp.n}`);
      await search.fill('555 0126');
      await waitNames(page, ['Élodie Dubois']);
      check(true, `search by phone digits finds the owner of +1 555 0126: ${vp.n}`);
      await search.fill('jane do');
      await waitNames(page, ['Jane Doe', 'Jane Dorsey']);
      check(true, `every search word must match: "jane do" finds both Janes whose family name starts with Do: ${vp.n}`);
      await search.fill('jane doe');
      await waitNames(page, ['Jane Doe']);
      await search.fill('jane');
      await waitNames(page, ['Jane Doe', 'Jane Dorsey']);
      await page.waitForFunction(() => (document.querySelector('[data-testid="contacts-count"]') || {}).textContent.includes('2 of 33'), null, { timeout: 5000 }).catch(() => {});
      check((await tid(page, 'contacts-count').textContent()).includes('2 of 33'), `filtered count "2 of 33 contacts": ${vp.n}`, await tid(page, 'contacts-count').textContent());
      await search.fill('no-such-person');
      await page.getByTestId('contacts-no-match').waitFor();
      check((await tid(page, 'contacts-no-match').textContent()).includes('no-such-person'), `no match: the text names the query: ${vp.n}`);
      await shot(page, `contacts-nomatch-${vp.n}-light-en`);
      await search.fill('');
      await waitRows(page, 33);
      check(!(await page.evaluate(() => location.hash.includes('q='))), `clearing the search removes q from the URL: ${vp.n}`);
      // deep link to a search
      await search.blur();
      await go(page, listHash(BOOK3, '&q=zimmer'));
      await waitNames(page, ['Zoe Zimmer']);
      check(await search.inputValue() === 'zimmer', `the search box shows the text of a deep link: ${vp.n}`, await search.inputValue());
      await go(page, listHash(BOOK3));
      await waitRows(page, 33);
      await search.focus();
      await go(page, listHash(BOOK3, '&q=zimmer'));
      await waitNames(page, ['Zoe Zimmer']);
      check(await search.inputValue() === 'zimmer', `with the search box focused, a deep link that changes q also updates the box (F3): ${vp.n}`, `box shows "${await search.inputValue()}"`);
      await search.blur();
      // group filter
      await go(page, listHash(BOOK3));
      await tid(page, 'contacts-group').selectOption({ label: 'Book club' });
      await waitRows(page, 3);
      check((await rowsOf(page)).map((r) => r.name).sort().join(',') === 'Abe Archer,Jane Doe,Zoe Zimmer', `group filter "Book club" lists its three members: ${vp.n}`, (await rowsOf(page)).map((r) => r.name).join(','));
      await tid(page, 'contacts-group').selectOption('');
      await waitRows(page, 33);
      // A-Z: jump to a letter focuses that heading
      await tid(page, 'az-D').click();
      check(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'letter-D', `A-Z: D moves focus to the D heading: ${vp.n}`);
      await assertClean(page, watch, `list scenario ${vp.n}`);
    } finally {
      await ctx.close();
    }
  }
};

scenarios.windowing = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await go(page, listHash(BIG));
    await waitRows(page, 250);
    const count = (await tid(page, 'contacts-count').textContent()).trim();
    check(count === '520 contacts · showing 1–250', 'a book of 520 shows the first window and says so', count);
    const more = tid(page, 'btn-show-more');
    check((await more.textContent()).trim() === 'Show 250 more (270 not shown)', 'the button names how many more and how many are hidden', await more.textContent());
    await shot(page, 'contacts-windowing-desktop-light-en');
    await more.click();
    await waitRows(page, 500);
    check((await more.textContent()).trim() === 'Show 20 more (20 not shown)', 'the second window shows the rest as 20', await more.textContent());
    await more.click();
    await waitRows(page, 520);
    check((await tid(page, 'btn-show-more').count()) === 0 && (await tid(page, 'contacts-count').textContent()).trim() === '520 contacts', 'with everything shown the button is gone and the count is plain');
    // a letter far down: the window starts there and "show earlier" offers the rows before it
    await page.reload();
    await ready(page);
    await waitRows(page, 250);
    const lastLetter = (await rowsOf(page)).length ? await page.$$eval('[data-testid="az-index"] button', (b) => b[b.length - 1].dataset.testid) : '';
    await tid(page, lastLetter || 'az-Z').click();
    await page.waitForFunction(() => location.hash.includes('from='));
    await page.waitForSelector('[data-testid="btn-show-earlier"]');
    check((await tid(page, 'btn-show-earlier').textContent()).includes('earlier'), 'a letter jump past the first window offers "Show earlier"');
    const rows = await rowsOf(page);
    check(rows.length > 0 && rows.length <= 250, 'the window after a letter jump holds at most 250 rows', String(rows.length));
    check((await tid(page, 'contacts-count').textContent()).includes('showing'), 'the count describes the window', await tid(page, 'contacts-count').textContent());
    await tid(page, 'btn-show-earlier').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="contact-row"]').length > 250 || !document.querySelector('[data-testid="btn-show-earlier"]'));
    info(`rows after "Show earlier": ${(await rowsOf(page)).length}`);
    await pageChecks(page, watch, 'windowed list (520 contacts)');
  } finally {
    await ctx.close();
  }
};

// ---------------------------------------------------------------------------------------------- detail
scenarios.detail = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { acceptDownloads: true });
  try {
    await signIn(page, 'alice');
    await openBook(page, BOOK3);
    await rowByName(page, 'Jane Doe').click();
    await page.getByTestId('contact-detail').waitFor();
    const d = tid(page, 'contact-detail');
    check((await d.getAttribute('data-uid')) === CORE.jane && (await d.getAttribute('data-href')).endsWith('core-jane.vcf'), 'the detail carries data-uid and data-href of the card');
    check((await tid(page, 'contact-name').textContent()).trim() === 'Jane Doe' && (await tid(page, 'contact-org').textContent()).includes('Example Org'), 'name and organisation are shown');
    const tel = page.getByTestId('contact-phone').locator('a');
    check((await tel.getAttribute('href')) === 'tel:+15550123' && (await tel.textContent()).includes('555 0123'), 'the phone is a tel: link with digits only', await tel.getAttribute('href'));
    const mail = page.getByTestId('contact-email').locator('a');
    check((await mail.getAttribute('href')) === 'mailto:jane.doe@example.org', 'the e-mail is a mailto: link', await mail.getAttribute('href'));
    const bday = (await tid(page, 'contact-birthday').textContent()).replace(/\s+/g, ' ');
    check(/April 12, 1990/.test(bday) && /\(?\d+/.test(bday), 'the birthday is formatted in the display language with the age', bday);
    check((await tid(page, 'contact-categories').textContent()).includes('friends'), 'categories are chips');
    const groups = (await page.getByTestId('contact-group-link').allTextContents()).map((s) => s.trim()).sort();
    check(groups.join(',') === 'Book club,Family', 'the groups of the contact are links', groups.join(','));
    check((await tid(page, 'contact-meta').textContent()).includes('vCard 3.0'), 'the card version is stated (kept as is)');
    check((await tid(page, 'contact-phone-link').count()) === 1 && (await tid(page, 'contact-email-link').count()) === 1, 'the phone and e-mail links carry test ids (F1): contact-phone-link, contact-email-link');
    const plain = (s) => (s || '').replace(/[\u2066-\u2069]/g, '');
    check(plain(await tid(page, 'btn-edit-contact').getAttribute('aria-label')) === 'Edit «Jane Doe»' && plain(await tid(page, 'btn-delete-contact').getAttribute('aria-label')) === 'Delete «Jane Doe»', 'actions are named after the contact', plain(await tid(page, 'btn-edit-contact').getAttribute('aria-label')));
    await shot(page, 'contacts-detail-desktop-light-en');
    await pageChecks(page, watch, 'contact detail desktop');
    // export one contact: the download is the card text of the server
    const [dl] = await Promise.all([page.waitForEvent('download'), tid(page, 'btn-export-contact').click()]);
    const path = await dl.path();
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(path, 'utf8');
    const server = await cardByUid('alice', BOOK3, CORE.jane);
    check(dl.suggestedFilename().endsWith('.vcf') && lineDiff(body, server).removed.length === 0 && lineDiff(body, server).added.length === 0, 'Export downloads the card as served by the server (.vcf)', dl.suggestedFilename());
    // phone width: the detail replaces the list
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    await shot(page, 'contacts-detail-phone-light-en');
    await overflow(page, 'contact detail phone');
    await assertClean(page, watch, 'detail scenario');
  } finally {
    await ctx.close();
  }
};

// ---------------------------------------------------------------------------------------------- create
scenarios.create = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const book = await scratchBook('alice', [{ text: card3(['FN:Seed Person', 'N:Person;Seed;;;']) }]);
    await signIn(page, 'alice');
    await go(page, newHash(book.href));
    await page.getByTestId('contact-form').waitFor();
    check((await tid(page, 'contact-form').getAttribute('data-version')) === '3.0', 'a new contact in a 3.0 book is a 3.0 card');
    await shot(page, 'contact-form-new-empty-desktop-light-en');
    check((await tid(page, 'name-more-toggle').count()) === 1, 'the "More name fields" toggle has a test id (F1): name-more-toggle');
    await tid(page, 'btn-add-address').click();
    check((await tid(page, 'address-more-toggle').count()) === 1, 'the address "More" toggle has a test id (F1): address-more-toggle');
    await tid(page, 'btn-remove-address').click();
    await tid(page, 'field-given').fill('Nora');
    await tid(page, 'field-family').fill('Newcomer');
    check(await tid(page, 'field-fn').inputValue() === 'Nora Newcomer', 'the display name follows the name parts until it is edited', await tid(page, 'field-fn').inputValue());
    await tid(page, 'field-org').fill('Example Org');
    await tid(page, 'field-title').fill('Tester');
    await addRow(page, 'phone', { type: 'work', value: '+1 555 0150' });
    await addRow(page, 'email', { type: 'work', value: 'nora.newcomer@example.org' });
    await addRow(page, 'address', { type: 'home', address: { street: '2 Example Road\nApt 3', city: 'Sampletown', code: '00002', country: 'Exampleland' } });
    await addRow(page, 'url', { type: 'work', value: 'https://example.org/nora' });
    await tid(page, 'field-bday-input').fill('03/24/2000');
    await tid(page, 'field-categories').fill('friends');
    await tid(page, 'btn-add-category').click();
    await tid(page, 'field-note').fill('Line one\nLine two, with a comma; and a semicolon');
    // a real JPEG with EXIF orientation 6
    const jpeg = await makeExifJpeg(page);
    await tid(page, 'field-photo').setInputFiles({ name: 'rotated.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await page.waitForFunction(() => /Photo ready/.test((document.querySelector('[data-testid="photo-status"]') || {}).textContent || ''), null, { timeout: 20000 });
    const status = await tid(page, 'photo-status').textContent();
    check(/\((\d+)×(\d+), \d+ KB\)/.test(status) && Number(/\((\d+)×(\d+)/.exec(status)[1]) < Number(/\((\d+)×(\d+)/.exec(status)[2]), 'the photo is processed upright: a 300x150 file with orientation 6 is reported portrait', status);
    await shot(page, 'contact-form-new-filled-desktop-light-en');
    await pageChecks(page, watch, 'new contact form (filled)');
    const before = await listItems('alice', book.href);
    await saveContact(page);
    const fresh = await newItems('alice', book.href, before);
    check(fresh.length === 1, 'one new card appears on the server', String(fresh.length));
    const text = (await davGet('alice', fresh[0].href)).text;
    const lines = unfold(text);
    check(lines.includes('VERSION:3.0') && lines.some((l) => l === 'FN:Nora Newcomer') && lines.some((l) => l === 'N:Newcomer;Nora;;;'), 'the card is vCard 3.0 with FN and N', lines.slice(0, 8).join(' | '));
    check(linesOf(text, 'TEL')[0].endsWith('+1 555 0150') && /TYPE=WORK/i.test(linesOf(text, 'TEL')[0]), 'phone with its type', linesOf(text, 'TEL').join('|'));
    check(linesOf(text, 'EMAIL')[0].endsWith(':nora.newcomer@example.org'), 'e-mail', linesOf(text, 'EMAIL').join('|'));
    check(linesOf(text, 'ADR')[0].includes('2 Example Road\\nApt 3') && linesOf(text, 'ADR')[0].includes('Sampletown'), 'address with a line break kept in the street', linesOf(text, 'ADR').join('|'));
    check(/^BDAY:2000-?03-?24$/.test(linesOf(text, 'BDAY')[0]), 'birthday 2000-03-24', linesOf(text, 'BDAY').join('|'));
    check(linesOf(text, 'CATEGORIES')[0] === 'CATEGORIES:friends', 'category', linesOf(text, 'CATEGORIES').join('|'));
    check(linesOf(text, 'NOTE')[0].includes('Line one\\nLine two\\, with a comma\\; and a semicolon'), 'note with line break, comma and semicolon escaped', linesOf(text, 'NOTE').join('|'));
    check(linesOf(text, 'ORG')[0] === 'ORG:Example Org' && linesOf(text, 'TITLE')[0] === 'TITLE:Tester', 'organisation and title');
    const px = await decodePhoto(page, text);
    check(px && px.width < px.height && Math.max(px.width, px.height) <= 256, 'the stored photo is upright (portrait) and at most 256 px', JSON.stringify(px));
    check(px && px.left[2] > 150 && px.left[0] < 90 && px.right[0] > 150 && px.right[2] < 90, 'the stored photo has the blue half on the left and the red half on the right: the EXIF rotation was applied and the EXIF block is gone', JSON.stringify(px));
    check(!/EXIF|GPS/i.test(Buffer.from(/PHOTO[^:]*:([A-Za-z0-9+/=\s]+)/.exec(unfold(text).find((l) => propName(l) === 'PHOTO') + '')[1], 'base64').toString('latin1')), 'the stored photo carries no EXIF block');
    // the detail after saving
    await page.getByTestId('contact-detail').waitFor();
    check((await tid(page, 'contact-name').textContent()).trim() === 'Nora Newcomer', 'after saving the detail of the new contact opens');
    const img = page.getByTestId('contact-avatar').locator('img');
    check((await img.count()) === 1 && (await img.evaluate((i) => i.naturalWidth > 0 && i.src.startsWith('data:image/jpeg'))), 'the detail shows the photo (a data: image of the allowed type)');
    await shot(page, 'contact-detail-after-create-desktop-light-en');
    await assertClean(page, watch, 'create scenario');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------------------ edit
/** Edit through the form and compare the card on the server before and after (only `allowed` properties may differ). */
async function editAndDiff(page, book, uid, label, mutate, allowed) {
  const before = await cardByUid('alice', book, uid);
  await go(page, editHash(book, uid));
  await page.getByTestId('contact-form').waitFor();
  await mutate(page);
  await saveContact(page);
  const after = await cardByUid('alice', book, uid);
  const d = lineDiff(before, after);
  const names = new Set([...d.removed, ...d.added].map(propName));
  const extra = [...names].filter((n) => !allowed.includes(n));
  check(extra.length === 0 && d.added.length + d.removed.length > 0, `${label}: the card differs only in ${allowed.join('/')}`, `removed ${JSON.stringify(d.removed)} added ${JSON.stringify(d.added)}`);
  return { before, after, diff: d };
}

scenarios.edit = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const uid = 'urn:uuid:' + cryptoUuid();
    const book = await scratchBook('alice', [{ text: RICH(uid) }]);
    await signIn(page, 'alice');
    await go(page, editHash(book.href, uid));
    await page.getByTestId('contact-form').waitFor();
    check(await tid(page, 'field-given').inputValue() === 'Rita' && await tid(page, 'field-family').inputValue() === 'Rich' && await tid(page, 'field-org').inputValue() === 'Example Org' && await tid(page, 'field-department').inputValue() === 'Research' && await tid(page, 'field-title').inputValue() === 'Analyst', 'the edit form shows the stored values (names, organisation, department, title)');
    check((await page.getByTestId('phone-row').count()) === 2 && await page.getByTestId('field-phone-type').first().inputValue() === 'cell' && await page.getByTestId('field-phone-custom').nth(1).inputValue() === 'Studio line', 'two phone rows: the first typed "cell", the second with its custom label "Studio line"');
    check(await tid(page, 'field-note').inputValue() === 'First line\nSecond line, with comma', 'the note keeps its line break and comma');
    await shot(page, 'contact-form-edit-desktop-light-en');
    await pageChecks(page, watch, 'edit form');
    // no change: no request
    const etag0 = (await listItems('alice', book.href)).map((i) => i.etag).join();
    await tid(page, 'contact-save').click();
    await waitFeedback(page, 'status', 'No changes to save');
    check((await listItems('alice', book.href)).map((i) => i.etag).join() === etag0 && /edit/.test(await page.evaluate(() => location.hash)), 'saving an untouched form says "No changes to save" and sends nothing (ETag unchanged, form stays open)');
    await shot(page, 'contact-form-nochange-desktop-light-en');
    // one field at a time
    await editAndDiff(page, book.href, uid, 'title', async (p) => { await tid(p, 'field-title').fill('Senior analyst'); }, ['TITLE', 'REV']);
    await editAndDiff(page, book.href, uid, 'first phone number', async (p) => { await p.getByTestId('field-phone-value').first().fill('+1 555 0149'); }, ['TEL', 'REV']);
    await editAndDiff(page, book.href, uid, 'a category added', async (p) => { await tid(p, 'field-categories').fill('family'); await tid(p, 'btn-add-category').click(); }, ['CATEGORIES', 'REV']);
    await editAndDiff(page, book.href, uid, 'the labelled phone row removed', async (p) => { await p.getByTestId('btn-remove-phone').nth(1).click(); }, ['TEL', 'X-ABLABEL', 'REV']);
    const r = await editAndDiff(page, book.href, uid, 'the note', async (p) => { await tid(p, 'field-note').fill('Only one line now'); }, ['NOTE', 'REV']);
    check(linesOf(r.after, 'X-CUSTOM-FLAG')[0] === 'X-CUSTOM-FLAG:keep-me' && linesOf(r.after, 'BDAY')[0] === 'BDAY:1985-06-30' && linesOf(r.after, 'EMAIL').length === 1 && linesOf(r.after, 'ADR').length === 1, 'properties the form does not edit (X- flag, birthday, e-mail, address) are still there after five saves');
    // the detail after the last save, and the cancel link
    await page.getByTestId('contact-detail').waitFor();
    check((await tid(page, 'contact-url-link').count()) === 1, 'the web link carries a test id (F1): contact-url-link');
    await tid(page, 'btn-edit-contact').click();
    await page.getByTestId('contact-form').waitFor();
    await tid(page, 'field-title').fill('Changed but cancelled');
    await tid(page, 'contact-cancel').click();
    await page.getByTestId('dialog-discard-changes').waitFor();
    await shot(page, 'contact-form-discard-dialog-desktop-light-en');
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'dialog-keep-editing', 'leaving a changed form asks first and focuses "Keep editing"');
    await tid(page, 'dialog-discard').click();
    await page.getByTestId('contact-detail').waitFor();
    const final = await cardByUid('alice', book.href, uid);
    check(!final.includes('Changed but cancelled'), 'discarding changes leaves the card as it was');
    await assertClean(page, watch, 'edit scenario');
  } finally {
    await ctx.close();
  }
};

// ---------------------------------------------------------------------------------------- field errors
scenarios.errors = async (browser) => {
  for (const lang of ['en', 'fr']) {
    const D = DICT[lang];
    const { ctx, page, watch } = await openPage(browser, { lang, w: lang === 'en' ? 1280 : 390, h: lang === 'en' ? 800 : 844 });
    try {
      const book = await scratchBook('alice', []);
      await signIn(page, 'alice');
      await go(page, newHash(book.href));
      await page.getByTestId('contact-form').waitFor();
      await tid(page, 'contact-save').click();
      const errs = tid(page, 'form-errors');
      await errs.waitFor({ state: 'visible' });
      check((await errs.getAttribute('role')) === 'alert' && (await errs.textContent()).includes(D['contact.err.name']), `an empty form: an alert summary says a name is required (${lang})`, await errs.textContent());
      check((await page.getByTestId('form-error-link').count()) === 1, `the summary has one link per problem (${lang})`);
      await shot(page, `contact-form-errors-empty-${lang}`);
      // several problems at once
      await tid(page, 'field-given').fill('Err');
      await addRow(page, 'phone', { value: 'ab' });
      await addRow(page, 'email', { value: 'not-an-email' });
      await addRow(page, 'url', { value: 'example.org/no-scheme' });
      await tid(page, 'field-bday-input').fill(lang === 'en' ? '02/31/2000' : '31/02/2000');
      await tid(page, 'contact-save').click();
      const listed = await page.waitForFunction(() => document.querySelectorAll('[data-testid="form-error-link"]').length >= 4, null, { timeout: 3000 }).then(() => true, () => false);
      check(listed, `ONE click on Save while the birthday field holds an invalid date lists the problems: the error line of the date field no longer moves the button (F4) (${lang})`);
      if (!listed) await tid(page, 'contact-save').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="form-error-link"]').length >= 4, null, { timeout: 5000 }).catch(() => {});
      const links = await page.getByTestId('form-error-link').allTextContents();
      check(links.length === 4, `four problems are listed: phone, e-mail, web address, birthday (${lang})`, links.join(' | '));
      const email = page.getByTestId('field-email-value');
      const describedBy = await email.getAttribute('aria-describedby');
      const msg = await page.evaluate((ids) => ids.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' '), describedBy || '');
      check((await email.getAttribute('aria-invalid')) === 'true' && msg.includes(D['contact.err.email']), `the e-mail field is aria-invalid and aria-describedby points at its message (${lang})`, `${describedBy} -> ${msg}`);
      const phoneMsg = await page.evaluate((id) => (document.getElementById(id) || {}).textContent || '', (await page.getByTestId('field-phone-value').getAttribute('aria-describedby') || '').split(/\s+/).pop());
      check(phoneMsg.includes(D['contact.err.phone'].slice(0, 20)), `the phone field has its own message (${lang})`, phoneMsg);
      const bd = tid(page, 'field-bday-input');
      check((await bd.getAttribute('aria-invalid')) === 'true' && (await bd.getAttribute('aria-describedby')) !== null, `the birthday field is aria-invalid and described (${lang})`);
      await shot(page, `contact-form-errors-several-${lang}`);
      await pageChecks(page, watch, `form with errors ${lang}`);
      // a link in the summary moves focus to the field
      await page.getByTestId('form-error-link').nth(1).click();
      check(await page.evaluate(() => document.activeElement.dataset.testid) === 'field-email-value', `a summary link moves focus to its field (${lang})`, await page.evaluate(() => document.activeElement.dataset.testid));
      // correcting the fields clears the errors and saves
      await page.getByTestId('field-phone-value').fill('+1 555 0161');
      await email.fill('err.test@example.org');
      await page.getByTestId('field-url-value').fill('https://example.org/err');
      await bd.fill(lang === 'en' ? '02/29/2000' : '29/02/2000');
      const before = await listItems('alice', book.href);
      await saveContact(page);
      const fresh = await newItems('alice', book.href, before);
      const text = (await davGet('alice', fresh[0].href)).text;
      check(fresh.length === 1 && /^BDAY:2000-?02-?29$/.test(linesOf(text, 'BDAY')[0]), `after correcting the fields the card is created, a real leap-day birthday accepted (${lang})`, linesOf(text, 'BDAY').join());
      // a birthday in the future
      await go(page, newHash(book.href));
      await tid(page, 'field-given').fill('Future');
      const next = new Date(Date.now() + 366 * 86400000);
      const pad = (n) => String(n).padStart(2, '0');
      await tid(page, 'field-bday-input').fill(`${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`);
      await tid(page, 'contact-save').click();
      await errs.waitFor({ state: 'visible' });
      check((await errs.textContent()).includes(D['contact.err.bdayFuture']), `a birthday in the future is refused (${lang})`, await errs.textContent());
      await assertClean(page, watch, `errors scenario ${lang}`);
    } finally {
      await ctx.close();
    }
  }
};

// ----------------------------------------------------------------------------------------- birthdays
scenarios.birthday = async (browser) => {
  for (const lang of ['en', 'fr']) {
    const D = DICT[lang];
    const { ctx, page, watch } = await openPage(browser, { lang });
    try {
      const book = await scratchBook('alice', []);
      await signIn(page, 'alice');
      const typed = lang === 'en' ? '03/24/2000' : '24/03/2000';
      const picked = lang === 'en' ? '07/04/1985' : '04/07/1985';
      for (const mode of ['typed', 'picked', 'yearless']) {
        await go(page, newHash(book.href));
        await page.getByTestId('contact-form').waitFor();
        await tid(page, 'field-given').fill(`Bday${mode}`);
        const input = tid(page, 'field-bday-input');
        const placeholder = await input.getAttribute('placeholder');
        if (mode === 'typed') {
          check(placeholder === (lang === 'en' ? 'MM/DD/YYYY' : 'JJ/MM/AAAA'), `the birthday hint shows the ${lang.toUpperCase()} date order (${placeholder})`);
          await input.fill(typed);
        } else if (mode === 'picked') {
          await tid(page, 'field-bday-picker').click();
          const dlg = page.getByTestId('field-bday-picker-dialog');
          await dlg.waitFor();
          await shot(page, `contact-form-datepicker-${lang}`);
          await page.getByTestId('field-bday-picker-year').fill('1985');
          await page.getByTestId('field-bday-picker-year').press('Tab');
          await page.getByTestId('field-bday-picker-month').selectOption('7');
          await page.locator('[data-testid="field-bday-picker-day"][data-date="1985-07-04"]').click();
          await dlg.waitFor({ state: 'detached' });
          check(await input.inputValue() === picked, `the picked date is written in the ${lang.toUpperCase()} order: ${picked}`, await input.inputValue());
        } else {
          await input.fill(lang === 'en' ? '03/24' : '24/03');
        }
        const before = await listItems('alice', book.href);
        await saveContact(page);
        const fresh = await newItems('alice', book.href, before);
        const text = (await davGet('alice', fresh[0].href)).text;
        const bday = linesOf(text, 'BDAY').join('|');
        if (mode === 'typed') check(/^BDAY:2000-?03-?24$/.test(bday), `typed ${typed} is stored as 2000-03-24 (${lang})`, bday);
        else if (mode === 'picked') check(/^BDAY:1985-?07-?04$/.test(bday), `picked 1985-07-04 is stored as 1985-07-04 (${lang})`, bday);
        else info(`year-less birthday ${lang} stored on a vCard 3.0 card as: ${bday} ${linesOf(text, 'X-APPLE-OMIT-YEAR').join()}`);
        await tid(page, 'btn-edit-contact').click();
        await page.getByTestId('contact-form').waitFor();
        const shown = await tid(page, 'field-bday-input').inputValue();
        if (mode === 'typed') check(shown === typed, `reopened for editing, the birthday shows as typed: ${typed} (${lang})`, shown);
        if (mode === 'typed') await shot(page, `contact-form-birthday-edit-${lang}`);
      }
      await assertClean(page, watch, `birthday scenario ${lang}`);
    } finally {
      await ctx.close();
    }
  }
};

// ------------------------------------------------------------------------------------ duplicate hint
scenarios.duplicate = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await go(page, newHash(BOOK3));
    const hint = tid(page, 'duplicate-hint');
    check(await hint.isHidden(), 'no duplicate hint on an empty form');
    await tid(page, 'field-given').fill('Jane');
    await tid(page, 'field-family').fill('Doe');
    await hint.waitFor({ state: 'visible' });
    const link = page.getByTestId('duplicate-link');
    check((await hint.getAttribute('role')) === 'status' && (await link.first().textContent()).includes('Jane Doe') && (await link.first().getAttribute('href')).includes(enc(CORE.jane)), 'typing the name of an existing contact shows a non-blocking hint with a link to it', await hint.textContent());
    await shot(page, 'contact-form-duplicate-hint-desktop-light-en');
    await tid(page, 'field-given').fill('Someone');
    await tid(page, 'field-family').fill('Else');
    await hint.waitFor({ state: 'hidden' });
    await addRow(page, 'email', { value: 'rick.roe@example.org' });
    await hint.waitFor({ state: 'visible' });
    check((await hint.textContent()).includes('Rick Roe'), 'the same e-mail address as an existing contact also shows the hint', await hint.textContent());
    check(await tid(page, 'contact-save').isEnabled(), 'the hint does not block saving');
    await assertClean(page, watch, 'duplicate scenario');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------------- delete
scenarios.delete = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const A = 'urn:uuid:' + cryptoUuid();
    const B = 'urn:uuid:' + cryptoUuid();
    const grp = (uid, name, members) => card3(['X-ADDRESSBOOKSERVER-KIND:group', `FN:${name}`, `N:${name};;;;`, ...members.map((m) => `X-ADDRESSBOOKSERVER-MEMBER:${m}`)], uid);
    const G1 = 'urn:uuid:' + cryptoUuid();
    const G2 = 'urn:uuid:' + cryptoUuid();
    const book = await scratchBook('alice', [
      { text: card3(['FN:Delia Doomed', 'N:Doomed;Delia;;;', 'EMAIL:delia@example.org'], A) },
      { text: card3(['FN:Bert Bystander', 'N:Bystander;Bert;;;'], B) },
      { text: grp(G1, 'Team', [A, B]) },
      { text: grp(G2, 'Solo', [A]) },
    ]);
    await signIn(page, 'alice');
    await openDetail(page, book.href, A);
    await tid(page, 'btn-delete-contact').click();
    const dlg = tid(page, 'dialog-delete-contact');
    await dlg.waitFor();
    const note = (await tid(page, 'delete-groups-note').textContent()).trim();
    check(/Also removed from 2 groups: /.test(note) && note.includes('Team') && note.includes('Solo'), 'the delete dialog names the groups the contact leaves', note);
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'dialog-cancel', 'the destructive dialog focuses Cancel first');
    const confirmName = (await tid(page, 'dialog-confirm-delete').textContent()).replace(/[⁦-⁩]/g, '');
    check(confirmName.trim() === 'Delete «Delia Doomed»', 'the confirm button is named after the contact', confirmName);
    await shot(page, 'contact-delete-dialog-desktop-light-en');
    await pageChecks(page, watch, 'delete dialog');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    check((await cardByUid('alice', book.href, A)) !== null, 'Esc cancels: the card is still on the server');
    await tid(page, 'btn-delete-contact').click();
    await dlg.waitFor();
    await tid(page, 'dialog-confirm-delete').click();
    await page.waitForFunction(() => !location.hash.includes('urn%3Auuid'), null, { timeout: 20000 });
    await ready(page);
    check((await cardByUid('alice', book.href, A)) === null, 'the contact is gone from the server');
    const g1 = await cardByUid('alice', book.href, G1);
    const g2 = await cardByUid('alice', book.href, G2);
    check(g1 && !g1.includes(A) && g1.includes(B), 'the group "Team" lost only the deleted member (Bert is still in it)', linesOf(g1 || '', 'X-ADDRESSBOOKSERVER-MEMBER').join());
    check(g2 && !g2.includes(A), 'the group "Solo" lost its only member', linesOf(g2 || '', 'X-ADDRESSBOOKSERVER-MEMBER').join());
    check(await page.getByTestId('contact-row').count() === 1, 'the list shows the one remaining contact (group cards are not contacts)');
    check((await tid(page, 'status-text').textContent()).length > 0, 'a persistent status text says what happened', await tid(page, 'status-text').textContent());
    await shot(page, 'contacts-after-delete-desktop-light-en');
    await assertClean(page, watch, 'delete scenario');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------ read-only grantee, no own space
scenarios['read-only'] = async (browser) => {
  for (const lang of ['en', 'fr']) {
    const D = DICT[lang];
    const { ctx, page, watch } = await openPage(browser, { lang, w: lang === 'en' ? 1280 : 390, h: lang === 'en' ? 800 : 844 });
    try {
      await signIn(page, 'agent-1');
      await openBook(page, '/bob/bob-book/');
      const note = tid(page, 'contacts-readonly');
      check(await note.isVisible() && (await note.textContent()).includes(D['contacts.readonly.text']), `a read-only grantee sees the read-only notice (${lang})`);
      const nw = tid(page, 'btn-new-contact');
      check((await nw.getAttribute('aria-disabled')) === 'true' && (await nw.getAttribute('aria-describedby')) === 'contacts-readonly-note', `"New contact" stays visible, aria-disabled and described by the notice (${lang})`);
      check(await tid(page, 'btn-import-vcf').isHidden(), `no Import button for a read-only book (${lang})`);
      await rowByName(page, 'Jane Doe').click();
      await page.getByTestId('contact-detail').waitFor();
      check((await tid(page, 'btn-edit-contact').count()) === 0 && (await tid(page, 'btn-delete-contact').count()) === 0 && (await tid(page, 'btn-add-to-group').count()) === 0 && (await tid(page, 'btn-export-contact').count()) === 1, `the detail has no edit, delete or add-to-group, only Export (${lang})`);
      await shot(page, `contacts-readonly-${lang}`);
      await pageChecks(page, watch, `read-only grantee ${lang}`);
      await go(page, `#/contacts/new?ab=${enc('/bob/bob-book/')}`);
      await page.getByTestId('contact-form-readonly').waitFor();
      check(true, `the new-contact route of a read-only book shows an explanation, not a form (${lang})`);
      await go(page, `#/contacts/groups?ab=${enc('/bob/bob-book/')}`);
      check((await tid(page, 'btn-new-group').count()) === 0, `no "New group" button for a read-only grantee (${lang})`);
      // the read-write grantee of the same account has the controls
      await openBook(page, '/alice/contacts/');
      check(!(await nw.getAttribute('aria-disabled')) && (await tid(page, 'btn-import-vcf').isVisible()) && (await tid(page, 'contacts-readonly').isHidden()), `a read-write grant gives the write controls (${lang})`);
      await assertClean(page, watch, `read-only scenario ${lang}`);
    } finally {
      await ctx.close();
    }
  }
};

scenarios['no-own-space'] = async (browser) => {
  for (const vp of [{ n: 'desktop', w: 1280, h: 800 }, { n: 'phone', w: 390, h: 844 }]) {
    const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h });
    try {
      await signIn(page, 'carol');
      await page.getByTestId('contacts-noaccess').waitFor();
      check((await tid(page, 'contacts-noaccess').textContent()).includes(en['contacts.noaccess.title']) && (await tid(page, 'btn-new-contact').isHidden()), `an account without an own space and without grants sees "${en['contacts.noaccess.title']}" and no create control: ${vp.n}`);
      await shot(page, `contacts-noaccess-${vp.n}-light-en`);
      await pageChecks(page, watch, `no own space contacts ${vp.n}`);
      await go(page, '#/collections');
      await page.getByTestId('own-space-disabled').waitFor();
      check((await tid(page, 'btn-new-calendar').isHidden()) && (await tid(page, 'btn-new-addressbook').isHidden()), `Collections: the create buttons are hidden and the reason is shown: ${vp.n}`);
      await shot(page, `collections-no-own-space-${vp.n}-light-en`);
      await pageChecks(page, watch, `no own space collections ${vp.n}`);
      await go(page, '#/contacts/new');
      check((await page.getByTestId('contact-form').count()) === 0, `the new-contact route shows no form for this account: ${vp.n}`);
    } finally {
      await ctx.close();
    }
  }
};

// ----------------------------------------------------------------------------------------------- offline
scenarios.offline = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const uid = 'urn:uuid:' + cryptoUuid();
    const book = await scratchBook('alice', [{ text: RICH(uid) }]);
    await signIn(page, 'alice');
    await openDetail(page, book.href, uid);
    const banner = tid(page, 'banner-offline');
    check(await banner.isHidden(), 'online: no offline banner');
    const editName = await tid(page, 'btn-edit-contact').getAttribute('aria-label');
    await ctx.setOffline(true);
    await banner.waitFor({ state: 'visible' });
    check((await banner.getAttribute('role')) === 'status' && (await banner.textContent()).includes(en['shell.offline']), 'offline: a persistent status banner says changes are disabled', await banner.textContent());
    const off = await tid(page, 'btn-edit-contact').getAttribute('aria-label');
    check(await tid(page, 'btn-edit-contact').isDisabled() && off.includes('(offline: changes disabled)') && off.startsWith(editName.replace(/\s+$/, '')), 'offline: Edit is disabled and its accessible name says why', off);
    check(await tid(page, 'btn-delete-contact').isDisabled(), 'offline: Delete is disabled');
    check(await tid(page, 'btn-export-contact').isEnabled(), 'offline: Export of the contact in memory still works');
    check((await tid(page, 'contact-name').textContent()).trim() === 'Rita Rich', 'offline: data already in memory stays readable');
    await shot(page, 'contact-detail-offline-desktop-light-en');
    await pageChecks(page, watch, 'detail offline', { skip: ['a11y'] });
    await ctx.setOffline(false);
    await banner.waitFor({ state: 'hidden' });
    check(await tid(page, 'btn-edit-contact').isEnabled() && (await tid(page, 'btn-edit-contact').getAttribute('aria-label')) === editName, 'back online: the banner is gone, Edit is enabled and has its plain name again');
    // the edit form: Save is disabled offline
    await tid(page, 'btn-edit-contact').click();
    await page.getByTestId('contact-form').waitFor();
    await tid(page, 'field-title').fill('Offline edit');
    await ctx.setOffline(true);
    await banner.waitFor({ state: 'visible' });
    const save = tid(page, 'contact-save');
    check(await save.isDisabled() && ((await save.getAttribute('aria-label')) || '').includes('(offline: changes disabled)'), 'offline: Save is disabled with an explanatory name, the typed text stays', (await save.getAttribute('aria-label')) || '');
    check(await tid(page, 'field-title').inputValue() === 'Offline edit', 'offline: the typed input is still in the form');
    await shot(page, 'contact-form-offline-desktop-light-en');
    await ctx.setOffline(false);
    await banner.waitFor({ state: 'hidden' });
    check(await save.isEnabled(), 'back online: Save is enabled again');
    await page.evaluate(() => { location.hash = '#/contacts'; });
    await tid(page, 'dialog-discard').click();
    await assertClean(page, watch, 'offline scenario', { external: true });
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------------ language
scenarios.language = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openBook(page, BOOK3);
    await tid(page, 'contacts-search').fill('zim');
    await waitNames(page, ['Zoe Zimmer']);
    await tid(page, 'lang-select').selectOption('fr');
    await page.waitForFunction((t) => (document.querySelector('[data-testid="btn-new-contact"]') || {}).textContent === t, fr['contacts.new']);
    check(await tid(page, 'contacts-search').inputValue() === 'zim', 'a language switch keeps the text typed in the search box');
    await waitNames(page, ['Zoe Zimmer']);
    check(true, 'and the list stays filtered');
    await shot(page, 'contacts-list-desktop-light-fr');
    await go(page, newHash(BOOK3));
    await page.getByTestId('contact-form').waitFor();
    await tid(page, 'field-given').fill('Lang');
    await tid(page, 'field-family').fill('Switch');
    await addRow(page, 'phone', { type: 'home', value: '+1 555 0171' });
    await addRow(page, 'email', { value: 'lang.switch@example.org' });
    await tid(page, 'field-bday-input').fill('03/24/2000');
    await tid(page, 'field-categories').fill('typed');
    await tid(page, 'btn-add-category').click();
    await tid(page, 'field-note').fill('Typed before the switch\nsecond line');
    await tid(page, 'lang-select').selectOption('fr');
    await page.waitForFunction((t) => (document.querySelector('[data-testid="contact-save"]') || {}).textContent === t, fr['contact.form.create']);
    const kept = await page.evaluate(() => ({
      given: document.querySelector('[data-testid="field-given"]').value, family: document.querySelector('[data-testid="field-family"]').value, fn: document.querySelector('[data-testid="field-fn"]').value,
      phone: document.querySelector('[data-testid="field-phone-value"]')?.value, phones: document.querySelectorAll('[data-testid="phone-row"]').length, email: document.querySelector('[data-testid="field-email-value"]')?.value,
      bday: document.querySelector('[data-testid="field-bday-input"]').value, chips: document.querySelectorAll('[data-testid="category-chip"]').length, note: document.querySelector('[data-testid="field-note"]').value,
      type: document.querySelector('[data-testid="field-phone-type"]')?.value,
    }));
    check(kept.given === 'Lang' && kept.family === 'Switch' && kept.fn === 'Lang Switch' && kept.phone === '+1 555 0171' && kept.phones === 1 && kept.email === 'lang.switch@example.org' && kept.chips === 1 && kept.note === 'Typed before the switch\nsecond line' && kept.type === 'home', 'a language switch keeps everything typed in the new-contact form (names, rows, types, chips, note)', JSON.stringify(kept));
    check(kept.bday === '03/24/2000', 'the typed birthday text is kept as typed (the date order of the new language applies when it is re-read)', kept.bday);
    check((await tid(page, 'field-bday-input').getAttribute('placeholder')) === 'JJ/MM/AAAA', 'the date hint is now in the French order');
    await shot(page, 'contact-form-new-after-switch-desktop-light-fr');
    await pageChecks(page, watch, 'form after a language switch (fr)');
    await tid(page, 'lang-select').selectOption('en');
    await page.waitForFunction((t) => (document.querySelector('[data-testid="contact-save"]') || {}).textContent === t, en['contact.form.create']);
    check(await tid(page, 'field-given').inputValue() === 'Lang' && (await page.getByTestId('category-chip').count()) === 1, 'and back to English: still kept');
    await page.evaluate(() => { location.hash = '#/contacts'; });
    await tid(page, 'dialog-discard').click();
    await assertClean(page, watch, 'language scenario');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------- keyboard only
scenarios.keyboard = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const book = await scratchBook('alice', [{ text: card3(['FN:Seed Person', 'N:Person;Seed;;;']) }]);
    await signIn(page, 'alice');
    await openBook(page, book.href);
    const focused = () => page.evaluate(() => (document.activeElement && document.activeElement.dataset.testid) || document.activeElement.tagName);
    const tabTo = async (id, max = 40) => {
      for (let i = 0; i < max; i++) {
        if ((await focused()) === id) return true;
        await page.keyboard.press('Tab');
      }
      return (await focused()) === id;
    };
    await tid(page, 'contacts-search').focus();
    check(await tabTo('btn-new-contact'), 'Tab reaches "New contact" from the search box');
    await focusVisible(page, 'New contact');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="contact-form"]');
    check(await page.evaluate(() => document.activeElement.id) === 'cf-title', 'the form opens with focus on its heading');
    check(await tabTo('field-given'), 'Tab reaches the given name');
    await page.keyboard.type('Kay');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Keyboard');
    check(await tabTo('btn-add-phone'), 'Tab reaches "Add a phone"');
    await page.keyboard.press('Enter');
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'field-phone-type' || await tabTo('field-phone-value', 4), 'adding a phone by keyboard puts focus in the new row');
    check(await tabTo('field-phone-value', 6), 'Tab reaches the phone value');
    await page.keyboard.type('+1 555 0181');
    await focusVisible(page, 'phone value');
    check(await tabTo('field-bday-input'), 'Tab reaches the birthday field');
    await page.keyboard.type('03/24/2000');
    check(await tabTo('field-categories'), 'Tab reaches the categories field');
    await page.keyboard.type('keys');
    await page.keyboard.press('Enter');
    check((await page.getByTestId('category-chip').count()) === 1 && (await page.getByTestId('contact-form').count()) === 1, 'Enter in the categories field adds a chip and does not submit the form');
    check(await tabTo('contact-save'), 'Tab reaches Create contact');
    await focusVisible(page, 'Create contact');
    await shot(page, 'contact-form-keyboard-desktop-light-en');
    const before = await listItems('alice', book.href);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !/\/new(\?|$)/.test(location.hash), null, { timeout: 30000 });
    const fresh = await newItems('alice', book.href, before);
    const text = fresh.length ? (await davGet('alice', fresh[0].href)).text : '';
    check(fresh.length === 1 && linesOf(text, 'FN')[0] === 'FN:Kay Keyboard' && linesOf(text, 'TEL')[0].endsWith('+1 555 0181') && linesOf(text, 'CATEGORIES')[0] === 'CATEGORIES:keys', 'the contact made with the keyboard alone is on the server', linesOf(text, 'FN').join());
    await assertClean(page, watch, 'keyboard scenario');
  } finally {
    await ctx.close();
  }
};

// ----------------------------------------------------------------------- an insecure (plain http) context
// A page served over plain http from a host that is not localhost has no crypto.randomUUID (review F2). The first
// scenario removes only that function: getRandomValues still exists in an insecure context, so Create must WORK and
// the UID must be a version-4 UUID. The second removes every secure random source: Create must say so in persistent
// text, with no uncaught error, and write nothing (there is never a Math.random fallback).
scenarios['insecure-context'] = async (browser) => {
  {
    const { ctx, page, watch } = await openPage(browser);
    try {
      await ctx.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }); });
      const book = await scratchBook('alice', []);
      await signIn(page, 'alice');
      check(await page.evaluate(() => typeof crypto.randomUUID === 'undefined' && typeof crypto.getRandomValues === 'function'), 'the page has getRandomValues but no crypto.randomUUID (simulated insecure context)');
      await go(page, newHash(book.href));
      await tid(page, 'field-given').fill('Plain');
      await tid(page, 'field-family').fill('Http');
      const before = await listItems('alice', book.href);
      await saveContact(page);
      const fresh = await newItems('alice', book.href, before);
      const text = fresh.length ? (await davGet('alice', fresh[0].href)).text : '';
      check(fresh.length === 1 && /^UID:(urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/m.test(unfold(text).find((l) => l.startsWith('UID:')) || ''), 'without crypto.randomUUID Create still works and the UID is a version-4 UUID (F2)', unfold(text).find((l) => l.startsWith('UID:')) || 'no card');
      await assertClean(page, watch, 'create without randomUUID');
    } finally {
      await ctx.close();
    }
  }
  const { ctx, page, watch } = await openPage(browser);
  try {
    await ctx.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
      Object.defineProperty(Crypto.prototype, 'getRandomValues', { value: undefined, configurable: true });
    });
    const book = await scratchBook('alice', []);
    await signIn(page, 'alice');
    await go(page, newHash(book.href));
    await tid(page, 'field-given').fill('Plain');
    await tid(page, 'field-family').fill('Http');
    const before = await listItems('alice', book.href);
    await tid(page, 'contact-save').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="form-errors"]') || {}).hidden === false || ((document.querySelector('[data-testid="alert-text"]') || {}).textContent || '').length > 0, null, { timeout: 8000 }).catch(() => {});
    const fb = await feedback(page);
    const visible = (await page.getByTestId('form-errors').isVisible()) || fb.alert.length > 0;
    const msg = (await page.getByTestId('form-errors').isVisible()) ? await tid(page, 'form-errors').textContent() : fb.alert;
    check(visible && watch.pageErrors.length === 0, 'with no secure random source Create shows a persistent message and raises no uncaught error (F2)', `message "${(msg || '').trim().slice(0, 80)}", uncaught: ${watch.pageErrors.slice(0, 1).join()}`);
    check((await tid(page, 'form-errors').getAttribute('role')) === 'alert' || fb.alert.length > 0, 'the message is an alert region text');
    check((await newItems('alice', book.href, before)).length === 0, 'nothing was written to the server');
    await tid(page, 'field-given').fill('Plain 2');
    check(await tid(page, 'contact-save').isEnabled(), 'the form stays usable after the refusal');
    await page.evaluate(() => { location.hash = '#/contacts'; });
    const d = page.getByTestId('dialog-discard');
    if (await d.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) await d.click();
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------ the placeholder of the detail pane (review minor 9)
scenarios.placeholder = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const empty = await scratchBook('alice', []);
    await signIn(page, 'alice');
    await openBook(page, BOOK3);
    check(await tid(page, 'contact-pick').isVisible(), 'a list with contacts shows "Choose a contact to see it here"');
    await rowByName(page, 'Jane Doe').click();
    await page.getByTestId('contact-detail').waitFor();
    check((await tid(page, 'contact-pick').count()) === 0, 'once a contact is open the placeholder is gone');
    await openBook(page, empty.href);
    await page.getByTestId('contacts-empty').waitFor();
    check((await tid(page, 'contact-pick').count()) === 0, 'an empty address book does not offer to choose a contact');
    await shot(page, 'contacts-empty-no-placeholder-desktop-light-en');
    await go(page, listHash(BOOK3, '&q=no-such-person-here'));
    await page.getByTestId('contacts-no-match').waitFor();
    info(`a search without a match: the placeholder is ${(await tid(page, 'contact-pick').count()) ? 'still shown (the book is not empty)' : 'hidden'}`);
    await assertClean(page, watch, 'placeholder');
  } finally {
    await ctx.close();
  }
  const c = await openPage(browser);
  try {
    await signIn(c.page, 'carol');
    await c.page.getByTestId('contacts-noaccess').waitFor();
    check((await tid(c.page, 'contact-pick').count()) === 0, 'an account with no address book at all has no placeholder');
    await shot(c.page, 'contacts-noaccess-no-placeholder-desktop-light-en');
    await assertClean(c.page, c.watch, 'placeholder carol');
  } finally {
    await c.ctx.close();
  }
};

// -------------------------------------------- a language switch while a create is in flight (review minor 6)
scenarios['language-inflight-create'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const book = await scratchBook('alice', []);
    await signIn(page, 'alice');
    await go(page, newHash(book.href));
    await tid(page, 'field-given').fill('Inflight');
    await tid(page, 'field-family').fill('Create');
    // hold every PUT of a card for three seconds
    let puts = 0;
    await page.route('**/*.vcf', async (route) => {
      if (route.request().method() === 'PUT') { puts += 1; await sleep(3000); }
      await route.continue();
    });
    await tid(page, 'contact-save').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="contact-form"]')?.getAttribute('aria-busy') === 'true', null, { timeout: 5000 });
    const select = tid(page, 'lang-select');
    const disabled = await select.isDisabled();
    check(disabled, 'while the create is in flight the language select is disabled');
    if (!disabled) {
      await select.selectOption('fr');
      await sleep(300);
      const again = tid(page, 'contact-save');
      if (await again.count() && await again.isEnabled()) await again.click();
    }
    for (let i = 0; i < 50 && puts < 1; i++) await sleep(100);
    await sleep(4500);
    await page.waitForFunction(() => !/\/new(\?|$)/.test(location.hash), null, { timeout: 15000 }).catch(() => {});
    const items = (await listItems('alice', book.href)).filter((i) => i.href !== book.href);
    check(items.length === 1, 'exactly one card exists after the in-flight create (no duplicate)', `${items.length} cards, ${puts} PUT(s) sent`);
    check(puts === 1, 'exactly one PUT was sent', String(puts));
    check((await select.isEnabled()), 'the language select is enabled again when the create has finished');
    await select.selectOption('fr');
    await page.waitForFunction((t) => document.documentElement.lang === 'fr', null, { timeout: 5000 });
    check(true, 'and the language can be switched afterwards');
    await page.unroute('**/*.vcf');
    await assertClean(page, watch, 'language in-flight create');
  } finally {
    await ctx.close();
  }
};
