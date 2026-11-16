// SPDX-License-Identifier: AGPL-3.0-or-later
// The task rows (RUN3 WP C1): one `<li data-testid="task-row">` per task, nested `<ul>` for sub-tasks, kept in a pool
// keyed by href so that a refresh, a filter or sort change, or a list toggle INSERTS, REMOVES and MOVES individual
// nodes and never rebuilds the list (same model as the calendar's event nodes, SPECS 4.1): scroll position and focus stay
// where they are. A row whose signature did not change is not touched.
//
// Row: the completion button (`task-complete`, `aria-pressed`) and the link to the task (`task-open`); titles and
// categories are text nodes only. Priority is bars plus a word, overdue is red plus "Overdue since ...", repeating tasks
// say so in words, and a task whose parent is missing says "parent not found". Test ids: task-row (data-uid, data-href,
// data-list, data-status, data-readonly, data-key, data-depth), task-complete, task-open, task-subtasks.

import { h } from '../../ui.js';
import { COLOUR_ALLOW, accessibleName, dueText, nodeAttrs, taskHash } from './common.js';

const bar = () => h('span', { class: 'prio__bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));

/** Why the completion button of a record is disabled: 'repeating' | 'readonly' | null. */
export function completeBlock(rec) {
  if (rec.readOnly || rec.listReadOnly) return 'readonly';
  if (rec.recurring && !rec.done) return 'repeating';
  return null;
}

/** The accessible name and explanation of the completion button. */
export function completeLabel(rec, t, named) {
  const block = completeBlock(rec);
  if (block === 'repeating') return t('tasks.completeRepeating', { name: named });
  if (block === 'readonly') return t('tasks.completeReadonly', { name: named });
  return t(rec.done ? 'tasks.markOpen' : 'tasks.markDone', { name: named });
}

/**
 * @param {object} o
 * @param {HTMLElement} o.ul the root list
 * @param {(key: string, params?: object) => string} o.t
 * @param {(href: string) => {name: string, color: string}|null} o.listOf
 * @param {(rec: object) => void} o.onComplete
 */
export function createRowTree({ ul, t, lang = 'en', use24h = null, today = '', listOf, onComplete, showLists = true }) {
  let cx = { t, lang, use24h, today, showLists };
  const pool = new Map(); // href -> {li, line, sub, sig}

  function signature(node, depth) {
    const r = node.rec;
    const list = listOf(r.collection) || {};
    return JSON.stringify([r.summary, r.status, r.percent, r.priority, r.dueDay, r.due && r.due.wall, r.overdue, r.today, r.recurring, r.categories, r.readOnly, r.listReadOnly, r.routeKey, list.name, list.color, cx.showLists, node.context, node.orphan, depth, cx.lang, cx.use24h, cx.today]);
  }

  function paint(node, entry, depth) {
    const r = node.rec;
    const { t: tr, lang: lg, use24h: u24 } = cx;
    const list = listOf(r.collection) || { name: '', color: null };
    const named = r.summary || tr('tasks.untitled');
    const due = dueText(r, { t: tr, lang: lg, use24h: u24, today: cx.today });
    const block = completeBlock(r);
    const tick = h('button', {
      type: 'button',
      class: ['tick', r.done && 'is-done'],
      testid: 'task-complete',
      'aria-pressed': String(r.done),
      'aria-label': completeLabel(r, tr, named),
      title: block ? completeLabel(r, tr, named) : null,
      disabled: Boolean(block),
      'aria-disabled': block ? 'true' : null,
      'data-block': block,
      write: true,
      on: { click: () => onComplete(r) },
    }, h('span', { class: 'tick__mark', 'aria-hidden': 'true' }, r.done ? '✓' : ''));
    const meta = h(
      'span',
      { class: 'task__meta' },
      due.none ? null : h('span', { class: ['task__due', due.overdue && 'is-overdue'], testid: 'task-due' }, due.text),
      r.prio !== 'none' ? h('span', { class: ['prio', `prio--${r.prio}`], testid: 'task-priority' }, bar(), tr(`tasks.prio.${r.prio}`)) : null,
      r.status === 'IN-PROCESS' ? h('span', { class: 'tag' }, r.percent !== null && r.percent !== undefined ? tr('tasks.inProgressPct', { n: r.percent }) : tr('tasks.state.IN-PROCESS')) : null,
      r.status === 'CANCELLED' ? h('span', { class: 'tag' }, tr('tasks.state.CANCELLED')) : null,
      r.recurring ? h('span', { class: 'tag', testid: 'task-repeats' }, h('span', { 'aria-hidden': 'true' }, '↻ '), tr('tasks.repeats')) : null,
      r.categories.map((c) => h('span', { class: 'tag tag--quiet' }, h('bdi', null, c))),
      cx.showLists && list.name ? h('span', { class: 'task__list' }, h('span', { class: 'dot', 'aria-hidden': 'true', vars: { allow: COLOUR_ALLOW, values: { '--cal': list.color } } }), h('bdi', null, list.name)) : null,
      node.orphan ? h('span', { class: 'tag tag--warn', testid: 'task-orphan' }, tr('tasks.parentMissing')) : null,
      node.context ? h('span', { class: 'tag tag--quiet', testid: 'task-context' }, tr('tasks.context')) : null,
    );
    const link = h(
      'a',
      { class: 'task__main', href: taskHash(r.routeKey, { list: r.collection }), testid: 'task-open', 'aria-label': accessibleName(r, { t: tr, due, listName: cx.showLists ? list.name : '' }) },
      h('span', { class: 'task__title' }, h('bdi', null, named)),
      meta,
    );
    entry.line.replaceChildren(tick, link);
    const attrs = nodeAttrs(r);
    for (const [k, v] of Object.entries(attrs)) entry.li.setAttribute(k, v);
    entry.li.setAttribute('data-depth', String(depth));
    entry.li.className = ['task', r.done && 'is-done', r.overdue && 'is-overdue', node.context && 'is-context', block && 'is-blocked'].filter(Boolean).join(' ');
    entry.sub.setAttribute('aria-label', tr('tasks.subtasksOf', { name: named }));
  }

  function create(r) {
    const line = h('div', { class: 'task__line' });
    const sub = h('ul', { class: 'tasks tasks--sub', testid: 'task-subtasks' });
    const li = h('li', { class: 'task', testid: 'task-row' }, line, sub);
    return { li, line, sub, sig: null };
  }

  /** Put `lis` into `box` in this order, touching only what is out of place. */
  function place(box, lis) {
    const want = new Set(lis);
    for (const c of [...box.childNodes]) if (!want.has(c)) box.removeChild(c);
    lis.forEach((li, i) => {
      const at = box.childNodes[i] || null;
      if (at !== li) box.insertBefore(li, at);
    });
  }

  const api = {
    /** New texts, language, clock or "today" (a different render of every row). */
    configure(next) {
      cx = { ...cx, ...next };
    },
    /**
     * @param {object[]} roots buildTree(...).roots
     * @param {{busy?: Set<string>, doc?: object}} [opts]
     * @returns {{added: number, removed: number, replaced: number}}
     */
    sync(roots, { busy = new Set(), doc = null } = {}) {
      const stat = { added: 0, removed: 0, replaced: 0 };
      const seen = new Set();
      const active = doc ? doc.activeElement : null;
      let focusedHref = null;
      let focusedTest = null;
      if (active) {
        for (const [href, e] of pool) {
          if (e.li.contains(active)) {
            focusedHref = href;
            focusedTest = typeof active.getAttribute === 'function' ? active.getAttribute('data-testid') : null;
          }
        }
      }
      const before = [...ul.querySelectorAll('[data-testid="task-row"]')].map((li) => li.getAttribute('data-href'));
      const build = (nodes, box, depth) => {
        const lis = [];
        for (const node of nodes) {
          const href = node.rec.href;
          seen.add(href);
          let entry = pool.get(href);
          if (!entry) {
            entry = create(node.rec);
            pool.set(href, entry);
            stat.added += 1;
          }
          const sig = signature(node, depth);
          if (entry.sig !== sig) {
            if (entry.sig !== null) stat.replaced += 1;
            paint(node, entry, depth);
            entry.sig = sig;
          }
          // a write in flight: the row says so, its controls stay (the focus must not move)
          if (busy.has(href)) entry.li.setAttribute('aria-busy', 'true');
          else entry.li.removeAttribute('aria-busy');
          lis.push(entry.li);
        }
        place(box, lis);
        nodes.forEach((node) => build(node.children, pool.get(node.rec.href).sub, depth + 1));
      };
      build(roots, ul, 0);
      for (const [href, e] of [...pool]) {
        if (seen.has(href)) continue;
        if (e.li.parentNode) e.li.parentNode.removeChild(e.li);
        pool.delete(href);
        stat.removed += 1;
      }
      // focus: a row that had it and is still there keeps it (a repainted row gets its control back); a removed one
      // hands it to the row now at its place (or the list), so the keyboard never falls back to the page
      if (focusedHref) {
        const kept = pool.get(focusedHref);
        const want = focusedTest || 'task-complete';
        if (kept) {
          const el = kept.li.querySelector(`[data-testid="${want}"]`);
          if (el && doc.activeElement !== el && !el.disabled) el.focus();
        } else {
          const after = [...ul.querySelectorAll('[data-testid="task-row"]')].map((li) => li.getAttribute('data-href'));
          const index = Math.min(Math.max(before.indexOf(focusedHref), 0), after.length - 1);
          const target = after.length ? pool.get(after[index]) : null;
          const el = target ? target.li.querySelector('[data-testid="task-open"]') : null;
          if (el) el.focus();
          else if (typeof ul.focus === 'function') ul.focus();
        }
      }
      return stat;
    },
    nodeOf: (href) => (pool.has(href) ? pool.get(href).li : null),
    get size() {
      return pool.size;
    },
    clear() {
      for (const e of pool.values()) if (e.li.parentNode) e.li.parentNode.removeChild(e.li);
      pool.clear();
    },
  };
  return api;
}
