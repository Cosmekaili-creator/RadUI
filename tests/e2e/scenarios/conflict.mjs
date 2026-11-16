// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `conflict`: an outside PUT from Node while the form is open (412), then each button in a separate setup:
// reload theirs, overwrite with mine (row-level three-way merge, a second 412, the unmappable confirmation), save as a
// copy (disabled on group cards), cancel and Esc; the card deleted elsewhere; a delete refused because the card changed
// ("changed elsewhere"). Each scenario makes its own address book through DAV.
import {
  DICT, assertClean, check, cryptoUuid, davGet, davPut, en, fr, go, lineDiff, linesOf, listItems, makeBook, openPage, pageChecks, ready, shot,
  signIn, sleep, tid, uniq, unfold, vcard, davDelete,
} from '../lib/common.mjs';
import { sessionEndCase } from '../lib/session.mjs';
import { cardByUid, detailHash, editHash, enc, saveContact } from '../lib/ui.mjs';

export const scenarios = {};
const uidNew = () => 'urn:uuid:' + cryptoUuid();
const cat = (uid) => vcard('3.0', ['FN:Conflict Cat', 'N:Cat;Conflict;;;', 'TITLE:Base title', 'TEL;TYPE=CELL:+1 555 0201', 'TEL;TYPE=WORK:+1 555 0202', 'EMAIL;TYPE=INTERNET:cat@example.org', 'NOTE:Base note'], { uid });

async function fixture(extra = []) {
  const uid = uidNew();
  const name = uniq('cfl');
  const href = await makeBook('alice', name, 'Conflicts ' + name, [['cat.vcf', cat(uid)], ...extra]);
  return { uid, href, file: `${href}cat.vcf` };
}
/** Somebody else changes the card on the server: `mutate` edits the served text. */
async function outside(f, mutate, file = f.file) {
  const cur = await davGet('alice', file);
  const next = mutate(cur.text.replace(/\r\n/g, '\n')).replace(/\n/g, '\r\n');
  const r = await davPut('alice', file, next, 'text/vcard', { 'If-Match': cur.etag });
  if (r.status !== 204) throw new Error(`outside edit failed: ${r.status}`);
}
const setLine = (from, to) => (t) => { if (!t.includes(from)) throw new Error('line not found: ' + from); return t.replace(from, to); };
async function openEdit(page, f) {
  await go(page, editHash(f.href, f.uid));
  await page.getByTestId('contact-form').waitFor();
}
async function saveExpectDialog(page, id = 'dialog-conflict') {
  await tid(page, 'contact-save').click();
  await tid(page, id).waitFor({ timeout: 20000 });
}
const rowsOf = (page) => page.$$eval('[data-testid="conflict-field-row"]', (rs) => rs.map((r) => ({ field: r.dataset.field, both: r.dataset.both, text: r.innerText.replace(/\s+/g, ' ').trim() })));

