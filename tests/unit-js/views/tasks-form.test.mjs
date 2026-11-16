// SPDX-License-Identifier: AGPL-3.0-or-later
// The task form (WP C1) over a real write path: new and edit, a form that changed nothing sends nothing, the zone of an
// existing time is kept, a time typed into a date takes the display zone, validation, completion rules, conflicts,
// unsaved-input guard, read-only and not-found states, delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../../../src/js/views/tasks/form.js';
import { CAL_A, CAL_B, CAL_TASKS, DISPLAY_TZ, NOW, all, flush, inside, one, setup, text } from './tasks-helpers.mjs';
import { change, choose, fire, type } from '../widgets/_dom.mjs';
import { todoText } from '../tasks/_tasks.mjs';

const calls = (s, method) => s.env.server.callsOf(method);
const NY = 'America/New_York';

async function mountForm(opts = {}, route = 'task-new', params = { list: CAL_A }, extra = {}) {
  const s = await setup(opts);
  s.dirty = [];
  s.app.setDirty = (v) => s.dirty.push(v);
  s.conflicts = [];
  const deps = { ...s.deps, zoneDeps: { pick: async () => NY }, openConflictDialog: async (o) => (s.conflicts.push(o.conflict), { cancelled: true }), actionDeps: { openConflictDialog: async (o) => (s.conflicts.push(o.conflict), { cancelled: true }) } };
  s.ctl = mount(s.ctx(params, { name: route }, extra), deps);
  await flush(40);
  s.form = s.ctl.form;
  s.root = s.main.querySelector('[data-testid="task-form-screen"]');
  return s;
}
const f = (s, id) => one(s.main, id);
const fill = (s, id, value) => {
  type(f(s, id), value);
  change(f(s, id));
};
const submit = async (s) => {
  fire(f(s, 'task-form'), 'submit');
  await flush(40);
};
const editParams = (uid) => ({ key: uid, list: CAL_A });

test('new task: blank form, the list select, status To do; Create writes one new .ics and goes back to the list', async () => {
  const s = await mountForm();
  assert.equal(s.root.getAttribute('data-state'), 'ready');
  assert.equal(s.root.getAttribute('data-mode'), 'new');
  assert.equal(f(s, 'field-list').value, CAL_A);
  assert.equal(all(s.main, 'field-list')[0].querySelectorAll('option').length, 3);
  assert.equal(f(s, 'field-status').value, 'NEEDS-ACTION');
  assert.equal(f(s, 'field-priority').value, '0');
  assert.equal(f(s, 'field-due-date-input').value, '');
  assert.equal(inside(s.main, 'task-delete'), null);
  assert.equal(s.main.ownerDocument.activeElement, f(s, 'field-summary'));
  const before = calls(s, 'PUT').length;
  fill(s, 'field-summary', 'Book the venue');
  fill(s, 'field-due-date-input', '2026-07-01');
  fill(s, 'field-due-time-input', '09:30');
  choose(f(s, 'field-priority'), '5');
  choose(f(s, 'field-list'), CAL_TASKS);
  await submit(s);
  assert.equal(calls(s, 'PUT').length, before + 1);
  const href = s.env.server.hrefsIn(CAL_TASKS).find((h) => !h.endsWith('done.ics') && !h.endsWith('today.ics'));
  const body = s.env.server.at(href).text;
  assert.match(body, /SUMMARY:Book the venue/);
  assert.match(body, /DUE;TZID=Europe\/Paris:20260701T093000/, 'the typed time takes the display zone');
  assert.match(body, /PRIORITY:5/);
  assert.match(body, /STATUS:NEEDS-ACTION/);
  assert.equal(s.navs.at(-1).hash, '#/tasks');
  assert.equal(s.dirty.at(-1), false);
  s.ctl.dispose();
});

test('new task: a date without a time is a DATE; "Done" at creation sets COMPLETED and 100 %', async () => {
  const s = await mountForm();
  fill(s, 'field-summary', 'Plan');
  fill(s, 'field-due-date-input', '2026-07-02');
  choose(f(s, 'field-status'), 'COMPLETED');
  await submit(s);
  const href = s.env.server.hrefsIn(CAL_A).find((h) => /^\/alice\/cal-a\/[0-9a-f-]+\.ics$/.test(h));
  const body = s.env.server.at(href).text;
  assert.match(body, /DUE;VALUE=DATE:20260702/);
  assert.match(body, /STATUS:COMPLETED/);
  assert.match(body, /PERCENT-COMPLETE:100/);
  assert.match(body, /COMPLETED:20260603T100000Z/);
  s.ctl.dispose();
});

