// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js moveItem (RUN3 D-R3-5.3, addendum M5): copy the EXACT server text to the other calendar, verify, then
// delete the source with If-Match. A 412 at that DELETE removes the copy and returns the normal conflict ("nothing moved").
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAL_A, CAL_B, CAL_RO, CAL_TASKS, ConflictError, DavError, baseOf, calls, makeCalEnv, opsLog, single, task, unknownZone, weekly } from './_cal.mjs';

const SRC = CAL_A + 'lunch.ics';
const DST = CAL_B + 'lunch.ics';
const TEXT = single('lunch@example.org', 'Lunch', { extra: 'X-EXAMPLE-NOTE:kept verbatim\n' });
const move = (env, o = {}) => env.writes.moveItem({ from: CAL_A, to: CAL_B, href: SRC, base: baseOf(env, SRC), ...o });
const dels = (env) => calls(env, 'DELETE');
const puts = (env) => calls(env, 'PUT');

test('success: the exact text is PUT to the other calendar under the same file name, verified, then the source is deleted', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  const sent = env.server.at(SRC).text;
  env.server.calls.length = 0;
  const r = await move(env);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'moved');
  assert.equal(r.href, DST);
  assert.equal(env.server.at(DST).text, sent); // byte for byte (the fake re-serialises nothing)
  assert.equal(env.server.at(SRC), undefined);
  assert.deepEqual(env.server.calls.filter((c) => /^(PUT|DELETE) /.test(c)), ['PUT ' + DST, 'DELETE ' + SRC]);
  assert.equal(env.stores.get(CAL_A).has(SRC), false);
  assert.equal(env.stores.get(CAL_B).get(DST).text, sent);
  assert.match(env.server.at(DST).text, /X-EXAMPLE-NOTE:kept verbatim/);
  assert.deepEqual(opsLog(env).slice(0, 1), ['move:ok']);
  assert.equal(env.feedback.status.text, 'store.status.moved');
});

test('a tasks too', async () => {
  const href = CAL_A + 'todo.ics';
  const env = await makeCalEnv({ items: { [href]: task('t@example.org') } });
  const r = await env.writes.moveItem({ from: CAL_A, to: CAL_B, href, base: baseOf(env, href) });
  assert.equal(r.status, 'moved');
  assert.ok(env.server.at(CAL_B + 'todo.ics'));
});

test('the target already has that file name with DIFFERENT content: a uuid name is used', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT, [DST]: single('other@example.org', 'Another thing') } });
  const r = await move(env);
  assert.equal(r.status, 'moved');
  assert.notEqual(r.href, DST);
  assert.match(r.href, /^\/alice\/cal-b\/[0-9a-f-]{36}\.ics$/);
  assert.match(env.server.at(DST).text, /Another thing/); // untouched
  assert.equal(env.server.at(SRC), undefined);
});

test('the target name holds the SAME item already (an earlier attempt copied it): treated as copied, then the source is deleted', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT, [DST]: TEXT } });
  const r = await move(env);
  assert.equal(r.status, 'moved');
  assert.equal(r.href, DST);
  assert.equal(env.server.hrefsIn(CAL_B).length, 1);
  assert.equal(env.server.at(SRC), undefined);
});

test('the DELETE of the source fails (403): both are kept, persistent "both exist" alert, no retry', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.fail('DELETE', new DavError('forbidden', { status: 403 }));
  env.server.calls.length = 0;
  const r = await move(env);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'move-incomplete');
  assert.ok(env.server.at(SRC));
  assert.ok(env.server.at(DST));
  assert.equal(dels(env).length, 1); // no auto-retry
  assert.match(env.feedback.alert.text, /store\.err\.moveBothExist/);
  assert.ok(opsLog(env).includes('move:error'));
});

