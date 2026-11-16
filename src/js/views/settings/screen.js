// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings (`#/settings`): your account, your own password (administrators only in this version),
// language, and "sign out and forget this device". WP B3b adds the calendar preferences section by
// appending its builder to SECTIONS below (each builder returns one <section>; preferences go through
// env.prefs, which is per login and applies without a reload).
//
// Own password (D-R3-10): the account service has no self-service endpoint yet, so an administrator
// changes their own password through the admin endpoint (`POST accounts/{login}/password`) and the
// stored credential is replaced in place (same storage, auth.replaceCredential). A `GET me` with the new
// header then confirms it; if that fails the user is signed out with a clear text. Other accounts see
// "Ask an administrator to reset your password". The password never reaches the Activity log, the
// console or a URL.
//
// Test ids: settings-screen, settings-status, settings-account (+ settings-account-login|name|type|admin),
// settings-password, own-password-form, field-own-pw, field-own-pw2, btn-own-password-save,
// btn-own-password-generate, own-password-status, own-password-error, own-password-admin-only,
// settings-language (settings-lang-en|fr), settings-calendar (settings-tz-display, settings-first-weekday, settings-24h,
// settings-birthdays, settings-bday-hide-duplicates, settings-cal-status), settings-device, btn-sign-out-forget, settings-diagnostics-link,
// dialog-password-once, generated-password, btn-copy-password, copy-status, field-pw-saved, btn-password-saved,
// settings-about (about-version, about-source-link, about-source-none).
//
// About: the version comes from `app.buildInfo()` (build-info.json of a built tree; none in a source tree:
// "development build"); the source link is the configured `sourceUrl` (https: only, re-checked here), or a
// neutral sentence when it is empty (AGPL section 13).

import { formField, h } from '../../ui.js';
import { oneTimeDialog } from '../../widgets/dialogs.js';
import { lastBookKey } from '../../session.js';
import { calendarSection } from './calendar.js';
import { isHttpsUrl } from '../../config.js';

export const MAX_PASSWORD_BYTES = 72;

/** i18n key (under settings.password.err.) for a failed password change. */
export function passwordErrorKey(err) {
  const kind = err && err.kind;
  if (kind === 'validation' || kind === 'badrequest' || kind === 'toolarge') return 'settings.password.err.rejected';
  if (kind === 'forbidden') return 'settings.password.err.forbidden';
  if (kind === 'ratelimited') return 'settings.password.err.rateLimited';
  if (kind === 'network' || kind === 'unavailable') return 'settings.password.err.network';
  return 'settings.password.err.generic';
}

/** Check the two typed passwords; returns {field: 'pw'|'pw2', key} for the first problem, or null. */
export function checkPasswords(pw, pw2, encoder = new TextEncoder()) {
  if (!pw) return { field: 'pw', key: 'settings.password.err.required' };
  if (encoder.encode(pw).length > MAX_PASSWORD_BYTES) return { field: 'pw', key: 'settings.password.err.tooLong' };
  if (!pw2) return { field: 'pw2', key: 'settings.password.err.repeatRequired' };
  if (pw !== pw2) return { field: 'pw2', key: 'settings.password.err.mismatch' };
  return null;
}

// ------------------------------------------------------------------ sections

function accountSection(env) {
  const { t } = env;
  const rows = {};
  const dl = h('dl', { class: 'settings__facts' });
  for (const [name, key] of [['login', 'settings.account.login'], ['name', 'settings.account.name'], ['type', 'settings.account.type'], ['admin', 'settings.account.admin']]) {
    rows[name] = h('dd', { testid: `settings-account-${name}` });
    dl.append(h('dt', null, t(key)), rows[name]);
  }
  rows.login.textContent = env.login;
  const note = h('p', { class: 'settings__note', testid: 'settings-account-note', role: 'status' }, t('settings.account.loading'));
  const section = h('section', { class: 'settings__section', testid: 'settings-account', 'aria-labelledby': 'settings-account-title' }, h('h2', { class: 'section-title', id: 'settings-account-title' }, t('settings.account.title')), dl, note);
  env.whenMe((me) => {
    if (!me) {
      note.textContent = t('settings.account.unavailable');
      return;
    }
    note.textContent = '';
    rows.login.textContent = me.login;
    rows.name.textContent = me.displayName;
    rows.type.textContent = me.type === 'bot' ? t('account.type.bot') : me.type === 'person' ? t('account.type.person') : '';
    rows.admin.textContent = me.admin ? t('common.yes') : t('common.no');
  });
  return section;
}

function passwordSection(env) {
  const { t } = env;
  const section = h('section', { class: 'settings__section', testid: 'settings-password', 'aria-labelledby': 'settings-password-title' }, h('h2', { class: 'section-title', id: 'settings-password-title' }, t('settings.password.title')));
  env.whenMe((me) => {
    if (!me || !me.admin) {
      section.append(h('p', { class: 'settings__note', testid: 'own-password-admin-only' }, t('settings.password.adminOnly')));
      return;
    }
    section.append(buildPasswordForm(env, me));
  });
  return section;
}

