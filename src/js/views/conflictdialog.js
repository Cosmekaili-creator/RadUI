// SPDX-License-Identifier: AGPL-3.0-or-later
// Conflict dialogs (SPECS 5.10, RUN2-PLAN 2.2 and 3.2). One modal dialog answers the three situations the write
// path reports when the server no longer holds the version the user started from:
//
//   status 'conflict'           dialog-conflict            "This item was changed elsewhere": a table of the fields
//                               that differ (yours / theirs), then Reload theirs, Overwrite with mine, Save mine as
//                               a copy, Cancel.
//   status 'deleted-elsewhere'  dialog-deleted-elsewhere   "This item was deleted elsewhere": Save mine as a copy,
//                               Discard my changes, Cancel.
//   status 'changed-elsewhere'  dialog-changed-elsewhere   a delete was refused because the item changed: Show their
//                               version, Delete anyway, Cancel.
//
// openConflictDialog({conflict, t, writes, label, feedback}) returns a Promise of the final write result of the
// resolution that succeeded, or {cancelled: true}. The store writes the Activity lines and the status text; this file
// only shows the choices and calls `writes.resolveReload / resolveOverwrite / resolveCopy / resolveDeleteAnyway`.
// A second 412 (or a deletion in the meantime) comes back as a new conflict result and the SAME dialog is drawn again
// with the new rows. Values are rendered as text nodes only (never HTML); the photo is only 'changed' / 'unchanged'.
// Nothing here writes a style attribute or an inline handler.

import { fill, h, openDialog, writeGate } from '../ui.js';
import { isolate } from '../widgets/avatar.js';
import { identityT, uniqueId } from '../widgets/fieldkit.js';

/** Test ids per variant (hooks are English and never translated). */
export const VARIANTS = Object.freeze({
  conflict: Object.freeze({ dialog: 'dialog-conflict', cancel: 'conflict-cancel' }),
  deleted: Object.freeze({ dialog: 'dialog-deleted-elsewhere', cancel: 'deleted-cancel' }),
  changed: Object.freeze({ dialog: 'dialog-changed-elsewhere', cancel: 'changed-cancel' }),
});

const MODE_OF_STATUS = Object.freeze({ conflict: 'conflict', 'deleted-elsewhere': 'deleted', 'changed-elsewhere': 'changed' });

/** The variant a store result asks for, or null when it is not a conflict result. */
export function modeOf(result) {
  return result && typeof result === 'object' && Object.hasOwn(MODE_OF_STATUS, result.status) ? MODE_OF_STATUS[result.status] : null;
}

