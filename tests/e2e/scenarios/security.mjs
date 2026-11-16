// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `security`: what an attacker who controls card and collection data (a shared address book, an imported file, a
// hostile sync partner) can make the browser do. Hostile cards go in through DAV PUT; hostile collection names,
// descriptions and colours through MKCOL / MKCALENDAR / PROPPATCH. Pass = 0 dialogs, 0 CSP violations, 0 requests
// to other hosts (route interception, every one is aborted and counted), payloads shown literally, no javascript:
// links, photos not rendered unless valid. Hostile payloads point at documentation hosts only.
import {
  HOST, UI, api, assertClean, check, dav, davGet, davPut, go, info, makeBook, openPage, pageChecks, ready, shot, signIn, sleep, spec, tid, uniq,
} from '../lib/common.mjs';
import { BAD_BASE64_CARD, HOSTILE_BOOK, HOSTILE_CAL, OUTSIDE_HOST, bigPhotoCard, cardFile, cardText, cardUid, CARDS } from '../hostile/cards.mjs';
import { detailHash, editHash, enc, listHash, openBook } from '../lib/ui.mjs';

export const scenarios = {};
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Abort and count every request that leaves the stack's own host. */
async function guard(ctx) {
  const blocked = [];
  await ctx.route((url) => /^https?:$/.test(url.protocol) && url.host !== `${HOST}:${spec.port}`, (route) => { blocked.push(route.request().url()); return route.abort(); });
  return blocked;
}

/** Everything the page could have run or fetched because of a card: counted after the fact. */
const probe = (page) => page.evaluate(() => ({
  xss: window.__xss === undefined ? null : String(window.__xss),
  scripts: [...document.querySelectorAll('script')].filter((s) => !s.src).length,
  frames: document.querySelectorAll('iframe, object, embed').length,
  badLinks: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)),
  hrefs: [...document.querySelectorAll('[data-testid="contact-detail"] a[href]')].map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target'), text: a.textContent })),
  imgs: [...document.querySelectorAll('#main img')].map((i) => i.getAttribute('src') || ''),
  handlers: [...document.querySelectorAll('[onerror],[onload],[onclick],[onfocus]')].length,
  styleAttrs: [...document.querySelectorAll('[style]')].map((e) => e.getAttribute('style')),
}));

