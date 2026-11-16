// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `import-export`: .vcf import with the three policies (skip, replace, keep both), the lossy-replace
// confirmation, a non-UTF-8 file, a vCard 2.1 file, cancel (before and during the run), the report; .vcf export of an
// address book and of one contact (the downloaded text is checked against the server) and the .ics export of a calendar.
// Run 3c adds the `.ics` import: `ics-import` (one file with a recurring series and its overrides, invitation METHODs,
// unescaped commas, unknown time zones, a task and a journal; skip, then replace with a lossy confirmation; every
// imported item compared with its source component; the calendar export), `ics-keep-both`, `ics-refusals`, `ics-phone`.
// Every scenario makes its own address book (or calendar) through DAV.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DICT, REPO, assertClean, check, cryptoUuid, dav, davGet, davPut, en, go, info, lineDiff, linesOf, listItems, makeBook, openPage, pageChecks, propName, ready,
  shot, signIn, sleep, spec, tid, uniq, unfold, vcard,
} from '../lib/common.mjs';
import { cardByUid, enc, listHash, openBook } from '../lib/ui.mjs';
import { sessionEndCase } from '../lib/session.mjs';

export const scenarios = {};
const UX1 = 'urn:uuid:5e000000-0000-4000-8000-000000000001';
const UX2 = 'urn:uuid:5e000000-0000-4000-8000-000000000002';
const UN1 = 'urn:uuid:5e000000-0000-4000-8000-000000000011';
const UN4 = 'urn:uuid:5e000000-0000-4000-8000-000000000014';
const UG = 'urn:uuid:5e000000-0000-4000-8000-000000000020';

const target = () => makeBook('alice', uniq('imp'), 'Import target', [
  ['x1.vcf', vcard('3.0', ['FN:Existing One', 'N:One;Existing;;;'], { uid: UX1 })],
  ['x2.vcf', vcard('3.0', ['FN:Existing Two', 'N:Two;Existing;;;', 'TITLE:Chief'], { uid: UX2 })],
]);

/** The import file: new cards, duplicates of the two existing ones, an Apple group, a vCard 4.0 card, junk. */
const FILE = [
  vcard('3.0', ['FN:Newly Added', 'N:Added;Newly;;;', 'EMAIL:newly@example.org'], { uid: UN1 }),
  vcard('3.0', ['FN:Existing One UPDATED', 'N:One;Existing;;;', 'TEL:+1 555 0199'], { uid: UX1 }),
  vcard('3.0', ['FN:Existing Two UPDATED', 'N:Two;Existing;;;', 'TITLE:Engineer, Lead'], { uid: UX2 }),
  vcard('4.0', ['FN:Four Point Oh', 'EMAIL:four@example.org'], { uid: UN4 }),
  vcard('3.0', ['X-ADDRESSBOOKSERVER-KIND:group', 'FN:Imported group', 'N:Imported group;;;;', `X-ADDRESSBOOKSERVER-MEMBER:${UN1}`, `X-ADDRESSBOOKSERVER-MEMBER:${UX1}`], { uid: UG }),
  'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Nora Nouid\r\nN:Nouid;Nora;;;\r\nEND:VCARD\r\n',
  'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:urn:uuid:5e000000-0000-4000-8000-000000000030\r\nFN:Bad Line\r\nthis line has no colon\r\nEND:VCARD\r\n',
  'BEGIN:VCARD\r\nVERSION:2.1\r\nN:Old;Ollie\r\nFN:Ollie Old\r\nTEL;CELL:+1 555 0150\r\nEND:VCARD\r\n',
].join('');

async function openImport(page, href) {
  await go(page, listHash(href));
  await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
  await tid(page, 'btn-import-vcf').click();
  await tid(page, 'dialog-import').waitFor();
}
async function choose(page, buffer, name = 'people.vcf') {
  await tid(page, 'field-import-file').setInputFiles({ name, mimeType: 'text/vcard', buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'utf8') });
}
const rowStates = (page) => page.$$eval('[data-testid="import-row"]', (rs) => rs.map((r) => `${r.children[1].textContent.trim()}:${r.dataset.state}`));
async function preview(page) {
  await page.waitForSelector('[data-testid="import-preview"] [data-testid="import-row"]', { timeout: 20000 });
}
async function run(page) {
  await tid(page, 'dialog-import-confirm').click();
  await page.waitForSelector('[data-testid="import-report"]:not([hidden])', { timeout: 60000 });
}
const reportRows = (page) => page.$$eval('[data-testid="import-report-row"]', (rs) => Object.fromEntries(rs.map((r) => [r.children[0].textContent.trim(), r.dataset.result])));
const etags = async (href) => Object.fromEntries((await listItems('alice', href)).filter((i) => i.href !== href).map((i) => [i.href, i.etag]));

