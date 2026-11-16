// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthStore, encodeBasic, STORAGE_KEY, browserStorages } from '../../../src/js/auth.js';
import { fakeStorage } from './_helpers.mjs';

const HEADER = encodeBasic('alice', 'secret-pass');

test('encodeBasic: UTF-8 and the colon rule', () => {
  assert.equal(encodeBasic('alice', 'secret'), 'Basic YWxpY2U6c2VjcmV0');
  assert.equal(encodeBasic('bob', 'pässwörd'), 'Basic ' + Buffer.from('bob:pässwörd', 'utf8').toString('base64'));
  assert.equal(encodeBasic('a', 'b:c'), 'Basic ' + Buffer.from('a:b:c').toString('base64'));
  assert.throws(() => encodeBasic('a:b', 'x'), RangeError);
  assert.throws(() => encodeBasic(1, 'x'), TypeError);
});

test('default: the header goes to sessionStorage only', () => {
  const session = fakeStorage();
  const local = fakeStorage();
  const s = createAuthStore({ session, local });
  assert.equal(s.isSignedIn(), false);
  assert.equal(s.getAuth(), null);
  assert.equal(s.signIn(HEADER, { login: 'alice' }), 'session');
  assert.ok(session.data.has(STORAGE_KEY));
  assert.equal(local.data.size, 0);
  assert.equal(s.getAuth(), HEADER);
  assert.equal(s.getLogin(), 'alice');
  assert.deepEqual(s.describe(), { signedIn: true, login: 'alice', where: 'session' });
});

test('"stay signed in" uses localStorage and clears sessionStorage', () => {
  const session = fakeStorage();
  const local = fakeStorage();
  const s = createAuthStore({ session, local });
  s.signIn(HEADER, { login: 'alice' });
  assert.equal(s.signIn(HEADER, { login: 'alice', stay: true }), 'local');
  assert.equal(session.data.size, 0);
  assert.ok(local.data.has(STORAGE_KEY));
  assert.equal(s.describe().where, 'local');
  // a fresh store over the same storages (a reload) is still signed in
  assert.equal(createAuthStore({ session, local }).getAuth(), HEADER);
  // signing in again without "stay" removes the long-lived copy
  s.signIn(HEADER, { login: 'alice' });
  assert.equal(local.data.size, 0);
});

test('logout clears both storages and memory', () => {
  const session = fakeStorage();
  const local = fakeStorage();
  const s = createAuthStore({ session, local });
  session.setItem(STORAGE_KEY, JSON.stringify({ h: HEADER, u: 'x' }));
  local.setItem(STORAGE_KEY, JSON.stringify({ h: HEADER, u: 'x' }));
  assert.equal(s.isSignedIn(), true);
  s.logout();
  assert.equal(session.data.size + local.data.size, 0);
  assert.equal(s.isSignedIn(), false);
  const throwing = createAuthStore({ session: fakeStorage({ throwOn: ['setItem'] }), local: fakeStorage({ throwOn: ['setItem'] }) });
  throwing.signIn(HEADER, { login: 'alice' });
  throwing.logout();
  assert.equal(throwing.getAuth(), null);
});

test('a throwing storage falls back to memory without throwing', () => {
  for (const throwOn of [['setItem'], ['getItem'], ['getItem', 'setItem', 'removeItem']]) {
    const s = createAuthStore({ session: fakeStorage({ throwOn }), local: fakeStorage({ throwOn }) });
    const where = s.signIn(HEADER, { login: 'alice', stay: true });
    assert.equal(where, 'memory', throwOn.join());
    assert.equal(s.getAuth(), HEADER);
    assert.equal(s.describe().where, 'memory');
    s.logout();
    assert.equal(s.getAuth(), null);
  }
});

test('stay=true with a blocked localStorage degrades to sessionStorage, not to nothing', () => {
  const session = fakeStorage();
  const s = createAuthStore({ session, local: fakeStorage({ throwOn: ['setItem'] }) });
  assert.equal(s.signIn(HEADER, { stay: true }), 'session');
});

test('missing storages (null) work in memory', () => {
  const s = createAuthStore({});
  assert.equal(s.signIn(HEADER, { login: 'alice' }), 'memory');
  assert.equal(s.getAuth(), HEADER);
});

test('corrupt or hostile stored values are ignored', () => {
  for (const value of ['not json', '{}', '{"h":"Bearer abc"}', '{"h":"Basic !!!"}', JSON.stringify({ h: 'Basic ' + 'A'.repeat(2000) }), 'null', '[]']) {
    const session = fakeStorage();
    session.setItem(STORAGE_KEY, value);
    const s = createAuthStore({ session });
    assert.equal(s.getAuth(), null, value.slice(0, 20));
    assert.equal(s.isSignedIn(), false);
  }
});

test('signIn refuses a malformed header', () => {
  const s = createAuthStore({ session: fakeStorage() });
  for (const bad of ['', 'Basic', 'Basic a b', 'Bearer abc', null, 'Basic ' + 'A'.repeat(2000)]) assert.throws(() => s.signIn(bad), TypeError);
});

