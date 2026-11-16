// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js: saveItem and createItem, every error class, M2 fresh-Item rule, no-change-no-request, verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, DavError } from '../../../src/js/dav/http.js';
import { FidelityError } from '../../../src/js/model/fidelity.js';
import { COLL, baseOf, card, etagOf, makeEnv, model, ops, radicaleLike, vcf } from './_helpers.mjs';

const UID_A = 'urn:uuid:11111111-2222-3333-4444-555555555501';
const base = () => card(UID_A, 'Alice Example', 'TEL;TYPE=CELL:+1 555 0100\nEMAIL:alice@example.org\nTITLE:Engineer\n');
const href = (name = 'a.vcf') => COLL + name;
const put = (env) => env.server.callsOf('PUT');

test('a change: PUT with If-Match, re-GET, store holds the server text, Activity and status', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  const before = env.store.get(href()).etag;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'Boss' } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'saved');
  assert.equal(r.verified, true);
  assert.equal(put(env).length, 1);
  assert.equal(env.server.callsOf('GET').length, 1);
  assert.match(env.server.get('a.vcf').text, /TITLE:Boss/);
  assert.notEqual(env.store.get(href()).etag, before);
  assert.equal(env.store.get(href()).text, env.server.get('a.vcf').text);
  assert.deepEqual(ops(env).slice(0, 1), ['update:ok']);
  assert.equal(env.feedback.status.text, 'store.status.saved');
  assert.equal(r.message, 'store.status.saved');
});

test('the PUT carries the etag the edit started from (If-Match), not the latest one', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  const startedFrom = env.store.get(href());
  env.server.external('a.vcf', base().replace('Engineer', 'Pilot'));
  await env.store.sync({ reason: 'poll' });
  const r = await env.writes.saveItem({ collection: COLL, href: href(), patch: { note: 'x' }, base: { text: startedFrom.text, etag: startedFrom.etag } });
  assert.equal(r.status, 'conflict'); // stale base etag -> 412 -> a conflict, never a silent overwrite
});

test('no change: NO request at all and the status says so', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'Engineer', fn: 'Alice Example' } });
  assert.deepEqual([r.ok, r.status, r.changed], [true, 'unchanged', false]);
  assert.deepEqual(env.server.calls, []);
  assert.equal(env.feedback.status.text, 'store.status.unchanged');
  const r2 = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: {} });
  assert.equal(r2.status, 'unchanged');
  assert.deepEqual(env.server.calls, []);
});

test('M2: a failed save never leaves its edits behind; a later save of ANOTHER field sends only that field', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.fail('PUT', new DavError('network', { message: 'down' }));
  const failed = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { note: 'unsent edit' } });
  assert.equal(failed.status, 'unknown-result');
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'Boss' } });
  assert.equal(r.ok, true);
  const sent = env.server.get('a.vcf').text;
  assert.match(sent, /TITLE:Boss/);
  assert.doesNotMatch(sent, /unsent edit/);
  assert.doesNotMatch(sent, /NOTE/);
});

test('M2: the same holds after a 412 and after a 5xx', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.fail('PUT', new ConflictError({ status: 412, href: href(), sentEtag: 'x' }));
  const c = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { note: 'conflicted edit' } });
  assert.equal(c.status, 'conflict');
  env.server.fail('PUT', new DavError('server', { status: 500 }));
  const e = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'T2' } });
  assert.equal(e.status, 'server-error');
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'T3' } });
  assert.equal(r.ok, true);
  assert.doesNotMatch(env.server.get('a.vcf').text, /conflicted edit|TITLE:T2/);
});

test('a patch builder is called with the fresh item\'s fields on every attempt', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  const seen = [];
  const builder = (fields) => {
    seen.push(fields);
    return { tel: [{ ...fields.tel[0], value: '+1 555 0199' }] };
  };
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: builder });
  assert.equal(r.ok, true);
  assert.match(env.server.get('a.vcf').text, /\+1 555 0199/);
  assert.equal(seen.length, 1);
});

