// SPDX-License-Identifier: AGPL-3.0-or-later
// Ready-made modal dialogs on top of ui.js `openDialog` (composition only; ui.js is not extended here):
//  - confirmDialog: named buttons ('Delete «Jane Doe»' / 'Cancel'), Cancel focused for destructive actions (m7);
//  - typedConfirmDialog: the confirm button stays disabled until the typed text equals the expected one;
//  - oneTimeDialog: the non-dismissible dialog of SPECS 10b-4 (Esc, backdrop and navigation cannot close it).
// Every function returns a Promise; the opened dialog controller is on `promise.dialog` (tests, agents).
// Focus is trapped by the native modal <dialog> and returned to the opener by openDialog.

import { h, openDialog, writeGate } from '../ui.js';
import { isolate } from './avatar.js';
import { identityT, uniqueId } from './fieldkit.js';

// The non-dismissible machinery lives in ui.js; it is re-exported so callers import dialogs from one place.
export { hasBlockingDialog, guardDialog } from '../ui.js';

/** Unicode-NFC exact comparison; an empty expected text never matches (a typed confirmation needs something to type). */
export function matchesTyped(input, expected) {
  return typeof input === 'string' && typeof expected === 'string' && expected !== '' && input.normalize('NFC') === expected.normalize('NFC');
}

function withController(promise, ctrl) {
  promise.dialog = ctrl;
  return promise;
}

/**
 * Yes/no confirmation.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.message]
 * @param {string|Node|Node[]} [o.confirmLabel]  a named label such as 'Delete «Jane Doe»'
 * @param {string|Node|Node[]} [o.cancelLabel]
 * @param {boolean} [o.danger]   the confirm button is red and Cancel gets the focus (m7)
 * @param {'cancel'|'first'|string|HTMLElement} [o.focus]  default: Cancel when `danger`, else the confirm button
 * @param {string} [o.testid='dialog-confirmation'] @param {string} [o.confirmTestid='dialog-confirm'] @param {string} [o.cancelTestid='dialog-cancel']
 * @param {Node[]} [o.body]  extra content between the message and the buttons
 * @param {boolean} [o.write]  register the confirm button with the write gate (offline / read-only)
 * @param {(key: string) => string} [o.t]
 * @returns {Promise<boolean>} true only when the confirm button was used; Esc, Cancel and anything else give false
 */
export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = false, focus, testid = 'dialog-confirmation', confirmTestid = 'dialog-confirm', cancelTestid = 'dialog-cancel', body = [], write = false, t = identityT, win } = {}) {
  let ctrl;
  const promise = new Promise((resolve) => {
    ctrl = openDialog({
      testid,
      title,
      description: message,
      body,
      focus: focus || (danger ? 'cancel' : confirmTestid),
      win,
      actions: [
        { testid: cancelTestid, label: cancelLabel || t('dialog.cancel'), cancel: true },
        { testid: confirmTestid, label: confirmLabel || t('dialog.confirm'), kind: danger ? 'danger' : 'primary', write },
      ],
      onClose: (value) => resolve(value === confirmTestid),
    });
  });
  return withController(promise, ctrl);
}

/**
 * Typed confirmation (collection delete, SPECS 4.4): the confirm button is disabled until the input equals
 * `expected` exactly (Unicode NFC; no trimming, no case folding). The input takes the focus.
 * @param {object} o
 * @param {string} o.title @param {string} [o.message]
 * @param {string} o.expected  the text to type
 * @param {string} [o.label]  label of the input (default: translated 'Type the name to confirm')
 * @param {string|Node|Node[]} [o.confirmLabel] @param {string|Node|Node[]} [o.cancelLabel]
 * @param {string} [o.testid='dialog-typed-confirm'] @param {string} [o.inputTestid='field-confirm-name']
 * @param {string} [o.confirmTestid='dialog-confirm'] @param {string} [o.cancelTestid='dialog-cancel']
 * @param {Node[]} [o.body] @param {boolean} [o.write] @param {(key: string, params?: object) => string} [o.t]
 * @returns {Promise<boolean>}
 */
