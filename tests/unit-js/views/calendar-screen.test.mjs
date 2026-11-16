// SPDX-License-Identifier: AGPL-3.0-or-later
// The calendar screen (WP B3a) over a real write path and stores on an in-memory multi-calendar server:
// views, status line, stable toggling (same grid element, is-off, individual inserts), time zones, search,
// read-only and empty states, errors, birthdays, hash navigation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DavError } from '../../../src/js/dav/http.js';
import { mount } from '../../../src/js/views/calendar/screen.js';
import { createCalendarSource } from '../../../src/js/views/calendar/source.js';
import { CAL_A, CAL_B, CAL_RO, NOW, WEEK, all, doc, flush, keysOf, offCount, one, setup, single, text } from './calendar-helpers.mjs';
import { change, choose, fire, type } from '../widgets/_dom.mjs';
import { pushRecent } from '../../../src/js/calendar/tzprefs.js';

const KEYS_ALL = 8; // events in the week of 2026-06-01 over the three calendars (see BASE_ITEMS)

async function mounted(opts = {}, params = WEEK) {
  const s = await setup(opts);
  const ctl = mount(s.ctx(params), s.deps);
  await flush(40);
  s.ctl = ctl;
  s.root = s.main.querySelector('[data-testid="calendar-screen"]');
  return s;
}
const toggle = (s, href) => all(s.main, 'calendar-toggle').find((n) => n.getAttribute('data-href') === href);
const tick = async (s, ms = 20) => {
  s.timers.advance(ms);
  await flush(20);
};

test('week view: ready, status line, one chip per event with the documented attributes, 3 calendars listed', async () => {
  const s = await mounted();
  assert.equal(s.root.getAttribute('data-state'), 'ready');
  assert.equal(s.root.getAttribute('data-sync'), 'idle');
  assert.equal(text(s.main, 'cal-status'), `Week of Jun 1, 2026 · ${KEYS_ALL} events in 3 calendars`);
  assert.equal(keysOf(s.main).length, KEYS_ALL);
  assert.equal(all(s.main, 'calendar-toggle').length, 3);
  assert.equal(one(s.main, 'week-grid') !== null, true);
  assert.equal(one(s.main, 'callist-count').textContent, '3/3');
  for (const chip of all(s.main, 'event-chip')) {
    for (const a of ['data-uid', 'data-href', 'data-calendar', 'data-occurrence', 'data-key', 'data-readonly']) assert.ok(chip.hasAttribute(a), a);
    assert.ok(chip.getAttribute('aria-label').length > 5);
  }
  const weekly = all(s.main, 'event-chip').find((c) => c.getAttribute('data-uid') === 'weekly@example.org');
  assert.equal(weekly.getAttribute('data-occurrence'), '2026-06-01T09:30:00'); // the override keeps its RECURRENCE-ID
  assert.match(weekly.getAttribute('aria-label'), /^Weekly sync \(moved\), Mon, Jun 1/);
  assert.equal(all(s.main, 'event-chip').find((c) => c.getAttribute('data-uid') === 'shared@example.org').getAttribute('data-readonly'), 'true');
  assert.equal(all(s.main, 'week-day').length, 7);
  assert.equal(all(s.main, 'btn-new-event-at').length, 7);
  assert.ok(one(s.main, 'now-marker'));
  assert.equal(one(s.main, 'period-heading').textContent.includes('1–7 June'), true);
  s.ctl.dispose();
});

test('the screen answers at once: data-state loading first, the shell readiness waits', async () => {
  const s = await setup();
  const ctl = mount(s.ctx(WEEK), s.deps);
  assert.equal(s.main.querySelector('[data-testid="calendar-screen"]').getAttribute('data-state'), 'loading');
  assert.equal(one(s.main, 'cal-status').textContent, 'Loading the calendars…');
  await flush(40);
  assert.equal(s.main.querySelector('[data-testid="calendar-screen"]').getAttribute('data-state'), 'ready');
  ctl.dispose();
});

