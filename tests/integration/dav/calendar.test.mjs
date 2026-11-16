// SPDX-License-Identifier: AGPL-3.0-or-later
// Events through the real store modules (store/index.js: createStoreContext) against the throwaway production-plugin
// stack (tests/integration/dav/stack.py): alice owns the calendars, bob holds a read-write or a read grant. What only a
// real server can show:
//   - `splitWrite` with a REAL outside PUT between the tail's creation (b) and the PUT of the truncated original (c):
//     the compensation leaves the server with exactly the outside version of the original and no tail; Overwrite
//     then replays the split on theirs (addendum C1);
//   - `moveItem` between two calendars; an outside PUT on the source between the copy and the DELETE (addendum M5:
//     the copy is removed, nothing moved, the normal conflict); a read grantee on the target (403, nothing deleted);
//   - the 412 replay of an override operation (Overwrite) and an unmappable replay (the occurrence was deleted);
//   - `calendars.js` picks an outside edit up with its next sync and stops with `disable`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { flatDiff } from '../../roundtrip/compare.mjs';
import { openItem } from '../../../src/js/model/item.js';
import { account, itp, lf, newBook, openStore, rawDav } from './prodenv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERIES = readFileSync(path.join(here, '../../fixtures/ics/event-series-overrides-exdates.ics'), 'utf8');
const zoned = (iso) => ({ kind: 'zoned', iso, tzid: 'Europe/Paris' });
const calendar = (owner, grants = {}, tag = 'cal') => newBook(owner, grants, { tag, kind: 'calendar' });
const same = (a, b) => {
  const d = flatDiff(a, b, { ignoreManaged: true });
  return d.onlyA.length === 0 && d.onlyB.length === 0;
};
const starts = (text) => openItem(text, 'event').expand({ limit: 5000 }).occurrences.map((o) => o.start.iso);
const summaryOf = (text) => (lf(text).match(/^SUMMARY:(.*)$/m) || [])[1];
const listing = async (a, href) => {
  const list = await a.client.listItemEtags(href);
  if (!list.length) return [];
  const { items } = await a.client.calendarMultiget(href, list.map((x) => x.href));
  return items.map((i) => ({ href: i.href, etag: i.etag, text: i.text })).sort((x, y) => (x.href < y.href ? -1 : 1));
};
/** PUT as another client would: no If-Match, as a plain overwrite. */
const outsidePut = async (login, href, text) => {
  const r = await rawDav(login, href, { method: 'PUT', headers: { 'Content-Type': 'text/calendar; charset=utf-8' }, body: text });
  assert.ok(r.status === 201 || r.status === 204, `outside PUT ${r.status}`);
};
/** The series as the server serves it in a fresh calendar of `owner`, with `href` and the served {text, etag}. */
async function seed(a, cal, text = SERIES, name = 'series') {
  const href = `${cal.href}${name}.ics`;
  await a.client.putItem(href, text, { create: true });
  const got = await a.client.getItem(href);
  return { href, served: { text: got.text, etag: got.etag } };
}

// ---------------------------------------------------------------------------

