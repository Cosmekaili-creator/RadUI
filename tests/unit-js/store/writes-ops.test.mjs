// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js applyOps (RUN3 D-R3-5.1): every operation type, no request when unchanged, replay on theirs after a
// 412, unmappable replays (addendum M4 double-shift refusal), verification, saveItem routing, createItem retry (m2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAL_A, CAL_B, ConflictError, DavError, baseOf, calls, makeCalEnv, model, opsLog, override, paris, single, task, unknownZone, weekly } from './_cal.mjs';

const UID = 'series-1@example.org';
const H = CAL_A + 'series.ics';
const S = CAL_A + 'single.ics';
const T = CAL_A + 'task.ics';
const run = (env, href, ops, extra = {}) => env.writes.applyOps({ collection: CAL_A, href, base: baseOf(env, href), ops, ...extra });
const server = (env, href) => env.server.at(href).text;

test('patch: master fields, PUT with If-Match of the base, re-GET, store holds the server text', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  const etag = baseOf(env, S).etag;
  env.server.calls.length = 0;
  const r = await run(env, S, [{ type: 'patch', fields: { summary: 'Brunch', location: 'Cafe Example' } }]);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'saved');
  assert.equal(r.verified, true);
  assert.equal(calls(env, 'PUT').length, 1);
  assert.match(server(env, S), /SUMMARY:Brunch/);
  assert.match(server(env, S), /LOCATION:Cafe Example/);
  assert.notEqual(env.stores.get(CAL_A).get(S).etag, etag);
  assert.equal(env.stores.get(CAL_A).get(S).text, server(env, S));
  assert.deepEqual(opsLog(env).slice(0, 1), ['update:ok']);
});

test('no change: no request at all', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  env.server.calls.length = 0;
  const r = await run(env, S, [{ type: 'patch', fields: { summary: 'Lunch' } }]);
  assert.deepEqual([r.ok, r.status, r.changed], [true, 'unchanged', false]);
  assert.deepEqual(env.server.calls, []);
});

test('override: creates the override inside the same resource, master untouched', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const r = await run(env, H, [{ type: 'override', rid: paris('2026-03-09T09:30:00'), fields: { summary: 'Moved sync', start: paris('2026-03-09T14:00:00'), end: paris('2026-03-09T15:00:00') } }]);
  assert.equal(r.status, 'saved');
  assert.equal(r.verified, true);
  const text = server(env, H);
  assert.match(text, /RECURRENCE-ID;TZID=Europe\/Paris:20260309T093000/);
  assert.match(text, /SUMMARY:Moved sync/);
  assert.match(text, /SUMMARY:Weekly sync/);
  assert.equal(env.server.hrefsIn(CAL_A).length, 1);
});

test('deleteOccurrence adds an EXDATE; removeExdate takes it back; removeOverride returns the occurrence to the series', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const rid = paris('2026-03-16T09:30:00');
  assert.equal((await run(env, H, [{ type: 'deleteOccurrence', rid }])).status, 'saved');
  assert.match(server(env, H), /EXDATE;TZID=Europe\/Paris:20260316T093000/);
  assert.equal((await run(env, H, [{ type: 'removeExdate', rid }])).status, 'saved');
  assert.doesNotMatch(server(env, H), /EXDATE/);
  const rid2 = paris('2026-03-23T09:30:00');
  await run(env, H, [{ type: 'override', rid: rid2, fields: { summary: 'Changed' } }]);
  assert.match(server(env, H), /RECURRENCE-ID/);
  assert.equal((await run(env, H, [{ type: 'removeOverride', rid: rid2 }])).status, 'saved');
  assert.doesNotMatch(server(env, H), /RECURRENCE-ID/);
  // restoring something that is not deleted is "no change", no request
  env.server.calls.length = 0;
  const again = await run(env, H, [{ type: 'removeExdate', rid }]);
  assert.equal(again.status, 'unchanged');
  assert.deepEqual(env.server.calls, []);
});