test('stable toggling: off keeps the grid element, the scroller and every node (is-off), on flags them back', async () => {
  const s = await mounted();
  const grid = one(s.main, 'week-grid');
  const scroller = one(s.main, 'time-scroller');
  scroller.scrollTop = 321;
  const nodes = all(s.main, 'event-chip');
  const before = nodes.length;
  const cb = toggle(s, CAL_B);
  cb.focus();
  cb.checked = false;
  fire(cb, 'change');
  await flush();
  assert.equal(one(s.main, 'week-grid'), grid, 'the grid element is not re-rendered');
  assert.equal(one(s.main, 'time-scroller'), scroller);
  assert.equal(scroller.scrollTop, 321);
  assert.equal(doc.activeElement, cb, 'focus stays on the checkbox');
  assert.equal(all(s.main, 'event-chip').length, before, 'nodes stay in the DOM');
  const off = all(s.main, 'event-chip').filter((n) => n.classList.contains('is-off'));
  assert.deepEqual(off.map((n) => n.getAttribute('data-calendar')), [CAL_B]);
  assert.equal(offCount(s.main), 1);
  assert.equal(one(s.main, 'callist-count').textContent, '2/3');
  assert.equal(text(s.main, 'cal-status'), 'Week of Jun 1, 2026 · 7 events in 2 calendars');
  assert.equal(text(s.main, 'callist-live'), 'Calendar /alice/cal-b/ hidden, 1 event removed from view.');
  assert.deepEqual(s.prefs.get('cal.hidden'), [CAL_B]);
  cb.checked = true;
  fire(cb, 'change');
  await flush();
  assert.equal(offCount(s.main), 0);
  assert.equal(all(s.main, 'event-chip').find((n) => n.getAttribute('data-calendar') === CAL_B), off[0], 'the same node comes back');
  assert.equal(text(s.main, 'callist-live'), 'Calendar /alice/cal-b/ shown, 1 event.');
  s.ctl.dispose();
});

test('a calendar that was off is fetched only when first switched on: loading marker, then its nodes are inserted individually', async () => {
  const s = await mounted({ hidden: [CAL_B] });
  assert.equal(keysOf(s.main).length, KEYS_ALL - 1);
  assert.equal(s.calendars.isEnabled(CAL_B), false);
  assert.equal(s.env.server.callsOf('SYNC').filter((c) => String(c).includes('cal-b') || c.href === CAL_B).length, 0);
  const grid = one(s.main, 'week-grid');
  const cb = toggle(s, CAL_B);
  assert.equal(cb.checked, false);
  const before = new Set(all(s.main, 'event-chip'));
  cb.checked = true;
  fire(cb, 'change');
  await Promise.resolve();
  const marker = () => s.main.querySelector(`[data-calendar="${CAL_B}"] [data-testid="calendar-loading"]`);
  assert.equal(marker().hidden, false, 'the row shows the loading marker');
  assert.equal(marker().parentNode.getAttribute('aria-busy'), 'true');
  await flush(40);
  assert.equal(s.calendars.isEnabled(CAL_B), true);
  assert.equal(one(s.main, 'week-grid'), grid);
  const added = all(s.main, 'event-chip').filter((n) => !before.has(n));
  assert.equal(added.length, 1);
  assert.equal(added[0].getAttribute('data-uid'), 'other@example.org');
  for (const n of before) assert.ok(n.isConnected, 'existing nodes untouched');
  assert.equal(marker().hidden, true);
  assert.equal(text(s.main, 'callist-live'), 'Calendar /alice/cal-b/ shown, 1 event.');
  s.ctl.dispose();
});