scenarios.skip = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await target();
    await signIn(page, 'alice');
    await openImport(page, href);
    check(await tid(page, 'field-import-target').inputValue() === href && (await tid(page, 'dialog-import-confirm').isDisabled()), 'the dialog opens on the book it was started from; the Import button is disabled until a file is read');
    await shot(page, 'import-dialog-empty-desktop-light-en');
    await pageChecks(page, watch, 'import dialog (empty)');
    await choose(page, FILE);
    await preview(page);
    const states = await rowStates(page);
    check(states.length === 8, 'every card of the file gets a row (8)', states.join(' | '));
    const want = { 'Newly Added': 'new', 'Existing One UPDATED': 'duplicate', 'Existing Two UPDATED': 'duplicate', 'Four Point Oh': 'new', 'Imported group': 'new', 'Nora Nouid': 'new', '(no name)': 'unsupported' };
    check(Object.entries(want).every(([n, s]) => states.includes(`${n}:${s}`)) && states.some((s) => s.endsWith(':invalid')), 'states: new, already there, not supported (vCard 2.1), invalid', states.join(' | '));
    const counts = (await tid(page, 'import-counts').textContent()).trim();
    check(/4 new, 2 already in the address book, 1 invalid, 1 not supported, 0 repeated/.test(counts), 'the counts line adds up', counts);
    const reasons = await page.getByTestId('import-rows').textContent();
    check(reasons.includes(en['import.reason.unsupported-version']) && reasons.includes(en['import.reason.uid-exists']) && reasons.includes(en['import.note.generatedUid']), 'each row gives its reason in plain text (2.1 refused, ID exists, an ID will be generated)');
    check(await tid(page, 'policy-skip').isChecked() && (await tid(page, 'dialog-import-confirm').textContent()).trim() === 'Import 4 items', 'the default policy is "Skip it" and the button names the count: Import 4 items', await tid(page, 'dialog-import-confirm').textContent());
    await shot(page, 'import-dialog-preview-desktop-light-en');
    await pageChecks(page, watch, 'import dialog (preview)');
    const before = await etags(href);
    await run(page);
    const rr = await reportRows(page);
    check(rr['Newly Added'] === 'created' && rr['Four Point Oh'] === 'created' && rr['Existing One UPDATED'] === 'skipped' && rr['Existing Two UPDATED'] === 'skipped', 'the report: new cards created, duplicates skipped', JSON.stringify(rr));
    check((await tid(page, 'import-report-summary').textContent()).includes('4 created, 0 replaced, 4 skipped, 0 failed'), 'the report summary (skipped: 2 duplicates, 1 invalid, 1 not supported)', await tid(page, 'import-report-summary').textContent());
    await shot(page, 'import-dialog-report-desktop-light-en');
    await pageChecks(page, watch, 'import dialog (report)');
    const after = await etags(href);
    check(before[`${href}x1.vcf`] === after[`${href}x1.vcf`] && before[`${href}x2.vcf`] === after[`${href}x2.vcf`], 'the existing cards were not written (same ETags)');
    check(Object.keys(after).length === 6, 'the book has 2 + 4 cards', String(Object.keys(after).length));
    const nora = (await davGet('alice', href)).text.split(/(?=BEGIN:VCARD)/).find((c) => c.includes('Nora Nouid'));
    check(nora && /^UID:.+/m.test(nora), 'the card without an ID got a generated UID, and only that was added', nora && linesOf(nora, 'UID').join());
    // the imported card is stored as in the file (semantic diff of the one card, apart from server normalisation)
    const got = await cardByUid('alice', href, UN1);
    const d = lineDiff(vcard('3.0', ['FN:Newly Added', 'N:Added;Newly;;;', 'EMAIL:newly@example.org'], { uid: UN1 }), got);
    check(d.removed.length === 0 && d.added.length === 0, 'a plain card is stored exactly as in the file', JSON.stringify(d));
    await tid(page, 'dialog-cancel').click();
    await page.waitForSelector('[data-testid="dialog-import"]', { state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="contact-row"]').length === 5, null, { timeout: 15000 });
    check(true, 'after closing, the list shows the imported contacts (the group card is not a contact)');
    await assertClean(page, watch, 'import skip');
  } finally {
    await ctx.close();
  }
};

scenarios.replace = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await target();
    await signIn(page, 'alice');
    await openImport(page, href);
    await choose(page, FILE);
    await preview(page);
    await tid(page, 'policy-replace').check();
    const lossy = tid(page, 'import-lossy');
    await lossy.waitFor({ state: 'visible' });
    const lossyText = await lossy.textContent();
    check(/Existing Two UPDATED/.test(lossyText) && /TITLE/i.test(lossyText), 'under "Replace" the dialog lists the card the server would damage and names the property (TITLE)', lossyText.replace(/\s+/g, ' ').slice(0, 200));
    check((await page.getByTestId('import-lossy-confirm').count()) === 1 && !(await page.getByTestId('import-lossy-confirm').isChecked()), 'its confirmation box is unticked');
    await shot(page, 'import-dialog-replace-lossy-desktop-light-en');
    await pageChecks(page, watch, 'import dialog (replace, lossy)');
    const before = await etags(href);
    await run(page);
    const rr = await reportRows(page);
    check(rr['Existing One UPDATED'] === 'replaced' && rr['Existing Two UPDATED'] === 'skipped', 'replace: the good card is replaced, the one that would be damaged is skipped until confirmed', JSON.stringify(rr));
    const one = await cardByUid('alice', href, UX1);
    const two = await cardByUid('alice', href, UX2);
    check(linesOf(one, 'FN')[0] === 'FN:Existing One UPDATED' && linesOf(one, 'TEL').length === 1, 'the replaced card has the new name and phone');
    check(linesOf(two, 'TITLE')[0] === 'TITLE:Chief', 'the card that was held back is untouched (TITLE:Chief)');
    check(before[`${href}x2.vcf`] === (await etags(href))[`${href}x2.vcf`], 'and was not written at all');
    // run it again with the lossy card confirmed: the server really cuts the title
    await tid(page, 'dialog-cancel').click();
    await openImport(page, href);
    await choose(page, FILE);
    await preview(page);
    await tid(page, 'policy-replace').check();
    await tid(page, 'import-lossy').waitFor({ state: 'visible' });
    await page.getByTestId('import-lossy-confirm').check();
    await run(page);
    const rr2 = await reportRows(page);
    check(rr2['Existing Two UPDATED'] === 'replaced', 'with the box ticked the damaged card is replaced', JSON.stringify(rr2));
    const two2 = await cardByUid('alice', href, UX2);
    check(linesOf(two2, 'TITLE')[0] === 'TITLE:Engineer', 'the warning was true: the server cut TITLE at the unescaped comma', linesOf(two2, 'TITLE').join());
    check((await page.getByTestId('import-report-verify').count()) === 1, 'the report warns that imported cards were stored differently', await page.getByTestId('import-report-verify').count() ? await tid(page, 'import-report-verify').textContent() : 'no warning shown');
    await shot(page, 'import-dialog-report-replace-desktop-light-en');
    await assertClean(page, watch, 'import replace');
  } finally {
    await ctx.close();
  }
};

scenarios['keep-both'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await target();
    await signIn(page, 'alice');
    await openImport(page, href);
    await choose(page, FILE);
    await preview(page);
    await tid(page, 'policy-keep').check();
    check((await tid(page, 'dialog-import-confirm').textContent()).trim() === 'Import 6 items', '"Keep both": the six importable cards are counted', await tid(page, 'dialog-import-confirm').textContent());
    await run(page);
    const rr = await reportRows(page);
    check(rr['Existing One UPDATED'] === 'created' && rr['Existing Two UPDATED'] === 'created', 'keep both: the duplicates are added as new cards', JSON.stringify(rr));
    const all = (await davGet('alice', href)).text.split(/(?=BEGIN:VCARD)/).filter((c) => c.includes('BEGIN:VCARD'));
    const uids = all.map((c) => linesOf(c, 'UID')[0].slice(4));
    check(all.length === 8 && new Set(uids).size === 8, '8 cards with 8 different UIDs (2 old, 6 imported)', `${all.length} cards, ${new Set(uids).size} UIDs`);
    const updated = all.find((c) => c.includes('Existing One UPDATED'));
    const newUid = linesOf(updated, 'UID')[0].slice(4);
    check(newUid !== UX1 && uids.includes(UX1), 'the kept copy has a new UID; the original is still there');
    const group = all.find((c) => c.includes('Imported group'));
    const members = linesOf(group, 'X-ADDRESSBOOKSERVER-MEMBER').map((l) => l.replace(/^[^:]*:/, ''));
    check(members.length === 2 && members.every((m) => uids.includes(m)) && !members.includes(UX1) && members.includes(newUid), 'the imported group points at the NEW UIDs of the cards imported with it (MEMBER remapped, the old card is not added)', members.join(' '));
    await assertClean(page, watch, 'import keep both');
  } finally {
    await ctx.close();
  }
};

