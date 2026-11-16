// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings screen (#/settings): account facts, own-password change for administrators with in-place
// credential replacement, the admin-only notice for everyone else, language, forget-this-device, and the
// per-login preference store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, passwordErrorKey, checkPasswords, MAX_PASSWORD_BYTES } from '../../../src/js/views/settings/screen.js';
import { createPrefs, prefKey } from '../../../src/js/views/settings/prefs.js';
import { createAuthStore, encodeBasic } from '../../../src/js/auth.js';
import { ApiError } from '../../../src/js/api.js';
import { createActivityLog, createFeedback, writeGate } from '../../../src/js/ui.js';
import { createI18n } from '../_i18n-all.mjs';
import { lastBookKey } from '../../../src/js/session.js';
import { makeDom, one, type, fire, chooseRadio } from '../widgets/_dom.mjs';
import { fakeStorage } from './_helpers.mjs';

const doc = makeDom();
/** A fake Storage that can be enumerated (length and key(i)), like the real one. */
function enumerable(storage) {
  Object.defineProperties(storage, {
    length: { get: () => storage.data.size },
    key: { value: (i) => [...storage.data.keys()][i] ?? null },
  });
  return storage;
}
const flush = (n = 6) => (n <= 0 ? Promise.resolve() : new Promise((r) => setImmediate(r)).then(() => flush(n - 1)));
const ME_ADMIN = { login: 'alice', displayName: 'Alice A.', type: 'person', admin: true, ownSpace: true };
const ME_USER = { login: 'bob', displayName: 'Bob B.', type: 'person', admin: false, ownSpace: true };

function reset() {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
  writeGate.setReason('offline', null);
  const main = doc.createElement('main');
  doc.body.append(main);
  return main;
}

function setup({ me = ME_ADMIN, stay = false, resetPassword, verify, lang = 'en', local = enumerable(fakeStorage()), appExtra = {} } = {}) {
  const root = reset();
  const session = fakeStorage();
  const auth = createAuthStore({ session, local });
  const login = me ? me.login : 'alice';
  auth.signIn(encodeBasic(login, 'old-password'), { login, stay });
  const calls = { reset: [], verify: [], signOutWith: [], signOut: 0, lang: [] };
  const activity = createActivityLog();
  const feedback = createFeedback();
  feedback.enterScreen('settings');
  const i18n = createI18n({ lang });
  const prefs = createPrefs({ storage: local, login });
  const app = {
    auth,
    activity,
    feedback,
    lang,
    gate: writeGate,
    session: { login },
    getMe: async () => me,
    prefs: () => prefs,
    api: {
      resetPassword: async (l, body) => {
        calls.reset.push({ login: l, body });
        if (resetPassword) return resetPassword(l, body);
        return { pending: false, password: body.generate ? 'Gen-erated-Pass-123' : null };
      },
    },
    candidate: (header) => ({
      api: {
        me: async () => {
          calls.verify.push(header);
          if (verify) return verify(header);
          return me;
        },
      },
    }),
    signOut: () => {
      calls.signOut += 1;
    },
    signOutWith: (key) => calls.signOutWith.push(key),
    setLanguage: (code) => calls.lang.push(code),
    ...appExtra,
  };
  const ctx = { root, t: (k, p) => i18n.t(k, p), tp: (k, n, p) => i18n.tp(k, n, p), params: {}, route: { name: 'settings', params: {}, query: {} }, signal: new AbortController().signal, app };
  const ctl = mount(ctx);
  return { root, app, auth, calls, ctl, prefs, local, session, activity, feedback };
}
const submit = async () => {
  fire(one(doc.body, 'own-password-form'), 'submit');
  await flush();
};

test('the screen exposes its test ids, a persistent status line and the account facts of `me`', async () => {
  const { root } = setup();
  await flush();
  for (const id of ['settings-screen', 'settings-status', 'settings-account', 'settings-password', 'settings-language', 'settings-device', 'btn-sign-out-forget', 'settings-diagnostics-link', 'settings-lang-en', 'settings-lang-fr']) assert.ok(one(root, id), id);
  assert.equal(one(root, 'settings-status').getAttribute('role'), 'status');
  assert.match(one(root, 'settings-status').textContent, /Signed in as alice \(administrator\)/);
  assert.equal(one(root, 'settings-account-login').textContent, 'alice');
  assert.equal(one(root, 'settings-account-name').textContent, 'Alice A.');
  assert.equal(one(root, 'settings-account-type').textContent, 'Person');
  assert.equal(one(root, 'settings-account-admin').textContent, 'Yes');
  assert.equal(one(root, 'settings-diagnostics-link').getAttribute('href'), '#/debug');
});

