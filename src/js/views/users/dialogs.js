// SPDX-License-Identifier: AGPL-3.0-or-later
// Dialogs of the Users screens: the password shown once, the change-preview of one grant, the password reset and
// the account delete (with "keep data" / "delete data" and an export per collection first, D-R3-11).
// Every dialog is built on ui.js `openDialog` through widgets/dialogs.js. Every function returns a Promise; the
// dialog controller is on `promise.dialog` (tests, agents). Nothing here writes to a server except through the
// admin store handed in (`admin`), which is the only caller of the account service.
//
// Test ids: dialog-password-once (generated-password, btn-copy-password, copy-status, pw-once-note, pw-once-warning,
// field-pw-saved, btn-password-saved), dialog-change-access (access-preview, access-effects, access-error,
// access-cancel, access-confirm), dialog-reset-password (dialog-confirm-reset), dialog-delete-account
// (delete-keep, delete-data, delete-collections, delete-collection, btn-export-first, export-status,
// field-confirm-login, dialog-confirm-delete), dialog-confirm-admin, dialog-confirm-ownspace.

import { h, openDialog } from '../../ui.js';
import { confirmDialog, oneTimeDialog, typedConfirmDialog } from '../../widgets/dialogs.js';
import { isolate } from '../../widgets/avatar.js';
import { uniqueId } from '../../widgets/fieldkit.js';
import { exportToFile } from '../collections/exporter.js';
import { limitsNote } from './parts.js';

/** Style hook: every dialog of the Users screens carries `dialog--users` (css/users.css). Returns the promise. */
function mark(promise) {
  if (promise && promise.dialog && promise.dialog.dialog) promise.dialog.dialog.classList.add('dialog--users');
  return promise;
}

// ------------------------------------------------------------------ the password, shown once

/**
 * The password of a new or reset account. Esc, the backdrop and navigation cannot close it before "I have saved it"
 * is ticked (SPECS 10b-4: the dialog is not dismissible and beforeunload is armed). The secret lives in this
 * closure and in the page text until the dialog closes; then the text is emptied.
 * @param {{t: Function, login: string, secret: string, created?: boolean, win?: object}} o
 * @returns {Promise<true>}
 */
export function passwordOnceDialog({ t, login, secret, created = false, win }) {
  const code = h('code', { class: 'secret', tabindex: '0', testid: 'generated-password', 'aria-label': t('pw.secretLabel', { login: isolate(login) }) }, secret);
  const copyStatus = h('p', { class: 'small', role: 'status', testid: 'copy-status' });
  const warn = h('p', { class: 'notice notice--warn', role: 'alert', hidden: true, testid: 'pw-once-warning' }, t('pw.mustConfirm'));
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      testid: 'btn-copy-password',
      'aria-label': t('pw.copyNamed', { login: isolate(login) }),
      on: {
        click: async () => {
          const nav = globalThis.navigator;
          try {
            await nav.clipboard.writeText(secret);
            copyStatus.textContent = t('pw.copied');
          } catch {
            try {
              const range = code.ownerDocument.createRange();
              range.selectNodeContents(code);
              const sel = globalThis.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            } catch {
              /* the text stays selectable by hand */
            }
            copyStatus.textContent = t('pw.copyFallback');
          }
        },
      },
    },
    t('pw.copy'),
  );
  const promise = mark(oneTimeDialog({
    title: t('pw.onceTitle', { login: isolate(login) }),
    message: t(created ? 'pw.onceCreated' : 'pw.onceReset'),
    body: [h('div', { class: 'secret-box' }, code, copy), copyStatus, h('p', { class: 'notice notice--warn', testid: 'pw-once-note' }, t('pw.onceNote')), warn],
    ackLabel: t('pw.saved'),
    confirmLabel: t('pw.done'),
    testid: 'dialog-password-once',
    confirmTestid: 'btn-password-saved',
    ackTestid: 'field-pw-saved',
    t,
    win,
  }));
  const dlg = promise.dialog.dialog;
  const showWarning = () => {
    warn.hidden = false;
  };
  dlg.addEventListener('cancel', showWarning);
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') showWarning();
  });
  const wrapped = promise.then(() => {
    code.textContent = ''; // the secret leaves the page with the dialog
    return true;
  });
  wrapped.dialog = promise.dialog;
  return wrapped;
}

// ------------------------------------------------------------------ change preview (one grant)

/**
 * Preview, then apply, ONE grant change `{owner, collection, grantee, level}`. The dry run is sent as soon as the
 * dialog opens; the confirm button stays disabled until it answered. A failed apply keeps the dialog open with the
 * text. Resolves `{applied, result}` when the dialog closes.
 * @param {object} o
 * @param {Function} o.t @param {object} o.admin admin store
 * @param {{owner: string, collection: string, grantee: string, level: 'none'|'read'|'readwrite'}} o.grant
 * @param {'none'|'read'|'readwrite'} o.before
 * @param {string} [o.label] how the collection is named in sentences (default `owner/collection`)
 */
