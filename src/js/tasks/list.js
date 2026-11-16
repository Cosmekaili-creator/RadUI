// SPDX-License-Identifier: AGPL-3.0-or-later
// The merged task list (RUN3 WP C1, SPECS 4.2, 10a-5): DOM-free logic. It turns the parsed VTODO items of every
// enabled task list into described records, filters them (open, today, overdue, done, all), sorts them (due,
// priority) and arranges RELATED-TO sub-tasks under their parent (read-only hierarchy; editing is v1.1).
//
//   describeTask(entry, {tz, now})      one record from {href, collection, etag, item} (item = a parsed Item)
//   matches(record, filter)             does a record belong to a filter
//   countFilters(records)               {open, today, overdue, done, all}
//   buildTree(records, {visible, filter, sort})   {roots: [{rec, children, context, orphan}], total}
//   compareTasks(sort)                  the comparator of a sort
//   priorityLevel(p), priorityRank(p)   1-4 high, 5 medium, 6-9 low, 0 or none = none
//
// "Today" and "overdue" are judged in the DISPLAY time zone: a DATE due is overdue from the next day on; a due
// date-time is overdue once it has passed (by its instant, or by the wall clock for floating values). All-day and
// floating values are never shifted. A due in an unknown zone is read at its own wall clock (the item is read-only).
// The record keeps no Item: it is a plain object that is safe to keep between renders.

import { timeInfo } from '../model/icalview.js';
import { dateMs, isoOfMs, todayIn } from '../calendar/grid.js';
import { wallInZone } from '../calendar/tzprefs.js';

export const FILTERS = Object.freeze(['open', 'today', 'overdue', 'done', 'all']);
export const SORTS = Object.freeze(['due', 'priority']);
export const DEFAULT_FILTER = 'open';
export const DEFAULT_SORT = 'due';

export const parseFilter = (v) => (FILTERS.includes(v) ? v : DEFAULT_FILTER);
export const parseSort = (v) => (SORTS.includes(v) ? v : DEFAULT_SORT);

/** 'none' | 'high' (1-4) | 'medium' (5) | 'low' (6-9). */
export const priorityLevel = (p) => (!Number.isInteger(p) || p < 1 || p > 9 ? 'none' : p <= 4 ? 'high' : p === 5 ? 'medium' : 'low');
/** Sort rank: 1 first, 9 last, no priority after all of them. */
export const priorityRank = (p) => (Number.isInteger(p) && p >= 1 && p <= 9 ? p : 10);

const MAX_DEPTH = 24;

/** RELATED-TO of a VTODO: the uids it names as parent (no RELTYPE or PARENT) and as children (RELTYPE=CHILD). */
export function relationsOf(comp) {
  const parents = [];
  const children = [];
  for (const p of comp.props('RELATED-TO')) {
    const uid = String(p.value || '').trim();
    if (!uid) continue;
    const rt = p.param('RELTYPE');
    const type = rt && rt.values.length ? String(rt.values[0].text).toUpperCase() : 'PARENT';
    if (type === 'PARENT') parents.push(uid);
    else if (type === 'CHILD') children.push(uid);
  }
  return { parents, children };
}

/**
 * The time of a due or start as the list needs it. `day` is the calendar day in the display zone (a DATE and a floating
 * value keep their own day), `wall` is a sortable wall clock in the display zone (ms as if UTC), `instant` the absolute
 * time or null (dates, floating, unknown zone).
 */
export function timeView(spec, zones, tz) {
  if (!spec) return null;
  const day = spec.iso.slice(0, 10);
  if (spec.kind === 'date') return { spec, allDay: true, floating: false, unknown: false, day, wall: dateMs(day), instant: null };
  const info = timeInfo(spec, zones);
  if (info.tzClass === 'unknown') return { spec, allDay: false, floating: false, unknown: true, day, wall: info.wallMs, instant: null };
  if (info.instant !== null) {
    const wall = wallInZone(info.instant, tz);
    return { spec, allDay: false, floating: false, unknown: false, day: isoOfMs(wall), wall, instant: info.instant };
  }
  return { spec, allDay: false, floating: true, unknown: false, day, wall: info.wallMs, instant: null };
}