test('a DAV change in an enabled calendar inserts the new node without rebuilding the grid', async () => {
  const s = await mounted();
  const grid = one(s.main, 'week-grid');
  const before = new Set(all(s.main, 'event-chip'));
  s.env.server.put(`${CAL_A}new.ics`, single('new@example.org', 'Brand new', { start: '20260603T160000', end: '20260603T170000' }));
  await s.calendars.store(CAL_A).sync({ reason: 'test' });
  await flush(20);
  assert.equal(one(s.main, 'week-grid'), grid);
  const added = all(s.main, 'event-chip').filter((n) => !before.has(n));
  assert.equal(added.length, 1);
  assert.match(added[0].getAttribute('aria-label'), /^Brand new, Wed, Jun 3 04:00 PM–05:00 PM, /);
  s.ctl.dispose();
});

test('navigation: next week is a link, update() builds the new period and keeps toolbar and search text', async () => {
  const s = await mounted();
  const toolbar = one(s.main, 'cal-toolbar');
  const search = one(s.main, 'cal-search');
  search.value = 'lun';
  assert.equal(one(s.main, 'cal-next').getAttribute('href'), '#/calendar/week/2026-06-10');
  assert.equal(one(s.main, 'cal-prev').getAttribute('href'), '#/calendar/week/2026-05-27');
  assert.equal(one(s.main, 'cal-today').getAttribute('href'), '#/calendar/week/2026-06-03');
  assert.equal(one(s.main, 'view-month').getAttribute('href'), '#/calendar/month/2026-06-03');
  assert.equal(one(s.main, 'view-week').getAttribute('aria-current'), 'page');
  const grid = one(s.main, 'week-grid');
  await s.ctl.update(s.ctx({ view: 'week', date: '2026-06-10' }));
  assert.notEqual(one(s.main, 'week-grid'), grid);
  assert.equal(one(s.main, 'cal-toolbar'), toolbar);
  assert.equal(one(s.main, 'cal-search'), search);
  assert.equal(search.value, 'lun');
  assert.equal(text(s.main, 'cal-status'), 'Week of Jun 8, 2026 · 1 event in 3 calendars');
  s.ctl.dispose();
});

test('month view: a cell per day, chips per day, "N more", multi-day events on each day, view buttons', async () => {
  const s = await mounted({}, { view: 'month', date: '2026-06-03' });
  assert.ok(one(s.main, 'month-grid'));
  assert.equal(all(s.main, 'month-cell').length, 35);
  const cell = (d) => all(s.main, 'month-cell').find((c) => c.getAttribute('data-date') === d);
  const chipsOn = (d) => cell(d).querySelectorAll('[data-testid="event-chip"]').filter((c) => !c.classList.contains('is-off') && !c.classList.contains('is-over'));
  assert.equal(chipsOn('2026-06-02').length, 1); // the 3-day conference on each of its days
  assert.equal(chipsOn('2026-06-03').length, 1);
  assert.equal(chipsOn('2026-06-04').length, 3);
  const more = cell('2026-06-04').querySelector('[data-testid="month-more"]');
  assert.equal(more.hidden, false); // 4 events on 4 June (conference, other, lunch, mars): 1 more
  assert.equal(more.textContent, '1 more');
  assert.equal(all(s.main, 'month-day').find((n) => n.getAttribute('data-date') === '2026-06-04').getAttribute('aria-label'), 'Thursday, June 4, 4 events');
  assert.equal(one(s.main, 'view-month').getAttribute('aria-current'), 'page');
  assert.equal(text(s.main, 'cal-status').startsWith('June 2026'), true);
  // hiding calendar A keeps the cell and updates the derived bits in place
  const grid = one(s.main, 'month-grid');
  const cb = toggle(s, CAL_A);
  cb.checked = false;
  fire(cb, 'change');
  await flush();
  assert.equal(one(s.main, 'month-grid'), grid);
  assert.equal(cell('2026-06-04').querySelector('[data-testid="month-more"]').hidden, true);
  assert.equal(chipsOn('2026-06-04').length, 1);
  s.ctl.dispose();
});