test('a non-admin sees "ask an administrator" and no password form', async () => {
  const { root } = setup({ me: ME_USER });
  await flush();
  assert.match(one(root, 'own-password-admin-only').textContent, /Ask an administrator to reset your password/);
  assert.equal(one(root, 'own-password-form'), null);
  assert.equal(one(root, 'settings-account-admin').textContent, 'No');
});

test('without `me` (account service down) the account section says so and no password form is offered', async () => {
  const { root } = setup({ me: null });
  await flush();
  assert.match(one(root, 'settings-account-note').textContent, /unavailable/);
  assert.equal(one(root, 'own-password-form'), null);
  assert.ok(one(root, 'own-password-admin-only'));
});

test('the French screen has the same ids and translated text', async () => {
  const { root } = setup({ lang: 'fr' });
  await flush();
  assert.match(one(root, 'settings-status').textContent, /Connecté en tant que alice \(administrateur\)/);
  assert.ok(one(root, 'own-password-form'));
  assert.equal(one(root, 'btn-sign-out-forget').textContent, 'Se déconnecter et oublier cet appareil');
});

test('own password: empty, mismatching and over-long passwords are refused before any request', async () => {
  const { calls } = setup();
  await flush();
  await submit();
  assert.equal(calls.reset.length, 0);
  assert.match(one(doc.body, 'field-own-pw-error').textContent, /Enter the new password/);
  type(one(doc.body, 'field-own-pw'), 'abc');
  await submit();
  assert.match(one(doc.body, 'field-own-pw2-error').textContent, /second time/);
  type(one(doc.body, 'field-own-pw2'), 'abd');
  await submit();
  assert.match(one(doc.body, 'field-own-pw2-error').textContent, /not the same/);
  const long = 'é'.repeat(37); // 74 bytes
  type(one(doc.body, 'field-own-pw'), long);
  type(one(doc.body, 'field-own-pw2'), long);
  await submit();
  assert.match(one(doc.body, 'field-own-pw-error').textContent, /72 bytes/);
  assert.equal(calls.reset.length, 0);
  assert.equal(calls.verify.length, 0);
  assert.deepEqual(checkPasswords('x'.repeat(MAX_PASSWORD_BYTES), 'x'.repeat(MAX_PASSWORD_BYTES)), null);
  assert.equal(checkPasswords('x'.repeat(MAX_PASSWORD_BYTES + 1), '').key, 'settings.password.err.tooLong');
});

for (const stay of [false, true]) {
  test(`own password (typed twice): server call, credential replaced in place in ${stay ? 'localStorage' : 'sessionStorage'}, confirmed with GET me, no secret in Activity`, async () => {
    const { calls, auth, activity, feedback, session, local } = setup({ stay });
    await flush();
    type(one(doc.body, 'field-own-pw'), 'Brand-new-pass-9');
    type(one(doc.body, 'field-own-pw2'), 'Brand-new-pass-9');
    await submit();
    assert.deepEqual(calls.reset, [{ login: 'alice', body: { password: 'Brand-new-pass-9' } }]);
    const expected = encodeBasic('alice', 'Brand-new-pass-9');
    assert.equal(auth.getAuth(), expected);
    assert.equal(auth.describe().where, stay ? 'local' : 'session');
    assert.equal((stay ? local : session).data.size, 1);
    assert.deepEqual(calls.verify, [expected], 'GET me is sent with the NEW header');
    assert.deepEqual(calls.signOutWith, []);
    assert.equal(one(doc.body, 'field-own-pw').value, '', 'the fields are emptied');
    assert.equal(one(doc.body, 'field-own-pw2').value, '');
    assert.match(one(doc.body, 'own-password-status').textContent, /Your password was changed/);
    const entries = activity.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].op, 'password');
    assert.equal(entries[0].result, 'ok');
    for (const blob of [JSON.stringify(entries), JSON.stringify(feedback.state ? feedback.state() : null)]) assert.equal(blob.includes('Brand-new-pass-9'), false);
  });
}

test('own password: a 202 "activation pending" answer still replaces the credential and says the server is still applying it', async () => {
  const { calls, auth } = setup({ resetPassword: async () => ({ pending: true, password: null }) });
  await flush();
  type(one(doc.body, 'field-own-pw'), 'Pending-pass-1');
  type(one(doc.body, 'field-own-pw2'), 'Pending-pass-1');
  await submit();
  assert.equal(auth.getAuth(), encodeBasic('alice', 'Pending-pass-1'));
  assert.match(one(doc.body, 'own-password-status').textContent, /still applying it/);
  assert.equal(calls.signOutWith.length, 0);
});

