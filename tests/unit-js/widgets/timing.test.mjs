// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { debounce, createAnnouncer } from '../../../src/js/widgets/timing.js';
import { fakeTimers } from './_dom.mjs';

test('debounce runs once, after the last call, with the last arguments', () => {
  const timers = fakeTimers();
  const seen = [];
  const d = debounce((x) => seen.push(x), 100, timers);
  d('a');
  timers.advance(60);
  d('b');
  timers.advance(60);
  assert.deepEqual(seen, []);
  assert.equal(d.pending, true);
  timers.advance(40);
  assert.deepEqual(seen, ['b']);
  assert.equal(d.pending, false);
});

test('debounce flush runs the pending call now; cancel drops it', () => {
  const timers = fakeTimers();
  const seen = [];
  const d = debounce((x) => seen.push(x), 100, timers);
  d('a');
  d.flush();
  assert.deepEqual(seen, ['a']);
  d.flush(); // nothing pending: no second call
  assert.deepEqual(seen, ['a']);
  d('b');
  d.cancel();
  timers.advance(500);
  assert.deepEqual(seen, ['a']);
});

test('announcer applies at most once per interval with the latest text', () => {
  const timers = fakeTimers();
  const said = [];
  const a = createAnnouncer({ apply: (s) => said.push(s), ms: 1000, timers });
  a.push('1 of 10');
  a.push('2 of 10');
  a.push('3 of 10');
  assert.deepEqual(said, []);
  timers.advance(1000);
  assert.deepEqual(said, ['3 of 10']);
  a.push('4 of 10');
  timers.advance(999);
  assert.deepEqual(said, ['3 of 10']);
  timers.advance(1);
  assert.deepEqual(said, ['3 of 10', '4 of 10']);
});

test('announcer flush announces the final text at once and drops the waiting one', () => {
  const timers = fakeTimers();
  const said = [];
  const a = createAnnouncer({ apply: (s) => said.push(s), ms: 1000, timers });
  a.push('5 of 10');
  a.flush('Done.');
  assert.deepEqual(said, ['Done.']);
  timers.advance(5000);
  assert.deepEqual(said, ['Done.']);
  a.flush('Done.'); // the same text is not repeated
  assert.deepEqual(said, ['Done.']);
});

test('announcer does not repeat an identical text and can be cancelled', () => {
  const timers = fakeTimers();
  const said = [];
  const a = createAnnouncer({ apply: (s) => said.push(s), ms: 10, timers });
  a.push('x');
  timers.advance(10);
  a.push('x');
  timers.advance(10);
  assert.deepEqual(said, ['x']);
  a.push('y');
  a.cancel();
  timers.advance(100);
  assert.deepEqual(said, ['x']);
});