test('row patches built from the VIEW\'s item are remapped through baseFields', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  const view = model.openItem(env.store.get(href()).text, 'contact'); // the form's own item
  const f = view.fields();
  const patch = { tel: [{ ...f.tel[0], value: '+1 555 0123' }], email: [...f.email, { value: 'second@example.org', types: ['work'] }] };
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch, baseFields: f });
  assert.equal(r.ok, true, r.message);
  const text = env.server.get('a.vcf').text;
  assert.match(text, /\+1 555 0123/);
  assert.match(text, /second@example.org/);
  assert.match(text, /TYPE=CELL/); // the untouched type survived
  // rows from a foreign item with no baseFields cannot be applied: refused as invalid, nothing sent
  env.server.calls.length = 0;
  const bad = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { tel: [{ ...f.tel[0], value: '+1' }] } });
  assert.equal(bad.status, 'invalid');
  assert.deepEqual(env.server.calls, []);
});

test('write verification tolerates what Radicale does (reorder, X-ABLABEL case, TYPE case)', async () => {
  const text = card(UID_A, 'Alice Example', 'item1.TEL;type=CELL:+1 555 0100\nitem1.X-ABLabel:Night shift\nTITLE:Engineer\nEMAIL;TYPE=INTERNET:a@example.org\n');
  const env = await makeEnv({ items: { 'a.vcf': text }, transform: radicaleLike });
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'Boss', note: 'n' } });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.deepEqual(r.mismatched, []);
  assert.equal(env.feedback.alert, null);
});

test('M8: a value the server stores differently gives a persistent alert and a verify:error line, never auto-fixed', async () => {
  // the server silently cuts a note at a comma (like the unescaped-comma truncation)
  const transform = (t) => t.replace(/^(NOTE:[^\n]*?)\\,.*$/m, '$1');
  const env = await makeEnv({ items: { 'a.vcf': base() }, transform });
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { note: 'first, second' } });
  assert.equal(r.ok, true); // it was written
  assert.equal(r.verified, false);
  assert.deepEqual(r.mismatched, ['note']);
  assert.ok(ops(env).includes('verify:error'));
  assert.match(env.feedback.alert.text, /store\.err\.verify/);
  assert.equal(env.feedback.alert.scope, null); // persistent: survives navigation
  assert.equal(env.server.callsOf('PUT').length, 1); // nothing was re-sent to "fix" it
  assert.match(env.store.get(href()).text, /NOTE:first\n/); // the store holds what the server holds
});

test('a read-back that fails after a good PUT is reported and the store is refreshed', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.fail('GET', new DavError('network', { message: 'x' }));
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'Boss' } });
  assert.equal(r.ok, true);
  assert.equal(r.verified, null);
  assert.ok(ops(env).includes('verify:error'));
  assert.match(env.store.get(href()).text, /TITLE:Boss/); // the refresh fetched the real text
});

test('403: text error, me/access is refetched and the level recomputed', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() }, level: 'readwrite' });
  env.server.fail('PUT', new DavError('forbidden', { status: 403 }));
  const before = env.accessCalls.n;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.equal(r.status, 'forbidden');
  assert.equal(env.feedback.alert.text, 'err.dav.forbidden');
  assert.equal(env.accessCalls.n, before + 1);
  assert.ok(ops(env).includes('update:error'));
});

test('404: deleted elsewhere, and the item leaves the store', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.fail('PUT', new DavError('notfound', { status: 404 }));
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.equal(r.status, 'deleted-elsewhere');
  assert.equal(env.store.has(href()), false);
  assert.equal(env.feedback.alert.text, 'store.err.deletedElsewhere');
});

test('413: too large; 401: auth without an alert (the session-expiry path owns it)', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.fail('PUT', new DavError('toolarge', { status: 413 }));
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.equal(r.status, 'toolarge');
  assert.equal(env.feedback.alert.text, 'err.dav.toolarge');
  env.feedback.clear();
  env.server.fail('PUT', new DavError('auth', { status: 401 }));
  const a = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'y' } });
  assert.equal(a.status, 'auth');
  assert.equal(env.feedback.alert, null);
});

