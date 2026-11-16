// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `shots`: the screenshot matrix as its own suite. Phone 390x844 and desktop 1280x800, light and dark, English and
// French, for the screens people use most; every form in its fill-in, edit and error states and every dialog. The
// standard per-page checks of run 1 run on every capture (no console error, CSP violation, failed or foreign request;
// no horizontal overflow; an accessible name and a data-testid on every control; contrast of 4.5:1). Files go to
// tests/e2e/shots/ (git-ignored) as <screen>-<viewport>-<scheme>-<lang>.png.
import {
  COMBOS, DICT, api, check, cryptoUuid, dav, davGet, davPut, go, makeBook, openPage, pageChecks, ready, shot, signIn, sleep, spec, tid, uniq, vcard,
} from '../lib/common.mjs';
import { detailHash, editHash, enc, listHash } from '../lib/ui.mjs';

export const scenarios = {};
const FAST = process.argv.includes('--fast');
const CORE = spec.core['3.0'];

const MKCAL = (name) => `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>${name}</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;

/** Capture the current screen and run the per-page checks on it. */
async function capture(page, watch, name, tag, opts = {}) {
  await sleep(150);
  await shot(page, `${name}-${tag}`);
  await pageChecks(page, watch, `${name} ${tag}`, opts);
}

async function runCombo(browser, combo, { extra }) {
  const tag = combo.name;
  const L = DICT[combo.lang];
  const { ctx, page, watch } = await openPage(browser, { w: combo.w, h: combo.h, scheme: combo.scheme, lang: combo.lang });
  try {
    // a collection for the delete dialog; it exists before the account's collections are first listed
    const del = uniq('shotdel');
    await makeBook('alice', del, 'Shot target ' + del, [['a.vcf', vcard('3.0', ['FN:Doomed', 'N:Doomed;Soon;;;'])]]);
    // a card to edit (also made before the first listing, so the app knows the book)
    const uid = 'urn:uuid:' + cryptoUuid();
    const name = uniq('shotedit');
    const href = await makeBook('alice', name, 'Shot edit ' + name, [['r.vcf', vcard('3.0', ['FN:Rita Rich', 'N:Rich;Rita;;;', 'ORG:Example Org;Research', 'TITLE:Analyst', 'TEL;TYPE=CELL,pref:+1 555 0140', 'item1.TEL:+1 555 0141', 'item1.X-ABLabel:Studio line', 'EMAIL;TYPE=INTERNET,WORK:rita@example.org', 'ADR;TYPE=WORK:;;1 Example Road;Sampletown;;00001;Exampleland', 'URL:https://example.org/rita', 'BDAY:1985-06-30', 'CATEGORIES:friends,colleagues', 'NOTE:First line\\nSecond line'], { uid })]]);
    // login
    await page.goto(spec.base + spec.uiPath);
    await ready(page);
    await capture(page, watch, 'login', tag);
    await tid(page, 'login-username').fill('alice');
    await tid(page, 'login-password').fill(spec.users.alice);
    await tid(page, 'login-submit').click();
    await page.waitForFunction(() => location.hash.startsWith('#/contacts'), null, { timeout: 30000 });
    await ready(page);
    // contacts: list, detail
    await go(page, listHash('/alice/contacts/'));
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    await capture(page, watch, 'contacts-list', tag);
    await page.getByTestId('contact-row').filter({ hasText: 'Jane Doe' }).click();
    await page.getByTestId('contact-detail').waitFor();
    await capture(page, watch, 'contact-detail', tag);
    // the new-contact form: empty, then its errors
    await go(page, `#/contacts/new?ab=${enc('/alice/contacts/')}`);
    await page.getByTestId('contact-form').waitFor();
    await capture(page, watch, 'contact-form-new', tag);
    await tid(page, 'contact-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    await capture(page, watch, 'contact-form-errors', tag);
    await tid(page, 'field-given').fill('Shot');
    await tid(page, 'field-family').fill('Taker');
    await tid(page, 'btn-add-phone').click();
    await page.getByTestId('field-phone-value').first().fill('+1 555 0188');
    await tid(page, 'btn-add-email').click();
    await page.getByTestId('field-email-value').first().fill('shot.taker@example.org');
    await capture(page, watch, 'contact-form-filled', tag);
    // leave the changed form the way a person does: Cancel, then "Discard changes"
    await tid(page, 'contact-cancel').click();
    await tid(page, 'dialog-discard').click();
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    // delete dialog of a contact
    await go(page, detailHash('/alice/contacts/', CORE.rick));
    await page.getByTestId('contact-detail').waitFor();
    await tid(page, 'btn-delete-contact').click();
    await tid(page, 'dialog-delete-contact').waitFor();
    await capture(page, watch, 'contact-delete-dialog', tag);
    await tid(page, 'dialog-cancel').click();
    // import dialog
    await go(page, listHash('/alice/contacts/'));
    await tid(page, 'btn-import-vcf').click();
    await tid(page, 'dialog-import').waitFor();
    await capture(page, watch, 'import-dialog', tag);
    await tid(page, 'dialog-cancel').click();
    // collections: list, new calendar (fill-in and errors), delete dialog
    await go(page, '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="collection-count"]')].every((e) => e.getAttribute('aria-busy') === 'false'), null, { timeout: 30000 });
    await capture(page, watch, 'collections-list', tag);
    await tid(page, 'btn-new-calendar').click();
    await page.getByTestId('calendar-form').waitFor();
    await capture(page, watch, 'collection-form-new', tag);
    await tid(page, 'collection-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    await capture(page, watch, 'collection-form-errors', tag);
    await tid(page, 'collection-cancel').click();
    const dis = page.getByTestId('dialog-discard');
    if (await dis.waitFor({ state: 'visible', timeout: 800 }).then(() => true, () => false)) await dis.click();
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await go(page, `#/collections?dialog=delete&href=${enc(`/alice/${del}/`)}`);
    await tid(page, 'dialog-delete-collection').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="delete-count"]')?.dataset.count !== '', null, { timeout: 15000 });
    await capture(page, watch, 'collection-delete-dialog', tag);
    await tid(page, 'dialog-cancel').click();
    await page.waitForFunction(() => location.hash === '#/collections');
    if (!extra) return;
    // groups, the edit form, the conflict dialog (one pass per viewport and scheme)
    await go(page, `#/contacts/groups?ab=${enc('/alice/contacts/')}`);
    await page.waitForSelector('[data-testid="groups-screen"][data-state="ready"]');
    await capture(page, watch, 'groups-list', tag);
    await page.getByTestId('group-row').first().click();
    await page.getByTestId('group-detail').waitFor();
    await capture(page, watch, 'group-detail', tag);
    await go(page, editHash(href, uid));
    await page.getByTestId('contact-form').waitFor();
    await capture(page, watch, 'contact-form-edit', tag);
    await tid(page, 'field-title').fill('Senior analyst');
    const cur = await davGet('alice', `${href}r.vcf`);
    await davPut('alice', `${href}r.vcf`, cur.text.replace(/\r?\n/g, '\r\n').replace('+1 555 0140', '+1 555 0149'), 'text/vcard', { 'If-Match': cur.etag });
    await tid(page, 'contact-save').click();
    await tid(page, 'dialog-conflict').waitFor();
    await capture(page, watch, 'conflict-dialog', tag, { expectHttp: ['412'] });
    await tid(page, 'conflict-cancel').click();
    check(true, `matrix pass complete (extra screens): ${tag}`);
  } finally {
    await ctx.close();
  }
}

