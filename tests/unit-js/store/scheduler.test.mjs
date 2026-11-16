// SPDX-License-Identifier: AGPL-3.0-or-later
// store/scheduler.js with a fake clock and a fake visibility: triggers, backoff, single flight, hidden, disposal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../../../src/js/session.js';
import { DEFAULTS, createScheduler, domCallbacks } from '../../../src/js/store/scheduler.js';
import { createClock, fakeDoc, fakeStorage, fakeTarget, tick } from './_helpers.mjs';

/** A store double: sync() is scripted, nothing else. */
function fakeStore() {
  const s = {
    calls: [],
    lastSync: 0,
    results: [],
    hold: null,
    async sync({ reason }) {
      s.calls.push(reason);
      if (s.hold) await s.hold;
      const r = s.results.length ? s.results.shift() : { ok: true };
      if (r.ok) s.lastSync = env.clock.now();
      return r;
    },
  };
  return s;
}
let env;
function setup(opts = {}) {
  const clock = createClock();
  const session = createSession({ login: 'alice', storage: fakeStorage(), timers: clock });
  const doc = fakeDoc();
  const win = fakeTarget();
  let online = true;
  const scheduler = createScheduler({ session, doc, win, now: clock.now, isOnline: () => online, ...opts });
  env = { clock, session, doc, win, scheduler, setOnline: (v) => (online = v) };
  return env;
}
const MIN = 60_000;

test('defaults match the plan: 60 s poll, 10 s enter age, 60/120/300 backoff', () => {
  assert.equal(DEFAULTS.intervalMs, 60_000);
  assert.equal(DEFAULTS.enterMinAgeMs, 10_000);
  assert.deepEqual([...DEFAULTS.backoffMs], [60_000, 120_000, 300_000]);
});

test('entering the screen syncs when there was never a sync or the last one is over 10 s old, not before', async () => {
  const { scheduler, clock } = setup();
  const st = fakeStore();
  await scheduler.enter(st);
  assert.deepEqual(st.calls, ['enter']);
  scheduler.unregister(st);
  await clock.advance(5_000);
  await scheduler.enter(st);
  assert.deepEqual(st.calls, ['enter']); // 5 s old: no sync
  scheduler.unregister(st);
  await clock.advance(6_000);
  await scheduler.enter(st);
  assert.deepEqual(st.calls, ['enter', 'enter']); // 11 s old
});

test('polls every 60 s while visible; only registered stores', async () => {
  const { scheduler, clock } = setup();
  const a = fakeStore();
  const b = fakeStore();
  scheduler.register(a);
  await clock.advance(MIN - 1);
  assert.equal(a.calls.length, 0);
  await clock.advance(1);
  assert.deepEqual(a.calls, ['poll']);
  await clock.advance(MIN);
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 0); // never registered
  scheduler.unregister(a);
  await clock.advance(5 * MIN);
  assert.equal(a.calls.length, 2);
  assert.equal(clock.pending, 0);
});

test('window focus and visibilitychange->visible trigger a sync; both together cost one', async () => {
  const { scheduler, clock, doc, win } = setup();
  const st = fakeStore();
  scheduler.register(st);
  await clock.advance(2_000);
  win.fire('focus');
  await tick();
  assert.deepEqual(st.calls, ['focus']);
  await clock.advance(5_000);
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  win.fire('focus'); // fires right after: inside the 1 s gap
  await tick();
  assert.deepEqual(st.calls, ['focus', 'visible']);
});

test('nothing runs while the page is hidden: timers are cancelled and focus is ignored', async () => {
  const { scheduler, clock, doc, win } = setup();
  const st = fakeStore();
  scheduler.register(st);
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  assert.equal(clock.pending, 0);
  await clock.advance(10 * MIN);
  win.fire('focus');
  await tick();
  assert.equal(st.calls.length, 0);
  assert.equal(await scheduler.enter(st), null); // entering a screen while hidden does not sync either
  assert.equal(st.calls.length, 0);
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  await tick();
  assert.deepEqual(st.calls, ['visible']);
  await clock.advance(MIN);
  assert.equal(st.calls.length, 2); // polling resumed
});

