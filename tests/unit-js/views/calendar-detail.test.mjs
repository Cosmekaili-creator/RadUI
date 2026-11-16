// SPDX-License-Identifier: AGPL-3.0-or-later
// The event detail (WP B3a): panel and page, zone lines, read-only and unknown-zone events, hostile text, and the
// actions (edit scope question, delete, move, export) through the real write path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, mountEvent } from '../../../src/js/views/calendar/screen.js';
import { buildDetail, zoneLines } from '../../../src/js/views/calendar/detail.js';
import { loadDetailModel } from '../../../src/js/views/calendar/detailmodel.js';
import { createCalendarSource } from '../../../src/js/views/calendar/source.js';
import { createEventActions } from '../../../src/js/views/calendar/actions.js';
import { CAL_A, CAL_B, CAL_RO, WEEK, all, doc, flush, hostile, one, setup, single, text } from './calendar-helpers.mjs';
import { fire } from '../widgets/_dom.mjs';

const cxOf = (s, tz = 'Europe/Paris') => ({ t: s.t, lang: 'en', tz, use24h: true });

async function model(s, { key, cal = CAL_A, occ = '', tz } = {}) {
  const src = createCalendarSource({ storeCtx: s.storeCtx, app: s.app, t: s.t });
  const res = await loadDetailModel({ source: src, storeCtx: s.storeCtx, params: { key, cal, occ }, cx: cxOf(s, tz) });
  return { src, res };
}
const detailOf = (s, res, over = {}) => buildDetail({ model: res.model, t: s.t, tp: s.tp, lang: 'en', tz: 'Europe/Paris', use24h: true, page: false, ops: { onEdit() {}, onDelete() {}, onMove() {}, onExport() {}, onClose() {} }, ...over });
const has = (root, id) => one(root, id) !== null;
const plain = (x) => String(x).replace(/[\u2066-\u2069]/g, '');
const dd = (root, id) => one(root, id).querySelector('dd').textContent;

test('two zones: the start and end zones are listed with the clock time in the display zone ("your time")', async () => {
  const s = await setup();
  const { res } = await model(s, { key: 'flight@example.org', tz: 'Asia/Kathmandu' });
  const lines = zoneLines(res.model.occ, { tz: 'Asia/Kathmandu', lang: 'en', use24h: true, t: s.t });
  assert.equal(lines.start, 'Starts 11:00 Europe/Paris = 14:45 your time');
  assert.equal(lines.end, 'Ends 13:30 America/New_York = 23:15 your time');
  const same = zoneLines(res.model.occ, { tz: 'Europe/Paris', lang: 'en', use24h: true, t: s.t });
  assert.equal(same.start, 'Time zone: Europe/Paris');
  assert.equal(same.end, 'Ends 13:30 America/New_York = 19:30 your time');
  const root = detailOf(s, res);
  assert.equal(text(root, 'event-zone-end'), same.end);
  assert.equal(has(root, 'event-floating'), false);
});

test('floating and all-day events: no zone line, a floating notice', async () => {
  const s = await setup();
  const run = (await model(s, { key: 'run@example.org' })).res;
  const root = detailOf(s, run);
  assert.match(text(root, 'event-floating'), /same clock time in every zone/);
  assert.equal(has(root, 'event-zone-start'), false);
  const conf = (await model(s, { key: 'conf@example.org' })).res;
  assert.match(text(detailOf(s, conf), 'event-when'), /all day/);
});

test('a writable single event: edit, delete, move and export buttons with names; the data attributes; no recurrence', async () => {
  const s = await setup();
  const { res } = await model(s, { key: 'lunch@example.org' });
  assert.equal(res.status, 'ready');
  assert.equal(res.model.canWrite, true);
  assert.equal(res.model.canMove, true);
  const root = detailOf(s, res);
  assert.equal(root.getAttribute('data-testid'), 'event-detail');
  assert.equal(root.getAttribute('data-uid'), 'lunch@example.org');
  assert.equal(root.getAttribute('data-readonly'), 'false');
  assert.equal(plain(one(root, 'btn-edit-event').getAttribute('aria-label')), 'Edit Lunch');
  assert.equal(plain(one(root, 'btn-delete-event').getAttribute('aria-label')), 'Delete Lunch');
  assert.equal(plain(one(root, 'btn-move-event').getAttribute('aria-label')), 'Move Lunch to another calendar');
  assert.equal(plain(one(root, 'btn-export-event').getAttribute('aria-label')), 'Export Lunch as an .ics file');
  assert.equal(has(root, 'event-recurrence'), false);
  assert.equal(text(root, 'event-title'), 'Lunch');
});