test('M5: 412 at the source DELETE (an outside PUT between copy and delete) -> the copy is deleted again, normal conflict, "nothing moved"', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  const base = baseOf(env, SRC);
  env.server.afterPut((href) => href === DST, () => env.server.outside(SRC, single('lunch@example.org', 'Lunch with Sam', { extra: 'X-EXAMPLE-NOTE:kept verbatim\n' })));
  env.server.calls.length = 0;
  const r = await env.writes.moveItem({ from: CAL_A, to: CAL_B, href: SRC, base });
  assert.equal(r.status, 'conflict');
  assert.equal(env.server.at(DST), undefined); // the copy is gone
  assert.match(env.server.at(SRC).text, /Lunch with Sam/); // the source is intact, with their change
  const del = dels(env);
  assert.deepEqual(del, ['DELETE ' + SRC, 'DELETE ' + DST]);
  assert.deepEqual(r.mine, { move: { to: CAL_B } });
  assert.equal(r.canCopy, false);
  assert.ok(r.rows.some((x) => x.field === 'summary'));
  assert.equal(env.stores.get(CAL_B).has(DST), false);
  // "Overwrite with mine" = move THEIR version
  const o = await env.writes.resolveOverwrite(r);
  assert.equal(o.status, 'moved');
  assert.match(env.server.at(DST).text, /Lunch with Sam/);
  assert.equal(env.server.at(SRC), undefined);
});

test('M5: 412 at the DELETE and the copy cannot be removed either: both-exist alert (never silent)', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.afterPut((href) => href === DST, () => env.server.outside(SRC, single('lunch@example.org', 'Changed')));
  env.server.fail('DELETE', new DavError('server', { status: 500 }), { when: (h) => h === DST });
  const r = await move(env);
  assert.equal(r.status, 'move-incomplete');
  assert.match(env.feedback.alert.text, /store\.err\.moveBothExist/);
});

test('the source is already gone (404 at the DELETE): the copy stands, the move is a success', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.afterPut((href) => href === DST, () => env.server.items.delete(SRC));
  const r = await move(env);
  assert.equal(r.status, 'moved');
  assert.ok(env.server.at(DST));
});

test('the DELETE response is lost but the source IS gone: success; if it is still there: both-exist alert', async () => {
  let env = await makeCalEnv({ items: { [SRC]: TEXT } });
  const del = env.server.client.deleteItem;
  env.server.client.deleteItem = async (...a) => {
    await del(...a);
    throw new DavError('network', { message: 'lost' });
  };
  assert.equal((await move(env)).status, 'moved');
  env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.fail('DELETE', new DavError('network', { message: 'down' }));
  const r = await move(env);
  assert.equal(r.status, 'move-incomplete');
});

test('a target that does not support the component is refused: no request', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.calls.length = 0;
  const r = await env.writes.moveItem({ from: CAL_A, to: CAL_TASKS, href: SRC, base: baseOf(env, SRC) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'not-allowed');
  assert.deepEqual(env.server.calls, []);
  // a task into an events-only calendar
  const t = CAL_A + 'todo.ics';
  const env2 = await makeCalEnv({ items: { [t]: task('t@example.org') } });
  const r2 = await env2.writes.moveItem({ from: CAL_A, to: CAL_RO, href: t, base: baseOf(env2, t) });
  assert.ok(['not-allowed', 'readonly'].includes(r2.status));
  assert.deepEqual(env2.server.calls.filter((c) => /^(PUT|DELETE) /.test(c)), []);
});

test('read-only target or source (needs readwrite on both): refused, no request', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT, '/bob/shared/x.ics': single('ro@example.org') } });
  env.server.calls.length = 0;
  const toRo = await env.writes.moveItem({ from: CAL_A, to: CAL_RO, href: SRC, base: baseOf(env, SRC) });
  assert.equal(toRo.status, 'readonly');
  const fromRo = await env.writes.moveItem({ from: CAL_RO, to: CAL_B, href: '/bob/shared/x.ics', base: baseOf(env, '/bob/shared/x.ics') });
  assert.equal(fromRo.status, 'readonly');
  assert.deepEqual(env.server.calls, []);
});

