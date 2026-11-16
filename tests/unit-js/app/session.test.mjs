// SPDX-License-Identifier: AGPL-3.0-or-later
// Session container (M9): dispose() stops everything, and a second login sees nothing of the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createSessionHolder, lastBookKey, LAST_BOOK_PREFIX } from '../../../src/js/session.js';
import { createAuthStore } from '../../../src/js/auth.js';
import { createActivityLog } from '../../../src/js/ui.js';
import { fakeStorage } from './_helpers.mjs';

/** Manual clock: setTimeout/setInterval that only fire when advance() is called. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const api = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, at: now + ms, every: null });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    setInterval(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, at: now + ms, every: ms });
      return id;
    },
    clearInterval: (id) => pending.delete(id),
    get active() {
      return pending.size;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else pending.delete(id);
        t.fn();
      }
      now = end;
    },
  };
  return api;
}

/** A store with a polling interval like the real scheduler. */
function fakeStore(session, timers, name) {
  const store = {
    name,
    polls: 0,
    disposed: 0,
    cache: new Map([['contacts', [name + '-card']]]),
    dispose() {
      this.disposed += 1;
      this.cache.clear();
    },
  };
  session.setInterval(() => (store.polls += 1), 60_000);
  session.register(store);
  return store;
}

test('a session needs a login', () => {
  assert.throws(() => createSession({}), TypeError);
  assert.throws(() => createSession({ login: '' }), TypeError);
});

test('dispose() stops timers, stores, subscriptions and listeners; later ticks do nothing', () => {
  const timers = fakeTimers();
  const session = createSession({ login: 'alice', timers });
  const store = fakeStore(session, timers, 'alice');
  let once = 0;
  session.setTimeout(() => (once += 1), 5_000);
  const events = new EventTarget();
  let heard = 0;
  session.listen(events, 'ping', () => (heard += 1));
  const order = [];
  session.onDispose(() => order.push('first'));
  session.onDispose(() => order.push('second'));
  session.data.set('discovery', { grants: ['x'] });

  timers.advance(60_000);
  assert.equal(store.polls, 1);
  assert.equal(once, 1);
  events.dispatchEvent(new Event('ping'));
  assert.equal(heard, 1);
  assert.equal(timers.active, 1);

  session.dispose();
  assert.equal(session.disposed, true);
  assert.equal(timers.active, 0, 'every timer is cleared');
  assert.equal(store.disposed, 1);
  assert.equal(store.cache.size, 0, 'the store dropped its memory');
  assert.equal(session.data.size, 0);
  assert.deepEqual(order, ['second', 'first'], 'disposers run newest first');
  timers.advance(10 * 60_000);
  assert.equal(store.polls, 1, 'nothing polls any more');
  events.dispatchEvent(new Event('ping'));
  assert.equal(heard, 1, 'the listener is gone');

  session.dispose(); // idempotent
  assert.equal(store.disposed, 1);
  assert.deepEqual(order, ['second', 'first']);
});

test('register() uses dispose, stop or destroy; a failing store does not stop the others', () => {
  const session = createSession({ login: 'alice', timers: fakeTimers() });
  const calls = [];
  session.register({ stop: () => calls.push('stop') });
  session.register({ destroy: () => calls.push('destroy') });
  session.register({
    dispose() {
      throw new Error('boom');
    },
  });
  session.register({ dispose: () => calls.push('dispose') });
  session.onDispose(() => {
    throw new Error('also boom');
  });
  session.onDispose(() => calls.push('last'));
  assert.doesNotThrow(() => session.dispose());
  assert.deepEqual(calls.sort(), ['destroy', 'dispose', 'last', 'stop']);
  assert.throws(() => createSession({ login: 'a' }).register(null), TypeError);
  assert.throws(() => createSession({ login: 'a' }).onDispose('x'), TypeError);
});

test('after dispose: new timers and listeners are inert, new stores are stopped at once, onDispose callbacks run immediately', () => {
  const timers = fakeTimers();
  const session = createSession({ login: 'alice', timers });
  session.dispose();
  let ran = 0;
  session.setTimeout(() => (ran += 1), 1);
  session.setInterval(() => (ran += 1), 1);
  assert.equal(timers.active, 0);
  const store = { disposed: 0, dispose() { this.disposed += 1; } };
  session.register(store);
  assert.equal(store.disposed, 1);
  session.onDispose(() => (ran += 10));
  assert.equal(ran, 10);
  assert.equal(session.setLastBook('/alice/book/'), false);
});

test('unregister() and the cancel functions of timers and onDispose', () => {
  const timers = fakeTimers();
  const session = createSession({ login: 'alice', timers });
  const store = { dispose() { this.gone = true; } };
  session.register(store);
  assert.equal(session.unregister(store), true);
  let t = 0;
  const cancel = session.setTimeout(() => (t += 1), 10);
  cancel();
  const off = session.onDispose(() => (t += 100));
  off();
  timers.advance(100);
  session.dispose();
  assert.equal(t, 0);
  assert.equal(store.gone, undefined);
});