test('month view on a phone: dots overview and the selected day as a list', async () => {
  const s = await mounted({ phone: true }, { view: 'month', date: '2026-06-04' });
  assert.equal(all(s.main, 'event-chip').length, 0);
  assert.equal(all(s.main, 'event-row').length, 4); // 4 June: conference, other, lunch, mars
  assert.equal(one(s.main, 'month-day-empty').hidden, true);
  assert.equal(all(s.main, 'month-day').find((n) => n.getAttribute('data-date') === '2026-06-04').getAttribute('href'), '#/calendar/month/2026-06-04');
  s.ctl.dispose();
});

test('day view and the phone week (3 days from the date)', async () => {
  const s = await mounted({}, { view: 'day', date: '2026-06-04' });
  assert.ok(one(s.main, 'day-grid'));
  assert.equal(all(s.main, 'week-day').length, 1);
  assert.equal(one(s.main, 'period-heading').getAttribute('class'), 'period period--day');
  s.ctl.dispose();
  const p = await mounted({ phone: true }, WEEK);
  assert.deepEqual(all(p.main, 'week-day').map((n) => n.getAttribute('data-date')), ['2026-06-03', '2026-06-04', '2026-06-05']);
  p.ctl.dispose();
});

test('agenda: 30 days from the date, sections with events only, event-row nodes', async () => {
  const s = await mounted({}, { view: 'agenda', date: '2026-06-01' });
  assert.ok(one(s.main, 'agenda-list'));
  const rows = all(s.main, 'event-row');
  assert.ok(rows.length >= KEYS_ALL);
  assert.equal(rows[0].getAttribute('data-uid') !== null, true);
  const visibleDays = all(s.main, 'event-row').map((r) => r.getAttribute('data-day'));
  assert.ok(visibleDays.includes('2026-06-08')); // the next Monday of the series
  assert.equal(one(s.main, 'agenda-empty').hidden, true);
  s.ctl.dispose();
});

test('display zone: changing it moves the clock times, redraws in place, writes NOTHING', async () => {
  const s = await setup({ prefsValues: {} });
  pushRecent('alice', 'Asia/Kathmandu', { storage: s.deps.storage });
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  const lunch = () => all(s.main, 'event-chip').find((c) => c.getAttribute('data-uid') === 'lunch@example.org');
  assert.match(lunch().getAttribute('aria-label'), /12:00 PM–01:00 PM/);
  const etags = JSON.stringify([...s.env.server.items.entries()].map(([h, i]) => [h, i.etag]));
  const puts = s.env.server.callsOf('PUT').length;
  const sel = one(s.main, 'tz-display');
  assert.deepEqual([...sel.querySelectorAll('option')].map((o) => o.value), ['Europe/Paris', 'Asia/Kathmandu', '__other']);
  choose(sel, 'Asia/Kathmandu');
  await flush();
  assert.match(lunch().getAttribute('aria-label'), /03:45 PM–04:45 PM/);
  assert.equal(JSON.stringify([...s.env.server.items.entries()].map(([h, i]) => [h, i.etag])), etags, 'no ETag changed');
  assert.equal(s.env.server.callsOf('PUT').length, puts, 'no request was sent');
  assert.equal(sel.value, 'Asia/Kathmandu');
  assert.match(s.env.feedback.status.text, /^Times are now shown in Asia\/Kathmandu/);
  assert.equal(one(s.main, 'tz-display'), sel, 'the switcher itself is not rebuilt');
  ctl.dispose();
});

test('search: results as an agenda list in the URL state, the status line counts, cal-no-match when nothing matches', async () => {
  const s = await mounted({}, { ...WEEK, q: 'lunch' });
  assert.ok(one(s.main, 'search-results'));
  const found = all(s.main, 'event-row').map((r) => r.getAttribute('data-uid')).sort();
  assert.deepEqual(found, ['lunch@example.org', 'shared@example.org']);
  assert.equal(text(s.main, 'cal-status'), '2 events match “lunch”.');
  assert.equal(one(s.main, 'cal-no-match').hidden, true);
  assert.equal(one(s.main, 'cal-search').value, 'lunch');
  s.ctl.dispose();
  const n = await mounted({}, { ...WEEK, q: 'zzzz nothing' });
  assert.equal(all(n.main, 'event-row').length, 0);
  assert.equal(one(n.main, 'cal-no-match').hidden, false);
  assert.equal(text(n.main, 'cal-status'), '0 events match “zzzz nothing”.');
  n.ctl.dispose();
});

