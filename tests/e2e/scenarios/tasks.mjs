// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `tasks` (Run 3, slice 3c): the merged task list with its filters, sort and list toggles, one-tap complete and
// reopen (checked over DAV), the repeating task that cannot be completed here, the task form (create with a due time and
// zone, errors, edit that keeps every other line, no-change save, discard guard, delete), the conflict dialog, a second
// client, sub-tasks, the empty / no-list / read-only states, a phone smoke test, the navigation entry, French and dark.
// The browser runs in Europe/Paris with a 24-hour clock; the seed's dates are relative to TODAY in that zone.
//
// Seed (tests/e2e/run.py, `seed_tasks`): alice has the task list "Tasks" (/alice/e2e-tasks/, nine tasks: overdue, due
// today, due later with a time and a zone, no date, done, a parent with two sub-tasks, a repeating one) and "Chores"
// (/alice/e2e-chores/, one task, readable by agent-1). bob has no task list, carol has no space. Scenarios that change
// data make their own task list through DAV (random name), so any scenario can be run alone; `list` goes first because it
// counts the seeded lists only.
import {
  assertClean, check, dav, davGet, davPut, en, fr, go, lineDiff, listItems, openPage, overflow, pageChecks, ready, shot,
  shotViewport, signIn, spec, tid, uniq, unfold,
} from '../lib/common.mjs';
import { dataRequests } from '../lib/session.mjs';

export const scenarios = {};

const SEED = spec.tasks;
const LIST = SEED.list;
const CHORES = SEED.chores;
const U = SEED.items; // short name -> uid
const enc = encodeURIComponent;
const ROW = '[data-testid="task-row"]';