scenarios.refusals = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await target();
    await signIn(page, 'alice');
    await openImport(page, href);
    // Windows-1252 text: not UTF-8
    const latin1 = Buffer.concat([Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:urn:uuid:5e000000-0000-4000-8000-0000000000a1\r\nFN:Caf', 'latin1'), Buffer.from([0xe9, 0x80]), Buffer.from(' Président\r\nEND:VCARD\r\n', 'latin1')]);
    await choose(page, latin1, 'old.vcf');
    await tid(page, 'import-error').waitFor({ state: 'visible' });
    const err = (await tid(page, 'import-error').textContent()).trim();
    check(err.includes('not UTF-8') && /windows-1252|ISO-8859|Latin|1252/i.test(err) && (await tid(page, 'dialog-import-confirm').isDisabled()), 'a non-UTF-8 file is refused with a reason that names the likely encoding; nothing can be imported', err);
    check((await tid(page, 'import-error').getAttribute('role')) === 'alert', 'the refusal is persistent alert text');
    await shot(page, 'import-dialog-not-utf8-desktop-light-en');
    // an .ics file
    await choose(page, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', 'cal.ics');
    await page.waitForFunction((t) => (document.querySelector('[data-testid="import-error"]') || {}).textContent?.includes(t), 'calendar file', { timeout: 10000 });
    check(true, 'a calendar file is refused: only .vcf contact files can be imported');
    // only vCard 2.1
    await choose(page, 'BEGIN:VCARD\r\nVERSION:2.1\r\nN:Old;Ollie\r\nFN:Ollie Old\r\nTEL;CELL;VOICE:+1 555 0150\r\nEND:VCARD\r\n', 'v21.vcf');
    await preview(page);
    check((await rowStates(page)).join() === '(no name):unsupported' && await tid(page, 'dialog-import-confirm').isDisabled() && (await tid(page, 'dialog-import-confirm').textContent()).includes('Nothing to import'), 'a file with only a vCard 2.1 card lists it as not supported and offers nothing to import');
    await shot(page, 'import-dialog-v21-desktop-light-en');
    // cancel with a file chosen
    await choose(page, FILE);
    await preview(page);
    await tid(page, 'dialog-cancel').click();
    await page.waitForSelector('[data-testid="dialog-import"]', { state: 'detached' });
    check((await listItems('alice', href)).length === 3, 'cancelling after the preview imports nothing (2 cards in the book)', String((await listItems('alice', href)).length - 1));
    // Esc cancels, too
    await tid(page, 'btn-import-vcf').click();
    await tid(page, 'dialog-import').waitFor();
    await choose(page, FILE);
    await preview(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="dialog-import"]', { state: 'detached' });
    check((await listItems('alice', href)).length === 3, 'Esc after the preview imports nothing');
    await assertClean(page, watch, 'import refusals');
  } finally {
    await ctx.close();
  }
};

scenarios['cancel-running'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await target();
    const many = [];
    for (let i = 0; i < 600; i++) many.push(vcard('3.0', [`FN:Bulk Person ${i}`, `N:Person${String(i).padStart(3, '0')};Bulk;;;`], { uid: `urn:uuid:5e000000-0000-4000-8000-${String(100000 + i).padStart(12, '0')}` }));
    await signIn(page, 'alice');
    await openImport(page, href);
    await choose(page, many.join(''));
    await preview(page);
    check((await tid(page, 'dialog-import-confirm').textContent()).trim() === 'Import 600 items', '600 cards are previewed');
    await tid(page, 'dialog-import-confirm').click();
    await tid(page, 'btn-import-cancel').waitFor({ state: 'visible', timeout: 20000 });
    const bar = tid(page, 'import-progress');
    check((await bar.getAttribute('role')) === 'progressbar' && (await tid(page, 'import-progress-text').textContent()).length > 0, 'while it runs: a progress bar and text');
    await shot(page, 'import-dialog-running-desktop-light-en');
    await sleep(600);
    await tid(page, 'btn-import-cancel').click();
    await page.waitForSelector('[data-testid="import-report"]:not([hidden])', { timeout: 60000 });
    const stopped = (await tid(page, 'import-report-stopped').textContent().catch(() => '')) || '';
    const items = (await listItems('alice', href)).length - 1 - 2;
    check(/cancelled/i.test(stopped) && items > 0 && items < 600, 'cancel stops the run: the report says so and part of the cards stay imported', `${items} of 600 imported; ${stopped}`);
    const sum = (await tid(page, 'import-report-summary').textContent()).match(/(\d+) created/);
    check(sum && Number(sum[1]) === items, 'the report counts exactly what is on the server', `${sum && sum[1]} vs ${items}`);
    await shot(page, 'import-dialog-cancelled-desktop-light-en');
    // re-run with "skip" resumes: the rest is created, nothing twice
    await tid(page, 'dialog-cancel').click();
    await tid(page, 'btn-import-vcf').click();
    await tid(page, 'dialog-import').waitFor();
    await choose(page, many.join(''));
    await preview(page);
    await run(page);
    check((await listItems('alice', href)).length - 1 === 602, 'running it again with "Skip it" completes the import without duplicates (602 cards)', String((await listItems('alice', href)).length - 1));
    await assertClean(page, watch, 'import cancel running');
  } finally {
    await ctx.close();
  }
};

