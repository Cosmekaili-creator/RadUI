// SPDX-License-Identifier: AGPL-3.0-or-later
// store/importrun.js: concurrency, progress, cancel, stop conditions, chunked verification, idempotent resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, DavError } from '../../../src/js/dav/http.js';
import { planImport } from '../../../src/js/model/importplan.js';
import { decodeUtf8File, startImport } from '../../../src/js/store/importrun.js';
import { COLL, card, makeEnv, ops, tick } from './_helpers.mjs';

const U = (n) => `urn:uuid:99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const file = (n, from = 1) => Array.from({ length: n }, (_, i) => card(U(from + i), `Person ${from + i}`, `EMAIL:p${from + i}@example.org\n`)).join('');
let rn = 0;
const random = () => `00000000-1111-4000-8000-${String(++rn).padStart(12, '0')}`;
const knownOf = (env) => env.store.list().map((e) => ({ href: e.href, etag: e.etag, uid: /^UID:(.*)$/m.exec(e.text)[1].trim() }));
const run = (env, text, o = {}) => {
  const plan = planImport(text, knownOf(env), { collectionHref: COLL, random });
  return startImport({ client: env.server.client, collection: COLL, plan, store: env.store, scheduler: env.scheduler, reporter: env.reporter, gate: env.gate, random, ...o });
};

test('imports every new card: PUT with If-None-Match, ONE multiget per chunk (no per-item GET), progress, report', async () => {
  const env = await makeEnv({ items: {} });
  env.server.calls.length = 0;
  const progress = [];
  const h = run(env, file(5), { chunkSize: 2, onProgress: (p) => progress.push(p) });
  const rep = await h.done;
  assert.equal(rep.created, 5);
  assert.deepEqual([rep.replaced, rep.skipped, rep.failed, rep.notRun], [0, 0, 0, 0]);
  assert.equal(rep.ok, true);
  assert.equal(env.server.callsOf('PUT').length, 5);
  assert.equal(env.server.callsOf('GET').length, 0);
  assert.equal(env.server.callsOf('MULTIGET').length, 3); // 2 + 2 + 1
  assert.equal(rep.verify.checked, 5);
  assert.equal(env.server.items.size, 5);
  assert.equal(env.store.size, 5); // the multiget texts went to the store
  assert.ok(ops(env).includes('import:ok'));
  assert.equal(env.feedback.status.text, 'store.status.importDone {"created":5,"replaced":0,"skipped":0,"failed":0}');
  assert.equal(progress[0].phase, 'start');
  assert.equal(progress.at(-1).phase, 'end');
  assert.equal(progress.at(-1).done, 5);
  assert.equal(rep.items.filter((i) => i.result === 'created').length, 5);
});

test('at most 3 requests are in flight at a time', async () => {
  const env = await makeEnv({ items: {} });
  let now = 0;
  let peak = 0;
  const put = env.server.client.putItem;
  env.server.client.putItem = async (...a) => {
    now++;
    peak = Math.max(peak, now);
    await tick(2);
    try {
      return await put(...a);
    } finally {
      now--;
    }
  };
  const rep = await run(env, file(12)).done;
  assert.equal(rep.created, 12);
  assert.equal(peak, 3);
});

test('Cancel stops after the requests in flight; the rest is "not run"', async () => {
  const env = await makeEnv({ items: {} });
  let started = 0;
  let release;
  const hold = new Promise((r) => (release = r));
  const put = env.server.client.putItem;
  env.server.client.putItem = async (...a) => {
    started++;
    if (started <= 3) await hold;
    return put(...a);
  };
  const h = run(env, file(10), { chunkSize: 10 });
  await tick();
  assert.equal(started, 3);
  h.cancel();
  release();
  const rep = await h.done;
  assert.equal(rep.created, 3); // exactly the ones in flight
  assert.equal(rep.notRun, 7);
  assert.equal(rep.cancelled, true);
  assert.equal(rep.stopped, 'cancelled');
  assert.equal(started, 3);
  assert.equal(env.feedback.status.text, 'store.status.importCancelled {"done":3,"total":10}');
});

test('a network loss stops at once; re-running with "skip" resumes (idempotent)', async () => {
  const env = await makeEnv({ items: {} });
  let n = 0;
  const put = env.server.client.putItem;
  env.server.client.putItem = async (...a) => {
    if (++n === 4) throw new DavError('network', { timeout: true });
    return put(...a);
  };
  const text = file(6);
  const rep = await run(env, text, { concurrency: 1, chunkSize: 10 }).done;
  assert.equal(rep.stopped, 'network');
  assert.equal(rep.created, 3);
  assert.equal(rep.failed, 1);
  assert.equal(rep.notRun, 2);
  assert.equal(rep.reasons['unknown-result'], 1);
  assert.equal(env.feedback.alert.text, 'store.err.importStopped.network {"done":4,"total":6}');
  assert.equal(env.feedback.alert.scope, null);
  // resume: the sync shows what is there, "skip" imports only what is missing
  await env.store.sync({ reason: 'manual' });
  const again = await run(env, text, { concurrency: 1, chunkSize: 10 }).done;
  assert.equal(again.created, 3);
  assert.equal(again.skipped, 3); // the first three: kept-existing (the 4th request had failed before it was applied)
  assert.equal(env.server.items.size, 6);
  const third = await run(env, text).done;
  assert.equal(third.created, 0);
  assert.equal(third.skipped, 6);
});

test('401 and 403 stop at once; offline (gate or isOnline) sends nothing', async () => {
  const a = await makeEnv({ items: {} });
  a.server.fail('PUT', new DavError('auth', { status: 401 }));
  const ra = await run(a, file(5), { concurrency: 1 }).done;
  assert.equal(ra.stopped, 'auth');
  assert.equal(a.server.callsOf('PUT').length, 1);
  const f = await makeEnv({ items: {} });
  f.server.fail('PUT', new DavError('forbidden', { status: 403 }));
  assert.equal((await run(f, file(5), { concurrency: 1 }).done).stopped, 'forbidden');
  const o = await makeEnv({ items: {} });
  o.gate.setReason('offline', 'x');
  const ro = await run(o, file(3)).done;
  assert.equal(ro.stopped, 'offline');
  assert.equal(o.server.callsOf('PUT').length, 0);
  assert.equal(o.feedback.alert.text, 'store.err.importStopped.offline {"done":0,"total":3}');
  const o2 = await makeEnv({ items: {} });
  assert.equal((await run(o2, file(3), { isOnline: () => false }).done).stopped, 'offline');
});

test('verification: a card the server stored differently is reported (persistent alert, verify line)', async () => {
  const env = await makeEnv({ items: {}, transform: (t) => t.replace(/^EMAIL:.*\n/m, '') });
  const rep = await run(env, file(2)).done;
  assert.equal(rep.created, 2);
  assert.equal(rep.verify.mismatched.length, 2);
  assert.deepEqual(rep.verify.mismatched[0].fields, ['email']);
  assert.equal(rep.ok, false);
  assert.ok(ops(env).includes('verify:error'));
  assert.equal(env.feedback.alert.text, 'store.err.importVerify {"count":2}');
});

test('a multi-value NICKNAME is imported and reported as truncated, without a second alarm', async () => {
  const text = card(U(1), 'Nina', 'NICKNAME:Nini,Nicky\n');
  const env = await makeEnv({ items: {}, transform: (t) => t.replace('NICKNAME:Nini,Nicky', 'NICKNAME:Nini') });
  const rep = await run(env, text).done;
  assert.equal(rep.created, 1);
  assert.equal(rep.warnings[0].code, 'nickname-truncated');
  assert.deepEqual(rep.warnings[0].values, ['Nicky']);
  assert.equal(rep.verify.mismatched.length, 0);
});

test('policies: skip keeps existing, replace PUTs with If-Match, keep-both creates under a new UID', async () => {
  const env = await makeEnv({ items: {} });
  await run(env, file(2)).done;
  await env.store.sync({ reason: 'manual' });
  const changed = file(2).replace('Person 1', 'Person One Changed');
  const skip = await run(env, changed, { policy: 'skip' }).done;
  assert.equal(skip.skipped, 2);
  assert.equal(skip.created, 0);
  const rep = await run(env, changed, { policy: 'replace' }).done;
  assert.equal(rep.replaced, 2);
  assert.ok([...env.server.items.values()].some((i) => i.text.includes('Person One Changed')));
  await env.store.sync({ reason: 'manual' });
  const both = await run(env, changed, { policy: 'keep-both' }).done;
  assert.equal(both.created, 2);
  assert.equal(env.server.items.size, 4);
});

test('per-item PUT outcomes: 412 on create = skipped "exists"; 412 on replace = failed "changed"; 409 = uid-conflict; 413; 5xx', async () => {
  const env = await makeEnv({ items: {} });
  env.server.fail('PUT', new ConflictError({ status: 412, href: 'x', sentEtag: null }));
  env.server.fail('PUT', new DavError('conflict', { status: 409 }));
  env.server.fail('PUT', new DavError('toolarge', { status: 413 }));
  env.server.fail('PUT', new DavError('server', { status: 500 }));
  const rep = await run(env, file(5), { concurrency: 1 }).done;
  assert.equal(rep.skipped, 1);
  assert.equal(rep.failed, 3);
  assert.equal(rep.created, 1);
  assert.deepEqual(rep.reasons, { exists: 1, 'uid-conflict': 1, 'too-large': 1, 'server-error': 1 });
  assert.equal(rep.stopped, null);
  const r2 = await makeEnv({ items: {} });
  await run(r2, file(1)).done;
  await r2.store.sync({ reason: 'manual' });
  r2.server.fail('PUT', new ConflictError({ status: 412, href: 'x', sentEtag: 'y' }));
  const rr = await run(r2, file(1).replace('Person 1', 'P1b'), { policy: 'replace' }).done;
  assert.deepEqual([rr.failed, rr.reasons.changed], [1, 1]);
});

test('rows the plan marks invalid, unsupported or duplicate-in-file are skipped with their reason and never sent', async () => {
  const env = await makeEnv({ items: {} });
  const text = file(1) + 'BEGIN:VCARD\nVERSION:2.1\nN:Old;Ollie\nFN:Ollie\nTEL;CELL:+1 555 0150\nEND:VCARD\n' + file(1);
  const rep = await run(env, text).done;
  assert.equal(rep.created, 1);
  assert.equal(rep.skipped, 2);
  assert.deepEqual(rep.reasons, { 'unsupported-version': 1, 'duplicate-uid': 1 });
  assert.equal(env.server.callsOf('PUT').length, 1);
});

test('after an import the scheduler is asked for ONE sync', async () => {
  const env = await makeEnv({ items: {} });
  env.scheduler.register(env.store);
  await run(env, file(4)).done;
  env.server.calls.length = 0;
  await env.clock.advance(1000);
  assert.equal(env.server.callsOf('SYNC').length, 1);
});

test('decodeUtf8File: UTF-8 only, a BOM is stripped, a Windows-1252 file with a euro sign is refused', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.deepEqual(decodeUtf8File(enc('BEGIN:VCARD\nFN:Zoë\nEND:VCARD\n')), { ok: true, text: 'BEGIN:VCARD\nFN:Zoë\nEND:VCARD\n' });
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('BEGIN:VCARD\n')]);
  assert.equal(decodeUtf8File(bom).text, 'BEGIN:VCARD\n');
  const cp1252 = new Uint8Array([...enc('FN:Price '), 0x80, ...enc(' caf'), 0xe9]);
  assert.deepEqual(decodeUtf8File(cp1252), { ok: false, reason: 'not-utf8' });
});

test('M5: the import stops when the session ends (no further request, nothing reported into the shell)', async () => {
  const env = await makeEnv({ items: {} });
  let started = 0;
  let release;
  const hold = new Promise((r) => (release = r));
  const put = env.server.client.putItem;
  env.server.client.putItem = async (...a) => {
    started++;
    if (started <= 3) await hold;
    return put(...a);
  };
  const h = run(env, file(10), { chunkSize: 10, isDisposed: () => env.session.disposed });
  await tick();
  env.session.dispose();
  const alerts = env.feedback.alert;
  release();
  const rep = await h.done;
  assert.equal(started, 3);
  assert.equal(rep.cancelled, true);
  assert.equal(rep.stopped, 'cancelled');
  assert.equal(env.server.callsOf('MULTIGET').length, 0); // not even the verification
  assert.equal(env.activity.entries().some((e) => e.op === 'import'), false);
  assert.equal(env.feedback.status, null);
  assert.equal(alerts, env.feedback.alert);
});
