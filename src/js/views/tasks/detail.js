// SPDX-License-Identifier: AGPL-3.0-or-later
// The task detail (RUN3 WP C1): `#/tasks/<key>?list=<href>`. Everything is text nodes; the description is shown in a
// `<pre>`-wrap block; the repeat rule and the sub-task relations are read-only (the rule stays as it is; the hierarchy
// is edited in v1.1). A task whose time zone is unknown (item.js category c) is shown at its own wall clock with a
// warning and the raw text; it can be deleted, not edited. Test ids: task-detail, task-title, task-status, task-due,
// task-start, task-priority, task-percent, task-categories, task-description, task-recurrence, task-parent, task-children,
// task-meta, task-readonly, task-raw, task-complete, btn-edit-task, btn-delete-task, btn-back.

import { h } from '../../ui.js';
import { summarizeRule } from '../../calendar/recurtext.js';
import { capText } from '../contacts/links.js';
import { dueText, isolate, taskHash, whenLine } from './common.js';
import { completeBlock, completeLabel } from './rows.js';

const field = (label, testid, ...kids) => h('div', { class: 'detail__row', testid }, h('dt', null, label), h('dd', null, ...kids));

/**
 * @param {object} o
 * @param {object} o.model {rec, item, entry, collection, canWrite, relatives: {parent, children, missingParent}}
 * @param {object} o.ops {onComplete(), onDelete(), editHash: string|null}
 */
export function buildTaskDetail({ model, t, tp, lang, tz, use24h, ops, backHash = '#/tasks' }) {
  const { rec, item, entry, collection } = model;
  const named = isolate(rec.summary || t('tasks.untitled'));
  const f = item.fields();
  const due = dueText(rec, { t, lang, use24h, today: '' });
  const readOnlyReason = model.canWrite ? (rec.readOnly ? rec.readOnlyReason || 'read-only' : null) : 'list';
  const readOnlyText = readOnlyReason === 'list' ? t('tasks.detail.readonlyList', { list: collection.label || collection.displayName || '' }) : readOnlyReason === 'unknown-tzid' ? t('tasks.detail.readonlyZone') : readOnlyReason ? t('tasks.detail.readonlyOther') : null;
  const block = completeBlock(rec);

  const list = [];
  if (f.start) list.push(field(t('tasks.field.start'), 'task-start', whenLine(f.start, { lang, use24h })));
  if (f.due) list.push(field(t('tasks.field.due'), 'task-due', h('span', { class: due.overdue ? 'is-overdue' : null }, whenLine(f.due, { lang, use24h })), due.overdue ? h('span', { class: 'tag tag--danger' }, due.text) : null));
  if (rec.prio !== 'none') list.push(field(t('tasks.field.priority'), 'task-priority', h('span', { class: ['prio', `prio--${rec.prio}`] }, h('span', { class: 'prio__bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), t(`tasks.prio.${rec.prio}`), ` (${rec.priority})`)));
  if (f.percent !== null && f.percent !== undefined) list.push(field(t('tasks.field.percent'), 'task-percent', `${f.percent} %`));
  if (f.categories.length) list.push(field(t('tasks.field.categories'), 'task-categories', h('span', { class: 'chips' }, ...f.categories.map((c) => h('span', { class: 'tag' }, h('bdi', null, c))))));
  if (f.description) {
    const cap = capText(f.description, 20000);
    list.push(field(t('tasks.field.description'), 'task-description', h('pre', { class: 'prose' }, cap.text)));
  }
  if (f.rrule) {
    const startSpec = f.due || f.start;
    let sentence = f.rrule;
    if (startSpec) {
      try {
        sentence = summarizeRule(f.rrule, startSpec, { t, tp, lang, zones: item.zones });
      } catch {
        sentence = f.rrule;
      }
    }
    list.push(field(t('tasks.field.repeats'), 'task-recurrence', sentence, h('p', { class: 'meta-line' }, t('tasks.detail.repeatsNote'))));
  }
  const rel = model.relatives;
  if (rel && rel.parent) list.push(field(t('tasks.field.parent'), 'task-parent', h('a', { class: 'link', href: taskHash(rel.parent.routeKey, { list: rel.parent.collection }) }, h('bdi', null, rel.parent.summary || t('tasks.untitled')))));
  else if (rel && rel.missingParent) list.push(field(t('tasks.field.parent'), 'task-parent', t('tasks.parentMissing')));
  if (rel && rel.children.length) {
    list.push(field(t('tasks.field.children'), 'task-children', h('ul', { class: 'detail__children' }, ...rel.children.map((c) => h('li', null, h('a', { class: 'link', href: taskHash(c.routeKey, { list: c.collection }) }, h('bdi', null, c.summary || t('tasks.untitled'))), c.done ? ` (${t('tasks.state.COMPLETED')})` : '')))));
  }

  const actions = h(
    'div',
    { class: 'detail__actions' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        testid: 'task-complete',
        'aria-pressed': String(rec.done),
        'aria-label': completeLabel(rec, t, named),
        title: block ? completeLabel(rec, t, named) : null,
        disabled: Boolean(block),
        'aria-disabled': block ? 'true' : null,
        write: true,
        on: { click: () => ops.onComplete() },
      },
      rec.done ? t('tasks.reopen') : t('tasks.complete'),
    ),
    ops.editHash ? h('a', { class: 'btn btn--primary', href: ops.editHash, testid: 'btn-edit-task', 'aria-label': t('tasks.editNamed', { name: named }) }, t('tasks.edit')) : null,
    model.canWrite ? h('button', { type: 'button', class: 'btn btn--danger-quiet', testid: 'btn-delete-task', 'aria-label': t('tasks.delete.named', { name: named }), write: true, on: { click: () => ops.onDelete() } }, t('tasks.delete')) : null,
  );

  const raw = readOnlyReason && readOnlyReason !== 'list' ? capText(entry.text, 100000) : null;
  const statusText = rec.status ? t(`tasks.state.${rec.status}`) : t('tasks.state.NEEDS-ACTION');
  return h(
    'section',
    { class: ['task-detail', rec.done && 'is-done'], testid: 'task-detail', 'aria-labelledby': 'task-title', 'data-uid': rec.uid, 'data-href': rec.href, 'data-list': rec.collection, 'data-status': rec.status || 'NEEDS-ACTION', 'data-readonly': readOnlyReason ? 'true' : 'false' },
    h('a', { class: 'link detail__back', href: backHash, testid: 'btn-back' }, t('tasks.detail.back')),
    h('h1', { class: 'page-title', id: 'task-title', testid: 'task-title', tabindex: '-1' }, h('bdi', null, rec.summary || t('tasks.untitled'))),
    h('p', { class: 'task-detail__status', testid: 'task-status' }, statusText),
    readOnlyText ? h('p', { class: 'notice', testid: 'task-readonly' }, readOnlyText) : null,
    h('dl', { class: 'detail__list' }, ...list),
    raw ? h('div', { class: 'detail__raw' }, h('h2', { class: 'detail__rawtitle' }, t('tasks.detail.rawTitle')), h('pre', { class: 'prose', testid: 'task-raw' }, raw.text)) : null,
    h('p', { class: 'meta-line', testid: 'task-meta' }, t('tasks.detail.meta', { list: collection.label || collection.displayName || '', file: String(entry.href).split('/').filter(Boolean).pop() || '' })),
    actions,
  );
}
