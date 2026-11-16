// SPDX-License-Identifier: AGPL-3.0-or-later
// Login screen. The credential is checked by attemptLogin() (account service
// first, DAV principal as fallback) and only stored when the check succeeded.
// Test ids: login-form, login-username, login-password, login-stay,
// login-stay-note, login-submit, login-error (+ login-username-error,
// login-password-error). A wrong password is shown once, in the role=alert
// login-error region; the password field is linked to it with aria-describedby.

import { h, formField } from './ui.js';
import { encodeBasic } from './auth.js';
import { attemptLogin, LoginError } from './api.js';
import { parseHash, resolveRoute, safeNext, LANDING_HASH } from './router.js';
import { familyOf } from './screens.js';

const ERROR_KEYS = { 'bad-credentials': 'login.err.bad', 'rate-limited': 'login.err.rateLimited', unavailable: 'login.err.unavailable' };

/**
 * @param {object} ctx
 * @param {HTMLElement} ctx.root   screen container (empty)
 * @param {(key: string, params?: object) => string} ctx.t
 * @param {object} ctx.params      query parameters of the route (`next`)
 * @param {string} ctx.host        server host shown to the user (location.host)
 * @param {object|null} [ctx.restore] snapshot() of a previous render (language change)
 * @param {object} ctx.app         {auth, candidate(header) -> {api, dav}, activity, feedback, readiness, navigate}
 */
export function renderLogin(ctx) {
  const { root, t, params, host, app } = ctx;
  const restore = ctx.restore || {};
  let busy = false;
  let errorKey = null;

  const user = h('input', { type: 'text', class: 'input', autocomplete: 'username', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', required: true, value: restore.username || '' });
  const pass = h('input', { type: 'password', class: 'input', autocomplete: 'current-password', required: true, value: restore.password || '' });
  const stay = h('input', { type: 'checkbox', id: 'login-stay-input', 'aria-describedby': 'login-stay-note', testid: 'login-stay', checked: Boolean(restore.stay) });
  const userField = formField({ id: 'login-username-input', label: t('login.username'), control: user, testid: 'login-username' });
  const passField = formField({ id: 'login-password-input', label: t('login.password'), control: pass, testid: 'login-password' });
  const error = h('div', { class: 'login__error', id: 'login-error', role: 'alert', testid: 'login-error' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--wide', testid: 'login-submit' }, t('login.submit'));

  // A wrong password is announced once, by the alert region (login-error); the
  // field is only marked invalid and points at that region instead of repeating the text.
  const fieldDescribedBy = pass.getAttribute('aria-describedby');
  const showError = (key) => {
    errorKey = key;
    error.textContent = key ? t(key) : '';
    if (key === 'login.err.bad') {
      pass.setAttribute('aria-invalid', 'true');
      pass.setAttribute('aria-describedby', 'login-error');
    } else if (fieldDescribedBy) {
      pass.setAttribute('aria-describedby', fieldDescribedBy);
    }
  };
  const clearErrors = () => {
    showError(null);
    userField.setError(null);
    passField.setError(null); // also drops aria-invalid
  };

  const form = h(
    'form',
    { class: 'login__form', novalidate: true, testid: 'login-form', 'aria-labelledby': 'login-title', on: { submit: onSubmit } },
    h('h1', { class: 'login__title', id: 'login-title', tabindex: '-1' }, t('login.title')),
    h('p', { class: 'login__server', testid: 'login-server' }, t('login.server', { host })),
    error,
    userField.el,
    passField.el,
    h(
      'div',
      { class: 'login__stay' },
      h('div', { class: 'check' }, stay, h('label', { for: 'login-stay-input' }, t('login.stay'))),
      h('p', { class: 'field__hint', id: 'login-stay-note', testid: 'login-stay-note' }, t('login.stayNote')),
    ),
    submit,
  );
  root.append(h('div', { class: 'login' }, h('div', { class: 'login__panel' }, form)));
  if (restore.errorKey) showError(restore.errorKey);

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    clearErrors();
    const login = user.value.trim();
    const password = pass.value;
    if (!login) {
      userField.setError(t('login.err.usernameRequired'));
      user.focus();
      return;
    }
    if (login.includes(':')) {
      userField.setError(t('login.err.usernameColon'));
      user.focus();
      return;
    }
    if (!password) {
      passField.setError(t('login.err.passwordRequired'));
      pass.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    app.feedback.setStatus(t('login.submitting'));
    const done = app.readiness.begin();
    try {
      const header = encodeBasic(login, password);
      const { api, dav } = app.candidate(header);
      const result = await attemptLogin({ api, dav });
      const shown = (result.me && result.me.login) || login;
      const where = app.auth.signIn(header, { login: shown, stay: stay.checked });
      app.activity.add({ op: 'login', target: shown, result: 'ok', detail: result.via + (where === 'memory' ? ', not persisted' : '') });
      pass.value = '';
      done(true);
      // The message belongs to the next screen family, so it survives the navigation.
      const text = t('login.ok', { login: shown }) + (result.limited ? ' ' + t('login.limited') : '');
      const next = safeNext(params.next) || LANDING_HASH;
      app.feedback.setStatus(text, { scope: familyOf(resolveRoute(parseHash(next)).screen) });
      app.navigate(next, { replace: true });
      return;
    } catch (err) {
      done(true);
      const reason = err instanceof LoginError ? err.reason : 'other';
      app.activity.add({ op: 'login', target: login, result: 'error', detail: reason });
      app.feedback.dismiss('status');
      showError(ERROR_KEYS[reason] || 'login.err.generic');
      pass.focus(); // focus only: select() would paint a blue highlight over the dots
    } finally {
      busy = false;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  }

  const focusTarget = restore.username ? pass : user;
  if (typeof focusTarget.focus === 'function') focusTarget.focus();

  return {
    title: t('login.title'),
    snapshot: () => ({ username: user.value, password: pass.value, stay: stay.checked, errorKey }),
  };
}