function buildPasswordForm(env, me) {
  const { t, app } = env;
  const pw = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', name: 'new-password', spellcheck: 'false', autocapitalize: 'off' });
  const pw2 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', name: 'new-password-repeat', spellcheck: 'false', autocapitalize: 'off' });
  const f1 = formField({ id: 'field-own-pw', label: t('settings.password.new'), control: pw, hint: t('settings.password.hint'), testid: 'field-own-pw' });
  const f2 = formField({ id: 'field-own-pw2', label: t('settings.password.repeat'), control: pw2, testid: 'field-own-pw2' });
  const save = h('button', { type: 'submit', class: 'btn btn--primary', testid: 'btn-own-password-save', write: true }, t('settings.password.save'));
  const gen = h('button', { type: 'button', class: 'btn', testid: 'btn-own-password-generate', write: true }, t('settings.password.generate'));
  const status = h('p', { class: 'settings__note', role: 'status', testid: 'own-password-status' });
  const alert = h('p', { class: 'field__error', role: 'alert', testid: 'own-password-error', hidden: true });
  const form = h('form', { class: 'settings__form', testid: 'own-password-form', novalidate: true }, h('p', { class: 'settings__note' }, t('settings.password.intro')), f1.el, f2.el, h('div', { class: 'settings__actions' }, save, gen), status, alert);
  let busy = false;

  const setBusy = (on) => {
    busy = on;
    form.setAttribute('aria-busy', on ? 'true' : 'false');
    for (const b of [save, gen]) b.disabled = on || (app.gate && app.gate.blocked === true);
    status.textContent = on ? t('settings.password.saving') : '';
  };
  const showError = (key) => {
    alert.textContent = t(key);
    alert.hidden = false;
  };
  const reset = () => {
    f1.setError(null);
    f2.setError(null);
    alert.textContent = '';
    alert.hidden = true;
  };

  async function change(generate) {
    if (busy || env.disposed()) return;
    reset();
    let body;
    if (generate) body = { generate: true };
    else {
      const problem = checkPasswords(pw.value, pw2.value);
      if (problem) {
        (problem.field === 'pw' ? f1 : f2).setError(t(problem.key));
        (problem.field === 'pw' ? pw : pw2).focus();
        return;
      }
      body = { password: pw.value };
    }
    setBusy(true);
    let res;
    try {
      res = await app.api.resetPassword(me.login, body);
    } catch (err) {
      setBusy(false);
      app.activity.add({ op: 'password', target: me.login, result: 'error', detail: String((err && err.kind) || 'error') });
      showError(passwordErrorKey(err));
      return;
    }
    const newPassword = generate ? res && res.password : body.password;
    pw.value = '';
    pw2.value = '';
    app.activity.add({ op: 'password', target: me.login, result: 'ok', detail: res && res.pending ? 'pending' : '' });
    let header = null;
    try {
      if (!newPassword) throw new Error('no password');
      app.auth.replaceCredential(me.login, newPassword);
      header = app.auth.getAuth();
    } catch {
      // The password was changed on the server but this device cannot hold the new one: start over.
      app.signOutWith('login.passwordChanged');
      return;
    }
    if (generate) await showOnce(env, newPassword); // the dialog must stay open until the user saved it
    if (env.disposed()) return;
    try {
      await app.candidate(header).api.me();
    } catch {
      app.signOutWith('login.passwordChanged');
      return;
    }
    setBusy(false);
    const text = t(res && res.pending ? 'settings.password.pending' : 'settings.password.done');
    status.textContent = text;
    app.feedback.setStatus(text);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    change(false);
  });
  gen.addEventListener('click', () => change(true));
  return form;
}

function showOnce(env, password) {
  const { t } = env;
  const copyStatus = h('p', { class: 'settings__note', role: 'status', testid: 'copy-status' });
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--small',
      testid: 'btn-copy-password',
      on: {
        click: async () => {
          try {
            await globalThis.navigator.clipboard.writeText(password);
            copyStatus.textContent = t('settings.password.once.copied');
          } catch {
            copyStatus.textContent = t('settings.password.once.copyFailed');
          }
        },
      },
    },
    t('settings.password.once.copy'),
  );
  return oneTimeDialog({
    title: t('settings.password.once.title'),
    message: t('settings.password.once.text'),
    body: [h('p', { class: 'secret', testid: 'generated-password' }, password), h('div', { class: 'settings__actions' }, copy), copyStatus],
    ackLabel: t('settings.password.once.ack'),
    confirmLabel: t('settings.password.once.confirm'),
    testid: 'dialog-password-once',
    ackTestid: 'field-pw-saved',
    confirmTestid: 'btn-password-saved',
    t,
  });
}