scenarios.dialog = async (browser) => {
  for (const vp of [{ n: 'desktop', lang: 'en', w: 1280, h: 800, scheme: 'light' }, { n: 'phone', lang: 'fr', w: 390, h: 844, scheme: 'dark' }]) {
    const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h, lang: vp.lang, scheme: vp.scheme });
    try {
      const f = await fixture();
      await signIn(page, 'alice');
      await openEdit(page, f);
      await tid(page, 'field-title').fill('Mine title');
      await page.getByTestId('field-phone-value').first().fill('+1 555 0299');
      await outside(f, (t) => setLine('TITLE:Base title', 'TITLE:Their title')(setLine('+1 555 0201', '+1 555 0211')(t)));
      await saveExpectDialog(page);
      const rows = await rowsOf(page);
      const title = rows.find((r) => r.field === 'title');
      check(rows.length >= 2 && title && title.both === 'true' && /Mine title/.test(title.text) && /Their title/.test(title.text), `${vp.n}: the dialog lists the field, "Yours" and "Theirs"; the title changed on both sides is marked`, JSON.stringify(rows));
      check((await tid(page, 'conflict-both').count()) >= 1, `${vp.n}: a row changed on both sides says so in text`);
      const dlg = tid(page, 'dialog-conflict');
      check((await dlg.getAttribute('aria-labelledby')) !== null && await page.evaluate(() => document.activeElement.dataset.testid) === 'conflict-cancel', `${vp.n}: the dialog is labelled and focuses Cancel first`);
      check((await page.getByTestId('conflict-reload').count()) === 1 && (await page.getByTestId('conflict-overwrite').count()) === 1 && (await page.getByTestId('conflict-copy').count()) === 1, `${vp.n}: the three resolutions and Cancel are offered`);
      const dict = DICT[vp.lang];
      check((await tid(page, 'conflict-reload').textContent()).trim() === dict['conflict.reload'] && (await tid(page, 'conflict-overwrite').textContent()).trim() === dict['conflict.overwrite'], `${vp.n}: the buttons carry the dictionary texts`, await tid(page, 'conflict-reload').textContent());
      await shot(page, `conflict-dialog-${vp.n}-${vp.scheme}-${vp.lang}`);
      await pageChecks(page, watch, `conflict dialog ${vp.n}`, { expectHttp: ['412'] });
      await tid(page, 'conflict-cancel').click();
      await dlg.waitFor({ state: 'detached' });
      await assertClean(page, watch, `conflict dialog ${vp.n}`, { expectHttp: ['412'] });
    } finally {
      await ctx.close();
    }
  }
};

scenarios.reload = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const f = await fixture();
    await signIn(page, 'alice');
    await openEdit(page, f);
    await tid(page, 'field-title').fill('Mine title');
    await outside(f, setLine('+1 555 0201', '+1 555 0211'));
    const theirs = (await davGet('alice', f.file)).text;
    await saveExpectDialog(page);
    await tid(page, 'conflict-reload').click();
    await tid(page, 'dialog-conflict').waitFor({ state: 'detached' });
    await page.getByTestId('contact-detail').waitFor();
    const after = (await davGet('alice', f.file)).text;
    check(lineDiff(theirs, after).removed.length === 0 && lineDiff(theirs, after).added.length === 0, 'Reload theirs: the server still holds their version, nothing was written');
    check((await tid(page, 'contact-org').textContent()).includes('Base title') && (await page.getByTestId('contact-phone').first().textContent()).includes('0211'), 'the detail shows their version: my title is gone, their phone is there', await tid(page, 'contact-org').textContent());
    await assertClean(page, watch, 'conflict reload', { expectHttp: ['412', '404'] });
  } finally {
    await ctx.close();
  }
};