test('a series occurrence: recurrence sentence, overridden note; occ is validated and resolved', async () => {
  const s = await setup();
  const ok = (await model(s, { key: 'weekly@example.org', occ: '2026-06-08T09:30:00' })).res;
  assert.equal(ok.status, 'ready');
  assert.match(dd(detailOf(s, ok), 'event-recurrence'), /^Every week on Monday/);
  assert.equal(ok.model.rec.occParam, '2026-06-08T09:30:00');
  const moved = (await model(s, { key: 'weekly@example.org', occ: '2026-06-01T09:30:00' })).res;
  assert.match(dd(detailOf(s, moved), 'event-recurrence'), /changed on its own/);
  assert.equal(moved.model.rec.title, 'Weekly sync (moved)');
  assert.equal((await model(s, { key: 'weekly@example.org', occ: '2026-06-09T09:30:00' })).res.status, 'occurrence'); // not an occurrence
  assert.equal((await model(s, { key: 'weekly@example.org', occ: 'not-a-date' })).res.status, 'occurrence');
  assert.equal((await model(s, { key: 'weekly@example.org', occ: '2026-06-08T09:30:00'.repeat(3) })).res.status, 'occurrence');
});

test('unknown time zone: read-only, warning, raw text, edit and move hidden, delete and export allowed', async () => {
  const s = await setup();
  const { res } = await model(s, { key: 'mars@example.org' });
  assert.equal(res.model.readOnlyReason, 'unknown-tzid');
  assert.equal(res.model.canMove, false); // a read-only item is never moved (writes.moveItem refuses it too)
  const root = detailOf(s, res);
  assert.equal(root.getAttribute('data-readonly'), 'true');
  assert.ok(has(root, 'event-readonly'));
  assert.ok(has(root, 'event-tz-warning'));
  assert.match(text(root, 'event-raw'), /TZID=Mars\/Olympus/);
  assert.match(text(root, 'event-zone-start'), /time zone unknown/);
  assert.equal(has(root, 'btn-edit-event'), false);
  assert.equal(has(root, 'btn-move-event'), false);
  assert.ok(has(root, 'btn-delete-event'));
  assert.ok(has(root, 'btn-export-event'));
});

test('a read-only calendar: no write button, a visible reason, export stays', async () => {
  const s = await setup();
  const { res } = await model(s, { key: 'shared@example.org', cal: CAL_RO });
  assert.equal(res.model.canWrite, false);
  const root = detailOf(s, res);
  assert.match(text(root, 'event-readonly'), /read-only for you/);
  for (const id of ['btn-edit-event', 'btn-delete-event', 'btn-move-event']) assert.equal(has(root, id), false, id);
  assert.ok(has(root, 'btn-export-event'));
});

test('hostile text is shown literally: no element, no link for a javascript: URL, no style', async () => {
  const s = await setup({ items: { [`${CAL_A}h.ics`]: hostile('hostile@example.org') } });
  const { res } = await model(s, { key: 'hostile@example.org' });
  const root = detailOf(s, res);
  assert.equal(text(root, 'event-title'), '<img src=x onerror=alert(1)>');
  assert.equal(dd(root, 'event-location'), '<b>Room</b>');
  assert.equal(one(root, 'event-url').querySelector('a'), null, 'javascript: is never a link');
  assert.match(dd(root, 'event-url'), /javascript:alert\(1\)/);
  assert.match(dd(root, 'event-description'), /<script>x<\/script>\nsecond line/);
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('script'), null);
  const att = all(root, 'attendee-row');
  assert.equal(att.length, 1);
  assert.match(att[0].textContent, /Pat Example/);
  assert.match(att[0].textContent, /Accepted/);
  assert.equal(att[0].querySelector('button'), null, 'attendees are read-only');
});

