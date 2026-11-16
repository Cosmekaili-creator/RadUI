// SPDX-License-Identifier: AGPL-3.0-or-later
// The merged task list logic (WP C1): described records, filters, sorts, the sub-task hierarchy, time zones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, compareTasks, countFilters, flatten, makeTaskKeyer, matches, parseFilter, parseSort, priorityLevel, priorityRank } from '../../../src/js/tasks/list.js';
import { rec, wrap } from './_tasks.mjs';
import { openItem } from '../../../src/js/model/item.js';
import { describeTask } from '../../../src/js/tasks/list.js';

const NOW = Date.parse('2026-06-03T10:00:00Z'); // Wed 3 June 2026, 12:00 in Paris
const D = (iso) => `DUE;VALUE=DATE:${iso}`;
const names = (roots) => flatten(roots).map((n) => `${'-'.repeat(n.depth)}${n.rec.uid}${n.context ? '*' : ''}`);

test('priority: 1-4 high, 5 medium, 6-9 low, 0 or none = none; rank puts none last', () => {
  assert.deepEqual([0, 1, 4, 5, 6, 9, null, 12].map(priorityLevel), ['none', 'high', 'high', 'medium', 'low', 'low', 'none', 'none']);
  assert.ok(priorityRank(9) < priorityRank(0));
  assert.equal(priorityRank(null), 10);
});

test('parseFilter and parseSort fall back to the defaults', () => {
  assert.equal(parseFilter('overdue'), 'overdue');
  assert.equal(parseFilter('bogus'), 'open');
  assert.equal(parseFilter(undefined), 'open');
  assert.equal(parseSort('priority'), 'priority');
  assert.equal(parseSort('x'), 'due');
});

test('describeTask: today, overdue and done are judged in the DISPLAY zone', () => {
  // 2026-06-03T10:00Z: 12:00 in Paris, 06:00 in New York, 15:45 in Kathmandu
  const dateToday = rec('a', 'date today', [D('20260603')]);
  assert.equal(dateToday.today, true);
  assert.equal(dateToday.overdue, false);
  const dateYesterday = rec('b', 'date yesterday', [D('20260602')]);
  assert.equal(dateYesterday.overdue, true);
  // a due at 11:00 UTC today is later today in Paris and not overdue yet; at 09:00 UTC it is overdue but still "today"
  const later = rec('c', 'later', ['DUE:20260603T110000Z']);
  assert.deepEqual([later.today, later.overdue], [true, false]);
  const earlier = rec('d', 'earlier', ['DUE:20260603T090000Z']);
  assert.deepEqual([earlier.today, earlier.overdue], [true, true]);
  // the same instant is another DAY in Kathmandu (+05:45): 23:00 UTC on 2 June is 04:45 on 3 June
  const edge = ['DUE:20260602T230000Z'];
  assert.equal(rec('e', 'edge', edge, { tz: 'Europe/Paris' }).dueDay, '2026-06-03');
  assert.equal(rec('e', 'edge', edge, { tz: 'America/New_York' }).dueDay, '2026-06-02');
  assert.equal(rec('e', 'edge', edge, { tz: 'Asia/Kathmandu' }).dueDay, '2026-06-03');
  assert.equal(rec('e', 'edge', edge, { tz: 'Australia/Lord_Howe' }).dueDay, '2026-06-03'); // +10:30, 09:30
  // a zoned due keeps its own zone for the instant: 17:00 in New York is 21:00 UTC
  const ny = rec('f', 'ny', ['DUE;TZID=America/New_York:20260603T170000']);
  assert.equal(ny.due.instant, Date.parse('2026-06-03T21:00:00Z'));
  assert.equal(ny.overdue, false);
  // floating: compared with the wall clock of the display zone (12:00 in Paris)
  assert.equal(rec('g', 'float', ['DUE:20260603T110000']).overdue, true);
  assert.equal(rec('h', 'float', ['DUE:20260603T130000']).overdue, false);
  // done is never overdue
  assert.equal(rec('i', 'done', [D('20260101'), 'STATUS:COMPLETED']).overdue, false);
  assert.equal(rec('j', 'cancelled', ['STATUS:CANCELLED']).done, true);
  assert.equal(rec('k', 'completed without a status', ['COMPLETED:20260101T000000Z']).done, true);
  assert.equal(rec('l', 'plain').done, false);
});