itp('splitWrite: an outside PUT between the tail and the truncated original leaves the server with exactly the outside version; Overwrite replays the split on theirs', async () => {
  const cal = await calendar('alice');
  let tail = null;
  let fired = false;
  let target = null;
  let outsideText = null;
  const a = account('alice', {
    hook: async (c) => {
      if (fired || !target) return;
      if (c.method === 'PUT' && c.status === 201 && c.path !== target.href && c.path.startsWith(cal.href)) tail = c.path;
      else if (tail && c.method === 'GET' && c.path === tail) {
        fired = true; // the tail exists and was read back: now someone else edits the original
        await outsidePut('alice', target.href, outsideText);
      }
    },
  });
  try {
    await a.ctx.access.refetch();
    const s = await seed(a, cal);
    target = s;
    outsideText = s.served.text.replace('SUMMARY:Weekly review\r\n', 'SUMMARY:Changed elsewhere\r\n').replace('SUMMARY:Weekly review\n', 'SUMMARY:Changed elsewhere\n');
    assert.notEqual(outsideText, s.served.text);
    const mark = a.mark();
    const r = await a.ctx.writes.splitWrite({ collection: cal.href, href: s.href, base: s.served, rid: zoned('2026-04-13T09:30:00'), tailFields: { summary: 'Tail title' } });
    assert.equal(fired, true, 'the outside PUT happened between (b) and (c)');
    assert.equal(r.status, 'conflict', JSON.stringify({ s: r.status, m: r.message }));
    assert.equal(r.ok, false);
    // the order on the wire: tail PUT, tail GET, original PUT (412), compensating DELETE of the tail
    const seq = a.since(mark, { via: 'dav' }).filter((c) => ['PUT', 'DELETE'].includes(c.method)).map((c) => `${c.method} ${c.path === s.href ? 'original' : 'tail'} ${c.status}`);
    assert.deepEqual(seq.slice(0, 3), ['PUT tail 201', 'PUT original 412', 'DELETE tail 200'], seq.join(' | '));
    // the server holds exactly ONE resource: the outside version of the original, untouched by the split
    const now = await listing(a, cal.href);
    assert.equal(now.length, 1, 'no tail left behind');
    assert.equal(now[0].href, s.href);
    assert.equal(summaryOf(now[0].text), 'Changed elsewhere');
    assert.deepEqual(starts(now[0].text), starts(s.served.text), 'the future occurrences are all still there');
    assert.equal(r.theirs.etag, now[0].etag);
    assert.equal(r.canOverwrite, true);
    assert.deepEqual(r.unmappable, []);
    // Overwrite = the same split on THEIR version
    const o = await a.ctx.writes.resolveOverwrite(r);
    assert.equal(o.ok, true, `${o.status} ${o.message}`);
    const after = await listing(a, cal.href);
    assert.equal(after.length, 2);
    const head = after.find((e) => e.href === s.href);
    const tl = after.find((e) => e.href !== s.href);
    assert.equal(summaryOf(head.text), 'Changed elsewhere', 'their change to the head is kept');
    assert.deepEqual(starts(head.text), ['2026-03-16T09:30:00', '2026-03-23T14:00:00', '2026-04-06T09:30:00']);
    assert.equal(starts(tl.text).length, 7);
    assert.equal(summaryOf(tl.text), 'Tail title');
  } finally {
    await a.dispose();
  }
});

itp('moveItem between two calendars: the exact text arrives, the source is gone; the stores follow', async () => {
  const from = await calendar('alice', {}, 'from');
  const to = await calendar('alice', {}, 'to');
  const a = account('alice');
  try {
    await a.ctx.access.refetch();
    const s = await seed(a, from);
    const src = await openStore(a, from.href, 'calendar');
    const dst = await openStore(a, to.href, 'calendar');
    const r = await a.ctx.writes.moveItem({ from: from.href, to: to.href, href: s.href, base: s.served });
    assert.equal(r.status, 'moved', `${r.status} ${r.message}`);
    assert.equal(r.href, `${to.href}series.ics`, 'same file name');
    assert.deepEqual(await listing(a, from.href), []);
    const there = await listing(a, to.href);
    assert.equal(there.length, 1);
    assert.equal(same(s.served.text, there[0].text), true, 'semantically the same item');
    assert.deepEqual(starts(there[0].text), starts(s.served.text));
    assert.equal(src.size, 0);
    assert.equal(dst.size, 1);
    const calls = a.calls.filter((c) => c.via === 'dav' && ['PUT', 'DELETE'].includes(c.method)).map((c) => `${c.method} ${c.status}`);
    assert.deepEqual(calls.slice(-2), ['PUT 201', 'DELETE 200']);
  } finally {
    await a.dispose();
  }
});

