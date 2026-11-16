// SPDX-License-Identifier: AGPL-3.0-or-later
// The recurrence builder, the reminders editor, the zone picker and the calendar section of Settings (WP B3b).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '../_i18n-all.mjs';
import { buildRule, parseRule, sameRule } from '../../../src/js/calendar/rrule.js';
import { change, choose, fire, type } from '../widgets/_dom.mjs';
import { createRecurrenceBuilder, followStart, monthlyChoices } from '../../../src/js/views/calendar/recurrence.js';
import { amountText, createAlarmsEditor, customAlarmText } from '../../../src/js/views/calendar/alarms.js';
import { createZoneField, openZonePicker, zoneLabel, zoneOptions } from '../../../src/js/views/calendar/tzpicker.js';
import { calendarSection, clockChoice, clockPref, PREF as SETTINGS_PREF } from '../../../src/js/views/settings/calendar.js';
import { PREF as CAL_PREF } from '../../../src/js/views/calendar/common.js';
import { doc, dlg, flush, memoryStorage, q, qa } from './event-helpers.mjs';

const en = createI18n({ lang: 'en' });
const fr = createI18n({ lang: 'fr' });
const T = (i18n) => ({ t: (k, p) => i18n.t(k, p), tp: (k, n, p) => i18n.tp(k, n, p) });
const START = { kind: 'zoned', iso: '2026-11-16T09:30:00', tzid: 'Europe/Paris' }; // a Monday
const make = (rule, extra = {}) => {
  const root = doc.createElement('div');
  const ctl = createRecurrenceBuilder({ rule, getStart: () => START, lang: 'en', ...T(en), ...extra });
  root.append(ctl.el);
  return { ctl, root };
};
const builderOf = (text) => ({ mode: 'builder', state: parseRule(text, START).state });

test('the builder shows a weekly rule: interval, weekdays, end, and the sentence; an untouched rule re-builds identically', () => {
  const text = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6';
  const { ctl, root } = make(builderOf(text));
  assert.equal(q(root, 'rec-freq').value, 'WEEKLY');
  assert.equal(q(root, 'rec-interval').value, '2');
  assert.equal(q(root, 'rec-day-mo').checked, true);
  assert.equal(q(root, 'rec-day-th').checked, true);
  assert.equal(q(root, 'rec-day-tu').checked, false);
  assert.equal(q(root, 'rec-end-count').checked, true);
  assert.equal(q(root, 'rec-count').value, '6');
  assert.equal(q(root, 'rec-summary').textContent, 'Every 2 weeks on Monday and Thursday, for 6 occurrences');
  assert.equal(q(root, 'rec-unit').textContent, 'weeks');
  assert.equal(q(root, 'rec-summary').getAttribute('aria-live'), 'polite');
  const r = ctl.getRule();
  assert.equal(r.mode, 'builder');
  assert.ok(sameRule(buildRule(r.state, START), text));
});

test('changing the frequency fills the parts from the start date; the sentence follows; None goes back to "Does not repeat"', () => {
  const { ctl, root } = make({ mode: 'none' });
  assert.equal(q(root, 'rec-details').hidden, true);
  assert.equal(q(root, 'rec-summary').textContent, 'Does not repeat');
  choose(q(root, 'rec-freq'), 'WEEKLY');
  assert.equal(q(root, 'rec-details').hidden, false);
  assert.equal(q(root, 'rec-day-mo').checked, true, 'the start is a Monday');
  assert.equal(q(root, 'rec-summary').textContent, 'Every week on Monday');
  choose(q(root, 'rec-freq'), 'MONTHLY');
  assert.equal(q(root, 'rec-monthly').hidden, false);
  assert.equal(q(root, 'rec-weekdays').hidden, true, 'the weekdays are for weekly rules only');
  assert.match(q(root, 'rec-monthly-day').parentNode.textContent, /on day 16/);
  assert.match(q(root, 'rec-monthly-nth').parentNode.textContent, /on the third Monday/);
  fire(q(root, 'rec-monthly-nth'), 'change');
  q(root, 'rec-monthly-nth').checked = true;
  q(root, 'rec-monthly-day').checked = false;
  change(q(root, 'rec-monthly-nth'));
  assert.equal(buildRule(ctl.getRule().state, START), 'FREQ=MONTHLY;BYDAY=3MO');
  assert.equal(q(root, 'rec-summary').textContent, 'Every month on the third Monday');
  choose(q(root, 'rec-freq'), 'NONE');
  assert.deepEqual(ctl.getRule(), { mode: 'none' });
  assert.equal(q(root, 'rec-summary').textContent, 'Does not repeat');
});

