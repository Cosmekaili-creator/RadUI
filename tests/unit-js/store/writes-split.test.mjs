// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js splitWrite (RUN3 D-R3-5.2, addendum C1 and m3): tail first, then the truncated original; the tail is deleted
// again ONLY when the PUT of the original is known not to have been applied. Never "future occurrences lost".
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAL_A, ConflictError, DavError, baseOf, calls, makeCalEnv, model, opsLog, override, paris, single, weekly } from './_cal.mjs';

const UID = 'series-1@example.org';
const H = CAL_A + 'series.ics';
const RID = paris('2026-03-23T09:30:00');
const split = (env, extra = {}) => env.writes.splitWrite({ collection: CAL_A, href: H, base: baseOf(env, H), rid: RID, ...extra });
const tails = (env) => env.server.hrefsIn(CAL_A).filter((h) => h !== H);
const openProj = (text) => model.openItem(text);
const dels = (env) => calls(env, 'DELETE');
const puts = (env) => calls(env, 'PUT');

test('success: the tail is created FIRST (If-None-Match), then the original is truncated (If-Match); two resources, one series', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.calls.length = 0;
  const r = await split(env, { tailFields: { summary: 'Weekly sync (new rule)' } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'saved');
  assert.equal(r.verified, true);
  const order = env.server.calls.filter((c) => c.startsWith('PUT '));
  assert.equal(order.length, 2);
  assert.notEqual(order[0], 'PUT ' + H); // the tail first
  assert.equal(order[1], 'PUT ' + H);
  const [tailHref] = tails(env);
  assert.equal(tailHref, r.tailHref);
  assert.match(env.server.at(H).text, /RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=/);
  assert.doesNotMatch(env.server.at(H).text, /COUNT=/);
  const tail = env.server.at(tailHref).text;
  assert.match(tail, /DTSTART;TZID=Europe\/Paris:20260323T093000/);
  assert.match(tail, /COUNT=5/); // 8 occurrences, 3 stay on the original
  assert.match(tail, /SUMMARY:Weekly sync \(new rule\)/);
  assert.notEqual(openProj(tail).uid, openProj(env.server.at(H).text).uid);
  assert.equal(dels(env).length, 0);
  assert.equal(env.stores.get(CAL_A).get(tailHref).text, tail); // both are in the store
  assert.deepEqual(opsLog(env).slice(0, 1), ['split:ok']);
});

test('later EXDATEs and overrides move to the tail; the original keeps only the earlier ones', async () => {
  const text = weekly(UID, { exdates: ['20260309T093000', '20260406T093000'], overrides: override(UID, '20260330T093000', { start: '20260330T150000', end: '20260330T160000' }) });
  const env = await makeCalEnv({ items: { [H]: text } });
  const r = await split(env);
  assert.equal(r.ok, true);
  const head = env.server.at(H).text;
  const tail = env.server.at(r.tailHref).text;
  assert.match(head, /EXDATE;TZID=Europe\/Paris:20260309T093000/);
  assert.doesNotMatch(head, /20260406T093000|RECURRENCE-ID/);
  assert.match(tail, /EXDATE;TZID=Europe\/Paris:20260406T093000/);
  assert.match(tail, /RECURRENCE-ID;TZID=Europe\/Paris:20260330T093000/);
});

test('(b) fails: nothing was changed (no PUT of the original, no DELETE)', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const before = env.server.at(H).text;
  env.server.fail('PUT', new DavError('forbidden', { status: 403 }));
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'forbidden');
  assert.equal(puts(env).length, 1);
  assert.equal(dels(env).length, 0);
  assert.equal(env.server.at(H).text, before);
  assert.deepEqual(tails(env), []);
});

test('(b) network error but the tail exists: the split goes on from that tail', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.loseResponse((href, opts) => opts && opts.create);
  const r = await split(env);
  assert.equal(r.ok, true);
  assert.equal(tails(env).length, 1);
  assert.match(env.server.at(H).text, /UNTIL=/);
});

test('(b) network error and no tail: nothing changed, no DELETE', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.fail('PUT', new DavError('network', { message: 'down' }));
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.status, 'unknown-result');
  assert.equal(dels(env).length, 0);
  assert.deepEqual(tails(env), []);
  assert.doesNotMatch(env.server.at(H).text, /UNTIL/);
});