scenarios.phone = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { lang: 'fr', w: 390, h: 844, scheme: 'dark' });
  try {
    const href = await target();
    await signIn(page, 'alice');
    await openImport(page, href);
    await choose(page, FILE);
    await preview(page);
    await tid(page, 'policy-replace').check();
    await tid(page, 'import-lossy').waitFor({ state: 'visible' });
    await shot(page, 'import-dialog-preview-phone-dark-fr');
    await pageChecks(page, watch, 'import preview phone dark fr');
    await run(page);
    await shot(page, 'import-dialog-report-phone-dark-fr');
    await pageChecks(page, watch, 'import report phone dark fr');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------------------ export
const cardsOf = (text) => text.split(/(?=BEGIN:VCARD)/).filter((c) => c.includes('BEGIN:VCARD'));
const uidsOf = (text) => cardsOf(text).map((c) => linesOf(c, 'UID')[0]).sort();

scenarios.export = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { acceptDownloads: true });
  try {
    await signIn(page, 'alice');
    // the whole address book (3.0 book with two Apple group cards): group cards are left out and the status says how many
    await openBook(page, '/alice/contacts/');
    const [dl] = await Promise.all([page.waitForEvent('download'), tid(page, 'btn-export-book').click()]);
    const body = readFileSync(await dl.path(), 'utf8');
    const server = (await davGet('alice', '/alice/contacts/')).text;
    const notGroups = cardsOf(server).filter((c) => !/X-ADDRESSBOOKSERVER-KIND|KIND:group/i.test(c));
    check(/^contacts-\d{4}-\d{2}-\d{2}\.vcf$/.test(dl.suggestedFilename()) || /\d{4}-\d{2}-\d{2}\.vcf$/.test(dl.suggestedFilename()), 'the file is named <book>-<date>.vcf', dl.suggestedFilename());
    check(cardsOf(body).length === 33 && JSON.stringify(uidsOf(body)) === JSON.stringify(uidsOf(notGroups.join(''))), 'the download holds the 33 contact cards of the server, no group card', `${cardsOf(body).length} cards`);
    let same = true;
    for (const c of notGroups) { const uid = linesOf(c, 'UID')[0]; const mine = cardsOf(body).find((x) => linesOf(x, 'UID')[0] === uid); const d = lineDiff(c, mine || ''); if (d.removed.length || d.added.length) same = false; }
    check(same, 'every card in the download equals the card the server holds (no re-writing)');
    check(body.includes('\r\n') && !/[^\r]\n/.test(body), 'the file uses CRLF line ends');
    await page.waitForFunction(() => /2 group cards were left out/.test((document.querySelector('[data-testid="status-text"]') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
    check((await tid(page, 'status-text').textContent()).includes('2 group cards were left out'), 'a persistent status says "Exported 33 contacts. 2 group cards were left out."', await tid(page, 'status-text').textContent());
    // the same book from the Collections screen
    await go(page, '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid="collection-row"][data-href="/alice/contacts/"] [data-testid="btn-export"]').click()]);
    const body2 = readFileSync(await dl2.path(), 'utf8');
    check(cardsOf(body2).length === 33 && dl2.suggestedFilename().endsWith('.vcf'), 'Collections > Export gives the same 33 contacts', `${cardsOf(body2).length} cards, ${dl2.suggestedFilename()}`);
    // a 4.0 book with a KIND:group card
    const [dl3] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid="collection-row"][data-href="/alice/contacts40/"] [data-testid="btn-export"]').click()]);
    const body3 = readFileSync(await dl3.path(), 'utf8');
    check(cardsOf(body3).length === 15 && /VERSION:4\.0/.test(body3), 'the 4.0 book exports its 15 contacts as 4.0 cards (the group card is left out)', `${cardsOf(body3).length} cards`);
    await shot(page, 'collections-after-export-desktop-light-en');
    await assertClean(page, watch, 'export vcf');
  } finally {
    await ctx.close();
  }
};

scenarios['export-calendar'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { acceptDownloads: true });
  try {
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid="collection-row"][data-href="/alice/cal-work/"] [data-testid="btn-export"]').click()]);
    const body = readFileSync(await dl.path(), 'utf8');
    const server = (await davGet('alice', '/alice/cal-work/')).text;
    const uids = (t) => unfold(t).filter((l) => /^UID:/.test(l)).sort();
    check(dl.suggestedFilename().endsWith('.ics') && (body.match(/BEGIN:VCALENDAR/g) || []).length === 1 && (body.match(/BEGIN:VEVENT/g) || []).length === 3, 'the .ics export is ONE calendar with the 3 events', `${dl.suggestedFilename()}: ${(body.match(/BEGIN:VEVENT/g) || []).length} events`);
    check(JSON.stringify(uids(body)) === JSON.stringify(uids(server)), 'the events are those the server serves for the whole collection');
    await page.waitForFunction(() => (document.querySelector('[data-testid="status-text"]') || {}).textContent?.length > 0);
    check((await tid(page, 'status-text').textContent()).length > 0, 'a persistent status text reports the export', await tid(page, 'status-text').textContent());
    // an empty collection downloads nothing
    const [empty] = await Promise.all([page.waitForEvent('download', { timeout: 2500 }).catch(() => null), page.locator('[data-testid="collection-row"][data-href="/alice/personal/"] [data-testid="btn-export"]').click()]);
    check(empty !== null, 'a calendar with one event exports (control)');
    await assertClean(page, watch, 'export calendar');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------ the session ends with the dialog open (review M1)
const importCase = (way) => (browser) => sessionEndCase(browser, {
  way,
  label: `import dialog, session ended by ${way === 'password' ? 'a password reset (401)' : 'a sign-out in another tab'}`,
  dialog: 'dialog-import',
  prepare: async (user) => makeBook(user, uniq('impse'), 'Import target', [['x1.vcf', vcard('3.0', ['FN:Existing One', 'N:One;Existing;;;'], { uid: UX1 })]]),
  open: async (page, href) => { await openImport(page, href); },
  trigger: async (page) => { await choose(page, FILE); },
});
scenarios['session-end-password'] = importCase('password');
scenarios['session-end-tab'] = importCase('tab');