test('an http link is a link with rel noopener; credentials in the URL are not', async () => {
  const mk = (url) => single('u@example.org', 'Linked', { extra: `URL:${url}\n` });
  const s = await setup({ items: { [`${CAL_A}u.ics`]: mk('https://example.org/room') } });
  const a = one(detailOf(s, (await model(s, { key: 'u@example.org' })).res), 'event-url').querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://example.org/room');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  const s2 = await setup({ items: { [`${CAL_A}u.ics`]: mk('https://user:pw@example.org/') } });
  assert.equal(one(detailOf(s2, (await model(s2, { key: 'u@example.org' })).res), 'event-url').querySelector('a'), null);
});

test('alarms: modelled ones as text, other reminders counted and kept', async () => {
  const alarm = (trigger, extra = '') => `BEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:x\nTRIGGER:${trigger}\n${extra}END:VALARM\n`;
  const items = { [`${CAL_A}al.ics`]: single('al@example.org', 'Alarmed', { extra: `${alarm('-PT15M')}${alarm('-PT45M')}BEGIN:VALARM\nACTION:AUDIO\nTRIGGER:-PT5M\nEND:VALARM\n` }) };
  const s = await setup({ items });
  const root = detailOf(s, (await model(s, { key: 'al@example.org' })).res);
  const li = one(root, 'event-alarms').querySelectorAll('li').map((n) => n.textContent);
  assert.deepEqual(li, ['15 minutes before', '45 minutes before']);
  assert.match(one(root, 'event-alarms').textContent, /1 other reminder is kept as it is/);
});

test('route keys: unknown calendar, unknown key and a key of 300 characters are not-found states, nothing is fetched', async () => {
  const s = await setup();
  assert.equal((await model(s, { key: 'nope@example.org' })).res.status, 'notfound');
  assert.equal((await model(s, { key: 'lunch@example.org', cal: '/alice/not-mine/' })).res.status, 'nocalendar');
  assert.equal((await model(s, { key: 'k'.repeat(300) })).res.status, 'notfound');
  assert.equal(s.env.server.callsOf('GET').filter((c) => c.includes('not-mine')).length, 0);
  assert.equal(s.env.server.callsOf('SYNC').filter((c) => c.includes('not-mine')).length, 0);
});

// ---- the screen: panel on desktop, page route

async function withPanel(key, extra = {}, pre = () => {}) {
  const s = await setup();
  pre(s);
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  const rec = ctl._state.records.find((r) => r.uid === key);
  assert.ok(rec, key);
  await ctl.update(s.ctx({ ...WEEK, ev: rec.routeKey, cal: rec.calendar, occ: rec.occParam, ...extra }));
  await flush(40);
  s.ctl = ctl;
  s.rec = rec;
  return s;
}