test('412 at (c): the compensating DELETE of the tail (If-Match tail ETag) is made, the result is a conflict, the server holds exactly the other client\'s version', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const base = baseOf(env, H);
  env.server.afterPut((href, opts) => opts && opts.create, () => env.server.outside(H, weekly(UID, { summary: 'Weekly sync v2' })));
  env.server.calls.length = 0;
  const r = await env.writes.splitWrite({ collection: CAL_A, href: H, base, rid: RID });
  assert.equal(r.status, 'conflict');
  assert.equal(dels(env).length, 1);
  assert.notEqual(dels(env)[0], 'DELETE ' + H);
  assert.deepEqual(tails(env), []); // the tail is gone again
  assert.match(env.server.at(H).text, /SUMMARY:Weekly sync v2/);
  assert.doesNotMatch(env.server.at(H).text, /UNTIL/);
  assert.deepEqual(r.mine.split.rid, RID);
  assert.equal(r.canOverwrite, true);
  assert.equal(r.canCopy, false);
  // Overwrite replays the split on theirs
  const o = await env.writes.resolveOverwrite(r);
  assert.equal(o.ok, true);
  assert.equal(tails(env).length, 1);
  assert.match(env.server.at(H).text, /SUMMARY:Weekly sync v2/);
  assert.match(env.server.at(H).text, /UNTIL=/);
  assert.match(env.server.at(tails(env)[0]).text, /SUMMARY:Weekly sync v2/);
});

test('403 / 413 / 404 at (c) also compensate (the PUT is known not applied)', async () => {
  for (const [kind, status] of [['forbidden', 403], ['toolarge', 413], ['notfound', 404]]) {
    const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
    env.server.fail('PUT', new DavError(kind, { status }), { when: (h) => h === H });
    env.server.calls.length = 0;
    const r = await split(env);
    assert.equal(r.ok, false, kind);
    assert.equal(dels(env).length, 1, kind);
    assert.deepEqual(tails(env), [], kind);
  }
});

test('compensation fails too: persistent alert naming BOTH resources, Activity split error, nothing else deleted', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.fail('PUT', new ConflictError({ status: 412, href: H, sentEtag: 'x' }), { when: (h) => h === H });
  env.server.fail('DELETE', new DavError('server', { status: 500 }));
  const r = await split(env);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'split-incomplete');
  assert.match(env.feedback.alert.text, /store\.err\.splitCompensation/);
  assert.match(env.feedback.alert.text, /series\.ics/);
  assert.match(env.feedback.alert.text, new RegExp(r.tailHref.split('/').pop().replace('.', '\\.')));
  assert.ok(opsLog(env).includes('split:error'));
  assert.equal(tails(env).length, 1); // the tail is still there: reported, never hidden
});

test('C1: network loss at (c) WITH the server having applied it -> the tail is KEPT, no DELETE is sent, the split is a success', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.loseResponse((href) => href === H);
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'saved');
  assert.equal(dels(env).length, 0);
  assert.equal(tails(env).length, 1);
  assert.match(env.server.at(H).text, /UNTIL=/);
});

test('C1: network loss at (c) with the server NOT having applied it -> GET shows the original, the tail is compensated, result unknown', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.fail('PUT', new DavError('network', { message: 'down' }), { when: (h) => h === H });
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unknown-result');
  assert.equal(dels(env).length, 1);
  assert.deepEqual(tails(env), []);
  assert.doesNotMatch(env.server.at(H).text, /UNTIL/);
});

test('C1: a 502 at (c) with the server having applied it behaves like a lost response: tail kept, no DELETE', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.loseResponse((href) => href === H, () => new DavError('server', { status: 502 }));
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.ok, true);
  assert.equal(dels(env).length, 0);
  assert.equal(tails(env).length, 1);
});

test('C1: network loss at (c) and the GET of the original fails too -> delete NOTHING, persistent "result unknown" naming both hrefs', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.loseResponse((href) => href === H);
  // the read-back of the tail happens before (c); make every later GET of the original fail
  const get = env.server.client.getItem;
  let armed = false;
  env.server.client.getItem = async (href) => {
    if (armed && href === H) throw new DavError('network', { message: 'down' });
    return get(href);
  };
  const put = env.server.client.putItem;
  env.server.client.putItem = async (href, text, opts) => {
    if (href === H) armed = true;
    return put(href, text, opts);
  };
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unknown-result');
  assert.equal(dels(env).length, 0);
  assert.equal(tails(env).length, 1);
  assert.match(env.feedback.alert.text, /store\.err\.splitUnknown/);
  assert.match(env.feedback.alert.text, /series\.ics/);
  assert.ok(opsLog(env).includes('split:error'));
});