export function changeAccessDialog({ t, admin, grant, before, label, win }) {
  const path = label || `${grant.owner}/${grant.collection}`;
  const login = isolate(grant.grantee);
  const phrase = grant.level === 'none' ? t('perm.preview.none', { login, path: isolate(path) }) : t('perm.preview.give', { login, path: isolate(path), level: t(`perm.phrase.${grant.level}`) });
  const preview = h('p', { class: 'preview', testid: 'access-preview', role: 'status', 'data-state': 'loading' }, t('perm.preview.loading'));
  const effects = h('ul', { class: 'share__preview', testid: 'access-effects', hidden: true });
  const error = h('p', { class: 'field__error', role: 'alert', hidden: true, testid: 'access-error' });
  let outcome = { applied: false, result: null };
  let closed = false;
  let ctrl;
  const promise = new Promise((resolve) => {
    ctrl = openDialog({
      testid: 'dialog-change-access',
      title: t('perm.confirmTitle'),
      body: [preview, h('p', { class: 'muted small' }, t('perm.beforeAfter', { before: t(`perm.${before}`), after: t(`perm.${grant.level}`) })), effects, error, limitsNote(t)],
      focus: 'cancel',
      win,
      actions: [
        { testid: 'access-cancel', label: t('dialog.cancel'), cancel: true },
        {
          testid: 'access-confirm',
          label: grant.level === 'none' ? t('perm.confirmRemove', { login }) : t('perm.confirmGive', { login, level: t(`perm.phrase.${grant.level}`) }),
          kind: 'primary',
          disabled: true,
          write: true,
          onClick: () => {
            run();
            return false;
          },
        },
      ],
      onClose: () => {
        closed = true;
        resolve(outcome);
      },
    });
  });
  ctrl.dialog.classList.add('dialog--users');
  const confirm = ctrl.buttons['access-confirm'];
  const cancel = ctrl.buttons['access-cancel'];

  async function run() {
    confirm.disabled = true;
    cancel.disabled = true;
    error.hidden = true;
    const result = await admin.applyGrant(grant);
    if (closed) return;
    cancel.disabled = false;
    outcome = { applied: result.ok === true && result.status !== 'noop', result };
    if (result.ok) ctrl.close('access-confirm');
    else {
      error.textContent = result.message || t('err.api.unknown');
      error.hidden = false;
      confirm.disabled = false;
    }
  }

  admin.previewGrant(grant).then((result) => {
    if (closed) return;
    preview.removeAttribute('data-state');
    if (!result.ok) {
      preview.textContent = phrase;
      error.textContent = result.message || t('err.api.unknown');
      error.hidden = false;
      return;
    }
    if (result.status === 'preview' && result.noop) {
      preview.textContent = t('perm.preview.noop');
      return;
    }
    preview.textContent = phrase;
    const lines = (result.effective || []).filter((e) => e.path).slice(0, 8);
    for (const e of lines) effects.append(h('li', { testid: 'access-effect', 'data-login': e.login }, t('perm.effect', { login: isolate(e.login || grant.grantee), path: e.path, before: e.before || '-', after: e.after || '-' })));
    effects.hidden = lines.length === 0;
    confirm.disabled = false;
  });
  const out = promise;
  out.dialog = ctrl;
  return out;
}

// ------------------------------------------------------------------ reset password

/** Confirm, reset with a generated password, show it once. Resolves {ok, status}. */
export async function resetPasswordFlow({ t, admin, login, win }) {
  const who = isolate(login);
  const yes = await mark(confirmDialog({
    title: t('users.resetTitle', { login: who }),
    message: t('users.resetText', { login: who }),
    confirmLabel: t('users.resetConfirm', { login: who }),
    testid: 'dialog-reset-password',
    confirmTestid: 'dialog-confirm-reset',
    write: true,
    t,
    win,
  }));
  if (!yes) return { ok: false, status: 'cancelled' };
  const result = await admin.resetPassword({ login, generate: true });
  if (!result.ok) return result;
  if (typeof result.password === 'string' && result.password) {
    let secret = result.password;
    result.password = null; // the caller's result object never carries it further
    await passwordOnceDialog({ t, login, secret, created: false, win });
    secret = '';
  }
  return { ok: true, status: result.status, message: result.message };
}

// ------------------------------------------------------------------ small confirmations

/** Make or remove an administrator: a named confirmation (it changes who can do everything). */
export function confirmAdminChange({ t, login, makeAdmin, win }) {
  const who = isolate(login);
  return mark(confirmDialog({
    title: t(makeAdmin ? 'users.adminOnTitle' : 'users.adminOffTitle', { login: who }),
    message: t(makeAdmin ? 'users.adminOnText' : 'users.adminOffText', { login: who }),
    confirmLabel: t(makeAdmin ? 'users.adminOnConfirm' : 'users.adminOffConfirm', { login: who }),
    danger: makeAdmin,
    testid: 'dialog-confirm-admin',
    confirmTestid: 'dialog-confirm-admin-yes',
    write: true,
    t,
    win,
  }));
}