for (const combo of COMBOS) {
  scenarios[combo.name] = async (browser) => {
    if (FAST && combo.scheme === 'dark') return;
    // the extra screens (groups, edit form, conflict) in English only, to stay inside one capped run
    await runCombo(browser, combo, { extra: combo.lang === 'en' });
  };
}

// ---------------------------------------------------------------------------------------------- run 4 cosmetic checks
// `run4-cosmetic` (run it by name: `run.py --suite=shots run4-cosmetic`): the file field of the import dialog (no native
// browser text; button, file name), the aligned "Ends" radios, equal gaps in the task form, a login on one line in the
// users table, the Settings About block. Phone and desktop, English and French; three screenshots.
scenarios['run4-cosmetic'] = async (browser) => {
  const slug = uniq('r4cos').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const calHref = `/alice/${slug}/`;
  const mk = await dav('alice', 'MKCALENDAR', calHref, `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Run4 cosmetic</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`, { 'Content-Type': 'application/xml' });
  check(mk.status === 201, 'run4: the calendar for the cosmetic checks is made', String(mk.status));
  for (const [w, h, lang] of [[390, 844, 'en'], [390, 844, 'fr'], [1280, 800, 'en'], [1280, 800, 'fr']]) {
    const tag = `${w === 390 ? 'phone' : 'desktop'}-light-${lang}`;
    const L = DICT[lang];
    const { ctx, page, watch } = await openPage(browser, { w, h, scheme: 'light', lang });
    try {
      await signIn(page, 'alice');
      // (1) the import dialog
      await go(page, listHash('/alice/contacts/'));
      await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
      await tid(page, 'btn-import-vcf').click();
      const dlg = tid(page, 'dialog-import');
      await dlg.waitFor();
      const btn = tid(page, 'btn-choose-file');
      const nm = tid(page, 'import-file-name');
      check((await btn.textContent()).trim() === L['import.chooseFile'] && (await nm.textContent()).trim() === L['import.noFileChosen'], `run4: import file field shows the translated button and "no file" text: ${tag}`);
      const geo = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="dialog-import"]').getBoundingClientRect();
        const b = document.querySelector('[data-testid="btn-choose-file"]').getBoundingClientRect();
        const n = document.querySelector('[data-testid="import-file-name"]').getBoundingClientRect();
        const nat = document.querySelector('[data-testid="field-import-file"]');
        return { inside: b.left >= d.left && b.right <= d.right && n.right <= d.right + 1, nativeBox: [nat.offsetWidth, nat.offsetHeight], overflow: document.documentElement.scrollWidth > innerWidth };
      });
      check(geo.inside && !geo.overflow, `run4: import file button and name stay inside the dialog: ${tag}`, JSON.stringify(geo));
      await tid(page, 'field-import-file').setInputFiles({ name: 'people.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcard('3.0', ['FN:Cos Metic', 'N:Metic;Cos;;;'], { uid: 'urn:uuid:' + cryptoUuid() }), 'utf8') });
      await page.waitForFunction(() => document.querySelector('[data-testid="import-file-name"]').textContent.includes('people.vcf'), null, { timeout: 10000 });
      check(true, `run4: the chosen file name is shown: ${tag}`);
      if (tag === 'desktop-light-en' || tag === 'phone-light-fr') await capture(page, watch, 'run4-import-dialog', tag);
      await tid(page, 'dialog-cancel').click();
      // (2) event form: the Ends radios
      await go(page, `#/events/new?date=2027-02-01&cal=${enc(calHref)}`);
      await page.getByTestId('event-form').waitFor({ timeout: 20000 });
      await tid(page, 'rec-freq').selectOption('WEEKLY');
      await tid(page, 'rec-end-count').check();
      await tid(page, 'rec-ends').scrollIntoViewIfNeeded();
      const ends = await page.evaluate(() => ['never', 'until', 'count'].map((k) => {
        const r = document.querySelector(`[data-testid="rec-end-${k}"]`).getBoundingClientRect();
        const lab = document.querySelector(`[data-testid="rec-end-${k}"]`).closest('label').getBoundingClientRect();
        return { x: Math.round(r.left), cy: Math.round(r.top + r.height / 2), labCy: Math.round(lab.top + lab.height / 2) };
      }));
      check(ends.every((e) => Math.abs(e.x - ends[0].x) <= 1) && ends.every((e) => Math.abs(e.cy - e.labCy) <= 3), `run4: the three "Ends" radios share one column and sit on their text line: ${tag}`, JSON.stringify(ends));
      if (tag === 'desktop-light-en' || tag === 'phone-light-fr') await capture(page, watch, 'run4-event-ends', tag);
      await tid(page, 'event-cancel').click();
      const dd = tid(page, 'dialog-discard');
      if (await dd.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await dd.click();
      // (3) task form: equal vertical gaps between stacked fields
      await go(page, `#/tasks/new?list=${enc(calHref)}`);
      await page.getByTestId('task-form').waitFor({ timeout: 20000 });
      const gaps = await page.evaluate(() => {
        const els = [...document.querySelectorAll('.tform [data-field]')].filter((e) => e.offsetParent && !e.parentElement.closest('[data-field]'));
        const g = [];
        for (let i = 1; i < els.length; i++) {
          const a = els[i - 1].getBoundingClientRect(), b = els[i].getBoundingClientRect();
          if (b.top >= a.bottom - 1 && Math.abs(a.left - b.left) < 2) { const d = Math.round((b.top - a.bottom) * 10) / 10; if (d < 100) g.push(d); } // a larger distance has non-field content between
        }
        return g;
      });
      const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 99;
      check(gaps.length >= 2 && spread <= 1.5, `run4: the task form rows are evenly spaced: ${tag}`, `gaps ${gaps.join(',')}`);
      await tid(page, 'task-cancel').click();
      // (4) users table: the login on one line
      await go(page, '#/users');
      await page.waitForSelector('[data-testid="account-link"]', { timeout: 20000 });
      const login = await page.evaluate(() => {
        const a = [...document.querySelectorAll('[data-testid="account-link"]')].find((x) => x.textContent.includes('agent-1'));
        if (!a) return null;
        const lh = parseFloat(getComputedStyle(a).lineHeight) || 20;
        return { h: a.getBoundingClientRect().height, lh, rects: a.getClientRects().length };
      });
      check(login && login.h < login.lh * 1.5 && login.rects === 1, `run4: the agent-1 login is on one line: ${tag}`, JSON.stringify(login));
      // (5) Settings About
      await go(page, '#/settings');
      await tid(page, 'settings-about').waitFor({ timeout: 20000 });
      if (tag === 'desktop-light-en' || tag === 'phone-light-fr') await capture(page, watch, 'run4-settings-about', tag);
    } finally {
      await ctx.close();
    }
  }
};
