// SPDX-License-Identifier: AGPL-3.0-or-later
// `.vcf` import through the real store modules (ctx.startImport -> store/importrun.js) against the throwaway
// production-plugin stack (tests/integration/dav/stack.py): 500 fictional cards with progress and the final report,
// cancel and resume (skip policy), the session ending mid-import (review M5), the policies with MEMBER remapping,
// lossy and NICKNAME warnings, a read-only grantee, the UTF-8 / BOM rules and a UID conflict.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planImport, resolveImport } from '../../../src/js/model/importplan.js';
import { decodeUtf8File } from '../../../src/js/store/importrun.js';
import { account, itp, lines, membersOf, newBook, openStore, serverCards } from './prodenv.mjs';
import { fictionalFile } from './gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASIC = readFileSync(path.join(here, '../../fixtures/vcf/import/book-basic.vcf'), 'utf8');
const uidIn = (text) => (lines(text).find((l) => /^UID[:;]/i.test(l)) || '').replace(/^UID[^:]*:/i, '').trim();
const known = (store) => store.list().map((e) => ({ href: e.href, etag: e.etag, uid: uidIn(e.text) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plan and start an import into `store`'s book; options: policy, onProgress, resolve. */
function start(a, store, text, { policy = 'skip', ...o } = {}) {
  const plan = planImport(text, known(store), { collectionHref: store.href });
  assert.equal(plan.fatal, null);
  return { plan, handle: a.ctx.startImport({ collection: store.href, plan, policy, ...o }) };
}

itp('import of 500 fictional cards: progress, final report, every card on the server, the store filled without a sync', { timeout: 280000 }, async (t) => {
  const book = await newBook('alice', {}, { tag: 'imp' });
  const alice = account('alice');
  try {
    await alice.ctx.access.refetch();
    const store = await openStore(alice, book.href);
    const events = [];
    const t0 = Date.now();
    const { plan, handle } = start(alice, store, fictionalFile(500), { onProgress: (e) => events.push(e) });
    assert.equal(plan.counts.new, 500);
    const report = await handle.done;
    const ms = Date.now() - t0;
    assert.equal(report.ok, true, JSON.stringify({ failed: report.failed, stopped: report.stopped, verify: report.verify.mismatched.slice(0, 3) }));
    assert.equal(report.created, 500);
    assert.deepEqual([report.replaced, report.skipped, report.failed, report.notRun], [0, 0, 0, 0]);
    assert.equal(report.verify.checked, 500);
    assert.deepEqual(report.verify.mismatched, []);
    assert.equal(report.stopped, null);
    // progress: starts at 0, ends at 500, never goes backwards, every phase is named
    assert.equal(events[0].phase, 'start');
    assert.equal(events[0].done, 0);
    assert.equal(events[events.length - 1].phase, 'end');
    assert.equal(events[events.length - 1].done, 500);
    assert.ok(events.some((e) => e.phase === 'uploading') && events.some((e) => e.phase === 'verifying'));
    for (let i = 1; i < events.length; i++) assert.ok(events[i].done >= events[i - 1].done, 'progress never goes backwards');
    assert.equal((await serverCards(alice.client, book.href)).length, 500);
    assert.equal(store.size, 500, 'verification handed every server text to the store');
    // verification is one multiget per chunk, not one GET per card
    assert.equal(alice.since(0, { via: 'dav', method: 'GET' }).filter((c) => c.path.endsWith('.vcf')).length, 0);
    assert.ok(alice.since(0, { method: 'REPORT' }).length >= 10);
    assert.equal(alice.activity.entries().some((e) => e.op === 'import' && e.result === 'ok'), true);
    t.diagnostic(`500 cards: ${ms} ms (3 in flight, bcrypt cost 4), ${alice.puts().length} PUTs`);
  } finally {
    await alice.dispose();
  }
});

itp('cancel, then resume with the skip policy: the run is idempotent and ends with exactly 500 cards', { timeout: 280000 }, async () => {
  const book = await newBook('alice', {}, { tag: 'imp' });
  const alice = account('alice');
  try {
    await alice.ctx.access.refetch();
    const store = await openStore(alice, book.href);
    const file = fictionalFile(500);
    let handle = null;
    const { handle: h1 } = start(alice, store, file, {
      onProgress: (e) => {
        if (e.done >= 120 && handle) handle.cancel();
      },
    });
    handle = h1;
    const first = await h1.done;
    assert.equal(first.cancelled, true);
    assert.equal(first.stopped, 'cancelled');
    assert.equal(first.ok, false);
    assert.ok(first.created >= 120 && first.created < 500, `created ${first.created}`);
    assert.equal(first.notRun, 500 - first.created - first.failed);
    const onServer = (await serverCards(alice.client, book.href)).length;
    assert.equal(onServer, first.created, 'what the report says is what the server holds');
    // resume: sync the target first, plan against it, skip what exists
    await store.reload();
    assert.equal(store.size, onServer);
    const second = await start(alice, store, file, { policy: 'skip' }).handle.done;
    assert.equal(second.ok, true, JSON.stringify(second.reasons));
    assert.equal(second.created, 500 - onServer);
    assert.equal(second.skipped, onServer);
    assert.equal(second.reasons['kept-existing'], onServer);
    assert.equal((await serverCards(alice.client, book.href)).length, 500);
    // a third run does nothing
    const third = await start(alice, store, file, { policy: 'skip' }).handle.done;
    assert.equal(third.created, 0);
    assert.equal(third.skipped, 500);
  } finally {
    await alice.dispose();
  }
});

itp('review M5: the session ending (sign-out, expiry) stops the import; no request is sent afterwards', { timeout: 200000 }, async () => {
  const book = await newBook('alice', {}, { tag: 'imp' });
  const alice = account('alice');
  try {
    await alice.ctx.access.refetch();
    const store = await openStore(alice, book.href);
    let ended = false;
    const { handle } = start(alice, store, fictionalFile(400), {
      onProgress: (e) => {
        if (e.done >= 40 && !ended) {
          ended = true;
          alice.session.dispose();
        }
      },
    });
    const report = await handle.done;
    assert.equal(ended, true);
    assert.equal(report.cancelled, true);
    assert.equal(report.stopped, 'cancelled');
    assert.ok(report.created < 400);
    const putsAtEnd = alice.puts().length;
    const count = (await serverCards(account('alice', { store: false }).client, book.href)).length;
    await sleep(800);
    assert.equal(alice.puts().length, putsAtEnd, 'no PUT after the run ended');
    assert.equal((await serverCards(account('alice', { store: false }).client, book.href)).length, count, 'the server count no longer moves');
    assert.ok(count >= 40 && count < 400, `${count} cards stored`);
    assert.equal(alice.activity.entries().filter((e) => e.op === 'import').length, 0, 'nothing is reported into the next login\'s screen');
  } finally {
    await alice.dispose();
  }
});

itp('policies through the store: skip, replace (lossy rows held back until confirmed) and keep-both with MEMBER remapping; warnings are reported', async () => {
  const book = await newBook('alice', {}, { tag: 'imp' });
  const alice = account('alice');
  try {
    await alice.ctx.access.refetch();
    const store = await openStore(alice, book.href);
    // first import
    const r1 = await start(alice, store, BASIC).handle.done;
    assert.equal(r1.created, 10);
    assert.equal(r1.skipped, 4, 'unterminated chunk, stray text, vCard 2.1 card, duplicate UID in the file');
    assert.deepEqual(Object.keys(r1.reasons).sort(), ['duplicate-uid', 'outside-card', 'unsupported-version', 'unterminated']);
    assert.equal(r1.failed, 0);
    // the card with a NICKNAME list is imported and REPORTED (the server keeps the first value)
    const nick = r1.warnings.find((w) => w.code === 'nickname-truncated');
    assert.ok(nick && nick.values.includes('Janie'), JSON.stringify(r1.warnings));
    // damaged-by-the-server cards show up in the verification (note, title, photo), never silently
    const damaged = r1.verify.mismatched.map((m) => m.fields.slice().sort().join('+')).sort();
    assert.ok(damaged.includes('note+title') || damaged.includes('title+note') || damaged.some((d) => /note/.test(d)), JSON.stringify(r1.verify.mismatched));
    assert.ok(damaged.some((d) => /photo/.test(d)));
    assert.equal(r1.ok, false);
    assert.equal(store.size, 10);

    // skip: existing UIDs are kept; the one card WITHOUT a UID gets a new generated UID on every import, so it is
    // created again (a file without UIDs cannot be matched: that is the documented price of generating them)
    let r = await start(alice, store, BASIC, { policy: 'skip' }).handle.done;
    assert.deepEqual([r.created, r.replaced, r.skipped], [1, 0, 9 + 4]);
    assert.equal(store.size, 11);

    // replace: the 4 lossy cards are held back, the rest is replaced with If-Match
    const before = new Map(store.list().map((e) => [e.href, e.text]));
    r = await start(alice, store, BASIC, { policy: 'replace' }).handle.done;
    assert.equal(r.replaced, 5);
    assert.equal(r.created, 1, 'the card without UID, again');
    assert.equal(r.reasons['lossy-needs-confirmation'], 4);
    assert.equal(r.failed, 0, JSON.stringify(r.items.filter((i) => i.result === 'failed')));
    for (const e of store.list()) if (/Lossynote|Xprop|Hana Photo|Ivo Nick/.test(e.text)) assert.equal(e.text, before.get(e.href), 'held back: unchanged');
    // confirmed by the dialog (a custom resolve, as the dialog will do): the replace goes ahead
    const plan = planImport(BASIC, known(store), { collectionHref: store.href });
    const fay = plan.rows.find((x) => x.fn === 'Fay Lossynote');
    const confirmed = alice.ctx.startImport({ collection: store.href, plan, policy: 'replace', resolve: (p, pol, o) => resolveImport(p, pol, { ...o, confirmLossy: [fay.uid] }) });
    const rc = await confirmed.done;
    assert.equal(rc.replaced, 6, '5 + the confirmed card');
    assert.equal(rc.created, 1);
    assert.equal(rc.reasons['lossy-needs-confirmation'], 3);

    // keep-both: new UIDs and names; MEMBER lines of the imported groups follow the re-keyed contacts
    r = await start(alice, store, BASIC, { policy: 'keep-both' }).handle.done;
    assert.equal(r.created, 10);
    assert.equal(r.failed, 0);
    const cards = await serverCards(alice.client, book.href);
    assert.equal(cards.length, 23, '10 + 1 + 1 + 1 (no UID) + 10 re-keyed');
    const old = new Set(['1', '2', '3', '4', '5', '6', '8', '101', '102'].map((n) => `urn:uuid:7a0c1e00-0000-4000-8000-${n.padStart(12, '0')}`));
    const originals = cards.filter((c) => old.has(uidIn(c.text)));
    const copies = cards.filter((c) => !old.has(uidIn(c.text)));
    const copyUids = new Set(copies.map((c) => uidIn(c.text).toLowerCase()));
    for (const g of copies.filter((c) => /KIND:group/i.test(c.text))) {
      for (const m of membersOf(g.text)) {
        if (m.endsWith('0000000000ff')) continue;
        assert.ok(copyUids.has(m.toLowerCase()), `${m} is one of the new cards`);
      }
    }
    for (const g of originals.filter((c) => /KIND:group/i.test(c.text))) for (const m of membersOf(g.text)) assert.ok(old.has(m) || m.endsWith('0000000000ff'), 'the first import\'s groups still list the originals');
  } finally {
    await alice.dispose();
  }
});

itp('a read-only grantee cannot import: the server refuses, the run stops at once and nothing is written', async () => {
  const book = await newBook('alice', { bob: 'readwrite', 'agent-1': 'read' }, { tag: 'imp' });
  const agent = account('agent-1');
  const bob = account('bob');
  try {
    const store = await openStore(agent, book.href);
    const { handle } = start(agent, store, fictionalFile(30));
    const rep = await handle.done;
    assert.equal(rep.stopped, 'forbidden');
    assert.equal(rep.created, 0);
    assert.ok(rep.failed >= 1 && rep.notRun >= 20, JSON.stringify({ failed: rep.failed, notRun: rep.notRun }));
    assert.ok(agent.puts().length <= 3, `${agent.puts().length} PUTs (3 in flight at most)`);
    assert.equal((await serverCards(bob.client, book.href)).length, 0);
    // the read-write grantee can
    const bstore = await openStore(bob, book.href);
    const ok = await start(bob, bstore, fictionalFile(30)).handle.done;
    assert.equal(ok.created, 30);
  } finally {
    await agent.dispose();
    await bob.dispose();
  }
});

itp('file rules: a non-UTF-8 file is refused, a byte-order mark is stripped and the file imports', async () => {
  const euro = Buffer.concat([Buffer.from('BEGIN:VCARD\nVERSION:3.0\nUID:x\nFN:Caf'), Buffer.from([0xe9, 0x20, 0x80]), Buffer.from('\nEND:VCARD\n')]);
  assert.deepEqual(decodeUtf8File(euro), { ok: false, reason: 'not-utf8' });
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fictionalFile(3))]);
  const dec = decodeUtf8File(bom);
  assert.equal(dec.ok, true);
  assert.ok(dec.text.startsWith('BEGIN:VCARD'));
  const book = await newBook('alice', {}, { tag: 'imp' });
  const alice = account('alice');
  try {
    await alice.ctx.access.refetch();
    const store = await openStore(alice, book.href);
    const rep = await start(alice, store, dec.text).handle.done;
    assert.equal(rep.created, 3);
    assert.equal(rep.ok, true);
  } finally {
    await alice.dispose();
  }
});

itp('a UID that already exists under another name (a stale plan) is a uid-conflict failure, not an overwrite', async () => {
  const book = await newBook('alice', {}, { tag: 'imp' });
  const alice = account('alice');
  try {
    await alice.ctx.access.refetch();
    const store = await openStore(alice, book.href);
    const file = fictionalFile(5);
    // another client created card 2 under a different name after the plan's known list was taken
    const plan = planImport(file, [], { collectionHref: store.href });
    const other = fictionalFile(1, 2);
    await alice.client.putItem(`${book.href}other-name.vcf`, other.replace(/\n/g, '\r\n').replace(/\r\r/g, '\r'), { create: true });
    const rep = await alice.ctx.startImport({ collection: store.href, plan, policy: 'skip' }).done;
    assert.equal(rep.created, 4);
    assert.equal(rep.failed, 1);
    assert.equal(rep.reasons['uid-conflict'], 1);
    assert.equal(rep.ok, false);
    assert.equal((await serverCards(alice.client, book.href)).length, 5);
  } finally {
    await alice.dispose();
  }
});