/** Turning an account's own space off while it owns collections needs its login typed (the service asks for it too). */
export function confirmOwnSpaceOff({ t, login, count, win }) {
  const who = isolate(login);
  return mark(typedConfirmDialog({
    title: t('users.ownSpaceOffTitle', { login: who }),
    message: t('users.ownSpaceOffText', { login: who, count }),
    expected: login,
    label: t('users.typeLogin', { login: who }),
    confirmLabel: t('users.ownSpaceOffConfirm', { login: who }),
    testid: 'dialog-confirm-ownspace',
    inputTestid: 'field-confirm-login',
    confirmTestid: 'dialog-confirm-ownspace-yes',
    t,
    win,
  }));
}

// ------------------------------------------------------------------ delete account

/**
 * The delete dialog. Resolves `{confirmed: boolean, deleteData: boolean}`.
 * `collections` are the account's collections (Depth-1 listing) or null when they could not be listed; with "delete
 * data" they are listed by name, each with an export button, and the store deletes them first (D-R3-11).
 */
export function deleteAccountDialog({ t, store, login, collections, grants = { held: 0, given: 0 }, win }) {
  const who = isolate(login);
  const list = Array.isArray(collections) ? collections : [];
  const exportStatus = h('p', { class: 'small', role: 'status', testid: 'export-status' });
  const nameOf = (c) => c.displayName || c.name || c.href;
  const rows = list.map((c) =>
    h(
      'li',
      { class: 'delete__coll', testid: 'delete-collection', 'data-href': c.href },
      h('span', { class: 'delete__collname' }, isolate(nameOf(c))),
      h('button', {
        type: 'button',
        class: 'btn btn--small',
        testid: 'btn-export-first',
        'aria-label': t('users.exportNamed', { name: isolate(nameOf(c)), login: who }),
        on: {
          click: async () => {
            const out = await exportToFile({ store, collection: c, includeGroups: true, t });
            exportStatus.textContent = out.text || '';
          },
        },
      }, t('users.exportFirst')),
    ),
  );
  const keepId = uniqueId('delete-keep');
  const dataId = uniqueId('delete-data');
  const keep = h('input', { type: 'radio', name: 'delete-choice', value: 'keep', id: keepId, checked: true, testid: 'delete-keep' });
  // Without the listing the confirmation cannot be compared with the server's state: deleting data is not offered.
  const wipe = h('input', { type: 'radio', name: 'delete-choice', value: 'data', id: dataId, testid: 'delete-data', ...(Array.isArray(collections) ? {} : { disabled: true }) });
  const choice = h(
    'fieldset',
    { class: 'fieldset', testid: 'field-delete-data' },
    h('legend', { class: 'fieldset__legend' }, t('users.deleteChoice')),
    h('div', { class: 'radio radio--block' }, keep, h('label', { for: keepId }, h('strong', null, t('users.deleteKeep')), ' ', h('span', { class: 'muted' }, t('users.deleteKeepHelp')))),
    h('div', { class: 'radio radio--block' }, wipe, h('label', { for: dataId }, h('strong', null, t('users.deleteData')), ' ', h('span', { class: 'muted' }, t('users.deleteDataHelp')))),
  );
  const collBox = h(
    'div',
    { class: 'delete__colls', testid: 'delete-collections', 'data-count': String(Array.isArray(collections) ? list.length : -1) },
    Array.isArray(collections)
      ? list.length
        ? [h('p', { class: 'small' }, t('users.deleteCollections', { count: list.length })), h('ul', { class: 'delete__list' }, rows), exportStatus]
        : h('p', { class: 'small muted' }, t('users.deleteNoCollections'))
      : h('p', { class: 'small muted', role: 'alert' }, t('users.deleteListFailed')),
  );
  const promise = mark(typedConfirmDialog({
    title: t('users.deleteTitle', { login: who }),
    message: t('users.deleteText', { count: list.length, held: grants.held, given: grants.given }),
    expected: login,
    label: t('users.typeLogin', { login: who }),
    confirmLabel: t('users.deleteNamed', { login: who }),
    testid: 'dialog-delete-account',
    inputTestid: 'field-confirm-login',
    confirmTestid: 'dialog-confirm-delete',
    body: [h('p', { class: 'notice notice--warn' }, t('users.deleteIrreversible')), collBox, choice],
    t,
    win,
  }));
  const out = promise.then((confirmed) => ({ confirmed, deleteData: confirmed && wipe.checked === true }));
  out.dialog = promise.dialog;
  return out;
}
