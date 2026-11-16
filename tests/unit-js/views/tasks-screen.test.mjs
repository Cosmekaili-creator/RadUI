// SPDX-License-Identifier: AGPL-3.0-or-later
// The tasks screen (WP C1) over a real write path and stores on an in-memory multi-calendar server: merged list, filters
// and sort by URL, stable list toggling (same nodes), one-tap complete and reopen, the repeating task, sub-tasks,
// read-only lists, empty and error states, the detail page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, mountTask } from '../../../src/js/views/tasks/screen.js';
import { CAL_A, CAL_TASKS, CAL_RO, all, flush, inside, one, rowOf, setup, uidsOf, text } from './tasks-helpers.mjs';
import { fire } from '../widgets/_dom.mjs';

async function mounted(opts = {}, params = {}) {
  const s = await setup(opts);
  s.conflicts = [];
  s.deps.actionDeps = { ...s.deps.actionDeps, openConflictDialog: async (o) => (s.conflicts.push(o.conflict), { cancelled: true }) };
  s.ctl = mount(s.ctx(params, { name: 'tasks' }), s.deps);
  await flush(40);
  s.root = s.main.querySelector('[data-testid="tasks-screen"]');
  return s;
}
const toggle = (s, href) => all(s.main, 'tasklist-toggle').find((n) => n.getAttribute('data-href') === href);
const click = (el) => fire(el, 'click');

