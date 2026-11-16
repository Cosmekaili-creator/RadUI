// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `calendar` (Run 3, slice 3b): the calendar screens, the event detail, the event form, recurrence and its
// scopes, time zones, birthdays, move, conflict, the Settings calendar section, a hostile-content check and a phone
// smoke test, against the real stack. The browser runs in Europe/Paris with a 24-hour clock and Monday first (set
// through the per-login preferences before the page loads); fixed dates in November 2026 and in 2027, never "today",
// except where a test says so.
//
// Seed (tests/e2e/run.py): alice has the calendars "Work" (/alice/e2e-work/: a weekly series in Europe/Paris with an
// override and an EXDATE, a flight Paris -> New York with two TZIDs, an event in a zone nobody knows, a three-day
// all-day event, a floating event, 30 single events in November 2026) and "Home" (a dentist, a yearly all-day event
// that duplicates a birthday), the book "Birthdays book" with three birthdays; agent-1 may only read Home; carol has no
// space. Scenarios that change data make their own calendar through DAV (random name) and look only at their own
// events in 2027, so no scenario depends on another and any one can be run alone.
import {
  assertClean, check, dav, davGet, davPut, en, fr, go, lineDiff, listItems, openPage, overflow, pageChecks, ready, shot,
  shotViewport, signIn, sleep, spec, tid, uniq, unfold,
} from '../lib/common.mjs';
import { dataRequests } from '../lib/session.mjs';

export const scenarios = {};

const WORK = spec.cal.work;
const HOME = spec.cal.home;
const enc = encodeURIComponent;
const CHIP = '[data-testid="event-chip"]';

// ------------------------------------------------------------------------------------------------ hashes
const calHash = (view, date, extra = '') => `#/calendar/${view}/${date}${extra}`;
const detailHash = (uid, cal, occ = 'single') => `#/events/${enc(uid)}?cal=${enc(cal)}&occ=${enc(occ)}`;
const editHash = (uid, cal, extra = '') => `#/events/${enc(uid)}/edit?cal=${enc(cal)}${extra}`;
const newHash = (query = '') => `#/events/new${query ? '?' + query : ''}`;