test('a timer that fires after the page went hidden does nothing', async () => {
  const { scheduler, clock, doc } = setup();
  const st = fakeStore();
  scheduler.register(st);
  doc.visibilityState = 'hidden'; // without the event: the guard inside the timer must still hold
  await clock.advance(MIN);
  assert.equal(st.calls.length, 0);
});

test('backoff after errors: 60 -> 120 -> 300 s (then stays at 300), a success resets it', async () => {
  const { scheduler, clock } = setup();
  const st = fakeStore();
  st.results = [{ ok: false, kind: 'network' }, { ok: false, kind: 'network' }, { ok: false, kind: 'server' }, { ok: false, kind: 'server' }, { ok: true }];
  scheduler.register(st);
  await clock.advance(MIN); // poll 1 -> error; next in 60 s
  assert.equal(st.calls.length, 1);
  assert.equal(scheduler.state(st).nextDelayMs, 60_000);
  await clock.advance(MIN); // poll 2 -> error; next in 120 s
  assert.equal(st.calls.length, 2);
  assert.equal(scheduler.state(st).nextDelayMs, 120_000);
  await clock.advance(119_000);
  assert.equal(st.calls.length, 2);
  await clock.advance(1_000); // poll 3 -> error; next in 300 s
  assert.equal(st.calls.length, 3);
  assert.equal(scheduler.state(st).nextDelayMs, 300_000);
  await clock.advance(299_000);
  assert.equal(st.calls.length, 3);
  await clock.advance(1_000); // poll 4 -> error; still 300 s
  assert.equal(st.calls.length, 4);
  assert.equal(scheduler.state(st).nextDelayMs, 300_000);
  await clock.advance(300_000); // poll 5 -> ok
  assert.equal(st.calls.length, 5);
  assert.equal(scheduler.state(st).errors, 0);
  assert.equal(scheduler.state(st).nextDelayMs, 60_000);
});

test('a 401 (fatal) stops the polling of that store', async () => {
  const { scheduler, clock } = setup();
  const st = fakeStore();
  st.results = [{ ok: false, kind: 'auth', fatal: true }];
  scheduler.register(st);
  await clock.advance(MIN);
  assert.equal(scheduler.state(st).fatal, true);
  await clock.advance(10 * MIN);
  assert.equal(st.calls.length, 1);
});

test('never two syncs of one store at once; a write while one runs queues exactly one more', async () => {
  const { scheduler, clock, win } = setup();
  const st = fakeStore();
  let release;
  st.hold = new Promise((r) => (release = r));
  scheduler.register(st);
  await clock.advance(MIN);
  assert.equal(st.calls.length, 1);
  win.fire('focus');
  scheduler.afterWrite(st);
  await clock.advance(DEFAULTS.writeDelayMs + 10);
  scheduler.afterWrite(st);
  await clock.advance(DEFAULTS.writeDelayMs + 10);
  assert.equal(st.calls.length, 1); // still the first one
  st.hold = null;
  release();
  await tick();
  assert.deepEqual(st.calls, ['poll', 'write']);
});

test('after each write: a sync soon, calls close together share one', async () => {
  const { scheduler, clock } = setup();
  const st = fakeStore();
  scheduler.register(st);
  scheduler.afterWrite(st);
  await clock.advance(100);
  scheduler.afterWrite(st);
  scheduler.afterWrite(st);
  await clock.advance(DEFAULTS.writeDelayMs - 1);
  assert.equal(st.calls.length, 0);
  await clock.advance(DEFAULTS.writeDelayMs);
  assert.deepEqual(st.calls, ['write']);
  scheduler.afterWrite({ sync() {} }); // an unregistered store is ignored
});