test('5xx: text alert and the list is reloaded; network error: "result unknown", list reloaded', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.fail('PUT', new DavError('server', { status: 500 }));
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.equal(r.status, 'server-error');
  assert.equal(env.feedback.alert.text, 'store.err.serverReloaded');
  assert.ok(env.server.callsOf('SYNC').length >= 1);
  env.server.calls.length = 0;
  env.server.fail('PUT', new DavError('network', { timeout: true }));
  const n = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'y' } });
  assert.equal(n.status, 'unknown-result');
  assert.equal(env.feedback.alert.text, 'store.err.unknownResult');
  assert.ok(env.server.callsOf('SYNC').length >= 1);
});

test('the write gate (offline / read-only) blocks before anything is sent', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.gate.setReason('offline', 'offline: changes disabled');
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'offline');
  assert.equal(env.feedback.alert.text, 'store.err.offline');
  assert.deepEqual(env.server.calls, []);
  env.gate.setReason('offline', null);
  env.gate.setReason('readonly', 'read-only');
  assert.equal((await env.writes.deleteItem({ collection: COLL, href: href(), etag: etagOf(env, href()) })).reason, 'readonly');
});

test('a collection the account may only read: refused before any request', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() }, level: 'read' });
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.deepEqual([r.ok, r.status], [false, 'readonly']);
  assert.equal(env.feedback.alert.text, 'store.err.noAccess');
  assert.equal((await env.writes.createItem({ collection: COLL, fields: { fn: 'N' } })).status, 'readonly');
  assert.deepEqual(env.server.calls, []);
});

test('a collection missing from the access list is tried (the server stays the authority)', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() }, level: null });
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.equal(r.ok, true);
});

test('FidelityError: save refused, item read-only for the session, codes in Activity, export offered', async () => {
  const strict = {
    ...model,
    openItem(text, kind) {
      const item = model.openItem(text, kind);
      if (item.ok) item.save = () => { throw new FidelityError([{ code: 'foreign-line-changed', message: 'a foreign line changed' }]); };
      return item;
    },
  };
  const env = await makeEnv({ items: { 'a.vcf': base() }, modelImpl: strict });
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'x' } });
  assert.equal(r.status, 'fidelity');
  assert.equal(r.problems[0].code, 'foreign-line-changed');
  assert.equal(r.exportText, base());
  assert.equal(env.feedback.alert.text, 'err.fidelity');
  assert.equal(env.activity.entries()[0].detail, 'fidelity foreign-line-changed');
  assert.equal(env.writes.isReadOnly(href()), true);
  assert.deepEqual(env.server.calls, []);
  const again = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'y' } });
  assert.equal(again.status, 'readonly'); // for the rest of the session, without even trying
});

test('items that open read-only (vCard 2.1, parse error) are never rewritten', async () => {
  const env = await makeEnv({ items: { 'old.vcf': 'BEGIN:VCARD\nVERSION:2.1\nN:Old;Ollie\nFN:Ollie\nUID:x\nEND:VCARD\n', 'bad.vcf': 'BEGIN:VCARD\nVERSION:3.0\nUID:y\nno colon here\nEND:VCARD\n' } });
  env.server.calls.length = 0;
  for (const n of ['old.vcf', 'bad.vcf']) {
    const r = await env.writes.saveItem({ collection: COLL, href: href(n), base: baseOf(env, href(n)), patch: { title: 'x' } });
    assert.equal(r.status, 'readonly', n);
  }
  assert.deepEqual(env.server.calls, []);
});

test('an invalid patch is refused with a reason (strict anniversary on vCard 3.0), nothing sent', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { anniversary: { year: 2000, month: 1, day: 2 } } });
  assert.equal(r.status, 'invalid');
  assert.match(env.feedback.alert.text, /store\.err\.invalid/);
  assert.deepEqual(env.server.calls, []);
});