export function typedConfirmDialog({ title, message, expected, label, confirmLabel, cancelLabel, testid = 'dialog-typed-confirm', inputTestid = 'field-confirm-name', confirmTestid = 'dialog-confirm', cancelTestid = 'dialog-cancel', body = [], write = true, t = identityT, win } = {}) {
  if (typeof expected !== 'string' || expected === '') throw new TypeError('typedConfirmDialog needs a non-empty `expected` text');
  const id = uniqueId('typed');
  const input = h('input', {
    type: 'text',
    class: 'input',
    id,
    testid: inputTestid,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-describedby': `${id}-hint ${id}-match`,
    'data-autofocus': true,
  });
  const matchEl = h('p', { class: 'field__hint typed__match', id: `${id}-match`, role: 'status', testid: `${testid}-match`, 'data-match': 'false' });
  const field = h(
    'div',
    { class: 'field typed' },
    h('label', { class: 'field__label', for: id }, label || t('dialog.typed.label')),
    input,
    h('p', { class: 'field__hint', id: `${id}-hint` }, t('dialog.typed.hint', { expected: isolate(expected) })),
    matchEl,
  );
  let ctrl;
  let unsubscribe = null;
  const promise = new Promise((resolve) => {
    ctrl = openDialog({
      testid,
      title,
      description: message,
      body: [...body, field],
      focus: input,
      win,
      actions: [
        { testid: cancelTestid, label: cancelLabel || t('dialog.cancel'), cancel: true },
        { testid: confirmTestid, label: confirmLabel || t('dialog.confirm'), kind: 'danger', disabled: true, write },
      ],
      onClose: (value) => {
        if (unsubscribe) unsubscribe();
        resolve(value === confirmTestid);
      },
    });
  });
  const confirmBtn = ctrl.buttons[confirmTestid];
  let lastState = null;
  const update = () => {
    const ok = matchesTyped(input.value, expected);
    confirmBtn.disabled = !ok || (write && writeGate.blocked);
    if (ok !== lastState) {
      lastState = ok;
      matchEl.textContent = ok ? t('dialog.typed.match') : t('dialog.typed.noMatch');
      matchEl.setAttribute('data-match', ok ? 'true' : 'false');
    }
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!confirmBtn.disabled) ctrl.close(confirmTestid);
  });
  if (write) unsubscribe = writeGate.subscribe(update); // the gate re-enables controls on its own; recompute after it
  return withController(promise, ctrl);
}

/**
 * The one-time dialog (SPECS 10b-4: a password shown once). Esc, backdrop clicks and navigation cannot close it
 * until the explicit confirm; with `ackLabel` the confirm stays disabled until the box is ticked.
 * The caller puts the secret in `body` (and offers its own copy button if it wants one).
 * @param {object} o
 * @param {string} o.title @param {string} [o.message] @param {Node[]} [o.body]
 * @param {string|Node|Node[]} [o.confirmLabel]
 * @param {string} [o.ackLabel]  e.g. 'I have saved it'
 * @param {string} [o.testid='dialog-once'] @param {string} [o.confirmTestid='dialog-once-confirm'] @param {string} [o.ackTestid='dialog-once-ack']
 * @returns {Promise<true>} resolves only after the confirm button was used
 */
export function oneTimeDialog({ title, message, body = [], confirmLabel, ackLabel, testid = 'dialog-once', confirmTestid = 'dialog-once-confirm', ackTestid = 'dialog-once-ack', t = identityT, win } = {}) {
  const ackId = uniqueId('ack');
  const ack = ackLabel ? h('input', { type: 'checkbox', id: ackId, testid: ackTestid }) : null;
  const ackRow = ack ? h('div', { class: 'check' }, ack, h('label', { for: ackId }, ackLabel)) : null;
  let ctrl;
  const promise = new Promise((resolve) => {
    ctrl = openDialog({
      testid,
      title,
      description: message,
      body: [...body, ackRow],
      dismissible: false,
      focus: ack || confirmTestid,
      win,
      actions: [{ testid: confirmTestid, label: confirmLabel || t('dialog.ok'), kind: 'primary', disabled: Boolean(ack) }],
      onClose: () => resolve(true),
    });
  });
  if (ack) {
    const btn = ctrl.buttons[confirmTestid];
    ack.addEventListener('change', () => {
      btn.disabled = !ack.checked;
    });
  }
  return withController(promise, ctrl);
}