test('last book: stored per login in localStorage, case-insensitive, unreadable storage tolerated', () => {
  const storage = fakeStorage();
  const a = createSession({ login: 'Alice', storage, timers: fakeTimers() });
  const b = createSession({ login: 'bob', storage, timers: fakeTimers() });
  assert.equal(a.lastBook, null);
  assert.equal(a.setLastBook('/alice/book/'), true);
  assert.equal(a.lastBook, '/alice/book/');
  assert.equal(b.lastBook, null, "a second login does not see the first login's preference");
  assert.equal(createSession({ login: 'alice', storage, timers: fakeTimers() }).lastBook, '/alice/book/');
  assert.ok([...storage.data.keys()].every((k) => k.startsWith(LAST_BOOK_PREFIX)));
  assert.notEqual(lastBookKey('alice'), lastBookKey('bob'));
  assert.equal(lastBookKey('A:b/c'), LAST_BOOK_PREFIX + 'a%3Ab%2Fc');
  assert.equal(a.setLastBook(''), true);
  assert.equal(a.lastBook, null);
  const broken = createSession({ login: 'x', storage: fakeStorage({ throwOn: ['getItem', 'setItem', 'removeItem'] }), timers: fakeTimers() });
  assert.equal(broken.lastBook, null);
  assert.equal(broken.setLastBook('/x/'), false);
  assert.equal(createSession({ login: 'x', timers: fakeTimers() }).lastBook, null);
});

test('holder: ensure() reuses the session of the same login and replaces (disposing) another login\'s', () => {
  const timers = fakeTimers();
  const started = [];
  const ended = [];
  const holder = createSessionHolder({ timers, onStart: (s) => started.push(s.login), onEnd: (s, why) => ended.push([s.login, why]) });
  assert.equal(holder.current, null);
  const a = holder.ensure('alice');
  assert.equal(holder.ensure('alice'), a);
  assert.equal(holder.current, a);
  const store = fakeStore(a, timers, 'alice');
  const b = holder.ensure('bob');
  assert.notEqual(b, a);
  assert.equal(a.disposed, true);
  assert.equal(store.disposed, 1);
  assert.deepEqual(started, ['alice', 'bob']);
  assert.deepEqual(ended, [['alice', 'replaced']]);
  assert.equal(holder.end('signed-out'), true);
  assert.equal(holder.end(), false);
  assert.equal(holder.current, null);
  assert.deepEqual(ended.at(-1), ['bob', 'signed-out']);
});

// The wiring app.js does: credential store -> session holder -> activity log.
function wireApp() {
  const timers = fakeTimers();
  const storages = { session: fakeStorage(), local: fakeStorage() };
  const auth = createAuthStore(storages);
  const activity = createActivityLog();
  const holder = createSessionHolder({ storage: storages.local, timers, onEnd: () => activity.clear() });
  auth.subscribe((who) => (who.signedIn ? holder.ensure(who.login) : holder.end('signed-out')));
  return { timers, storages, auth, activity, holder };
}
const basic = (login) => 'Basic ' + Buffer.from(`${login}:pw`).toString('base64');

test('sign-out disposes the session: timers stopped, memory cleared, Activity emptied', () => {
  const w = wireApp();
  w.auth.signIn(basic('alice'), { login: 'alice' });
  const s = w.holder.current;
  assert.equal(s.login, 'alice');
  const store = fakeStore(s, w.timers, 'alice');
  s.data.set('contacts', ['Ann']);
  w.activity.add({ op: 'create', target: 'Ann Example' });
  w.timers.advance(60_000);
  assert.equal(store.polls, 1);

  w.auth.logout();
  assert.equal(w.holder.current, null);
  assert.equal(s.disposed, true);
  assert.equal(w.timers.active, 0);
  assert.equal(store.disposed, 1);
  assert.equal(s.data.size, 0);
  assert.equal(w.activity.size, 0);
  w.timers.advance(10 * 60_000);
  assert.equal(store.polls, 1);
});

test('session expiry (credential dropped) disposes the session exactly like sign-out', () => {
  const w = wireApp();
  w.auth.signIn(basic('alice'), { login: 'alice' });
  const s = w.holder.current;
  const store = fakeStore(s, w.timers, 'alice');
  // what app.js expireSession() does: auth.logout()
  w.auth.logout();
  assert.equal(s.disposed, true);
  assert.equal(store.disposed, 1);
  assert.equal(w.timers.active, 0);
});

test('a second login in the same tab sees none of the first login\'s data', () => {
  const w = wireApp();
  w.auth.signIn(basic('alice'), { login: 'alice' });
  const first = w.holder.current;
  first.data.set('contacts', ['Ann Example']);
  first.setLastBook('/alice/book/');
  const firstStore = fakeStore(first, w.timers, 'alice');
  w.activity.add({ op: 'update', target: 'Ann Example' });
  w.auth.logout();

  w.auth.signIn(basic('bob'), { login: 'bob' });
  const second = w.holder.current;
  assert.notEqual(second, first);
  assert.equal(second.login, 'bob');
  assert.equal(second.data.size, 0);
  assert.equal(second.lastBook, null);
  assert.equal(w.activity.size, 0);
  assert.equal(JSON.stringify([...second.data]).includes('Ann'), false);
  assert.equal(firstStore.cache.size, 0, 'the first login\'s store was emptied');
  w.timers.advance(5 * 60_000);
  assert.equal(firstStore.polls, 0, 'the first login\'s scheduler no longer runs');
  assert.equal(w.timers.active, 0);

  // even a direct credential swap (no logout in between) starts from a fresh container
  const secondStore = fakeStore(second, w.timers, 'bob');
  w.auth.signIn(basic('carol'), { login: 'carol' });
  assert.equal(second.disposed, true);
  assert.equal(secondStore.disposed, 1);
  assert.equal(w.holder.current.login, 'carol');
});
