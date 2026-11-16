// SPDX-License-Identifier: AGPL-3.0-or-later
// The event form (WP B3b): the form state of every fixture class, minimal patches, ONE request per save through the real write
// path, the scope questions, the DST-gap preview, validation, conflicts, read-only states, the unsaved-input guard and the
// language-switch snapshot. The write path is the real one over the in-memory calendar server of the store tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { change, chooseRadio, choose, fire, type } from '../widgets/_dom.mjs';
import { mount, durationText, previewText, resolveUse24h, restoreBlocksSplit, tzLimitYear } from '../../../src/js/views/calendar/form.js';
import { CAL_A, CAL_B, CAL_RO, baseOf, doc, dlg, flush, fx, memoryStorage, q, qa, setup } from './event-helpers.mjs';
import { override, paris, single, unknownZone, weekly } from '../store/_cal.mjs';
import en from '../../../src/i18n/en.js';

const H24 = { get: (n, f) => (n === 'cal.use24h' ? true : f), set() {}, remove() {}, subscribe: () => () => {} };
const EDIT = { name: 'event-edit' };
const NEW = { name: 'event-new' };
const puts = (s) => s.env.server.callsOf('PUT');
const open = async (s, params, route = EDIT, over = {}, extra = {}) => {
  const ctl = mount(s.ctx(params, route, extra), { ...s.deps, ...over });
  await flush(40);
  return ctl;
};
const submit = async (s) => {
  fire(q(s.main, 'event-form'), 'submit');
  await flush(60);
};
const server = (s, href) => s.env.server.at(href).text;
const WEEK = CAL_A + 'week.ics';
const SINGLE = CAL_A + 'single.ics';
const UID = 'series-1@example.org';
const typeInto = (s, id, text) => {
  const el = q(s.main, id);
  type(el, text);
  change(el);
};

test('a zoned event with two zones: each zone is shown as its own, nothing is rewritten, saving unchanged sends nothing', async () => {
  const s = await setup({ items: { [SINGLE]: fx('event-two-zones.ics') }, prefs: H24 });
  const ctl = await open(s, { key: 'two-zones@example.org', cal: CAL_A });
  assert.equal(q(s.main, 'event-form-screen').getAttribute('data-state'), 'ready');
  assert.equal(q(s.main, 'field-title').value, 'Flight with two zones');
  assert.equal(q(s.main, 'field-tz-start').getAttribute('data-zone'), 'America/New_York');
  assert.equal(q(s.main, 'field-tz-end').getAttribute('data-zone'), 'Asia/Tokyo');
  assert.equal(q(s.main, 'field-start-time-input').value, '08:00');
  assert.equal(q(s.main, 'field-end-time-input').value, '23:00');
  assert.equal(q(s.main, 'field-allday').checked, false);
  assert.match(q(s.main, 'event-when-preview').textContent, /America\/New_York = \d\d:\d\d your time to .*Asia\/Tokyo = \d\d:\d\d your time · 2 h/);
  assert.equal(q(s.main, 'scope-notice'), null);
  assert.equal(ctl.form.state.scope, null);
  await submit(s);
  assert.equal(puts(s).length, 0, 'no request');
  assert.equal(s.navs.length, 0);
  assert.match(q(s.main, 'form-status').textContent, /No changes|unchanged|nothing/i);
});

test('an all-day event: the all-day box is ticked, the end date is inclusive and the time fields are hidden', async () => {
  const s = await setup({ items: { [SINGLE]: fx('event-allday-multiday.ics') }, prefs: H24 });
  await open(s, { key: 'allday-multi@example.org', cal: CAL_A });
  const f = q(s.main, 'event-form');
  assert.ok(f, 'form shown');
  assert.equal(q(s.main, 'field-allday').checked, true);
  assert.equal(q(s.main, 'field-start-time').hidden, true);
  assert.equal(q(s.main, 'field-tz-start').parentNode.hidden, true);
  assert.match(q(s.main, 'event-when-preview').textContent, /^All day, \d+ days\.$/);
  await submit(s);
  assert.equal(puts(s).length, 0);
});