test('NICKNAME list: Radicale cuts it on every PUT, so the write is refused unless confirmed', async () => {
  const env = await makeEnv({ items: { 'n.vcf': vcf('vcard30-multi-nickname.vcf') } });
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href('n.vcf'), base: baseOf(env, href('n.vcf')), patch: { note: 'edited' } });
  assert.equal(r.status, 'nickname-loss');
  assert.deepEqual(r.lost, ['Nicky', 'Nine']);
  assert.deepEqual(env.server.calls, []);
  const ok = await env.writes.saveItem({ collection: COLL, href: href('n.vcf'), base: baseOf(env, href('n.vcf')), patch: { note: 'edited' }, acceptNicknameLoss: true });
  assert.equal(ok.ok, true);
});

test('C1: base {text, etag} is MANDATORY for saveItem and copyItem; the store copy is never an implicit base', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  env.server.calls.length = 0;
  for (const call of [
    () => env.writes.saveItem({ collection: COLL, href: href(), patch: { title: 'x' } }),
    () => env.writes.saveItem({ collection: COLL, href: href(), patch: { title: 'x' }, base: { text: base() } }),
    () => env.writes.saveItem({ collection: COLL, href: href(), patch: { title: 'x' }, base: { text: '', etag: '"e"' } }),
    () => env.writes.copyItem({ collection: COLL, href: href(), patch: { title: 'x' } }),
  ]) {
    const r = await call();
    assert.deepEqual([r.ok, r.status, r.reason], [false, 'invalid', 'base-required']);
  }
  assert.deepEqual(env.server.calls, []);
  const gone = await env.writes.saveItem({ collection: COLL, href: href('zz.vcf'), patch: { title: 'x' }, base: { text: base(), etag: '"nope"' } });
  assert.notEqual(gone.status, 'saved'); // a base for an item that is not on the server never writes
});

test('C1 regression: the form opened on [cell 0001, work 0002]; another client deletes the cell row and adds home 0003; a sync runs; the save is a CONFLICT, never "saved"', async () => {
  const v1 = card(UID_A, 'Alice Example', 'TEL;TYPE=CELL:+1 555 0001\nTEL;TYPE=WORK:+1 555 0002\n');
  const env = await makeEnv({ items: { 'a.vcf': v1 } });
  const started = baseOf(env, href()); // what the form kept when it opened
  const view = model.openItem(started.text, 'contact').fields();
  const patch = { tel: [view.tel[0], { ...view.tel[1], value: '+1 555 9999' }] }; // I edit the work number
  env.server.external('a.vcf', card(UID_A, 'Alice Example', 'TEL;TYPE=WORK:+1 555 0002\nTEL;TYPE=HOME:+1 555 0003\n')); // theirs: cell gone, home added
  await env.store.sync({ reason: 'poll' }); // the store now holds THEIR version
  assert.match(env.store.get(href()).text, /555 0003/);
  const r = await env.writes.saveItem({ collection: COLL, href: href(), patch, baseFields: view, base: started });
  assert.equal(r.status, 'conflict');
  assert.notEqual(r.status, 'saved');
  const server = env.server.get('a.vcf').text;
  assert.match(server, /555 0003/); // their home number is untouched
  assert.doesNotMatch(server, /555 9999/);
  assert.doesNotMatch(server, /555 0001/); // their deletion of the cell row stays
  // overwrite then merges row by row
  const o = await env.writes.resolveOverwrite(r, { confirmUnmappable: true });
  assert.equal(o.ok, true);
  const merged = env.server.get('a.vcf').text;
  assert.match(merged, /555 9999/);
  assert.match(merged, /555 0003/);
});