const isDone = (status, completed) => status === 'COMPLETED' || status === 'CANCELLED' || (!status && Boolean(completed));

/**
 * @param {{href: string, collection: string, etag: string, item: object}} entry `item` is a parsed task Item
 * @param {{tz: string, now: number}} cx display zone and the current instant (ms)
 * @returns {object|null} null when the item cannot be read as a task
 */
export function describeTask(entry, { tz, now }) {
  const { item } = entry;
  if (!item || item.kind !== 'task') return null;
  let f;
  let rel;
  try {
    f = item.fields();
    rel = relationsOf(item.main);
  } catch {
    return null;
  }
  const zones = item.zones;
  const today = todayIn(tz, now);
  const done = isDone(f.status, f.completed);
  let due = null;
  let start = null;
  try {
    due = timeView(f.due, zones, tz);
    start = timeView(f.start, zones, tz);
  } catch {
    return null;
  }
  let overdue = false;
  if (due && !done) {
    if (due.allDay) overdue = due.day < today;
    else if (due.instant !== null) overdue = due.instant < now;
    else overdue = due.wall < wallInZone(now, tz);
  }
  const priority = Number.isInteger(f.priority) ? f.priority : 0;
  return {
    key: entry.href,
    href: entry.href,
    collection: entry.collection,
    etag: entry.etag,
    uid: item.uid || '',
    summary: f.summary,
    description: f.description,
    status: f.status || '',
    percent: f.percent,
    priority,
    prio: priorityLevel(priority),
    done,
    cancelled: f.status === 'CANCELLED',
    due,
    start,
    dueDay: due ? due.day : null,
    dueWall: due ? due.wall : null,
    today: Boolean(due) && due.day === today,
    overdue,
    recurring: Boolean(f.rrule),
    rrule: f.rrule || null,
    categories: f.categories || [],
    completed: f.completed || null,
    parentUids: rel.parents,
    childUids: rel.children,
    readOnly: Boolean(item.readOnly),
    readOnlyReason: item.readOnly ? item.readOnlyReason || 'read-only' : null,
  };
}

/** Does a record belong to a filter? (done = completed or cancelled; today = due today and not done.) */
export function matches(rec, filter) {
  switch (filter) {
    case 'all':
      return true;
    case 'done':
      return rec.done;
    case 'today':
      return !rec.done && rec.today;
    case 'overdue':
      return !rec.done && rec.overdue;
    case 'open':
    default:
      return !rec.done;
  }
}

export function countFilters(records) {
  const out = { open: 0, today: 0, overdue: 0, done: 0, all: records.length };
  for (const r of records) for (const f of ['open', 'today', 'overdue', 'done']) if (matches(r, f)) out[f] += 1;
  return out;
}