test('typing in the search box pushes q into the URL (debounced, replace)', async () => {
  const s = await mounted();
  const box = one(s.main, 'cal-search');
  type(box, 'flight');
  assert.equal(s.navs.length, 0);
  await tick(s, 15);
  assert.deepEqual(s.navs.at(-1), { hash: '#/calendar/week/2026-06-03?q=flight', opts: { replace: true } });
  s.ctl.dispose();
});

test('"go to date" navigates to the same view at that date', async () => {
  const s = await mounted();
  const input = one(s.main, 'cal-jump-input');
  type(input, '2026-07-15');
  change(input);
  assert.equal(s.navs.at(-1).hash, '#/calendar/week/2026-07-15');
  s.ctl.dispose();
});

test('a bare #/calendar or a bad view/date is redirected to this week without a history entry', async () => {
  const s = await setup();
  const ctl = mount(s.ctx({}, { name: 'calendar' }), s.deps);
  await flush(40);
  assert.deepEqual(s.navs[0], { hash: '#/calendar/week/2026-06-03', opts: { replace: true } });
  ctl.dispose();
  const bad = await setup();
  const c2 = mount(bad.ctx({ view: 'year', date: '2026-13-40' }), bad.deps);
  await flush(40);
  assert.equal(bad.navs[0].opts.replace, true);
  c2.dispose();
});

test('read-only: when every calendar is read-only New event is disabled with a visible reason', async () => {
  const s = await setup({ items: { [`${CAL_RO}shared.ics`]: single('shared@example.org', 'Shared lunch', { start: '20260603T120000', end: '20260603T130000' }) } });
  s.env.access.calendars = () => s.env.access.list().filter((c) => c.href === CAL_RO);
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  const btn = one(s.main, 'btn-new-event');
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.equal(btn.hasAttribute('href'), false);
  assert.equal(one(s.main, 'calendar-readonly').hidden, false);
  assert.equal(btn.getAttribute('aria-describedby'), one(s.main, 'calendar-readonly').getAttribute('id'));
  ctl.dispose();
});

test('New event keeps its link when a calendar is writable and carries the date and the calendar', async () => {
  const s = await mounted();
  const btn = one(s.main, 'btn-new-event');
  assert.equal(btn.getAttribute('href'), `#/events/new?date=2026-06-03&cal=${encodeURIComponent(CAL_A)}`);
  assert.equal(one(s.main, 'calendar-readonly').hidden, true);
  s.ctl.dispose();
});

test('no calendar at all: calendar-empty with a create button (own space), calendar-noaccess without', async () => {
  const s = await setup({ items: {} });
  s.env.access.calendars = () => [];
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  assert.ok(one(s.main, 'calendar-empty'));
  assert.equal(one(s.main, 'btn-new-calendar').getAttribute('href'), '#/collections/new-calendar');
  assert.equal(one(s.main, 'callist-none').hidden, false);
  ctl.dispose();
  const n = await setup({ items: {} });
  n.env.access.calendars = () => [];
  n.env.access.canCreateCollections = () => false;
  const c2 = mount(n.ctx(WEEK), n.deps);
  await flush(40);
  assert.ok(one(n.main, 'calendar-noaccess'));
  c2.dispose();
});