test('truncate: the series ends before the occurrence (COUNT becomes UNTIL), later EXDATE and overrides go with it; ONE PUT', async () => {
  const text = weekly(UID, { exdates: ['20260330T093000'], overrides: override(UID, '20260406T093000', { start: '20260406T150000', end: '20260406T160000' }) });
  const env = await makeCalEnv({ items: { [H]: text } });
  env.server.calls.length = 0;
  const r = await run(env, H, [{ type: 'truncate', rid: paris('2026-03-23T09:30:00') }]);
  assert.equal(r.status, 'saved');
  assert.equal(calls(env, 'PUT').length, 1);
  const out = server(env, H);
  assert.match(out, /RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=/);
  assert.doesNotMatch(out, /COUNT=/);
  assert.doesNotMatch(out, /EXDATE/);
  assert.doesNotMatch(out, /RECURRENCE-ID/);
  assert.deepEqual(opsLog(env).slice(0, 1), ['truncate:ok']);
});

test('shiftExceptions then patch start: EXDATE and RECURRENCE-ID follow the series, the override keeps its own times', async () => {
  const text = weekly(UID, { exdates: ['20260316T093000'], overrides: override(UID, '20260330T093000', { start: '20260330T150000', end: '20260330T160000' }) });
  const env = await makeCalEnv({ items: { [H]: text } });
  const ops = [
    { type: 'shiftExceptions', fromStart: paris('2026-03-02T09:30:00'), toStart: paris('2026-03-02T10:30:00') },
    { type: 'patch', fields: { start: paris('2026-03-02T10:30:00'), end: paris('2026-03-02T11:30:00') } },
  ];
  const r = await run(env, H, ops);
  assert.equal(r.status, 'saved');
  assert.equal(r.verified, true);
  const out = server(env, H);
  assert.match(out, /DTSTART;TZID=Europe\/Paris:20260302T103000/);
  assert.match(out, /EXDATE;TZID=Europe\/Paris:20260316T103000/);
  assert.match(out, /RECURRENCE-ID;TZID=Europe\/Paris:20260330T103000/);
  assert.match(out, /DTSTART;TZID=Europe\/Paris:20260330T150000/); // the override's own start stays where the user put it
});

test('M4 double-shift refusal: the same shift sent again against the shifted series is refused, nothing is sent', async () => {
  const text = weekly(UID, { exdates: ['20260316T093000'] });
  const env = await makeCalEnv({ items: { [H]: text } });
  const shift = { type: 'shiftExceptions', fromStart: paris('2026-03-02T09:30:00'), toStart: paris('2026-03-02T10:30:00') };
  const patch = { type: 'patch', fields: { start: paris('2026-03-02T10:30:00'), end: paris('2026-03-02T11:30:00') } };
  assert.equal((await run(env, H, [shift, patch])).status, 'saved');
  env.server.calls.length = 0;
  const again = await run(env, H, [shift, patch]); // base is the shifted series now: its start is no longer fromStart
  assert.equal(again.ok, false);
  assert.equal(again.status, 'invalid');
  assert.deepEqual(calls(env, 'PUT'), []);
  assert.match(server(env, H), /EXDATE;TZID=Europe\/Paris:20260316T103000/); // not shifted twice
});

test('M4 in a conflict: an outside change of the start makes the shift unmappable and Overwrite is disabled and refused', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID, { exdates: ['20260316T093000'] }) } });
  const base = baseOf(env, H);
  env.server.outside(H, weekly(UID, { exdates: ['20260316T093000'] }).replace('20260302T093000', '20260302T080000').replace('20260302T103000', '20260302T090000'));
  const ops = [
    { type: 'shiftExceptions', fromStart: paris('2026-03-02T09:30:00'), toStart: paris('2026-03-02T10:30:00') },
    { type: 'patch', fields: { start: paris('2026-03-02T10:30:00'), end: paris('2026-03-02T11:30:00') } },
  ];
  const c = await env.writes.applyOps({ collection: CAL_A, href: H, base, ops });
  assert.equal(c.status, 'conflict');
  assert.equal(c.canOverwrite, false);
  assert.equal(c.unmappable.length, 1);
  assert.deepEqual([c.unmappable[0].field, c.unmappable[0].op, c.unmappable[0].reason], ['shiftExceptions', 'replay', 'start-mismatch']);
  env.server.calls.length = 0;
  const o = await env.writes.resolveOverwrite(c);
  assert.equal(o.ok, false);
  assert.equal(o.status, 'not-allowed');
  assert.deepEqual(calls(env, 'PUT'), []);
});