test('ends: until (a date field), after N occurrences, never; an untouched UNTIL keeps its original text', () => {
  const text = 'FREQ=DAILY;UNTIL=20261231T225959Z';
  const { ctl, root } = make(builderOf(text));
  assert.equal(q(root, 'rec-end-until').checked, true);
  assert.equal(q(root, 'rec-until-input').value, '12/31/2026');
  assert.equal(buildRule(ctl.getRule().state, START), text, 'the original UNTIL is re-emitted untouched');
  type(q(root, 'rec-until-input'), '12/24/2026');
  change(q(root, 'rec-until-input'));
  assert.equal(q(root, 'rec-end-until').checked, true);
  assert.equal(ctl.getRule().state.end.date, '2026-12-24');
  assert.match(buildRule(ctl.getRule().state, START), /UNTIL=20261224T225959Z/, 'the end of the chosen day in the start zone, as UTC');
  q(root, 'rec-end-count').checked = true;
  q(root, 'rec-end-until').checked = false;
  change(q(root, 'rec-end-count'));
  type(q(root, 'rec-count'), '3');
  assert.deepEqual(ctl.getRule().state.end, { type: 'count', count: 3 });
  q(root, 'rec-end-never').checked = true;
  q(root, 'rec-end-count').checked = false;
  change(q(root, 'rec-end-never'));
  assert.deepEqual(ctl.getRule().state.end, { type: 'never' });
});

test('an invalid interval is reported through the state (NaN), never silently rebuilt', () => {
  const { ctl, root } = make(builderOf('FREQ=DAILY'));
  type(q(root, 'rec-interval'), 'abc');
  assert.ok(Number.isNaN(ctl.getRule().state.interval));
  assert.equal(q(root, 'rec-summary').textContent, 'Complete the rule to see its summary.');
  type(q(root, 'rec-interval'), '3');
  assert.equal(q(root, 'rec-summary').textContent, 'Every 3 days');
});

test('a custom rule: shown as custom with its raw text, controls hidden, never re-emitted; replacing it turns the builder on', () => {
  const raw = 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=10';
  const seen = [];
  const { ctl, root } = make({ mode: 'custom', raw, reason: 'part-bysetpos' }, { onChange: () => seen.push(1) });
  assert.equal(q(root, 'rec-custom').hidden, false);
  assert.equal(q(root, 'rec-details').hidden, true);
  assert.equal(q(root, 'rec-custom-raw').textContent, raw);
  assert.equal(q(root, 'rec-summary').textContent, 'Custom rule (kept as is)');
  assert.equal(q(root, 'rec-freq').value, 'CUSTOM');
  assert.deepEqual(ctl.getRule(), { mode: 'custom', raw, reason: 'part-bysetpos' });
  fire(q(root, 'btn-replace-rule'), 'click');
  assert.equal(q(root, 'rec-custom').hidden, true);
  assert.equal(q(root, 'rec-details').hidden, false);
  assert.equal(ctl.getRule().mode, 'builder');
  assert.match(q(root, 'rec-summary').textContent, /^Every week on Monday/);
  assert.ok(seen.length >= 1);
});

test('exceptions: skipped dates can be brought back (the op is the form\'s), changed dates are listed without a button', () => {
  const ex = [
    { type: 'exdate', spec: { kind: 'zoned', iso: '2026-11-23T09:30:00', tzid: 'Europe/Paris' }, key: 'a' },
    { type: 'override', spec: { kind: 'zoned', iso: '2026-11-30T09:30:00', tzid: 'Europe/Paris' }, key: 'b' },
  ];
  const { ctl, root } = make(builderOf('FREQ=WEEKLY'), { exceptions: ex });
  assert.equal(qa(root, 'exception-row').length, 2);
  assert.equal(qa(root, 'btn-restore-exception').length, 1);
  assert.match(qa(root, 'exception-row')[1].textContent, /changed/);
  fire(q(root, 'btn-restore-exception'), 'click');
  assert.equal(qa(root, 'exception-row').length, 1);
  assert.deepEqual(ctl.restored(), [ex[0].spec]);
});

