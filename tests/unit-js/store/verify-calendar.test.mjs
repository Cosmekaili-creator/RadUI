// SPDX-License-Identifier: AGPL-3.0-or-later
// store/verify.js for events and tasks (RUN3 D-R3-5.4): projections, touched keys, server-added VTIMEZONE, re-serialisation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_KEYS, EVENT_KEYS, TOUCH_ALL, diffCalendarProjections, occurrenceKey, projectEvent, projectTask, rruleProjection, timeProjection, touchedOfOps, verifyCalendar } from '../../../src/js/store/verify.js';
import { model, override, paris, single, task, weekly } from './_cal.mjs';

const open = (t) => {
  const r = model.openItem(t);
  assert.equal(r.ok, true);
  return r;
};

test('rruleProjection: part order and list order do not matter, case does not', () => {
  assert.equal(rruleProjection('FREQ=WEEKLY;BYDAY=TH,MO;INTERVAL=2'), rruleProjection('interval=2;byday=MO,TH;freq=WEEKLY'.toUpperCase()));
  assert.equal(rruleProjection(null), null);
  assert.notEqual(rruleProjection('FREQ=WEEKLY;COUNT=3'), rruleProjection('FREQ=WEEKLY;COUNT=4'));
  assert.match(rruleProjection('nonsense'), /^raw:/);
});

test('timeProjection: the INSTANT for zoned and UTC values, the wall clock for dates and floating', () => {
  const zones = open(single('a@example.org')).zones;
  const p = timeProjection(paris('2026-06-04T12:00:00'), zones);
  assert.equal(typeof p.at, 'number');
  assert.equal(p.at, Date.UTC(2026, 5, 4, 10, 0, 0));
  assert.equal(timeProjection({ kind: 'utc', iso: '2026-06-04T10:00:00' }, zones).at, p.at);
  assert.equal(timeProjection({ kind: 'date', iso: '2026-06-04' }, zones).at, '2026-06-04');
  assert.equal(timeProjection({ kind: 'floating', iso: '2026-06-04T12:00:00' }, zones).at, '2026-06-04T12:00:00');
  assert.equal(timeProjection(null, zones), null);
});

test('a server-added VTIMEZONE is not a mismatch: same instants, with and without the embedded zone', () => {
  const sent = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example//EN\nBEGIN:VEVENT\nUID:z@example.org\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=America/New_York:20260610T090000\nDTEND;TZID=America/New_York:20260610T100000\nSUMMARY:Call\nEND:VEVENT\nEND:VCALENDAR\n`;
  const got = sent.replace('BEGIN:VEVENT', 'BEGIN:VTIMEZONE\nTZID:America/New_York\nBEGIN:DAYLIGHT\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nTZNAME:EDT\nDTSTART:19700308T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT\nBEGIN:STANDARD\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nTZNAME:EST\nDTSTART:19701101T020000\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD\nEND:VTIMEZONE\nBEGIN:VEVENT');
  const v = verifyCalendar(model, { sentText: sent, gotText: got });
  assert.deepEqual(v, { ok: true, mismatched: [] });
});

test('DTEND and DURATION are the same end; EXDATE as a set; alarms as a multiset; categories as a set', () => {
  const a = single('a@example.org', 'X', { extra: 'CATEGORIES:b,a\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT10M\nDESCRIPTION:r\nEND:VALARM\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT1H\nDESCRIPTION:r\nEND:VALARM\n' });
  const b = a.replace('DTEND;TZID=Europe/Paris:20260604T130000', 'DURATION:PT1H').replace('CATEGORIES:b,a', 'CATEGORIES:a,b').replace('TRIGGER:-PT10M', 'TRIGGER:-PT1H').replace(/TRIGGER:-PT1H\nDESCRIPTION:r\nEND:VALARM\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT1H/, 'TRIGGER:-PT1H\nDESCRIPTION:r\nEND:VALARM\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT10M');
  assert.deepEqual(verifyCalendar(model, { sentText: a, gotText: b }), { ok: true, mismatched: [] });
  const w1 = weekly('w@example.org', { exdates: ['20260309T093000', '20260316T093000'] });
  const w2 = weekly('w@example.org', { exdates: ['20260316T093000', '20260309T093000'] });
  assert.equal(verifyCalendar(model, { sentText: w1, gotText: w2 }).ok, true);
});

