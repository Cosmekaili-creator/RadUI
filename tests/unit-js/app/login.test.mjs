// SPDX-License-Identifier: AGPL-3.0-or-later
// The login screen driven through a fake DOM and fake services (no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDocument, createFeedback, createActivityLog, createReadiness } from '../../../src/js/ui.js';
import { renderLogin } from '../../../src/js/login.js';
import { createAuthStore } from '../../../src/js/auth.js';
import { createApi } from '../../../src/js/api.js';
import { createI18n } from '../_i18n-all.mjs';
import { fakeDocument, FakeElement, fakeStorage, makeFetch, json, find } from './_helpers.mjs';

setDocument(fakeDocument());

function setup({ handler, params = {}, davPrincipal } = {}) {
  const i18n = createI18n({ lang: 'en' });
  const session = fakeStorage();
  const local = fakeStorage();
  const auth = createAuthStore({ session, local });
  const feedback = createFeedback();
  feedback.enterScreen('login');
  const activity = createActivityLog();
  const readiness = createReadiness(() => {});
  const navigations = [];
  const fetchImpl = makeFetch(handler || (() => json(200, { login: 'alice', displayName: 'Alice', type: 'person', admin: false, ownSpace: true, generation: 1 })));
  const app = {
    auth,
    feedback,
    activity,
    readiness,
    candidate: (header) => ({ api: createApi({ apiBase: '/api/', getAuth: () => header, fetchImpl }), dav: { principal: davPrincipal || (async () => '/alice/') } }),
    navigate: (hash, opts) => navigations.push([hash, opts]),
  };
  const root = new FakeElement('main');
  const ctl = renderLogin({ root, t: i18n.t, params, host: 'host.example.org', app });
  const el = (id) => find(root, id);
  const submit = async (user, pass, stay = false) => {
    el('login-username').value = user;
    el('login-password').value = pass;
    el('login-stay').checked = stay;
    const ev = new Event('submit', { cancelable: true });
    el('login-form').dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    await new Promise((r) => setTimeout(r, 10));
  };
  return { el, submit, auth, feedback, activity, navigations, session, local, fetchImpl, ctl, root };
}

test('login screen: documented test ids, labels, stay checkbox off by default', () => {
  const s = setup();
  for (const id of ['login-form', 'login-username', 'login-password', 'login-stay', 'login-submit', 'login-error', 'login-stay-note', 'login-server']) assert.ok(s.el(id), id);
  assert.ok(!s.el('login-stay').checked);
  assert.equal(s.el('login-stay').getAttribute('aria-describedby'), 'login-stay-note');
  assert.equal(s.el('login-error').getAttribute('role'), 'alert');
  assert.equal(s.el('login-password').getAttribute('type'), 'password');
  assert.equal(s.el('login-username').getAttribute('autocomplete'), 'username');
  assert.match(s.el('login-stay-note').textContent, /shared or public device/);
  assert.equal(s.el('login-server').textContent, 'Server: host.example.org');
  assert.equal(s.ctl.title, 'Sign in');
});

test('login: empty fields show visible field errors and send nothing', async () => {
  const s = setup();
  await s.submit('', '');
  assert.equal(s.el('login-username').getAttribute('aria-invalid'), 'true');
  assert.equal(s.el('login-username-error').textContent, 'Enter your user name.');
  await s.submit('alice', '');
  assert.equal(s.el('login-password-error').textContent, 'Enter your password.');
  await s.submit('a:b', 'x');
  assert.match(s.el('login-username-error').textContent, /colon/);
  assert.equal(s.fetchImpl.calls.length, 0);
});

test('login success: stored in sessionStorage, activity logged, status for the next screen, navigation', async () => {
  const s = setup();
  await s.submit('alice', 'secret');
  assert.equal(s.fetchImpl.calls[0].headers.authorization, 'Basic YWxpY2U6c2VjcmV0');
  assert.equal(s.auth.describe().where, 'session');
  assert.equal(s.local.data.size, 0);
  assert.deepEqual(s.navigations, [['#/contacts', { replace: true }]]);
  assert.equal(s.feedback.status.text, 'Signed in as alice.');
  assert.equal(s.feedback.status.scope, 'contacts');
  assert.equal(s.el('login-password').value, '');
  const e = s.activity.entries()[0];
  assert.deepEqual([e.op, e.target, e.result], ['login', 'alice', 'ok']);
  assert.ok(!JSON.stringify(s.activity.entries()).includes('YWxpY2U6'));
});