test('describeTask: unknown zone is read at its own wall clock; the record is a plain object; a non-task is null', () => {
  const r = rec('m', 'mars', ['DUE;TZID=Mars/Olympus:20260603T120000']);
  assert.equal(r.due.unknown, true);
  assert.equal(r.due.instant, null);
  assert.equal(r.readOnly, true);
  assert.equal(r.dueDay, '2026-06-03');
  assert.doesNotThrow(() => JSON.stringify(r));
  const ev = openItem(wrap('BEGIN:VEVENT\nUID:e\nDTSTAMP:20260101T000000Z\nDTSTART:20260601T100000Z\nSUMMARY:x\nEND:VEVENT\n'));
  assert.equal(describeTask({ href: '/a/e.ics', collection: '/a/', etag: '1', item: ev }, { tz: 'UTC', now: NOW }), null);
});

test('describeTask: repeating tasks, categories, priority level, percent', () => {
  const r = rec('n', 'weekly', ['RRULE:FREQ=WEEKLY;COUNT=3', D('20260601'), 'PRIORITY:3', 'PERCENT-COMPLETE:40', 'CATEGORIES:home,garden', 'STATUS:IN-PROCESS']);
  assert.equal(r.recurring, true);
  assert.equal(r.prio, 'high');
  assert.equal(r.percent, 40);
  assert.deepEqual(r.categories, ['home', 'garden']);
});

const SET = () => [
  rec('over', 'Overdue', [D('20260520'), 'PRIORITY:9']),
  rec('today', 'Today', [D('20260603'), 'PRIORITY:1']),
  rec('later', 'Later', [D('20260710')]),
  rec('nodue', 'No due date', ['PRIORITY:5']),
  rec('done', 'Done', [D('20260401'), 'STATUS:COMPLETED']),
  rec('cancel', 'Cancelled', ['STATUS:CANCELLED']),
];

test('filters: open, today, overdue, done, all, and their counts', () => {
  const all = SET();
  const ids = (f) => all.filter((r) => matches(r, f)).map((r) => r.uid).sort();
  assert.deepEqual(ids('open'), ['later', 'nodue', 'over', 'today']);
  assert.deepEqual(ids('today'), ['today']);
  assert.deepEqual(ids('overdue'), ['over']);
  assert.deepEqual(ids('done'), ['cancel', 'done']);
  assert.equal(ids('all').length, 6);
  assert.deepEqual(countFilters(all), { open: 4, today: 1, overdue: 1, done: 2, all: 6 });
});

test('sort by due: earliest first, no due date last, ties by priority; sort by priority: 1 first, none last', () => {
  const all = SET();
  const byDue = buildTree(all, { filter: 'all', sort: 'due' }).roots.map((n) => n.rec.uid);
  assert.deepEqual(byDue, ['done', 'over', 'today', 'later', 'nodue', 'cancel']);
  const byPrio = buildTree(all, { filter: 'open', sort: 'priority' }).roots.map((n) => n.rec.uid);
  assert.deepEqual(byPrio, ['today', 'nodue', 'over', 'later']);
  // total order: same keys fall back to the title, then the href
  const a = rec('x1', 'Beta', [D('20260701')]);
  const b = rec('x2', 'alpha', [D('20260701')]);
  assert.deepEqual([a, b].sort(compareTasks('due')).map((r) => r.uid), ['x2', 'x1']);
});