scenarios.cards = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  const blocked = await guard(ctx);
  try {
    const book = await makeBook('alice', uniq('sec'), 'Hostile cards', CARDS.map((c) => [cardFile(c), cardText(c)]));
    const refused = await davPut('alice', `${book}bad.vcf`, BAD_BASE64_CARD);
    check(refused.status === 400, 'a card whose PHOTO is not base64 at all is refused by the server (400), so it cannot reach the UI', String(refused.status));
    await signIn(page, 'alice');
    await openBook(page, book);
    const baseline = (await probe(page)).scripts;
    const names = await page.$$eval('[data-testid="contact-row"] .crow__name', (xs) => xs.map((x) => x.textContent.trim()));
    check(names.length === CARDS.length, `all ${CARDS.length} hostile cards are listed`, String(names.length));
    for (const c of CARDS) check(names.includes(c.fn), `the list shows "${c.key}" literally`, names.join(' | ').slice(0, 300));
    await shot(page, 'security-list-desktop-light-en');
    await pageChecks(page, watch, 'hostile list');
    for (const c of CARDS) {
      await go(page, detailHash(book, cardUid(c)));
      await page.getByTestId('contact-detail').waitFor();
      const shown = (await tid(page, 'contact-name').textContent()).trim();
      check(shown === c.fn, `${c.key}: the name is shown literally`, shown);
      const p = await probe(page);
      check(p.xss === null && p.scripts === baseline && p.frames === 0 && p.handlers === 0, `${c.key}: nothing ran and nothing was injected (window.__xss, scripts, frames, handlers)`, JSON.stringify({ xss: p.xss, scripts: p.scripts, frames: p.frames, h: p.handlers }));
      check(p.badLinks.length === 0, `${c.key}: no javascript:, data: or vbscript: link anywhere`, p.badLinks.join());
      check(p.imgs.every((s) => /^data:image\/(jpeg|png|webp|gif);base64,/.test(s) || s === ''), `${c.key}: every image is a data: image of an allowed type`, p.imgs.map((s) => s.slice(0, 40)).join());
      check(p.styleAttrs.every((s) => !/url\(|expression|@import/i.test(s)), `${c.key}: no style attribute carries a url() or an expression`, p.styleAttrs.join(' | '));
      if (c.key === 'note') {
        const note = tid(page, 'contact-note');
        const txt = await note.textContent();
        check(txt.includes('<img src=') && txt.includes('javascript:') && txt.includes('<iframe') && (await note.locator('*').count()) === 0, 'note: markup and the javascript: link are shown as text; the note has no child elements');
      }
      if (c.key === 'script-fn') {
        const org = (await tid(page, 'contact-org').textContent()) + (await tid(page, 'contact-nickname').textContent());
        check(org.includes('<b>Bold Org</b>') && org.includes('<svg/onload'), 'script-fn: organisation, title and nickname with tags are shown as text', org);
      }
      if (c.key === 'urls') {
        const web = p.hrefs.filter((h) => /^https?:/.test(h.href));
        check(web.length === 1 && web[0].href.startsWith('https://example.org/fine') && /noopener/.test(web[0].rel || '') && /noreferrer/.test(web[0].rel || '') && web[0].target === '_blank', 'urls: only the plain https address is a link, with rel="noopener noreferrer" and target=_blank', JSON.stringify(web));
        check(p.hrefs.filter((h) => !/^#/.test(h.href)).length === 1, 'urls: the other seven (javascript: twice, data:, vbscript:, credentials, ftp:, protocol-relative) are plain text', JSON.stringify(p.hrefs.map((h) => h.href)));
        check((await page.getByTestId('contact-url').count()) === 8, 'urls: all eight are still listed', String(await page.getByTestId('contact-url').count()));
      }
      if (c.key === 'contact-values') {
        const mail = p.hrefs.filter((h) => /^mailto:/.test(h.href));
        check(mail.length === 1 && mail[0].href === 'mailto:ok@example.org', 'e-mail: only a plain address becomes a mailto link (no ?, no &)', JSON.stringify(mail));
        const tel = p.hrefs.filter((h) => /^tel:/.test(h.href));
        check(tel.every((h) => /^tel:[+0-9]+$/.test(h.href)), 'phone: tel links hold digits and + only', JSON.stringify(tel.map((h) => h.href)));
        check(!p.hrefs.some((h) => /javascript/i.test(h.href)), 'phone: "javascript:alert(1)" is not a link');
      }
      if (/^photo-/.test(c.key)) {
        check((await page.getByTestId('contact-avatar').locator('img').count()) === 0, `${c.key}: no photo is rendered (the initials avatar is shown)`);
      }
      if (c.key === 'bidi') {
        const bidiOk = await page.evaluate(() => { const n = document.querySelector('[data-testid="contact-name"]'); return Boolean(n.querySelector('bdi')) || getComputedStyle(n).unicodeBidi.includes('isolate'); });
        check(bidiOk, 'bidi: the name is wrapped in <bdi> (isolated), so the controls cannot reorder the surrounding text');
        const noteBidi = await page.evaluate(() => { const n = document.querySelector('[data-testid="contact-note"]'); return n ? (n.getAttribute('dir') === 'auto' || getComputedStyle(n).unicodeBidi.includes('isolate') || Boolean(n.closest('[dir=auto]'))) : null; });
        info(`bidi: the note paragraph is isolated: ${noteBidi}`);
      }
      // the edit form: values are in the inputs as typed text
      await go(page, editHash(book, cardUid(c)));
      const form = await page.getByTestId('contact-form').waitFor({ timeout: 8000 }).then(() => true, () => false);
      if (form) {
        const fnv = await tid(page, 'field-fn').inputValue();
        check(fnv === c.fn || c.key.startsWith('photo'), `${c.key}: the edit form holds the name as plain text`, fnv);
        const p2 = await probe(page);
        check(p2.xss === null && p2.scripts === baseline && p2.badLinks.length === 0, `${c.key}: the edit form ran nothing`);
      }
      if (c.key === 'script-fn') await shot(page, 'security-detail-script-fn-desktop-light-en');
      await page.evaluate(() => { location.hash = '#/contacts'; });
      const d = page.getByTestId('dialog-discard');
      if (await d.waitFor({ state: 'visible', timeout: 600 }).then(() => true, () => false)) await d.click();
    }
    await go(page, detailHash(book, cardUid(CARDS.find((c) => c.key === 'urls'))));
    await shot(page, 'security-detail-urls-desktop-light-en');
    await go(page, detailHash(book, cardUid(CARDS.find((c) => c.key === 'bidi'))));
    await shot(page, 'security-detail-bidi-desktop-light-en');
    check(blocked.length === 0, 'not one request left the stack (the route interception aborted none)', blocked.join(' | '));
    check(watch.dialogs.length === 0, 'no alert, confirm or prompt dialog was raised', watch.dialogs.join(' | '));
    await assertClean(page, watch, 'hostile cards');
  } finally {
    await ctx.close();
  }
};

scenarios['export-hostile'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { acceptDownloads: true });
  const blocked = await guard(ctx);
  try {
    const c = CARDS.find((x) => x.key === 'script-fn');
    const book = await makeBook('alice', uniq('sec'), 'Hostile export', [[cardFile(c), cardText(c)]]);
    await signIn(page, 'alice');
    await go(page, detailHash(book, cardUid(c)));
    await page.getByTestId('contact-detail').waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download'), tid(page, 'btn-export-contact').click()]);
    const name = dl.suggestedFilename();
    check(/^[\w.-]+\.vcf$/.test(name) && !/[<>"'\\/:]/.test(name), 'the download file name is made safe (no markup or path characters)', name);
    check(blocked.length === 0 && watch.dialogs.length === 0, 'nothing left the stack and no dialog was raised');
    await assertClean(page, watch, 'export hostile');
  } finally {
    await ctx.close();
  }
};

scenarios['big-photo'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  const blocked = await guard(ctx);
  try {
    const book = await makeBook('alice', uniq('sec'), 'Big photo', [['big.vcf', bigPhotoCard()], ['small.vcf', cardText(CARDS[0])]]);
    check((await davGet('alice', `${book}big.vcf`)).buf.length > 5 * 1024 * 1024, 'setup: the server holds a card with a 5 MB photo');
    await signIn(page, 'alice');
    const t0 = Date.now();
    await openBook(page, book);
    const t = Date.now() - t0;
    check((await page.getByTestId('contact-row').count()) === 2, 'the list with the 5 MB card loads and shows both cards', `${t} ms`);
    await page.getByTestId('contact-row').filter({ hasText: 'Big Photo' }).click();
    await page.getByTestId('contact-detail').waitFor();
    check((await page.getByTestId('contact-avatar').locator('img').count()) === 0, 'the 5 MB photo is not rendered (initials instead)');
    const note = await page.getByTestId('photo-note').count() ? await tid(page, 'photo-note').textContent() : '';
    check(note.length > 0, 'a text note explains that the photo is not shown', note);
    const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1));
    info(`JS heap after opening the 5 MB card: ${heap} MB (${t} ms to the list)`);
    check(heap === -1 || heap < 150, 'the heap stays small', String(heap));
    await tid(page, 'btn-edit-contact').click();
    await page.getByTestId('contact-form').waitFor();
    check((await tid(page, 'photo-status').textContent()).length >= 0 && (await page.getByTestId('photo-block').locator('img').count()) === 0, 'the edit form does not render it either');
    check(blocked.length === 0, 'no request left the stack');
    await assertClean(page, watch, 'big photo');
  } finally {
    await ctx.close();
  }
};

scenarios.collections = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  const blocked = await guard(ctx);
  try {
    const slugB = uniq('hsb');
    const slugC = uniq('hsc');
    const mkb = `<?xml version="1.0"?><D:mkcol xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"><D:set><D:prop><D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype><D:displayname>${escXml(HOSTILE_BOOK.name)}</D:displayname><CR:addressbook-description>${escXml(HOSTILE_BOOK.desc)}</CR:addressbook-description></D:prop></D:set></D:mkcol>`;
    check((await dav('alice', 'MKCOL', `/alice/${slugB}/`, mkb, { 'Content-Type': 'application/xml' })).status === 201, 'setup: an address book with a hostile name and description');
    const mkc = `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/"><D:set><D:prop><D:displayname>${escXml(HOSTILE_CAL.name)}</D:displayname><C:calendar-description>${escXml(HOSTILE_CAL.desc)}</C:calendar-description><I:calendar-color>${escXml(HOSTILE_CAL.colour)}</I:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
    check((await dav('alice', 'MKCALENDAR', `/alice/${slugC}/`, mkc, { 'Content-Type': 'application/xml' })).status === 201, 'setup: a calendar with a hostile name, description and colour');
    await api('alice', 'PUT', 'grants', { owner: 'alice', collection: slugC, grantee: 'bob', level: 'read' });
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="collection-count"]')].every((e) => e.getAttribute('aria-busy') === 'false'), null, { timeout: 30000 });
    const rowB = page.locator(`[data-testid="collection-row"][data-href="/alice/${slugB}/"]`);
    const rowC = page.locator(`[data-testid="collection-row"][data-href="/alice/${slugC}/"]`);
    check((await rowB.getByTestId('collection-name').textContent()).trim() === HOSTILE_BOOK.name && (await rowB.getByTestId('collection-desc').textContent()) === HOSTILE_BOOK.desc, 'the address book name and description are shown literally');
    check((await rowC.getByTestId('collection-name').textContent()).trim() === HOSTILE_CAL.name && (await rowC.getByTestId('collection-desc').textContent()) === HOSTILE_CAL.desc, 'the calendar name and description are shown literally');
    const sw = await rowC.locator('.crow__swatch').evaluate((e) => ({ style: e.getAttribute('style'), cal: e.style.getPropertyValue('--cal'), bg: getComputedStyle(e).backgroundImage }));
    check(!/url\(|attacker/i.test(sw.style || '') && sw.cal === '' && sw.bg === 'none', 'the hostile colour "red;background:url(...)" is not applied: no --cal, no style with a url(), no background image', JSON.stringify(sw));
    let p = await probe(page);
    check(p.xss === null && p.scripts === (await probe(page)).scripts && p.frames === 0 && p.handlers === 0 && p.badLinks.length === 0, 'nothing ran: window.__xss is unset, no injected script, frame, handler or javascript: link');
    check((await page.locator('[data-testid="collection-desc"] *').count()) === 0, 'descriptions have no child elements (they are text)');
    await shot(page, 'security-collections-desktop-light-en');
    await pageChecks(page, watch, 'hostile collections');
    // the edit form and the delete dialog with the typed name
    await rowC.getByTestId('btn-edit-collection').click();
    await page.getByTestId('calendar-form').waitFor();
    check(await tid(page, 'field-coll-name').inputValue() === HOSTILE_CAL.name && await tid(page, 'field-coll-desc').inputValue() === HOSTILE_CAL.desc, 'the edit form holds the hostile name and description as plain text');
    check(await tid(page, 'field-color-custom').inputValue() === '' && (await page.locator('[data-testid^="colour-"]:checked').count()) === 0, 'the hostile colour is not offered as an editable value');
    await shot(page, 'security-collection-edit-desktop-light-en');
    await tid(page, 'collection-cancel').click();
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await rowB.getByTestId('btn-delete-collection').click();
    await tid(page, 'dialog-delete-collection').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="delete-count"]')?.dataset.count !== '', null, { timeout: 15000 });
    const dlgText = await tid(page, 'dialog-delete-collection').textContent();
    check(dlgText.includes(HOSTILE_BOOK.name), 'the delete dialog asks for the hostile name as text');
    await tid(page, 'field-confirm-name').fill(HOSTILE_BOOK.name);
    check(await tid(page, 'dialog-confirm-delete').isEnabled(), 'typing it exactly enables Delete');
    await shot(page, 'security-collection-delete-dialog-desktop-light-en');
    p = await probe(page);
    check(p.xss === null && p.frames === 0, 'nothing ran in the dialog');
    await tid(page, 'dialog-cancel').click();
    await tid(page, 'dialog-delete-collection').waitFor({ state: 'detached' });
    // the book selector of the contacts screen and the contacts list of the hostile book
    await go(page, listHash(`/alice/${slugB}/`));
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    const opts = await page.$$eval('[data-testid="contacts-book"] option', (os) => os.map((o) => o.textContent));
    check(opts.includes(HOSTILE_BOOK.name), 'the book selector lists the hostile name as an option text');
    p = await probe(page);
    check(p.xss === null && p.frames === 0 && p.badLinks.length === 0, 'the contacts screen of the hostile book ran nothing');
    // bob sees the hostile calendar through a grant
    check(blocked.length === 0, 'not one request left the stack', blocked.join(' | '));
    check(watch.dialogs.length === 0, 'no dialog was raised', watch.dialogs.join(' | '));
    await assertClean(page, watch, 'hostile collections');
  } finally {
    await ctx.close();
  }
  // a grantee sees the same hostile names in the "Shared with you" list
  const b = await openPage(browser);
  const blocked2 = await guard(b.ctx);
  try {
    await signIn(b.page, 'bob', '#/collections');
    await b.page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const names = await b.page.$$eval('[data-testid="collection-list-shared"] [data-testid="collection-name"]', (xs) => xs.map((x) => x.textContent.trim()));
    check(names.includes(HOSTILE_CAL.name), 'a grantee sees the hostile calendar name literally in the shared list', names.join(' | '));
    const p = await probe(b.page);
    check(p.xss === null && p.frames === 0 && blocked2.length === 0 && b.watch.dialogs.length === 0, 'nothing ran for the grantee either');
    await assertClean(b.page, b.watch, 'hostile collections as grantee');
  } finally {
    await b.ctx.close();
  }
};

scenarios['hash-injection'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  const blocked = await guard(ctx);
  try {
    await signIn(page, 'alice');
    const evil = [
      '#/contacts/%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%3D1%3E',
      '#/contacts/%3Cscript%3Ewindow.__xss%3D1%3C%2Fscript%3E/edit',
      `#/contacts?ab=${enc("<script>window.__xss=1</script>")}`,
      `#/contacts?ab=${enc('/alice/contacts/')}&q=${enc('<img src=x onerror=window.__xss=1>')}&group=${enc('"><svg/onload=window.__xss=1>')}&from=${enc('<b>')}`,
      `#/contacts/groups/${enc("'><img src=x onerror=window.__xss=1>")}`,
      `#/collections?dialog=delete&href=${enc('javascript:window.__xss=1')}`,
      `#/collections/edit?href=${enc('//attacker.example.net/x')}`,
      `#/collections?dialog=%3Cimg%3E&href=${enc('/alice/contacts/')}`,
      `#/login?next=${enc('javascript:window.__xss=1')}`,
      '#/debug?items=%3Cscript%3E',
    ];
    for (const hash of evil) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await sleep(900);
      const p = await probe(page);
      check(p.xss === null && p.frames === 0 && p.handlers === 0 && p.badLinks.length === 0 , `a hostile hash runs nothing: ${hash.slice(0, 70)}`, JSON.stringify({ xss: p.xss, frames: p.frames }));
      check(await page.evaluate(() => document.querySelectorAll('#main img[onerror], #main script').length) === 0, `no element of the hostile text was created: ${hash.slice(0, 50)}`);
    }
    check(blocked.length === 0 && watch.dialogs.length === 0, 'no request left the stack and no dialog was raised', blocked.join(' | '));
    await sleep(500);
    watch.errors.length = 0; // a hostile href is looked up and not found: the browser logs nothing else
    await assertClean(page, watch, 'hash injection');
  } finally {
    await ctx.close();
  }
};