test('complete and reopen (tasks): STATUS, COMPLETED, PERCENT-COMPLETE and back; Activity names the operation', async () => {
  const env = await makeCalEnv({ items: { [T]: task('t1@example.org') } });
  const done = await run(env, T, [{ type: 'complete' }]);
  assert.equal(done.status, 'saved');
  assert.equal(done.verified, true);
  assert.match(server(env, T), /STATUS:COMPLETED/);
  assert.match(server(env, T), /COMPLETED:20260601T100000Z/);
  assert.match(server(env, T), /PERCENT-COMPLETE:100/);
  const back = await run(env, T, [{ type: 'reopen' }]);
  assert.equal(back.status, 'saved');
  assert.match(server(env, T), /STATUS:NEEDS-ACTION/);
  assert.doesNotMatch(server(env, T), /COMPLETED:/);
  assert.deepEqual(opsLog(env).slice(0, 2), ['reopen:ok', 'complete:ok']);
});

test('a patch is data: a 412 returns a conflict with rows; Overwrite replays the SAME operations on theirs', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  const base = baseOf(env, S);
  env.server.outside(S, single('one@example.org', 'Lunch', { extra: 'LOCATION:Their place\n' }));
  const ops = [{ type: 'patch', fields: { summary: 'Brunch' } }];
  const c = await env.writes.applyOps({ collection: CAL_A, href: S, base, ops });
  assert.equal(c.status, 'conflict');
  assert.equal(c.canOverwrite, true);
  assert.equal(c.canCopy, true);
  assert.deepEqual(c.mine.ops, ops);
  const fields = c.rows.map((r) => r.field);
  assert.ok(fields.includes('summary'));
  assert.ok(fields.includes('location'));
  const o = await env.writes.resolveOverwrite(c);
  assert.equal(o.ok, true);
  assert.match(server(env, S), /SUMMARY:Brunch/);
  assert.match(server(env, S), /LOCATION:Their place/); // their change kept
  assert.equal(env.feedback.status.text, 'store.status.overwritten');
});

test('conflict rows name the occurrence an override targets', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const base = baseOf(env, H);
  env.server.outside(H, weekly(UID, { summary: 'Weekly sync v2' }));
  const rid = paris('2026-03-09T09:30:00');
  const c = await env.writes.applyOps({ collection: CAL_A, href: H, base, ops: [{ type: 'override', rid, fields: { summary: 'Only this one' } }] });
  assert.equal(c.status, 'conflict');
  assert.equal(c.canCopy, false); // a series is never saved as a copy
  const occ = c.rows.filter((r) => r.occurrence);
  assert.ok(occ.length >= 1);
  assert.equal(occ[0].occurrence, '2026-03-09T09:30:00');
  assert.equal(occ[0].field, 'summary');
  const o = await env.writes.resolveOverwrite(c);
  assert.equal(o.ok, true);
  assert.match(server(env, H), /SUMMARY:Weekly sync v2/);
  assert.match(server(env, H), /SUMMARY:Only this one/);
});

test('replay that throws: their version is all-day now, so the timed occurrence cannot be mapped -> unmappable row, Overwrite disabled, nothing sent', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const base = baseOf(env, H);
  env.server.outside(H, weekly(UID).replace('DTSTART;TZID=Europe/Paris:20260302T093000', 'DTSTART;VALUE=DATE:20260302').replace('DTEND;TZID=Europe/Paris:20260302T103000', 'DTEND;VALUE=DATE:20260303'));
  const c = await env.writes.applyOps({ collection: CAL_A, href: H, base, ops: [{ type: 'override', rid: paris('2026-03-09T09:30:00'), fields: { summary: 'Only this one' } }] });
  assert.equal(c.status, 'conflict');
  assert.equal(c.canOverwrite, false);
  assert.deepEqual([c.unmappable[0].field, c.unmappable[0].op], ['override', 'replay']);
  env.server.calls.length = 0;
  const o = await env.writes.resolveOverwrite(c);
  assert.equal(o.status, 'not-allowed');
  assert.deepEqual(calls(env, 'PUT'), []);
});