itp('moveItem with an outside PUT on the source between copy and delete (addendum M5): the copy is removed, nothing moved, the normal conflict', async () => {
  const from = await calendar('alice', {}, 'from');
  const to = await calendar('alice', {}, 'to');
  let armed = false;
  let fired = false;
  let source = null;
  let outsideText = null;
  const a = account('alice', {
    hook: async (c) => {
      if (armed && !fired && c.method === 'PUT' && c.status === 201 && c.path.startsWith(to.href)) {
        fired = true; // the copy was just written: now the source changes
        await outsidePut('alice', source.href, outsideText);
      }
    },
  });
  try {
    await a.ctx.access.refetch();
    const s = await seed(a, from);
    source = s;
    outsideText = s.served.text.replace(/SUMMARY:Weekly review(\r?\n)/, 'SUMMARY:Edited while moving$1');
    assert.notEqual(outsideText, s.served.text);
    armed = true;
    const mark = a.mark();
    const r = await a.ctx.writes.moveItem({ from: from.href, to: to.href, href: s.href, base: s.served });
    assert.equal(fired, true);
    assert.equal(r.status, 'conflict', `${r.status} ${r.message}`);
    assert.deepEqual(await listing(a, to.href), [], 'the copy was deleted again');
    const kept = await listing(a, from.href);
    assert.equal(kept.length, 1);
    assert.equal(summaryOf(kept[0].text), 'Edited while moving', 'the outside edit is untouched');
    const dels = a.since(mark, { via: 'dav', method: 'DELETE' });
    assert.deepEqual(dels.map((c) => [c.path.startsWith(to.href) ? 'copy' : 'source', c.status]), [['source', 412], ['copy', 200]]);
    assert.equal(r.theirs.etag, kept[0].etag);
    // Overwrite moves THEIR version
    const o = await a.ctx.writes.resolveOverwrite(r);
    assert.equal(o.status, 'moved', `${o.status} ${o.message}`);
    assert.deepEqual(await listing(a, from.href), []);
    const moved = await listing(a, to.href);
    assert.equal(moved.length, 1);
    assert.equal(summaryOf(moved[0].text), 'Edited while moving');
  } finally {
    await a.dispose();
  }
});

itp('moveItem onto a calendar where the user only reads: refused before any request, and by the server (403) with nothing deleted', async () => {
  const mine = await calendar('bob', {}, 'mine');
  const theirs = await calendar('alice', { bob: 'read' }, 'ro');
  const informed = account('bob');
  const unaware = account('bob'); // access list never loaded: the server decides
  try {
    await informed.ctx.access.refetch();
    const s = await seed(informed, mine);
    // (a) the level is known: refused locally
    let mark = informed.mark();
    const a1 = await informed.ctx.writes.moveItem({ from: mine.href, to: theirs.href, href: s.href, base: s.served });
    assert.equal(a1.ok, false);
    assert.equal(a1.status, 'readonly');
    assert.deepEqual(informed.since(mark, { via: 'dav' }).filter((c) => c.method === 'PUT' || c.method === 'DELETE'), []);
    // (b) the level is unknown: the PUT is refused by the server and nothing is deleted
    mark = unaware.mark();
    const a2 = await unaware.ctx.writes.moveItem({ from: mine.href, to: theirs.href, href: s.href, base: s.served });
    assert.equal(a2.ok, false, `${a2.status} ${a2.message}`);
    const wire = unaware.since(mark, { via: 'dav' }).filter((c) => c.method === 'PUT' || c.method === 'DELETE').map((c) => `${c.method} ${c.status}`);
    assert.deepEqual(wire, ['PUT 403']);
    assert.equal((await listing(informed, mine.href)).length, 1, 'the original is still there');
    assert.deepEqual(await listing(account('alice', { store: false }), theirs.href), [], 'nothing arrived');
  } finally {
    await informed.dispose();
    await unaware.dispose();
  }
});