test('C1: rows are never mapped by position between two versions: viewFields that are not from base.text are refused', async () => {
  const v1 = card(UID_A, 'Alice Example', 'TEL;TYPE=CELL:+1 555 0001\nTEL;TYPE=WORK:+1 555 0002\n');
  const v2 = card(UID_A, 'Alice Example', 'TEL;TYPE=WORK:+1 555 0002\nTEL;TYPE=HOME:+1 555 0003\n');
  const env = await makeEnv({ items: { 'a.vcf': v1 } });
  const view = model.openItem(v1, 'contact').fields(); // fields of ANOTHER version than the base given below
  env.server.calls.length = 0;
  const r = await env.writes.saveItem({ collection: COLL, href: href(), patch: { tel: [{ ...view.tel[1], value: '+1 555 9999' }] }, baseFields: view, base: { text: v2, etag: env.store.get(href()).etag } });
  assert.deepEqual([r.status, r.reason], ['invalid', 'base-mismatch']);
  assert.deepEqual(env.server.calls, []);
  // same row count, different rows: also refused (a count check alone would not catch it)
  const v3 = card(UID_A, 'Alice Example', 'TEL;TYPE=CELL:+1 555 7777\nTEL;TYPE=WORK:+1 555 0002\n');
  const r3 = await env.writes.saveItem({ collection: COLL, href: href(), patch: { tel: [{ ...view.tel[1], value: '+1 555 9999' }] }, baseFields: view, base: { text: v3, etag: '"x"' } });
  assert.equal(r3.reason, 'base-mismatch');
  // and the same text is accepted
  const ok = await env.writes.saveItem({ collection: COLL, href: href(), patch: { tel: [view.tel[0], { ...view.tel[1], value: '+1 555 9999' }] }, baseFields: view, base: baseOf(env, href()) });
  assert.equal(ok.ok, true);
});