test('offline: nothing is synced and it does not count as an error', async () => {
  const { scheduler, clock, setOnline } = setup();
  const st = fakeStore();
  scheduler.register(st);
  setOnline(false);
  await clock.advance(3 * MIN);
  assert.equal(st.calls.length, 0);
  assert.equal(scheduler.state(st).errors, 0);
  setOnline(true);
  await clock.advance(MIN);
  assert.equal(st.calls.length, 1);
});

test('callbacks: aria-busy and data-sync are driven by callbacks, never by the global data-state', async () => {
  const { scheduler, clock } = setup();
  const st = fakeStore();
  const attrs = {};
  const el = (name) => ({
    setAttribute: (k, v) => (attrs[name + ':' + k] = v),
    removeAttribute: (k) => delete attrs[name + ':' + k],
  });
  const cb = domCallbacks({ listEl: el('list'), rootEl: el('root') });
  let release;
  st.hold = new Promise((r) => (release = r));
  scheduler.register(st, cb);
  assert.equal(attrs['root:data-sync'], 'idle');
  await clock.advance(MIN);
  assert.equal(attrs['list:aria-busy'], 'true');
  assert.equal(attrs['root:data-sync'], 'running');
  st.hold = null;
  release();
  await tick();
  assert.equal('list:aria-busy' in attrs, false);
  assert.equal(attrs['root:data-sync'], 'idle');
  st.results = [{ ok: false, kind: 'network' }];
  await clock.advance(MIN);
  assert.equal(attrs['root:data-sync'], 'error');
  assert.ok(!Object.keys(attrs).some((k) => k.includes('data-state')));
  // a throwing callback does not stop the scheduler
  scheduler.register(st, { onSync() { throw new Error('view bug'); } });
  await clock.advance(5 * MIN);
  assert.ok(st.calls.length >= 3);
  domCallbacks({}).onBusy(true); // no elements: harmless
});

test('sign-out: disposing the session stops every timer and listener, later triggers do nothing', async () => {
  const { scheduler, clock, session, doc, win } = setup();
  const st = fakeStore();
  scheduler.register(st);
  scheduler.afterWrite(st);
  assert.equal(doc.count('visibilitychange'), 1);
  assert.equal(win.count('focus'), 1);
  session.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(doc.count('visibilitychange'), 0);
  assert.equal(win.count('focus'), 0);
  assert.equal(scheduler.stopped, true);
  await clock.advance(10 * MIN);
  win.fire('focus');
  await tick();
  assert.equal(st.calls.length, 0);
  assert.equal(scheduler.register(st) instanceof Function, true);
  await clock.advance(10 * MIN);
  assert.equal(st.calls.length, 0);
});

test('a scheduler created after the session was disposed is inert', async () => {
  const clock = createClock();
  const session = createSession({ login: 'alice', storage: fakeStorage(), timers: clock });
  session.dispose();
  const scheduler = createScheduler({ session, doc: fakeDoc(), win: fakeTarget(), now: clock.now });
  const st = fakeStore();
  scheduler.register(st);
  await clock.advance(5 * MIN);
  assert.equal(st.calls.length, 0);
  assert.throws(() => createScheduler({}), TypeError);
});

test('re-registering a store replaces its callbacks and does not double the polling; syncNow ignores the age', async () => {
  const { scheduler, clock } = setup();
  const st = fakeStore();
  const seen = [];
  scheduler.register(st, { onSync: (s) => seen.push('a' + s) });
  scheduler.register(st, { onSync: (s) => seen.push('b' + s) });
  await clock.advance(MIN);
  assert.equal(st.calls.length, 1);
  assert.ok(seen.includes('brunning') && !seen.includes('arunning'));
  await scheduler.syncNow(st, 'retry');
  assert.deepEqual(st.calls, ['poll', 'retry']);
  assert.equal(scheduler.isRegistered(st), true);
  assert.equal(scheduler.unregister(st), true);
  assert.equal(scheduler.unregister(st), false);
  assert.equal(scheduler.state(st), null);
});