test('merged list: ready, status line, filters with counts, rows with the documented attributes', async () => {
  const s = await mounted();
  assert.equal(s.root.getAttribute('data-state'), 'ready');
  assert.equal(s.root.getAttribute('data-sync'), 'idle');
  assert.equal(text(s.main, 'tasks-status'), '6 open · 2 overdue · 3 task lists');
  assert.deepEqual(uidsOf(s.main), ['over', 'rep', 'today', 'parent', 'child', 'orphan']);
  const row = rowOf(s.main, 'over');
  for (const a of ['data-uid', 'data-href', 'data-list', 'data-status', 'data-readonly', 'data-key', 'data-depth']) assert.ok(row.hasAttribute(a), a);
  assert.equal(row.getAttribute('data-list'), CAL_A);
  assert.equal(row.getAttribute('data-readonly'), 'false');
  assert.equal(inside(row, 'task-due').textContent, 'Overdue since Wed, May 20');
  assert.match(inside(row, 'task-due').getAttribute('class'), /is-overdue/);
  assert.match(inside(row, 'task-priority').textContent, /High priority/);
  assert.equal(inside(row, 'task-open').getAttribute('aria-label'), 'Pay the invoice, Overdue since Wed, May 20, High priority, /alice/cal-a/');
  assert.match(inside(row, 'task-open').getAttribute('href'), /^#\/tasks\/over%40example\.org\?list=%2Falice%2Fcal-a%2F$/);
  for (const f of ['open', 'today', 'overdue', 'done', 'all']) assert.ok(one(s.main, `task-filter-${f}`), f);
  assert.deepEqual(['open', 'today', 'overdue', 'done', 'all'].map((f) => one(s.main, `task-filter-${f}-count`).textContent), ['6', '1', '2', '1', '7']);
  assert.equal(one(s.main, 'task-filter-open').getAttribute('aria-current'), 'page');
  assert.equal(all(s.main, 'tasklist-toggle').length, 3);
  assert.equal(one(s.main, 'btn-new-task').getAttribute('href'), '#/tasks/new?list=%2Falice%2Fcal-a%2F');
  s.ctl.dispose();
});

test('sub-tasks sit under their parent; an orphan child is at top level with "parent not found"', async () => {
  const s = await mounted();
  const parent = rowOf(s.main, 'parent');
  assert.equal(parent.getAttribute('data-depth'), '0');
  const child = inside(parent, 'task-subtasks').querySelector('[data-testid="task-row"]');
  assert.equal(child.getAttribute('data-uid'), 'child@example.org');
  assert.equal(child.getAttribute('data-depth'), '1');
  const orphan = rowOf(s.main, 'orphan');
  assert.equal(orphan.getAttribute('data-depth'), '0');
  assert.ok(inside(orphan, 'task-orphan'));
  assert.equal(inside(orphan, 'task-orphan').textContent, 'Parent not found');
  s.ctl.dispose();
});

test('filter and sort come from the URL; a route change keeps the list element and the rows that stay', async () => {
  const s = await mounted();
  const listEl = one(s.main, 'task-list');
  const over = rowOf(s.main, 'over');
  await s.ctl.update(s.ctx({ filter: 'overdue', sort: 'priority' }, { name: 'tasks' }));
  assert.equal(one(s.main, 'task-list'), listEl, 'the list element is kept');
  assert.deepEqual(uidsOf(s.main), ['over', 'rep']);
  assert.equal(rowOf(s.main, 'over'), over, 'a row that stays is the same node');
  assert.equal(one(s.main, 'task-filter-overdue').getAttribute('aria-current'), 'page');
  assert.equal(one(s.main, 'task-sort').value, 'priority');
  assert.equal(s.root.getAttribute('data-filter'), 'overdue');
  assert.match(text(s.main, 'tasks-status'), /Showing 2 tasks \(Overdue\)\.$/);
  assert.match(one(s.main, 'task-filter-today').getAttribute('href'), /filter=today&sort=priority/);
  await s.ctl.update(s.ctx({ filter: 'done' }, { name: 'tasks' }));
  assert.deepEqual(uidsOf(s.main), ['done']);
  await s.ctl.update(s.ctx({ filter: 'today', sort: 'due' }, { name: 'tasks' }));
  assert.deepEqual(uidsOf(s.main), ['today']);
  await s.ctl.update(s.ctx({ filter: 'nonsense', sort: 'x' }, { name: 'tasks' }));
  assert.equal(s.root.getAttribute('data-filter'), 'open');
  s.ctl.dispose();
});

test('sort by priority puts 1 first and tasks without a priority last; sort by due puts no due date last', async () => {
  const s = await mounted({}, { sort: 'priority' });
  assert.deepEqual(uidsOf(s.main).slice(0, 2), ['over', 'today']);
  await s.ctl.update(s.ctx({ sort: 'due' }, { name: 'tasks' }));
  assert.equal(uidsOf(s.main)[0], 'over');
  assert.equal(uidsOf(s.main).at(-1), 'orphan');
  s.ctl.dispose();
});

test('stable toggling: a list off removes only its rows (same nodes for the others), on puts them back; the preference and the live text follow', async () => {
  const s = await mounted();
  const listEl = one(s.main, 'task-list');
  const today = rowOf(s.main, 'today');
  const before = uidsOf(s.main).length;
  const cb = toggle(s, CAL_A);
  cb.checked = false;
  fire(cb, 'change');
  await flush(20);
  assert.deepEqual(uidsOf(s.main), ['today']);
  assert.equal(rowOf(s.main, 'today'), today);
  assert.equal(one(s.main, 'task-list'), listEl);
  assert.deepEqual(s.prefs.get('tasks.hidden'), [CAL_A]);
  assert.equal(text(s.main, 'tasklist-live'), 'List “/alice/cal-a/” hidden, 5 tasks');
  assert.equal(text(s.main, 'tasks-status'), '1 open · 0 overdue · 2 task lists');
  cb.checked = true;
  fire(cb, 'change');
  await flush(20);
  assert.equal(uidsOf(s.main).length, before);
  assert.equal(rowOf(s.main, 'today'), today);
  assert.equal(text(s.main, 'tasklist-live'), 'List “/alice/cal-a/” shown, 5 tasks');
  s.ctl.dispose();
});

test('a list that is switched off at the start is not fetched until it is switched on (tasklist-loading on its toggle)', async () => {
  const s = await mounted({ prefsValues: { 'tasks.hidden': [CAL_TASKS] } });
  assert.deepEqual(uidsOf(s.main), ['over', 'rep', 'parent', 'child', 'orphan']);
  assert.equal(s.calendars.isEnabled(CAL_TASKS), false);
  const cb = toggle(s, CAL_TASKS);
  cb.checked = true;
  fire(cb, 'change');
  await flush(30);
  assert.equal(s.calendars.isEnabled(CAL_TASKS), true);
  assert.deepEqual(uidsOf(s.main).includes('today'), true);
  s.ctl.dispose();
});

test('one-tap complete writes the task, the open list drops it, the status text stays; reopen from the Done list', async () => {
  const s = await mounted();
  const row = rowOf(s.main, 'over');
  const tick = inside(row, 'task-complete');
  assert.equal(tick.getAttribute('aria-pressed'), 'false');
  assert.equal(tick.getAttribute('aria-label'), 'Mark “Pay the invoice” as done');
  click(tick);
  await flush(40);
  const served = s.env.server.at(`${CAL_A}over.ics`).text;
  assert.match(served, /STATUS:COMPLETED/);
  assert.match(served, /PERCENT-COMPLETE:100/);
  assert.match(served, /COMPLETED:2026060[0-9]T/);
  assert.equal(rowOf(s.main, 'over'), null, 'it left the Open filter');
  assert.equal(s.env.feedback.status.text, 'Task marked as done.');
  assert.equal(s.env.feedback.alert, null);
  assert.equal(text(s.main, 'tasks-status'), '5 open · 1 overdue · 3 task lists');
  await s.ctl.update(s.ctx({ filter: 'done' }, { name: 'tasks' }));
  assert.deepEqual(uidsOf(s.main).sort(), ['done', 'over']);
  const back = inside(rowOf(s.main, 'over'), 'task-complete');
  assert.equal(back.getAttribute('aria-pressed'), 'true');
  click(back);
  await flush(40);
  const reopened = s.env.server.at(`${CAL_A}over.ics`).text;
  assert.match(reopened, /STATUS:NEEDS-ACTION/);
  assert.doesNotMatch(reopened, /PERCENT-COMPLETE|\nCOMPLETED:/);
  assert.equal(rowOf(s.main, 'over'), null);
  s.ctl.dispose();
});

test('a repeating task cannot be completed: the button is disabled with the explanation as its accessible name; no request', async () => {
  const s = await mounted();
  const tick = inside(rowOf(s.main, 'rep'), 'task-complete');
  assert.equal(tick.disabled, true);
  assert.equal(tick.getAttribute('aria-disabled'), 'true');
  assert.equal(tick.getAttribute('aria-label'), 'Repeating tasks can’t be completed here yet: “Water the plants”');
  assert.ok(inside(rowOf(s.main, 'rep'), 'task-repeats'));
  const before = s.env.server.at(`${CAL_A}rep.ics`).etag;
  click(tick);
  await flush(10);
  assert.equal(s.env.server.at(`${CAL_A}rep.ics`).etag, before);
  s.ctl.dispose();
});

test('a conflict on complete (an outside edit) opens the conflict dialog; nothing is overwritten', async () => {
  const s = await mounted();
  s.env.server.outside(`${CAL_A}over.ics`, s.env.server.at(`${CAL_A}over.ics`).text.replace('Pay the invoice', 'Pay the invoice now'));
  click(inside(rowOf(s.main, 'over'), 'task-complete'));
  await flush(40);
  assert.equal(s.conflicts.length, 1);
  assert.equal(s.conflicts[0].status, 'conflict');
  assert.doesNotMatch(s.env.server.at(`${CAL_A}over.ics`).text, /COMPLETED/);
  assert.equal(s.root.querySelector('[data-testid="task-row"][data-uid="over@example.org"] [data-testid="task-complete"]').disabled, false, 'the row is usable again');
  s.ctl.dispose();
});

test('a list that is read-only for the account: complete disabled with the reason, New disabled with an explanation, tasks-readonly shown', async () => {
  const s = await setup();
  // make the shared list a task list the account may only read
  const entry = s.env.access.list().find((c) => c.href === CAL_RO);
  entry.components = ['VEVENT', 'VTODO'];
  for (const c of s.env.access.list()) if (c.href !== CAL_RO) c.level = 'read';
  s.env.server.put(`${CAL_RO}ro.ics`, s.env.server.at(`${CAL_TASKS}today.ics`).text.replace('today@example.org', 'ro@example.org'));
  const ctl = mount(s.ctx({}, { name: 'tasks' }), s.deps);
  await flush(40);
  const tick = inside(rowOf(s.main, 'ro'), 'task-complete');
  assert.equal(tick.disabled, true);
  assert.match(tick.getAttribute('aria-label'), /^You can’t change this task: /);
  assert.equal(rowOf(s.main, 'ro').getAttribute('data-readonly'), 'true');
  const add = one(s.main, 'btn-new-task');
  assert.equal(add.disabled, true);
  assert.ok(one(s.main, 'tasks-readonly'));
  ctl.dispose();
});

test('states: no task list (create button, or a plain explanation without own space), lists without tasks, nothing in a filter, errors', async () => {
  const s = await setup({ items: {} });
  for (const c of s.env.access.calendars()) s.env.access.remove(c.href);
  const ctl = mount(s.ctx({}, { name: 'tasks' }), s.deps);
  await flush(30);
  assert.ok(one(s.main, 'tasks-nolist'));
  assert.equal(s.main.querySelector('[data-testid="tasks-screen"]').getAttribute('data-state'), 'ready');
  assert.equal(one(s.main, 'btn-create-task-list') !== null, s.env.access.canCreateCollections());
  ctl.dispose();

  const e = await setup({ items: {} });
  const c2 = mount(e.ctx({}, { name: 'tasks' }), e.deps);
  await flush(30);
  assert.ok(one(e.main, 'tasks-empty'));
  assert.ok(one(e.main, 'btn-new-task-empty'));
  assert.equal(one(e.main, 'task-list').hasAttribute('hidden'), true);
  c2.dispose();

  const f = await setup();
  const c3 = mount(f.ctx({ filter: 'today' }, { name: 'tasks' }), f.deps);
  await flush(30);
  await c3.update(f.ctx({ filter: 'overdue' }, { name: 'tasks' }));
  assert.equal(one(f.main, 'tasks-filter-empty'), null);
  f.env.server.put(`${CAL_A}x.ics`, f.env.server.at(`${CAL_A}over.ics`).text);
  c3.dispose();
});

test('the loaded lists are only the task lists: a calendar that accepts events only is not offered', async () => {
  const s = await mounted();
  assert.deepEqual(all(s.main, 'tasklist-toggle').map((n) => n.getAttribute('data-href')).sort(), [CAL_A, '/alice/cal-b/', CAL_TASKS].sort());
  assert.equal(all(s.main, 'tasklist-toggle').some((n) => n.getAttribute('data-href') === CAL_RO), false);
  s.ctl.dispose();
});

test('hostile text is drawn as text: no element comes out of a title, a category or a list name', async () => {
  const s = await setup({ items: { [`${CAL_A}h.ics`]: s0('<img src=x onerror=alert(1)>') } });
  const ctl = mount(s.ctx({}, { name: 'tasks' }), s.deps);
  await flush(40);
  const row = rowOf(s.main, 'h');
  assert.equal(inside(row, 'task-open').querySelector('img'), null);
  assert.match(inside(row, 'task-open').textContent, /<img src=x onerror=alert\(1\)>/);
  ctl.dispose();
});
function s0(summary) {
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example Corp//Tasks 1.0//EN\nBEGIN:VTODO\nUID:h@example.org\nDTSTAMP:20260101T000000Z\nSUMMARY:${summary}\nCATEGORIES:<b>x</b>\nEND:VTODO\nEND:VCALENDAR\n`;
}

test('dispose releases the lists it enabled; the screen element is removed', async () => {
  const s = await mounted();
  assert.ok(s.calendars.isEnabled(CAL_A));
  s.ctl.dispose();
  assert.equal(s.calendars.isEnabled(CAL_A), false);
  assert.equal(s.main.querySelector('[data-testid="tasks-screen"]'), null);
});

// ------------------------------------------------------------------ the detail

async function detail(uid, list = CAL_A, opts = {}) {
  const s = await setup(opts);
  s.conflicts = [];
  const ctl = mountTask(s.ctx({ key: uid, list }, { name: 'task' }), s.deps);
  await flush(40);
  s.ctl = ctl;
  return s;
}

test('detail: fields, read-only repeat rule, relations; complete is disabled for the repeating task; an unknown list or key is "not found"', async () => {
  const s = await detail('parent@example.org');
  assert.ok(one(s.main, 'task-detail'));
  assert.equal(text(s.main, 'task-title'), 'Project');
  assert.match(text(s.main, 'task-due'), /Aug 1/);
  const kids = one(s.main, 'task-children');
  assert.match(kids.textContent, /Write the plan/);
  assert.equal(one(s.main, 'btn-edit-task').getAttribute('href'), '#/tasks/parent%40example.org/edit?list=%2Falice%2Fcal-a%2F');
  s.ctl.dispose();

  const c = await detail('child@example.org');
  assert.match(one(c.main, 'task-parent').textContent, /Project/);
  c.ctl.dispose();

  const r = await detail('rep@example.org');
  assert.match(text(r.main, 'task-recurrence'), /Every week/);
  assert.equal(one(r.main, 'task-complete').disabled, true);
  assert.match(one(r.main, 'task-complete').getAttribute('aria-label'), /^Repeating tasks can’t be completed here yet/);
  r.ctl.dispose();

  const o = await detail('orphan@example.org');
  assert.equal(one(o.main, 'task-parent').textContent.includes('Parent not found'), true);
  o.ctl.dispose();

  const n = await detail('nope@example.org');
  assert.ok(one(n.main, 'task-notfound'));
  assert.equal(n.main.querySelector('[data-testid="task-screen"]').getAttribute('data-state'), 'error');
  n.ctl.dispose();
  const l = await detail('over@example.org', '/mallory/secret/');
  assert.equal(one(l.main, 'task-notfound').getAttribute('data-reason'), 'nolist');
  l.ctl.dispose();
});

test('detail: complete and delete go through the write path; delete asks first (dialog-delete-task)', async () => {
  const s = await detail('over@example.org');
  click(one(s.main, 'task-complete'));
  await flush(40);
  assert.match(s.env.server.at(`${CAL_A}over.ics`).text, /STATUS:COMPLETED/);
  assert.equal(one(s.main, 'task-complete').getAttribute('aria-pressed'), 'true');
  click(one(s.main, 'btn-delete-task'));
  await flush(10);
  const dlg = s.main.ownerDocument.body.querySelector('[data-testid="dialog-delete-task"]');
  assert.ok(dlg, 'the confirmation is open');
  const confirm = dlg.querySelector('[data-testid="dialog-confirm-delete"]');
  assert.equal(confirm.textContent.replace(/[\u2068\u2069]/g, ''), 'Delete task “Pay the invoice”');
  click(confirm);
  await flush(40);
  assert.equal(s.env.server.at(`${CAL_A}over.ics`), undefined);
  assert.equal(s.navs.at(-1).hash, '#/tasks');
  s.ctl.dispose();
});

test('detail: an unknown time zone is read-only with a warning, the raw text, and delete only', async () => {
  const mars = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example Corp//Tasks 1.0//EN\nBEGIN:VTODO\nUID:mars@example.org\nDTSTAMP:20260101T000000Z\nSUMMARY:Mars errand\nDUE;TZID=Mars/Olympus:20260604T120000\nEND:VTODO\nEND:VCALENDAR\n`;
  const s = await detail('mars@example.org', CAL_A, { items: { [`${CAL_A}mars.ics`]: mars } });
  assert.ok(one(s.main, 'task-readonly'));
  assert.match(one(s.main, 'task-raw').textContent, /Mars\/Olympus/);
  assert.equal(one(s.main, 'btn-edit-task'), null);
  assert.ok(one(s.main, 'btn-delete-task'));
  s.ctl.dispose();
});

test('focus: a completed row that leaves the list hands the focus to the row now in its place; a repainted row keeps it', async () => {
  const s = await mounted();
  const tick = inside(rowOf(s.main, 'over'), 'task-complete');
  tick.focus();
  assert.equal(s.main.ownerDocument.activeElement, tick);
  click(tick);
  await flush(40);
  const now = s.main.ownerDocument.activeElement;
  assert.ok(now && now.getAttribute('data-testid') === 'task-open', 'the focus is on a row, not on the page');
  assert.equal(rowOf(s.main, 'over'), null);
  // a repaint (the language of the status text does not matter: a priority change arrives by sync) keeps the focus on the same control
  const todayTick = inside(rowOf(s.main, 'today'), 'task-complete');
  todayTick.focus();
  s.env.server.outside(`${CAL_TASKS}today.ics`, s.env.server.at(`${CAL_TASKS}today.ics`).text.replace('PRIORITY:5', 'PRIORITY:1'));
  await s.env.stores.get(CAL_TASKS).refresh({ reason: 'test' });
  await flush(30);
  const after = s.main.ownerDocument.activeElement;
  assert.equal(after.getAttribute('data-testid'), 'task-complete');
  assert.equal(after.closest ? after.closest('[data-testid="task-row"]') : null, after.closest ? rowOf(s.main, 'today') : null);
  assert.match(inside(rowOf(s.main, 'today'), 'task-priority').textContent, /High priority/);
  s.ctl.dispose();
});
