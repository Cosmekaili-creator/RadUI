// SPDX-License-Identifier: AGPL-3.0-or-later
// The task form model (WP C1): no-op over every todo fixture, single-field edits, status / completion rules, time
// zones, validation, new tasks, and complete / reopen on the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openItem } from '../../../src/js/model/item.js';
import { fromItem, isEmptyPatch, newTaskValues, priorityOptions, statusOptions, toNewFields, toPatch, validate, valuesToSpecs, withZone } from '../../../src/js/tasks/formmodel.js';
import { todoText } from './_tasks.mjs';

const FIXTURES = new URL('../../fixtures/ics/', import.meta.url).pathname;
const NOW = Date.parse('2026-06-03T10:00:00Z');
const open = (text) => {
  const it = openItem(text);
  assert.ok(it.ok, it.reason);
  return it;
};
const OPTS = { now: NOW, defaultTz: 'Asia/Kathmandu' };

test('no-op: every todo-*.ics fixture gives an empty patch and no validation error', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.startsWith('todo-'));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const item = open(readFileSync(FIXTURES + f, 'utf8'));
    const v = fromItem(item);
    assert.deepEqual(toPatch(v, { ...v }, OPTS), {}, f);
    assert.deepEqual(validate(v, v, { zones: item.zones }), [], f);
    // the patch applied to a fresh item changes nothing either
    assert.equal(isEmptyPatch(toPatch(v, v)), true, f);
  }
});

test('fromItem shows what the file holds (zones keep their own TZID, a date stays a date, the rule is read-only)', () => {
  const zoned = fromItem(open(readFileSync(FIXTURES + 'todo-zoned.ics', 'utf8')));
  assert.deepEqual([zoned.dueDate, zoned.dueTime, zoned.dueTz, zoned.dueKind], ['2026-06-01', '17:00', 'America/New_York', 'zoned']);
  assert.deepEqual([zoned.startTime, zoned.startTz], ['09:00', 'America/New_York']);
  const open1 = fromItem(open(readFileSync(FIXTURES + 'todo-open.ics', 'utf8')));
  assert.deepEqual([open1.dueDate, open1.dueTime, open1.dueTz, open1.dueKind, open1.priority, open1.status, open1.percent, open1.categories], ['2026-04-15', '', '', 'date', '5', 'NEEDS-ACTION', '', ['errands']]);
  assert.equal(open1.description, 'Paper, pens; stamps');
  const rec = fromItem(open(readFileSync(FIXTURES + 'todo-recurring.ics', 'utf8')));
  assert.deepEqual([rec.recurring, rec.rrule], [true, 'FREQ=WEEKLY;COUNT=10']);
  const utc = fromItem(open(readFileSync(FIXTURES + 'todo-due-completed.ics', 'utf8')));
  assert.deepEqual([utc.dueTz, utc.dueKind, utc.dueTime], ['UTC', 'utc', '17:00']);
});

const base = () => fromItem(open(readFileSync(FIXTURES + 'todo-open.ics', 'utf8')));

test('single-field edits give exactly one key', () => {
  const b = base();
  assert.deepEqual(toPatch(b, { ...b, summary: ' Buy more supplies ' }, OPTS), { summary: 'Buy more supplies' });
  assert.deepEqual(toPatch(b, { ...b, description: 'x\r\ny' }, OPTS), { description: 'x\ny' });
  assert.deepEqual(toPatch(b, { ...b, categories: ['errands', 'home'] }, OPTS), { categories: ['errands', 'home'] });
  assert.deepEqual(toPatch(b, { ...b, priority: '1' }, OPTS), { priority: 1 });
  assert.deepEqual(toPatch(b, { ...b, priority: '0' }, OPTS), { priority: null }, 'no priority removes the property');
  assert.deepEqual(toPatch(b, { ...b, percent: '30' }, OPTS), { percent: 30 });
  assert.deepEqual(toPatch(b, { ...b, status: 'IN-PROCESS' }, OPTS), { status: 'IN-PROCESS' });
  assert.deepEqual(toPatch(b, { ...b, dueDate: '2026-04-16' }, OPTS), { due: { kind: 'date', iso: '2026-04-16' } });
  assert.deepEqual(toPatch(b, { ...b, dueDate: '' }, OPTS), { due: null });
  assert.deepEqual(toPatch(b, { ...b, startDate: '2026-04-10' }, OPTS), { start: { kind: 'date', iso: '2026-04-10' } });
});