const str = (v) => (v === undefined || v === null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

/** The translated text of `key` when the dictionary knows it, else `fallback` (a field name from the model). */
function tOr(t, key, fallback) {
  const out = t(key);
  return typeof out === 'string' && out && out !== key ? out : fallback;
}

/**
 * Open the dialog for a conflict result.
 * @param {object} o
 * @param {object} o.conflict   a store result with status 'conflict', 'deleted-elsewhere' or 'changed-elsewhere'
 * @param {(key: string, params?: object) => string} [o.t]
 * @param {object} o.writes     the store write path (resolveReload, resolveOverwrite, resolveCopy, resolveDeleteAnyway)
 * @param {string} [o.label]    the item's name for the text (shown isolated for right-to-left names)
 * @param {{dismiss?: Function, setStatus?: Function}} [o.feedback]  the shell's feedback store: the stale conflict alert is
 *        dismissed after a resolution, and "nothing was saved" is left as status text after Cancel
 * @param {object} [o.win]
 * @returns {Promise<object>} the final write result, `{ok: true, status: 'discarded', href}` for "Discard my changes",
 *          or `{cancelled: true}`; `promise.dialog` is the controller of the opened dialog
 */
export function openConflictDialog({ conflict, t = identityT, writes, label, feedback, win } = {}) {
  const startMode = modeOf(conflict);
  if (!startMode || !writes) {
    const refused = Promise.resolve({ ok: false, status: 'invalid', reason: startMode ? 'no-writes' : 'not-a-conflict' });
    refused.dialog = null;
    return refused;
  }

  const state = {
    mode: startMode,
    current: conflict,
    confirmed: false, // the unmappable changes were acknowledged
    lost: null, // nickname values the server would drop (needs its own acknowledgement)
    lostConfirmed: false,
    busy: false,
    detached: false, // the dialog was closed by the browser while a request was running
  };
  const name = str(label).trim();
  const named = (key) => (name ? t(key, { name: isolate(name) }) : t(`${key}Unnamed`));
  const uid = uniqueId('conflict');

  let ctrl = null;
  let settled = false;
  let outcome = null;
  let unsubscribeGate = null;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const settle = (result) => {
    if (settled) return;
    settled = true;
    resolvePromise(result);
  };

  // stable regions: they exist before their text changes, so assistive technology announces the changes
  const contentEl = h('div', { class: 'conflict__content', id: `${uid}-content` });
  const statusEl = h('p', { class: 'conflict__status', role: 'status', testid: 'conflict-status', tabindex: '-1', hidden: true });
  const alertEl = h('p', { class: 'conflict__alert', role: 'alert', testid: 'conflict-alert', hidden: true });
  const footerEl = h('div', { class: 'dialog__actions conflict__actions' });
  const btn = {}; // the buttons of the current variant, by role

  const say = (el, text) => {
    el.textContent = text || '';
    el.hidden = !text;
  };

  // ------------------------------------------------------------ content

  function valueNode(row, side) {
    const v = row[side];
    if (row.kind === 'photo' || row.field === 'photo') {
      const key = v === 'changed' ? 'conflict.photo.changed' : 'conflict.photo.unchanged';
      return h('span', { class: 'conflict__photo', 'data-state': v === 'changed' ? 'changed' : 'unchanged' }, t(key));
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return h('span', { class: 'conflict__empty' }, t('conflict.empty'));
      return h(
        'ul',
        { class: 'conflict__list' },
        v.map((item) => h('li', { dir: 'auto' }, str(item))),
      );
    }
    const text = str(v);
    return text === '' ? h('span', { class: 'conflict__empty' }, t('conflict.empty')) : h('span', { class: 'conflict__text', dir: 'auto' }, text);
  }

  /** The label of a row; a row about one occurrence of a series (events) names it. */
  function fieldLabel(row) {
    const label = tOr(t, `conflict.field.${row.field}`, str(row.field));
    return row.occurrence ? t('conflict.occurrence', { field: label, when: str(row.occurrence) }) : label;
  }

  function diffTable(rows) {
    const colMine = t('conflict.col.mine');
    const colTheirs = t('conflict.col.theirs');
    return h(
      'table',
      { class: 'conflict__diff', testid: 'conflict-diff' },
      h('caption', { class: 'visually-hidden' }, t('conflict.caption')),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('conflict.col.field')), h('th', { scope: 'col' }, colMine), h('th', { scope: 'col' }, colTheirs))),
      h(
        'tbody',
        null,
        rows.map((row) => {
          const both = row.both === true;
          return h(
            'tr',
            { class: 'conflict__row', testid: 'conflict-field-row', 'data-field': str(row.field), 'data-both': both ? 'true' : 'false' },
            h('th', { scope: 'row' }, fieldLabel(row), both ? h('span', { class: 'conflict__both', testid: 'conflict-both' }, t('conflict.both')) : null),
            h('td', { 'data-label': colMine, 'data-side': 'mine' }, valueNode(row, 'mine')),
            h('td', { 'data-label': colTheirs, 'data-side': 'theirs' }, valueNode(row, 'theirs')),
          );
        }),
      ),
    );
  }

  function unmappableText(u) {
    const field = tOr(t, `conflict.field.${u && u.field}`, str(u && u.field));
    // an event/task operation that cannot be replayed on their version (store/writes.js calendarConflict)
    if (u && u.op === 'replay') return t('conflict.unmappable.replay', { field, reason: tOr(t, `conflict.replay.${u.reason}`, tOr(t, 'conflict.replay.error', str(u.reason))) });
    if (u && u.op === 'remove') return t('conflict.unmappable.remove', { field, base: str(u.base) });
    return t('conflict.unmappable.modify', { field, base: str(u && u.base), mine: str(u && u.mine) });
  }

  function noteText(n) {
    if (typeof n === 'string') return n;
    const field = tOr(t, `conflict.field.${n && n.field}`, str(n && n.field));
    const parts = arr(n && n.parts)
      .map((p) => tOr(t, `conflict.part.${p}`, str(p)))
      .join(', ');
    const known = ['both-edited', 'theirs-removed', 'pref-moved'].includes(n && n.code);
    const key = known ? `conflict.note.${n.code}` : 'conflict.note.generic';
    return t(key, { field, parts: parts || t('conflict.part.any'), row: str(n && n.row) });
  }

  function listBlock(testid, titleKey, items, extra) {
    return h(
      'section',
      { class: `conflict__block conflict__block--${testid.replace('conflict-', '')}`, testid, 'aria-labelledby': `${uid}-${testid}-title` },
      h('p', { class: 'conflict__block-title', id: `${uid}-${testid}-title` }, t(titleKey)),
      h(
        'ul',
        { class: 'conflict__items' },
        items.map((text) => h('li', { testid: `${testid}-item`, dir: 'auto' }, text)),
      ),
      extra,
    );
  }

  function checkRow(testid, text, checked, onChange) {
    const id = `${uid}-${testid}`;
    const input = h('input', { type: 'checkbox', id, testid, checked: checked || undefined, on: { change: () => onChange(Boolean(input.checked)) } });
    return h('div', { class: 'check conflict__check' }, input, h('label', { for: id }, text));
  }

  /** The reason a button is disabled, as visible text next to the buttons (never colour or a tooltip alone). */
  function reasonNode(testid, text) {
    return h('p', { class: 'conflict__reason', id: `${uid}-${testid}`, testid }, text);
  }

  function renderContent() {
    const c = state.current;
    const mode = state.mode;
    const kids = [];
    if (mode === 'conflict') {
      const rows = arr(c.rows);
      kids.push(rows.length ? diffTable(rows) : h('p', { class: 'conflict__norows', testid: 'conflict-no-rows' }, t('conflict.noRows')));
      const unmappable = arr(c.unmappable);
      if (unmappable.length) {
        // when Overwrite is impossible anyway (an operation that cannot be replayed), there is nothing to confirm
        const blocked = c.canOverwrite === false;
        kids.push(listBlock('conflict-unmappable', 'conflict.unmappable.title', unmappable.map(unmappableText), blocked ? null : h('p', { class: 'conflict__explain' }, t('conflict.unmappable.explain'))));
        if (!blocked) {
          kids.push(
            checkRow('conflict-confirm-unmappable', t('conflict.unmappable.confirm'), state.confirmed, (on) => {
              state.confirmed = on;
              refresh();
            }),
          );
        }
      }
      if (state.lost && state.lost.length) {
        kids.push(
          checkRow('conflict-confirm-nickname', t('conflict.nickname.confirm', { values: state.lost.map(str).join(', ') }), state.lostConfirmed, (on) => {
            state.lostConfirmed = on;
            refresh();
          }),
        );
      }
      const notes = arr(c.notes);
      if (notes.length) kids.push(listBlock('conflict-notes', 'conflict.notes.title', notes.map(noteText)));
      kids.push(h('p', { class: 'conflict__help' }, t('conflict.help')));
      if (c.canOverwrite === false) kids.push(reasonNode('conflict-overwrite-reason', t(arr(c.unmappable).length ? 'conflict.overwriteDisabled.ops' : 'conflict.overwriteDisabled')));
      if (c.canCopy === false) kids.push(reasonNode('conflict-copy-reason', c.isGroup ? t('conflict.copyDisabled.group') : t('conflict.copyDisabled.other')));
    } else if (mode === 'deleted') {
      kids.push(h('p', { class: 'conflict__help' }, t('conflict.deleted.help')));
      if (c.canCopy === false) kids.push(reasonNode('deleted-copy-reason', c.isGroup ? t('conflict.copyDisabled.group') : t('conflict.copyDisabled.other')));
    } else {
      kids.push(h('p', { class: 'conflict__help' }, t('conflict.changed.help')));
    }
    fill(contentEl, ...kids);
  }

  // ------------------------------------------------------------ buttons

  function button(role, testid, label, { kind, write = false, describedBy } = {}) {
    const el = h('button', { type: 'button', class: ['btn', kind ? `btn--${kind}` : null, `conflict__btn conflict__btn--${role}`], testid, write: write || undefined, 'aria-describedby': describedBy, on: { click: () => onAction(role) } }, label);
    btn[role] = el;
    return el;
  }

  function renderFooter() {
    for (const k of Object.keys(btn)) delete btn[k];
    const c = state.current;
    const v = VARIANTS[state.mode];
    const kids = [];
    if (state.mode === 'conflict') {
      kids.push(
        button('reload', 'conflict-reload', t('conflict.reload'), { kind: 'primary' }),
        button('overwrite', 'conflict-overwrite', t('conflict.overwrite'), { write: true, kind: 'danger-quiet', describedBy: c.canOverwrite === false ? `${uid}-conflict-overwrite-reason` : undefined }),
        button('copy', 'conflict-copy', t('conflict.copy'), { write: true, describedBy: c.canCopy === false ? `${uid}-conflict-copy-reason` : undefined }),
      );
    } else if (state.mode === 'deleted') {
      kids.push(button('copy', 'deleted-save-copy', t('conflict.copy'), { write: true, kind: 'primary', describedBy: c.canCopy === false ? `${uid}-deleted-copy-reason` : undefined }), button('discard', 'deleted-discard', t('conflict.deleted.discard')));
    } else {
      kids.push(button('show', 'changed-show-theirs', t('conflict.changed.show'), { kind: 'primary' }), button('deleteAnyway', 'changed-delete-anyway', t('conflict.changed.deleteAnyway'), { write: true, kind: 'danger-quiet' }));
    }
    kids.push(button('cancel', v.cancel, t('conflict.cancel')));
    fill(footerEl, ...kids);
  }

  /** Enabled/disabled state of every button, from the busy flag, the write gate and the conflict's own flags. */
  function refresh() {
    const c = state.current;
    const busy = state.busy;
    const blocked = writeGate.blocked;
    const needsUnmappable = arr(c.unmappable).length > 0 && !state.confirmed;
    const needsNickname = Boolean(state.lost && state.lost.length) && !state.lostConfirmed;
    const set = (role, off) => {
      if (btn[role]) btn[role].disabled = Boolean(off);
    };
    set('reload', busy);
    set('show', busy);
    set('discard', busy);
    set('cancel', busy);
    set('overwrite', busy || blocked || c.canOverwrite === false || needsUnmappable || needsNickname);
    set('copy', busy || blocked || c.canCopy === false || (state.mode === 'conflict' && needsNickname));
    set('deleteAnyway', busy || blocked);
    if (ctrl) {
      if (busy) ctrl.dialog.setAttribute('aria-busy', 'true');
      else ctrl.dialog.removeAttribute('aria-busy');
      ctrl.dialog.setAttribute('data-busy', busy ? 'true' : 'false');
    }
  }

  function titleAndText() {
    const dlg = ctrl.dialog;
    const mode = state.mode;
    dlg.setAttribute('data-testid', VARIANTS[mode].dialog);
    dlg.setAttribute('data-mode', mode);
    const title = dlg.querySelector('.dialog__title');
    const desc = dlg.querySelector('.dialog__desc');
    if (title) title.textContent = mode === 'deleted' ? t('conflict.deleted.title') : t('conflict.title');
    if (desc) desc.textContent = mode === 'deleted' ? named('conflict.deleted.text') : mode === 'changed' ? named('conflict.changed.text') : named('conflict.text');
  }

  function focusSafe() {
    if (btn.cancel && !btn.cancel.disabled) btn.cancel.focus();
  }

  /** Draw the current conflict again (the first time, after a second 412, and when the variant changes). */
  function render() {
    titleAndText();
    renderContent();
    renderFooter();
    refresh();
  }

  // ------------------------------------------------------------ actions

  function finish(result) {
    outcome = result;
    if (ctrl) ctrl.close('done');
  }

  function failureText(res) {
    const message = res && typeof res.message === 'string' ? res.message.trim() : '';
    return message || t('conflict.err.generic', { status: str(res && res.status) || 'error' });
  }

  function handle(res) {
    if (state.detached) {
      settle(res);
      return;
    }
    const mode = modeOf(res);
    if (res && res.ok === true) {
      if (feedback && typeof feedback.dismiss === 'function') feedback.dismiss('alert');
      finish(res);
      return;
    }
    if (mode) {
      // a new conflict: draw the same dialog again with the new rows (or the other variant)
      state.current = res;
      state.mode = mode;
      state.confirmed = false;
      state.lost = null;
      state.lostConfirmed = false;
      say(alertEl, '');
      say(statusEl, t('conflict.again'));
      render();
      focusSafe();
      return;
    }
    if (res && res.status === 'needs-confirmation' && Array.isArray(res.unmappable)) {
      state.current = { ...state.current, unmappable: res.unmappable };
      state.confirmed = false;
    }
    if (res && res.status === 'nickname-loss' && Array.isArray(res.lost) && res.lost.length) {
      state.lost = res.lost;
      state.lostConfirmed = false;
    }
    say(statusEl, '');
    say(alertEl, failureText(res));
    renderContent();
    refresh();
    focusSafe();
  }

  async function run(call) {
    if (state.busy) return;
    state.busy = true;
    say(alertEl, '');
    say(statusEl, t('conflict.working'));
    refresh();
    statusEl.focus();
    let res;
    try {
      res = await call();
    } catch {
      res = { ok: false, status: 'error', message: '' };
    }
    state.busy = false;
    if (!state.detached) say(statusEl, '');
    refresh();
    handle(res);
  }

  function onAction(role) {
    const c = state.current;
    if (state.busy || (btn[role] && btn[role].disabled)) return undefined;
    if (role === 'cancel') return finish({ cancelled: true });
    if (role === 'discard') return finish({ ok: true, status: 'discarded', href: c.href });
    if (role === 'reload' || role === 'show') return run(() => writes.resolveReload(c));
    if (role === 'overwrite') {
      const options = { confirmUnmappable: arr(c.unmappable).length > 0 && state.confirmed };
      if (state.lost && state.lostConfirmed) options.acceptNicknameLoss = true;
      return run(() => writes.resolveOverwrite(c, options));
    }
    if (role === 'copy') return run(() => (state.lost && state.lostConfirmed ? writes.resolveCopy(c, { acceptNicknameLoss: true }) : writes.resolveCopy(c)));
    if (role === 'deleteAnyway') return run(() => writes.resolveDeleteAnyway(c));
    return undefined;
  }

  // ------------------------------------------------------------ open

  renderContent();
  renderFooter();
  ctrl = openDialog({
    testid: VARIANTS[state.mode].dialog,
    title: state.mode === 'deleted' ? t('conflict.deleted.title') : t('conflict.title'),
    description: state.mode === 'deleted' ? named('conflict.deleted.text') : state.mode === 'changed' ? named('conflict.changed.text') : named('conflict.text'),
    body: [contentEl, statusEl, alertEl, footerEl],
    focus: btn.cancel, // destructive choices: the safe button first (m7)
    win,
    onClose: () => {
      if (unsubscribeGate) unsubscribeGate();
      unsubscribeGate = null;
      if (state.busy) {
        // closed by the browser while a request runs: the result still reaches the caller
        state.detached = true;
        return;
      }
      if ((outcome === null || outcome.cancelled === true) && feedback && typeof feedback.setStatus === 'function') feedback.setStatus(t('conflict.cancelled'));
      settle(outcome === null ? { cancelled: true } : outcome);
    },
  });
  const dlg = ctrl.dialog;
  dlg.classList.add('dialog--conflict');
  dlg.setAttribute('data-mode', state.mode);
  // Esc (and a second Esc) cannot close the dialog while a request runs: the answer must not be lost
  dlg.addEventListener('cancel', (e) => {
    if (state.busy) e.preventDefault();
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.busy) e.preventDefault();
  });
  unsubscribeGate = writeGate.subscribe(refresh);
  refresh();
  promise.dialog = ctrl;
  return promise;
}