test('login success with "stay signed in" uses localStorage; a safe ?next= is honoured', async () => {
  const s = setup({ params: { next: '#/debug?items=2' } });
  await s.submit('alice', 'secret', true);
  assert.equal(s.auth.describe().where, 'local');
  assert.equal(s.navigations[0][0], '#/debug?items=2');
  const bad = setup({ params: { next: 'https://evil.example/' } });
  await bad.submit('alice', 'secret');
  assert.equal(bad.navigations[0][0], '#/contacts');
});

test('login failure: persistent error text, nothing stored, no navigation', async () => {
  const s = setup({ handler: () => ({ status: 401 }) });
  await s.submit('alice', 'wrong');
  assert.equal(s.el('login-error').textContent, 'Wrong user name or password.');
  assert.equal(s.auth.isSignedIn(), false);
  assert.equal(s.session.data.size + s.local.data.size, 0);
  assert.deepEqual(s.navigations, []);
  assert.equal(s.el('login-password').getAttribute('aria-invalid'), 'true');
  // the error is announced once: the field links to the alert region instead of repeating the text
  assert.equal(s.el('login-password').getAttribute('aria-describedby'), 'login-error');
  assert.equal(s.el('login-password-error').textContent, '');
  assert.equal(s.el('login-password-error').hidden, true);
  assert.equal(s.el('login-error').getAttribute('role'), 'alert');
  // focus() but never select(): no highlighted dots
  assert.equal(FakeElement.focused, s.el('login-password'));
  assert.ok(!s.el('login-password').selectCount, 'select() must not be called');
  assert.equal(s.activity.entries()[0].result, 'error');
  assert.equal(s.feedback.status, null); // "Signing in..." is gone
  assert.equal(s.el('login-submit').disabled, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.el('login-error').textContent, 'Wrong user name or password.', 'the error does not time out');
});

test('login: rate limit and unavailable server have their own messages', async () => {
  const limited = setup({ handler: () => json(429, { error: { code: 'rate_limited' } }) });
  await limited.submit('alice', 'x');
  assert.match(limited.el('login-error').textContent, /Too many attempts/);
  const down = setup({
    handler: () => {
      throw new TypeError('down');
    },
    davPrincipal: async () => {
      throw new TypeError('down');
    },
  });
  await down.submit('alice', 'x');
  assert.match(down.el('login-error').textContent, /could not be reached/);
});

test('login: backend down but DAV answers -> signed in with a "limited" notice', async () => {
  const s = setup({ handler: () => ({ status: 502 }) });
  await s.submit('alice', 'secret');
  assert.equal(s.auth.isSignedIn(), true);
  assert.match(s.feedback.status.text, /only basic sign-in was checked/);
  assert.match(s.activity.entries()[0].detail, /^dav/);
});

test('snapshot/restore keeps what was typed across a language change', async () => {
  const s = setup({ handler: () => ({ status: 401 }) });
  s.el('login-username').value = 'bob';
  const snap = s.ctl.snapshot();
  assert.equal(snap.username, 'bob');
  await s.submit('bob', 'nope');
  const snap2 = s.ctl.snapshot();
  assert.equal(snap2.errorKey, 'login.err.bad');
  const i18n = createI18n({ lang: 'fr' });
  const root = new FakeElement('main');
  renderLogin({ root, t: i18n.t, params: {}, host: 'h', app: { feedback: createFeedback(), readiness: createReadiness(() => {}) }, restore: snap2 });
  assert.equal(find(root, 'login-username').value, 'bob');
  assert.equal(find(root, 'login-error').textContent, "Nom d'utilisateur ou mot de passe incorrect.");
  assert.equal(find(root, 'login-password').getAttribute('aria-describedby'), 'login-error');
  assert.equal(find(root, 'login-password').getAttribute('aria-invalid'), 'true');
});

test('a new attempt clears the invalid state and restores the field description', async () => {
  const s = setup({ handler: () => ({ status: 401 }) });
  await s.submit('alice', 'wrong');
  assert.equal(s.el('login-password').getAttribute('aria-describedby'), 'login-error');
  await s.submit('alice', '');
  assert.equal(s.el('login-password').getAttribute('aria-describedby'), 'login-password-input-error');
  assert.equal(s.el('login-error').textContent, '');
});