test('a read-only item (unknown time zone) and an unparseable item are refused', async () => {
  const mars = CAL_A + 'mars.ics';
  const env = await makeCalEnv({ items: { [mars]: unknownZone('mars@example.org') } });
  env.server.calls.length = 0;
  const r = await env.writes.moveItem({ from: CAL_A, to: CAL_B, href: mars, base: baseOf(env, mars) });
  assert.equal(r.status, 'readonly');
  const bad = await env.writes.moveItem({ from: CAL_A, to: CAL_B, href: mars, base: { text: 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n', etag: '"x"' } });
  assert.equal(bad.status, 'readonly');
  assert.deepEqual(env.server.calls, []);
});

test('a series moves as one resource (master and overrides together), same collection and missing base are refused', async () => {
  const href = CAL_A + 'series.ics';
  const env = await makeCalEnv({ items: { [href]: weekly('s@example.org', { exdates: ['20260316T093000'] }) } });
  const same = await env.writes.moveItem({ from: CAL_A, to: CAL_A, href, base: baseOf(env, href) });
  assert.equal(same.status, 'invalid');
  const nobase = await env.writes.moveItem({ from: CAL_A, to: CAL_B, href });
  assert.equal(nobase.reason, 'base-required');
  const r = await env.writes.moveItem({ from: CAL_A, to: CAL_B, href, base: baseOf(env, href) });
  assert.equal(r.status, 'moved');
  assert.match(env.server.at(CAL_B + 'series.ics').text, /EXDATE/);
});

test('the copy reads back differently: the copy is removed again, the original is NEVER deleted', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT }, transform: (t, href) => (href === DST ? t.replace('SUMMARY:Lunch', 'SUMMARY:Lunch!') : t) });
  env.server.calls.length = 0;
  const r = await move(env);
  assert.equal(r.status, 'copy-mismatch');
  assert.ok(env.server.at(SRC));
  assert.equal(env.server.at(DST), undefined);
  assert.deepEqual(dels(env), ['DELETE ' + DST]);
});

test('copy PUT fails (403 / network): nothing is deleted, nothing changed', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.fail('PUT', new DavError('forbidden', { status: 403 }));
  env.server.calls.length = 0;
  const r = await move(env);
  assert.equal(r.status, 'forbidden');
  assert.deepEqual(dels(env), []);
  assert.ok(env.server.at(SRC));
  env.server.fail('PUT', new DavError('network', { message: 'down' }));
  const r2 = await move(env);
  assert.equal(r2.status, 'unknown-result');
  assert.deepEqual(dels(env), []);
  assert.equal(puts(env).length, 2);
});

test('the copy cannot be read back: the original is kept and the user is told to check both', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  const get = env.server.client.getItem;
  env.server.client.getItem = async (href) => {
    if (href === DST) throw new DavError('network', { message: 'down' });
    return get(href);
  };
  env.server.calls.length = 0;
  const r = await move(env);
  assert.equal(r.status, 'copy-unverified');
  assert.deepEqual(dels(env), []);
  assert.match(env.feedback.alert.text, /store\.err\.moveUnverified/);
});

test('a 412 whose uid is taken elsewhere in the target (409) is "exists"', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.fail('PUT', new DavError('conflict', { status: 409 }));
  const r = await move(env);
  assert.equal(r.status, 'exists');
  assert.ok(ConflictError);
});

test('m6: the session ends after the copy was made -> the source is NOT deleted, status aborted', async () => {
  const env = await makeCalEnv({ items: { [SRC]: TEXT } });
  env.server.afterPut((href) => href.startsWith(CAL_B), () => env.session.dispose());
  env.server.calls.length = 0;
  const r = await move(env);
  assert.equal(r.status, 'aborted');
  assert.deepEqual(dels(env), []);
  assert.ok(env.server.at(SRC));
});