test('followStart: implicit parts move with the start, parts the user chose stay', () => {
  const weekly = parseRule('FREQ=WEEKLY', START).state;
  assert.deepEqual(followStart({ ...weekly, byday: ['MO'] }, '2026-11-16', '2026-11-18').byday, ['WE']);
  assert.deepEqual(followStart({ ...weekly, byday: ['MO', 'TH'] }, '2026-11-16', '2026-11-18').byday, ['MO', 'TH']);
  const monthly = { ...weekly, freq: 'MONTHLY', monthly: 'dom', bymonthday: 16 };
  assert.equal(followStart(monthly, '2026-11-16', '2026-11-20').bymonthday, 20);
  assert.equal(followStart({ ...monthly, bymonthday: 5 }, '2026-11-16', '2026-11-20').bymonthday, 5);
  const nth = { ...monthly, monthly: 'nth', nth: { n: 3, weekday: 'MO' } };
  assert.deepEqual(followStart(nth, '2026-11-16', '2026-11-25').nth, { n: 4, weekday: 'WE' });
  const yearly = { ...weekly, freq: 'YEARLY', monthly: 'dom', bymonth: 11, bymonthday: 16 };
  const moved = followStart(yearly, '2026-11-16', '2026-12-02');
  assert.deepEqual([moved.bymonth, moved.bymonthday], [12, 2]);
});

test('the builder follows the form start through setStart()', () => {
  let start = START;
  const root = doc.createElement('div');
  const ctl = createRecurrenceBuilder({ rule: builderOf('FREQ=WEEKLY;BYDAY=MO'), getStart: () => start, lang: 'en', ...T(en) });
  root.append(ctl.el);
  start = { ...START, iso: '2026-11-18T09:30:00' };
  ctl.setStart();
  assert.equal(q(root, 'rec-day-we').checked, true);
  assert.equal(q(root, 'rec-day-mo').checked, false);
  assert.equal(q(root, 'rec-summary').textContent, 'Every week on Wednesday');
});