test('a floating event is shown at its own clock time with the floating label; a title change keeps it floating', async () => {
  const s = await setup({ items: { [SINGLE]: fx('event-floating.ics') }, prefs: H24 });
  await open(s, { key: 'floating@example.org', cal: CAL_A });
  assert.equal(q(s.main, 'field-tz-start').getAttribute('data-zone'), '');
  assert.equal(q(s.main, 'field-tz-start').textContent, 'Floating time (no zone)');
  assert.match(q(s.main, 'event-when-preview').textContent, /^Floating time:/);
  typeInto(s, 'field-title', 'Floating, renamed');
  await submit(s);
  assert.equal(puts(s).length, 1);
  const text = server(s, SINGLE);
  assert.match(text, /SUMMARY:Floating\\, renamed/);
  assert.doesNotMatch(text, /DTSTART;TZID/);
  assert.doesNotMatch(text, /DTSTART:\d{8}T\d{6}Z/);
});

test('a custom rule is shown as such and an edit of another field never re-emits it', async () => {
  const s = await setup({ items: { [SINGLE]: fx('event-custom-rrule.ics') }, prefs: H24 });
  await open(s, { key: 'custom-rrule@example.org', cal: CAL_A, scope: 'all' });
  assert.equal(q(s.main, 'rec-custom').hidden, false);
  assert.match(q(s.main, 'rec-custom-raw').textContent, /BYSETPOS=-1/);
  assert.equal(q(s.main, 'rec-details').hidden, true);
  assert.equal(q(s.main, 'rec-summary').textContent, 'Custom rule (kept as is)');
  assert.ok(q(s.main, 'btn-replace-rule'));
  typeInto(s, 'field-title', 'Last weekday, renamed');
  await submit(s);
  assert.equal(puts(s).length, 1);
  assert.match(server(s, SINGLE), /RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=10/);
});

test('"Replace with a simple rule" turns the builder on and the summary changes', async () => {
  const s = await setup({ items: { [SINGLE]: fx('event-custom-rrule.ics') }, prefs: H24 });
  const ctl = await open(s, { key: 'custom-rrule@example.org', cal: CAL_A, scope: 'all' });
  fire(q(s.main, 'btn-replace-rule'), 'click');
  assert.equal(q(s.main, 'rec-custom').hidden, true);
  assert.equal(q(s.main, 'rec-details').hidden, false);
  assert.match(q(s.main, 'rec-summary').textContent, /^Every week on /);
  assert.equal(ctl.form.collect().rule.mode, 'builder');
  await submit(s);
  assert.equal(puts(s).length, 1);
  assert.doesNotMatch(server(s, SINGLE), /BYSETPOS/);
  assert.match(server(s, SINGLE), /RRULE:FREQ=WEEKLY;BYDAY=\w\w/);
});

test('scope "this" on a series: no builder, the notice names the occurrence, one override in the same resource', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 6 }) }, prefs: H24 });
  await open(s, { key: UID, cal: CAL_A, occ: '2026-03-09T09:30:00', scope: 'this' });
  assert.equal(q(s.main, 'recurrence-builder'), null);
  assert.match(q(s.main, 'scope-notice').textContent, /only the occurrence of/);
  assert.equal(q(s.main, 'field-start-date-input').value, '03/09/2026');
  typeInto(s, 'field-title', 'Moved sync');
  await submit(s);
  assert.equal(puts(s).length, 1);
  const text = server(s, WEEK);
  assert.match(text, /RECURRENCE-ID;TZID=Europe\/Paris:20260309T093000/);
  assert.match(text, /SUMMARY:Moved sync/);
  assert.match(text, /SUMMARY:Weekly sync/);
  assert.equal(s.env.server.hrefsIn(CAL_A).length, 1);
  assert.match(s.navs.at(-1).hash, /^#\/events\/series-1%40example\.org\?cal=.*occ=2026-03-09T09%3A30%3A00/);
});