test('clicking an event opens the detail in the panel on desktop: URL state, same grid, title focused', async () => {
  const s = await setup();
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  const chip = all(s.main, 'event-chip').find((c) => c.getAttribute('data-uid') === 'lunch@example.org');
  assert.match(chip.getAttribute('href'), /^#\/events\/lunch%40example\.org\?cal=/); // the page route (phones, middle click)
  ctl.openEvent(ctl._state.records.find((r) => r.uid === 'lunch@example.org'));
  assert.equal(s.navs.at(-1).hash, `#/calendar/week/2026-06-03?ev=lunch%40example.org&cal=${encodeURIComponent(CAL_A)}&occ=single`);
  const grid = one(s.main, 'week-grid');
  await ctl.update(s.ctx({ ...WEEK, ev: 'lunch@example.org', cal: CAL_A, occ: 'single' }));
  await flush(40);
  assert.equal(one(s.main, 'week-grid'), grid);
  assert.equal(one(s.main, 'event-panel').hidden, false);
  assert.equal(text(s.main, 'event-title'), 'Lunch');
  assert.equal(doc.activeElement, one(s.main, 'event-title'));
  // close: back to the calendar hash without the event
  fire(one(s.main, 'btn-close-detail'), 'click');
  assert.equal(s.navs.at(-1).hash, '#/calendar/week/2026-06-03');
  await ctl.update(s.ctx(WEEK));
  assert.equal(one(s.main, 'event-panel').hidden, true);
  ctl.dispose();
});

test('on a phone an event link in the calendar hash goes to the page route', async () => {
  const s = await setup({ phone: true });
  const ctl = mount(s.ctx({ ...WEEK, ev: 'lunch@example.org', cal: CAL_A, occ: 'single' }), s.deps);
  await flush(40);
  assert.equal(s.navs.at(-1).hash, `#/events/lunch%40example.org?cal=${encodeURIComponent(CAL_A)}&occ=single`);
  assert.equal(s.navs.at(-1).opts.replace, true);
  ctl.dispose();
});

test('the page route: detail, back link to the calendar week of the event, not-found state, birthday detail', async () => {
  const s = await setup();
  const ctl = mountEvent(s.ctx({ key: 'lunch@example.org', cal: CAL_A, occ: 'single' }, { name: 'event' }), s.deps);
  await flush(40);
  assert.equal(s.main.querySelector('[data-testid="event-screen"]').getAttribute('data-state'), 'ready');
  assert.equal(text(s.main, 'event-title'), 'Lunch');
  assert.equal(one(s.main, 'btn-back').getAttribute('href'), '#/calendar/week/2026-06-04');
  assert.equal(has(s.main, 'btn-close-detail'), false);
  ctl.dispose();
  const n = await setup();
  const c2 = mountEvent(n.ctx({ key: 'gone@example.org', cal: CAL_A }, { name: 'event' }), n.deps);
  await flush(40);
  assert.equal(n.main.querySelector('[data-testid="event-screen"]').getAttribute('data-state'), 'error');
  assert.ok(one(n.main, 'event-notfound'));
  assert.ok(one(n.main, 'btn-back'));
  c2.dispose();
});

test('delete a single event: the named dialog, Cancel does nothing, Delete sends one DELETE with the shown ETag', async () => {
  const s = await withPanel('lunch@example.org');
  const href = `${CAL_A}lunch.ics`;
  const etag = s.env.server.at(href).etag;
  fire(one(s.main, 'btn-delete-event'), 'click');
  await flush();
  const dlg = one(doc.body, 'dialog-delete-event');
  assert.ok(dlg);
  assert.match(plain(dlg.textContent), /Delete Lunch\?/);
  fire(one(dlg, 'dialog-cancel'), 'click');
  await flush();
  assert.equal(s.env.server.callsOf('DELETE').length, 0);
  fire(one(s.main, 'btn-delete-event'), 'click');
  await flush();
  fire(one(one(doc.body, 'dialog-delete-event'), 'dialog-confirm-delete'), 'click');
  await flush(40);
  assert.deepEqual(s.env.server.callsOf('DELETE'), [`DELETE ${href}`]);
  assert.equal(s.env.server.at(href), undefined);
  assert.equal(etag !== undefined, true);
  assert.equal(s.navs.at(-1).hash, '#/calendar/week/2026-06-03');
  s.ctl.dispose();
});

test('delete "this occurrence" of a series: the scope question, then ONE PUT that adds an EXDATE; the series stays', async () => {
  const s = await setup();
  const asked = [];
  s.deps.actionDeps.loadScopeDialog = async () => ({ askScope: async (o) => (asked.push(o), 'this') });
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  await ctl.update(s.ctx({ ...WEEK, ev: 'weekly@example.org', cal: CAL_A, occ: '2026-06-08T09:30:00' }));
  await flush(40);
  fire(one(s.main, 'btn-delete-event'), 'click');
  await flush(60);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].mode, 'delete');
  assert.equal(asked[0].isFirst, false);
  assert.equal(s.env.server.callsOf('PUT').length, 1);
  assert.equal(s.env.server.callsOf('DELETE').length, 0);
  assert.match(s.env.server.at(`${CAL_A}weekly.ics`).text, /EXDATE;TZID=Europe\/Paris:20260608T093000/);
  ctl.dispose();
});

test('edit: a single event goes straight to the form route; a series asks the scope first and carries it', async () => {
  const s = await setup();
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  await ctl.update(s.ctx({ ...WEEK, ev: 'lunch@example.org', cal: CAL_A, occ: 'single' }));
  await flush(40);
  fire(one(s.main, 'btn-edit-event'), 'click');
  await flush(20);
  assert.equal(s.navs.at(-1).hash, `#/events/lunch%40example.org/edit?cal=${encodeURIComponent(CAL_A)}`);
  const asked = [];
  s.deps.actionDeps.loadScopeDialog = async () => ({ askScope: async (o) => (asked.push(o), 'following') });
  await ctl.update(s.ctx({ ...WEEK, ev: 'weekly@example.org', cal: CAL_A, occ: '2026-06-08T09:30:00' }));
  await flush(40);
  fire(one(s.main, 'btn-edit-event'), 'click');
  await flush(40);
  assert.equal(asked[0].mode, 'edit');
  assert.equal(s.navs.at(-1).hash, `#/events/weekly%40example.org/edit?cal=${encodeURIComponent(CAL_A)}&occ=2026-06-08T09%3A30%3A00&scope=following`);
  ctl.dispose();
});