// ------------------------------------------------------------------------------------------------ dates
const dayIso = (n) => {
  const d = new Date(`${SEED.today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const day8 = (n) => dayIso(n).replace(/-/g, '');

// ------------------------------------------------------------------------------------------------ hashes
const tasksHash = (q = '') => `#/tasks${q ? '?' + q : ''}`;
const taskHash = (uid, list) => `#/tasks/${enc(uid)}?list=${enc(list)}`;
const taskEditHash = (uid, list) => `#/tasks/${enc(uid)}/edit?list=${enc(list)}`;
const taskNewHash = (list) => `#/tasks/new?list=${enc(list)}`;

// ------------------------------------------------------------------------------------------------ data
const MKCAL = (name) => `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/"><D:set><D:prop><D:displayname>${name}</D:displayname><I:calendar-color>#4466aa</I:calendar-color><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
/** A VCALENDAR with one VTODO; `lines` are the properties after UID, DTSTAMP and SUMMARY. */
const todoText = (uid, summary, ...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RadUI e2e//EN', 'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', `SUMMARY:${summary}`, ...lines, 'END:VTODO', 'END:VCALENDAR'].join('\r\n') + '\r\n';

/** A task list of its own for one scenario (random name). */
async function mklist(prefix, display, user = 'alice') {
  const slug = uniq(prefix).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const href = `/${user}/${slug}/`;
  const r = await dav(user, 'MKCALENDAR', href, MKCAL(display), { 'Content-Type': 'application/xml' });
  if (r.status !== 201) throw new Error(`MKCALENDAR ${href}: ${r.status} ${r.text.slice(0, 100)}`);
  return { href, name: display };
}
async function put(list, uid, text, user = 'alice') {
  const r = await davPut(user, `${list.href}${uid}.ics`, text, 'text/calendar');
  if (r.status !== 201) throw new Error(`PUT ${uid}: ${r.status} ${r.text.slice(0, 100)}`);
  return `${list.href}${uid}.ics`;
}
const linesOfRes = async (href, user = 'alice') => unfold((await davGet(user, href)).text);
const has = (lines, re) => lines.some((l) => re.test(l));

// ------------------------------------------------------------------------------------------------ browser
/** A context in Europe/Paris with a 24-hour clock, signed in as `user`. */
async function open(browser, { user = 'alice', prefs = {}, ...rest } = {}) {
  const o = await openPage(browser, { timezoneId: 'Europe/Paris', ...rest });
  const all = { 'cal.use24h': true, 'cal.firstWeekday': 1, ...prefs };
  await o.ctx.addInitScript(({ login, all }) => {
    try {
      for (const [k, v] of Object.entries(all)) {
        const key = `radui.pref.${login}.${k}`;
        if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(v));
      }
    } catch { /* no storage */ }
  }, { login: user, all });
  await signIn(o.page, user);
  return o;
}
async function tasksReady(page, timeout = 30000) {
  await page.waitForSelector('[data-testid="tasks-screen"][data-state="ready"]', { timeout });
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid="tasks-screen"]');
    return s && s.dataset.sync === 'idle' && [...document.querySelectorAll('[data-testid="tasklist-loading"]')].every((e) => e.hidden);
  }, null, { timeout });
}
async function openTasks(page, query = '') {
  await go(page, tasksHash(query));
  await tasksReady(page);
}
const rowOf = (page, uid) => page.locator(`${ROW}[data-uid="${uid}"]`);
const rowUids = (page) => page.$$eval(ROW, (ns) => ns.map((n) => n.dataset.uid));
const rootUids = (page) => page.$$eval(ROW, (ns) => ns.filter((n) => n.dataset.depth === '0').map((n) => n.dataset.uid));
const statusOf = (page) => tid(page, 'tasks-status').textContent().then((s) => s.trim().replace(/\s+/g, ' '));
const toggleOf = (page, frag) => page.locator(`[data-testid="tasklist-toggle"][data-href*="${frag}"]`);
const noWrites = (log, mark = 0) => log.slice(mark).filter((l) => /^(PUT|DELETE|POST|PROPPATCH|MKCALENDAR|MKCOL|MOVE|COPY) /.test(l));
const fillDate = async (page, which, iso) => { const el = tid(page, `field-${which}-date-input`); await el.fill(iso); await el.press('Tab'); };
const fillTime = async (page, which, hhmm) => { const el = tid(page, `field-${which}-time-input`); await el.fill(hhmm); await el.press('Tab'); };

/** Save the task form and wait until it left the form, or say what the form shows. */
async function saveTask(page) {
  await tid(page, 'task-save').click();
  try {
    await page.waitForFunction(() => !/\/(new|edit)(\?|$)/.test(location.hash), null, { timeout: 30000 });
  } catch {
    const why = await page.evaluate(() => `errors: "${((document.querySelector('[data-testid="form-errors"]') || {}).innerText || '').trim()}" alert: "${((document.querySelector('[data-testid="alert-text"]') || {}).textContent || '').trim()}"`);
    throw new Error('the task form did not close after Save: ' + why);
  }
  await ready(page);
}
async function openForm(page, hash) {
  await go(page, hash);
  await page.getByTestId('task-form').waitFor({ timeout: 20000 });
}
async function pickZone(page, which, query, id) {
  await tid(page, `field-tz-${which}`).click();
  await tid(page, 'zone-picker').waitFor();
  await tid(page, 'field-zone-search').fill(query);
  await page.locator(`[data-testid="zone-option"][data-id="${id}"]`).click();
  await tid(page, 'zone-picker').waitFor({ state: 'detached' });
}

// ============================================================================================== list
scenarios.list = async (browser) => {
  const { ctx, page, watch } = await open(browser);
  try {
    await openTasks(page);
    await page.waitForSelector(`${ROW}[data-uid="${U.overdue}"]`, { timeout: 20000 });
    const st = await statusOf(page);
    check(/^9 open · 1 overdue · 2 task lists/.test(st), 'the persistent status line (role=status) counts open and overdue tasks and the lists', st);
    check((await tid(page, 'tasks-screen').getAttribute('data-filter')) === 'open' && (await tid(page, 'tasks-screen').getAttribute('data-sort')) === 'due', 'the screen starts on filter "open", sort "due" (data-filter, data-sort)');
    const counts = {};
    for (const f of ['open', 'today', 'overdue', 'done', 'all']) counts[f] = Number((await tid(page, `task-filter-${f}-count`).textContent()).trim());
    check(JSON.stringify(counts) === JSON.stringify({ open: 9, today: 1, overdue: 1, done: 1, all: 10 }), 'the filter counts: 9 open, 1 today, 1 overdue, 1 done, 10 all', JSON.stringify(counts));
    const order = await rowUids(page);
    const want = [U.overdue, U.today, U.repeat, U.soon, U.parent, U.child1, U.child2, U.nodue, U.recycling];
    check(JSON.stringify(order) === JSON.stringify(want), 'sort by due date: earliest first, a task without a date last, the sub-tasks right under their parent', order.join(','));
    const depth = await page.$$eval(ROW, (ns) => Object.fromEntries(ns.map((n) => [n.dataset.uid, n.dataset.depth])));
    check(depth[U.child1] === '1' && depth[U.child2] === '1' && depth[U.parent] === '0', 'the sub-tasks are nested one level (data-depth 1)', JSON.stringify(depth));
    check((await rowOf(page, U.done).count()) === 0, 'a done task is not in the open filter');
    // texts of a row
    const od = rowOf(page, U.overdue);
    const odDue = (await od.getByTestId('task-due').textContent()).trim();
    check(/^Overdue since /.test(odDue) && (await od.getByTestId('task-due').getAttribute('class')).includes('is-overdue'), 'an overdue task says "Overdue since …" and is marked overdue', odDue);
    check((await od.getByTestId('task-priority').first().textContent()).includes('High priority') && (await rowOf(page, U.soon).getByTestId('task-priority').first().textContent()).includes('Low priority') && (await rowOf(page, U.today).getByTestId('task-priority').first().textContent()).includes('Medium priority'), 'priority is a word as well as bars (high / medium / low)');
    check((await rowOf(page, U.today).getByTestId('task-due').textContent()).trim() === 'Due today', 'a task due today says "Due today"');
    const soonDue = (await rowOf(page, U.soon).getByTestId('task-due').textContent()).trim();
    check(/^Due .*17:00$/.test(soonDue), 'a task due later shows the date and the time (display zone, 24-hour clock)', soonDue);
    const name = await rowOf(page, U.overdue).getByTestId('task-open').getAttribute('aria-label');
    check(/^Pay the example invoice, Overdue since .+, High priority, Tasks$/.test(name), 'the accessible name of a row: title, due, priority, list', name);
    const attrs = await page.$$eval(ROW, (ns) => ns.map((n) => ['uid', 'href', 'list', 'status', 'readonly', 'key', 'depth'].every((k) => (n.dataset[k] || '') !== '')));
    check(attrs.length === 9 && attrs.every(Boolean), 'every task row carries data-uid, -href, -list, -status, -readonly, -key and -depth', `${attrs.length} rows`);
    // the repeating one
    const rep = rowOf(page, U.repeat);
    const tick = rep.getByTestId('task-complete');
    check(await tick.isDisabled() && (await tick.getAttribute('aria-label')).startsWith(en['tasks.completeRepeating'].split('{name}')[0]) && (await tick.getAttribute('data-block')) === 'repeating' && (await rep.getByTestId('task-repeats').count()) === 1, 'a repeating task: complete is disabled, its accessible name says why, the row says "Repeats"', await tick.getAttribute('aria-label'));
    await shot(page, 'tasks-list-desktop-light-en');
    await pageChecks(page, watch, 'tasks list desktop');
    // filters by URL
    for (const [f, uids] of [['overdue', [U.overdue]], ['today', [U.today]], ['done', [U.done]], ['all', 10]]) {
      await tid(page, `task-filter-${f}`).click();
      await page.waitForFunction((x) => location.hash.includes(`filter=${x}`), f);
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="task-row"]').length === n, Array.isArray(uids) ? uids.length : uids, { timeout: 10000 });
      const got = await rowUids(page);
      check(Array.isArray(uids) ? JSON.stringify(got) === JSON.stringify(uids) : got.length === uids, `filter "${f}" (a link, the URL is the state)`, got.join(','));
    }
    check((await tid(page, 'task-filter-all').getAttribute('aria-current')) === 'page' && (await tid(page, 'tasks-screen').getAttribute('data-filter')) === 'all', 'the current filter is aria-current and data-filter');
    check(/Showing 10 tasks \(All\)/.test(await statusOf(page)), 'the status line names the filter when it is not "open"', await statusOf(page));
    const doneTick = rowOf(page, U.done).getByTestId('task-complete');
    check((await doneTick.getAttribute('aria-pressed')) === 'true' && (await rowOf(page, U.done).getAttribute('data-status')) === 'COMPLETED', 'the done task is aria-pressed and data-status COMPLETED');
    // sort by priority (the select changes the URL)
    await go(page, tasksHash('filter=open'));
    await tasksReady(page);
    await tid(page, 'task-sort').selectOption('priority');
    await page.waitForFunction(() => location.hash.includes('sort=priority'));
    await page.waitForFunction((uid) => document.querySelector('[data-testid="task-row"]')?.dataset.uid === uid, U.overdue);
    const byPrio = await rowUids(page);
    check(JSON.stringify(byPrio) === JSON.stringify([U.overdue, U.parent, U.child1, U.child2, U.today, U.soon, U.repeat, U.nodue, U.recycling]), 'sort by priority: 1 first, a task without a priority last, ties by due date', byPrio.join(','));
    // list toggles
    await go(page, tasksHash());
    await tasksReady(page);
    check((await tid(page, 'tasklist-toggle').count()) === 2 && (await toggleOf(page, 'e2e-chores').isChecked()), 'one toggle per task list, both on');
    await toggleOf(page, 'e2e-chores').uncheck();
    await page.waitForFunction((uid) => !document.querySelector(`[data-testid="task-row"][data-uid="${uid}"]`), U.recycling);
    check(/^8 open · 1 overdue · 1 task list/.test(await statusOf(page)), 'switching a list off removes its tasks and the status line follows', await statusOf(page));
    await page.reload();
    await tasksReady(page);
    check(!(await toggleOf(page, 'e2e-chores').isChecked()) && (await rowOf(page, U.recycling).count()) === 0, 'the choice of lists is remembered after a reload (per login)');
    await toggleOf(page, 'e2e-chores').check();
    await page.waitForSelector(`${ROW}[data-uid="${U.recycling}"]`);
    // reload keeps filter and sort
    await go(page, tasksHash('filter=done&sort=priority'));
    await tasksReady(page);
    await page.reload();
    await tasksReady(page);
    check((await tid(page, 'tasks-screen').getAttribute('data-filter')) === 'done' && (await tid(page, 'task-sort').inputValue()) === 'priority', 'a reload restores filter and sort from the URL');
    await go(page, tasksHash('filter=bogus&sort=nope'));
    await tasksReady(page);
    check((await tid(page, 'tasks-screen').getAttribute('data-filter')) === 'open' && (await tid(page, 'tasks-screen').getAttribute('data-sort')) === 'due', 'an unknown filter or sort in the URL falls back to open / due');
    // detail
    await go(page, taskHash(U.soon, LIST));
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    const detail = (await tid(page, 'task-detail').innerText()).replace(/\s+/g, ' ');
    check(/Prepare the quarterly report/.test(detail) && /Europe\/Paris/.test(detail) && /Numbers for the example board/.test(detail) && /WORK/i.test(detail), 'the detail shows title, due with its own zone, description and category', detail.slice(0, 200));
    await go(page, taskHash(U.parent, LIST));
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    check((await tid(page, 'task-children').locator('a').count()) === 2, 'the parent lists its two sub-tasks as links');
    await go(page, taskHash(U.repeat, LIST));
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    check((await tid(page, 'task-recurrence').textContent()).trim().length > 5 && await tid(page, 'task-complete').isDisabled(), 'the repeating task shows its rule as a sentence and its complete button is disabled in the detail too', await tid(page, 'task-recurrence').textContent());
    await pageChecks(page, watch, 'task detail desktop');
    await assertClean(page, watch, 'tasks list');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ complete
scenarios.complete = async (browser) => {
  const list = await mklist('cpl', 'Complete test');
  const keep = ['X-E2E-KEEP:keep this line', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM'];
  const a = uniq('ca');
  const b = uniq('cb');
  const c = uniq('cc');
  const hrefA = await put(list, a, todoText(a, 'Simple task', `DUE;VALUE=DATE:${day8(3)}`, ...keep));
  await put(list, b, todoText(b, 'Repeating task', `DTSTART;VALUE=DATE:${day8(1)}`, `DUE;VALUE=DATE:${day8(2)}`, 'RRULE:FREQ=WEEKLY;COUNT=5'));
  const hrefC = await put(list, c, todoText(c, 'Done repeating task', 'STATUS:COMPLETED', 'PERCENT-COMPLETE:100', `COMPLETED:${day8(-1)}T100000Z`, `DTSTART;VALUE=DATE:${day8(-8)}`, `DUE;VALUE=DATE:${day8(-7)}`, 'RRULE:FREQ=WEEKLY;COUNT=5'));
  const { ctx, page, watch } = await open(browser);
  try {
    const log = dataRequests(page);
    await openTasks(page, 'filter=open');
    await page.waitForSelector(`${ROW}[data-uid="${a}"]`, { timeout: 20000 });
    const before = (await davGet('alice', hrefA)).text;
    const open0 = Number((await tid(page, 'task-filter-open-count').textContent()).trim());
    await rowOf(page, a).getByTestId('task-complete').click();
    await page.waitForFunction((uid) => !document.querySelector(`[data-testid="task-row"][data-uid="${uid}"]`), a, { timeout: 20000 });
    check(true, 'one tap on the tick completes the task: its row leaves the "open" filter');
    const after = (await davGet('alice', hrefA)).text;
    const d = lineDiff(before, after);
    const lines = unfold(after);
    check(has(lines, /^STATUS:COMPLETED$/) && has(lines, /^COMPLETED:\d{8}T\d{6}Z$/) && has(lines, /^PERCENT-COMPLETE:100$/), 'on the server: STATUS:COMPLETED, COMPLETED (UTC) and PERCENT-COMPLETE:100', d.added.join(' | '));
    check(has(lines, /^X-E2E-KEEP:keep this line$/) && has(lines, /^TRIGGER:-PT15M$/) && d.removed.every((l) => /^(DTSTAMP|LAST-MODIFIED|SEQUENCE|STATUS)/.test(l)), 'every other line is kept (an unknown property and the reminder)', `removed: ${d.removed.join(' | ')}`);
    check(/Task marked as done\./.test(await tid(page, 'status-text').textContent()), 'a persistent status text says "Task marked as done."', await tid(page, 'status-text').textContent());
    check(Number((await tid(page, 'task-filter-open-count').textContent()).trim()) === open0 - 1, 'the filter counts follow');
    // reopen from "done"
    await go(page, tasksHash('filter=done'));
    await tasksReady(page);
    const doneTick = rowOf(page, a).getByTestId('task-complete');
    check((await doneTick.getAttribute('aria-pressed')) === 'true', 'in the "done" filter the task is aria-pressed');
    await doneTick.click();
    await page.waitForFunction((uid) => !document.querySelector(`[data-testid="task-row"][data-uid="${uid}"]`), a, { timeout: 20000 });
    const re = await linesOfRes(hrefA);
    check(has(re, /^STATUS:NEEDS-ACTION$/) && !has(re, /^COMPLETED[:;]/) && !has(re, /^PERCENT-COMPLETE/), 'reopen: STATUS:NEEDS-ACTION, no COMPLETED, no PERCENT-COMPLETE', re.join(' | '));
    check(/Task marked as not done\./.test(await tid(page, 'status-text').textContent()), 'and says "Task marked as not done."');
    // the repeating tasks
    await openTasks(page, 'filter=all');
    await page.waitForSelector(`${ROW}[data-uid="${b}"]`);
    const bt = rowOf(page, b).getByTestId('task-complete');
    const mark = log.length;
    check(await bt.isDisabled() && (await bt.getAttribute('aria-disabled')) === 'true' && (await bt.getAttribute('aria-label')).startsWith('Repeating tasks can’t be completed here yet'), 'a repeating task: the tick is disabled and its accessible name is "Repeating tasks can’t be completed here yet: …"', await bt.getAttribute('aria-label'));
    await bt.click({ force: true, timeout: 3000 }).catch(() => {});
    check(noWrites(log, mark).length === 0, 'pressing the disabled tick sends nothing');
    const ct = rowOf(page, c).getByTestId('task-complete');
    check(!(await ct.isDisabled()) && (await ct.getAttribute('aria-pressed')) === 'true', 'a DONE repeating task can be reopened (its tick is enabled)');
    await ct.click();
    await page.waitForFunction((uid) => document.querySelector(`[data-testid="task-row"][data-uid="${uid}"]`)?.dataset.status === 'NEEDS-ACTION', c, { timeout: 20000 });
    const cl = await linesOfRes(hrefC);
    check(has(cl, /^STATUS:NEEDS-ACTION$/) && !has(cl, /^COMPLETED[:;]/) && has(cl, /^RRULE:FREQ=WEEKLY;COUNT=5$/), 'the reopened repeating task keeps its RRULE', cl.join(' | '));
    check((await rowOf(page, c).getByTestId('task-complete').isDisabled()), 'and is a normal repeating task again: complete is disabled');
    await assertClean(page, watch, 'complete and reopen');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ second client
scenarios['second-client'] = async (browser) => {
  const list = await mklist('scl', 'Second client');
  const u = uniq('sc');
  const href = await put(list, u, todoText(u, 'Base title', 'DESCRIPTION:Base text', `DUE;VALUE=DATE:${day8(4)}`));
  const { ctx, page, watch } = await open(browser);
  try {
    await openTasks(page);
    await page.waitForSelector(`${ROW}[data-uid="${u}"]`);
      const cur = await davGet('alice', href);
    const r = await davPut('alice', href, cur.text.replace('SUMMARY:Base title', 'SUMMARY:Their title'), 'text/calendar', { 'If-Match': cur.etag });
    if (r.status !== 204) throw new Error('outside edit failed: ' + r.status);
    await rowOf(page, u).getByTestId('task-complete').click();
    await tid(page, 'dialog-conflict').waitFor({ timeout: 20000 });
    const rows0 = await page.$$eval('[data-testid="conflict-field-row"]', (rs) => rs.map((x) => ({ field: x.dataset.field, both: x.dataset.both })));
    check(rows0.every((x) => x.both !== 'true') && (await tid(page, 'conflict-overwrite').isEnabled()), 'a stale tick meets a 412: the shared conflict dialog opens, no field is changed on both sides, Overwrite is offered', JSON.stringify(rows0));
    await tid(page, 'conflict-overwrite').click();
    await tid(page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
    await page.waitForFunction((x) => !document.querySelector(`[data-testid="task-row"][data-uid="${x}"]`) || document.querySelector(`[data-testid="task-row"][data-uid="${x}"]`).dataset.status === 'COMPLETED', u, { timeout: 20000 });
    const lines = await linesOfRes(href);
    check(has(lines, /^SUMMARY:Their title$/) && has(lines, /^STATUS:COMPLETED$/) && has(lines, /^COMPLETED:\d{8}T\d{6}Z$/), 'Overwrite replays "complete" on THEIR version: their new title and the completion are both on the server', lines.join(' | '));
    await assertClean(page, watch, 'second client complete', { expectHttp: ['412'] });
    // the edit form: same title changed on both sides -> the shared conflict dialog
    const u2 = uniq('sd');
    const href2 = await put(list, u2, todoText(u2, 'Base title', 'DESCRIPTION:Base text'));
    await openForm(page, taskEditHash(u2, list.href));
    await tid(page, 'field-summary').fill('Mine title');
    const cur2 = await davGet('alice', href2);
    const r2 = await davPut('alice', href2, cur2.text.replace('SUMMARY:Base title', 'SUMMARY:Their title').replace('DESCRIPTION:Base text', 'DESCRIPTION:Their text'), 'text/calendar', { 'If-Match': cur2.etag });
    if (r2.status !== 204) throw new Error('outside edit 2 failed: ' + r2.status);
    await tid(page, 'task-save').click();
    await tid(page, 'dialog-conflict').waitFor({ timeout: 20000 });
    const rows = await page.$$eval('[data-testid="conflict-field-row"]', (rs) => rs.map((x) => ({ field: x.dataset.field, both: x.dataset.both, text: x.innerText.replace(/\s+/g, ' ') })));
    check(rows.some((x) => /summary|title/i.test(x.field) && x.both === 'true' && /Mine title/.test(x.text) && /Their title/.test(x.text)), 'an outside change while the form is open: the shared conflict dialog lists the title changed on both sides', JSON.stringify(rows));
    await shotViewport(page, 'task-conflict-desktop-light-en');
    await tid(page, 'conflict-overwrite').click();
    await tid(page, 'dialog-conflict').waitFor({ state: 'detached', timeout: 20000 });
    await page.waitForFunction(() => !/\/(new|edit)(\?|$)/.test(location.hash), null, { timeout: 20000 });
    const l2 = await linesOfRes(href2);
    check(has(l2, /^SUMMARY:Mine title$/) && has(l2, /^DESCRIPTION:Their text$/), 'Overwrite: my title wins, the description they changed is kept (merged on their version)', l2.join(' | '));
    await assertClean(page, watch, 'task conflict', { expectHttp: ['412'] });
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ create, edit, delete
scenarios.crud = async (browser) => {
  const list = await mklist('crd', 'Crud test');
  const { ctx, page, watch } = await open(browser);
  try {
    const log = dataRequests(page);
    // ---- create with every field
    await openForm(page, taskNewHash(list.href));
    check((await tid(page, 'field-list').inputValue()) === list.href, 'the new-task form opens on the list it came from');
    check(!(await tid(page, 'field-tz-due').isVisible()), 'the due-zone control is hidden while there is no due time');
    await tid(page, 'field-summary').fill('Write the example report');
    await tid(page, 'field-priority').selectOption('1');
    await tid(page, 'field-status').selectOption('IN-PROCESS');
    await tid(page, 'field-percent').fill('40');
    await fillDate(page, 'due', dayIso(20));
    await fillTime(page, 'due', '17:30');
    check(await tid(page, 'field-tz-due').isVisible() && /Europe\/Paris/.test(await tid(page, 'field-tz-due').textContent()), 'once a time is typed, the zone control appears with the display zone', await tid(page, 'field-tz-due').textContent());
    await pickZone(page, 'due', 'new york', 'America/New_York');
    await tid(page, 'field-categories').fill('work');
    await tid(page, 'btn-add-category').click();
    await tid(page, 'field-description').fill('Numbers and charts for the example board.');
    await shot(page, 'task-form-desktop-light-en');
    await pageChecks(page, watch, 'task form desktop');
    const before = await listItems('alice', list.href);
    await saveTask(page);
    await tasksReady(page);
    const mine = (await listItems('alice', list.href)).filter((i) => !before.some((b) => b.href === i.href));
    check(mine.length === 1, 'Create adds exactly one task', String(mine.length));
    const text = mine.length ? await linesOfRes(mine[0].href) : [];
    check(has(text, /^SUMMARY:Write the example report$/) && has(text, /^PRIORITY:1$/) && has(text, /^STATUS:IN-PROCESS$/) && has(text, /^PERCENT-COMPLETE:40$/), 'on the server: summary, priority 1, status IN-PROCESS, 40 %', text.join(' | '));
    check(has(text, new RegExp(`^DUE;TZID=America/New_York:${day8(20)}T173000$`)) && has(text, /^BEGIN:VTIMEZONE$/) && has(text, /^TZID:America\/New_York$/), 'the due time is stored with its own zone (TZID) and the zone definition travels with it', text.filter((l) => /DUE|TZID/.test(l)).join(' | '));
    check(has(text, /^CATEGORIES:work$/) && has(text, /^DESCRIPTION:Numbers and charts for the example board\.$/), 'categories and description are stored');
    const uid = (text.find((l) => /^UID:/.test(l)) || '').slice(4);
    await page.waitForSelector(`${ROW}[data-uid="${uid}"]`);
    const rowDue = (await rowOf(page, uid).getByTestId('task-due').textContent()).trim();
    check(/^Due .*(23|11):30$/.test(rowDue) || /^Due .*:30$/.test(rowDue), 'the list shows the due time in the display zone (New York 17:30 is 23:30 in Paris)', rowDue);
    // ---- a date-only task
    await openForm(page, taskNewHash(list.href));
    await tid(page, 'field-summary').fill('A task with a date only');
    await fillDate(page, 'due', dayIso(21));
    check(!(await tid(page, 'field-tz-due').isVisible()), 'a due date without a time shows no zone control');
    const before2 = await listItems('alice', list.href);
    await saveTask(page);
    await tasksReady(page);
    const mine2 = (await listItems('alice', list.href)).filter((i) => !before2.some((b) => b.href === i.href));
    const t2 = mine2.length ? await linesOfRes(mine2[0].href) : [];
    check(has(t2, new RegExp(`^DUE;VALUE=DATE:${day8(21)}$`)) && !has(t2, /^PRIORITY/) && !has(t2, /^PERCENT/) && !has(t2, /^DESCRIPTION/) && has(t2, /^STATUS:NEEDS-ACTION$/), 'a date-only task stores DUE;VALUE=DATE, STATUS:NEEDS-ACTION and nothing it was not given (no PRIORITY, no PERCENT, no DESCRIPTION)', t2.join(' | '));
    // ---- errors
    await openForm(page, taskNewHash(list.href));
    const mark = log.length;
    await tid(page, 'task-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    check(/Enter a title\./.test(await tid(page, 'form-errors').textContent()) && (await tid(page, 'form-error-link').count()) >= 1 && (await tid(page, 'field-summary').getAttribute('aria-invalid')) === 'true' && (await page.evaluate(() => document.activeElement.dataset.testid)) === 'field-summary', 'an empty title: the error is named, linked, the field is aria-invalid and has the focus');
    await tid(page, 'field-summary').fill('Broken times');
    await fillTime(page, 'due', '10:00');
    await tid(page, 'task-save').click();
    check(/Enter a date for this time\./.test(await tid(page, 'form-errors').textContent()), 'a time without a date is refused with a plain message', await tid(page, 'form-errors').textContent());
    await fillDate(page, 'due', dayIso(5));
    await fillDate(page, 'start', dayIso(9));
    await fillTime(page, 'start', '09:00');
    await tid(page, 'task-save').click();
    check(/due date is before the start/i.test(await tid(page, 'form-errors').textContent()), 'a due date before the start is refused', await tid(page, 'form-errors').textContent());
    await tid(page, 'field-percent').fill('abc');
    await tid(page, 'task-save').click();
    check(/whole number from 0 to 100/.test(await tid(page, 'form-errors').textContent()), 'a percent that is not a number is refused', await tid(page, 'form-errors').textContent());
    await shot(page, 'task-form-errors-desktop-light-en');
    check(noWrites(log, mark).length === 0, 'nothing was sent while the form had errors');
    await tid(page, 'task-cancel').click();
    await tid(page, 'dialog-discard-changes').waitFor({ timeout: 5000 });
    await tid(page, 'dialog-discard').click();
    await ready(page);
    // ---- edit keeps every other line
    const e = uniq('ed');
    const hrefE = await put(list, e, todoText(e, 'Edit me', 'PRIORITY:5', 'STATUS:NEEDS-ACTION', `DUE;VALUE=DATE:${day8(6)}`, 'X-E2E-KEEP:keep this line', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM'));
    await page.reload();
    await tasksReady(page);
    await rowOf(page, e).getByTestId('task-open').click();
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    await tid(page, 'btn-edit-task').click();
    await page.getByTestId('task-form').waitFor();
    check((await page.locator('#tf-title').textContent()).includes('Edit me') && (await tid(page, 'field-list').textContent()).includes('Crud test'), 'the edit form names the task and shows its list as text (a task is not moved here)');
    // a save with nothing changed sends nothing
    let m2 = log.length;
    await tid(page, 'task-save').click();
    await page.waitForFunction(() => /No changes to save/.test((document.querySelector('[data-testid="status-text"]') || {}).textContent || ''), null, { timeout: 5000 });
    check(noWrites(log, m2).length === 0 && /\/edit\?/.test(await page.evaluate(() => location.hash)), 'a form that changed nothing sends nothing and says "No changes to save."');
    // discard guard
    await tid(page, 'field-summary').fill('Edited title');
    await tid(page, 'task-cancel').click();
    await tid(page, 'dialog-discard-changes').waitFor({ timeout: 5000 });
    check(true, 'leaving a form with unsaved input asks first (dialog-discard-changes)');
    await page.keyboard.press('Escape');
    await tid(page, 'dialog-discard-changes').waitFor({ state: 'detached' });
    check((await tid(page, 'field-summary').inputValue()) === 'Edited title', 'Esc keeps the form and the typed input');
    await tid(page, 'field-priority').selectOption('9');
    await saveTask(page);
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    const el = await linesOfRes(hrefE);
    const d = lineDiff(todoText(e, 'Edit me', 'PRIORITY:5', 'STATUS:NEEDS-ACTION', `DUE;VALUE=DATE:${day8(6)}`, 'X-E2E-KEEP:keep this line', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM'), (await davGet('alice', hrefE)).text);
    check(has(el, /^SUMMARY:Edited title$/) && has(el, /^PRIORITY:9$/), 'the edit changed the title and the priority', el.join(' | '));
    check(has(el, /^X-E2E-KEEP:keep this line$/) && has(el, /^TRIGGER:-PT15M$/) && has(el, new RegExp(`^DUE;VALUE=DATE:${day8(6)}$`)) && d.removed.every((l) => /^(SUMMARY|PRIORITY|DTSTAMP|LAST-MODIFIED|SEQUENCE)/.test(l)), 'only those lines changed: the due date, the unknown property and the reminder are untouched', `removed: ${d.removed.join(' | ')}; added: ${d.added.join(' | ')}`);
    // ---- delete
    await tid(page, 'btn-edit-task').click();
    await page.getByTestId('task-form').waitFor();
    await tid(page, 'task-delete').click();
    await tid(page, 'dialog-delete-task').waitFor();
    check((await tid(page, 'dialog-confirm-delete').textContent()).includes('Edited title') && (await page.evaluate(() => document.activeElement.dataset.testid)) !== 'dialog-confirm-delete', 'the delete dialog names the task; the focus is not on the destructive button');
    await tid(page, 'dialog-cancel').click();
    await tid(page, 'dialog-delete-task').waitFor({ state: 'detached' });
    check((await davGet('alice', hrefE)).status === 200, 'cancelling the delete dialog deletes nothing');
    await tid(page, 'task-delete').click();
    await tid(page, 'dialog-delete-task').waitFor();
    await tid(page, 'dialog-confirm-delete').click();
    await tid(page, 'dialog-delete-task').waitFor({ state: 'detached', timeout: 20000 });
    await page.waitForFunction(() => location.hash.startsWith('#/tasks') && !/\/edit/.test(location.hash), null, { timeout: 20000 });
    check((await davGet('alice', hrefE)).status === 404, 'confirming deletes the task on the server (404 afterwards)');
    await tasksReady(page);
    check((await rowOf(page, e).count()) === 0, 'and the row is gone from the list');
    await assertClean(page, watch, 'tasks crud');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ sub-tasks
scenarios.subtasks = async (browser) => {
  const list = await mklist('sub', 'Subtasks test');
  const p = uniq('p');
  const c1 = uniq('c');
  const o = uniq('o');
  await put(list, p, todoText(p, 'Parent task', `DUE;VALUE=DATE:${day8(10)}`));
  await put(list, c1, todoText(c1, 'Child due today', `RELATED-TO:${p}`, `DUE;VALUE=DATE:${day8(0)}`));
  await put(list, o, todoText(o, 'Orphan child', 'RELATED-TO:no-such-parent@example.org'));
  const { ctx, page, watch } = await open(browser);
  try {
    await openTasks(page, 'filter=all');
    await page.waitForSelector(`${ROW}[data-uid="${o}"]`);
    const depth = await page.$$eval(ROW, (ns) => Object.fromEntries(ns.map((n) => [n.dataset.uid, n.dataset.depth])));
    check(depth[p] === '0' && depth[c1] === '1', 'a child is nested under its parent (RELATED-TO)', JSON.stringify({ p: depth[p], c1: depth[c1] }));
    check(depth[o] === '0' && (await rowOf(page, o).getByTestId('task-orphan').textContent()).includes('Parent not found'), 'an orphan child is shown at top level with "Parent not found"');
    await openTasks(page, 'filter=today');
    const mine = (await rowUids(page)).filter((x) => x === p || x === c1);
    check(JSON.stringify(mine) === JSON.stringify([p, c1]) && (await rowOf(page, p).getByTestId('task-context').count()) === 1, 'a parent that does not match the filter stays as context when its child does ("Shown for context")', mine.join(','));
    check(/Sub-tasks of/.test(await rowOf(page, p).getByTestId('task-subtasks').first().getAttribute('aria-label')), 'the nested list is named "Sub-tasks of …"');
    await assertClean(page, watch, 'subtasks');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ states
scenarios.states = async (browser) => {
  // bob: no task list (his calendar takes events only), he can create one
  const b = await open(browser, { user: 'bob' });
  try {
    await openTasks(b.page);
    await tid(b.page, 'tasks-nolist').waitFor({ timeout: 20000 });
    const href = await tid(b.page, 'btn-create-task-list').getAttribute('href');
    check(/new-calendar\?components=VTODO/.test(href), 'no task list: the state offers "Create a task list" that opens the form with tasks ticked', href);
    check((await tid(b.page, 'btn-new-task').count()) === 0, 'and no "New task" button yet');
    await shot(b.page, 'tasks-nolist-desktop-light-en');
    await tid(b.page, 'btn-create-task-list').click();
    await b.page.waitForSelector('[data-testid="field-components"]');
    check(await b.page.getByTestId('component-vtodo').isChecked() && !(await b.page.getByTestId('component-vevent').isChecked()), 'the collection form starts with tasks ticked and events not');
    // an empty task list: the "no tasks yet" state with a way to add one
    const empty = await mklist('emp', 'Empty list', 'bob');
    await go(b.page, tasksHash());
    await b.page.reload();
    await tasksReady(b.page);
    await tid(b.page, 'tasks-empty').waitFor({ timeout: 20000 });
    check((await tid(b.page, 'btn-new-task-empty').getAttribute('href')).includes(enc(empty.href)), 'an empty task list: "No tasks yet" with a button to add the first one, on that list');
    check(/^0 open · 0 overdue · 1 task list/.test(await statusOf(b.page)), 'the status line still reads 0 open', await statusOf(b.page));
    await assertClean(b.page, b.watch, 'bob tasks states');
  } finally {
    await b.ctx.close();
  }
  // carol: no own space and nothing shared
  const c = await open(browser, { user: 'carol' });
  try {
    await go(c.page, tasksHash());
    await tid(c.page, 'tasks-nolist').waitFor({ timeout: 20000 });
    check((await tid(c.page, 'btn-create-task-list').count()) === 0 && /Nothing has been shared with you/.test(await tid(c.page, 'tasks-nolist').textContent()), 'an account without space or shares: an explanation and no create button', await tid(c.page, 'tasks-nolist').textContent());
    await assertClean(c.page, c.watch, 'carol tasks');
  } finally {
    await c.ctx.close();
  }
  // agent-1: may only read "Chores"
  const a = await open(browser, { user: 'agent-1' });
  try {
    const { page, watch } = a;
    const log = dataRequests(page);
    await openTasks(page);
    await page.waitForSelector(`${ROW}[data-uid="${U.recycling}"]`);
    check((await toggleOf(page, 'e2e-chores').count()) === 1 && (await toggleOf(page, 'e2e-tasks').count()) === 0, 'only the shared task list is listed');
    check(await tid(page, 'tasks-readonly').isVisible() && await tid(page, 'btn-new-task').isDisabled(), 'a read-only list: a notice, and "New task" is disabled with its reason');
    const tick = rowOf(page, U.recycling).getByTestId('task-complete');
    check(await tick.isDisabled() && (await rowOf(page, U.recycling).getAttribute('data-readonly')) === 'true' && /can’t change this task/.test(await tick.getAttribute('aria-label')), 'the tick is disabled, data-readonly is true, the accessible name says why', await tick.getAttribute('aria-label'));
    await go(page, taskHash(U.recycling, CHORES));
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    check((await tid(page, 'btn-edit-task').count()) === 0 && (await tid(page, 'btn-delete-task').count()) === 0 && (await tid(page, 'task-readonly').count()) === 1, 'the detail of a read-only task has no edit or delete, and says it is read-only');
    await go(page, taskEditHash(U.recycling, CHORES));
    await tid(page, 'task-form-readonly').waitFor({ timeout: 20000 });
    check((await tid(page, 'task-form').count()) === 0, 'the edit route is refused in the page');
    await go(page, taskNewHash(CHORES));
    await tid(page, 'task-form-readonly').waitFor({ timeout: 20000 });
    check(noWrites(log).length === 0, 'a read-only user sent no write at all');
    await assertClean(page, watch, 'agent tasks');
  } finally {
    await a.ctx.close();
  }
};

// ============================================================================================ operability, nav
scenarios.operability = async (browser) => {
  const { ctx, page, watch } = await open(browser);
  try {
    check(await tid(page, 'nav-tasks').isVisible(), 'the Tasks entry is in the navigation (slice 3c is switched on)');
    await tid(page, 'nav-tasks').click();
    await tasksReady(page);
    check((await tid(page, 'nav-tasks').getAttribute('aria-current')) === 'page', 'and is current on the task screens');
    // keyboard only: a row link opens the detail, the detail focuses its title
    await page.waitForSelector(`${ROW}[data-uid="${U.today}"]`);
    await rowOf(page, U.today).getByTestId('task-open').focus();
    await page.keyboard.press('Enter');
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    check((await page.evaluate(() => document.activeElement.dataset.testid)) === 'task-title', 'keyboard: a row link opens the detail; the detail focuses its title');
    await tid(page, 'btn-edit-task').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('task-form').waitFor();
    await pageChecks(page, watch, 'task edit form desktop');
    await tid(page, 'task-cancel').click();
    await ready(page);
    // the whole task screen is reachable with Tab only
    await openTasks(page);
    let reached = false;
    await tid(page, 'task-filter-open').focus();
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = (await page.evaluate(() => document.activeElement.dataset.testid)) === 'task-complete';
    }
    check(reached, 'Tab reaches the completion buttons');
    await assertClean(page, watch, 'tasks operability');
  } finally {
    await ctx.close();
  }
};

// ============================================================================================ phone
scenarios.phone = async (browser) => {
  const list = await mklist('mob', 'Phone test');
  const { ctx, page, watch } = await open(browser, { w: 390, h: 844 });
  try {
    await openTasks(page);
    await page.waitForSelector(`${ROW}[data-uid="${U.parent}"]`);
    await overflow(page, 'tasks list phone');
    await shot(page, 'tasks-list-phone-light-en');
    await pageChecks(page, watch, 'tasks list phone', { skip: ['contrast'] });
    check(await tid(page, 'btn-new-task').isVisible() && await tid(page, 'task-filter-overdue').isVisible(), 'phone: the new-task button and the filters are on screen');
    await go(page, taskDetailOf(U.soon));
    await tid(page, 'task-detail').waitFor({ timeout: 20000 });
    await overflow(page, 'task detail phone');
    const before = await listItems('alice', list.href);
    await openForm(page, taskNewHash(list.href));
    await tid(page, 'field-summary').fill('Phone task');
    await fillDate(page, 'due', dayIso(7));
    await fillTime(page, 'due', '08:15');
    await overflow(page, 'task form phone');
    await shot(page, 'task-form-phone-light-en');
    await pageChecks(page, watch, 'task form phone', { skip: ['contrast'] });
    await saveTask(page);
    check((await listItems('alice', list.href)).length === before.length + 1, 'phone: the form creates a task');
    await assertClean(page, watch, 'tasks phone');
  } finally {
    await ctx.close();
  }
};
const taskDetailOf = (key) => taskHash(key, LIST);

// ============================================================================================ French, dark
scenarios['french-dark'] = async (browser) => {
  const { ctx, page, watch } = await open(browser, { lang: 'fr', scheme: 'dark' });
  try {
    await openTasks(page);
    await page.waitForSelector(`${ROW}[data-uid="${U.overdue}"]`);
    check(/à faire/.test(await statusOf(page)) && (await tid(page, 'task-filter-overdue').textContent()).includes(fr['tasks.filter.overdue']), 'French: the status line and the filters are in French', await statusOf(page));
    check(/^En retard depuis le /.test((await rowOf(page, U.overdue).getByTestId('task-due').textContent()).trim()) && (await rowOf(page, U.today).getByTestId('task-due').textContent()).trim() === fr['tasks.dueToday'], 'French: the due texts', (await rowOf(page, U.overdue).getByTestId('task-due').textContent()).trim());
    await shot(page, 'tasks-list-desktop-dark-fr');
    await pageChecks(page, watch, 'tasks list desktop dark fr');
    await openForm(page, taskNewHash(LIST));
    check((await page.locator('#tf-title').textContent()).trim() === fr['tasks.form.titleNew'], 'French: the form title');
    await shot(page, 'task-form-desktop-dark-fr');
    await tid(page, 'task-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    check((await tid(page, 'form-errors').textContent()).includes(fr['tasks.err.summary-required']), 'French: the error text', await tid(page, 'form-errors').textContent());
    await tid(page, 'task-cancel').click();
    await ready(page);
    await assertClean(page, watch, 'tasks french dark');
  } finally {
    await ctx.close();
  }
};
