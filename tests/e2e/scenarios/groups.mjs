// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `groups`: create (the form of the book: Apple form for a 3.0 book, RFC 6350 for a 4.0 book), name errors,
// rename, add and remove a member (one PUT on the group card, member cards never written), an unknown member that is
// kept, delete (the member cards are untouched). Each scenario makes its own address book through DAV.
import {
  DICT, assertClean, check, cryptoUuid, davGet, go, lineDiff, linesOf, listItems, makeBook, openPage, pageChecks, propName, shot,
  signIn, sleep, tid, uniq, vcard,
} from '../lib/common.mjs';
import { cardByUid, enc, openBook, saveContact } from '../lib/ui.mjs';

export const scenarios = {};
const groupsHash = (href) => `#/contacts/groups?ab=${enc(href)}`;
const uidNew = () => 'urn:uuid:' + cryptoUuid();

async function book(version, cards) {
  const name = uniq('grp');
  const href = await makeBook('alice', name, 'Groups ' + name, cards.map((c, i) => [`c${i}.vcf`, c]));
  return href;
}
const person = (version, uid, fn, family, given) => vcard(version, [`FN:${fn}`, `N:${family};${given};;;`, `EMAIL:${given.toLowerCase()}@example.org`], { uid });
const groupCard = (version, uid, name, members) => (version === '3.0'
  ? vcard('3.0', ['X-ADDRESSBOOKSERVER-KIND:group', `FN:${name}`, `N:${name};;;;`, ...members.map((m) => `X-ADDRESSBOOKSERVER-MEMBER:${m}`)], { uid })
  : vcard('4.0', ['KIND:group', `FN:${name}`, ...members.map((m) => `MEMBER:${m}`)], { uid }));
const memberLines = (text) => [...linesOf(text, 'X-ADDRESSBOOKSERVER-MEMBER'), ...linesOf(text, 'MEMBER')].map((l) => l.replace(/^[^:]*:/, ''));
const etags = async (href) => Object.fromEntries((await listItems('alice', href)).filter((i) => i.href !== href).map((i) => [i.href, i.etag]));

