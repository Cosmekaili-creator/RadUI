// SPDX-License-Identifier: AGPL-3.0-or-later
// `#/users/new`: create an account. Login (lower-cased as you type; the pattern and the reserved names are a
// hint, the account service decides), display name, type, administrator (people only), own space, and a password
// that is generated (shown ONCE in a dialog that cannot be dismissed before "I have saved it") or typed (with a
// strength meter). Server answers with a field map onto the form; nothing is lost on an error.
//
// Test ids: account-form (aria-busy), field-acct-login, field-acct-name, field-acct-type (acct-type-person|bot),
// field-acct-admin, field-acct-ownspace, field-pw-mode (pw-mode-generate|typed), pw-typed-box, field-acct-password,
// field-acct-show, pw-strength, form-errors, form-status, account-save, account-cancel, plus the one-time dialog.

import { clear, formField, h } from '../../ui.js';
import { uniqueId } from '../../widgets/fieldkit.js';
import { passwordOnceDialog } from './dialogs.js';
import { checkDisplayName, checkLogin, checkPassword } from './model.js';
import { strengthMeter, tabs } from './parts.js';

const SERVER_FIELD = Object.freeze({ login: 'login', displayName: 'name', password: 'password', type: 'type', admin: 'admin', ownSpace: 'ownspace' });