test('REGRESSION (found by the real-server integration test): an override of an occurrence they deleted meanwhile is unmappable, never brought back', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const base = baseOf(env, H);
  env.server.outside(H, weekly(UID, { exdates: ['20260316T093000'] })); // they deleted 16 March
  const ops = [{ type: 'override', rid: paris('2026-03-16T09:30:00'), fields: { summary: 'Too late' } }];
  const c = await env.writes.applyOps({ collection: CAL_A, href: H, base, ops });
  assert.equal(c.status, 'conflict');
  assert.equal(c.canOverwrite, false);
  assert.deepEqual([c.unmappable[0].field, c.unmappable[0].op, c.unmappable[0].reason], ['override', 'replay', 'occurrence-not-found']);
  env.server.calls.length = 0;
  const o = await env.writes.resolveOverwrite(c, { confirmUnmappable: true });
  assert.equal(o.status, 'not-allowed');
  assert.deepEqual(calls(env, 'PUT'), []);
  assert.doesNotMatch(server(env, H), /Too late/);
  // the same for a delete and a truncate of an occurrence that is gone, and for an occurrence the rule no longer yields
  for (const op of [{ type: 'deleteOccurrence', rid: paris('2026-03-16T09:30:00') }, { type: 'truncate', rid: paris('2026-03-16T09:30:00') }, { type: 'override', rid: paris('2026-03-10T09:30:00'), fields: { summary: 'x' } }]) {
    const item = model.openItem(weekly(UID, { exdates: ['20260316T093000'] }), 'event');
    const lib = await import('../../../src/js/model/event.js');
    const { applyOpsToItem } = await import('../../../src/js/store/calops.js');
    assert.throws(() => applyOpsToItem(item, [op], { lib }), (e) => e.code === 'occurrence-not-found', op.type);
  }
});

test('replay failure from an all-day toggle when their version has exceptions is listed, never guessed', async () => {
  const env = await makeCalEnv({ items: { [H]: weekly(UID) } });
  const base = baseOf(env, H);
  env.server.outside(H, weekly(UID, { exdates: ['20260316T093000'] })); // they deleted an occurrence meanwhile
  const ops = [
    { type: 'shiftExceptions', fromStart: paris('2026-03-02T09:30:00'), toStart: { kind: 'date', iso: '2026-03-02' } },
    { type: 'patch', fields: { start: { kind: 'date', iso: '2026-03-02' }, end: { kind: 'date', iso: '2026-03-03' } } },
  ];
  // on the base (no exceptions) the toggle works, so the write reaches the server and meets the 412
  const c = await env.writes.applyOps({ collection: CAL_A, href: H, base, ops });
  assert.equal(c.status, 'conflict');
  assert.equal(c.canOverwrite, false);
  assert.equal(c.unmappable[0].reason, 'allday-toggle-with-exceptions');
});

test('saveItem on a calendar item is one patch operation (conflicts replay on theirs)', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  const r = await env.writes.saveItem({ collection: CAL_A, href: S, base: baseOf(env, S), patch: { summary: 'Via saveItem' } });
  assert.equal(r.status, 'saved');
  assert.match(server(env, S), /SUMMARY:Via saveItem/);
  env.server.outside(S, single('one@example.org', 'Lunch', { extra: 'LOCATION:Theirs\n' }));
  const c = await env.writes.saveItem({ collection: CAL_A, href: S, base: { text: r.text, etag: r.etag }, patch: { summary: 'Again' } });
  assert.equal(c.status, 'conflict');
  assert.ok(Array.isArray(c.mine.ops));
});

test('an unknown time zone makes the item read-only: refused, no request', async () => {
  const env = await makeCalEnv({ items: { [S]: unknownZone('mars@example.org') } });
  env.server.calls.length = 0;
  const r = await run(env, S, [{ type: 'patch', fields: { summary: 'x' } }]);
  assert.equal(r.status, 'readonly');
  assert.deepEqual(env.server.calls, []);
});