test('own password: when GET me with the new header fails, the user is signed out with the "password changed" text', async () => {
  const { calls } = setup({ verify: async () => { throw new ApiError('auth', { status: 401 }); } });
  await flush();
  type(one(doc.body, 'field-own-pw'), 'Brand-new-pass-9');
  type(one(doc.body, 'field-own-pw2'), 'Brand-new-pass-9');
  await submit();
  assert.deepEqual(calls.signOutWith, ['login.passwordChanged']);
  assert.match(createI18n({ lang: 'en' }).t('login.passwordChanged'), /Your password was changed\. Sign in again/);
});

test('own password: a refused change leaves the stored credential alone and shows a persistent error', async () => {
  const { calls, auth } = setup({ resetPassword: async () => { throw new ApiError('validation', { status: 422, code: 'validation', field: 'password' }); } });
  await flush();
  const before = auth.getAuth();
  type(one(doc.body, 'field-own-pw'), 'Brand-new-pass-9');
  type(one(doc.body, 'field-own-pw2'), 'Brand-new-pass-9');
  await submit();
  assert.equal(auth.getAuth(), before);
  assert.equal(calls.verify.length, 0);
  const alert = one(doc.body, 'own-password-error');
  assert.equal(alert.hidden, false);
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.match(alert.textContent, /did not accept this password/);
  assert.equal(one(doc.body, 'btn-own-password-save').disabled, false, 'the form can be used again');
  assert.equal(passwordErrorKey(new ApiError('ratelimited', { status: 429 })), 'settings.password.err.rateLimited');
  assert.equal(passwordErrorKey(new ApiError('forbidden', { status: 403 })), 'settings.password.err.forbidden');
  assert.equal(passwordErrorKey(new ApiError('network', {})), 'settings.password.err.network');
  assert.equal(passwordErrorKey(new ApiError('server', { status: 500 })), 'settings.password.err.generic');
});

test('own password (generated): the one-time dialog shows it, cannot close before the tick, and the check with the new credential waits for it', async () => {
  const { calls, auth } = setup();
  await flush();
  fire(one(doc.body, 'btn-own-password-generate'), 'click');
  await flush();
  assert.deepEqual(calls.reset, [{ login: 'alice', body: { generate: true } }]);
  const dlg = one(doc.body, 'dialog-password-once');
  assert.ok(dlg, 'dialog is open');
  assert.equal(dlg.getAttribute('data-dismissible'), 'false');
  assert.equal(one(dlg, 'generated-password').textContent, 'Gen-erated-Pass-123');
  assert.equal(auth.getAuth(), encodeBasic('alice', 'Gen-erated-Pass-123'), 'the device already holds the new credential');
  assert.equal(one(dlg, 'btn-password-saved').disabled, true, 'confirm needs the tick');
  assert.equal(calls.verify.length, 0, 'not verified (and so not signed out) while the password is on screen');
  const ack = one(dlg, 'field-pw-saved');
  ack.checked = true;
  fire(ack, 'change');
  assert.equal(one(dlg, 'btn-password-saved').disabled, false);
  fire(one(dlg, 'btn-password-saved'), 'click');
  await flush();
  assert.equal(one(doc.body, 'dialog-password-once'), null);
  assert.deepEqual(calls.verify, [encodeBasic('alice', 'Gen-erated-Pass-123')]);
  assert.equal(calls.signOutWith.length, 0);
});

test('language radios call the shell, "forget this device" clears only this login\'s preferences and signs out', async () => {
  const { root, calls, prefs, local } = setup();
  await flush();
  assert.equal(one(root, 'settings-lang-en').checked, true);
  chooseRadio(one(root, 'settings-lang-fr'), doc);
  assert.deepEqual(calls.lang, ['fr']);
  prefs.set('tz', 'UTC');
  prefs.set('first-weekday', 1);
  local.setItem(lastBookKey('alice'), '/alice/book/');
  local.setItem(prefKey('bob', 'tz'), '"Asia/Tokyo"');
  local.setItem('radui.lang', 'fr');
  fire(one(root, 'btn-sign-out-forget'), 'click');
  assert.equal(calls.signOut, 1);
  assert.equal(local.getItem(prefKey('alice', 'tz')), null);
  assert.equal(local.getItem(lastBookKey('alice')), null);
  assert.equal(local.getItem(prefKey('bob', 'tz')), '"Asia/Tokyo"', 'another account is untouched');
  assert.equal(local.getItem('radui.lang'), 'fr', 'device-wide choices (language, theme) stay');
});