function languageSection(env) {
  const { t, app } = env;
  const group = h('fieldset', { class: 'settings__radios', testid: 'settings-language' }, h('legend', null, t('settings.language.title')));
  for (const code of ['en', 'fr']) {
    const radio = h('input', { type: 'radio', name: 'settings-lang', value: code, testid: `settings-lang-${code}`, checked: app.lang === code });
    radio.addEventListener('change', () => {
      if (radio.checked) app.setLanguage(code);
    });
    group.append(h('label', { class: 'radio' }, radio, h('span', null, t(`settings.language.${code}`))));
  }
  return h('section', { class: 'settings__section' }, group);
}

function aboutSection(env) {
  const { t, app } = env;
  const version = h('dd', { testid: 'about-version' }, t('settings.about.versionLoading'));
  const dl = h(
    'dl',
    { class: 'settings__facts' },
    h('dt', null, t('settings.about.app')),
    h('dd', null, t('settings.about.appName')),
    h('dt', null, t('settings.about.version')),
    version,
    h('dt', null, t('settings.about.licence')),
    h('dd', null, t('settings.about.licenceName')),
  );
  const url = typeof app.sourceUrl === 'string' && isHttpsUrl(app.sourceUrl) ? app.sourceUrl : '';
  const source = url
    ? h(
        'p',
        { class: 'settings__note' },
        t('settings.about.sourceIntro'),
        ' ',
        h('a', { class: 'settings__link', href: url, rel: 'noopener noreferrer', target: '_blank', testid: 'about-source-link' }, url),
      )
    : h('p', { class: 'settings__note', testid: 'about-source-none' }, t('settings.about.sourceNone'));
  Promise.resolve(app.buildInfo ? app.buildInfo() : null)
    .catch(() => null)
    .then((info) => {
      if (env.disposed()) return;
      version.textContent = info && info.source ? info.source : t('settings.about.versionDev');
    });
  return h('section', { class: 'settings__section', testid: 'settings-about', 'aria-labelledby': 'settings-about-title' }, h('h2', { class: 'section-title', id: 'settings-about-title' }, t('settings.about.title')), dl, source);
}

function deviceSection(env) {
  const { t, app } = env;
  const forget = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--danger',
      testid: 'btn-sign-out-forget',
      on: {
        click: () => {
          // Remove this account's saved preferences and its "last address book", then sign out.
          if (env.prefs) {
            env.prefs.clearAll();
            env.prefs.removeKey(lastBookKey(env.login));
          }
          app.signOut();
        },
      },
    },
    t('settings.device.forget'),
  );
  return h(
    'section',
    { class: 'settings__section', testid: 'settings-device', 'aria-labelledby': 'settings-device-title' },
    h('h2', { class: 'section-title', id: 'settings-device-title' }, t('settings.device.title')),
    h('p', { class: 'settings__note' }, t('settings.device.text')),
    h('div', { class: 'settings__actions' }, forget, h('a', { class: 'btn', href: '#/debug', testid: 'settings-diagnostics-link' }, t('settings.device.diagnostics'))),
  );
}

/** Section builders in display order (the calendar preferences builder is views/settings/calendar.js, WP B3b). */
const SECTIONS = [accountSection, passwordSection, languageSection, calendarSection, deviceSection, aboutSection];

// -------------------------------------------------------------------- screen

export function mount(ctx) {
  const { root, t, app } = ctx;
  let disposed = false;
  const login = (app.auth && app.auth.getLogin && app.auth.getLogin()) || (app.session && app.session.login) || '';
  const prefs = app.prefs ? app.prefs() : null;
  const meWaiters = [];
  let meState = { done: false, me: null };
  const whenMe = (fn) => {
    if (meState.done) fn(meState.me);
    else meWaiters.push(fn);
  };
  const env = { t, tp: ctx.tp, app, login, prefs, whenMe, disposed: () => disposed };
  const status = h('p', { class: 'settings__status', role: 'status', testid: 'settings-status' }, t('settings.status', { login }));
  const page = h('section', { class: 'settings', testid: 'settings-screen', 'aria-labelledby': 'settings-title' }, h('h1', { class: 'page-title', id: 'settings-title', tabindex: '-1' }, t('settings.title')), status);
  for (const build of SECTIONS) page.append(build(env));
  root.append(page);
  Promise.resolve(app.getMe ? app.getMe() : null)
    .catch(() => null)
    .then((me) => {
      if (disposed) return;
      meState = { done: true, me: me || null };
      if (me && me.admin) status.textContent = t('settings.status.admin', { login: me.login });
      for (const fn of meWaiters.splice(0)) fn(meState.me);
    });
  return {
    title: t('settings.title'),
    update() {},
    dispose() {
      disposed = true;
    },
  };
}
