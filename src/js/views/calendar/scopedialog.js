// SPDX-License-Identifier: AGPL-3.0-or-later
// The two questions a repeating event asks (RUN3 D-R3-7, addendum M3, m1). Both are modal dialogs on top of ui.js
// `openDialog`, registered with the global dialog registry (so they cannot outlive the session) and resolved as promises.
//
//   askScope({mode: 'edit' | 'delete', isFirst, title, t, lang, win})
//       -> Promise<'this' | 'following' | 'all' | null>        null = cancelled (Esc, backdrop, Cancel)
//       dialog ids dialog-scope-edit / dialog-scope-delete; buttons scope-this, scope-following, scope-all, scope-cancel.
//       `isFirst` hides "this and following" (it would equal the whole series). The interface B3a's actions.js calls.
//
//   askRuleExceptions({exceptions, orphans, defaultChoice, t, lang, win})
//       -> Promise<'keep' | 'remove' | 'remove-orphans' | null>
//       dialog id dialog-rule-exceptions; buttons exceptions-keep, exceptions-remove, exceptions-remove-orphans,
//       exceptions-cancel. The dates that "will no longer be shown" are listed (exception-item). Keep is the default and the
//       focused button ONLY when `defaultChoice === 'keep'`, that is when nothing would be orphaned; otherwise the focus is on
//       Cancel and no button is primary-by-default (addendum M3).

import { h, openDialog } from '../../ui.js';
import { isolate } from '../../widgets/avatar.js';

const labelOf = (head, help) => h('span', { class: 'scope__choice' }, h('span', { class: 'scope__head' }, head), help ? h('span', { class: 'scope__help' }, help) : null);

/** The scope question for an edit or a delete of one occurrence of a series. */
export function askScope({ mode = 'edit', isFirst = false, title = '', t, win } = {}) {
  const m = mode === 'delete' ? 'delete' : 'edit';
  let answer = null;
  const pick = (value) => () => {
    answer = value;
  };
  const kind = (value) => (m === 'delete' ? (value === 'this' ? undefined : 'danger') : value === 'this' ? 'primary' : undefined);
  const actions = [
    { testid: 'scope-this', label: labelOf(t(`event.scope.${m}.this`), t(`event.scope.help.${m}.this`)), kind: kind('this'), write: true, onClick: pick('this') },
    ...(isFirst ? [] : [{ testid: 'scope-following', label: labelOf(t(`event.scope.${m}.following`), t(`event.scope.help.${m}.following`)), kind: kind('following'), write: true, onClick: pick('following') }]),
    { testid: 'scope-all', label: labelOf(t(`event.scope.${m}.all`), t(`event.scope.help.${m}.all`)), kind: kind('all'), write: true, onClick: pick('all') },
    { testid: 'scope-cancel', label: t('dialog.cancel'), cancel: true },
  ];
  return new Promise((resolve) => {
    const ctrl = openDialog({
      testid: `dialog-scope-${m}`,
      title: t(`event.scope.${m}.title`),
      description: t(`event.scope.text.${m}`, { name: isolate(title) }),
      actions,
      focus: m === 'delete' ? 'cancel' : 'scope-this',
      win,
      onClose: () => resolve(answer),
    });
    ctrl.dialog.classList.add('dialog--scope');
  });
}

function whenText(spec, lang, use24h) {
  if (!spec || typeof spec.iso !== 'string') return '';
  const [y, mo, d] = spec.iso.slice(0, 10).split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, +(spec.iso.slice(11, 13) || 0), +(spec.iso.slice(14, 16) || 0));
  try {
    const opts = { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    if (spec.kind !== 'date') Object.assign(opts, { hour: '2-digit', minute: '2-digit', hour12: use24h === false });
    return new Intl.DateTimeFormat(lang, opts).format(new Date(wall));
  } catch {
    return spec.iso;
  }
}

/**
 * "Keep exceptions / Remove exceptions / Cancel" (D-R3-7 and addendum M3). `exceptions` and `orphans` are the
 * `{type, spec, key}` lists of planEdit's question (`orphans` is the subset whose date is no longer an occurrence of
 * the new rule or start).
 */
export function askRuleExceptions({ exceptions = [], orphans = [], defaultChoice = null, t, tp, lang = 'en', use24h = null, win } = {}) {
  let answer = null;
  const pick = (value) => () => {
    answer = value;
  };
  const plural = (key, n, params) => (tp ? tp(key, n, params) : t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...params }));
  const total = exceptions.length;
  const lost = orphans.length;
  const items = (list) =>
    h(
      'ul',
      { class: 'exc-list', testid: 'exception-list' },
      list.map((e) => h('li', { class: 'exc-list__item', testid: 'exception-item', 'data-type': e.type }, h('bdi', null, whenText(e.spec, lang, use24h)), ' ', h('span', { class: 'meta-line' }, t(e.type === 'override' ? 'event.exc.type.override' : 'event.exc.type.exdate')))),
    );
  const body = [];
  if (lost) {
    body.push(h('p', { class: 'notice notice--warn', role: 'status', testid: 'exceptions-orphans-note' }, plural('event.exc.orphans', lost)), items(orphans));
  } else body.push(h('p', { class: 'meta-line' }, plural('event.exc.count', total)));
  const keepLabel = lost ? plural('event.exc.keepOrphans', lost) : t('event.exc.keep');
  const actions = [
    { testid: 'exceptions-keep', label: keepLabel, kind: defaultChoice === 'keep' ? 'primary' : undefined, write: true, onClick: pick('keep') },
    { testid: 'exceptions-remove', label: plural('event.exc.removeAll', total), kind: 'danger', write: true, onClick: pick('remove') },
  ];
  if (lost && lost < total) actions.splice(1, 0, { testid: 'exceptions-remove-orphans', label: plural('event.exc.removeOrphans', lost), write: true, onClick: pick('remove-orphans') });
  actions.push({ testid: 'exceptions-cancel', label: t('dialog.cancel'), cancel: true });
  return new Promise((resolve) => {
    openDialog({
      testid: 'dialog-rule-exceptions',
      title: t(lost ? 'event.exc.titleOrphans' : 'event.exc.title'),
      description: t(lost ? 'event.exc.textOrphans' : 'event.exc.text'),
      body,
      actions,
      focus: defaultChoice === 'keep' ? 'exceptions-keep' : 'cancel',
      win,
      onClose: () => resolve(answer),
    });
  });
}