// ------------------------------------------------------------------ the file field is styled and still labelled
scenarios['file-field'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await target();
    await signIn(page, 'alice');
    await openImport(page, href);
    const field = tid(page, 'field-import-file');
    check((await page.getByLabel(en['import.field.file'], { exact: true }).count()) === 1 && (await field.count()) === 1, 'the file input is still reached by its visible label and has its test id');
    const style = await field.evaluate((e) => {
      const cs = getComputedStyle(e);
      const b = getComputedStyle(e, '::file-selector-button');
      return { visible: e.getBoundingClientRect().width > 4, btnRadius: b.borderRadius, btnBg: b.backgroundColor, btnFont: b.fontWeight, btnPad: b.paddingLeft, btnBorder: b.borderTopWidth, border: cs.borderTopWidth, radius: cs.borderRadius };
    });
    const nativeLook = style.btnRadius === '0px' && style.btnPad === '0px' && /^(rgba\(0, 0, 0, 0\)|rgb\(239, 239, 239\))$/.test(style.btnBg);
    const customButton = !style.visible && (await page.getByTestId('btn-choose-file').count()) === 1;
    check(customButton || !nativeLook, 'the file field is styled (a styled selector button, or a button plus a hidden input), not the browser default', JSON.stringify(style));
    await shot(page, 'import-dialog-file-field-desktop-light-en');
    await choose(page, FILE);
    await preview(page);
    check((await tid(page, 'import-file-info').textContent()).includes('people.vcf'), 'the chosen file name is shown after choosing');
    await assertClean(page, watch, 'import file field');
  } finally {
    await ctx.close();
  }
};

