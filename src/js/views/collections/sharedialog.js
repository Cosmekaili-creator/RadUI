// SPDX-License-Identifier: AGPL-3.0-or-later
// The sharing dialog of one collection (owner or administrator; `#/collections?dialog=share&href=` and the
// "Share" buttons of the collections list, the permission matrix and the account view). It shows who has access,
// lets you change levels and add a person as a DRAFT, lists exactly what will change, and applies the changes one
// after the other (the account service takes one at a time), each with its own visible result. It stays open after
// "Apply" so the results can be read; "Close" ends it.
//
// Who can be added: an administrator picks from the directory of enabled accounts; an owner who is not an
// administrator types a login (the service answers the same "no such account, or it cannot receive grants" for
// every refusal, so nothing can be probed to learn which logins exist).
//
// Test ids: dialog-share, share-current, share-table, share-row (data-login), share-select, share-result
// (data-result), share-preview, share-change, share-status, share-add (field-share-grantee | field-share-login,
// btn-share-add, share-add-error), share-apply, share-cancel, rights-limits-note.

import { h, openDialog } from '../../ui.js';
import { isolate } from '../../widgets/avatar.js';
import { limitsNote, levelSelect } from '../users/parts.js';
import { LOGIN_RE } from '../users/model.js';

const byLogin = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {object} o
 * @param {Function} o.t @param {Function} [o.tp]
 * @param {object} o.app screen app object (`api`, `feedback`)
 * @param {object} o.admin admin store (previewless: the dialog's own list is the preview)
 * @param {boolean} o.isAdmin the signed-in account is an administrator
 * @param {{owner: string, name: string, href?: string, displayName?: string}} o.collection `name` = technical name
 * @returns {Promise<{applied: number, failed: number}>} resolves when the dialog closes; `.dialog` is the controller
 */
export function openShareDialog({ t, tp, app, admin, isAdmin, collection, win }) {
  const owner = collection.owner;
  const name = collection.name;
  const label = collection.displayName || name;
  const path = `${owner}/${name}`;
  const feedback = app && app.feedback;
  let current = new Map(); // login -> level on the server now
  const draft = new Map(); // login -> level wanted
  const resultOf = new Map(); // login -> {result: 'ok'|'error', text}
  let directory = [];
  let applied = 0;
  let failed = 0;
  let busy = false;
  let closed = false;
  let ready = false;
  let ctrl;

  const status = h('p', { class: 'small', role: 'status', testid: 'share-status' }, t('share.loading'));
  const currentLine = h('p', { class: 'small', testid: 'share-current' });
  const tbody = h('tbody');
  const tableWrap = h('div', { class: 'table-wrap', hidden: true }, h('table', { class: 'table table--share', testid: 'share-table' }, h('caption', { class: 'visually-hidden' }, t('share.caption', { name: isolate(label) })), h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('share.account')), h('th', { scope: 'col' }, t('share.access')), h('th', { scope: 'col' }, t('share.result')))), tbody));
  const nobody = h('p', { class: 'muted', testid: 'share-nobody', hidden: true }, t('share.nobody'));
  const preview = h('ul', { class: 'share__preview', 'aria-live': 'polite', testid: 'share-preview' });
  const addError = h('p', { class: 'field__error', role: 'alert', hidden: true, testid: 'share-add-error' });

  // ---- add somebody
  let addControl;
  let addGrantee = null; // admin: the <select>; owner: the <input>
  const addBtn = h('button', { type: 'button', class: 'btn', testid: 'btn-share-add', write: true, on: { click: () => addSelected() } }, t('share.add'));
  if (isAdmin) {
    addGrantee = h('select', { class: 'input', id: 'share-grantee', testid: 'field-share-grantee' });
    addControl = h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'share-grantee' }, t('share.addAdminLabel')), h('div', { class: 'share__who' }, addGrantee, addBtn), addError);
  } else {
    addGrantee = h('input', { type: 'text', class: 'input', id: 'share-login', testid: 'field-share-login', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '32', 'aria-describedby': 'share-login-hint' });
    addGrantee.addEventListener('input', () => {
      const low = addGrantee.value.toLowerCase();
      if (low !== addGrantee.value) addGrantee.value = low;
      addError.hidden = true;
    });
    addGrantee.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSelected();
      }
    });
    addControl = h('div', { class: 'field', testid: 'share-add' }, h('label', { class: 'field__label', for: 'share-login' }, t('share.addTypedLabel')), h('div', { class: 'share__who' }, addGrantee, addBtn), h('p', { class: 'field__hint', id: 'share-login-hint' }, t('share.addTypedHint')), addError);
  }
  addControl.setAttribute('data-testid', 'share-add');
  addControl.hidden = true;

  const changes = () => [...draft.keys()].filter((login) => draft.get(login) !== (current.get(login) || 'none')).sort(byLogin);

  function phrase(login, level) {
    return level === 'none' ? t('perm.preview.none', { login: isolate(login), path: isolate(path) }) : t('perm.preview.give', { login: isolate(login), path: isolate(path), level: t(`perm.phrase.${level}`) });
  }

  function refreshPreview() {
    const ch = changes();
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    if (!ch.length) preview.append(h('li', { class: 'muted' }, t('share.noChanges')));
    for (const login of ch) preview.append(h('li', { testid: 'share-change', 'data-login': login }, phrase(login, draft.get(login))));
    if (ctrl) {
      const apply = ctrl.buttons['share-apply'];
      apply.disabled = busy || !ready || ch.length === 0;
      apply.textContent = ch.length ? tp('share.apply', ch.length) : t('share.applyNone');
    }
  }

  function refreshCurrent() {
    const list = [...current.entries()].filter(([, l]) => l !== 'none').sort((a, b) => byLogin(a[0], b[0]));
    currentLine.textContent = list.length ? `${t('share.current')} ${list.map(([login, l]) => `${login} (${t(`perm.phrase.${l}`)})`).join(', ')}` : t('share.private');
  }

  function refreshAddChoices() {
    if (!isAdmin) return;
    while (addGrantee.firstChild) addGrantee.removeChild(addGrantee.firstChild);
    for (const d of directory) if (d.login !== owner && !draft.has(d.login)) addGrantee.append(h('option', { value: d.login }, `${d.login}${d.displayName && d.displayName !== d.login ? ` (${d.displayName})` : ''}`));
    addBtn.disabled = addGrantee.childNodes.length === 0;
  }

  function renderRows(focusLogin = null) {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    const logins = [...draft.keys()].sort(byLogin);
    for (const login of logins) {
      const r = resultOf.get(login);
      tbody.append(
        h(
          'tr',
          { testid: 'share-row', 'data-login': login },
          h('th', { scope: 'row' }, h('span', { class: 'share__who' }, h('strong', null, isolate(login)))),
          h('td', null, levelSelect({ t, login, owner, coll: name, label: path, value: draft.get(login), testid: 'share-select', disabled: busy, onChange: (v) => {
            draft.set(login, v);
            resultOf.delete(login);
            renderResult(login);
            refreshPreview();
          } })),
          h('td', null, h('span', { class: 'share__result', testid: 'share-result', 'data-result': r ? r.result : '' }, r ? r.text : '')),
        ),
      );
    }
    tableWrap.hidden = logins.length === 0;
    nobody.hidden = logins.length !== 0;
    if (focusLogin) {
      const sel = tbody.querySelector(`[data-testid="share-select"][data-login="${focusLogin.replace(/["\\]/g, '')}"]`);
      if (sel) sel.focus();
    }
  }

  function renderResult(login) {
    const row = tbody.querySelector(`[data-testid="share-row"][data-login="${login.replace(/["\\]/g, '')}"]`);
    if (!row) return;
    const cell = row.querySelector('[data-testid="share-result"]');
    const r = resultOf.get(login);
    cell.textContent = r ? r.text : '';
    cell.setAttribute('data-result', r ? r.result : '');
  }

  function addSelected() {
    addError.hidden = true;
    const login = String(addGrantee.value || '').trim().toLowerCase();
    const fail = (key) => {
      addError.textContent = t(key, { login: isolate(login) });
      addError.hidden = false;
      addGrantee.focus();
    };
    if (!login) return fail('share.err.required');
    if (!LOGIN_RE.test(login)) return fail('share.err.pattern');
    if (login === owner) return fail('share.err.self');
    if (draft.has(login)) {
      fail('share.err.listed');
      return;
    }
    draft.set(login, 'read');
    if (!isAdmin) addGrantee.value = '';
    refreshAddChoices();
    renderRows(login);
    refreshPreview();
  }

  function failureText(res, login) {
    if (!isAdmin && res.code === 'validation' && res.field === 'grantee') return t('share.err.unknownGrantee');
    return res.message || t('err.api.unknown');
  }

  async function apply() {
    if (busy || !ready) return;
    const ch = changes();
    if (!ch.length) return;
    busy = true;
    for (const b of [ctrl.buttons['share-apply'], ctrl.buttons['share-cancel']]) b.disabled = true;
    renderRows();
    let ok = 0;
    let bad = 0;
    let stopped = false;
    for (let i = 0; i < ch.length; i++) {
      const login = ch[i];
      const level = draft.get(login);
      status.textContent = t('share.applying', { done: i, total: ch.length });
      const res = await admin.applyGrant({ owner, collection: name, grantee: login, level });
      if (closed) return;
      if (res.ok) {
        ok++;
        if (level === 'none') current.delete(login);
        else current.set(login, level);
        resultOf.set(login, { result: 'ok', text: t(level === 'none' ? 'share.resultRemoved' : 'share.resultOk') });
      } else {
        bad++;
        resultOf.set(login, { result: 'error', text: failureText(res, login) });
        if (res.status === 'aborted' || res.status === 'unauthenticated') {
          stopped = true;
          break;
        }
      }
    }
    applied += ok;
    failed += bad;
    busy = false;
    ctrl.buttons['share-cancel'].disabled = false;
    ctrl.buttons['share-cancel'].textContent = t('share.close');
    // applied ones are no longer a pending change: their draft now equals the server
    renderRows();
    refreshCurrent();
    refreshAddChoices();
    refreshPreview();
    const text = bad === 0 ? tp('share.done', ok, { name: isolate(label) }) : t('share.partial', { ok, failed: bad });
    status.textContent = text;
    status.setAttribute('role', bad ? 'alert' : 'status');
    if (feedback && !stopped) feedback.setStatus(text);
  }

  // ---- the dialog
  const promise = new Promise((resolve) => {
    ctrl = openDialog({
      testid: 'dialog-share',
      title: t('share.title', { name: isolate(label) }),
      description: t(owner === (app.session && app.session.login) ? 'share.descOwn' : 'share.desc', { owner: isolate(owner), path: isolate(path) }),
      body: [currentLine, status, nobody, tableWrap, addControl, h('p', { class: 'muted small' }, t('share.adminsAlways')), h('div', { class: 'share__previewbox' }, h('h3', { class: 'section-title' }, t('share.preview')), preview), limitsNote(t)],
      focus: 'cancel',
      win,
      actions: [
        { testid: 'share-cancel', label: t('dialog.cancel'), cancel: true },
        { testid: 'share-apply', label: t('share.applyNone'), kind: 'primary', disabled: true, write: true, onClick: () => { apply(); return false; } },
      ],
      onClose: () => {
        closed = true;
        resolve({ applied, failed });
      },
    });
  });
  ctrl.dialog.classList.add('dialog--share');
  refreshPreview();

  (async () => {
    let grants;
    try {
      grants = await app.api.grants({ owner });
    } catch {
      grants = null;
    }
    if (closed) return;
    if (grants === null) {
      status.textContent = t('share.loadFailed');
      status.setAttribute('role', 'alert');
      return;
    }
    current = new Map();
    for (const g of grants) if (g.collection === name && (g.level === 'read' || g.level === 'readwrite')) current.set(g.grantee, g.level);
    for (const [login, level] of current) draft.set(login, level);
    if (isAdmin) {
      const dir = await admin.directory();
      if (closed) return;
      directory = dir.ok ? dir.directory.slice().sort((a, b) => byLogin(a.login, b.login)) : [];
      const full = await admin.load();
      if (closed) return;
      if (full.ok) {
        const adminLogins = new Set(full.accounts.filter((a) => a.admin).map((a) => a.login));
        directory = directory.filter((d) => !adminLogins.has(d.login));
      }
    }
    ready = true;
    status.textContent = t('share.ready');
    addControl.hidden = false;
    refreshCurrent();
    refreshAddChoices();
    renderRows();
    refreshPreview();
  })();

  const out = promise;
  out.dialog = ctrl;
  return out;
}