/** @param {object} env screen environment @param {HTMLElement} host */
export function mountForm(env, host) {
  const { t, app, admin, feedback } = env;
  const restore = env.restore && env.restore.kind === 'account-form' ? env.restore : null;
  let disposed = false;
  let busy = false;

  const loginIn = h('input', { type: 'text', class: 'input', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '32', 'data-autofocus': true });
  const nameIn = h('input', { type: 'text', class: 'input', autocomplete: 'off', maxlength: '64' });
  const fLogin = formField({ id: 'acct-login', label: t('users.col.login'), control: loginIn, hint: t('users.loginHint'), testid: 'field-acct-login' });
  const fName = formField({ id: 'acct-name', label: t('users.col.name'), control: nameIn, testid: 'field-acct-name' });

  const person = h('input', { type: 'radio', name: 'acct-type', value: 'person', checked: true, testid: 'acct-type-person' });
  const bot = h('input', { type: 'radio', name: 'acct-type', value: 'bot', testid: 'acct-type-bot' });
  const typeSet = h(
    'fieldset',
    { class: 'fieldset fieldset--inline', testid: 'field-acct-type' },
    h('legend', { class: 'fieldset__legend' }, t('users.col.type')),
    h('label', { class: 'radio' }, person, h('span', null, t('users.type.person'))),
    h('label', { class: 'radio' }, bot, h('span', null, t('users.type.bot'))),
  );

  const adminId = uniqueId('acct-admin');
  const adminBox = h('input', { type: 'checkbox', id: adminId, testid: 'field-acct-admin', 'aria-describedby': `${adminId}-hint` });
  const adminHint = h('p', { class: 'field__hint', id: `${adminId}-hint` }, t('users.adminHint'));
  const ownId = uniqueId('acct-ownspace');
  const ownBox = h('input', { type: 'checkbox', id: ownId, testid: 'field-acct-ownspace', checked: true, 'aria-describedby': `${ownId}-hint` });

  const gen = h('input', { type: 'radio', name: 'pw-mode', value: 'generate', checked: true, testid: 'pw-mode-generate' });
  const typed = h('input', { type: 'radio', name: 'pw-mode', value: 'typed', testid: 'pw-mode-typed' });
  const modeSet = h(
    'fieldset',
    { class: 'fieldset', testid: 'field-pw-mode' },
    h('legend', { class: 'fieldset__legend' }, t('pw.legend')),
    h('label', { class: 'radio radio--block' }, gen, h('span', null, h('strong', null, t('pw.generate')), ' ', h('span', { class: 'muted' }, t('pw.generateHelp')))),
    h('label', { class: 'radio radio--block' }, typed, h('span', null, h('strong', null, t('pw.typed')), ' ', h('span', { class: 'muted' }, t('pw.typedHelp')))),
  );
  const pwIn = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', spellcheck: 'false', autocapitalize: 'off' });
  const fPw = formField({ id: 'acct-password', label: t('pw.password'), control: pwIn, hint: t('pw.rules'), testid: 'field-acct-password' });
  const showId = uniqueId('acct-pw-show');
  const showBox = h('input', { type: 'checkbox', id: showId, testid: 'field-acct-show' });
  const meter = strengthMeter(t);
  const typedBox = h('div', { class: 'field-group', hidden: true, testid: 'pw-typed-box' }, fPw.el, h('div', { class: 'check' }, showBox, h('label', { for: showId }, t('pw.show'))), meter);

  const errorsBox = h('div', { class: 'notice notice--warn form__errors', role: 'alert', hidden: true, testid: 'form-errors', tabindex: '-1' });
  const status = h('p', { class: 'small muted', role: 'status', testid: 'form-status' });
  const save = h('button', { type: 'submit', class: 'btn btn--primary', testid: 'account-save', write: true }, t('users.create'));
  const form = h(
    'form',
    { class: 'form form--narrow', novalidate: true, testid: 'account-form', 'aria-busy': 'false', 'aria-labelledby': 'users-title' },
    errorsBox,
    fLogin.el,
    fName.el,
    typeSet,
    h('div', { class: 'check-block' }, h('div', { class: 'check' }, ownBox, h('label', { for: ownId }, t('users.ownSpaceLabel'))), h('p', { class: 'field__hint', id: `${ownId}-hint` }, t('users.ownSpaceHint'))),
    h('div', { class: 'check-block', testid: 'acct-admin-block' }, h('div', { class: 'check' }, adminBox, h('label', { for: adminId }, t('users.adminLabel'))), adminHint),
    modeSet,
    typedBox,
    h('div', { class: 'form__actions' }, h('a', { class: 'btn', href: '#/users', testid: 'account-cancel' }, t('dialog.cancel')), save),
    status,
  );
  host.append(h('div', { class: 'toolbar' }, tabs('accounts', t)), form);

  const type = () => (bot.checked ? 'bot' : 'person');
  const mode = () => (typed.checked ? 'typed' : 'generate');
  const dirty = () => loginIn.value !== '' || nameIn.value !== '' || pwIn.value !== '';
  const updateDirty = () => {
    if (app && typeof app.setDirty === 'function') app.setDirty(!disposed && dirty());
  };

  function syncType() {
    const isBot = type() === 'bot';
    if (isBot) adminBox.checked = false;
    adminBox.disabled = isBot;
    adminHint.textContent = t(isBot ? 'users.adminBotHint' : 'users.adminHint');
  }
  function syncMode() {
    typedBox.hidden = mode() !== 'typed';
  }
  loginIn.addEventListener('input', () => {
    const v = loginIn.value;
    const low = v.toLowerCase();
    if (v !== low) loginIn.value = low;
    fLogin.setError(null);
    meter.measure(pwIn.value, loginIn.value.trim());
    updateDirty();
  });
  nameIn.addEventListener('input', () => {
    fName.setError(null);
    updateDirty();
  });
  pwIn.addEventListener('input', () => {
    fPw.setError(null);
    meter.measure(pwIn.value, loginIn.value.trim());
    updateDirty();
  });
  for (const r of [person, bot]) r.addEventListener('change', syncType);
  for (const r of [gen, typed]) r.addEventListener('change', syncMode);
  showBox.addEventListener('change', () => {
    pwIn.setAttribute('type', showBox.checked ? 'text' : 'password');
  });
  syncType();

  if (restore) {
    loginIn.value = restore.login || '';
    nameIn.value = restore.name || '';
    bot.checked = restore.type === 'bot';
    person.checked = !bot.checked;
    adminBox.checked = restore.admin === true && !bot.checked;
    ownBox.checked = restore.ownSpace !== false;
    typed.checked = restore.mode === 'typed';
    gen.checked = !typed.checked;
    syncType();
    syncMode();
    updateDirty();
  }

  const FIELDS = { login: fLogin, name: fName, password: fPw };
  const CONTROLS = { login: loginIn, name: nameIn, password: pwIn, type: bot, admin: adminBox, ownspace: ownBox };

  function showErrors(list) {
    for (const f of Object.values(FIELDS)) f.setError(null);
    clear(errorsBox);
    if (!list.length) {
      errorsBox.hidden = true;
      return;
    }
    for (const e of list) if (FIELDS[e.field]) FIELDS[e.field].setError(e.message);
    errorsBox.append(h('p', { class: 'form__errors-title' }, env.tp('users.err.summary', list.length)), h('ul', null, list.map((e) => h('li', null, e.message))));
    errorsBox.hidden = false;
  }

  function validate() {
    const errs = [];
    const login = loginIn.value.trim();
    const code = checkLogin(login);
    if (code) errs.push({ field: 'login', message: t(`users.err.login.${code}`, { login }) });
    const nameCode = checkDisplayName(nameIn.value);
    if (nameCode) errs.push({ field: 'name', message: t(`users.err.name.${nameCode}`) });
    if (mode() === 'typed') {
      const pwCode = checkPassword(pwIn.value, login);
      if (pwCode) errs.push({ field: 'password', message: t(`users.err.password.${pwCode}`) });
    }
    return errs;
  }

  function setBusy(on) {
    busy = on;
    form.setAttribute('aria-busy', on ? 'true' : 'false');
    save.disabled = on || (app && app.gate && app.gate.blocked === true);
    status.textContent = on ? t('users.creating') : '';
  }

  async function submit(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (busy || disposed) return;
    const errs = validate();
    showErrors(errs);
    if (errs.length) {
      const first = CONTROLS[errs[0].field];
      if (first && typeof first.focus === 'function') first.focus();
      return;
    }
    const login = loginIn.value.trim();
    const body = { login, displayName: nameIn.value.trim(), type: type(), ownSpace: ownBox.checked };
    if (type() === 'person' && adminBox.checked) body.admin = true;
    if (mode() === 'typed') body.password = pwIn.value;
    else body.generate = true;
    const end = app.readiness.begin();
    setBusy(true);
    let res;
    try {
      res = await admin.createAccount(body);
    } finally {
      body.password = undefined;
    }
    if (disposed) return end(true);
    setBusy(false);
    if (!res.ok) {
      if (res.status === 'aborted') return end(true);
      const field = res.field ? SERVER_FIELD[res.field] : res.code === 'exists' || res.code === 'tombstoned' ? 'login' : null;
      const specific = field === 'login' ? t(res.code === 'tombstoned' ? 'users.err.login.tombstoned' : res.code === 'exists' ? 'users.err.login.exists' : 'users.err.server.login', { login }) : field ? t(`users.err.server.${field}`) : res.message;
      showErrors(field && FIELDS[field] ? [{ field, message: specific }] : [{ field: 'none', message: res.message || t('err.api.unknown') }]);
      const c = field && CONTROLS[field];
      if (c && typeof c.focus === 'function') c.focus();
      return end(false);
    }
    pwIn.value = '';
    app.setDirty(false);
    if (typeof res.password === 'string' && res.password) {
      let secret = res.password;
      res.password = null;
      await passwordOnceDialog({ t, login, secret, created: true, win: env.win });
      secret = '';
    }
    if (disposed) return end(true);
    feedback.setStatus(t(res.status === 'pending' ? 'users.createdPending' : 'users.created', { login }));
    end(true);
    app.navigate(`#/users/${encodeURIComponent(login)}`);
  }
  form.addEventListener('submit', submit);

  return {
    submit,
    async load() {
      env.setLine(t('users.new'));
      return { ok: true };
    },
    update() {},
    snapshot: () => ({ kind: 'account-form', login: loginIn.value, name: nameIn.value, type: type(), admin: adminBox.checked, ownSpace: ownBox.checked, mode: mode() }),
    focus() {
      loginIn.focus();
    },
    dispose() {
      disposed = true;
      if (app && typeof app.setDirty === 'function') app.setDirty(false);
    },
  };
}