test('hierarchy: children under their parent (RELATED-TO child side and CHILD side), indented depth, sorted', () => {
  const recs = [
    rec('p', 'Project', [D('20260801')]),
    rec('c1', 'Child 1', ['RELATED-TO:p', D('20260702')]),
    rec('c2', 'Child 2', ['RELATED-TO;RELTYPE=PARENT:p', D('20260701')]),
    rec('g', 'Grandchild', ['RELATED-TO:c1']),
    rec('c3', 'Claimed by the parent only'),
  ];
  recs[0].childUids.push('c3');
  const t = buildTree(recs, { filter: 'open' });
  assert.deepEqual(names(t.roots), ['p', '-c2', '-c1', '--g', '-c3']);
  assert.equal(t.total, 5);
  // SIBLING and DEPENDS-ON never make a parent
  const s = rec('s', 'Sibling', ['RELATED-TO;RELTYPE=SIBLING:p', 'RELATED-TO;RELTYPE=DEPENDS-ON:p']);
  assert.deepEqual(names(buildTree([recs[0], s], { filter: 'open' }).roots).sort(), ['p', 's']);
});

test('hierarchy: an orphan child is a root flagged "parent not found"; a parent in a hidden list is not a missing parent', () => {
  const orphan = rec('o', 'Orphan', ['RELATED-TO:nowhere']);
  const t = buildTree([orphan], { filter: 'open' });
  assert.equal(t.roots.length, 1);
  assert.equal(t.roots[0].orphan, true);
  const parent = rec('p', 'Parent', [], { collection: '/alice/hidden/' });
  const kid = rec('k', 'Kid', ['RELATED-TO:p'], { collection: '/alice/tasks/' });
  const t2 = buildTree([parent, kid], { filter: 'open', visible: (r) => r.collection === '/alice/tasks/' });
  assert.deepEqual(names(t2.roots), ['k']);
  assert.equal(t2.roots[0].orphan, false);
});

test('hierarchy under a filter: a parent that does not match stays as context when a child matches', () => {
  const recs = [rec('p', 'Parent', [D('20260801'), 'STATUS:COMPLETED']), rec('c', 'Child', ['RELATED-TO:p', D('20260520')])];
  const t = buildTree(recs, { filter: 'overdue' });
  assert.deepEqual(names(t.roots), ['p*', '-c']);
  assert.equal(t.total, 1);
  assert.equal(buildTree(recs, { filter: 'overdue' }).nodes.get(recs[0]).context, true);
});

test('hierarchy: a cycle is cut, a task is never its own parent, duplicates in two lists prefer the same list', () => {
  const a = rec('a', 'A', ['RELATED-TO:b']);
  const b = rec('b', 'B', ['RELATED-TO:a']);
  const self = rec('s', 'Self', ['RELATED-TO:s']);
  const t = buildTree([a, b, self], { filter: 'open' });
  assert.equal(flatten(t.roots).length, 3);
  assert.ok(t.roots.length >= 1);
  const p1 = rec('p', 'P in 1', [], { collection: '/alice/one/' });
  const p2 = rec('p', 'P in 2', [], { collection: '/alice/two/' });
  const k = rec('k', 'K', ['RELATED-TO:p'], { collection: '/alice/two/' });
  const t2 = buildTree([p1, p2, k], { filter: 'open' });
  const p2node = t2.roots.find((n) => n.rec === p2);
  assert.deepEqual(p2node.children.map((n) => n.rec.uid), ['k']);
});

test('hidden lists: only visible records are drawn, counts of the filter exclude hidden ones', () => {
  const a = rec('a', 'A', [], { collection: '/alice/one/' });
  const b = rec('b', 'B', [], { collection: '/alice/two/' });
  const t = buildTree([a, b], { filter: 'open', visible: (r) => r.collection === '/alice/one/' });
  assert.deepEqual(names(t.roots), ['a']);
});

test('route keys: the UID when unique in its list, else the file name', () => {
  const a = rec('same', 'A', [], { collection: '/alice/one/' });
  const b = rec('same', 'B', [], { collection: '/alice/one/' });
  b.href = '/alice/one/other%20file.ics';
  const c = rec('same', 'C', [], { collection: '/alice/two/' });
  const keyOf = makeTaskKeyer([a, b, c]);
  assert.equal(keyOf(c), 'same');
  assert.equal(keyOf(b), 'other file.ics');
  assert.equal(keyOf(a), 'same.ics');
  const n = rec('new', 'Reserved', []);
  assert.equal(makeTaskKeyer([n])(n), 'new.ics');
});