test('dispose stops the late `me` answer from touching the page', async () => {
  const { ctl, root } = setup();
  ctl.dispose();
  await flush();
  assert.equal(one(root, 'settings-account-name').textContent, '');
});

// ------------------------------------------------------------------ prefs

test('prefs: per login, JSON values, fallbacks, notification, clearAll removes only this login', () => {
  const storage = enumerable(fakeStorage());
  const a = createPrefs({ storage, login: 'Alice' });
  const b = createPrefs({ storage, login: 'bob' });
  const seen = [];
  const off = a.subscribe((name, value) => seen.push([name, value]));
  assert.equal(a.get('tz', 'x'), 'x');
  assert.equal(a.set('tz', 'UTC'), true);
  assert.equal(a.set('h24', true), true);
  b.set('tz', 'Asia/Tokyo');
  assert.equal(a.get('tz'), 'UTC');
  assert.equal(a.get('h24'), true);
  assert.equal(b.get('tz'), 'Asia/Tokyo');
  assert.equal(prefKey('Alice', 'tz'), prefKey('alice', 'tz'), 'the login is case-insensitive');
  assert.equal(a.clearAll(), 2);
  assert.equal(a.get('tz', 'none'), 'none');
  assert.equal(b.get('tz'), 'Asia/Tokyo');
  a.remove('x');
  off();
  a.set('tz', 'Y');
  assert.deepEqual(seen, [['tz', 'UTC'], ['h24', true], [null, undefined], ['x', undefined]]);
});

test('prefs: a storage that throws never breaks a screen; values live in memory', () => {
  const bad = fakeStorage({ throwOn: ['getItem', 'setItem', 'removeItem'] });
  const p = createPrefs({ storage: bad, login: 'alice' });
  assert.equal(p.set('tz', 'UTC'), false);
  assert.equal(p.get('tz'), 'UTC');
  assert.doesNotThrow(() => p.remove('tz'));
  assert.equal(p.get('tz', 'dflt'), 'dflt');
  assert.doesNotThrow(() => p.clearAll());
  const none = createPrefs({ storage: null, login: 'alice' });
  assert.equal(none.set('a', 1), false);
  assert.equal(none.get('a'), 1);
  const corrupt = fakeStorage();
  corrupt.setItem(prefKey('alice', 'tz'), '{not json');
  assert.equal(createPrefs({ storage: corrupt, login: 'alice' }).get('tz', 'fallback'), 'fallback');
  assert.throws(() => createPrefs({ storage: null, login: '' }), TypeError);
});

test('static: the settings sources use no innerHTML and never log the password', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['screen', 'prefs']) {
    const code = readFileSync(new URL(`../../../src/js/views/settings/${f}.js`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|console\./.test(code), false, f);
  }
});

// ------------------------------------------------------------------ About

test('About: version from build-info, licence and the configured https source link', async () => {
  const { root } = setup({ appExtra: { sourceUrl: 'https://example.invalid/radui', buildInfo: async () => ({ source: 'v1.2-3-gabc1234', minified: true }) } });
  await flush();
  assert.ok(one(root, 'settings-about'));
  assert.equal(one(root, 'about-version').textContent, 'v1.2-3-gabc1234');
  assert.match(one(root, 'settings-about').textContent, /AGPL-3\.0-or-later/);
  const a = one(root, 'about-source-link');
  assert.equal(a.getAttribute('href'), 'https://example.invalid/radui');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(one(root, 'about-source-none'), null);
});

test('About: no build-info and no sourceUrl show "development build" and the neutral sentence, in both languages', async () => {
  for (const [lang, dev, none] of [['en', /development build/, /available from its administrator/], ['fr', /version de développement/, /auprès de son administrateur/]]) {
    const { root } = setup({ lang, appExtra: { sourceUrl: '', buildInfo: async () => null } });
    await flush();
    assert.match(one(root, 'about-version').textContent, dev);
    assert.match(one(root, 'about-source-none').textContent, none);
    assert.equal(one(root, 'about-source-link'), null);
  }
});

test('About: shows "development build" when buildInfo is missing or rejects; a non-https sourceUrl is never linked', async () => {
  for (const extra of [{}, { buildInfo: async () => { throw new Error('x'); } }]) {
    const { root } = setup({ appExtra: { sourceUrl: 'javascript:alert(1)', ...extra } });
    await flush();
    assert.match(one(root, 'about-version').textContent, /development build/);
    assert.equal(one(root, 'about-source-link'), null);
    assert.ok(one(root, 'about-source-none'));
  }
  const { root } = setup({ appExtra: { sourceUrl: 'http://example.invalid/x' } });
  await flush();
  assert.equal(one(root, 'about-source-link'), null);
});