test('invalid operation lists are refused before anything is read or sent', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  env.server.calls.length = 0;
  for (const ops of [[], [{ type: 'nope' }], [{ type: 'override', fields: {} }], [{ type: 'patch' }]]) {
    const r = await run(env, S, ops);
    assert.equal(r.status, 'invalid');
  }
  const noBase = await env.writes.applyOps({ collection: CAL_A, href: S, ops: [{ type: 'patch', fields: { summary: 'x' } }] });
  assert.equal(noBase.reason, 'base-required');
  assert.deepEqual(env.server.calls, []);
});

test('a server that stores the title differently is reported (persistent alert, Activity verify line), nothing auto-fixed', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') }, transform: (t, href) => (href === S ? t.replace(/SUMMARY:Brunch/, 'SUMMARY:Brunch (server)') : t) });
  const r = await run(env, S, [{ type: 'patch', fields: { summary: 'Brunch' } }]);
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.deepEqual(r.mismatched, ['summary']);
  assert.ok(opsLog(env).includes('verify:error'));
  assert.match(env.feedback.alert.text, /store\.err\.verify/);
});

test('verification only looks at what the operations touched: an unrelated server-side change is not a mismatch', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') }, transform: (t, href) => (href === S ? t.replace(/LOCATION:.*\n/, '') : t) });
  const r = await run(env, S, [{ type: 'patch', fields: { summary: 'Brunch' } }]);
  assert.equal(r.verified, true);
});

test('readonly level: a write on a collection the user can only read is refused', async () => {
  const href = '/bob/shared/x.ics';
  const env = await makeCalEnv({ items: { [href]: single('ro@example.org') } });
  const r = await env.writes.applyOps({ collection: '/bob/shared/', href, base: baseOf(env, href), ops: [{ type: 'patch', fields: { summary: 'x' } }] });
  assert.equal(r.status, 'readonly');
});

test('network and 5xx errors on the PUT are classified like every other write (result unknown / server error)', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  env.server.fail('PUT', new DavError('network', { message: 'down' }));
  assert.equal((await run(env, S, [{ type: 'patch', fields: { summary: 'a' } }])).status, 'unknown-result');
  env.server.fail('PUT', new DavError('server', { status: 500 }));
  assert.equal((await run(env, S, [{ type: 'patch', fields: { summary: 'b' } }])).status, 'server-error');
  env.server.fail('PUT', new DavError('forbidden', { status: 403 }));
  assert.equal((await run(env, S, [{ type: 'patch', fields: { summary: 'c' } }])).status, 'forbidden');
  const ok = await run(env, S, [{ type: 'patch', fields: { summary: 'd' } }]);
  assert.equal(ok.ok, true);
  assert.doesNotMatch(server(env, S), /SUMMARY:[abc]\n/); // M2: nothing from the failed attempts stays behind
});

test('createItem of an event: server adds a VTIMEZONE and re-orders; a retry that meets 412 is recognised by projection, not bytes (m2)', async () => {
  const env = await makeCalEnv({ items: {}, transform: (t) => t.replace(/SUMMARY:(.*)\n/, 'SUMMARY:$1\nX-SERVER-NOTE:x\n') });
  const fields = { summary: 'Standup', start: paris('2026-06-04T09:00:00'), end: paris('2026-06-04T09:30:00') };
  env.server.failAfter('PUT', new DavError('network', { message: 'lost' }));
  const first = await env.writes.createItem({ collection: CAL_A, kind: 'event', fields });
  assert.equal(first.status, 'unknown-result');
  assert.ok(first.retry);
  const retry = await env.writes.createItem({ collection: CAL_A, kind: 'event', fields, retry: first.retry });
  assert.equal(retry.ok, true);
  assert.equal(retry.recovered, true); // the 412 was recognised: the first attempt had worked
  assert.equal(env.server.hrefsIn(CAL_A).length, 1);
  assert.notEqual(env.server.at(first.retry.href).text, first.retry.text.replace(/\r\n/g, '\n')); // the stored text differs from the sent bytes
});

test('a retry that meets a 412 for DIFFERENT content is "exists", never a silent success', async () => {
  const env = await makeCalEnv({ items: {} });
  const fields = { summary: 'Standup', start: paris('2026-06-04T09:00:00'), end: paris('2026-06-04T09:30:00') };
  env.server.failAfter('PUT', new DavError('network', { message: 'lost' }));
  const first = await env.writes.createItem({ collection: CAL_A, kind: 'event', fields });
  env.server.outside(first.retry.href, single('someone-else@example.org', 'Other thing'));
  const retry = await env.writes.createItem({ collection: CAL_A, kind: 'event', fields, retry: first.retry });
  assert.equal(retry.ok, false);
  assert.equal(retry.status, 'exists');
});