test('every calendar fails to load: calendar-error with a retry that loads again', async () => {
  const s = await setup();
  const orig = s.env.server.client.syncCollection;
  const origList = s.env.server.client.listItemEtags;
  s.env.server.client.syncCollection = async () => {
    throw new DavError('server', { status: 500 });
  };
  s.env.server.client.listItemEtags = async () => {
    throw new DavError('server', { status: 500 });
  };
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(60);
  assert.equal(s.main.querySelector('[data-testid="calendar-screen"]').getAttribute('data-state'), 'error');
  assert.ok(one(s.main, 'calendar-error'));
  assert.equal(all(s.main, 'calendar-failed').filter((n) => !n.hidden).length, 3);
  s.env.server.client.syncCollection = orig;
  s.env.server.client.listItemEtags = origList;
  fire(one(s.main, 'btn-retry'), 'click');
  await flush(60);
  assert.equal(s.main.querySelector('[data-testid="calendar-screen"]').getAttribute('data-state'), 'ready');
  assert.equal(keysOf(s.main).length, KEYS_ALL);
  assert.equal(one(s.main, 'calendar-error'), null);
  ctl.dispose();
});

test('offline with nothing loaded says so', async () => {
  const s = await setup({ online: false });
  const orig = s.env.access.load;
  s.env.access.load = async () => {
    throw new DavError('network', { message: 'offline' });
  };
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  assert.ok(one(s.main, 'calendar-offline'));
  assert.equal(text(s.main, 'calendar-offline').includes('offline'), true);
  assert.ok(one(s.main, 'btn-retry'));
  s.env.access.load = orig;
  ctl.dispose();
});

test('the calendar list: fold button cycles open, rail, hidden and persists the choice; aria-expanded follows', async () => {
  const s = await mounted();
  const list = one(s.main, 'calendar-list');
  const fold = one(s.main, 'btn-toggle-callist');
  assert.equal(fold.getAttribute('aria-controls'), 'cal-list-body');
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  fire(fold, 'click');
  assert.equal(list.getAttribute('data-list-state'), 'rail');
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.equal(s.prefs.get('cal.listState'), 'rail');
  assert.equal(text(s.main, 'callist-live'), 'Calendar list folded to colour dots.');
  fire(fold, 'click');
  assert.equal(s.prefs.get('cal.listState'), 'hidden');
  fire(fold, 'click');
  assert.equal(s.prefs.get('cal.listState'), 'open');
  assert.equal(s.root.getAttribute('data-list-state'), 'open');
  s.ctl.dispose();
});

test('the checkbox colour comes through the whitelist: a hostile colour is dropped, a hex colour applied', async () => {
  const s = await setup();
  s.env.access.calendars = () => s.env.access.list().filter((c) => c.kind === 'calendar').map((c, i) => ({ ...c, color: i === 0 ? 'red; background:url(//x)' : '#009e73' }));
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(40);
  const boxes = all(s.main, 'calendar-toggle');
  assert.equal(boxes[0].styleProps.has('--cal'), true); // the fallback colour, never the hostile text
  assert.notEqual(boxes[0].styleProps.get('--cal'), 'red; background:url(//x)');
  assert.equal(boxes[1].styleProps.get('--cal'), '#009e73');
  ctl.dispose();
});