// ------------------------------------------------------------------------------------------------ data
const MKCAL = (name) => `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/"><D:set><D:prop><D:displayname>${name}</D:displayname><I:calendar-color>#4466aa</I:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
const PARIS = ['BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
const vevent = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const calText = (events, tz = PARIS) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RadUI e2e//EN', ...tz, ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';

/** One zoned event; `start`/`end` are `YYYYMMDDTHHMMSS` in Europe/Paris. */
const eventText = ({ uid, summary, start, end, extra = [] }) => calText([vevent([`UID:${uid}`, 'DTSTAMP:20260101T000000Z', `DTSTART;TZID=Europe/Paris:${start}`, `DTEND;TZID=Europe/Paris:${end}`, `SUMMARY:${summary}`, ...extra])]);
/** A series in Europe/Paris with optional EXDATEs and overrides ({rid, start, end, summary}). */
function seriesText({ uid, summary, start = '20270104T090000', end = '20270104T100000', rrule = 'FREQ=WEEKLY;COUNT=8;BYDAY=MO', exdates = [], overrides = [] }) {
  const evs = [vevent([`UID:${uid}`, 'DTSTAMP:20260101T000000Z', `DTSTART;TZID=Europe/Paris:${start}`, `DTEND;TZID=Europe/Paris:${end}`, `RRULE:${rrule}`, ...exdates.map((x) => `EXDATE;TZID=Europe/Paris:${x}`), `SUMMARY:${summary}`])];
  for (const o of overrides) evs.push(vevent([`UID:${uid}`, 'DTSTAMP:20260101T000000Z', `RECURRENCE-ID;TZID=Europe/Paris:${o.rid}`, `DTSTART;TZID=Europe/Paris:${o.start}`, `DTEND;TZID=Europe/Paris:${o.end}`, `SUMMARY:${o.summary}`, 'SEQUENCE:1']));
  return calText(evs);
}

/** A calendar of its own for one scenario (random name). */
async function mkcal(prefix, display) {
  const slug = uniq(prefix).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const href = `/alice/${slug}/`;
  const r = await dav('alice', 'MKCALENDAR', href, MKCAL(display), { 'Content-Type': 'application/xml' });
  if (r.status !== 201) throw new Error(`MKCALENDAR ${href}: ${r.status} ${r.text.slice(0, 100)}`);
  return { href, name: display };
}
async function put(cal, uid, text) {
  const r = await davPut('alice', `${cal.href}${uid}.ics`, text, 'text/calendar');
  if (r.status !== 201) throw new Error(`PUT ${uid}: ${r.status} ${r.text.slice(0, 100)}`);
  return `${cal.href}${uid}.ics`;
}
const linesOfRes = async (href) => unfold((await davGet('alice', href)).text);
const count = (lines, re) => lines.filter((l) => re.test(l)).length;
const newOnes = async (cal, before) => {
  const seen = new Set(before.map((i) => i.href));
  return (await listItems('alice', cal.href)).filter((i) => !seen.has(i.href));
};
const todayParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// ------------------------------------------------------------------------------------------------ browser
/** A context in Europe/Paris, 24-hour clock, Monday first (preferences of the login, set before the page loads). */
async function open(browser, { user = 'alice', prefs = {}, zone = null, ...rest } = {}) {
  const o = await openPage(browser, { timezoneId: 'Europe/Paris', ...rest });
  const all = { 'cal.use24h': true, 'cal.firstWeekday': 1, ...prefs };
  await o.ctx.addInitScript(({ login, all, zone }) => {
    try {
      for (const [k, v] of Object.entries(all)) {
        const key = `radui.pref.${login}.${k}`;
        if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(v));
      }
      if (zone && localStorage.getItem(`radui.tz.display.${login}`) === null) localStorage.setItem(`radui.tz.display.${login}`, zone);
    } catch { /* no storage */ }
  }, { login: user, all, zone });
  await signIn(o.page, user);
  return o;
}
async function calReady(page, timeout = 30000) {
  await page.waitForSelector('[data-testid="calendar-screen"][data-state="ready"]', { timeout });
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid="calendar-screen"]');
    return s && s.dataset.sync === 'idle' && [...document.querySelectorAll('[data-testid="calendar-loading"]')].every((e) => e.hidden);
  }, null, { timeout });
}
/** Open a calendar period and wait until the loaded calendars are drawn. */
async function openCal(page, view, date, extra = '') {
  await go(page, calHash(view, date, extra));
  await calReady(page);
}
const chipsOf = (page, scope = '') => page.$$eval(`${scope} ${CHIP}`.trim(), (ns) => ns.map((n) => ({ key: n.dataset.key, uid: n.dataset.uid, cal: n.dataset.calendar, occ: n.dataset.occurrence, ro: n.dataset.readonly, off: n.classList.contains('is-off'), name: n.getAttribute('aria-label') || '', time: (n.querySelector('.chip__time') || {}).textContent || '', title: (n.querySelector('.chip__title') || {}).textContent || '' })));
const liveKeys = async (page, scope = '') => [...new Set((await chipsOf(page, scope)).filter((c) => !c.off).map((c) => c.key))];
const statusOf = (page) => tid(page, 'cal-status').textContent().then((s) => s.trim());
const chipOf = (page, uid, occ = '') => page.locator(`${CHIP}[data-uid="${uid}"]${occ ? `[data-occurrence^="${occ}"]` : ''}`).first();
const toggleOf = (page, frag) => page.locator(`[data-testid="calendar-toggle"][data-href*="${frag}"]`);

/** Save the event form and wait until it left the form (detail) or report what the form says. */
async function saveEvent(page) {
  await tid(page, 'event-save').click();
  try {
    await page.waitForFunction(() => !/\/(new|edit)(\?|$)/.test(location.hash), null, { timeout: 30000 });
  } catch {
    const why = await page.evaluate(() => `errors: "${((document.querySelector('[data-testid="form-errors"]') || {}).innerText || '').trim()}" alert: "${((document.querySelector('[data-testid="alert-text"]') || {}).textContent || '').trim()}" status: "${((document.querySelector('[data-testid="status-text"]') || {}).textContent || '').trim()}"`);
    throw new Error('the event form did not close after Save: ' + why);
  }
  await ready(page);
}
/** Leave the form through Cancel, discarding when the shell asks. */
async function leaveForm(page) {
  await tid(page, 'event-cancel').click();
  const dlg = tid(page, 'dialog-discard-changes');
  if (await dlg.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await tid(page, 'dialog-discard').click();
  await ready(page);
}
async function openForm(page, hash) {
  await go(page, hash);
  await page.getByTestId('event-form').waitFor({ timeout: 20000 });
}
const fillDate = async (page, which, iso) => { const el = tid(page, `field-${which}-date-input`); await el.fill(iso); await el.press('Tab'); };
const fillTime = async (page, which, hhmm) => { const el = tid(page, `field-${which}-time-input`); await el.fill(hhmm); await el.press('Tab'); };
const noWrites = (log, mark = 0) => log.slice(mark).filter((l) => /^(PUT|DELETE|POST|PROPPATCH|MKCALENDAR|MKCOL|MOVE|COPY) /.test(l));

// ============================================================================================== views
scenarios.views = async (browser) => {
  const { ctx, page, watch } = await open(browser);
  try {
    await openCal(page, 'week', '2026-11-16');
    await page.waitForSelector(`${CHIP}[data-uid="e2e-bday-ada"]`, { timeout: 20000 });
    check(await tid(page, 'week-grid').isVisible() && (await tid(page, 'calendar-screen').getAttribute('data-view')) === 'week', 'the week view is drawn at #/calendar/week/<date>');
    const days = await page.$$eval('[data-testid="week-day"]', (ns) => ns.map((n) => n.dataset.date));
    check(days.join(',') === '2026-11-16,2026-11-17,2026-11-18,2026-11-19,2026-11-20,2026-11-21,2026-11-22', 'seven day columns, Monday first (preference)', days.join(','));
    check((await tid(page, 'time-scroller').evaluate((n) => n.scrollTop)) >= 300, 'a fresh week view opens at the working hours, not at midnight');
    check(/16.22 November/.test((await tid(page, 'period-heading').textContent()).replace(/\s+/g, ' ')), 'the period heading names the week', await tid(page, 'period-heading').textContent());
    const st = await statusOf(page);
    const m = /^Week of .+2026 · (\d+) events? in (\d+) calendars?$/.exec(st);
    const keys = await liveKeys(page);
    check(m && Number(m[1]) === keys.length, 'the persistent status line (role=status) counts the events drawn this week', `${st} / ${keys.length} chips`);
    check((await tid(page, 'cal-status').getAttribute('role')) === 'status', 'the status line is a status region');
    const flight = (await chipsOf(page, '')).find((c) => c.uid === 'e2e-flight');
    check(flight && /^Flight to the example city, .*10:00.18:30, Work/.test(flight.name), 'event chip accessible name: title, when (display zone), calendar', flight && flight.name);
    const moved = (await chipsOf(page, '')).find((c) => c.title === 'Weekly review (moved)');
    check(moved && /14:00.15:00, Work, Repeats/.test(moved.name) && moved.occ.startsWith('2026-11-16'), 'the moved occurrence of the series is drawn at its own time, named as repeating', moved && moved.name);
    // navigation by buttons
    await tid(page, 'cal-next').click();
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/week/2026-11-23'));
    await calReady(page);
    check((await page.locator(`${CHIP}[data-uid="e2e-weekly-review"]`).count()) === 0, 'the skipped date (EXDATE of 23 Nov) shows no occurrence of the series');
    check((await page.locator(`${CHIP}[data-uid="e2e-offsite"]`).count()) === 1, 'the three-day all-day event is one block spanning the week days');
    await tid(page, 'cal-prev').click();
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/week/2026-11-16'));
    await calReady(page);
    // month
    await tid(page, 'view-month').click();
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/month/2026-11-16'));
    await calReady(page);
    check(await tid(page, 'month-grid').isVisible(), 'view-month shows the month grid');
    const cell18 = page.locator('[data-testid="month-cell"][data-date="2026-11-18"]');
    check((await cell18.locator(`${CHIP}`).count()) === 4 && /^1 more/.test((await cell18.getByTestId('month-more').textContent()).trim()), 'a day with four events shows three chips and "1 more"', await cell18.getByTestId('month-more').textContent());
    for (const d of ['2026-11-24', '2026-11-25', '2026-11-26']) check((await page.locator(`[data-testid="month-cell"][data-date="${d}"] ${CHIP}[data-uid="e2e-offsite"]`).count()) === 1, `a multi-day event has a chip on each day: ${d}`);
    check((await page.locator(`[data-testid="month-cell"][data-date="2026-11-23"] ${CHIP}[data-uid="e2e-weekly-review"]`).count()) === 0 && (await page.locator(`[data-testid="month-cell"][data-date="2026-11-30"] ${CHIP}[data-uid="e2e-weekly-review"]`).count()) === 1, 'month: the series skips 23 Nov and continues on 30 Nov');
    await shot(page, 'calendar-month-desktop-light-en');
    await pageChecks(page, watch, 'month desktop');
    await cell18.getByTestId('month-more').click();
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/day/2026-11-18'));
    await calReady(page);
    check(await tid(page, 'day-grid').isVisible() && (await tid(page, 'week-day').count()) === 1, '"1 more" opens that day in the day view');
    // agenda
    await tid(page, 'view-agenda').click();
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/agenda/2026-11-18'));
    await calReady(page);
    const rows = await page.$$eval('[data-testid="event-row"]', (ns) => ns.map((n) => ({ uid: n.dataset.uid, name: n.getAttribute('aria-label'), ro: n.dataset.readonly })));
    check(rows.length >= 8 && rows.some((r) => r.uid === 'e2e-flight'), 'the agenda lists the next 30 days as event rows', `${rows.length} rows`);
    check((await statusOf(page)).includes('Nov'), 'the agenda status line names its period', await statusOf(page));
    await pageChecks(page, watch, 'agenda desktop');
    // jump to a date
    await tid(page, 'cal-jump-input').fill('2027-01-15');
    await tid(page, 'cal-jump-input').press('Enter');
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/agenda/2027-01-15'), null, { timeout: 15000 });
    check(true, 'the "go to date" field moves the period (hash updated)');
    // today
    await tid(page, 'cal-today').click();
    await page.waitForFunction((d) => location.hash.includes(d), todayParis(), { timeout: 15000 });
    check(true, 'Today goes to the current date in the display zone', todayParis());
    // search
    await openCal(page, 'week', '2026-11-16');
    await tid(page, 'cal-search').fill('flight');
    await page.waitForFunction(() => location.hash.includes('q=flight'), null, { timeout: 10000 });
    await page.waitForSelector('[data-testid="search-results"] [data-testid="event-row"]');
    const found = await page.$$eval('[data-testid="search-results"] [data-testid="event-row"]', (ns) => ns.map((n) => n.dataset.uid));
    check(found.length === 1 && found[0] === 'e2e-flight', 'search finds the event by a word of its title (results as an agenda list)', found.join(','));
    check(/“flight”/.test(await statusOf(page)), 'the status line says what was searched', await statusOf(page));
    await tid(page, 'cal-search').fill('zzzz-nothing');
    await tid(page, 'cal-no-match').waitFor({ state: 'visible', timeout: 10000 });
    check((await tid(page, 'cal-no-match').textContent()).trim() === en['cal.noMatch'], 'search without a result says so in text');
    await tid(page, 'cal-search').fill('');
    await page.waitForFunction(() => !location.hash.includes('q='), null, { timeout: 10000 });
    await tid(page, 'week-grid').waitFor();
    check(true, 'clearing the search returns to the grid');
    // bad routes
    await page.evaluate(() => { location.hash = '#/calendar/foo/bar'; });
    await page.waitForFunction(() => /^#\/calendar\/week\/\d{4}-\d\d-\d\d/.test(location.hash), null, { timeout: 10000 });
    check(true, 'an invalid view or date redirects to a week');
    await page.evaluate(() => { location.hash = '#/calendar'; });
    await page.waitForFunction(() => /^#\/calendar\/week\/\d{4}-\d\d-\d\d/.test(location.hash), null, { timeout: 10000 });
    check(true, '#/calendar redirects to the week of today');
    await assertClean(page, watch, 'views');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ toggles
scenarios.toggles = async (browser) => {
  const { ctx, page, watch } = await open(browser);
  try {
    await openCal(page, 'week', '2026-11-16');
    await page.waitForSelector(`${CHIP}[data-uid="e2e-dentist"]`);
    check((await tid(page, 'calendar-toggle').count()) >= 3, 'one toggle per calendar plus Birthdays', String(await tid(page, 'calendar-toggle').count()));
    const before = (await liveKeys(page)).length;
    await page.evaluate(() => {
      document.querySelector('[data-testid="week-grid"]').__mark = 'same-grid';
      document.querySelector('[data-testid="time-scroller"]').scrollTop = 300;
    });
    const work = toggleOf(page, 'e2e-work');
    await work.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="event-chip"][data-calendar="/alice/e2e-work/"]:not(.is-off)').length === 0);
    const after = await page.evaluate(() => ({ mark: document.querySelector('[data-testid="week-grid"]').__mark, top: document.querySelector('[data-testid="time-scroller"]').scrollTop, focus: (document.activeElement.dataset || {}).href || '', off: document.querySelectorAll('[data-testid="event-chip"].is-off').length }));
    check(after.mark === 'same-grid', 'switching a calendar off keeps the SAME grid element (no rebuild)');
    check(Math.abs(after.top - 300) <= 2, 'the scroll position is kept', String(after.top));
    check(/e2e-work/.test(after.focus), 'focus stays on the checkbox that was toggled (keyboard)', after.focus);
    check(after.off >= 10, 'its events are flagged is-off, not removed', `${after.off} is-off`);
    check(/Calendar Work hidden/.test((await tid(page, 'callist-live').textContent())), 'a polite live line says what happened', await tid(page, 'callist-live').textContent());
    const st = await statusOf(page);
    check(/in 4 calendars|in \d+ calendars/.test(st) && (await liveKeys(page)).length < before, 'the status line counts what is still shown', st);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="event-chip"][data-calendar="/alice/e2e-work/"].is-off').length === 0);
    check((await liveKeys(page)).length === before && (await page.evaluate(() => document.querySelector('[data-testid="week-grid"]').__mark)) === 'same-grid', 'switching it on again restores the events in the same grid');
    // the open detail survives toggles
    await go(page, calHash('week', '2026-11-16', `?ev=e2e-dentist&cal=${enc(HOME)}&occ=single`));
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    await page.evaluate(() => { document.querySelector('[data-testid="event-detail"]').__mark = 'same-detail'; });
    await toggleOf(page, 'e2e-work').click();
    await toggleOf(page, 'e2e-home').click();
    await sleep(500);
    check(await page.evaluate(() => (document.querySelector('[data-testid="event-detail"]') || {}).__mark) === 'same-detail' && (await tid(page, 'event-title').textContent()).trim() === 'Dentist', 'the open detail panel is untouched by toggles');
    await toggleOf(page, 'e2e-work').click();
    await toggleOf(page, 'e2e-home').click();
    // fold the list: open -> rail -> hidden -> open
    const fold = tid(page, 'btn-toggle-callist');
    const stateOf = () => tid(page, 'calendar-list').getAttribute('data-list-state');
    check((await stateOf()) === 'open' && (await fold.getAttribute('aria-expanded')) === 'true' && (await fold.getAttribute('aria-controls')) !== null, 'the list starts open; its button has aria-expanded and aria-controls');
    await fold.click();
    check((await stateOf()) === 'rail' && (await fold.getAttribute('aria-expanded')) === 'false', 'one press folds the list to colour dots');
    check(((await toggleOf(page, 'e2e-work').getAttribute('aria-label')) || '') === 'Work', 'in the folded list every toggle keeps its name');
    await page.reload();
    await calReady(page);
    check((await stateOf()) === 'rail', 'the fold state is remembered over a reload');
    await tid(page, 'btn-toggle-callist').click();
    check((await stateOf()) === 'hidden', 'a second press hides the list');
    await tid(page, 'btn-toggle-callist').click();
    check((await stateOf()) === 'open', 'a third press opens it again');
    // visible calendars are remembered, and a hidden calendar is not fetched
    await toggleOf(page, 'e2e-home').click();
    await page.reload();
    await calReady(page);
    check(!(await toggleOf(page, 'e2e-home').isChecked()), 'a switched-off calendar stays off after a reload');
    await assertClean(page, watch, 'toggles');
  } finally {
    await ctx.close();
  }
  // a calendar that is off at the start is not fetched until it is switched on
  const b = await open(browser, { prefs: { 'cal.hidden': [HOME] } });
  try {
    const log = dataRequests(b.page);
    await openCal(b.page, 'week', '2026-11-16');
    await sleep(800);
    check(!log.some((l) => l.includes(HOME)), 'a calendar that starts switched off is not requested', log.filter((l) => l.includes('e2e-home')).join(' | '));
    check((await b.page.locator(`${CHIP}[data-uid="e2e-dentist"]`).count()) === 0, 'and none of its events is drawn');
    await toggleOf(b.page, 'e2e-home').check();
    await b.page.waitForSelector(`${CHIP}[data-uid="e2e-dentist"]:not(.is-off)`, { timeout: 20000 });
    check(log.some((l) => l.includes(HOME)), 'switching it on fetches that calendar (only)');
    await assertClean(b.page, b.watch, 'lazy calendar');
  } finally {
    await b.ctx.close();
  }
};

// ========================================================================================= birthdays
scenarios.birthdays = async (browser) => {
  const { ctx, page, watch } = await open(browser);
  try {
    await openCal(page, 'week', '2026-11-16');
    await page.waitForSelector(`${CHIP}[data-uid="e2e-bday-ada"]`, { timeout: 20000 });
    const bd = toggleOf(page, 'birthdays');
    check(await bd.isChecked(), 'the Birthdays calendar is in the list and on');
    const all = await chipsOf(page);
    const ada = all.find((c) => c.uid === 'e2e-bday-ada');
    const bruno = all.find((c) => c.uid === 'e2e-bday-bruno');
    check(ada && ada.cal === 'birthdays' && /Ada Birchwood-Test – 41/.test(ada.title) && ada.ro === 'true' && /Read-only/.test(ada.name), 'a birthday with a year shows the age and is read-only', ada && ada.name);
    check(bruno && !/–/.test(bruno.title), 'a birthday without a year (--MM-DD) shows no age', bruno && bruno.title);
    const cleoVirtual = all.filter((c) => c.cal === 'birthdays' && /Cleo/.test(c.title));
    const cleoReal = all.filter((c) => c.cal !== 'birthdays' && /Cleo Birchwood birthday/.test(c.title));
    check(cleoVirtual.length === 0 && cleoReal.length === 1, 'a birthday that duplicates a yearly all-day event of a real calendar is hidden by default');
    await tid(page, 'bday-hide-duplicates').uncheck();
    await page.waitForSelector(`${CHIP}[data-uid="e2e-bday-cleo"]`, { timeout: 10000 });
    check(/shown/.test(await tid(page, 'callist-live').textContent()), 'unticking "hide duplicates" shows it and says so', await tid(page, 'callist-live').textContent());
    await tid(page, 'bday-hide-duplicates').check();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="event-chip"][data-uid="e2e-bday-cleo"]:not(.is-off)').length === 0);
    check(true, 'ticking it again hides the duplicate');
    // toggling the whole calendar
    await bd.uncheck();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="event-chip"][data-calendar="birthdays"]:not(.is-off)').length === 0);
    check(true, 'the Birthdays toggle flags every birthday off');
    await bd.check();
    await page.waitForSelector(`${CHIP}[data-uid="e2e-bday-ada"]:not(.is-off)`);
    // detail and link to the contact
    await chipOf(page, 'e2e-bday-ada').click();
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check((await tid(page, 'event-detail').getAttribute('data-virtual')) === 'true' && /Turns 41/.test(await tid(page, 'event-age').textContent()) && (await tid(page, 'btn-edit-event').count()) === 0, 'a birthday opens a small read-only detail with the age and no edit button');
    await tid(page, 'btn-open-contact').click();
    await page.waitForFunction(() => location.hash.startsWith('#/contacts/'), null, { timeout: 15000 });
    await tid(page, 'contact-detail').waitFor({ timeout: 20000 });
    check(/Ada Birchwood-Test/.test(await tid(page, 'contact-detail').innerText()), '"Open contact" leads to the contact');
    await assertClean(page, watch, 'birthdays');
  } finally {
    await ctx.close();
  }
};

// ======================================================================================= timezones
scenarios.timezones = async (browser) => {
  // a) the display zone: switching never writes, events move
  const a = await open(browser);
  try {
    const { page, watch } = a;
    const etags = async () => JSON.stringify([...(await listItems('alice', WORK)), ...(await listItems('alice', HOME))].sort((x, y) => (x.href < y.href ? -1 : 1)));
    const e0 = await etags();
    const log = dataRequests(page);
    await openCal(page, 'week', '2026-11-16');
    await page.waitForSelector(`${CHIP}[data-uid="e2e-flight"]`);
    check((await page.locator('.tgrid__zone').first().textContent()).trim() === 'Europe/Paris', 'the week grid names its display zone (the browser zone by default)');
    const t0 = (await chipsOf(page)).find((c) => c.uid === 'e2e-flight').time;
    check(t0 === '10:00', 'the flight starts at 10:00 Paris time in a Paris display', t0);
    const mark = log.length;
    await tid(page, 'tz-display').selectOption('__other');
    await tid(page, 'zone-picker').waitFor({ timeout: 10000 });
    await tid(page, 'field-zone-search').fill('kathmandu');
    await page.locator('[data-testid="zone-option"][data-id="Asia/Kathmandu"]').click();
    await tid(page, 'zone-picker').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.tgrid__zone').textContent.trim() === 'Asia/Kathmandu');
    const t1 = (await chipsOf(page)).find((c) => c.uid === 'e2e-flight').time;
    check(t1 === '14:45', 'the same event is drawn at 14:45 in Kathmandu (+5:45)', t1);
    check(/Asia\/Kathmandu/.test((await tid(page, 'status-text').textContent())), 'the shell status says the zone changed', await tid(page, 'status-text').textContent());
    check(noWrites(log, mark).length === 0, 'changing the display zone sends no write request', noWrites(log, mark).join(' | '));
    check((await etags()) === e0, 'every ETag on the server is unchanged after the change');
    check(await page.evaluate(() => localStorage.getItem('radui.tz.display.alice')) === 'Asia/Kathmandu', 'the choice is a per-login preference of the browser');
    const bdayDay = await page.locator(`${CHIP}[data-uid="e2e-bday-ada"]`).evaluate((n) => n.closest('[data-date]') ? n.closest('[data-date]').dataset.date : '');
    check(bdayDay === '' || bdayDay === '2026-11-18', 'all-day items are not shifted by the display zone', bdayDay);
    await assertClean(page, watch, 'display zone');
  } finally {
    await a.ctx.close();
  }
  // b) an event with two zones, in two display zones; the unknown zone (the delete test's calendar is made before the page loads its list)
  const delCal = await mkcal('tzdel', 'Zone delete');
  const delHref = await put(delCal, 'tz-gone', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RadUI e2e//EN', ...vevent(['UID:tz-gone', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Mars/Olympus_Mons:20270301T150000', 'DTEND;TZID=Mars/Olympus_Mons:20270301T160000', 'SUMMARY:Gone soon']), 'END:VCALENDAR'].join('\r\n') + '\r\n');
  const b = await open(browser);
  try {
    const { page, watch } = b;
    await go(page, detailHash('e2e-flight', WORK));
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check(/Europe\/Paris/.test(await tid(page, 'event-zone-start').textContent()) && /12:30 America\/New_York = 18:30/.test(await tid(page, 'event-zone-end').textContent()), 'an event in two zones shows its own end time and the time in the display zone', `${await tid(page, 'event-zone-start').textContent()} / ${await tid(page, 'event-zone-end').textContent()}`);
    await go(page, detailHash('e2e-unknown-zone', WORK));
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check(await tid(page, 'event-readonly').isVisible() && await tid(page, 'event-tz-warning').isVisible() && /Mars\/Olympus_Mons/.test(await tid(page, 'event-raw').textContent()), 'an unknown TZID is read-only: notice, warning and the raw text');
    check((await tid(page, 'btn-edit-event').count()) === 0 && (await tid(page, 'btn-move-event').count()) === 0 && (await tid(page, 'btn-delete-event').count()) === 1, 'edit and move are hidden for it, delete stays');
    await go(page, editHash('e2e-unknown-zone', WORK));
    await tid(page, 'event-readonly').waitFor({ timeout: 20000 });
    check((await tid(page, 'event-form').count()) === 0, 'the edit route shows the read-only box, not a form');
    await openCal(page, 'week', '2026-11-16');
    const chip = (await chipsOf(page)).find((c) => c.uid === 'e2e-unknown-zone');
    check(chip && chip.ro === 'true' && /time zone unknown$/.test(chip.name), 'the chip is marked read-only and its name ends with "time zone unknown"', chip && chip.name);
    // the unknown-zone event can be deleted (not rewritten)
    await go(page, detailHash('tz-gone', delCal.href));
    await tid(page, 'btn-delete-event').click();
    await tid(page, 'dialog-delete-event').waitFor();
    await tid(page, 'dialog-confirm-delete').click();
    await page.waitForFunction(() => !location.hash.startsWith('#/events/'), null, { timeout: 20000 });
    check((await dav('alice', 'GET', delHref)).status === 404, 'an event in an unknown zone can be deleted');
    await assertClean(page, watch, 'unknown zone', { expectHttp: ['404'] });
  } finally {
    await b.ctx.close();
  }
  // c) the detail seen from Kathmandu (screenshot)
  const c = await open(browser, { zone: 'Asia/Kathmandu' });
  try {
    await go(c.page, detailHash('e2e-flight', WORK));
    await tid(c.page, 'event-detail').waitFor({ timeout: 20000 });
    const s = await tid(c.page, 'event-zone-start').textContent();
    const e = await tid(c.page, 'event-zone-end').textContent();
    check(/10:00 Europe\/Paris = 14:45/.test(s) && /12:30 America\/New_York = 23:15/.test(e), 'seen from Kathmandu both ends carry their own time and the local one', `${s} / ${e}`);
    await shot(c.page, 'event-timezone-detail-desktop-light-en');
    await assertClean(c.page, c.watch, 'zone detail');
  } finally {
    await c.ctx.close();
  }
  // d) a time inside a daylight-saving gap is explained in text
  const d = await open(browser);
  try {
    const { page } = d;
    await openForm(page, newHash('date=2027-03-28'));
    await fillDate(page, 'start', '2027-03-28');
    await fillTime(page, 'start', '02:30');
    const pv = tid(page, 'event-when-preview');
    await page.waitForFunction(() => /does not exist/.test(document.querySelector('[data-testid="event-when-preview"]').textContent));
    const text = (await pv.textContent()).trim();
    check(/02:30 does not exist in Europe\/Paris on .*stored as 03:30/.test(text) && (await pv.getAttribute('data-gap')) === 'true', 'a time in the spring-forward gap is explained in the preview, as text', text);
    check((await pv.getAttribute('aria-live')) === 'polite', 'the preview is a polite live region');
    await leaveForm(page);
  } finally {
    await d.ctx.close();
  }
};

// ========================================================================================== create
scenarios.create = async (browser) => {
  const cal = await mkcal('create', 'Create test');
  const { ctx, page, watch } = await open(browser);
  try {
    await openCal(page, 'week', '2026-11-16');
    await tid(page, 'btn-new-event').click();
    await page.getByTestId('event-form').waitFor({ timeout: 20000 });
    check(/^#\/events\/new\?.*date=2026-11-16/.test(await page.evaluate(() => location.hash)), 'New event carries the date of the view in the URL');
    check(/11\/16\/2026|2026-11-16/.test(await tid(page, 'field-start-date-input').inputValue()) && (await tid(page, 'field-start-time-input').inputValue()) === '09:00', 'the form opens on that day at 09:00');
    // a validation error first (fill-in and error states)
    await tid(page, 'field-title').fill('E2E planning');
    await fillDate(page, 'start', '2027-03-03');
    await fillDate(page, 'end', '2027-03-01');
    await tid(page, 'field-calendar').selectOption({ label: cal.name });
    const before = await listItems('alice', cal.href);
    await tid(page, 'event-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible', timeout: 10000 });
    check(/end must be after the start/i.test(await tid(page, 'form-errors').innerText()) && (await tid(page, 'form-error-link').count()) >= 1 && /\/new/.test(await page.evaluate(() => location.hash)), 'an end before the start is refused with a message in text; the form stays', await tid(page, 'form-errors').innerText());
    check((await listItems('alice', cal.href)).length === before.length, 'nothing was written');
    await shotViewport(page, 'event-form-error-desktop-light-en');
    // fix and save a timed event
    await fillDate(page, 'start', '2027-03-02');
    await fillDate(page, 'end', '2027-03-02');
    await fillTime(page, 'start', '14:00');
    await fillTime(page, 'end', '15:30');
    await tid(page, 'field-location').fill('Room 12');
    const pv = (await tid(page, 'event-when-preview').textContent()).trim();
    check(/14:00/.test(pv) && /1 h 30/.test(pv), 'the preview line says when and for how long', pv);
    await saveEvent(page);
    await tid(page, 'event-detail').waitFor();
    const made = await newOnes(cal, before);
    check(made.length === 1, 'exactly one resource was created');
    const lines = await linesOfRes(made[0].href);
    check(lines.includes('SUMMARY:E2E planning') && lines.includes('DTSTART;TZID=Europe/Paris:20270302T140000') && lines.includes('DTEND;TZID=Europe/Paris:20270302T153000') && lines.includes('LOCATION:Room 12'), 'a timed event: title, zoned start and end, location', lines.join(' | '));
    check(lines.includes('BEGIN:VTIMEZONE') && lines.includes('TZID:Europe/Paris'), 'the stored event carries its VTIMEZONE (generated)', lines.join(' | '));
    check((await tid(page, 'event-title').textContent()).trim() === 'E2E planning' && /14:00.15:30/.test(await tid(page, 'event-when').textContent()), 'the detail shows the new event');
    // an all-day event
    const before2 = await listItems('alice', cal.href);
    await openForm(page, newHash(`date=2027-04-05&cal=${enc(cal.href)}`));
    await tid(page, 'field-title').fill('E2E offsite');
    await tid(page, 'field-allday').check();
    check(!(await tid(page, 'field-start-time-input').isVisible()) && !(await tid(page, 'field-tz-start').isVisible()), 'ticking "All day" hides the times and zones');
    await fillDate(page, 'end', '2027-04-07');
    check(/All day/.test(await tid(page, 'event-when-preview').textContent()), 'the preview says all day', await tid(page, 'event-when-preview').textContent());
    await saveEvent(page);
    const made2 = await newOnes(cal, before2);
    const l2 = made2.length ? await linesOfRes(made2[0].href) : [];
    check(made2.length === 1 && l2.includes('DTSTART;VALUE=DATE:20270405') && count(l2, /^DTEND;VALUE=DATE:2027040[78]$/) === 1 && count(l2, /^TZID:/) === 0, 'an all-day event is stored with dates, no zone, no VTIMEZONE', l2.join(' | '));
    // the new-event button of a day header
    await openCal(page, 'week', '2026-11-16');
    await page.locator('[data-testid="btn-new-event-at"][data-date="2026-11-20"]').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('event-form').waitFor();
    check(/11\/20\/2026|2026-11-20/.test(await tid(page, 'field-start-date-input').inputValue()), 'the "+" of a day header (keyboard) opens a new event on that day');
    await leaveForm(page);
    await assertClean(page, watch, 'create');
  } finally {
    await ctx.close();
  }
};

// ===================================================================================== edit, delete
scenarios['edit-delete'] = async (browser) => {
  const cal = await mkcal('edit', 'Edit test');
  const uid = uniq('edit1');
  const href = await put(cal, uid, eventText({ uid, summary: 'Original title', start: '20270510T100000', end: '20270510T110000', extra: ['LOCATION:Old room', 'DESCRIPTION:Keep me'] }));
  const { ctx, page, watch } = await open(browser);
  try {
    await go(page, detailHash(uid, cal.href));
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check((await tid(page, 'event-title').textContent()).trim() === 'Original title' && /Old room/.test(await tid(page, 'event-location').textContent()), 'the detail shows title and location');
    const base = await davGet('alice', href);
    await tid(page, 'btn-edit-event').click();
    await page.getByTestId('event-form').waitFor();
    check((await tid(page, 'field-title').inputValue()) === 'Original title' && (await tid(page, 'event-form').getAttribute('data-mode')) === 'edit', 'the edit form opens filled (a plain event asks no scope)');
    // saving without a change writes nothing
    await tid(page, 'event-save').click();
    await page.waitForFunction(() => /No changes/.test((document.querySelector('[data-testid="status-text"]') || {}).textContent || ''), null, { timeout: 10000 });
    check((await davGet('alice', href)).etag === base.etag, 'Save without a change says "No changes to save" and writes nothing');
    await tid(page, 'field-title').fill('Edited title');
    await tid(page, 'field-location').fill('New room');
    await saveEvent(page);
    const after = await davGet('alice', href);
    const diff = lineDiff(base.text, after.text);
    const owned = (l) => /^(SUMMARY|LOCATION|DTSTAMP|LAST-MODIFIED|SEQUENCE):/.test(l);
    check(unfold(after.text).includes('SUMMARY:Edited title') && unfold(after.text).includes('LOCATION:New room') && diff.removed.every(owned) && diff.added.every(owned), 'only the edited properties (and the stamps) changed on the server', JSON.stringify(diff));
    check(unfold(after.text).includes('DESCRIPTION:Keep me'), 'a property the form did not touch is kept');
    // delete: cancel first, then confirm
    await tid(page, 'btn-delete-event').click();
    await tid(page, 'dialog-delete-event').waitFor();
    await tid(page, 'dialog-cancel').click();
    check((await dav('alice', 'GET', href)).status === 200, 'cancelling the delete dialog keeps the event');
    await tid(page, 'btn-delete-event').click();
    await tid(page, 'dialog-confirm-delete').click();
    await page.waitForFunction(() => !location.hash.startsWith('#/events/'), null, { timeout: 20000 });
    check((await dav('alice', 'GET', href)).status === 404, 'confirming deletes the event on the server');
    await assertClean(page, watch, 'edit delete', { expectHttp: ['404'] });
  } finally {
    await ctx.close();
  }
};

// ========================================================================== recurring: create weekly
scenarios['recurring-create'] = async (browser) => {
  const cal = await mkcal('rec', 'Recurring test');
  const { ctx, page, watch } = await open(browser);
  try {
    const before = await listItems('alice', cal.href);
    await openForm(page, newHash(`date=2027-02-01&cal=${enc(cal.href)}`));
    await tid(page, 'field-title').fill('E2E weekly sync');
    await fillTime(page, 'start', '14:00');
    await fillTime(page, 'end', '15:00');
    await tid(page, 'field-tz-start').click();
    await tid(page, 'zone-picker').waitFor();
    await tid(page, 'field-zone-search').fill('new york');
    await page.locator('[data-testid="zone-option"][data-id="America/New_York"]').click();
    await tid(page, 'zone-picker').waitFor({ state: 'detached' });
    const pv = (await tid(page, 'event-when-preview').textContent()).trim();
    check(/America\/New[_ ]York/.test(pv) && /20:00 your time/.test(pv), 'an event in another zone: the preview shows both times (14:00 New York = 20:00 your time)', pv);
    check(/New.York/.test(await tid(page, 'field-tz-end').textContent()), 'the end zone follows the start zone until it is chosen');
    await tid(page, 'rec-freq').selectOption('WEEKLY');
    check(await tid(page, 'rec-day-mo').isChecked(), 'weekly repeats on the weekday of the start by default');
    await tid(page, 'rec-day-th').check();
    await tid(page, 'rec-end-count').check();
    await tid(page, 'rec-count').fill('4');
    const sum = (await tid(page, 'rec-summary').textContent()).trim();
    check(/Every week on Monday and Thursday.*4 occurrences/.test(sum), 'the recurrence builder states the rule in a sentence', sum);
    await tid(page, 'btn-add-alarm').click();
    await tid(page, 'field-alarm-1').selectOption('15m');
    await shot(page, 'event-form-recurrence-desktop-light-en');
    await saveEvent(page);
    await tid(page, 'event-detail').waitFor();
    const made = await newOnes(cal, before);
    const lines = made.length ? await linesOfRes(made[0].href) : [];
    check(made.length === 1 && lines.includes('DTSTART;TZID=America/New_York:20270201T140000') && lines.some((l) => /^RRULE:/.test(l) && /FREQ=WEEKLY/.test(l) && /COUNT=4/.test(l) && /BYDAY=MO,TH/.test(l)) && lines.some((l) => /^TRIGGER.*:-PT15M$/.test(l)) && lines.includes('TZID:America/New_York'), 'stored: New York start, weekly rule, 15 minute alarm, the zone definition', lines.join(' | '));
    check(/20:00/.test(await tid(page, 'event-zone-start').textContent()) && /Monday and Thursday/.test(await tid(page, 'event-recurrence').textContent()) && /15 minutes before/.test(await tid(page, 'event-alarms').textContent()), 'the detail shows the zones, the sentence and the reminder');
    const uid = lines.find((l) => l.startsWith('UID:')).slice(4);
    await openCal(page, 'week', '2027-02-01');
    const occ = (await chipsOf(page)).filter((c) => c.uid === uid);
    check(occ.length === 2, 'the week shows two occurrences (Monday and Thursday)', String(occ.length));
    await assertClean(page, watch, 'recurring create');
  } finally {
    await ctx.close();
  }
};

// =========================================================================== recurring: edit scopes
async function openOccurrence(page, cal, uid, weekDate, occPrefix) {
  await openCal(page, 'week', weekDate);
  await chipOf(page, uid, occPrefix).click();
  await tid(page, 'event-detail').waitFor({ timeout: 20000 });
}

scenarios['series-this-following'] = async (browser) => {
  const cal = await mkcal('ser1', 'Series one');
  const u1 = uniq('s1');
  const u2 = uniq('s2');
  const h1 = await put(cal, u1, seriesText({ uid: u1, summary: 'S1 base' }));
  const h2 = await put(cal, u2, seriesText({ uid: u2, summary: 'S2 base' }));
  const { ctx, page, watch } = await open(browser);
  try {
    // this occurrence
    await openOccurrence(page, cal, u1, '2027-01-18', '2027-01-18');
    await tid(page, 'btn-edit-event').click();
    await tid(page, 'dialog-scope-edit').waitFor();
    check((await tid(page, 'scope-this').count()) === 1 && (await tid(page, 'scope-following').count()) === 1 && (await tid(page, 'scope-all').count()) === 1 && (await tid(page, 'scope-cancel').count()) === 1, 'editing an occurrence of a series asks: this / this and following / all / cancel');
    await shotViewport(page, 'event-scope-dialog-desktop-light-en');
    await tid(page, 'scope-this').click();
    await page.getByTestId('event-form').waitFor();
    check((await tid(page, 'event-form').getAttribute('data-scope')) === 'this' && (await tid(page, 'recurrence-builder').count()) === 0 && /only the occurrence/.test(await tid(page, 'scope-notice').textContent()), 'scope "this": no recurrence builder, a notice names the occurrence');
    await tid(page, 'field-title').fill('S1 special');
    await saveEvent(page);
    const l1 = await linesOfRes(h1);
    check(count(l1, /^BEGIN:VEVENT$/) === 2 && l1.includes('RECURRENCE-ID;TZID=Europe/Paris:20270118T090000') && l1.includes('SUMMARY:S1 special') && l1.includes('SUMMARY:S1 base'), 'this: the master is untouched and an override with a RECURRENCE-ID was added', l1.join(' | '));
    await openCal(page, 'week', '2027-01-18');
    check((await chipsOf(page)).some((c) => c.uid === u1 && c.title === 'S1 special'), 'the changed occurrence is drawn with its new title');
    await openCal(page, 'week', '2027-01-25');
    check((await chipsOf(page)).some((c) => c.uid === u1 && c.title === 'S1 base'), 'the next occurrence keeps the old title');
    // this and following
    const before = await listItems('alice', cal.href);
    await openOccurrence(page, cal, u2, '2027-02-01', '2027-02-01');
    await tid(page, 'btn-edit-event').click();
    await tid(page, 'dialog-scope-edit').waitFor();
    await tid(page, 'scope-following').click();
    await page.getByTestId('event-form').waitFor();
    check((await tid(page, 'event-form').getAttribute('data-scope')) === 'following' && (await tid(page, 'recurrence-builder').count()) === 1, 'scope "following": the form shows the recurrence builder');
    await tid(page, 'field-title').fill('S2 tail');
    await saveEvent(page);
    const made = await newOnes(cal, before);
    check(made.length === 1, 'this and following: two resources afterwards (the original and a new tail)', `${made.length} new`);
    const orig = await linesOfRes(h2);
    const tail = made.length ? await linesOfRes(made[0].href) : [];
    check(orig.some((l) => /^RRULE:/.test(l) && /(COUNT=4|UNTIL=)/.test(l)) && orig.includes('SUMMARY:S2 base') && tail.includes('SUMMARY:S2 tail') && tail.includes('DTSTART;TZID=Europe/Paris:20270201T090000') && !tail.includes(`UID:${u2}`), 'the original now ends before 1 Feb; the tail starts on 1 Feb with the new title and its own UID (checked over DAV)', `ORIG ${orig.join(' | ')} || TAIL ${tail.join(' | ')}`);
    await openCal(page, 'week', '2027-01-25');
    check((await chipsOf(page)).some((c) => c.uid === u2 && c.title === 'S2 base'), 'the occurrence before the split is unchanged');
    await openCal(page, 'week', '2027-02-08');
    const w = await chipsOf(page);
    check(w.filter((c) => c.title === 'S2 tail').length === 1 && !w.some((c) => c.uid === u2), 'after the split the later weeks come from the tail only');
    await assertClean(page, watch, 'series this and following');
  } finally {
    await ctx.close();
  }
};

scenarios['series-all'] = async (browser) => {
  const cal = await mkcal('ser3', 'Series three');
  const u3 = uniq('s3');
  const h3 = await put(cal, u3, seriesText({ uid: u3, summary: 'S3 base', exdates: ['20270208T090000'], overrides: [{ rid: '20270118T090000', start: '20270118T140000', end: '20270118T150000', summary: 'S3 moved' }] }));
  const { ctx, page, watch } = await open(browser);
  try {
    await openOccurrence(page, cal, u3, '2027-01-25', '2027-01-25');
    await tid(page, 'btn-edit-event').click();
    await tid(page, 'dialog-scope-edit').waitFor();
    await tid(page, 'scope-all').click();
    await page.getByTestId('event-form').waitFor();
    check((await tid(page, 'exception-row').count()) === 2 && (await page.locator('[data-testid="exception-row"][data-type="exdate"] [data-testid="btn-restore-exception"]').count()) === 1, 'the form lists the skipped and the changed date (a skipped date can be restored)');
    await fillTime(page, 'start', '10:00');
    check(/^11:00$|^1[01]:00/.test(await tid(page, 'field-end-time-input').inputValue()), 'the end follows the start (same duration)', await tid(page, 'field-end-time-input').inputValue());
    await saveEvent(page);
    const lines = await linesOfRes(h3);
    check(lines.includes('DTSTART;TZID=Europe/Paris:20270104T100000') && lines.includes('EXDATE;TZID=Europe/Paris:20270208T100000') && lines.includes('RECURRENCE-ID;TZID=Europe/Paris:20270118T100000') && lines.includes('DTSTART;TZID=Europe/Paris:20270118T140000'), 'all with a new start time: the skipped date and the override date moved with it; the override keeps its own time (checked over DAV)', lines.join(' | '));
    await openCal(page, 'week', '2027-01-25');
    check((await chipsOf(page)).find((c) => c.uid === u3).time === '10:00', 'the later occurrences are drawn at 10:00');
    await openCal(page, 'week', '2027-02-08');
    check(!(await chipsOf(page)).some((c) => c.uid === u3), 'the skipped date is still skipped');
    await assertClean(page, watch, 'series all');
  } finally {
    await ctx.close();
  }
};

scenarios['series-delete'] = async (browser) => {
  const cal = await mkcal('ser4', 'Series four');
  const u = uniq('s4');
  const href = await put(cal, u, seriesText({ uid: u, summary: 'S4 base' }));
  const { ctx, page, watch } = await open(browser);
  try {
    const leftCalendar = () => page.waitForFunction(() => !location.hash.startsWith('#/events/'), null, { timeout: 20000 });
    // the first occurrence has no "following"; the delete dialog focuses Cancel
    await openOccurrence(page, cal, u, '2027-01-04', '2027-01-04');
    await tid(page, 'btn-delete-event').click();
    await tid(page, 'dialog-scope-delete').waitFor();
    check((await tid(page, 'scope-following').count()) === 0 && (await page.evaluate(() => document.activeElement.dataset.testid)) === 'scope-cancel', 'delete, first occurrence: no "this and following"; Cancel has the focus');
    await tid(page, 'scope-cancel').click();
    const e0 = (await davGet('alice', href)).etag;
    // this
    await openOccurrence(page, cal, u, '2027-02-01', '2027-02-01');
    await tid(page, 'btn-delete-event').click();
    await tid(page, 'dialog-scope-delete').waitFor();
    await tid(page, 'scope-this').click();
    await leftCalendar();
    const l1 = await linesOfRes(href);
    check((await davGet('alice', href)).etag !== e0 && l1.includes('EXDATE;TZID=Europe/Paris:20270201T090000'), 'delete this: the date is added as an EXDATE (one PUT)', l1.join(' | '));
    // this and following
    const n0 = (await listItems('alice', cal.href)).length;
    await openOccurrence(page, cal, u, '2027-02-15', '2027-02-15');
    await tid(page, 'btn-delete-event').click();
    await tid(page, 'dialog-scope-delete').waitFor();
    await tid(page, 'scope-following').click();
    await leftCalendar();
    const l2 = await linesOfRes(href);
    check(l2.some((l) => /^RRULE:/.test(l) && /(UNTIL=|COUNT=)/.test(l)) && (await listItems('alice', cal.href)).length === n0, 'delete this and following: the series is cut in place (no new resource)', l2.join(' | '));
    await openCal(page, 'week', '2027-02-15');
    check(!(await chipsOf(page)).some((c) => c.uid === u), 'nothing of the series is drawn from the cut on');
    await openCal(page, 'week', '2027-02-08');
    check((await chipsOf(page)).some((c) => c.uid === u), 'the week before the cut still shows it');
    // all
    await openOccurrence(page, cal, u, '2027-01-11', '2027-01-11');
    await tid(page, 'btn-delete-event').click();
    await tid(page, 'dialog-scope-delete').waitFor();
    await tid(page, 'scope-all').click();
    await tid(page, 'dialog-delete-event').waitFor();
    await tid(page, 'dialog-confirm-delete').click();
    await leftCalendar();
    check((await dav('alice', 'GET', href)).status === 404, 'delete all: the resource is deleted after one more confirmation');
    await assertClean(page, watch, 'series delete', { expectHttp: ['404'] });
  } finally {
    await ctx.close();
  }
};

scenarios['series-rule-dialog'] = async (browser) => {
  const cal = await mkcal('ser5', 'Series five');
  const u5 = uniq('s5');
  const u6 = uniq('s6');
  const h5 = await put(cal, u5, seriesText({ uid: u5, summary: 'S5 base', exdates: ['20270208T090000'] }));
  const h6 = await put(cal, u6, seriesText({ uid: u6, summary: 'S6 base', exdates: ['20270208T090000'] }));
  const { ctx, page, watch } = await open(browser);
  try {
    // a rule change that orphans a skipped date: the dialog lists it, Cancel has the focus
    await openOccurrence(page, cal, u5, '2027-01-25', '2027-01-25');
    await tid(page, 'btn-edit-event').click();
    await tid(page, 'dialog-scope-edit').waitFor();
    await tid(page, 'scope-all').click();
    await page.getByTestId('event-form').waitFor();
    await tid(page, 'rec-day-tu').check();
    await tid(page, 'rec-day-mo').uncheck();
    const e0 = (await davGet('alice', h5)).etag;
    await tid(page, 'event-save').click();
    await tid(page, 'dialog-rule-exceptions').waitFor({ timeout: 15000 });
    check(await tid(page, 'exceptions-orphans-note').isVisible() && (await tid(page, 'exception-item').count()) >= 1, 'a rule change that leaves a skipped date behind lists it ("will no longer be shown")');
    check((await page.evaluate(() => document.activeElement.dataset.testid)) === 'exceptions-cancel', 'with orphans the dialog does not default to Keep: Cancel has the focus');
    await tid(page, 'exceptions-cancel').click();
    await sleep(300);
    check((await davGet('alice', h5)).etag === e0 && (await tid(page, 'event-form').count()) === 1, 'Cancel writes nothing and keeps the form');
    await tid(page, 'event-save').click();
    await tid(page, 'dialog-rule-exceptions').waitFor({ timeout: 15000 });
    await tid(page, 'exceptions-remove').click();
    await page.waitForFunction(() => !/\/(new|edit)(\?|$)/.test(location.hash), null, { timeout: 30000 });
    const l5 = await linesOfRes(h5);
    check(l5.some((l) => /^RRULE:/.test(l) && /BYDAY=TU/.test(l)) && count(l5, /^EXDATE/) === 0, '"Remove" applies the new rule and drops the orphaned exception (checked over DAV)', l5.join(' | '));
    // a rule change that orphans nothing: Keep is the default
    await openOccurrence(page, cal, u6, '2027-01-25', '2027-01-25');
    await tid(page, 'btn-edit-event').click();
    await tid(page, 'dialog-scope-edit').waitFor();
    await tid(page, 'scope-all').click();
    await page.getByTestId('event-form').waitFor();
    await tid(page, 'rec-count').fill('6');
    await tid(page, 'event-save').click();
    await tid(page, 'dialog-rule-exceptions').waitFor({ timeout: 15000 });
    check((await page.evaluate(() => document.activeElement.dataset.testid)) === 'exceptions-keep' && (await tid(page, 'exceptions-orphans-note').count()) === 0, 'when nothing is orphaned "Keep them" is the default and focused');
    await tid(page, 'exceptions-keep').click();
    await page.waitForFunction(() => !/\/(new|edit)(\?|$)/.test(location.hash), null, { timeout: 30000 });
    const l6 = await linesOfRes(h6);
    check(l6.some((l) => /^RRULE:/.test(l) && /COUNT=6/.test(l)) && l6.includes('EXDATE;TZID=Europe/Paris:20270208T090000'), 'Keep: the new count is stored and the skipped date is kept');
    await assertClean(page, watch, 'series rule dialog');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================== move
scenarios.move = async (browser) => {
  const a = await mkcal('mva', 'Move from');
  const b = await mkcal('mvb', 'Move to');
  const uid = uniq('mv');
  const src = await put(a, uid, eventText({ uid, summary: 'Moving event', start: '20270601T100000', end: '20270601T110000', extra: ['LOCATION:Somewhere', 'ATTENDEE;CN=Pat Example:mailto:pat@example.org'] }));
  const original = (await davGet('alice', src)).text;
  const { ctx, page, watch } = await open(browser);
  try {
    await go(page, detailHash(uid, a.href));
    await tid(page, 'btn-move-event').waitFor({ timeout: 20000 });
    await tid(page, 'btn-move-event').click();
    await tid(page, 'dialog-move-event').waitFor();
    await tid(page, 'field-move-target').selectOption({ label: b.name });
    await tid(page, 'dialog-confirm-move').click();
    await page.waitForFunction(() => !location.hash.startsWith('#/events/'), null, { timeout: 20000 });
    check((await dav('alice', 'GET', src)).status === 404, 'move: the event is gone from the first calendar');
    const to = await dav('alice', 'GET', `${b.href}${uid}.ics`);
    const diff = lineDiff(original, to.text);
    check(to.status === 200 && diff.removed.length === 0 && diff.added.length === 0, 'move: the second calendar holds the exact same text (copied, not rewritten)', JSON.stringify(diff));
    await openCal(page, 'week', '2027-06-01');
    check((await chipsOf(page)).some((c) => c.uid === uid && c.cal === b.href), 'the event is drawn in its new calendar');
    await assertClean(page, watch, 'move', { expectHttp: ['404'] });
  } finally {
    await ctx.close();
  }
};

// ========================================================================================== conflict
scenarios.conflict = async (browser) => {
  const cal = await mkcal('cfl', 'Conflict test');
  const uid = uniq('cf');
  const href = await put(cal, uid, eventText({ uid, summary: 'Base title', start: '20270615T100000', end: '20270615T110000', extra: ['LOCATION:Base room'] }));
  const { ctx, page, watch } = await open(browser);
  try {
    await openForm(page, editHash(uid, cal.href));
    await tid(page, 'field-title').fill('Mine title');
    // somebody else changes the title and the location behind our back
    const cur = await davGet('alice', href);
    const next = cur.text.replace('SUMMARY:Base title', 'SUMMARY:Their title').replace('LOCATION:Base room', 'LOCATION:Their room');
    const r = await davPut('alice', href, next, 'text/calendar', { 'If-Match': cur.etag });
    if (r.status !== 204) throw new Error('outside edit failed: ' + r.status);
    await tid(page, 'event-save').click();
    await tid(page, 'dialog-conflict').waitFor({ timeout: 20000 });
    const rows = await page.$$eval('[data-testid="conflict-field-row"]', (rs) => rs.map((x) => ({ field: x.dataset.field, both: x.dataset.both, text: x.innerText.replace(/\s+/g, ' ') })));
    check(rows.some((x) => /title|summary/i.test(x.field) && x.both === 'true' && /Mine title/.test(x.text) && /Their title/.test(x.text)), 'an outside change while the form is open: the shared conflict dialog lists the title changed on both sides', JSON.stringify(rows));
    check((await page.evaluate(() => document.activeElement.dataset.testid)) === 'conflict-cancel' && (await tid(page, 'conflict-overwrite').count()) === 1, 'the dialog focuses Cancel and offers Overwrite');
    await shotViewport(page, 'event-conflict-desktop-light-en');
    await tid(page, 'conflict-overwrite').click();
    await tid(page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
    await page.waitForFunction(() => !/\/(new|edit)(\?|$)/.test(location.hash), null, { timeout: 20000 });
    const lines = await linesOfRes(href);
    check(lines.includes('SUMMARY:Mine title') && lines.includes('LOCATION:Their room'), 'Overwrite: my title wins, the location they changed is kept (merged on their version)', lines.join(' | '));
    await assertClean(page, watch, 'conflict', { expectHttp: ['412'] });
  } finally {
    await ctx.close();
  }
};

// ============================================================================ read-only and no space
scenarios['readonly-agent'] = async (browser) => {
  const a = await open(browser, { user: 'agent-1' });
  try {
    const { page, watch } = a;
    await openCal(page, 'week', '2026-11-16');
    await page.waitForSelector(`${CHIP}[data-uid="e2e-dentist"]`);
    check((await toggleOf(page, 'e2e-home').count()) === 1 && /Read-only/.test(await page.locator('[data-testid="calendar-list"] li', { has: toggleOf(page, 'e2e-home') }).innerText()), 'a read-only calendar is tagged "Read-only" in the list');
    check((await toggleOf(page, 'e2e-work').count()) === 0, 'a calendar nobody shared is not listed');
    const dentist = (await chipsOf(page)).find((c) => c.uid === 'e2e-dentist');
    check(dentist && dentist.ro === 'true', 'its events carry data-readonly="true"');
    await go(page, detailHash('e2e-dentist', HOME));
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check((await tid(page, 'btn-edit-event').count()) === 0 && (await tid(page, 'btn-delete-event').count()) === 0 && (await tid(page, 'btn-move-event').count()) === 0 && (await tid(page, 'btn-export-event').count()) === 1 && /read-only/.test(await tid(page, 'event-readonly').textContent()), 'a read grantee sees the detail with a read-only notice, export, and no edit, delete or move');
    await go(page, editHash('e2e-dentist', HOME));
    await tid(page, 'event-readonly').waitFor({ timeout: 20000 });
    check((await tid(page, 'event-form').count()) === 0, 'the edit route is refused in the page for a read grantee');
    await assertClean(page, watch, 'agent read-only');
  } finally {
    await a.ctx.close();
  }
  const c = await open(browser, { user: 'carol' });
  try {
    await go(c.page, calHash('week', '2026-11-16'));
    await tid(c.page, 'calendar-noaccess').waitFor({ timeout: 20000 });
    check((await tid(c.page, 'btn-new-calendar').count()) === 0 && !(await tid(c.page, 'week-grid').isVisible()), 'an account without space or shares gets the "no calendar shared" state, no create button');
    check(await tid(c.page, 'nav-calendar').isVisible(), 'the Calendar entry is in the navigation');
    await assertClean(c.page, c.watch, 'carol');
  } finally {
    await c.ctx.close();
  }
};

// ========================================================================================== settings
scenarios.settings = async (browser) => {
  const { ctx, page, watch } = await open(browser);
  try {
    await go(page, '#/settings');
    await tid(page, 'settings-calendar').waitFor({ timeout: 20000 });
    check((await tid(page, 'settings-first-weekday').inputValue()) === '1', 'the Settings calendar section shows the first weekday');
    await tid(page, 'settings-first-weekday').selectOption('7');
    check(/saved/i.test(await tid(page, 'settings-cal-status').textContent()), 'a change is confirmed in a status line', await tid(page, 'settings-cal-status').textContent());
    await tid(page, 'settings-24h').selectOption('12');
    await go(page, calHash('month', '2026-11-16'));
    await calReady(page);
    check((await page.locator('.month__dow').first().getAttribute('aria-label')) === 'Sunday', 'the first weekday applies without a reload (month starts on Sunday)');
    await go(page, calHash('week', '2026-11-16'));
    await calReady(page);
    const t12 = (await chipsOf(page)).find((c) => c.title === 'Single 17');
    check(t12 && /^\d{1,2}:\d{2}\s?(AM|PM)$/.test(t12.time.trim()), 'the 12-hour clock applies to the chips', t12 && t12.time);
    await go(page, '#/settings');
    await tid(page, 'settings-calendar').waitFor();
    await tid(page, 'settings-24h').selectOption('24');
    await tid(page, 'settings-first-weekday').selectOption('1');
    await tid(page, 'settings-birthdays').uncheck();
    await go(page, calHash('week', '2026-11-16'));
    await calReady(page);
    check((await toggleOf(page, 'birthdays').count()) === 0 && (await page.locator(`${CHIP}[data-calendar="birthdays"]`).count()) === 0, 'switching Birthdays off in Settings removes the virtual calendar');
    await go(page, '#/settings');
    await tid(page, 'settings-calendar').waitFor();
    await tid(page, 'settings-birthdays').check();
    await tid(page, 'settings-tz-display').click();
    await tid(page, 'zone-picker').waitFor();
    await tid(page, 'field-zone-search').fill('new york');
    await page.locator('[data-testid="zone-option"][data-id="America/New_York"]').click();
    await tid(page, 'zone-picker').waitFor({ state: 'detached' });
    await go(page, calHash('week', '2026-11-16'));
    await calReady(page);
    const ny = (await chipsOf(page)).find((c) => c.title === 'Single 17');
    check(ny && ny.time === '05:00', 'the display zone of Settings applies to the calendar (11:00 Paris = 05:00 New York)', ny && ny.time);
    await assertClean(page, watch, 'settings');
  } finally {
    await ctx.close();
  }
};

// ========================================================================================== hostile
scenarios.hostile = async (browser) => {
  const cal = await mkcal('evil', 'Hostile test');
  const uid = uniq('evil');
  const sum = '<img src=x onerror=alert(1)>';
  const loc = '<script>alert(2)</script>';
  await put(cal, uid, eventText({ uid, summary: sum, start: '20261121T100000', end: '20261121T110000', extra: [`LOCATION:${loc}`, 'URL:javascript:alert(3)', 'DESCRIPTION:<b>bold</b> text'] }));
  const { ctx, page, watch } = await open(browser);
  try {
    await openCal(page, 'week', '2026-11-16');
    const chip = chipOf(page, uid);
    await chip.waitFor();
    check((await chip.locator('.chip__title').textContent()) === sum && (await page.locator('img[src="x"]').count()) === 0, 'markup in a title is drawn literally in the grid; no image element exists');
    await openCal(page, 'agenda', '2026-11-16');
    check((await page.locator(`[data-testid="event-row"][data-uid="${uid}"] .arow__title`).first().textContent()).includes(sum), 'and literally in the agenda');
    await go(page, detailHash(uid, cal.href));
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check((await tid(page, 'event-title').textContent()).trim() === sum && (await tid(page, 'event-location').innerText()).includes(loc) && (await tid(page, 'event-description').innerText()).includes('<b>bold</b>'), 'title, location and description are shown literally in the detail');
    check((await tid(page, 'event-url').locator('a').count()) === 0 && (await tid(page, 'event-url').innerText()).includes('javascript:alert(3)'), 'a javascript: link is text, not a link');
    await openForm(page, editHash(uid, cal.href));
    check((await tid(page, 'field-title').inputValue()) === sum, 'the form holds the same text as a value');
    await leaveForm(page);
    await sleep(500);
    check(watch.dialogs.length === 0, 'no alert, confirm or prompt dialog was opened', watch.dialogs.join(' | '));
    await assertClean(page, watch, 'hostile event');
  } finally {
    await ctx.close();
  }
};

// ====================================================================================== operability
scenarios.operability = async (browser) => {
  const { ctx, page, watch } = await open(browser);
  try {
    await openCal(page, 'week', '2026-11-16');
    await page.waitForSelector(`${CHIP}[data-uid="e2e-bday-ada"]`);
    const attrs = await page.$$eval(CHIP, (ns) => ns.map((n) => ({ ok: ['uid', 'calendar', 'occurrence', 'key', 'readonly'].every((k) => (n.dataset[k] || '') !== '') && (n.dataset.calendar === 'birthdays' || (n.dataset.href || '') !== ''), name: n.getAttribute('aria-label') || '' })));
    check(attrs.length > 10 && attrs.every((a) => a.ok), 'every event node carries data-uid, -href, -calendar, -occurrence, -key and -readonly', `${attrs.length} chips`);
    check(attrs.every((a) => /^.+, .+, .+/.test(a.name)), 'every event node has an accessible name "Title, when, calendar"');
    // keyboard only
    await tid(page, 'view-month').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/month/2026-11-16'));
    await calReady(page);
    await page.locator('[data-testid="month-day"][data-date="2026-11-18"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/day/2026-11-18'));
    await calReady(page);
    await chipOf(page, 'e2e-flight').focus();
    await page.keyboard.press('Enter');
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check((await page.evaluate(() => document.activeElement.dataset.testid)) === 'event-title', 'keyboard: a view link, a day link and an event chip lead on; the detail focuses its title');
    await tid(page, 'btn-edit-event').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('event-form').waitFor();
    await pageChecks(page, watch, 'event form desktop');
    await leaveForm(page);
    // URLs are the state
    await go(page, calHash('month', '2026-11-16', '?q=flight'));
    await calReady(page);
    await page.reload();
    await calReady(page);
    check((await page.evaluate(() => location.hash)).includes('q=flight') && (await tid(page, 'cal-search').inputValue()) === 'flight', 'a reload restores view, date and search from the URL');
    await go(page, calHash('week', '2026-11-16'));
    await calReady(page);
    await pageChecks(page, watch, 'week desktop');
    await assertClean(page, watch, 'operability');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ phone
scenarios.phone = async (browser) => {
  const cal = await mkcal('mob', 'Phone test');
  const { ctx, page, watch } = await open(browser, { w: 390, h: 844 });
  try {
    await openCal(page, 'month', '2026-11-18');
    await page.waitForSelector('[data-testid="month-day-list"] [data-testid="event-row"]');
    check(await tid(page, 'month-grid').isVisible() && (await page.locator(`[data-testid="month-grid"] ${CHIP}`).count()) === 0, 'phone: the month is an overview of dots, not chips');
    const rows = await page.$$eval('[data-testid="month-day-list"] [data-testid="event-row"]', (ns) => ns.map((n) => n.dataset.uid));
    check(rows.includes('e2e-flight') && rows.includes('e2e-dentist'), 'phone: the selected day is listed underneath', rows.join(','));
    await page.locator('[data-testid="month-day"][data-date="2026-11-19"]').click();
    await page.waitForFunction(() => location.hash.startsWith('#/calendar/month/2026-11-19'));
    await page.waitForSelector('[data-testid="month-day-list"] [data-testid="event-row"][data-uid="e2e-unknown-zone"]');
    check(true, 'phone: tapping a day lists that day');
    await overflow(page, 'month phone');
    await shot(page, 'calendar-month-phone-light-en');
    await pageChecks(page, watch, 'month phone', { skip: ['contrast'] });
    await tid(page, 'cal-list-toggle').click();
    check((await tid(page, 'cal-list-toggle').getAttribute('aria-expanded')) === 'true' && await toggleOf(page, 'e2e-work').isVisible(), 'phone: the calendar list opens as a sheet');
    await tid(page, 'cal-list-toggle').click();
    await openCal(page, 'week', '2026-11-16');
    check((await tid(page, 'week-day').count()) === 3, 'phone: the week shows three days');
    await overflow(page, 'week phone');
    await go(page, detailHash('e2e-flight', WORK));
    await tid(page, 'event-detail').waitFor({ timeout: 20000 });
    check(await tid(page, 'btn-back').isVisible(), 'phone: the detail is a page with a back link');
    await overflow(page, 'detail phone');
    // the event form
    const before = await listItems('alice', cal.href);
    await openForm(page, newHash(`date=2026-11-18&cal=${enc(cal.href)}`));
    await tid(page, 'field-title').fill('Phone event');
    await fillTime(page, 'start', '16:00');
    await overflow(page, 'event form phone');
    await shot(page, 'event-form-phone-light-en');
    await pageChecks(page, watch, 'event form phone', { skip: ['contrast'] });
    await saveEvent(page);
    check((await newOnes(cal, before)).length === 1, 'phone: the form creates an event');
    await assertClean(page, watch, 'phone');
  } finally {
    await ctx.close();
  }
};

// ===================================================================================== French, dark
scenarios['french-dark'] = async (browser) => {
  const { ctx, page, watch } = await open(browser, { lang: 'fr', scheme: 'dark' });
  try {
    await openCal(page, 'week', '2026-11-16');
    await page.waitForSelector(`${CHIP}[data-uid="e2e-flight"]`);
    check(/novembre/.test(await tid(page, 'period-heading').textContent()) && (await tid(page, 'view-month').textContent()).trim() === fr['cal.view.month'], 'French: the heading and the views are in French', await tid(page, 'period-heading').textContent());
    check(/événements? dans/.test(await statusOf(page)), 'French: the status line', await statusOf(page));
    await shot(page, 'calendar-week-desktop-dark-fr');
    await pageChecks(page, watch, 'week desktop dark fr');
    await openForm(page, newHash('date=2026-11-18'));
    check((await page.locator('#ef-title').textContent()).trim() === fr['event.form.titleNew'], 'French: the form title', await page.locator('#ef-title').textContent());
    await tid(page, 'rec-freq').selectOption('WEEKLY');
    await shot(page, 'event-form-desktop-dark-fr');
    await leaveForm(page);
    await assertClean(page, watch, 'french dark');
  } finally {
    await ctx.close();
  }
};