test('C1: network loss at (c) and somebody else changed the original meanwhile (not base, not truncated) -> delete NOTHING, result unknown', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  env.server.fail('PUT', new DavError('network', { message: 'down' }), { when: (h) => h === H });
  env.server.afterPut((href, opts) => opts && opts.create, () => env.server.outside(H, weekly(UID, { summary: 'Weekly sync v3' })));
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.status, 'unknown-result');
  assert.equal(dels(env).length, 0);
  assert.equal(tails(env).length, 1);
  assert.match(env.feedback.alert.text, /store\.err\.splitUnknown/);
});

test('m3: the tail read back differs from what was sent -> stop, the tail is compensated (original untouched), reported', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) }, transform: (t, href) => (href === H ? t : t.replace('SUMMARY:Weekly sync', 'SUMMARY:Garbled')) });
  const before = env.server.at(H).text;
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'tail-mismatch');
  assert.ok(r.mismatched.includes('summary'));
  assert.equal(puts(env).filter((c) => c === 'PUT ' + H).length, 0); // the original was never touched
  assert.equal(dels(env).length, 1);
  assert.deepEqual(tails(env), []);
  assert.equal(env.server.at(H).text, before);
  assert.match(env.feedback.alert.text, /store\.err\.verify/);
});

test('m3: the tail GET fails -> the PUT ETag is used and the split goes on', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const get = env.server.client.getItem;
  let first = true;
  env.server.client.getItem = async (href) => {
    if (href !== H && first) {
      first = false;
      throw new DavError('network', { message: 'down' });
    }
    return get(href);
  };
  const r = await split(env);
  assert.equal(r.ok, true);
  assert.equal(tails(env).length, 1);
});

test('refused: a single event, the first occurrence -> nothing is sent', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID), [CAL_A + 's.ics']: single('s@example.org') } });
  env.server.calls.length = 0;
  const one = await env.writes.splitWrite({ collection: CAL_A, href: CAL_A + 's.ics', base: baseOf(env, CAL_A + 's.ics'), rid: paris('2026-06-04T12:00:00') });
  assert.equal(one.status, 'invalid');
  const first = await env.writes.splitWrite({ collection: CAL_A, href: H, base: baseOf(env, H), rid: paris('2026-03-02T09:30:00') });
  assert.equal(first.status, 'invalid');
  assert.deepEqual(puts(env), []);
  assert.deepEqual(dels(env), []);
});

test('m3: the rule changed elsewhere (BYDAY) so the occurrence no longer exists -> the row is unmappable, Overwrite is refused, nothing is cut', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const base = baseOf(env, H);
  // the 23 March Monday is no longer produced: the series now runs on Tuesdays
  env.server.afterPut((href, opts) => opts && opts.create, () => env.server.outside(H, weekly(UID, { rrule: 'FREQ=WEEKLY;COUNT=8;BYDAY=TU' })));
  const c = await env.writes.splitWrite({ collection: CAL_A, href: H, base, rid: RID });
  assert.equal(c.status, 'conflict');
  assert.equal(c.canOverwrite, false);
  assert.equal(c.unmappable.length, 1);
  assert.match(c.unmappable[0].reason, /occurrence-not-found/);
  env.server.calls.length = 0;
  const o = await env.writes.resolveOverwrite(c);
  assert.equal(o.ok, false);
  assert.deepEqual(puts(env), []);
  assert.doesNotMatch(env.server.at(H).text, /UNTIL/);
  assert.deepEqual(tails(env), []);
});

test('m6: the session ends after the tail was created -> the original is NOT touched, no further request, status aborted', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const before = env.server.at(H).text;
  env.server.afterPut((href, opts) => opts && opts.create, () => env.session.dispose());
  env.server.calls.length = 0;
  const r = await split(env);
  assert.equal(r.status, 'aborted');
  assert.equal(r.ok, false);
  assert.equal(puts(env).length, 1); // only the tail
  assert.equal(env.server.at(H).text, before);
  assert.deepEqual(dels(env), []);
});

test('m6: a session that already ended sends nothing at all', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const base = baseOf(env, H);
  env.session.dispose();
  env.server.calls.length = 0;
  const r = await env.writes.splitWrite({ collection: CAL_A, href: H, base, rid: RID });
  assert.equal(r.status, 'aborted');
  assert.deepEqual(puts(env), []);
});