itp('the 412 replay of an override operation: Overwrite applies it on their version; an occurrence deleted elsewhere is unmappable and Overwrite is refused', async () => {
  const cal = await calendar('alice', { bob: 'readwrite' }, 'shared');
  const alice = account('alice');
  const bob = account('bob');
  try {
    await alice.ctx.access.refetch();
    await bob.ctx.access.refetch();
    const s = await seed(alice, cal);
    const op = { type: 'override', rid: zoned('2026-04-13T09:30:00'), fields: { summary: 'Mine for this day' } };

    // bob renames the whole series first
    const bobBase = await bob.client.getItem(s.href);
    const b = await bob.ctx.writes.applyOps({ collection: cal.href, href: s.href, base: { text: bobBase.text, etag: bobBase.etag }, ops: [{ type: 'patch', fields: { summary: 'Bob renamed it' } }] });
    assert.equal(b.status, 'saved', JSON.stringify(b));

    // alice, still on the old version
    let mark = alice.mark();
    const c = await alice.ctx.writes.applyOps({ collection: cal.href, href: s.href, base: s.served, ops: [op] });
    assert.equal(c.status, 'conflict', `${c.status} ${c.message}`);
    assert.equal(c.canOverwrite, true);
    assert.deepEqual(c.unmappable, []);
    assert.equal(alice.since(mark, { via: 'dav', method: 'PUT' })[0].status, 412);
    const o = await alice.ctx.writes.resolveOverwrite(c);
    assert.equal(o.status, 'saved', `${o.status} ${o.message}`);
    const now = await alice.client.getItem(s.href);
    const occ = openItem(now.text, 'event').expand({ limit: 50 }).occurrences.find((x) => x.start.iso === '2026-04-13T09:30:00');
    assert.equal(occ.source, 'override');
    assert.equal(occ.component.prop('SUMMARY').value, 'Mine for this day');
    assert.equal(summaryOf(now.text), 'Bob renamed it', 'their change to the master is kept');

    // bob now deletes the occurrence alice is about to change
    const base2 = await alice.client.getItem(s.href);
    const fresh = { text: base2.text, etag: base2.etag };
    const bobNow = await bob.client.getItem(s.href);
    const d = await bob.ctx.writes.applyOps({ collection: cal.href, href: s.href, base: { text: bobNow.text, etag: bobNow.etag }, ops: [{ type: 'deleteOccurrence', rid: zoned('2026-04-27T09:30:00') }] });
    assert.equal(d.status, 'saved', JSON.stringify(d));
    mark = alice.mark();
    const c2 = await alice.ctx.writes.applyOps({ collection: cal.href, href: s.href, base: fresh, ops: [{ type: 'override', rid: zoned('2026-04-27T09:30:00'), fields: { summary: 'Too late' } }] });
    assert.equal(c2.status, 'conflict');
    assert.equal(c2.canOverwrite, false);
    assert.ok(c2.unmappable.length > 0, 'the operation is listed as unmappable');
    const refused = await alice.ctx.writes.resolveOverwrite(c2, { confirmUnmappable: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'not-allowed');
    assert.equal(alice.since(mark, { via: 'dav', method: 'PUT' }).filter((x) => x.status !== 412).length, 0, 'no second PUT');
    assert.equal(starts((await alice.client.getItem(s.href)).text).includes('2026-04-27T09:30:00'), false, 'still deleted');
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});

itp('calendars.js: an outside edit arrives with the next sync; a disabled calendar is dropped and not polled', async () => {
  const cal = await calendar('alice', { bob: 'readwrite' }, 'sync');
  const alice = account('alice');
  const bob = account('bob');
  try {
    await alice.ctx.access.refetch();
    await bob.ctx.access.refetch();
    const s = await seed(alice, cal);
    const cals = alice.ctx.calendars;
    await cals.ready();
    const store = cals.enable({ href: cal.href, kind: 'calendar' });
    assert.ok(store);
    await store.sync({ reason: 'load' });
    const from = Date.UTC(2026, 2, 1);
    const to = Date.UTC(2026, 5, 30);
    let res = cals.occurrences(from, to);
    assert.equal(res.loading, false);
    assert.equal(res.occurrences.length, 10);
    assert.ok(res.occurrences.every((o) => o.collection === cal.href && o.href === s.href));
    const titles = (r) => new Set(r.occurrences.filter((o) => o.source === 'series').map((o) => o.component.prop('SUMMARY').value));
    assert.deepEqual([...titles(res)], ['Weekly review']);
    // bob edits through his write path; alice's store knows nothing until it syncs
    const theirs = await bob.client.getItem(s.href);
    const w = await bob.ctx.writes.applyOps({ collection: cal.href, href: s.href, base: { text: theirs.text, etag: theirs.etag }, ops: [{ type: 'patch', fields: { summary: 'Edited by bob' } }] });
    assert.equal(w.status, 'saved');
    assert.deepEqual([...titles(cals.occurrences(from, to))], ['Weekly review']);
    const sync = await store.sync({ reason: 'manual' });
    assert.equal(sync.ok, true);
    res = cals.occurrences(from, to);
    assert.deepEqual([...titles(res)], ['Edited by bob'], 'the parse cache follows the new ETag');
    assert.equal(res.occurrences.length, 10);
    // disable: the store is dropped, nothing polls it any more
    assert.equal(cals.disable(cal.href), true);
    assert.equal(cals.store(cal.href), null);
    assert.equal(cals.occurrences(from, to).occurrences.length, 0);
    const mark = alice.mark();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alice.since(mark, { via: 'dav' }).length, 0, 'no request after disable');
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});