test('minor 1: acceptNicknameLoss is usable in resolveOverwrite, copyItem and createItem, and the accepted values are not reported as "stored differently"', async () => {
  const nick = vcf('vcard30-multi-nickname.vcf');
  const cut = (t) => t.replace(/^NICKNAME:([^,\n]*).*$/m, 'NICKNAME:$1');
  const env = await makeEnv({ items: { 'n.vcf': nick }, transform: cut });
  const started = baseOf(env, href('n.vcf'));
  const ok = await env.writes.saveItem({ collection: COLL, href: href('n.vcf'), patch: { note: 'edited' }, base: started, acceptNicknameLoss: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.verified, true);
  assert.deepEqual(ok.mismatched, []);
  assert.equal(env.feedback.alert, null); // no persistent "stored differently" alert for the accepted values
  // a copy
  const nope = await env.writes.copyItem({ collection: COLL, href: href('n.vcf'), patch: { note: 'c' }, base: started });
  assert.equal(nope.status, 'nickname-loss');
  const copy = await env.writes.copyItem({ collection: COLL, href: href('n.vcf'), patch: { note: 'c' }, base: started, acceptNicknameLoss: true });
  assert.equal(copy.ok, true);
  assert.equal(copy.verified, true);
  // an overwrite after a conflict
  const env2 = await makeEnv({ items: { 'n.vcf': nick }, transform: cut });
  const s2 = baseOf(env2, href('n.vcf'));
  env2.server.external('n.vcf', nick.replace('Nina Nicknames', 'Nina Renamed'));
  const c = await env2.writes.saveItem({ collection: COLL, href: href('n.vcf'), patch: { note: 'mine' }, base: s2, acceptNicknameLoss: true });
  assert.equal(c.status, 'conflict');
  assert.equal((await env2.writes.resolveOverwrite(c)).status, 'nickname-loss');
  assert.equal((await env2.writes.resolveCopy(c)).status, 'nickname-loss');
  const done = await env2.writes.resolveOverwrite(c, { acceptNicknameLoss: true });
  assert.equal(done.ok, true);
  assert.equal(done.verified, true);
  // a create whose text carries the list (a retry token)
  const env3 = await makeEnv({ items: {}, transform: cut });
  const retry = { href: COLL + 'x.vcf', uid: 'x', text: nick };
  assert.equal((await env3.writes.createItem({ collection: COLL, retry })).status, 'nickname-loss');
  assert.equal((await env3.writes.createItem({ collection: COLL, retry, acceptNicknameLoss: true })).ok, true);
});

test('minor 7: the fidelity read-only flag clears when a different version of the item arrives', async () => {
  const strict = {
    ...model,
    openItem(text, kind) {
      const item = model.openItem(text, kind);
      if (item.ok) item.save = () => { throw new FidelityError([{ code: 'x', message: 'm' }]); };
      return item;
    },
  };
  const env = await makeEnv({ items: { 'a.vcf': base() }, modelImpl: strict });
  const r = await env.writes.saveItem({ collection: COLL, href: href(), patch: { title: 'x' }, base: baseOf(env, href()) });
  assert.equal(r.status, 'fidelity');
  assert.equal(env.writes.isReadOnly(href()), true);
  assert.deepEqual(env.writes.readOnlyHrefs(), [href()]);
  env.server.external('a.vcf', base().replace('Engineer', 'Fixed on the server'));
  await env.store.sync({ reason: 'poll' }); // a new ETag arrives
  assert.equal(env.writes.isReadOnly(href()), false);
  assert.deepEqual(env.writes.readOnlyHrefs(), []);
  const again = await env.writes.saveItem({ collection: COLL, href: href(), patch: { title: 'y' }, base: baseOf(env, href()) });
  assert.equal(again.status, 'fidelity'); // tried again (the fake model refuses every save) rather than refused unseen
});

// ------------------------------------------------------------------ create

test('createItem: If-None-Match create, new UID and href, GET, store, Activity', async () => {
  const env = await makeEnv({ items: {} });
  const r = await env.writes.createItem({ collection: COLL, fields: { fn: 'New Person', email: [{ value: 'new@example.org', types: ['home'] }] } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'created');
  assert.equal(r.href, COLL + '00000000-0000-4000-8000-000000000001.vcf');
  assert.equal(r.uid, '00000000-0000-4000-8000-000000000001');
  assert.match(env.server.get('00000000-0000-4000-8000-000000000001.vcf').text, /FN:New Person/);
  assert.equal(env.store.has(r.href), true);
  assert.ok(ops(env).includes('create:ok'));
  assert.equal(r.verified, true);
});

test('createItem: the VERSION is the book\'s majority, 3.0 for an empty book', async () => {
  const empty = await makeEnv({ items: {} });
  assert.match((await empty.writes.createItem({ collection: COLL, fields: { fn: 'A' } })).text, /VERSION:3\.0/);
  const four = await makeEnv({ items: { '1.vcf': card('u1', 'A', '', '4.0'), '2.vcf': card('u2', 'B', '', '4.0'), '3.vcf': card('u3', 'C') } });
  assert.match((await four.writes.createItem({ collection: COLL, fields: { fn: 'N' } })).text, /VERSION:4\.0/);
  const forced = await four.writes.createItem({ collection: COLL, fields: { fn: 'F' }, version: '3.0' });
  assert.match(forced.text, /VERSION:3\.0/);
});

test('createItem: a contact without a name is refused before any request; read-only gate too', async () => {
  const env = await makeEnv({ items: {} });
  env.server.calls.length = 0;
  const r = await env.writes.createItem({ collection: COLL, fields: { tel: [] } });
  assert.equal(r.status, 'invalid');
  assert.deepEqual(env.server.calls, []);
});

test('create: network error returns a retry token; the retry reuses the SAME href and UID', async () => {
  const env = await makeEnv({ items: {} });
  env.server.fail('PUT', new DavError('network', { timeout: true }));
  const first = await env.writes.createItem({ collection: COLL, fields: { fn: 'Retry Person' } });
  assert.equal(first.status, 'unknown-result');
  assert.ok(first.retry.href && first.retry.uid && first.retry.text);
  const second = await env.writes.createItem({ collection: COLL, fields: { fn: 'IGNORED' }, retry: first.retry });
  assert.equal(second.ok, true);
  assert.equal(second.href, first.retry.href);
  assert.equal(second.uid, first.retry.uid);
  assert.equal(env.server.items.size, 1);
  assert.match(env.server.get(first.retry.href.split('/').pop()).text, /Retry Person/);
});

test('create retry: a 412 after a lost response means the first attempt worked (verified by a GET)', async () => {
  const env = await makeEnv({ items: {} });
  env.server.failAfter('PUT', new DavError('network', { timeout: true })); // applied, response lost
  const first = await env.writes.createItem({ collection: COLL, fields: { fn: 'Lost Reply' } });
  assert.equal(first.status, 'unknown-result');
  assert.equal(env.server.items.size, 1); // it did go through
  const second = await env.writes.createItem({ collection: COLL, fields: {}, retry: first.retry });
  assert.equal(second.ok, true);
  assert.equal(second.recovered, true);
  assert.equal(second.status, 'created');
  assert.equal(env.server.items.size, 1);
  assert.equal(env.store.has(first.retry.href), true);
});

test('create retry: a 412 where the item holds OTHER content is "exists", never "worked"', async () => {
  const env = await makeEnv({ items: {} });
  env.server.fail('PUT', new DavError('network', {}));
  const first = await env.writes.createItem({ collection: COLL, fields: { fn: 'Mine' } });
  env.server.seed(first.retry.href.split('/').pop(), card(first.retry.uid, 'Someone Else'));
  const second = await env.writes.createItem({ collection: COLL, fields: {}, retry: first.retry });
  assert.equal(second.status, 'exists');
  assert.equal(second.ok, false);
});

test('create: a 412 on a first attempt and a 409 uid conflict are "exists"', async () => {
  const env = await makeEnv({ items: {} });
  env.server.fail('PUT', new ConflictError({ status: 412, href: 'x', sentEtag: null }));
  assert.equal((await env.writes.createItem({ collection: COLL, fields: { fn: 'A' } })).status, 'exists');
  env.server.fail('PUT', new DavError('conflict', { status: 409 }));
  const r = await env.writes.createItem({ collection: COLL, fields: { fn: 'B' } });
  assert.equal(r.status, 'exists');
  assert.equal(env.feedback.alert.text, 'store.err.uidConflict');
});

test('createItem for a group: Apple form for an empty book, the group form of the book otherwise', async () => {
  const env = await makeEnv({ items: {} });
  const g = await env.writes.createItem({ collection: COLL, group: { name: 'Family', memberUids: ['11111111-2222-3333-4444-555555555501'] } });
  assert.equal(g.ok, true);
  assert.match(g.text, /X-ADDRESSBOOKSERVER-KIND:group/);
  assert.match(g.text, /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:11111111-2222-3333-4444-555555555501/);
  const rfc = await makeEnv({ items: { 'g1.vcf': vcf('vcard40-group-kind.vcf'), 'g2.vcf': vcf('vcard40-group-kind.vcf').replace(/555555555508/, '555555555599') } });
  const g2 = await rfc.writes.createItem({ collection: COLL, group: { name: 'Team', memberUids: [] } });
  assert.match(g2.text, /\nKIND:group/);
});

test('copyItem: new UID and href, base + patch, If-None-Match; groups are refused', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base(), 'g.vcf': vcf('vcard30-group-apple.vcf') } });
  const r = await env.writes.copyItem({ collection: COLL, href: href(), base: baseOf(env, href()), patch: { title: 'Copy' } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'copied');
  assert.notEqual(r.uid, UID_A);
  const copy = env.server.items.get(r.href).text;
  assert.match(copy, /TITLE:Copy/);
  assert.doesNotMatch(copy, new RegExp(UID_A));
  assert.match(env.server.get('a.vcf').text, /TITLE:Engineer/); // the original is untouched
  const g = await env.writes.copyItem({ collection: COLL, href: href('g.vcf'), base: baseOf(env, href('g.vcf')), patch: { fn: 'Dup' } });
  assert.equal(g.status, 'not-allowed');
});