test('scope "following": two resources afterwards, the tail starts at the occurrence, one navigation to the tail', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 6 }) }, prefs: H24 });
  await open(s, { key: UID, cal: CAL_A, occ: '2026-03-16T09:30:00', scope: 'following' });
  assert.match(q(s.main, 'scope-notice').textContent, /this and all following/);
  assert.ok(q(s.main, 'recurrence-builder'));
  typeInto(s, 'field-title', 'Tail title');
  await submit(s);
  const hrefs = s.env.server.hrefsIn(CAL_A);
  assert.equal(hrefs.length, 2);
  const tail = hrefs.find((h) => h !== WEEK);
  assert.match(server(s, tail), /SUMMARY:Tail title/);
  assert.match(server(s, tail), /DTSTART;TZID=Europe\/Paris:20260316T093000/);
  assert.match(server(s, WEEK), /UNTIL=/);
  assert.doesNotMatch(server(s, WEEK), /Tail title/);
  assert.match(s.navs.at(-1).hash, /^#\/events\//);
  assert.doesNotMatch(s.navs.at(-1).hash, new RegExp(UID.replace(/[.@]/g, '.')));
});

test('scope "all" with a later start: ONE request, the EXDATE moves by the same delta (no dialog when nothing is orphaned)', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 8, exdates: ['20260316T093000'] }) }, prefs: H24 });
  await open(s, { key: UID, cal: CAL_A, scope: 'all' });
  assert.equal(qa(s.main, 'exception-row').length, 1);
  typeInto(s, 'field-start-time-input', '10:30');
  assert.equal(q(s.main, 'field-end-time-input').value, '11:30', 'the end keeps its distance from the start');
  await submit(s);
  assert.equal(dlg('dialog-rule-exceptions'), null);
  assert.equal(puts(s).length, 1);
  const text = server(s, WEEK);
  assert.match(text, /DTSTART;TZID=Europe\/Paris:20260302T103000/);
  assert.match(text, /EXDATE;TZID=Europe\/Paris:20260316T103000/);
});

test('rule change with an exception that would be orphaned: the dialog does not default to Keep; Cancel sends nothing; remove-orphans drops it', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 8, exdates: ['20260316T093000'] }) }, prefs: H24 });
  await open(s, { key: UID, cal: CAL_A, scope: 'all' });
  // Mondays -> Tuesdays: the skipped Monday is no longer an occurrence
  fire(q(s.main, 'rec-day-mo'), 'change', {});
  q(s.main, 'rec-day-mo').checked = false;
  q(s.main, 'rec-day-tu').checked = true;
  change(q(s.main, 'rec-day-tu'));
  const p = submit(s);
  await flush(20);
  const d = dlg('dialog-rule-exceptions');
  assert.ok(d, 'dialog open');
  assert.ok(qa(d, 'exception-item').length >= 1);
  assert.equal(doc.activeElement, q(d, 'exceptions-cancel'), 'Cancel is focused: no default to Keep');
  assert.doesNotMatch(q(d, 'exceptions-keep').className, /btn--primary/);
  q(d, 'exceptions-cancel').click();
  await p;
  assert.equal(puts(s).length, 0);
  assert.equal(dlg('dialog-rule-exceptions'), null);
  const p2 = submit(s);
  await flush(20);
  const d2 = dlg('dialog-rule-exceptions');
  assert.ok(d2);
  const target = q(d2, 'exceptions-remove-orphans') || q(d2, 'exceptions-remove');
  target.click();
  await p2;
  assert.equal(puts(s).length, 1);
  assert.doesNotMatch(server(s, WEEK), /EXDATE/);
  assert.match(server(s, WEEK), /BYDAY=TU/);
});