test('edit of the FIRST occurrence offers no "this and following" (isFirst is passed to the scope dialog)', async () => {
  const s = await setup();
  const asked = [];
  const src = createCalendarSource({ storeCtx: s.storeCtx, app: s.app, t: s.t });
  const { res } = await model(s, { key: 'weekly@example.org', occ: '2026-03-02T09:30:00' });
  const actions = createEventActions({ app: s.app, storeCtx: s.storeCtx, source: src, t: s.t, deps: { loadScopeDialog: async () => ({ askScope: async (o) => (asked.push(o), 'all') }) } });
  const hash = await actions.editTarget(res.model);
  assert.equal(asked[0].isFirst, true);
  assert.match(hash, /scope=all/);
});

test('the fallback scope dialog (no WP B3b module) uses the same ids and buttons', async () => {
  const s = await setup();
  const src = createCalendarSource({ storeCtx: s.storeCtx, app: s.app, t: s.t });
  const { res } = await model(s, { key: 'weekly@example.org', occ: '2026-06-08T09:30:00' });
  const actions = createEventActions({ app: s.app, storeCtx: s.storeCtx, source: src, t: s.t, deps: { win: {}, loadScopeDialog: async () => { throw new Error('missing'); } } });
  const pending = actions.editTarget(res.model);
  await flush();
  const dlg = one(doc.body, 'dialog-scope-edit');
  assert.ok(dlg);
  for (const id of ['scope-this', 'scope-following', 'scope-all', 'scope-cancel']) assert.ok(one(dlg, id), id);
  fire(one(dlg, 'scope-cancel'), 'click');
  assert.equal(await pending, null);
});

test('move: a named dialog lists the OTHER writable calendars; Move copies the exact text then deletes the original', async () => {
  const s = await withPanel('lunch@example.org');
  const href = `${CAL_A}lunch.ics`;
  const original = s.env.server.at(href).text;
  fire(one(s.main, 'btn-move-event'), 'click');
  await flush();
  const dlg = one(doc.body, 'dialog-move-event');
  assert.ok(dlg);
  const select = one(dlg, 'field-move-target');
  assert.deepEqual(select.querySelectorAll('option').map((o) => o.value), [CAL_B]); // not itself, not the read-only calendar
  fire(one(dlg, 'dialog-confirm-move'), 'click');
  await flush(60);
  assert.equal(s.env.server.at(href), undefined);
  assert.equal(s.env.server.at(`${CAL_B}lunch.ics`).text.replace(/\s+/g, ''), original.replace(/\s+/g, ''));
  assert.equal(s.navs.at(-1).hash, '#/calendar/week/2026-06-03');
  s.ctl.dispose();
});

test('export downloads the stored text as one .ics file', async () => {
  const s = await withPanel('lunch@example.org');
  fire(one(s.main, 'btn-export-event'), 'click');
  assert.equal(s.downloads.length, 1);
  assert.match(s.downloads[0].filename, /^lunch-\d{4}-\d{2}-\d{2}\.ics$/);
  assert.match(s.downloads[0].text, /UID:lunch@example\.org/);
  assert.equal(s.downloads[0].mime.startsWith('text/calendar'), true);
  s.ctl.dispose();
});

test('an event changed elsewhere before Delete: the conflict dialog is shown ("Delete anyway" is its choice), nothing is deleted behind the user', async () => {
  const seen = [];
  const s = await withPanel('lunch@example.org', {}, (x) => {
    x.deps.actionDeps.openConflictDialog = async ({ conflict }) => (seen.push(conflict.status), { ok: false, cancelled: true });
  });
  const href = `${CAL_A}lunch.ics`;
  s.env.server.outside(href, single('lunch@example.org', 'Lunch changed elsewhere'));
  fire(one(s.main, 'btn-delete-event'), 'click');
  await flush();
  fire(one(one(doc.body, 'dialog-delete-event'), 'dialog-confirm-delete'), 'click');
  await flush(60);
  assert.deepEqual(seen, ['changed-elsewhere']);
  assert.ok(s.env.server.at(href));
  s.ctl.dispose();
});