test('the header never appears in describe(), JSON, string conversion or listener payloads', () => {
  const s = createAuthStore({ session: fakeStorage() });
  const payloads = [];
  s.subscribe((p) => payloads.push(p));
  s.signIn(HEADER, { login: 'alice' });
  const b64 = HEADER.slice(6);
  for (const text of [JSON.stringify(s.describe()), JSON.stringify(s), String(s), JSON.stringify(payloads), Object.keys(s).join()]) assert.ok(!text.includes(b64) && !text.includes('Basic '), text);
  assert.equal(payloads.length, 1);
  s.logout();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].signedIn, false);
});

test('subscribe: unsubscribe works and a throwing listener does not break sign-in', () => {
  const s = createAuthStore({ session: fakeStorage() });
  let n = 0;
  const off = s.subscribe(() => {
    n += 1;
    throw new Error('boom');
  });
  s.signIn(HEADER);
  assert.equal(n, 1);
  off();
  s.logout();
  assert.equal(n, 1);
});

test('browserStorages survives property getters that throw', () => {
  const win = {
    get sessionStorage() {
      throw new DOMException('denied', 'SecurityError');
    },
    localStorage: fakeStorage(),
  };
  const st = browserStorages(win);
  assert.equal(st.session, null);
  assert.ok(st.local);
});

// ---------------------------------------------------------- replaceCredential (own password change)

test('replaceCredential keeps the storage kind: session stays in sessionStorage, local in localStorage', () => {
  for (const stay of [false, true]) {
    const session = fakeStorage();
    const local = fakeStorage();
    const s = createAuthStore({ session, local });
    s.signIn(HEADER, { login: 'alice', stay });
    const where = s.replaceCredential('alice', 'brand-new-pass');
    assert.equal(where, stay ? 'local' : 'session');
    assert.equal(s.getAuth(), encodeBasic('alice', 'brand-new-pass'));
    assert.deepEqual(s.describe(), { signedIn: true, login: 'alice', where });
    assert.equal((stay ? session : local).data.size, 0, 'the other storage stays empty');
    assert.equal((stay ? local : session).data.size, 1);
    // a reload (fresh store over the same storages) still has the NEW credential
    assert.equal(createAuthStore({ session, local }).getAuth(), encodeBasic('alice', 'brand-new-pass'));
  }
});

test('replaceCredential in memory stays in memory; the old header is gone', () => {
  const s = createAuthStore({ session: fakeStorage({ throwOn: ['setItem'] }), local: null });
  assert.equal(s.signIn(HEADER, { login: 'alice' }), 'memory');
  assert.equal(s.replaceCredential('alice', 'next'), 'memory');
  assert.equal(s.getAuth(), encodeBasic('alice', 'next'));
});

test('replaceCredential falls back to memory when the storage refuses the new value, and never keeps the old one', () => {
  const session = fakeStorage();
  const s = createAuthStore({ session, local: null });
  s.signIn(HEADER, { login: 'alice' });
  const realSet = session.setItem;
  session.setItem = () => {
    throw new DOMException('quota', 'QuotaExceededError');
  };
  assert.equal(s.replaceCredential('alice', 'next'), 'memory');
  session.setItem = realSet;
  assert.equal(s.getAuth(), encodeBasic('alice', 'next'));
  assert.equal(session.data.size, 0, 'the stale record was removed');
});

test('replaceCredential: display login is unchanged, the header login defaults to the one in the header, subscribers hear about it, signed-out is a no-op', () => {
  const session = fakeStorage();
  const s = createAuthStore({ session, local: null });
  assert.equal(s.replaceCredential('alice', 'x'), null);
  assert.equal(s.isSignedIn(), false);
  s.signIn(encodeBasic('Alice', 'old'), { login: 'alice' });
  const seen = [];
  s.subscribe((who) => seen.push(who));
  s.replaceCredential(undefined, 'new');
  assert.equal(s.getAuth(), encodeBasic('Alice', 'new'), 'the user name of the old header is reused');
  assert.equal(s.getLogin(), 'alice');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { signedIn: true, login: 'alice', where: 'session' });
});

test('replaceCredential rejects bad input without touching the stored credential, and never leaks the password', () => {
  const session = fakeStorage();
  const s = createAuthStore({ session, local: null });
  s.signIn(HEADER, { login: 'alice' });
  assert.throws(() => s.replaceCredential('a:b', 'x'), RangeError);
  assert.throws(() => s.replaceCredential('alice', 7), TypeError);
  assert.throws(() => s.replaceCredential('alice', 'x'.repeat(2000)), TypeError);
  assert.equal(s.getAuth(), HEADER);
  s.replaceCredential('alice', 'very-secret-new');
  assert.equal(JSON.stringify(s.describe()).includes('very-secret-new'), false);
  assert.equal(JSON.stringify(s).includes('very-secret-new'), false);
});