test('a time typed into a date-only value takes the display zone; the zone of an existing time is never rewritten', () => {
  const b = base();
  assert.deepEqual(toPatch(b, { ...b, dueTime: '17:30' }, OPTS), { due: { kind: 'zoned', iso: '2026-04-15T17:30:00', tzid: 'Asia/Kathmandu' } });
  const z = fromItem(open(readFileSync(FIXTURES + 'todo-zoned.ics', 'utf8')));
  // only the due time changes: its own zone stays, the start is not in the patch
  assert.deepEqual(toPatch(z, { ...z, dueTime: '18:00' }, OPTS), { due: { kind: 'zoned', iso: '2026-06-01T18:00:00', tzid: 'America/New_York' } });
  // the picker changes the zone explicitly
  const w = withZone(z, 'due', 'Australia/Lord_Howe');
  assert.deepEqual(toPatch(z, w, OPTS), { due: { kind: 'zoned', iso: '2026-06-01T17:00:00', tzid: 'Australia/Lord_Howe' } });
  assert.deepEqual(toPatch(z, withZone(z, 'due', 'UTC'), OPTS), { due: { kind: 'utc', iso: '2026-06-01T17:00:00' } });
  // clearing the time makes a date
  assert.deepEqual(toPatch(z, { ...z, dueTime: '' }, OPTS), { due: { kind: 'date', iso: '2026-06-01' } });
  // floating stays floating
  const f = { ...base(), dueDate: '2026-04-15', dueTime: '08:00', dueTz: '', dueKind: 'floating' };
  assert.deepEqual(valuesToSpecs(f).due, { kind: 'floating', iso: '2026-04-15T08:00:00' });
  assert.deepEqual(valuesToSpecs({ ...f, dueKind: 'date' }, { defaultTz: 'Europe/Paris' }).due, { kind: 'zoned', iso: '2026-04-15T08:00:00', tzid: 'Europe/Paris' });
});

test('status COMPLETED sets COMPLETED (UTC now) and percent 100 unless a percent was typed; leaving COMPLETED clears them', () => {
  const b = base();
  const done = toPatch(b, { ...b, status: 'COMPLETED' }, OPTS);
  assert.deepEqual(done, { status: 'COMPLETED', completed: { kind: 'utc', iso: '2026-06-03T10:00:00' }, percent: 100 });
  const typed = toPatch(b, { ...b, status: 'COMPLETED', percent: '80' }, OPTS);
  assert.equal(typed.percent, 80);
  const finished = fromItem(open(readFileSync(FIXTURES + 'todo-due-completed.ics', 'utf8')));
  assert.deepEqual(toPatch(finished, { ...finished, status: 'NEEDS-ACTION' }, OPTS), { status: 'NEEDS-ACTION', completed: null, percent: null });
  assert.deepEqual(toPatch(finished, { ...finished, status: 'IN-PROCESS', percent: '50' }, OPTS), { status: 'IN-PROCESS', completed: null, percent: 50 });
  assert.deepEqual(toPatch(b, { ...b, status: 'CANCELLED' }, OPTS), { status: 'CANCELLED' });
});

test('the repeat rule is never in a patch', () => {
  const r = fromItem(open(readFileSync(FIXTURES + 'todo-recurring.ics', 'utf8')));
  assert.deepEqual(toPatch(r, { ...r, summary: 'Water the garden', rrule: 'FREQ=DAILY' }, OPTS), { summary: 'Water the garden' });
  assert.ok(validate(r, { ...r, status: 'COMPLETED' }, {}).some((e) => e.code === 'recurring-complete'));
  assert.deepEqual(validate(r, { ...r, status: 'CANCELLED' }, {}), []);
  assert.equal(validate(finishedRecurring(), { ...finishedRecurring(), status: 'COMPLETED' }, {}).length, 0, 'an already-done repeating task is not blocked again');
});
function finishedRecurring() {
  return fromItem(open(todoText('r', 'Repeats', ['RRULE:FREQ=DAILY', 'STATUS:COMPLETED'])));
}