test('bringing back a skipped date is one removeExdate in the same single request', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 8, exdates: ['20260316T093000'] }) }, prefs: H24 });
  const ctl = await open(s, { key: UID, cal: CAL_A, scope: 'all' });
  fire(q(s.main, 'btn-restore-exception'), 'click');
  assert.equal(qa(s.main, 'exception-row').length, 0);
  assert.equal(ctl.form.collect().summary, 'Weekly sync');
  await submit(s);
  assert.equal(puts(s).length, 1);
  assert.doesNotMatch(server(s, WEEK), /EXDATE/);
});

test('the DST gap shows as TEXT in the preview ("does not exist ... stored as"), the start zone being the display zone', async () => {
  const s = await setup({ prefs: H24, items: { [CAL_A + 'x.ics']: single('x@example.org') } });
  await open(s, { date: '2026-03-29', time: '02:30' }, NEW);
  const text = q(s.main, 'event-when-preview').textContent;
  assert.match(text, /02:30 does not exist in Europe\/Paris on .*; it will be stored as 03:30\./);
  assert.equal(q(s.main, 'event-when-preview').getAttribute('data-gap'), 'true');
  assert.equal(q(s.main, 'event-when-preview').getAttribute('aria-live'), 'polite');
});

test('previewText: a repeated hour (overlap), a different end zone, floating and all-day wording; durationText', () => {
  const t = (k, p) => `${k}${p ? JSON.stringify(p) : ''}`;
  const tp = (k, n) => `${k}#${n}`;
  assert.equal(durationText(5400, (k, p) => `${p.n}${k.split('.').pop()}`), '1h 30min');
  assert.equal(durationText(2700, (k, p) => `${p.n}${k.split('.').pop()}`), '45min');
  assert.equal(durationText(90000, (k, p) => `${p.n}${k.split('.').pop()}`), '1d 1h');
  const info = { allDay: false, durationSec: 3600, start: { iso: '2026-10-25T02:30:00' }, end: { iso: '2026-10-25T03:30:00' }, display: { start: '2026-10-25T02:30:00', end: '2026-10-25T03:30:00' }, startOverlap: { wall: '2026-10-25T02:30:00', tzid: 'Europe/Paris' } };
  const out = previewText(info, { startTz: 'Europe/Paris', endTz: 'Europe/Paris' }, { t, tp, lang: 'en', use24h: true, displayTz: 'Europe/Paris' });
  assert.match(out, /event\.preview\.overlap/);
  assert.match(previewText({ ...info, allDay: true, durationSec: 172800 }, {}, { t, tp, lang: 'en' }), /allDayMany#2/);
  assert.match(previewText({ ...info, startOverlap: undefined }, { startTz: '', endTz: '' }, { t, tp, lang: 'en', use24h: true, displayTz: 'x' }), /event\.preview\.floating/);
  assert.equal(previewText(null, {}, { t, tp }), '');
  // the end before the start: a plain message, never a negative or zero duration (timed and all-day)
  assert.equal(previewText({ ...info, durationSec: -172800 }, { startTz: 'Europe/Paris', endTz: 'Europe/Paris' }, { t, tp, lang: 'en', use24h: true, displayTz: 'Europe/Paris' }), 'event.preview.endBeforeStart');
  assert.equal(previewText({ ...info, allDay: true, durationSec: -86400 }, {}, { t, tp, lang: 'en' }), 'event.preview.endBeforeStart');
  assert.doesNotMatch(previewText({ ...info, durationSec: 0 }, { startTz: 'Europe/Paris', endTz: 'Europe/Paris' }, { t, tp, lang: 'en', use24h: true, displayTz: 'Europe/Paris' }), /endBeforeStart/);
  assert.equal(resolveUse24h(true, 'en'), true);
  assert.equal(resolveUse24h(false, 'fr'), false);
  assert.equal(resolveUse24h(null, 'fr'), true);
});

test('a new event: ONE create request, TZID of the display zone, the user lands on the event', async () => {
  const s = await setup({ prefs: H24, items: { [CAL_A + 'x.ics']: single('x@example.org') } });
  await open(s, { date: '2026-06-20', time: '14:00', cal: CAL_B }, NEW);
  assert.equal(q(s.main, 'field-calendar').value, CAL_B);
  assert.equal(q(s.main, 'field-end-time-input').value, '15:00');
  typeInto(s, 'field-title', 'Planning');
  typeInto(s, 'field-location', 'Room 2');
  await submit(s);
  assert.equal(puts(s).length, 1);
  const [href] = s.env.server.hrefsIn(CAL_B);
  assert.ok(href, 'created in the chosen calendar');
  const text = server(s, href);
  assert.match(text, /DTSTART;TZID=Europe\/Paris:20260620T140000/);
  assert.match(text, /DTEND;TZID=Europe\/Paris:20260620T150000/);
  assert.match(text, /SUMMARY:Planning/);
  assert.match(s.navs.at(-1).hash, /^#\/events\/.*\?cal=/);
  assert.equal(s.dirty.at(-1), false);
});

test('validation: a missing title and an end before the start are named, linked and nothing is sent', async () => {
  const s = await setup({ prefs: H24, items: { [CAL_A + 'x.ics']: single('x@example.org') } });
  await open(s, { date: '2026-06-20', time: '14:00' }, NEW);
  typeInto(s, 'field-end-time-input', '13:00');
  await submit(s);
  assert.equal(puts(s).length, 0);
  const errs = q(s.main, 'form-errors');
  assert.equal(errs.hidden, false);
  assert.match(errs.textContent, /2 fields need attention/);
  assert.match(errs.textContent, /Title: Enter a title\./);
  assert.match(errs.textContent, /End time: The end must be after the start/);
  assert.equal(q(s.main, 'field-title').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.activeElement, q(s.main, 'field-title'));
  assert.equal(qa(s.main, 'form-error-link').length, 2);
  typeInto(s, 'field-url', 'javascript:alert(1)');
  typeInto(s, 'field-title', 'T');
  typeInto(s, 'field-end-time-input', '15:00');
  await submit(s);
  assert.match(q(s.main, 'form-errors').textContent, /not allowed/);
  assert.equal(puts(s).length, 0);
});

test('an end before the start: the preview line says so in words (polite live region), then returns to the times', async () => {
  const s = await setup({ prefs: H24, items: { [CAL_A + 'x.ics']: single('x@example.org') } });
  await open(s, { date: '2026-06-20', time: '14:00' }, NEW);
  typeInto(s, 'field-end-time-input', '13:00');
  const el = q(s.main, 'event-when-preview');
  assert.equal(el.textContent, en['event.preview.endBeforeStart']);
  assert.doesNotMatch(el.textContent, /min|\u00b7/);
  assert.equal(el.getAttribute('aria-live'), 'polite');
  typeInto(s, 'field-end-time-input', '15:00');
  assert.match(el.textContent, /1 h/);
});

test('picking another start zone rewrites only that zone; the end zone follows it until it was chosen on its own', async () => {
  const s = await setup({ prefs: H24, items: { [SINGLE]: single('one@example.org') } });
  await open(s, { key: 'one@example.org', cal: CAL_A }, EDIT, { zonePick: async () => 'Asia/Kathmandu' });
  assert.equal(q(s.main, 'field-tz-start').getAttribute('data-zone'), 'Europe/Paris');
  fire(q(s.main, 'field-tz-start'), 'click');
  await flush(10);
  assert.equal(q(s.main, 'field-tz-start').getAttribute('data-zone'), 'Asia/Kathmandu');
  assert.equal(q(s.main, 'field-tz-end').getAttribute('data-zone'), 'Asia/Kathmandu');
  await submit(s);
  assert.equal(puts(s).length, 1);
  const text = server(s, SINGLE);
  assert.match(text, /DTSTART;TZID=Asia\/Kathmandu:20260604T120000/);
  assert.match(text, /DTEND;TZID=Asia\/Kathmandu:20260604T130000/);
});

test('m2: a zone whose generated VTIMEZONE is not periodic shows the persistent "exact up to {year}" line; a periodic zone hides it; all-day hides it', async () => {
  const s = await setup({ prefs: H24, items: { [SINGLE]: single('one@example.org') } });
  let pick = 'Africa/Casablanca';
  await open(s, { key: 'one@example.org', cal: CAL_A }, EDIT, { zonePick: async () => pick });
  const line = q(s.main, 'event-tz-limit');
  assert.equal(line.hidden, true);
  fire(q(s.main, 'field-tz-start'), 'click');
  await flush(10);
  assert.equal(line.hidden, false);
  assert.match(line.textContent, /^Clock changes in this zone are exact up to \d{4}\.$/);
  assert.equal(line.getAttribute('role'), 'status');
  pick = 'Europe/Paris';
  fire(q(s.main, 'field-tz-start'), 'click');
  await flush(10);
  fire(q(s.main, 'field-tz-end'), 'click');
  await flush(10);
  assert.equal(line.hidden, true);
  assert.equal(tzLimitYear('Europe/Paris'), null);
  assert.equal(tzLimitYear(''), null);
  assert.equal(typeof tzLimitYear('Africa/Casablanca'), 'number');
  assert.equal(tzLimitYear('Mars/Olympus'), null);
});

test('m4: restored exceptions cannot travel with a split: the form refuses (helper) instead of dropping them', () => {
  assert.equal(restoreBlocksSplit({ action: 'split' }, [{ type: 'removeExdate' }]), true);
  assert.equal(restoreBlocksSplit({ action: 'split' }, []), false);
  assert.equal(restoreBlocksSplit({ action: 'ops', ops: [] }, [{ type: 'removeExdate' }]), false);
  assert.ok(en['event.err.restore-needs-scope']);
});

test('ticking "all day" on a timed event writes dates (DTEND exclusive) and a timed one again restores the times', async () => {
  const s = await setup({ prefs: H24, items: { [SINGLE]: single('one@example.org') } });
  await open(s, { key: 'one@example.org', cal: CAL_A });
  const box = q(s.main, 'field-allday');
  box.checked = true;
  change(box);
  assert.equal(q(s.main, 'field-start-time').hidden, true);
  assert.match(q(s.main, 'event-when-preview').textContent, /All day/);
  box.checked = false;
  change(box);
  assert.equal(q(s.main, 'field-start-time-input').value, '12:00');
  assert.equal(q(s.main, 'field-tz-start').getAttribute('data-zone'), 'Europe/Paris');
  box.checked = true;
  change(box);
  await submit(s);
  assert.equal(puts(s).length, 1);
  assert.match(server(s, SINGLE), /DTSTART;VALUE=DATE:20260604/);
  assert.match(server(s, SINGLE), /DTEND;VALUE=DATE:20260605/);
});

test('an outside change while the form is open: the shared conflict dialog opens and "Overwrite with mine" replays on theirs', async () => {
  const s = await setup({ prefs: H24, items: { [SINGLE]: single('one@example.org') } });
  await open(s, { key: 'one@example.org', cal: CAL_A });
  s.env.server.outside(SINGLE, single('one@example.org', 'Lunch', { extra: 'LOCATION:Elsewhere\n' }));
  typeInto(s, 'field-title', 'My title');
  const p = submit(s);
  await flush(40);
  const d = dlg('dialog-conflict');
  assert.ok(d, 'conflict dialog');
  q(d, 'conflict-overwrite').click();
  await p;
  await flush(40);
  const text = server(s, SINGLE);
  assert.match(text, /SUMMARY:My title/);
  assert.match(text, /LOCATION:Elsewhere/);
  assert.match(s.navs.at(-1).hash, /^#\/events\//);
});

test('unsaved input is guarded (setDirty) and survives a language switch (snapshot/restore keeps the base)', async () => {
  const s = await setup({ prefs: H24, items: { [SINGLE]: single('one@example.org') } });
  const ctl = await open(s, { key: 'one@example.org', cal: CAL_A });
  assert.deepEqual(s.dirty.filter(Boolean), []);
  typeInto(s, 'field-title', 'Typed but not saved');
  await flush(5);
  assert.equal(s.dirty.at(-1), true);
  const snap = ctl.snapshot();
  ctl.dispose();
  assert.equal(s.dirty.at(-1), false, 'the guard is released with the screen');
  const baseEtag = snap.base.etag;
  s.env.server.outside(SINGLE, single('one@example.org', 'Lunch', { extra: 'LOCATION:Late edit\n' }));
  const ctl2 = await open(s, { key: 'one@example.org', cal: CAL_A }, EDIT, {}, { restore: snap });
  assert.equal(q(s.main, 'field-title').value, 'Typed but not saved');
  assert.equal(ctl2.form.fields.get('field-title').control.value, 'Typed but not saved');
  assert.equal(ctl2.snapshot().base.etag, baseEtag, 'the version the user started from is kept');
  await flush(5);
  assert.equal(s.dirty.at(-1), true);
});

test('read-only: a calendar shared read-only, an event with an unknown time zone, and an unknown event', async () => {
  const s = await setup({ prefs: H24, items: { [CAL_RO + 'ro.ics']: single('ro@example.org'), [CAL_A + 'mars.ics']: unknownZone('mars@example.org') } });
  await open(s, { key: 'ro@example.org', cal: CAL_RO });
  assert.ok(q(s.main, 'event-readonly'));
  assert.equal(q(s.main, 'event-form'), null);
  assert.match(q(s.main, 'event-readonly').textContent, /read-only for you/);
  const s2 = await setup({ prefs: H24, items: { [CAL_A + 'mars.ics']: unknownZone('mars@example.org') } });
  await open(s2, { key: 'mars@example.org', cal: CAL_A });
  assert.ok(q(s2.main, 'event-readonly'));
  assert.match(q(s2.main, 'event-readonly').textContent, /time zone that this browser does not know/);
  assert.equal(q(s2.main, 'event-form'), null);
  const s3 = await setup({ prefs: H24, items: { [CAL_A + 'x.ics']: single('x@example.org') } });
  await open(s3, { key: 'nope', cal: CAL_A });
  assert.ok(q(s3.main, 'event-form-notfound'));
  await open(s3, { key: 'x@example.org', cal: '/alice/not-a-calendar/' });
  assert.ok(q(s3.main, 'event-form-notfound'));
});

test('categories, status and a third reminder are edited in the same single request', async () => {
  const s = await setup({ prefs: H24, items: { [SINGLE]: single('one@example.org') } });
  await open(s, { key: 'one@example.org', cal: CAL_A });
  choose(q(s.main, 'field-status'), 'TENTATIVE');
  const cat = q(s.main, 'field-categories');
  type(cat, 'Work');
  fire(cat, 'keydown', { key: 'Enter' });
  fire(q(s.main, 'btn-add-alarm'), 'click');
  choose(q(s.main, 'field-alarm-1'), '15m');
  await submit(s);
  assert.equal(puts(s).length, 1);
  const text = server(s, SINGLE);
  assert.match(text, /STATUS:TENTATIVE/);
  assert.match(text, /CATEGORIES:Work/);
  assert.match(text, /BEGIN:VALARM/);
  assert.match(text, /TRIGGER:-PT15M/);
});

test('a read grantee has no writable calendar for a new event', async () => {
  const s = await setup({ prefs: H24 });
  // every writable calendar is hidden from the access list of this account
  s.storeCtx.access.calendars = () => [];
  await open(s, { date: '2026-06-20' }, NEW);
  assert.ok(q(s.main, 'event-readonly'));
  assert.equal(q(s.main, 'event-form'), null);
});

test('a lost response after a create keeps the form locked and retries with the SAME retry token', async () => {
  const s = await setup({ prefs: H24, items: { [CAL_A + 'x.ics']: single('x@example.org') } });
  await open(s, { date: '2026-06-20', time: '14:00' }, NEW);
  typeInto(s, 'field-title', 'Once only');
  s.env.server.loseResponse((href, opts) => opts && opts.create);
  await submit(s);
  assert.equal(q(s.main, 'event-save').textContent, 'Try again');
  assert.equal(puts(s).length, 1);
  await submit(s);
  const created = s.env.server.hrefsIn(CAL_A).filter((h) => h !== CAL_A + 'x.ics');
  assert.equal(created.length, 1, 'one event, not two');
  assert.match(s.navs.at(-1).hash, /^#\/events\//);
});

test('the form never leaves a dialog or a guard behind after dispose', async () => {
  const s = await setup({ prefs: H24, items: { [WEEK]: weekly(UID, { count: 8, exdates: ['20260316T093000'] }) } });
  const ctl = await open(s, { key: UID, cal: CAL_A, scope: 'all' });
  typeInto(s, 'field-title', 'x');
  await flush(5);
  ctl.dispose();
  assert.equal(s.dirty.at(-1), false);
  assert.equal(q(s.main, 'event-form-screen'), null);
});

test('scope "following" with a later start: the exceptions of the TAIL move with it (addendum M1), two requests for two resources', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 8, exdates: ['20260330T093000'] }) }, prefs: H24 });
  await open(s, { key: UID, cal: CAL_A, occ: '2026-03-16T09:30:00', scope: 'following' });
  typeInto(s, 'field-start-time-input', '10:30');
  await submit(s);
  assert.equal(puts(s).length, 2, 'tail created, then the truncated original');
  const tail = s.env.server.hrefsIn(CAL_A).find((h) => h !== WEEK);
  assert.match(server(s, tail), /DTSTART;TZID=Europe\/Paris:20260316T103000/);
  assert.match(server(s, tail), /EXDATE;TZID=Europe\/Paris:20260330T103000/);
  assert.doesNotMatch(server(s, WEEK), /EXDATE/);
});