test('validation: an empty title, a bad date, a due before the start; errors are text next to the fields and a summary with links, nothing is sent', async () => {
  const s = await mountForm();
  const before = calls(s, 'PUT').length;
  await submit(s);
  assert.equal(f(s, 'form-errors').hasAttribute('hidden'), false);
  assert.match(f(s, 'form-errors').textContent, /1 thing to fix/);
  assert.match(f(s, 'form-errors').textContent, /Task: Enter a title\./);
  assert.equal(f(s, 'field-summary').getAttribute('aria-invalid'), 'true');
  fill(s, 'field-summary', 'X');
  fill(s, 'field-start-date-input', '2026-07-10');
  fill(s, 'field-due-date-input', '2026-07-01');
  await submit(s);
  assert.match(f(s, 'form-errors').textContent, /The due date is before the start/);
  fill(s, 'field-due-date-input', '31/02/2026x');
  await submit(s);
  assert.match(f(s, 'form-errors').textContent, /Enter a real date/);
  fill(s, 'field-due-date-input', '2026-07-12');
  fill(s, 'field-percent', '150');
  await submit(s);
  assert.match(f(s, 'form-errors').textContent, /whole number from 0 to 100/);
  assert.equal(calls(s, 'PUT').length, before);
  assert.equal(all(s.main, 'form-error-link').length, 1);
  s.ctl.dispose();
});

test('edit: an untouched form sends NO request ("No changes to save"); one field sends one PUT with only that line changed', async () => {
  const s = await mountForm({}, 'task-edit', editParams('over@example.org'));
  assert.equal(s.root.getAttribute('data-mode'), 'edit');
  assert.equal(f(s, 'field-summary').value, 'Pay the invoice');
  assert.equal(f(s, 'field-priority').value, '1');
  assert.equal(f(s, 'field-due-date-input').value.replace(/\D/g, '').length, 8);
  const original = s.env.server.at(`${CAL_A}over.ics`).text;
  let before = calls(s, 'PUT').length;
  await submit(s);
  assert.equal(calls(s, 'PUT').length, before, 'no request');
  assert.equal(s.env.feedback.status.text, 'No changes to save.');
  assert.equal(s.dirty.at(-1) ?? false, false);
  fill(s, 'field-summary', 'Pay the invoice today');
  await flush(5);
  assert.equal(s.dirty.at(-1), true, 'unsaved input is guarded');
  before = calls(s, 'PUT').length;
  await submit(s);
  assert.equal(calls(s, 'PUT').length, before + 1);
  const after = s.env.server.at(`${CAL_A}over.ics`).text;
  const lines = (x) => x.split('\n').filter((l) => !/^(DTSTAMP|SEQUENCE|LAST-MODIFIED)/.test(l));
  assert.deepEqual(lines(after).filter((l) => !lines(original).includes(l)), ['SUMMARY:Pay the invoice today']);
  assert.deepEqual(lines(original).filter((l) => !lines(after).includes(l)), ['SUMMARY:Pay the invoice']);
  assert.equal(s.navs.at(-1).hash, '#/tasks/over%40example.org?list=%2Falice%2Fcal-a%2F');
  s.ctl.dispose();
});

test('edit: the zone of an existing time is kept (only the time changes); the zone picker changes it explicitly', async () => {
  const zoned = todoText('z@example.org', 'Zoned', ['DTSTART;TZID=America/New_York:20260601T090000', 'DUE;TZID=America/New_York:20260601T170000', 'X-KEEP:1']);
  const s = await mountForm({ items: { [`${CAL_A}z.ics`]: zoned } }, 'task-edit', editParams('z@example.org'));
  assert.equal(f(s, 'field-tz-due').getAttribute('data-zone'), NY);
  // the two zone controls have different names (not "Time zone" twice)
  const zoneLabel = (id) => (s.main.querySelector(`[data-field="${id}"] label`) || {}).textContent;
  assert.equal(zoneLabel('field-tz-due'), 'Due time zone');
  assert.equal(zoneLabel('field-tz-start'), 'Start time zone');
  fill(s, 'field-due-time-input', '18:15');
  await submit(s);
  let body = s.env.server.at(`${CAL_A}z.ics`).text;
  assert.match(body, /DUE;TZID=America\/New_York:20260601T181500/);
  assert.match(body, /DTSTART;TZID=America\/New_York:20260601T090000/);
  assert.match(body, /X-KEEP:1/);
  s.ctl.dispose();

  const s2 = await mountForm({ items: { [`${CAL_A}z.ics`]: zoned.replace(/America\/New_York/g, 'Asia/Kathmandu').replace('T170000', 'T230000') } }, 'task-edit', editParams('z@example.org'));
  await s2.form.fields.get('field-tz-start').choose();
  await submit(s2);
  body = s2.env.server.at(`${CAL_A}z.ics`).text;
  assert.match(body, /DTSTART;TZID=America\/New_York:20260601T090000/, 'the picked zone is written (wall time kept)');
  assert.match(body, /DUE;TZID=Asia\/Kathmandu:20260601T230000/, 'the due keeps its own zone');
  s2.ctl.dispose();
});