const cmpNullLast = (a, b) => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0);
const cmpText = (a, b) => {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The comparator of a sort: due date (no due date last), or priority; ties by the other, then title, then href. */
export function compareTasks(sort) {
  const byDue = (a, b) => cmpNullLast(a.dueWall, b.dueWall);
  const byPrio = (a, b) => priorityRank(a.priority) - priorityRank(b.priority);
  const first = sort === 'priority' ? byPrio : byDue;
  const second = sort === 'priority' ? byDue : byPrio;
  return (a, b) => first(a, b) || second(a, b) || cmpText(a.summary, b.summary) || cmpText(a.href, b.href);
}

/**
 * The hierarchy. Parents are looked up among ALL records (a parent in a hidden list is known, so its child is not an
 * orphan), but only visible records are drawn. A child names its parent with RELATED-TO (no RELTYPE or PARENT); a parent
 * may also name its children (RELTYPE=CHILD). A claim to a uid that no loaded task has makes an `orphan` (shown at top
 * level with "parent not found"). A cycle is cut at the record that closes it. A parent that does not match the filter is
 * kept as `context` when one of its children matches.
 * @returns {{roots: object[], total: number, nodes: Map<object, object>}} `total` = records that match the filter
 */
export function buildTree(records, { visible = () => true, filter = DEFAULT_FILTER, sort = DEFAULT_SORT } = {}) {
  const same = new Map();
  const byUid = new Map();
  const childClaims = new Map();
  for (const r of records) {
    if (!r.uid) continue;
    if (!same.has(`${r.collection}|${r.uid}`)) same.set(`${r.collection}|${r.uid}`, r);
    if (!byUid.has(r.uid)) byUid.set(r.uid, r);
    for (const c of r.childUids) if (!childClaims.has(`${r.collection}|${c}`)) childClaims.set(`${r.collection}|${c}`, r);
  }
  const parentOf = new Map();
  const orphan = new Set();
  for (const r of records) {
    let parent = null;
    for (const uid of r.parentUids) {
      const p = same.get(`${r.collection}|${uid}`) || byUid.get(uid) || null;
      if (p && p !== r) {
        parent = p;
        break;
      }
    }
    if (!parent && r.uid) {
      const p = childClaims.get(`${r.collection}|${r.uid}`) || null;
      if (p && p !== r) parent = p;
    }
    if (!parent && r.parentUids.length) orphan.add(r);
    parentOf.set(r, parent);
  }
  for (const r of records) {
    // a cycle (or a chain longer than MAX_DEPTH) is cut at the record that closes it: it becomes a root
    let p = parentOf.get(r);
    let steps = 0;
    while (p && p !== r && steps < MAX_DEPTH) {
      p = parentOf.get(p);
      steps += 1;
    }
    if (p) parentOf.set(r, null);
  }
  const vis = records.filter((r) => visible(r));
  const visSet = new Set(vis);
  const matched = new Set(vis.filter((r) => matches(r, filter)));
  const shown = new Set(matched);
  for (const r of matched) {
    let p = parentOf.get(r);
    for (let i = 0; p && visSet.has(p) && !shown.has(p) && i < MAX_DEPTH; i += 1) {
      shown.add(p);
      p = parentOf.get(p);
    }
  }
  const cmp = compareTasks(sort);
  const nodes = new Map();
  for (const r of shown) nodes.set(r, { rec: r, children: [], context: !matched.has(r), orphan: orphan.has(r) });
  const roots = [];
  for (const r of shown) {
    const p = parentOf.get(r);
    if (p && shown.has(p)) nodes.get(p).children.push(nodes.get(r));
    else roots.push(nodes.get(r));
  }
  const order = (list) => {
    list.sort((a, b) => cmp(a.rec, b.rec));
    for (const n of list) order(n.children);
  };
  order(roots);
  return { roots, total: matched.size, nodes };
}

/** Every record of a tree in display order (parents before their children). */
export function flatten(roots) {
  const out = [];
  const walk = (list, depth) => {
    for (const n of list) {
      out.push({ ...n, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** href of a task -> the route key: the UID when it is unique in its list (and usable in a URL), else the file name. */
export function makeTaskKeyer(records) {
  const counts = new Map();
  for (const r of records) if (r.uid) counts.set(`${r.collection}|${r.uid}`, (counts.get(`${r.collection}|${r.uid}`) || 0) + 1);
  return (rec) => {
    if (rec.uid && rec.uid.length <= 255 && rec.uid !== 'new' && counts.get(`${rec.collection}|${rec.uid}`) === 1) return rec.uid;
    const leaf = String(rec.href).split('/').filter(Boolean).pop() || '';
    try {
      return decodeURIComponent(leaf);
    } catch {
      return leaf;
    }
  };
}