test('scope "following" with a rule change that orphans a skipped date of the tail: the dialog opens and Cancel sends nothing', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 8, exdates: ['20260330T093000'] }) }, prefs: H24 });
  await open(s, { key: UID, cal: CAL_A, occ: '2026-03-16T09:30:00', scope: 'following' });
  q(s.main, 'rec-day-mo').checked = false;
  q(s.main, 'rec-day-tu').checked = true;
  change(q(s.main, 'rec-day-tu'));
  const p = submit(s);
  await flush(20);
  const d = dlg('dialog-rule-exceptions');
  assert.ok(d);
  assert.equal(doc.activeElement, q(d, 'exceptions-cancel'));
  q(d, 'exceptions-cancel').click();
  await p;
  assert.equal(puts(s).length, 0);
  assert.equal(s.env.server.hrefsIn(CAL_A).length, 1);
});

test('the first occurrence has no "following" scope: a scope=following link falls back to the whole series', async () => {
  const s = await setup({ items: { [WEEK]: weekly(UID, { count: 8 }) }, prefs: H24 });
  const ctl = await open(s, { key: UID, cal: CAL_A, occ: '2026-03-02T09:30:00', scope: 'following' });
  assert.equal(ctl.form.state.scope, 'all');
  assert.match(q(s.main, 'scope-notice').textContent, /every occurrence of the series/);
});