test('edit: status Done sets COMPLETED and 100 %; back to To do removes them; a repeating task cannot be set to Done', async () => {
  const s = await mountForm({}, 'task-edit', editParams('today@example.org'));
  s.ctl.dispose();
  const t2 = await mountForm({}, 'task-edit', { key: 'today@example.org', list: CAL_TASKS });
  choose(f(t2, 'field-status'), 'COMPLETED');
  await submit(t2);
  let body = t2.env.server.at(`${CAL_TASKS}today.ics`).text;
  assert.match(body, /STATUS:COMPLETED/);
  assert.match(body, /PERCENT-COMPLETE:100/);
  assert.match(body, /\nCOMPLETED:20260603T100000Z/);
  t2.ctl.dispose();
  const t3 = await mountForm({}, 'task-edit', { key: 'done@example.org', list: CAL_TASKS });
  choose(f(t3, 'field-status'), 'NEEDS-ACTION');
  await submit(t3);
  body = t3.env.server.at(`${CAL_TASKS}done.ics`).text;
  assert.match(body, /STATUS:NEEDS-ACTION/);
  assert.doesNotMatch(body, /PERCENT-COMPLETE|\nCOMPLETED:/);
  t3.ctl.dispose();
  const t4 = await mountForm({}, 'task-edit', editParams('rep@example.org'));
  assert.ok(inside(t4.main, 'task-recurrence'), 'the rule is shown read-only');
  assert.match(text(t4.main, 'task-recurrence'), /Every week/);
  choose(f(t4, 'field-status'), 'COMPLETED');
  const before = calls(t4, 'PUT').length;
  await submit(t4);
  assert.match(f(t4, 'form-errors').textContent, /repeating task cannot be marked as done/);
  assert.equal(calls(t4, 'PUT').length, before);
  choose(f(t4, 'field-status'), 'NEEDS-ACTION');
  fill(t4, 'field-summary', 'Water the garden');
  await submit(t4);
  const rep = t4.env.server.at(`${CAL_A}rep.ics`).text;
  assert.match(rep, /RRULE:FREQ=WEEKLY;COUNT=10/, 'the rule is untouched');
  assert.match(rep, /SUMMARY:Water the garden/);
  t4.ctl.dispose();
});

test('a priority that is not 1, 5 or 9 stays selectable and untouched', async () => {
  const s = await mountForm({ items: { [`${CAL_A}p.ics`]: todoText('p@example.org', 'Three', ['PRIORITY:3']) } }, 'task-edit', editParams('p@example.org'));
  assert.equal(f(s, 'field-priority').value, '3');
  assert.match(f(s, 'field-priority').querySelectorAll('option').map((o) => o.textContent).join('|'), /High priority \(3\)/);
  const before = calls(s, 'PUT').length;
  await submit(s);
  assert.equal(calls(s, 'PUT').length, before);
  s.ctl.dispose();
});

test('conflict on save: an outside edit opens the conflict dialog; nothing is overwritten', async () => {
  const s = await mountForm({}, 'task-edit', editParams('over@example.org'));
  s.env.server.outside(`${CAL_A}over.ics`, s.env.server.at(`${CAL_A}over.ics`).text.replace('PRIORITY:1', 'PRIORITY:9'));
  fill(s, 'field-summary', 'Mine');
  await submit(s);
  assert.equal(s.conflicts.length, 1);
  assert.match(s.env.server.at(`${CAL_A}over.ics`).text, /SUMMARY:Pay the invoice\n/);
  assert.equal(f(s, 'task-save').disabled, false);
  s.ctl.dispose();
});

