// SPDX-License-Identifier: AGPL-3.0-or-later
// store/calendars.js (RUN3 D-R3-5.6): enable/disable create and dispose stores, only enabled stores are polled,
// occurrences merge across calendars, parse cache per ETag, per-item limit, disposal with the session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendars } from '../../../src/js/store/calendars.js';
import { CAL_A, CAL_B, baseOf, makeCalEnv, model, single, task, weekly } from './_cal.mjs';

const A1 = CAL_A + 'one.ics';
const B1 = CAL_B + 'two.ics';
const TK = CAL_A + 'todo.ics';
const W = CAL_A + 'weekly.ics';
const day = (iso) => Date.parse(iso + 'T00:00:00Z');

async function setup(items) {
  const env = await makeCalEnv({ items, load: false });
  const cals = createCalendars({ stores: env.stores, scheduler: env.scheduler, session: env.session, model });
  return { env, cals };
}

test('enable creates the store and starts polling; disable disposes it; only enabled stores are polled', async () => {
  const { env, cals } = await setup({ [A1]: single('a@example.org'), [B1]: single('b@example.org', 'Other') });
  const a = cals.enable({ href: CAL_A, kind: 'calendar' });
  assert.equal(cals.isEnabled(CAL_A), true);
  assert.equal(cals.isEnabled(CAL_B), false);
  assert.equal(a, env.stores.get(CAL_A));
  await env.clock.advance(61_000); // one poll interval
  assert.ok(env.stores.get(CAL_A).syncCount >= 1);
  assert.equal(env.stores.get(CAL_B).syncCount, 0); // not enabled: never polled
  assert.equal(env.stores.get(CAL_A).has(A1), true);
  cals.disable(CAL_A);
  assert.equal(a.disposed, true);
  assert.equal(env.stores.get(CAL_A), null);
  assert.deepEqual(cals.enabledHrefs(), []);
  const n = env.server.callsOf('SYNC').length;
  await env.clock.advance(300_000);
  assert.equal(env.server.callsOf('SYNC').length, n); // nothing polls a disabled calendar
});

test('enable is idempotent; setEnabled makes the set exactly the list', async () => {
  const { env, cals } = await setup({});
  const a1 = cals.enable({ href: CAL_A, kind: 'calendar' });
  assert.equal(cals.enable({ href: CAL_A, kind: 'calendar' }), a1);
  cals.setEnabled([{ href: CAL_B, kind: 'calendar' }]);
  assert.deepEqual(cals.enabledHrefs(), [CAL_B]);
  assert.equal(env.stores.get(CAL_A), null);
  assert.equal(cals.disable(CAL_A), false);
});

test('events: a toggle and every store event are forwarded', async () => {
  const { cals } = await setup({ [A1]: single('a@example.org') });
  const seen = [];
  cals.subscribe((ev) => seen.push(`${ev.type}:${ev.collection}`));
  const store = cals.enable({ href: CAL_A, kind: 'calendar' });
  await store.sync({ reason: 'test' });
  cals.disable(CAL_A);
  assert.ok(seen.includes(`toggle:${CAL_A}`));
  assert.ok(seen.includes(`sync:${CAL_A}`));
  assert.equal(seen.filter((s) => s.startsWith('toggle')).length, 2);
});

test('occurrences merge the enabled calendars in start order and carry collection, href, etag and uid; tasks are not occurrences', async () => {
  const { cals } = await setup({
    [A1]: single('a@example.org', 'Lunch', { start: '20260604T120000', end: '20260604T130000' }),
    [B1]: single('b@example.org', 'Breakfast', { start: '20260604T080000', end: '20260604T090000' }),
    [TK]: task('t@example.org'),
  });
  for (const c of [CAL_A, CAL_B]) await cals.enable({ href: c, kind: 'calendar' }).sync({ reason: 'test' });
  const r = cals.occurrences(day('2026-06-01'), day('2026-06-08'));
  assert.deepEqual(r.occurrences.map((o) => o.href), [B1, A1]);
  assert.deepEqual([r.occurrences[0].collection, r.occurrences[0].uid], [CAL_B, 'b@example.org']);
  assert.ok(r.occurrences[0].etag);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.unreadable, []);
  // outside the window: nothing
  assert.equal(cals.occurrences(day('2026-07-01'), day('2026-07-08')).occurrences.length, 0);
  // a disabled calendar disappears from the merge
  cals.disable(CAL_B);
  assert.deepEqual(cals.occurrences(day('2026-06-01'), day('2026-06-08')).occurrences.map((o) => o.href), [A1]);
  // tasks are reachable through entries()
  assert.deepEqual(cals.entries({ kind: 'task' }).entries.map((e) => e.href), [TK]);
});

test('the per-item limit is applied and flagged; unreadable items are listed, never thrown', async () => {
  const bad = CAL_A + 'broken.ics';
  const { cals } = await setup({ [W]: weekly('w@example.org', { count: 50 }), [bad]: 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n' });
  await cals.enable({ href: CAL_A, kind: 'calendar' }).sync({ reason: 'test' });
  const r = cals.occurrences(day('2026-03-01'), day('2027-03-01'), { limit: 10 });
  assert.equal(r.occurrences.length, 10);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.unreadable.map((u) => u.href), [bad]);
});

test('parse cache: one parse per href + ETag; a new ETag replaces it', async () => {
  let opens = 0;
  const counting = { openItem: (t) => (opens++, model.openItem(t)) };
  const env = await makeCalEnv({ items: { [A1]: single('a@example.org') }, load: false });
  const cals = createCalendars({ stores: env.stores, scheduler: env.scheduler, session: env.session, model: counting });
  await cals.enable({ href: CAL_A, kind: 'calendar' }).sync({ reason: 'test' });
  cals.occurrences(day('2026-06-01'), day('2026-06-08'));
  cals.occurrences(day('2026-06-01'), day('2026-06-08'));
  cals.occurrences(day('2026-05-01'), day('2026-07-08'));
  assert.equal(opens, 1);
  const r = await env.writes.applyOps({ collection: CAL_A, href: A1, base: baseOf(env, A1), ops: [{ type: 'patch', fields: { summary: 'Changed' } }] });
  assert.equal(r.ok, true);
  const again = cals.occurrences(day('2026-06-01'), day('2026-06-08'));
  assert.equal(opens, 2);
  assert.equal(again.occurrences.length, 1);
});

test('the model is loaded lazily: before it is there occurrences() answers loading', async () => {
  const env = await makeCalEnv({ items: {}, load: false });
  const cals = createCalendars({ stores: env.stores, scheduler: env.scheduler, session: env.session });
  const r = cals.occurrences(0, 1);
  assert.equal(r.loading, true);
  await cals.ready();
  assert.equal(cals.occurrences(0, 1).loading, false);
});

test('disposing the session disposes every store and stops the polling', async () => {
  const { env, cals } = await setup({ [A1]: single('a@example.org') });
  const a = cals.enable({ href: CAL_A, kind: 'calendar' });
  env.session.dispose();
  assert.equal(a.disposed, true);
  assert.deepEqual(cals.enabledHrefs(), []);
  assert.equal(cals.enable({ href: CAL_B, kind: 'calendar' }), null);
});