test('Save mine as a copy: a single event only; a series is refused', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org'), [H]: weekly(UID) } });
  const base = baseOf(env, S);
  env.server.outside(S, single('one@example.org', 'Lunch', { extra: 'LOCATION:Theirs\n' }));
  const c = await env.writes.applyOps({ collection: CAL_A, href: S, base, ops: [{ type: 'patch', fields: { summary: 'Mine' } }] });
  const copy = await env.writes.resolveCopy(c);
  assert.equal(copy.status, 'copied');
  const hrefs = env.server.hrefsIn(CAL_A);
  assert.equal(hrefs.length, 3);
  const copied = hrefs.find((h) => h !== S && h !== H);
  assert.match(env.server.at(copied).text, /SUMMARY:Mine/);
  assert.doesNotMatch(env.server.at(copied).text, /UID:one@example.org/);
  // direct attempt for a series is refused by the store as well
  const r = await env.writes.copyItem({ collection: CAL_A, href: H, base: baseOf(env, H), ops: [{ type: 'patch', fields: { summary: 'x' } }] });
  assert.equal(r.status, 'not-allowed');
});

test('deleted elsewhere (404 on the PUT) returns the deleted-elsewhere result and drops the item from the store', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  const base = baseOf(env, S);
  env.server.items.delete(S);
  const r = await env.writes.applyOps({ collection: CAL_A, href: S, base, ops: [{ type: 'patch', fields: { summary: 'x' } }] });
  assert.equal(r.status, 'deleted-elsewhere');
  assert.equal(env.stores.get(CAL_A).has(S), false);
});

test('m1: a title edit of a single event that another client deleted offers "save mine as a copy" and the copy works (404 on the PUT)', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org') } });
  const base = baseOf(env, S);
  env.server.items.delete(S);
  const ops = [{ type: 'patch', fields: { summary: 'Mine' } }];
  const r = await env.writes.applyOps({ collection: CAL_A, href: S, base, ops });
  assert.equal(r.status, 'deleted-elsewhere');
  assert.equal(r.canCopy, true);
  assert.deepEqual(r.mine.ops, ops);
  assert.equal(r.base.etag, base.etag);
  const copy = await env.writes.resolveCopy(r);
  assert.equal(copy.status, 'copied');
  const copied = env.server.hrefsIn(CAL_A);
  assert.equal(copied.length, 1);
  assert.match(env.server.at(copied[0]).text, /SUMMARY:Mine/);
});

test('m1: the same when the deletion is only seen after a 412 (the GET answers 404); a series deleted elsewhere offers no copy', async () => {
  const env = await makeCalEnv({ items: { [S]: single('one@example.org'), [H]: weekly(UID) } });
  const ops = [{ type: 'patch', fields: { summary: 'Mine' } }];
  const base = baseOf(env, S);
  env.server.outside(S, single('one@example.org', 'Lunch', { extra: 'LOCATION:Theirs\n' }));
  const get = env.server.client.getItem;
  env.server.client.getItem = async (href) => {
    env.server.client.getItem = get;
    throw new DavError('notfound', { status: 404 });
  };
  const r = await env.writes.applyOps({ collection: CAL_A, href: S, base, ops });
  assert.equal(r.status, 'deleted-elsewhere');
  assert.equal(r.canCopy, true);
  assert.equal((await env.writes.resolveCopy(r)).status, 'copied');
  env.server.items.delete(H);
  const series = await env.writes.applyOps({ collection: CAL_A, href: H, base: baseOf(env, H), ops });
  assert.equal(series.status, 'deleted-elsewhere');
  assert.equal(series.canCopy, false);
});

test('model injection sanity: the tests run on the real model', () => {
  assert.equal(typeof model.openItem, 'function');
  assert.ok(ConflictError);
  assert.equal(CAL_B.endsWith('/'), true);
});