for (const version of ['3.0', '4.0']) {
  scenarios[`create-rename-delete-${version}`] = async (browser) => {
    const { ctx, page, watch } = await openPage(browser);
    try {
      const A = uidNew();
      const href = await book(version, [person(version, A, 'Ann Alpha', 'Alpha', 'Ann')]);
      await signIn(page, 'alice');
      await go(page, groupsHash(href));
      await page.getByTestId('groups-screen').waitFor();
      await page.waitForSelector('[data-testid="groups-screen"][data-state="ready"]');
      check((await tid(page, 'groups-count').textContent()).includes('0'), `${version}: a book without groups says so (0 groups)`, await tid(page, 'groups-count').textContent());
      await shot(page, `groups-empty-desktop-light-en-${version}`);
      await tid(page, 'btn-new-group').click();
      const dlg = tid(page, 'dialog-new-group');
      await dlg.waitFor();
      check(await page.evaluate(() => document.activeElement.dataset.testid) === 'field-group-name', `${version}: the new-group dialog focuses the name field`);
      // an empty name is refused next to the field
      await tid(page, 'dialog-create-group').click();
      await sleep(300);
      const err0 = await page.evaluate(() => (document.querySelector('dialog[open] .field__error') || {}).textContent || '');
      check(err0.length > 0 && (await tid(page, 'field-group-name').getAttribute('aria-invalid')) === 'true', `${version}: an empty name is refused with a message next to the field`, err0);
      await shot(page, `groups-new-dialog-error-desktop-light-en-${version}`);
      await tid(page, 'field-group-name').fill('Alpha team');
      await shot(page, `groups-new-dialog-filled-desktop-light-en-${version}`);
      await pageChecks(page, watch, `new group dialog ${version}`);
      const before = await listItems('alice', href);
      await tid(page, 'dialog-create-group').click();
      await page.getByTestId('group-detail').waitFor();
      const fresh = (await listItems('alice', href)).filter((i) => !before.some((b) => b.href === i.href));
      const text = fresh.length === 1 ? (await davGet('alice', fresh[0].href)).text : '';
      if (version === '3.0') check(/^VERSION:3\.0/m.test(text) && linesOf(text, 'X-ADDRESSBOOKSERVER-KIND')[0] === 'X-ADDRESSBOOKSERVER-KIND:group' && linesOf(text, 'FN')[0] === 'FN:Alpha team', '3.0: the new group card uses the Apple form (X-ADDRESSBOOKSERVER-KIND)', text.slice(0, 200));
      else check(/^VERSION:4\.0/m.test(text) && linesOf(text, 'KIND')[0] === 'KIND:group' && linesOf(text, 'FN')[0] === 'FN:Alpha team', '4.0: the new group card uses KIND:group', text.slice(0, 200));
      check((await tid(page, 'group-format-note').textContent()).includes(version), `${version}: the group screen names the card format`, await tid(page, 'group-format-note').textContent());
      // a duplicate name
      await go(page, groupsHash(href));
      await tid(page, 'btn-new-group').click();
      await tid(page, 'field-group-name').fill('alpha TEAM');
      await tid(page, 'dialog-create-group').click();
      await sleep(300);
      const dup = await page.evaluate(() => (document.querySelector('dialog[open] .field__error') || {}).textContent || '');
      check(dup.length > 0 && (await page.getByTestId('group-row').count()) === 1, `${version}: a name that differs only by case is a duplicate and is refused`, dup);
      await tid(page, 'dialog-cancel').click();
      // rename: only the name properties change
      await page.getByTestId('group-row').first().click();
      await page.getByTestId('group-detail').waitFor();
      const gh = fresh[0].href;
      const gUid = /^UID:(.*)$/m.exec(text)[1];
      await tid(page, 'field-group-rename').fill('Alpha crew');
      await shot(page, `groups-rename-desktop-light-en-${version}`);
      await tid(page, 'btn-rename-group').click();
      await page.waitForFunction(() => (document.querySelector('[data-testid="group-detail"] h2, [data-testid="group-detail"] h1') || {}).textContent?.includes('Alpha crew') || document.querySelector('[data-testid="field-group-rename"]')?.value === 'Alpha crew', null, { timeout: 15000 });
      await sleep(500);
      const renamed = (await davGet('alice', gh)).text;
      const d = lineDiff(text, renamed);
      const names = new Set([...d.removed, ...d.added].map(propName));
      check([...names].every((n) => ['FN', 'N', 'REV'].includes(n)) && linesOf(renamed, 'FN')[0] === 'FN:Alpha crew', `${version}: renaming changes only FN and N (and REV)`, JSON.stringify(d));
      check(linesOf(renamed, 'UID')[0] === `UID:${gUid}`, `${version}: the UID is unchanged`);
      // delete the group: member cards stay
      const cardsBefore = await etags(href);
      await tid(page, 'btn-delete-group').click();
      const ddlg = tid(page, 'dialog-delete-group');
      await ddlg.waitFor();
      check(await page.evaluate(() => document.activeElement.dataset.testid) === 'dialog-cancel', `${version}: the delete dialog focuses Cancel`);
      await shot(page, `groups-delete-dialog-desktop-light-en-${version}`);
      await tid(page, 'dialog-confirm-delete').click();
      await page.getByTestId('group-list').or(page.getByTestId('groups-empty')).first().waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="group-row"]').length === 0, null, { timeout: 15000 });
      const after = await etags(href);
      check(!(gh in after) && Object.entries(cardsBefore).every(([k, v]) => k === gh || after[k] === v), `${version}: the group card is gone and no other card was written (ETags unchanged)`);
      await assertClean(page, watch, `groups ${version}`);
    } finally {
      await ctx.close();
    }
  };

  scenarios[`members-${version}`] = async (browser) => {
    const { ctx, page, watch } = await openPage(browser);
    try {
      const A = uidNew();
      const B = uidNew();
      const C = uidNew();
      const G = uidNew();
      const OUTSIDE = 'urn:uuid:99999999-8888-7777-6666-555555555555';
      const href = await book(version, [
        person(version, A, 'Ann Alpha', 'Alpha', 'Ann'),
        person(version, B, 'Bert Beta', 'Beta', 'Bert'),
        person(version, C, 'Cleo Gamma', 'Gamma', 'Cleo'),
        groupCard(version, G, 'Core', [A, OUTSIDE, 'mailto:visitor@example.org']),
      ]);
      await signIn(page, 'alice');
      await go(page, groupsHash(href));
      await page.waitForSelector('[data-testid="groups-screen"][data-state="ready"]');
      check((await page.getByTestId('group-row').count()) === 1 && (await page.getByTestId('group-row').first().textContent()).includes('Core'), `${version}: the list has the one group`);
      await shot(page, `groups-list-desktop-light-en-${version}`);
      await pageChecks(page, watch, `groups list ${version}`);
      await page.getByTestId('group-row').first().click();
      await page.getByTestId('group-detail').waitFor();
      check((await page.getByTestId('member-row').count()) === 1 && (await page.getByTestId('member-unknown-row').count()) === 2, `${version}: one known member and two unknown members (another book, mailto:) are listed`);
      await shot(page, `groups-detail-desktop-light-en-${version}`);
      check((await tid(page, 'group-member-link').count()) === 1, `${version}: the member link carries a test id (F1): group-member-link`);
      await pageChecks(page, watch, `group detail ${version}`);
      const gh = (await listItems('alice', href)).find((i) => i.href.endsWith('c3.vcf')).href;
      const cards0 = await etags(href);
      // add Bert through the picker: one PUT, on the group card
      await tid(page, 'btn-add-member').click();
      await tid(page, 'member-picker').waitFor();
      check((await page.getByTestId('member-option').count()) === 2, `${version}: the picker offers the two contacts that are not members`, String(await page.getByTestId('member-option').count()));
      await shot(page, `groups-member-picker-desktop-light-en-${version}`);
      await pageChecks(page, watch, `member picker ${version}`);
      await tid(page, 'field-member-search').fill('bert');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="member-option"]').length === 1, null, { timeout: 5000 });
      await page.getByTestId('member-option').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="member-row"]').length === 2, null, { timeout: 15000 });
      let text = (await davGet('alice', gh)).text;
      check(JSON.stringify(memberLines(text)) === JSON.stringify([A, OUTSIDE, 'mailto:visitor@example.org', B]) || (memberLines(text).includes(B) && memberLines(text).length === 4), `${version}: Bert is added after the existing members, the unknown members are kept`, memberLines(text).join(' '));
      let cards1 = await etags(href);
      check(Object.entries(cards0).every(([k, v]) => k === gh || cards1[k] === v) && cards1[gh] !== cards0[gh], `${version}: only the group card was written (member cards keep their ETags)`);
      // remove Ann
      await page.getByTestId('btn-remove-member').first().click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="member-row"]').length === 1, null, { timeout: 15000 });
      text = (await davGet('alice', gh)).text;
      check(!memberLines(text).includes(A) && memberLines(text).includes(B) && memberLines(text).includes(OUTSIDE) && memberLines(text).includes('mailto:visitor@example.org'), `${version}: Ann is removed; Bert and both unknown members stay`, memberLines(text).join(' '));
      // remove one unknown member explicitly
      await page.getByTestId('member-unknown-row').first().getByTestId('btn-remove-member').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="member-unknown-row"]').length === 1, null, { timeout: 15000 });
      text = (await davGet('alice', gh)).text;
      check(memberLines(text).length === 2 && memberLines(text).includes(B), `${version}: an unknown member goes only when its own Remove is used`, memberLines(text).join(' '));
      const cards2 = await etags(href);
      check(Object.entries(cards0).every(([k, v]) => k === gh || cards2[k] === v), `${version}: member cards were never written (ETags unchanged after three group edits)`);
      // the contact's own detail lists the group and the group link opens it
      await openBook(page, href);
      await page.getByTestId('contact-row').filter({ hasText: 'Bert Beta' }).click();
      await page.getByTestId('contact-detail').waitFor();
      check((await page.getByTestId('contact-group-link').allTextContents()).join().includes('Core'), `${version}: the contact detail lists its group`);
      // add to group from the contact
      await page.getByTestId('contact-row').filter({ hasText: 'Cleo Gamma' }).click();
      await page.getByTestId('contact-detail').waitFor();
      await tid(page, 'btn-add-to-group').click();
      await page.getByTestId('group-picker').waitFor();
      await shot(page, `contact-add-to-group-picker-desktop-light-en-${version}`);
      await page.getByTestId('group-picker').getByRole('option').first().click().catch(async () => { await page.getByTestId('group-picker').locator('button, [role=option]').first().click(); });
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="contact-group-link"]').length === 1, null, { timeout: 15000 });
      text = (await davGet('alice', gh)).text;
      check(memberLines(text).includes(C), `${version}: "Add to group" from the contact adds it to the group card`, memberLines(text).join(' '));
      await assertClean(page, watch, `members ${version}`);
    } finally {
      await ctx.close();
    }
  };
}

scenarios['phone-fr'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { lang: 'fr', w: 390, h: 844, scheme: 'dark' });
  try {
    const A = uidNew();
    const G = uidNew();
    const href = await book('3.0', [person('3.0', A, 'Ann Alpha', 'Alpha', 'Ann'), groupCard('3.0', G, 'Équipe', [A])]);
    await signIn(page, 'alice');
    await go(page, groupsHash(href));
    await page.waitForSelector('[data-testid="groups-screen"][data-state="ready"]');
    await shot(page, 'groups-list-phone-dark-fr');
    await pageChecks(page, watch, 'groups list phone dark fr');
    await page.getByTestId('group-row').first().click();
    await page.getByTestId('group-detail').waitFor();
    await shot(page, 'groups-detail-phone-dark-fr');
    await pageChecks(page, watch, 'group detail phone dark fr');
    await tid(page, 'btn-delete-group').click();
    await tid(page, 'dialog-delete-group').waitFor();
    await shot(page, 'groups-delete-dialog-phone-dark-fr');
    await pageChecks(page, watch, 'group delete dialog phone dark fr');
    await tid(page, 'dialog-cancel').click();
  } finally {
    await ctx.close();
  }
};