test('birthdays: a row, the virtual events, the duplicate filter and its live announcement; the data stays read-only', async () => {
  const s = await setup({ items: { ...{ [`${CAL_A}bd.ics`]: `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example//EN\nBEGIN:VEVENT\nUID:bd@example.org\nDTSTAMP:20260101T000000Z\nDTSTART;VALUE=DATE:20260604\nRRULE:FREQ=YEARLY\nSUMMARY:Birthday Jo Example\nEND:VEVENT\nEND:VCALENDAR\n` } } });
  const book = '/alice/book/';
  const card = (uid, fn, bday) => `BEGIN:VCARD\nVERSION:3.0\nUID:${uid}\nFN:${fn}\nN:${fn.split(' ').reverse().join(';')};;;\nBDAY:${bday}\nEND:VCARD\n`;
  s.env.server.client.getCollection = s.env.server.client.getCollection;
  const bookStore = {
    loaded: true,
    list: () => [
      { href: `${book}jo.vcf`, etag: '"1"', text: card('jo-uid', 'Jo Example', '1990-06-04') },
      { href: `${book}max.vcf`, etag: '"2"', text: card('max-uid', 'Max Sample', '--06-05') },
    ],
    sync: async () => ({ ok: true }),
    get: () => null,
  };
  s.env.access.addressbooks = () => [{ href: book, kind: 'addressbook', level: 'own' }];
  const open = s.storeCtx.stores.open.bind(s.storeCtx.stores);
  s.storeCtx.stores.open = (o) => (o.kind === 'addressbook' ? bookStore : open(o));
  const get = s.storeCtx.stores.get.bind(s.storeCtx.stores);
  s.storeCtx.stores.get = (h) => (h === book ? bookStore : get(h));
  const ctl = mount(s.ctx(WEEK), s.deps);
  await flush(60);
  const rows = all(s.main, 'calendar-toggle').map((n) => n.getAttribute('data-href'));
  assert.ok(rows.includes('birthdays'));
  const names = () => all(s.main, 'event-chip').filter((c) => c.getAttribute('data-calendar') === 'birthdays' && !c.classList.contains('is-off')).map((c) => c.querySelector('.chip__title').textContent);
  assert.deepEqual(names(), ['Max Sample']); // Jo's birthday is already a yearly all-day event: hidden by default
  const dup = one(s.main, 'bday-hide-duplicates');
  assert.equal(dup.checked, true);
  dup.checked = false;
  fire(dup, 'change');
  await flush();
  assert.deepEqual(names().sort(), ['Jo Example – 36', 'Max Sample']);
  assert.match(text(s.main, 'callist-live'), /Birthdays already in a real calendar are shown/);
  const bday = all(s.main, 'event-chip').find((c) => c.getAttribute('data-calendar') === 'birthdays');
  assert.equal(bday.getAttribute('data-readonly'), 'true');
  assert.match(bday.getAttribute('href'), /^#\/events\/(max-uid|jo-uid)\?cal=birthdays&occ=2026-06-0[45]$/);
  assert.equal(s.env.server.callsOf('PUT').length, 0);
  ctl.dispose();
});

test('dispose releases what the screen enabled and removes its DOM', async () => {
  const s = await mounted();
  assert.equal(s.calendars.enabledHrefs().length, 3);
  s.ctl.dispose();
  assert.equal(s.calendars.enabledHrefs().length, 0);
  assert.equal(s.main.querySelector('[data-testid="calendar-screen"]'), null);
});

test('the source: the route key is the UID when unique in its calendar, else the file name', async () => {
  const s = await setup({ items: { [`${CAL_A}a.ics`]: single('same@example.org', 'One'), [`${CAL_A}b.ics`]: single('same@example.org', 'Two'), [`${CAL_A}c.ics`]: single('solo@example.org', 'Three') } });
  const src = createCalendarSource({ storeCtx: s.storeCtx, app: s.app, t: s.t });
  await src.load(CAL_A);
  const r = src.records({ from: Date.parse('2026-06-01T00:00:00Z'), to: Date.parse('2026-06-10T00:00:00Z'), range: { start: '2026-06-01', end: '2026-06-10' }, tz: 'Europe/Paris', lang: 'en', use24h: true });
  assert.deepEqual(r.records.map((x) => x.routeKey).sort(), ['a.ics', 'b.ics', 'solo@example.org']);
  assert.equal((await src.resolveEvent({ key: 'solo@example.org', cal: CAL_A })).state, 'ok');
  assert.equal((await src.resolveEvent({ key: 'same@example.org', cal: CAL_A })).state, 'notfound'); // not unique: only the file name works
  assert.equal((await src.resolveEvent({ key: 'b.ics', cal: CAL_A })).entry.href, `${CAL_A}b.ics`);
  assert.equal((await src.resolveEvent({ key: 'solo@example.org', cal: '/alice/elsewhere/' })).state, 'nocalendar');
  assert.equal((await src.resolveEvent({ key: 'x'.repeat(300), cal: CAL_A })).state, 'notfound');
  src.dispose();
  assert.equal(NOW > 0, true);
});