test('delete: a named confirmation, then the DELETE with the shown ETag, then back to the list', async () => {
  const s = await mountForm({}, 'task-edit', editParams('over@example.org'));
  fire(f(s, 'task-delete'), 'click');
  await flush(10);
  const dlg = s.main.ownerDocument.body.querySelector('[data-testid="dialog-delete-task"]');
  assert.ok(dlg);
  fire(dlg.querySelector('[data-testid="dialog-confirm-delete"]'), 'click');
  await flush(40);
  assert.equal(s.env.server.at(`${CAL_A}over.ics`), undefined);
  assert.deepEqual(calls(s, 'DELETE'), [`DELETE ${CAL_A}over.ics`]);
  assert.equal(s.navs.at(-1).hash, '#/tasks');
  s.ctl.dispose();
});

test('states: unknown list, unknown task, a read-only list, an unreadable zone, no task list', async () => {
  const a = await mountForm({}, 'task-new', { list: '/mallory/x/' });
  assert.ok(one(a.main, 'task-form-notfound'));
  a.ctl.dispose();
  const b = await mountForm({}, 'task-edit', { key: 'nope', list: CAL_A });
  assert.ok(one(b.main, 'task-form-notfound'));
  b.ctl.dispose();
  const c = await setup();
  for (const e of c.env.access.list()) e.level = 'read';
  const ctl = mount(c.ctx({ list: CAL_A }, { name: 'task-new' }), c.deps);
  await flush(40);
  assert.ok(one(c.main, 'task-form-readonly'));
  ctl.dispose();
  const mars = todoText('m@example.org', 'Mars', ['DUE;TZID=Mars/Olympus:20260604T120000']);
  const d = await mountForm({ items: { [`${CAL_A}m.ics`]: mars } }, 'task-edit', editParams('m@example.org'));
  assert.ok(one(d.main, 'task-form-readonly'));
  assert.equal(one(d.main, 'task-form'), null);
  d.ctl.dispose();
  const e = await setup();
  for (const x of e.env.access.calendars()) e.env.access.remove(x.href);
  const ctl2 = mount(e.ctx({}, { name: 'task-new' }), e.deps);
  await flush(40);
  assert.ok(one(e.main, 'task-form-nolist'));
  ctl2.dispose();
});

test('a language switch keeps what was typed (snapshot/restore) and the base version', async () => {
  const s = await mountForm({}, 'task-edit', editParams('over@example.org'));
  fill(s, 'field-summary', 'Typed');
  fill(s, 'field-percent', '30');
  const snap = s.ctl.snapshot();
  assert.equal(snap.mode, 'edit');
  s.ctl.dispose();
  const ctl = mount(s.ctx(editParams('over@example.org'), { name: 'task-edit' }, { restore: snap }), { ...s.deps, zoneDeps: { pick: async () => NY } });
  await flush(40);
  assert.equal(f(s, 'field-summary').value, 'Typed');
  assert.equal(f(s, 'field-percent').value, '30');
  assert.deepEqual(ctl.snapshot().base, snap.base);
  ctl.dispose();
});

test('the form carries the documented ids', async () => {
  const s = await mountForm();
  for (const id of ['task-form', 'field-summary', 'field-list', 'field-due-date', 'field-due-time', 'field-tz-due', 'field-start-date', 'field-start-time', 'field-tz-start', 'field-priority', 'field-status', 'field-percent', 'field-categories', 'field-description', 'task-save', 'task-cancel', 'form-errors', 'form-status']) {
    assert.ok(s.main.querySelector(`[data-testid="${id}"]`), id);
  }
  assert.equal(f(s, 'task-cancel').getAttribute('href'), '#/tasks');
  s.ctl.dispose();
});

test('delete after an outside edit is refused with the "changed elsewhere" choice: the task stays', async () => {
  const s = await mountForm({}, 'task-edit', editParams('over@example.org'));
  s.env.server.outside(`${CAL_A}over.ics`, s.env.server.at(`${CAL_A}over.ics`).text.replace('PRIORITY:1', 'PRIORITY:9'));
  fire(f(s, 'task-delete'), 'click');
  await flush(10);
  fire(s.main.ownerDocument.body.querySelector('[data-testid="dialog-delete-task"] [data-testid="dialog-confirm-delete"]'), 'click');
  await flush(40);
  assert.ok(s.env.server.at(`${CAL_A}over.ics`));
  assert.equal(s.conflicts.at(-1).status, 'changed-elsewhere');
  s.ctl.dispose();
});