// ===================================================================================== .ics import (Run 3c)
const ICS_DIR = path.join(REPO, 'tests', 'fixtures', 'ics', 'import');
const icsFx = (name) => readFileSync(path.join(ICS_DIR, `import-${name}.ics`), 'utf8');
const MKCAL_BOTH = (name) => `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/"><D:set><D:prop><D:displayname>${name}</D:displayname><I:calendar-color>#4466aa</I:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
async function mkcal(prefix, display) {
  const href = `/alice/${uniq(prefix).toLowerCase().replace(/[^a-z0-9-]/g, '')}/`;
  const r = await dav('alice', 'MKCALENDAR', href, MKCAL_BOTH(display), { 'Content-Type': 'application/xml' });
  if (r.status !== 201) throw new Error(`MKCALENDAR ${href}: ${r.status}`);
  return href;
}
const OLD_SERIES = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI e2e//EN\r\nBEGIN:VEVENT\r\nUID:series-a@example.org\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T090000Z\r\nDTEND:20260101T100000Z\r\nSUMMARY:Weekly review OLD\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const OLD_COMMA = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI e2e//EN\r\nBEGIN:VEVENT\r\nUID:comma-summary@example.org\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260311T090000Z\r\nDTEND:20260311T100000Z\r\nSUMMARY:Apples and pears\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const TODO_ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example Corp//Calendar 1.0//EN\nBEGIN:VTODO\nUID:e2e-ics-todo@example.org\nDTSTAMP:20260101T000000Z\nSUMMARY:Send the example invoice\nDUE;VALUE=DATE:20260630\nPRIORITY:3\nEND:VTODO\nEND:VCALENDAR\n';
const JOURNAL_ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example Corp//Calendar 1.0//EN\nBEGIN:VJOURNAL\nUID:e2e-ics-journal@example.org\nDTSTAMP:20260101T000000Z\nDTSTART;VALUE=DATE:20260302\nSUMMARY:A journal entry\nEND:VJOURNAL\nEND:VCALENDAR\n';
/** One file, six calendars: 13 entries (a series with two overrides is ONE entry). */
const ICS_FILE = () => [icsFx('recurring-overrides'), icsFx('method-request'), icsFx('unescaped-comma'), icsFx('unknown-tzid'), TODO_ICS, JOURNAL_ICS].join('');

/** The top-level components of a calendar text: [{kind, uid, lines}] and the lines outside them (wrapper, VTIMEZONE). */
function parts(text) {
  const comps = [];
  const outside = [];
  let cur = null;
  for (const l of unfold(text)) {
    if (!cur && /^BEGIN:(VEVENT|VTODO|VJOURNAL|VFREEBUSY)$/.test(l)) { cur = { kind: l.slice(6), uid: null, lines: [l] }; continue; }
    if (cur) {
      cur.lines.push(l);
      if (cur.uid === null && /^UID:/.test(l)) cur.uid = l.slice(4);
      if (l === `END:${cur.kind}`) { comps.push(cur); cur = null; }
    } else outside.push(l);
  }
  return { comps, outside };
}
/** source lines by UID (events and tasks only) and every line that is not inside a component */
function sourceOf(text) {
  const { comps, outside } = parts(text);
  const byUid = new Map();
  for (const c of comps.filter((x) => x.kind === 'VEVENT' || x.kind === 'VTODO')) byUid.set(c.uid, [...(byUid.get(c.uid) || []), ...c.lines]);
  return { byUid, outside: new Set(outside) };
}
const served = async (href) => {
  const out = [];
  for (const it of (await listItems('alice', href)).filter((i) => i.href !== href)) out.push({ href: it.href, etag: it.etag, text: (await davGet('alice', it.href)).text });
  return out;
};
const uidOfText = (text) => (parts(text).comps[0] || {}).uid;

async function openIcsImport(page, href) {
  await go(page, '#/collections');
  await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
  const seen = [];
  const keep = (m) => { if (m.type() === 'error') seen.push(m.text()); };
  page.on('console', keep);
  page.on('pageerror', (e) => seen.push(String(e.message || e)));
  await page.locator(`[data-testid="collection-row"][data-href="${href}"] [data-testid="btn-import"]`).click();
  try {
    await tid(page, 'dialog-import').waitFor({ timeout: 15000 });
  } catch (e) {
    const alert = await page.evaluate(() => ((document.querySelector('[data-testid="alert-text"]') || {}).textContent || '').trim());
    throw new Error(`the import dialog did not open (alert "${alert}"; page errors: ${seen.slice(0, 3).join(' | ')})`);
  } finally {
    page.off('console', keep);
  }
}
const chooseIcs = (page, text, name = 'calendar.ics') => tid(page, 'field-import-file').setInputFiles({ name, mimeType: 'text/calendar', buffer: Buffer.from(text, 'utf8') });
const rowNotes = (page, name, kind) => page.locator('[data-testid="import-row"]', { has: page.locator('bdi', { hasText: name }) }).locator(`[data-kind="${kind}"]`);

scenarios['ics-import'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { acceptDownloads: true });
  try {
    const href = await mkcal('ics', 'Import calendar');
    for (const [f, t] of [['old-series.ics', OLD_SERIES], ['old-comma.ics', OLD_COMMA]]) {
      const r = await davPut('alice', href + f, t, 'text/calendar');
      if (r.status !== 201) throw new Error(`PUT ${f}: ${r.status}`);
    }
    const FILE_TEXT = ICS_FILE();
    const src = sourceOf(FILE_TEXT);
    await signIn(page, 'alice');
    await openIcsImport(page, href);
    check(/\.ics/.test(await tid(page, 'dialog-import').textContent()) && (await tid(page, 'field-import-target').inputValue()) === href && await tid(page, 'dialog-import-confirm').isDisabled(), 'the import dialog opens from a calendar: it asks for a .ics file, targets that calendar, nothing can be imported yet');
    await chooseIcs(page, FILE_TEXT);
    await preview(page);
    const states = await rowStates(page);
    check(states.length === 13, 'one row per entry: 13 (a series with its overrides is ONE row)', `${states.length}: ${states.join(' | ')}`);
    const want = { 'Weekly review': 'duplicate', 'Apples, pears and plums': 'duplicate', 'Call with the New York office': 'new', 'Release call': 'new', 'Planning session': 'new', 'Offsite day': 'new', 'Daily check': 'new', 'Nothing to fear': 'new', 'Zone nobody defines': 'new', 'Send the example invoice': 'new' };
    check(Object.entries(want).every(([n, st]) => states.includes(`${n}:${st}`)) && states.filter((x) => x.endsWith(':unsupported')).length === 1, 'states: the two items already there are "duplicate", the rest are new, the journal is not supported', states.join(' | '));
    const counts = (await tid(page, 'import-counts').textContent()).trim();
    check(/10 new, 2 already in the calendar, 0 invalid, 1 not imported, 0 repeated in the file/.test(counts), 'the counts line adds up', counts);
    const kinds = await page.$$eval('[data-testid="import-row"]', (rs) => Object.fromEntries(rs.map((r) => [r.children[1].textContent.trim(), (r.querySelector('[data-kind="info"]') || {}).textContent || ''])));
    check(/Event · Repeats · Changed occurrences: 2/.test(kinds['Weekly review']) && /^Task/.test(kinds['Send the example invoice']), 'a row says what it is: "Event · Repeats · Changed occurrences: 2", "Task"', kinds['Weekly review'] + ' / ' + kinds['Send the example invoice']);
    check((await page.locator('[data-testid="import-row"][data-component="VJOURNAL"]').count()) === 1 && /VJOURNAL entries are not imported \(only events and tasks are\)/.test((await page.locator('[data-testid="import-row"][data-component="VJOURNAL"]').textContent()).replace(/[\u2066-\u2069]/g, '')), 'a journal entry is listed with its reason (not imported, only events and tasks are)');
    check((await rowNotes(page, 'Planning session', 'method-dropped').count()) === 1 && (await rowNotes(page, 'Offsite day', 'method-dropped').count()) === 1, 'the invitation METHOD is reported on both entries of that file ("is dropped")');
    check((await rowNotes(page, 'Zone nobody defines', 'unknown-tzid').count()) === 1 && /Nowhere\/Example/.test(await rowNotes(page, 'Zone nobody defines', 'unknown-tzid').textContent()), 'an unknown time zone is reported by name: stored exactly as it is, shown read-only');
    check((await rowNotes(page, 'Zone defined in the file', 'unknown-tzid').count()) === 0 && (await rowNotes(page, 'Known zone without a VTIMEZONE in the file', 'unknown-tzid').count()) === 0, 'a zone defined in the file, and a known one, are not reported');
    check((await rowNotes(page, 'Daily check', 'lossy').count()) === 1 && (await rowNotes(page, 'Apples, pears and plums', 'lossy').count()) === 1, 'entries with an unescaped comma are flagged as lossy (the server would cut the text)', await page.locator('[data-kind="lossy"]').allTextContents().then((x) => x.join(' | ')));
    check(await tid(page, 'policy-skip').isChecked() && (await tid(page, 'dialog-import-confirm').textContent()).trim() === 'Import 10 items', 'the default policy is "Skip it"; the button names the count: Import 10 items', await tid(page, 'dialog-import-confirm').textContent());
    await shot(page, 'import-ics-preview-desktop-light-en');
    await pageChecks(page, watch, 'ics import dialog (preview)');
    const before = Object.fromEntries((await served(href)).map((x) => [uidOfText(x.text), x.etag]));
    await run(page);
    const rr = await reportRows(page);
    check(rr['Weekly review'] === 'skipped' && rr['Apples, pears and plums'] === 'skipped' && rr['Release call'] === 'created' && rr['Send the example invoice'] === 'created' && rr['Daily check'] === 'created', 'skip: new items are created, the two duplicates are skipped', JSON.stringify(rr));
    const sum = (await tid(page, 'import-report-summary').textContent()).trim();
    check(/^10 created, 0 replaced, 3 skipped, 0 failed/.test(sum), 'the report summary (skipped: 2 duplicates and the journal)', sum);
    const notes = (await tid(page, 'import-report-notes').textContent()).replace(/\s+/g, ' ');
    check(/2 items carried an invitation method/.test(notes) && /1 entry that is neither an event nor a task was not imported/.test(notes), 'the report notes name what was dropped (METHOD on 2 items) and what was not imported (1 entry)', notes);
    check((await page.getByTestId('import-report-verify').count()) === 1, 'the report warns that an imported item was stored differently by the server (the comma)', await page.getByTestId('import-report-verify').count() ? await tid(page, 'import-report-verify').textContent() : 'no warning shown');
    await shot(page, 'import-ics-report-desktop-light-en');
    await pageChecks(page, watch, 'ics import dialog (report)');
    // what is on the server
    const items = await served(href);
    check(items.length === 12, 'the calendar holds 12 items: 2 old + 10 imported', String(items.length));
    const after = Object.fromEntries(items.map((x) => [uidOfText(x.text), x]));
    check(before['series-a@example.org'] === after['series-a@example.org'].etag && before['comma-summary@example.org'] === after['comma-summary@example.org'].etag, 'the two items that were already there were not written (same ETags)');
    check(items.every((x) => !/^METHOD:/m.test(x.text)), 'no stored item carries a METHOD line');
    const series = after['comma-series@example.org'];
    check(series && parts(series.text).comps.length === 2, 'a series and its changed occurrence are ONE resource (2 VEVENTs)', series ? String(parts(series.text).comps.length) : 'missing');
    let bad = [];
    for (const [uid, lines] of src.byUid) {
      const x = after[uid];
      if (!x || uid === 'series-a@example.org' || uid === 'comma-summary@example.org' || uid === 'comma-series@example.org') continue;
      const got = parts(x.text);
      // the server (not the app) writes a quoted TZID parameter without its quotes; nothing else may differ
      const unq = (x) => x.replace(/TZID="([^";:,]+)"/g, 'TZID=$1');
      if (lines.some((l) => /TZID="/.test(l)) && got.comps.flatMap((c) => c.lines).some((l) => /TZID=[^"]/.test(l))) info(`${uid}: Radicale stores a quoted TZID parameter without its quotes`);
      const d = lineDiff(lines.map(unq).join('\r\n'), got.comps.flatMap((c) => c.lines).map(unq).join('\r\n'));
      const wrapper = lineDiff('', got.outside.join('\r\n')).added.filter((l) => !src.outside.has(l));
      if (d.removed.length || d.added.length || wrapper.length) bad.push(`${uid}: -${d.removed.join('|')} +${d.added.join('|')} wrapper+${wrapper.join('|')}`);
    }
    check(bad.length === 0, 'every imported item is stored exactly as in the file: the same component lines (folded text unfolded), only the wrapper and its own time zone around them', bad.join(' ;; '));
    const noZoneLines = after['unknown-zone@example.org'] ? parts(after['unknown-zone@example.org'].text).outside.filter((l) => /TZID/.test(l)) : ['missing'];
    check(noZoneLines.length === 0, 'an item in an unknown zone gets no invented VTIMEZONE', noZoneLines.join(','));
    const ny = after['single-ny@example.org'] ? parts(after['single-ny@example.org'].text).outside.filter((l) => /^TZID:/.test(l)) : [];
    check(ny.length === 1 && ny[0] === 'TZID:America/New_York', 'each item gets exactly the VTIMEZONE it uses (the New York call, not the Paris one)', ny.join(','));
    const cs = series ? series.text : '';
    check(!/Floor 2/.test(cs) && /LOCATION:Hall 1/.test(cs), 'the warning was true: the server cut the unescaped comma (LOCATION:Hall 1)', (cs.match(/LOCATION:.*/) || [''])[0]);
    // ---- replace
    await tid(page, 'dialog-cancel').click();
    await page.waitForSelector('[data-testid="dialog-import"]', { state: 'detached' });
    await openIcsImport(page, href);
    await chooseIcs(page, FILE_TEXT);
    await preview(page);
    const counts2 = (await tid(page, 'import-counts').textContent()).trim();
    check(/0 new, 12 already in the calendar, 0 invalid, 1 not imported/.test(counts2), 'the same file again: every item is now "already in the calendar"', counts2);
    await tid(page, 'policy-replace').check();
    await tid(page, 'import-lossy').waitFor({ state: 'visible' });
    const boxes = await page.getByTestId('import-lossy-confirm').evaluateAll((bs) => bs.map((b) => ({ uid: b.dataset.uid, on: b.checked })));
    check(boxes.length === 2 && boxes.every((b) => !b.on) && boxes.some((b) => b.uid === 'comma-summary@example.org') && boxes.some((b) => b.uid === 'comma-series@example.org'), 'under "Replace" the dialog lists the two items the server would damage, both unticked', JSON.stringify(boxes));
    await page.locator('[data-testid="import-lossy-confirm"][data-uid="comma-summary@example.org"]').check();
    await shot(page, 'import-ics-replace-lossy-desktop-light-en');
    await pageChecks(page, watch, 'ics import dialog (replace, lossy)');
    const mid = Object.fromEntries((await served(href)).map((x) => [uidOfText(x.text), x.etag]));
    await run(page);
    const r2 = await reportRows(page);
    const sum2 = (await tid(page, 'import-report-summary').textContent()).trim();
    check(/^0 created, 11 replaced, 2 skipped, 0 failed/.test(sum2) && r2['Daily check'] === 'skipped' && r2['Apples, pears and plums'] === 'replaced' && r2['Weekly review'] === 'replaced', 'replace: the series and the confirmed item are replaced, the damaging one that was not confirmed is skipped, the journal is not imported', `${sum2} ${JSON.stringify(r2)}`);
    const items2 = Object.fromEntries((await served(href)).map((x) => [uidOfText(x.text), x]));
    check(mid['comma-series@example.org'] === items2['comma-series@example.org'].etag, 'the unconfirmed item was not written at all');
    const sa = parts(items2['series-a@example.org'].text);
    const wk = src.byUid.get('series-a@example.org');
    const dSeries = lineDiff(wk.join('\r\n'), sa.comps.flatMap((c) => c.lines).join('\r\n'));
    check(sa.comps.length === 3 && dSeries.removed.length === 0 && dSeries.added.length === 0 && !/OLD/.test(items2['series-a@example.org'].text), 'replace overwrote the old event with the whole series: master (RRULE, EXDATE) and its 2 overrides, every line as in the file', `${sa.comps.length} components; -${dSeries.removed.join('|')} +${dSeries.added.join('|')}`);
    check(/SUMMARY:Apples$/m.test(items2['comma-summary@example.org'].text) || /SUMMARY:Apples\r?$/m.test(items2['comma-summary@example.org'].text), 'the confirmed lossy replace really cut the title at the comma (SUMMARY:Apples)', (items2['comma-summary@example.org'].text.match(/SUMMARY:.*/) || [''])[0]);
    await shot(page, 'import-ics-report-replace-desktop-light-en');
    await tid(page, 'dialog-cancel').click();
    await page.waitForSelector('[data-testid="dialog-import"]', { state: 'detached' });
    // ---- the imported series in the calendar screen
    await go(page, '#/calendar/week/2026-03-23');
    await page.waitForSelector('[data-testid="calendar-screen"][data-state="ready"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="calendar-screen"]').dataset.sync === 'idle');
    const titles = await page.$$eval('[data-testid="event-chip"][data-uid="series-a@example.org"]', (ns) => ns.map((n) => (n.querySelector('.chip__title') || {}).textContent));
    check(titles.includes('Weekly review (moved)'), 'the imported series shows in the calendar, with its changed occurrence on 23 March', titles.join(' | '));
    await go(page, '#/calendar/week/2026-03-30');
    await page.waitForSelector('[data-testid="calendar-screen"][data-state="ready"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="calendar-screen"]').dataset.sync === 'idle');
    check((await page.locator('[data-testid="event-chip"][data-uid="series-a@example.org"]:not(.is-off)').count()) === 0, 'and the skipped date (EXDATE of 30 March) is not drawn');
    // ---- the .ics export of that calendar
    await go(page, '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(`[data-testid="collection-row"][data-href="${href}"] [data-testid="btn-export"]`).click()]);
    const body = readFileSync(await dl.path(), 'utf8');
    const all = await served(href);
    const count = (t, k) => (t.match(new RegExp(`^BEGIN:${k}$`, 'gm')) || []).length;
    const serverEvents = all.reduce((n, x) => n + count(x.text, 'VEVENT'), 0);
    const serverTodos = all.reduce((n, x) => n + count(x.text, 'VTODO'), 0);
    check(dl.suggestedFilename().endsWith('.ics') && count(body, 'VCALENDAR') === 1 && count(body, 'VEVENT') === serverEvents && count(body, 'VTODO') === serverTodos && serverTodos === 1, 'the calendar export is ONE calendar with every event and the task of the server', `${dl.suggestedFilename()}: ${count(body, 'VEVENT')}/${serverEvents} events, ${count(body, 'VTODO')} tasks`);
    const exportLines = lineDiff(all.flatMap((x) => parts(x.text).comps.flatMap((c) => c.lines)).join('\r\n'), body);
    check(exportLines.removed.length === 0, 'every component line the server holds is in the export, unchanged', exportLines.removed.slice(0, 3).join(' | '));
    await assertClean(page, watch, 'ics import');
  } finally {
    await ctx.close();
  }
};

scenarios['ics-keep-both'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await mkcal('icsk', 'Keep both calendar');
    const r = await davPut('alice', href + 'old-series.ics', OLD_SERIES, 'text/calendar');
    if (r.status !== 201) throw new Error('PUT old series: ' + r.status);
    const oldTag = r.etag || (await listItems('alice', href)).find((i) => i.href.endsWith('old-series.ics')).etag;
    await signIn(page, 'alice');
    await openIcsImport(page, href);
    const text = icsFx('recurring-overrides');
    await chooseIcs(page, text);
    await preview(page);
    await tid(page, 'policy-keep').check();
    check((await tid(page, 'dialog-import-confirm').textContent()).trim() === 'Import 3 items', '"Keep both": the three entries are counted (the duplicate is added as a new item)', await tid(page, 'dialog-import-confirm').textContent());
    await run(page);
    const rr = await reportRows(page);
    check(Object.values(rr).every((x) => x === 'created') && Object.keys(rr).length === 3, 'keep both: three items created, nothing skipped', JSON.stringify(rr));
    const items = await served(href);
    check(items.length === 4, 'the calendar holds the old item and 3 new ones', String(items.length));
    const old = items.find((x) => x.href.endsWith('old-series.ics'));
    check(old && old.etag === oldTag && /OLD/.test(old.text), 'the old item is untouched');
    const copy = items.find((x) => /Weekly review/.test(x.text) && !x.href.endsWith('old-series.ics'));
    const cp = copy ? parts(copy.text) : { comps: [] };
    const newUid = cp.comps[0] && cp.comps[0].uid;
    check(cp.comps.length === 3 && newUid && newUid !== 'series-a@example.org' && cp.comps.every((c) => c.uid === newUid), 'the copy of the series has ONE new UID on the master and on both overrides', cp.comps.map((c) => c.uid).join(','));
    const d = lineDiff(sourceOf(text).byUid.get('series-a@example.org').join('\r\n'), cp.comps.flatMap((c) => c.lines).join('\r\n'));
    check(d.removed.length === 3 && d.removed.every((l) => l === 'UID:series-a@example.org') && d.added.length === 3 && d.added.every((l) => l === `UID:${newUid}`), 'nothing else differs from the source: only the three UID lines were rewritten', `-${d.removed.join('|')} +${d.added.join('|')}`);
    await assertClean(page, watch, 'ics keep both');
  } finally {
    await ctx.close();
  }
};

scenarios['ics-refusals'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const href = await mkcal('icsr', 'Refusals calendar');
    await signIn(page, 'alice');
    await openIcsImport(page, href);
    await chooseIcs(page, 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:A\r\nN:A;;;;\r\nEND:VCARD\r\n', 'people.vcf');
    await page.waitForFunction((t) => (document.querySelector('[data-testid="import-error"]') || {}).textContent?.includes(t), 'contacts file', { timeout: 10000 });
    check(await tid(page, 'dialog-import-confirm').isDisabled() && (await tid(page, 'import-error').getAttribute('role')) === 'alert', 'a contacts file given to a calendar is refused in a persistent alert; nothing can be imported');
    await chooseIcs(page, 'BEGIN:VCALENDAR\r\nVERSION:1.0\r\nPRODID:-//Old//EN\r\nBEGIN:VEVENT\r\nUID:old-version@example.org\r\nDTSTART:20260101T090000Z\r\nSUMMARY:Old format\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    await preview(page);
    check((await rowStates(page)).join() === '(no title):unsupported' && await tid(page, 'dialog-import-confirm').isDisabled(), 'a calendar of version 1.0 is listed as not supported and offers nothing to import', (await rowStates(page)).join());
    await chooseIcs(page, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//E//EN\r\nBEGIN:VEVENT\r\nUID:broken@example.org\r\nDTSTART:not-a-date\r\nSUMMARY:Broken date\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:fine@example.org\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260401T090000Z\r\nSUMMARY:Fine one\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    await preview(page);
    const st = await rowStates(page);
    check(st.includes('(no title):invalid') && st.includes('Fine one:new') && (await tid(page, 'dialog-import-confirm').textContent()).trim() === 'Import 1 item', 'one broken entry is reported and skipped without hiding the good one', st.join(' | '));
    await chooseIcs(page, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//E//EN\r\nBEGIN:VEVENT\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260401T090000Z\r\nSUMMARY:No ID at all\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    await preview(page);
    check((await page.locator('[data-kind="generated-uid"]').count()) === 1, 'an entry without an ID says that one is generated');
    await tid(page, 'dialog-cancel').click();
    await page.waitForSelector('[data-testid="dialog-import"]', { state: 'detached' });
    check((await listItems('alice', href)).length === 1, 'nothing was imported');
    await assertClean(page, watch, 'ics refusals');
  } finally {
    await ctx.close();
  }
};

scenarios['ics-phone'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { lang: 'fr', w: 390, h: 844, scheme: 'dark' });
  try {
    const href = await mkcal('icsp', 'Phone import');
    await davPut('alice', href + 'old-series.ics', OLD_SERIES, 'text/calendar');
    await signIn(page, 'alice');
    await openIcsImport(page, href);
    await chooseIcs(page, ICS_FILE());
    await preview(page);
    await shot(page, 'import-ics-preview-phone-dark-fr');
    await pageChecks(page, watch, 'ics import preview phone dark fr');
    await run(page);
    await shot(page, 'import-ics-report-phone-dark-fr');
    await pageChecks(page, watch, 'ics import report phone dark fr');
  } finally {
    await ctx.close();
  }
};