test('differences are named; only touched keys are compared', () => {
  const a = single('a@example.org', 'Lunch');
  const b = single('a@example.org', 'Dinner', { extra: 'LOCATION:Somewhere\n' });
  assert.deepEqual(verifyCalendar(model, { sentText: a, gotText: b }).mismatched.sort(), ['location', 'summary']);
  const touched = touchedOfOps([{ type: 'patch', fields: { location: 'Somewhere' } }]);
  assert.deepEqual(verifyCalendar(model, { sentText: a, gotText: b, touched }).mismatched, ['location']);
  const start = touchedOfOps([{ type: 'patch', fields: { start: paris('2026-06-04T12:00:00') } }]);
  assert.deepEqual(start.master.sort(), ['end', 'start']);
});

test('touchedOfOps maps every operation type; tasks use task keys', () => {
  const t = touchedOfOps([
    { type: 'override', rid: paris('2026-03-09T09:30:00'), fields: { summary: 'x', start: paris('2026-03-09T10:00:00') } },
    { type: 'deleteOccurrence', rid: paris('2026-03-16T09:30:00') },
    { type: 'shiftExceptions', fromStart: paris('2026-03-02T09:30:00'), toStart: paris('2026-03-02T10:30:00') },
  ]);
  assert.deepEqual(t.occurrences[0].keys.sort(), ['end', 'start', 'summary']);
  assert.ok(t.master.includes('exdates') && t.master.includes('rrule'));
  assert.equal(t.overrideSet, true);
  assert.equal(t.allOverrides, true);
  const c = touchedOfOps([{ type: 'complete' }], 'task');
  assert.deepEqual(c.master.sort(), ['completed', 'percent', 'status']);
  assert.ok(TASK_KEYS.includes('completed') && EVENT_KEYS.includes('alarms'));
});

test('overrides are compared per occurrence, and the SET of overrides when the operation changes it', () => {
  const a = weekly('w@example.org', { overrides: override('w@example.org', '20260309T093000', { summary: 'Moved' }) });
  const b = weekly('w@example.org', { overrides: override('w@example.org', '20260309T093000', { summary: 'Moved!' }) });
  const rid = paris('2026-03-09T09:30:00');
  const touched = touchedOfOps([{ type: 'override', rid, fields: { summary: 'Moved' } }]);
  const v = verifyCalendar(model, { sentText: a, gotText: b, touched });
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatched, [`override:${occurrenceKey(rid, open(a).zones)}:summary`]);
  // a missing override is a difference of the set
  const none = weekly('w@example.org');
  assert.deepEqual(verifyCalendar(model, { sentText: a, gotText: none, touched }).mismatched, ['overrides']);
  // an untouched override is not looked at
  assert.equal(verifyCalendar(model, { sentText: a, gotText: b, touched: touchedOfOps([{ type: 'patch', fields: { location: 'x' } }]) }).ok, true);
});

test('projectEvent keys every override by the identity of its RECURRENCE-ID (instant), whatever form it is written in', () => {
  const a = weekly('w@example.org', { overrides: override('w@example.org', '20260309T093000') });
  const b = a.replace('RECURRENCE-ID;TZID=Europe/Paris:20260309T093000', 'RECURRENCE-ID:20260309T083000Z');
  assert.deepEqual(Object.keys(projectEvent(open(a)).overrides), Object.keys(projectEvent(open(b)).overrides));
});

test('projectTask and tasks: status, percent, priority, due, COMPLETED presence', () => {
  const a = task('t@example.org', 'Report', 'PRIORITY:3\nDUE;TZID=Europe/Paris:20260610T170000\nCATEGORIES:y,x\n');
  const p = projectTask(open(a));
  assert.deepEqual([p.master.priority, p.master.status, p.master.completed, p.master.categories], [3, 'NEEDS-ACTION', false, ['x', 'y']]);
  assert.equal(typeof p.master.due.at, 'number');
  const done = a.replace('STATUS:NEEDS-ACTION', 'STATUS:COMPLETED\nCOMPLETED:20260601T100000Z\nPERCENT-COMPLETE:100');
  const v = verifyCalendar(model, { sentText: a, gotText: done, touched: touchedOfOps([{ type: 'complete' }], 'task') });
  assert.deepEqual(v.mismatched.sort(), ['completed', 'percent', 'status']);
});

test('a kind change, and an unreadable server text, are reported', () => {
  assert.deepEqual(verifyCalendar(model, { sentText: single('a@example.org'), gotText: task('a@example.org') }).mismatched, ['kind']);
  assert.equal(verifyCalendar(model, { sentText: single('a@example.org'), gotText: 'garbage' }).unreadable, true);
  assert.equal(verifyCalendar(model, { sentText: 'garbage', gotText: single('a@example.org') }).skipped, true);
  assert.deepEqual(diffCalendarProjections(projectEvent(open(single('a@example.org'))), projectEvent(open(single('a@example.org'))), TOUCH_ALL), []);
});