test('validation: judges only what changed (or all for a new task)', () => {
  const b = base();
  const codes = (v, o) => validate(b, v, o).map((e) => `${e.testId}:${e.code}`);
  assert.deepEqual(codes({ ...b, summary: '  ' }), ['field-summary:summary-required']);
  assert.deepEqual(codes({ ...b, percent: '101' }), ['field-percent:percent']);
  assert.deepEqual(codes({ ...b, percent: 'ab' }), ['field-percent:percent']);
  assert.deepEqual(codes({ ...b, percent: '' }), []);
  assert.deepEqual(codes({ ...b, dueDate: '2026-02-30' }), ['field-due-date:date-invalid']);
  assert.deepEqual(codes({ ...b, dueTime: '25:00' }), ['field-due-time:time-invalid']);
  assert.deepEqual(codes({ ...b, dueDate: '', dueTime: '10:00' }), ['field-due-date:date-required']);
  assert.deepEqual(codes({ ...b, dueTime: '10:00', dueTz: 'Mars/Olympus', dueKind: 'zoned' }), ['field-tz-due:tz-unknown']);
  // due before start
  assert.deepEqual(codes({ ...b, startDate: '2026-04-20' }), ['field-due-date:due-before-start']);
  // a timed due with a date-only start: RFC 5545 says both have the same type
  assert.deepEqual(codes({ ...b, startDate: '2026-04-01', dueTime: '09:00' }), ['field-due-date:date-types-differ']);
  // timed, in different zones: compared by instant (due 09:00 Paris is before 08:30 New York the same day)
  const t = { ...b, dueDate: '2026-04-15', dueTime: '09:00', dueTz: 'Europe/Paris', dueKind: 'zoned', startDate: '2026-04-15', startTime: '08:30', startTz: 'America/New_York', startKind: 'zoned' };
  assert.deepEqual(codes(t), ['field-due-time:due-before-start']);
  // an old odd value that did not change is not judged
  const odd = { ...b, percent: '250' };
  assert.deepEqual(validate(odd, odd), []);
  // a new task needs a title; long text is refused
  assert.deepEqual(validate(newTaskValues({ tz: 'UTC' }), newTaskValues({ tz: 'UTC' }), { isNew: true }).map((e) => e.code), ['summary-required']);
  assert.ok(validate(b, { ...b, summary: 'x'.repeat(1001) }).some((e) => e.code === 'too-long'));
});

test('new tasks: blank values, toNewFields (date due, timed due in the display zone, completed)', () => {
  const v = newTaskValues({ tz: 'Europe/Paris' });
  assert.deepEqual([v.status, v.priority, v.dueDate, v.dueTz, v.dueKind], ['NEEDS-ACTION', '0', '', 'Europe/Paris', 'zoned']);
  assert.deepEqual(toPatch(v, v, OPTS), {}, 'a blank form is clean');
  assert.deepEqual(toNewFields({ ...v, summary: ' Write ' }, OPTS), { summary: 'Write', status: 'NEEDS-ACTION' });
  const f = toNewFields({ ...v, summary: 'T', dueDate: '2026-07-01', dueTime: '09:15', priority: '5', percent: '20', categories: ['a', ' '], description: 'd' }, OPTS);
  assert.deepEqual(f, { summary: 'T', description: 'd', due: { kind: 'zoned', iso: '2026-07-01T09:15:00', tzid: 'Europe/Paris' }, priority: 5, status: 'NEEDS-ACTION', percent: 20, categories: ['a'] });
  assert.deepEqual(toNewFields({ ...v, summary: 'U', dueDate: '2026-07-01', dueTime: '09:15', dueTz: 'UTC', dueKind: 'utc' }, OPTS).due, { kind: 'utc', iso: '2026-07-01T09:15:00' });
  assert.deepEqual(toNewFields({ ...v, summary: 'D', dueDate: '2026-07-01' }, OPTS).due, { kind: 'date', iso: '2026-07-01' });
  const c = toNewFields({ ...v, summary: 'C', status: 'COMPLETED' }, OPTS);
  assert.deepEqual([c.completed, c.percent], [{ kind: 'utc', iso: '2026-06-03T10:00:00' }, 100]);
});

test('select options keep a value the form does not know', () => {
  assert.deepEqual(priorityOptions({ priority: '3' }), [0, 1, 3, 5, 9]);
  assert.deepEqual(priorityOptions({ priority: '5' }), [0, 1, 5, 9]);
  assert.deepEqual(statusOptions({ status: '' }), ['', 'NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']);
  assert.deepEqual(statusOptions({ status: 'COMPLETED' }), ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']);
});

test('model: complete sets STATUS, COMPLETED and PERCENT-COMPLETE; reopen undoes them; neither touches other lines', () => {
  const text = todoText('t', 'Task', ['PRIORITY:3', 'X-KEEP:1', 'DUE;VALUE=DATE:20260901']);
  const item = open(text);
  assert.equal(item.completeTask(new Date(NOW)), true);
  const done = item.save().text;
  assert.match(done, /STATUS:COMPLETED/);
  assert.match(done, /COMPLETED:20260603T100000Z/);
  assert.match(done, /PERCENT-COMPLETE:100/);
  assert.match(done, /X-KEEP:1/);
  const again = open(done);
  assert.equal(again.reopenTask(), true);
  const reopened = again.save().text;
  assert.match(reopened, /STATUS:NEEDS-ACTION/);
  assert.doesNotMatch(reopened, /COMPLETED:|PERCENT-COMPLETE/);
  assert.match(reopened, /PRIORITY:3/);
  assert.match(reopened, /DUE;VALUE=DATE:20260901/);
});