test('the builder speaks French (sentence, labels) and orders the weekdays from the first weekday', () => {
  const root = doc.createElement('div');
  const ctl = createRecurrenceBuilder({ rule: builderOf('FREQ=WEEKLY;BYDAY=MO,TH'), getStart: () => START, lang: 'fr', firstWeekday: 7, ...T(fr) });
  root.append(ctl.el);
  assert.match(q(root, 'rec-summary').textContent, /^Toutes les semaines le lundi et le jeudi|^Chaque semaine/);
  const order = qa(root, 'rec-weekdays')[0].querySelectorAll('input').map((i) => i.getAttribute('data-testid'));
  assert.equal(order[0], 'rec-day-su');
  assert.equal(order[1], 'rec-day-mo');
  assert.equal(q(root, 'rec-freq').querySelectorAll('option')[2].textContent, 'Toutes les semaines');
  const c = monthlyChoices({ freq: 'YEARLY', bymonth: 4, bymonthday: 5, monthly: 'dom' }, '2026-04-05', { ...T(fr), lang: 'fr' });
  assert.match(c.dom, /5 avril/);
  assert.match(c.nth, /d’avril|d'avril/);
});

// ---------------------------------------------------------------------------------------------------- reminders

test('reminders: presets, add up to three, remove, a custom alarm is kept and shown as text, foreign alarms are counted', () => {
  let n = 0;
  const root = doc.createElement('div');
  const ed = createAlarmsEditor({ ...T(en), lang: 'en', alarms: [{ seconds: -900, related: 'START' }, { seconds: -2700, related: 'START' }, { seconds: 120, related: 'END' }], foreign: 2, onChange: () => (n += 1) });
  root.append(ed.el);
  assert.equal(qa(root, 'alarm-row').length, 3);
  assert.equal(q(root, 'field-alarm-1').value, '15m');
  assert.equal(q(root, 'field-alarm-2').value, 'custom');
  assert.match(q(root, 'field-alarm-2').querySelectorAll('option').at(-1).textContent, /45 minutes before the start/);
  assert.match(q(root, 'field-alarm-3').querySelectorAll('option').at(-1).textContent, /2 minutes after the end/);
  assert.match(q(root, 'alarms-foreign').textContent, /2 other reminders are kept as they are/);
  assert.equal(q(root, 'btn-add-alarm').disabled, true);
  assert.equal(q(root, 'alarms-max').hidden, false);
  assert.deepEqual(ed.values(), [{ seconds: -900, related: 'START' }, { seconds: -2700, related: 'START' }, { seconds: 120, related: 'END' }]);
  choose(q(root, 'field-alarm-1'), '1d');
  assert.deepEqual(ed.values()[0], { seconds: -86400, related: 'START' });
  choose(q(root, 'field-alarm-1'), 'none');
  assert.equal(ed.values().length, 2);
  fire(qa(root, 'btn-remove-alarm')[1], 'click');
  assert.equal(qa(root, 'alarm-row').length, 2);
  assert.equal(q(root, 'btn-add-alarm').disabled, false);
  fire(q(root, 'btn-add-alarm'), 'click');
  assert.equal(ed.rowCount, 3);
  assert.deepEqual(ed.values().at(-1), { seconds: -600, related: 'START' });
  assert.ok(n >= 4);
});

test('reminder helpers: amount text uses the largest exact unit, in the language', () => {
  assert.equal(amountText(-2700, 'en'), '45 minutes');
  assert.equal(amountText(7200, 'en'), '2 hours');
  assert.equal(amountText(-172800, 'en'), '2 days');
  assert.match(amountText(-3600, 'fr'), /^1\sheure$/);
  assert.equal(customAlarmText({ seconds: 0, related: 'END' }, (k) => k, 'en'), 'event.alarm.custom.atEnd');
});

// ---------------------------------------------------------------------------------------------------- zones

test('the zone field shows the zone (floating when empty), opens the picker, remembers the choice and reports it', async () => {
  const storage = memoryStorage();
  const seen = [];
  const calls = [];
  const f = createZoneField({ testid: 'field-tz-start', label: 'Start time zone', value: 'Europe/Paris', ...T(en), login: 'alice', storage, onChange: (z) => seen.push(z), deps: { pick: async (o) => (calls.push(o), 'Australia/Lord_Howe') } });
  const root = doc.createElement('div');
  root.append(f.el);
  assert.equal(q(root, 'field-tz-start').textContent, 'Europe/Paris');
  assert.equal(zoneLabel('America/New_York'), 'America/New York');
  fire(q(root, 'field-tz-start'), 'click');
  await flush(5);
  assert.deepEqual(seen, ['Australia/Lord_Howe']);
  assert.equal(f.value, 'Australia/Lord_Howe');
  assert.equal(calls[0].current, 'Europe/Paris');
  assert.ok(calls[0].seen.includes('Europe/Paris'));
  assert.match(storage.getItem('radui.tz.recent.alice'), /Lord_Howe/);
  const floating = createZoneField({ testid: 'field-tz-end', label: 'x', value: '', ...T(en), login: 'alice', storage });
  assert.equal(floating.value, '');
  assert.equal(floating.control.textContent, 'Floating time (no zone)');
});

test('zone options: recent zones first, the zones in use, then the rest, with their offsets; the picker searches by city', async () => {
  const storage = memoryStorage({ 'radui.tz.recent.alice': JSON.stringify(['Asia/Kathmandu']) });
  const opts = zoneOptions({ login: 'alice', seen: ['America/New_York'], browser: 'Europe/Paris', storage, supported: ['Africa/Cairo', 'America/New_York', 'Asia/Kathmandu', 'Europe/Paris'], atMs: Date.UTC(2026, 0, 15) });
  assert.deepEqual(opts.slice(0, 2).map((o) => o.id), ['Asia/Kathmandu', 'America/New_York']);
  assert.equal(opts[0].sublabel, 'UTC+05:45');
  assert.equal(opts[1].label, 'America/New York');
  assert.ok(opts.some((o) => o.id === 'UTC'));
  const p = openZonePicker({ ...T(en), login: 'alice', storage, supported: ['America/New_York', 'Europe/Paris'], current: 'Europe/Paris' });
  const d = dlg('zone-picker');
  assert.ok(d, 'the picker dialog');
  assert.ok(q(d, 'field-zone-search'));
  type(q(d, 'field-zone-search'), 'new york');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(qa(d, 'zone-option').length, 1);
  fire(qa(d, 'zone-option')[0], 'click');
  assert.equal(await p, 'America/New_York');
});

// ---------------------------------------------------------------------------------------------------- settings

test('Settings calendar section: first weekday, clock, birthdays and the duplicate filter are per-login prefs applied at once', async () => {
  const store = new Map();
  const events = [];
  const prefs = { get: (n, f) => (store.has(n) ? store.get(n) : f), set: (n, v) => (store.set(n, v), events.push(['set', n, v])), remove: (n) => (store.delete(n), events.push(['remove', n])) };
  const status = [];
  const app = { lang: 'en', timeZone: 'Europe/Paris', feedback: { setStatus: (x) => status.push(x) } };
  const zoneStore = memoryStorage();
  const section = calendarSection({ ...T(en), app, login: 'alice', prefs, disposed: () => false }, { storage: zoneStore, zonePick: async () => 'Asia/Kathmandu' });
  const root = doc.createElement('div');
  root.append(section);
  assert.ok(q(root, 'settings-calendar'));
  for (const id of ['settings-first-weekday', 'settings-24h', 'settings-birthdays', 'settings-bday-hide-duplicates', 'settings-cal-status']) assert.ok(q(root, id), id);
  assert.equal(q(root, 'settings-birthdays').checked, true);
  assert.equal(q(root, 'settings-bday-hide-duplicates').checked, true);
  choose(q(root, 'settings-first-weekday'), '7');
  choose(q(root, 'settings-24h'), '12');
  q(root, 'settings-birthdays').checked = false;
  change(q(root, 'settings-birthdays'));
  q(root, 'settings-bday-hide-duplicates').checked = false;
  change(q(root, 'settings-bday-hide-duplicates'));
  assert.equal(store.get('cal.firstWeekday'), 7);
  assert.equal(store.get('cal.use24h'), false);
  assert.equal(store.get('cal.birthdays'), false);
  assert.equal(store.get('cal.hideDupBirthdays'), false);
  choose(q(root, 'settings-first-weekday'), 'auto');
  choose(q(root, 'settings-24h'), 'auto');
  assert.equal(store.has('cal.firstWeekday'), false);
  assert.equal(store.has('cal.use24h'), false);
  assert.match(q(root, 'settings-cal-status').textContent, /saved on this device/);
  assert.ok(status.length >= 4);
  await section.zoneReady;
  assert.equal(q(root, 'settings-tz-display').getAttribute('data-zone'), 'Europe/Paris');
  fire(q(root, 'settings-tz-display'), 'click');
  await flush(10);
  assert.equal(q(root, 'settings-tz-display').getAttribute('data-zone'), 'Asia/Kathmandu');
  assert.equal(zoneStore.getItem('radui.tz.display.alice'), 'Asia/Kathmandu', 'the preference the calendar screen reads');
  assert.match(q(root, 'settings-cal-status').textContent, /Display time zone/);
});

test('Settings: the preference names and the clock mapping are the ones the calendar screen reads', () => {
  assert.deepEqual({ ...SETTINGS_PREF }, { firstWeekday: CAL_PREF.firstWeekday, use24h: CAL_PREF.use24h, birthdays: CAL_PREF.birthdays, hideDup: CAL_PREF.hideDup });
  assert.deepEqual([clockChoice(true), clockChoice(false), clockChoice(null)], ['24', '12', 'auto']);
  assert.deepEqual([clockPref('24'), clockPref('12'), clockPref('auto')], [true, false, null]);
});

test('Settings without a preference store: the controls are disabled instead of failing', () => {
  const app = { lang: 'en', timeZone: 'Europe/Paris' };
  const section = calendarSection({ ...T(en), app, login: 'alice', prefs: null, disposed: () => false }, { storage: memoryStorage() });
  const root = doc.createElement('div');
  root.append(section);
  assert.equal(q(root, 'settings-first-weekday').disabled, true);
  assert.equal(q(root, 'settings-birthdays').disabled, true);
});