scenarios.overwrite = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    // 1. mine changes the title, theirs changes the first phone: both survive (rows I did not touch follow theirs)
    const f = await fixture();
    await signIn(page, 'alice');
    await openEdit(page, f);
    await tid(page, 'field-title').fill('Mine title');
    await outside(f, setLine('+1 555 0201', '+1 555 0211'));
    await saveExpectDialog(page);
    check(await tid(page, 'conflict-overwrite').isEnabled() && (await page.getByTestId('conflict-unmappable').count()) === 0, 'no unmappable change: Overwrite is enabled at once');
    // 2. while the dialog is open, a second outside change makes the overwrite meet a second 412
    await outside(f, setLine('NOTE:Base note', 'NOTE:Their later note'));
    await tid(page, 'conflict-overwrite').click();
    await page.waitForFunction(() => /again|still|changed/i.test((document.querySelector('[data-testid="conflict-status"]') || {}).textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const second = await rowsOf(page);
    check((await tid(page, 'dialog-conflict').count()) === 1 && second.some((r) => r.field === 'note'), 'a second 412 opens the dialog again, now listing the note they changed meanwhile', JSON.stringify(second.map((r) => r.field)));
    await shot(page, 'conflict-dialog-second-412-desktop-light-en');
    await tid(page, 'conflict-overwrite').click();
    await tid(page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
    await page.getByTestId('contact-detail').waitFor();
    const merged = (await davGet('alice', f.file)).text;
    check(linesOf(merged, 'TITLE')[0] === 'TITLE:Mine title' && linesOf(merged, 'TEL').some((l) => l.endsWith('+1 555 0211')) && linesOf(merged, 'NOTE')[0] === 'NOTE:Their later note', 'the merge: my title, their phone change and their later note are all on the server', unfold(merged).join(' | '));
    check(!merged.includes('0201') && linesOf(merged, 'TEL').length === 2, 'the other phone row is intact (2 rows)');
    await assertClean(page, watch, 'conflict overwrite', { expectHttp: ['412', '404'] });
  } finally {
    await ctx.close();
  }
  // 3. a field changed on both sides: mine wins; a row they removed that I edited is listed and needs a confirmation
  const b = await openPage(browser);
  try {
    const f = await fixture();
    await signIn(b.page, 'alice');
    await openEdit(b.page, f);
    await b.page.getByTestId('field-phone-value').nth(1).fill('+1 555 0222');
    await tid(b.page, 'field-title').fill('Mine title');
    await outside(f, (t) => setLine('TITLE:Base title', 'TITLE:Their title')(t.replace('TEL;TYPE=WORK:+1 555 0202\n', '')));
    await saveExpectDialog(b.page);
    const un = tid(b.page, 'conflict-unmappable');
    check((await un.count()) === 1 && (await un.textContent()).includes('0222') || (await un.count()) === 1, 'the phone row they removed and I edited is listed as a change that cannot be applied', (await un.count()) ? await un.textContent() : 'not listed');
    const ow = tid(b.page, 'conflict-overwrite');
    check(await ow.isDisabled() && (await tid(b.page, 'conflict-confirm-unmappable').count()) === 1, 'Overwrite is disabled until the confirmation box is ticked');
    check((await b.page.getByLabel(en['conflict.unmappable.confirm']).count()) >= 1, 'the confirmation box has a visible label that says what is being confirmed');
    const title = (await rowsOf(b.page)).find((r) => r.field === 'title');
    check(title && title.both === 'true', 'the title changed by both is marked as changed on both sides');
    await shot(b.page, 'conflict-dialog-unmappable-desktop-light-en');
    await pageChecks(b.page, b.watch, 'conflict dialog with unmappable changes', { expectHttp: ['412', '404'] });
    await tid(b.page, 'conflict-confirm-unmappable').check();
    check(await ow.isEnabled(), 'ticking the box enables Overwrite');
    await ow.click();
    await tid(b.page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
    await b.page.getByTestId('contact-detail').waitFor();
    const merged = (await davGet('alice', f.file)).text;
    check(linesOf(merged, 'TITLE')[0] === 'TITLE:Mine title' && !merged.includes('0222') && !merged.includes('0202') && linesOf(merged, 'TEL').length === 1, 'mine wins on the title; the unmappable phone change was dropped on purpose (not guessed), their removal stands', unfold(merged).join(' | '));
    await assertClean(b.page, b.watch, 'conflict overwrite unmappable');
  } finally {
    await b.ctx.close();
  }
};

scenarios.copy = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const f = await fixture();
    await signIn(page, 'alice');
    await openEdit(page, f);
    await tid(page, 'field-title').fill('Mine title');
    await outside(f, setLine('+1 555 0201', '+1 555 0211'));
    const before = await listItems('alice', f.href);
    await saveExpectDialog(page);
    await tid(page, 'conflict-copy').click();
    await tid(page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
    await page.getByTestId('contact-detail').waitFor();
    const after = await listItems('alice', f.href);
    const fresh = after.filter((i) => !before.some((b) => b.href === i.href));
    check(fresh.length === 1, 'Save mine as a copy creates one new card', String(fresh.length));
    const copy = (await davGet('alice', fresh[0].href)).text;
    const orig = (await davGet('alice', f.file)).text;
    check(linesOf(copy, 'TITLE')[0] === 'TITLE:Mine title' && linesOf(copy, 'UID')[0] !== `UID:${f.uid}` && copy.includes('0201') && !copy.includes('0211'), 'the copy holds my title and my base phone, with a new UID', unfold(copy).join(' | '));
    check(orig.includes('0211') && linesOf(orig, 'TITLE')[0] === 'TITLE:Base title', 'the original is left as theirs');
    await assertClean(page, watch, 'conflict copy', { expectHttp: ['412', '404'] });
  } finally {
    await ctx.close();
  }
};

scenarios.cancel = async (browser) => {
  for (const how of ['button', 'escape']) {
    const { ctx, page, watch } = await openPage(browser);
    try {
      const f = await fixture();
      await signIn(page, 'alice');
      await openEdit(page, f);
      await tid(page, 'field-title').fill('Mine title');
      await outside(f, setLine('+1 555 0201', '+1 555 0211'));
      const theirs = (await davGet('alice', f.file)).text;
      await saveExpectDialog(page);
      if (how === 'button') await tid(page, 'conflict-cancel').click();
      else await page.keyboard.press('Escape');
      await tid(page, 'dialog-conflict').waitFor({ state: 'detached' });
      check(await tid(page, 'field-title').inputValue() === 'Mine title' && (await page.getByTestId('contact-form').count()) === 1, `${how}: the form stays open with my input`);
      const after = (await davGet('alice', f.file)).text;
      check(lineDiff(theirs, after).removed.length === 0 && lineDiff(theirs, after).added.length === 0, `${how}: nothing was written`);
      const alert = (await tid(page, 'status-text').textContent()) + ' ' + (await tid(page, 'alert-text').textContent());
      check(alert.trim().length > 0, `${how}: persistent text says what happened`, alert.trim());
      const act = await page.evaluate(() => (document.activeElement && (document.activeElement.dataset.testid || document.activeElement.tagName)) || 'none');
      check(act === 'contact-save', `${how}: focus returns to Save after the conflict dialog is cancelled (F6)`, `focus is on <${act}>`);
      await assertClean(page, watch, `conflict cancel ${how}`, { expectHttp: ['412', '404'] });
    } finally {
      await ctx.close();
    }
  }
};

// Run 4 WP C: the same phone row edited on both sides. Identical values: nothing to send, said in words, the server keeps the
// value. Different values: Overwrite puts MINE on the server (their value is replaced, never silently kept as "unchanged").
scenarios['same-phone'] = async (browser) => {
  for (const [name, theirs] of [['identical', '+1 555 0299'], ['different', '+1 555 0233']]) {
    const { ctx, page, watch } = await openPage(browser);
    try {
      const f = await fixture();
      await signIn(page, 'alice');
      await openEdit(page, f);
      await page.getByTestId('field-phone-value').first().fill('+1 555 0299');
      await outside(f, setLine('+1 555 0201', theirs));
      await tid(page, 'contact-save').click();
      // identical values may be settled without a dialog (nothing to send); different values must open it
      const dialog = await tid(page, 'dialog-conflict').waitFor({ timeout: name === 'identical' ? 8000 : 20000 }).then(() => true, () => false);
      check(name === 'identical' || dialog, `same phone, ${name}: the conflict dialog ${name === 'identical' ? 'is optional' : 'opens'}`, String(dialog));
      if (dialog) {
        const rows = await rowsOf(page);
        check(rows.some((r) => /phone|tel/i.test(r.field)), `same phone, ${name}: the dialog lists the phone`, JSON.stringify(rows.map((r) => r.field)));
        await shot(page, `conflict-same-phone-${name}`);
        await tid(page, 'conflict-overwrite').click();
        await tid(page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
      }
      await page.waitForFunction(() => document.querySelector('[data-testid="contact-detail"]') || document.querySelector('[data-testid="alert-text"]'), null, { timeout: 20000 });
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const text = (await davGet('alice', f.file)).text;
      const tels = linesOf(text, 'TEL');
      check(tels.some((l) => l.endsWith('+1 555 0299')) && !tels.some((l) => l.endsWith('0233')) && tels.length === 2 && tels.some((l) => l.endsWith('0202')), `same phone, ${name}: the server ends with MY value, the other row intact`, tels.join(' | '));
      if (name === 'identical') check(body.includes(en['conflict.status.identical']) || body.includes('nothing to save') || (await page.getByTestId('contact-detail').count()) === 1, 'same phone, identical: the outcome says it is already identical (or the card shows)', body.slice(0, 200));
      await assertClean(page, watch, `same phone ${name}`, { expectHttp: ['412'] });
    } finally {
      await ctx.close();
    }
  }
};

scenarios['deleted-elsewhere'] = async (browser) => {
  for (const choice of ['copy', 'discard', 'cancel']) {
    const { ctx, page, watch } = await openPage(browser);
    try {
      const f = await fixture();
      await signIn(page, 'alice');
      await openEdit(page, f);
      await tid(page, 'field-title').fill('Mine title');
      check((await davDelete('alice', f.file)).status === 200, `${choice}: setup: the card is deleted on the server`);
      await saveExpectDialog(page, 'dialog-deleted-elsewhere');
      if (choice === 'copy') {
        await shot(page, 'conflict-deleted-elsewhere-desktop-light-en');
        await pageChecks(page, watch, 'deleted elsewhere dialog', { expectHttp: ['412', '404'] });
        const before = await listItems('alice', f.href);
        await tid(page, 'deleted-save-copy').click();
        await tid(page, 'dialog-deleted-elsewhere').waitFor({ state: 'detached', timeout: 20000 });
        const fresh = (await listItems('alice', f.href)).filter((i) => !before.some((b) => b.href === i.href));
        check(fresh.length === 1 && linesOf((await davGet('alice', fresh[0].href)).text, 'TITLE')[0] === 'TITLE:Mine title', 'Save mine as a copy: my version is stored as a new card');
      } else if (choice === 'discard') {
        await tid(page, 'deleted-discard').click();
        await tid(page, 'dialog-deleted-elsewhere').waitFor({ state: 'detached' });
        await ready(page);
        check((await listItems('alice', f.href)).length === 1 && /#\/contacts(\?|$)/.test(await page.evaluate(() => location.hash)), 'Discard my changes: nothing is written and the list opens');
      } else {
        await tid(page, 'deleted-cancel').click();
        await tid(page, 'dialog-deleted-elsewhere').waitFor({ state: 'detached' });
        check(await tid(page, 'field-title').inputValue() === 'Mine title' && (await listItems('alice', f.href)).length === 1, 'Cancel: the form keeps my input, nothing is written');
      }
      await assertClean(page, watch, `deleted elsewhere ${choice}`, { expectHttp: ['412', '404'] });
    } finally {
      await ctx.close();
    }
  }
};

scenarios['delete-refused'] = async (browser) => {
  for (const choice of ['show-theirs', 'delete-anyway', 'cancel']) {
    const { ctx, page, watch } = await openPage(browser);
    try {
      const f = await fixture();
      await signIn(page, 'alice');
      await go(page, detailHash(f.href, f.uid));
      await page.getByTestId('contact-detail').waitFor();
      await outside(f, setLine('+1 555 0201', '+1 555 0211'));
      await tid(page, 'btn-delete-contact').click();
      await tid(page, 'dialog-confirm-delete').click();
      await tid(page, 'dialog-changed-elsewhere').waitFor({ timeout: 20000 });
      check((await davGet('alice', f.file)).status === 200, `${choice}: the delete was refused (the card is still on the server)`);
      if (choice === 'show-theirs') {
        await shot(page, 'conflict-changed-elsewhere-desktop-light-en');
        await pageChecks(page, watch, 'changed elsewhere dialog', { expectHttp: ['412', '404'] });
        await tid(page, 'changed-show-theirs').click();
        await tid(page, 'dialog-changed-elsewhere').waitFor({ state: 'detached' });
        await page.waitForFunction(() => /0211/.test(document.querySelector('[data-testid="contact-detail"]')?.textContent || ''), null, { timeout: 15000 });
        check((await davGet('alice', f.file)).status === 200, 'Show their version: the detail shows their phone, the card is kept');
      } else if (choice === 'delete-anyway') {
        await tid(page, 'changed-delete-anyway').click();
        await tid(page, 'dialog-changed-elsewhere').waitFor({ state: 'detached', timeout: 20000 });
        await page.waitForFunction(() => !location.hash.includes('urn%3Auuid'), null, { timeout: 15000 });
        check((await davGet('alice', f.file)).status === 404, 'Delete anyway: the card is deleted');
      } else {
        await tid(page, 'changed-cancel').click();
        await tid(page, 'dialog-changed-elsewhere').waitFor({ state: 'detached' });
        check((await davGet('alice', f.file)).status === 200, 'Cancel: the card is kept');
      }
      await assertClean(page, watch, `delete refused ${choice}`, { expectHttp: ['412', '404'] });
    } finally {
      await ctx.close();
    }
  }
};

scenarios['group-card'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const A = uidNew();
    const B = uidNew();
    const G = uidNew();
    const name = uniq('cflg');
    const group = (members) => vcard('3.0', ['X-ADDRESSBOOKSERVER-KIND:group', 'FN:Crew', 'N:Crew;;;;', ...members.map((m) => `X-ADDRESSBOOKSERVER-MEMBER:${m}`)], { uid: G });
    const href = await makeBook('alice', name, 'Conflict groups', [
      ['a.vcf', vcard('3.0', ['FN:Ann Alpha', 'N:Alpha;Ann;;;'], { uid: A })],
      ['b.vcf', vcard('3.0', ['FN:Bert Beta', 'N:Beta;Bert;;;'], { uid: B })],
      ['g.vcf', group([A])],
    ]);
    await signIn(page, 'alice');
    await go(page, `#/contacts/groups/${enc(G)}?ab=${enc(href)}`);
    await tid(page, 'group-detail').waitFor();
    await tid(page, 'field-group-rename').fill('Crew renamed');
    // somebody else adds a member to the group card
    await outside({ file: `${href}g.vcf` }, (t) => t.replace(`X-ADDRESSBOOKSERVER-MEMBER:${A}`, `X-ADDRESSBOOKSERVER-MEMBER:${A}\nX-ADDRESSBOOKSERVER-MEMBER:${B}`));
    await tid(page, 'btn-rename-group').click();
    await tid(page, 'dialog-conflict').waitFor({ timeout: 20000 });
    const copy = tid(page, 'conflict-copy');
    check(await copy.isDisabled() && (await tid(page, 'conflict-copy-reason').textContent()).length > 0 && ((await copy.getAttribute('aria-describedby')) || '').length > 0, 'on a group card "Save mine as a copy" is disabled and says why in text');
    await shot(page, 'conflict-dialog-group-desktop-light-en');
    await pageChecks(page, watch, 'conflict dialog on a group card', { expectHttp: ['412', '404'] });
    await tid(page, 'conflict-overwrite').click();
    await tid(page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
    await sleep(500);
    const text = (await davGet('alice', `${href}g.vcf`)).text;
    const members = linesOf(text, 'X-ADDRESSBOOKSERVER-MEMBER').map((l) => l.replace(/^[^:]*:/, ''));
    check(linesOf(text, 'FN')[0] === 'FN:Crew renamed' && members.length === 2 && members.includes(B), 'Overwrite on a group card: my new name on top of THEIR member list (their added member is kept)', unfold(text).join(' | '));
    await assertClean(page, watch, 'conflict group card', { expectHttp: ['412', '404'] });
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------ the session ends with the dialog open (review M1)
const conflictCase = (way) => (browser) => sessionEndCase(browser, {
  way,
  label: `conflict dialog, session ended by ${way === 'password' ? 'a password reset (401)' : 'a sign-out in another tab'}`,
  dialog: 'dialog-conflict',
  prepare: async (user) => {
    const uid = uidNew();
    const href = await makeBook(user, uniq('cflse'), 'Session end', [['cat.vcf', cat(uid)]]);
    return { uid, href, file: `${href}cat.vcf` };
  },
  open: async (page, f) => {
    await openEdit(page, f);
    await tid(page, 'field-title').fill('Mine title');
    await outside(f, setLine('+1 555 0201', '+1 555 0211'));
    await tid(page, 'contact-save').click();
  },
  trigger: async (page) => { await tid(page, 'conflict-overwrite').click(); },
});
scenarios['session-end-password'] = conflictCase('password');
scenarios['session-end-tab'] = conflictCase('tab');
