// SPDX-License-Identifier: AGPL-3.0-or-later
// model/conflict.js, per-kind registry (RUN3 D-R3-5.5): diffOwned('event'|'task', ...) on projections, canSaveAsCopy(kind, recurring),
// and the contact behaviour unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_FIELDS, EVENT_FIELDS, FIELDS, TASK_FIELDS, canSaveAsCopy, diffOwned } from '../../../src/js/model/conflict.js';
import { occurrenceKey, projectEvent, projectTask } from '../../../src/js/store/verify.js';
import { model, override, paris, single, task, weekly } from '../store/_cal.mjs';

const ev = (t) => projectEvent(model.openItem(t));
const td = (t) => projectTask(model.openItem(t));

test('the registry has one entry per kind and the contact list is the old one', () => {
  assert.equal(FIELDS.contact, DIFF_FIELDS);
  assert.equal(FIELDS.event, EVENT_FIELDS);
  assert.equal(FIELDS.task, TASK_FIELDS);
  assert.ok(EVENT_FIELDS.includes('summary') && EVENT_FIELDS.includes('exdates') && EVENT_FIELDS.includes('overrides'));
});

test('event rows: only fields that changed on a side and differ now; both-sides flag; times shown as wall time and zone', () => {
  const base = ev(single('a@example.org', 'Lunch'));
  const mine = ev(single('a@example.org', 'Brunch'));
  const theirs = ev(single('a@example.org', 'Dinner', { start: '20260604T190000', end: '20260604T200000', extra: 'LOCATION:Somewhere\n' }));
  const rows = diffOwned('event', base, mine, theirs);
  const by = Object.fromEntries(rows.map((r) => [r.field, r]));
  assert.deepEqual(Object.keys(by).sort(), ['end', 'location', 'start', 'summary']);
  assert.equal(by.summary.both, true);
  assert.deepEqual([by.summary.mine, by.summary.theirs], ['Brunch', 'Dinner']);
  assert.equal(by.location.changedMine, false);
  assert.equal(by.location.theirs, 'Somewhere');
  assert.equal(by.start.theirs, '2026-06-04T19:00:00 Europe/Paris');
  assert.equal(by.start.kind, 'text');
});

test('rows disappear when both sides made the same change', () => {
  const base = ev(single('a@example.org', 'Lunch'));
  const same = ev(single('a@example.org', 'Brunch'));
  assert.deepEqual(diffOwned('event', base, same, same), []);
});

test('series: exdates and the set of overrides are rows; an occurrence option adds that occurrence\'s fields', () => {
  const uid = 'w@example.org';
  const base = ev(weekly(uid));
  const mineText = weekly(uid, { overrides: override(uid, '20260309T093000', { summary: 'Only me' }) });
  const theirsText = weekly(uid, { exdates: ['20260316T093000'], overrides: override(uid, '20260309T093000', { summary: 'Only them' }) });
  const zones = model.openItem(mineText).zones;
  const key = occurrenceKey(paris('2026-03-09T09:30:00'), zones);
  const rows = diffOwned('event', base, ev(mineText), ev(theirsText), { occurrences: [{ key, label: '2026-03-09T09:30:00' }] });
  const fields = rows.map((r) => r.field + (r.occurrence ? '@' + r.occurrence : ''));
  assert.ok(fields.includes('exdates'));
  assert.ok(fields.includes('summary@2026-03-09T09:30:00'));
  const occ = rows.find((r) => r.occurrence);
  assert.deepEqual([occ.mine, occ.theirs, occ.both], ['Only me', 'Only them', true]);
  assert.equal(rows.some((r) => r.field === 'overrides'), false); // same set of overrides on both sides
});

test('task rows: priority, percent and status are shown as text', () => {
  const base = td(task('t@example.org', 'Report', 'PRIORITY:5\n'));
  const mine = td(task('t@example.org', 'Report', 'PRIORITY:1\n'));
  const theirs = td(task('t@example.org', 'Report', 'PRIORITY:5\nPERCENT-COMPLETE:40\n'));
  const rows = diffOwned('task', base, mine, theirs);
  const by = Object.fromEntries(rows.map((r) => [r.field, r]));
  assert.deepEqual([by.priority.mine, by.priority.changedTheirs], ['1', false]);
  assert.equal(by.percent.theirs, '40');
});

test('canSaveAsCopy: contacts by group, events and tasks only when not recurring', () => {
  assert.equal(canSaveAsCopy('event', false), true);
  assert.equal(canSaveAsCopy('event', true), false);
  assert.equal(canSaveAsCopy('task', false), true);
  assert.equal(canSaveAsCopy('task', true), false);
  assert.equal(canSaveAsCopy('contact', false), true);
  assert.equal(canSaveAsCopy({ group: { isGroup: true } }), false);
  assert.equal(canSaveAsCopy({ group: { isGroup: false } }), true);
});

test('contact form is unchanged: diffOwned(base, mine, theirs) and diffOwned(\'contact\', ...) agree', () => {
  const b = { fn: 'A', note: '' };
  const m = { fn: 'B', note: '' };
  const t = { fn: 'C', note: 'x' };
  const rows = diffOwned(b, m, t);
  assert.deepEqual(rows.map((r) => r.field), ['fn', 'note']);
  assert.deepEqual(diffOwned('contact', b, m, t), rows);
});
