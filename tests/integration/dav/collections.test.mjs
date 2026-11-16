// SPDX-License-Identifier: AGPL-3.0-or-later
// Collections through the real store modules against the throwaway production-plugin stack
// (tests/integration/dav/stack.py): create (mkcol / mkcalendar), the review regression C2 (an existing shared
// collection never loses its grants; orphan grants of a NEW name are revoked first), edit and delete with a stale and
// a fresh ETag, grants revoked after a delete, refusals for grantees (403), and `getCollectionText` through
// store/export.js for both kinds (book without group cards unless asked, calendar as ONE merged VCALENDAR).
import assert from 'node:assert/strict';
import { account, appleGroup, event, itp, lines, newBook, openStore, rfcGroup, uniqueName, urn, vcard } from './prodenv.mjs';

const grantsOf = async (a, name) => (await a.api.grants({ owner: 'alice' })).filter((g) => g.collection === name).map((g) => `${g.grantee}:${g.level}`).sort();
const grantPuts = (a, mark) => a.since(mark, { via: 'api', method: 'PUT', path: '/ui/api/grants' });

itp('mkcol and mkcalendar through the write path: created, listed with their properties, a second create is "exists"', async () => {
  const alice = account('alice');
  try {
    await alice.ctx.access.refetch();
    const bookName = uniqueName('mk');
    const calName = uniqueName('mk');
    const b = await alice.ctx.writes.mkcol({ home: '/alice/', name: bookName, displayName: 'Friends & family', description: 'Line one\nLine two' });
    assert.equal(b.status, 'created', JSON.stringify(b));
    const c = await alice.ctx.writes.mkcalendar({ home: '/alice/', name: calName, displayName: 'Work <cal>', color: '#3366CC', description: 'Plans', components: ['VEVENT'] });
    assert.equal(c.status, 'created', JSON.stringify(c));
    const book = alice.ctx.access.get(`/alice/${bookName}/`);
    const cal = alice.ctx.access.get(`/alice/${calName}/`);
    assert.equal(book.level, 'own');
    assert.equal(book.kind, 'addressbook');
    assert.equal(book.displayName, 'Friends & family');
    assert.equal(book.description, 'Line one\nLine two');
    assert.equal(cal.kind, 'calendar');
    assert.equal(cal.color, '#3366CC');
    assert.equal((await alice.ctx.writes.mkcol({ home: '/alice/', name: bookName, displayName: 'again' })).status, 'exists');
    assert.equal((await alice.ctx.writes.mkcalendar({ home: '/alice/', name: calName, displayName: 'again' })).status, 'exists');
    // names the server refuses are caught before any request
    const mark = alice.mark();
    for (const bad of ['', 'ends~', 'has space', 'radui-gen-x', '../up']) assert.equal((await alice.ctx.writes.mkcol({ home: '/alice/', name: bad })).status, 'invalid', bad);
    assert.equal(alice.since(mark).length, 0);
  } finally {
    await alice.dispose();
  }
});

itp('review C2: creating a name that exists and is shared sends no grant call and leaves every grant intact', async () => {
  const book = await newBook('alice', { bob: 'readwrite', 'agent-1': 'read' }, { tag: 'c2' });
  const known = account('alice');
  const unaware = account('alice'); // access list never loaded: the probe has to find the collection
  const bob = account('bob');
  try {
    await known.ctx.access.refetch();
    const expected = ['agent-1:read', 'bob:readwrite'];
    assert.deepEqual(await grantsOf(known, book.name), expected);

    // (a) the collection is in the access list
    let mark = known.mark();
    const r = await known.ctx.writes.mkcol({ home: '/alice/', name: book.name, displayName: 'take over' });
    assert.equal(r.status, 'exists');
    assert.equal(grantPuts(known, mark).length, 0, 'no PUT grants');
    assert.equal(known.since(mark, { via: 'dav', method: 'MKCOL' }).length, 0, 'not even a MKCOL');
    // (b) not in the list: a PROPFIND probe finds it; still no grant call (also for the other kind)
    mark = unaware.mark();
    assert.equal((await unaware.ctx.writes.mkcol({ home: '/alice/', name: book.name })).status, 'exists');
    assert.equal((await unaware.ctx.writes.mkcalendar({ home: '/alice/', name: book.name })).status, 'exists');
    assert.equal(grantPuts(unaware, mark).length, 0);
    assert.equal(unaware.since(mark, { via: 'api' }).filter((c) => c.method !== 'GET').length, 0);
    // the grants and the collection are as they were: bob still writes, agent-1 still reads
    assert.deepEqual(await grantsOf(known, book.name), expected);
    await bob.client.putItem(`${book.href}after.vcf`, vcard(1, 'Bea After'), { create: true });
    assert.equal((await account('agent-1', { store: false }).client.getItem(`${book.href}after.vcf`)).text.includes('Bea After'), true);
  } finally {
    await known.dispose();
    await unaware.dispose();
    await bob.dispose();
  }
});

itp('review C2: a NEW name that has orphan grants revokes them first, then creates', async () => {
  const book = await newBook('alice', { bob: 'readwrite', 'agent-1': 'read' }, { tag: 'orph' });
  const alice = account('alice');
  const bob = account('bob');
  try {
    await alice.ctx.access.refetch();
    // the collection disappears behind the account service's back; its grants stay
    const col = await alice.client.getCollection(book.href);
    await alice.client.deleteCollection(book.href, col.etag);
    assert.deepEqual(await grantsOf(alice, book.name), ['agent-1:read', 'bob:readwrite'], 'the orphans exist');
    await alice.ctx.access.refetch(); // (a stale list would answer "exists", which is safe: no grant is touched)
    assert.equal(alice.ctx.access.get(book.href), null);
    const mark = alice.mark();
    const r = await alice.ctx.writes.mkcol({ home: '/alice/', name: book.name, displayName: 'fresh' });
    assert.equal(r.status, 'created', JSON.stringify(r));
    const seq = alice.since(mark).map((c) => `${c.via}:${c.method}:${c.path}`);
    const firstRevoke = seq.indexOf('api:PUT:/ui/api/grants');
    const mkcol = seq.indexOf(`dav:MKCOL:${book.href}`);
    assert.ok(firstRevoke >= 0 && mkcol > firstRevoke, `revocation before MKCOL: ${seq.join(' > ')}`);
    assert.equal(grantPuts(alice, mark).length, 2, 'one revocation per grantee');
    assert.ok(grantPuts(alice, mark).every((c) => c.body.level === 'none'));
    assert.deepEqual(await grantsOf(alice, book.name), []);
    // the new collection starts private: bob cannot read it
    await assert.rejects(bob.client.getCollection(book.href), (e) => e.kind === 'forbidden');
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});

itp('delete a collection through the write path: a stale ETag answers "changed", a fresh one deletes and revokes every grant', async () => {
  const book = await newBook('alice', { bob: 'readwrite', 'agent-1': 'read' }, { tag: 'del' });
  const alice = account('alice');
  const bob = account('bob');
  try {
    await alice.ctx.access.refetch();
    const store = await openStore(alice, book.href);
    const shown = await alice.client.getCollection(book.href); // the delete dialog opens with this ETag
    // bob adds a card while the dialog is open
    await bob.client.putItem(`${book.href}late.vcf`, vcard(7, 'Lou Late'), { create: true });
    const mark = alice.mark();
    const changed = await alice.ctx.writes.deleteCollection({ href: book.href, kind: 'addressbook', expectedEtag: shown.etag });
    assert.equal(changed.status, 'changed');
    assert.equal(changed.itemCount, 1);
    assert.notEqual(changed.etag, shown.etag);
    assert.equal(alice.since(mark, { via: 'dav', method: 'DELETE' }).length, 0);
    assert.equal((await alice.client.getCollection(book.href)).href, book.href, 'still there');
    assert.equal(grantPuts(alice, mark).length, 0, 'grants untouched');
    // the dialog is shown again with the fresh ETag; confirming deletes
    const done = await alice.ctx.writes.deleteCollection({ href: book.href, kind: 'addressbook', expectedEtag: changed.etag });
    assert.equal(done.status, 'deleted', JSON.stringify(done));
    assert.deepEqual(done.revoke.revoked.slice().sort(), ['agent-1', 'bob']);
    assert.equal(done.grantsLeft, false);
    assert.deepEqual(await grantsOf(alice, book.name), []);
    await assert.rejects(alice.client.getCollection(book.href), (e) => e.kind === 'notfound');
    assert.equal(alice.ctx.stores.get(book.href), null, 'the store was dropped');
    assert.equal(alice.ctx.access.get(book.href), null);
    assert.equal(store.disposed, true);
    // deleting what is already gone is "deleted" too, not an error
    assert.equal((await alice.ctx.writes.deleteCollection({ href: book.href, kind: 'addressbook' })).status, 'deleted');
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});

itp('DAV client: delete with a stale ETag (before an item was added, before a PROPPATCH) is refused 412, the fresh ETag deletes', async () => {
  const alice = account('alice', { store: false });
  const c = alice.client;
  const mk = async (kind) => {
    const href = `/alice/${uniqueName('etag')}/`;
    if (kind === 'calendar') await c.mkcalendar(href, { displayName: 'cal', components: ['VEVENT'] });
    else await c.mkAddressbook(href, { displayName: 'book' });
    return href;
  };
  for (const kind of ['addressbook', 'calendar']) {
    const href = await mk(kind);
    const e0 = (await c.getCollection(href)).etag;
    await c.proppatch(href, kind, { displayName: 'Renamed', description: 'Described' });
    const e1 = (await c.getCollection(href)).etag;
    assert.notEqual(e1, e0, 'a PROPPATCH changes the collection ETag');
    await assert.rejects(c.deleteCollection(href, e0), (e) => e.name === 'ConflictError' && e.kind === 'precondition');
    const item = kind === 'calendar' ? [`${href}e.ics`, event('etag-event', 'Event')] : [`${href}c.vcf`, vcard(9, 'Ida Item')];
    await c.putItem(item[0], item[1], { create: true });
    const e2 = (await c.getCollection(href)).etag;
    assert.notEqual(e2, e1, 'an item changes it too');
    await assert.rejects(c.deleteCollection(href, e1), (e) => e.kind === 'precondition');
    assert.equal((await c.getCollection(href)).displayName, 'Renamed', 'the collection is intact');
    await c.deleteCollection(href, e2);
    await assert.rejects(c.getCollection(href), (e) => e.kind === 'notfound');
  }
});

itp('grantees cannot manage a collection: PROPPATCH and DELETE are 403 for read-write and read grantees, nothing changes', async () => {
  const book = await newBook('alice', { bob: 'readwrite', 'agent-1': 'read' }, { tag: 'perm' });
  const cal = await newBook('alice', { bob: 'readwrite', 'agent-1': 'read' }, { tag: 'perm', kind: 'calendar' });
  const alice = account('alice', { store: false });
  const grantees = [account('bob'), account('agent-1')];
  try {
    for (const g of grantees) {
      await g.ctx.access.refetch();
      for (const [coll, kind] of [[book, 'addressbook'], [cal, 'calendar']]) {
        const c = await alice.client.getCollection(coll.href);
        // at the raw DAV layer: the server refuses
        await assert.rejects(g.client.proppatch(coll.href, kind, { displayName: 'mine now' }), (e) => e.kind === 'forbidden' && e.status === 403, `${g.login} proppatch ${kind}`);
        await assert.rejects(g.client.deleteCollection(coll.href, c.etag), (e) => e.kind === 'forbidden' && e.status === 403, `${g.login} delete ${kind}`);
        // through the write path: the known level refuses before any request
        const mark = g.mark();
        assert.equal((await g.ctx.writes.proppatch({ href: coll.href, kind, changes: { displayName: 'x' } })).status, 'readonly');
        assert.equal((await g.ctx.writes.deleteCollection({ href: coll.href, kind })).status, 'readonly');
        assert.equal(g.since(mark, { via: 'dav' }).length, 0);
        // and creating a collection in the owner's space is not offered either
        assert.equal((await g.ctx.writes.mkcol({ home: '/alice/', name: uniqueName('x') })).status === 'created', false);
      }
    }
    for (const coll of [book, cal]) {
      const c = await alice.client.getCollection(coll.href);
      assert.equal(c.displayName, coll.name, 'name untouched');
    }
    assert.deepEqual(await grantsOf(alice, book.name), ['agent-1:read', 'bob:readwrite']);
    // the owner can
    const owner = account('alice');
    await owner.ctx.access.refetch();
    assert.equal((await owner.ctx.writes.proppatch({ href: book.href, kind: 'addressbook', changes: { displayName: 'Renamed by owner' } })).status, 'saved');
    assert.equal((await alice.client.getCollection(book.href)).displayName, 'Renamed by owner');
    assert.equal(owner.ctx.access.get(book.href).displayName, 'Renamed by owner');
    await owner.dispose();
  } finally {
    for (const g of grantees) await g.dispose();
  }
});

itp('export through getCollectionText: a book without group cards unless asked, the same for a read-only grantee', async () => {
  const book = await newBook('alice', { 'agent-1': 'read' }, { tag: 'exp' });
  const alice = account('alice');
  const agent = account('agent-1');
  try {
    await alice.ctx.access.refetch();
    await agent.ctx.access.refetch();
    await alice.client.putItem(`${book.href}a.vcf`, vcard(1, 'Ada Export', 'TEL;TYPE=CELL:+1 555 0101\r\n'), { create: true });
    await alice.client.putItem(`${book.href}b.vcf`, vcard(2, 'Bo Export', '', '4.0'), { create: true });
    await alice.client.putItem(`${book.href}ga.vcf`, appleGroup(11, 'Apple group', [urn(1)]), { create: true });
    await alice.client.putItem(`${book.href}gr.vcf`, rfcGroup(12, 'RFC group', [urn(2)]), { create: true });
    const raw = await alice.client.getCollectionText(book.href);
    assert.equal((raw.text.match(/^BEGIN:VCARD/gm) || []).length, 4, 'the server text holds every card, group cards included');
    for (const who of [alice, agent]) {
      const ex = await who.ctx.exportCollection({ collection: { href: book.href, kind: 'addressbook', displayName: 'Friends & Family' }, now: () => new Date(2026, 10, 13) });
      assert.equal(ex.ok, true);
      assert.equal(ex.count, 2);
      assert.equal(ex.groupsExcluded, 2);
      assert.equal(ex.filename, 'friends-family-2026-11-13.vcf');
      assert.equal(ex.fallback, false);
      assert.ok(ex.text.includes('\r\n') && !/[^\r]\n/.test(ex.text), 'CRLF');
      assert.deepEqual(lines(ex.text).filter((l) => /^FN:/.test(l)).sort(), ['FN:Ada Export', 'FN:Bo Export']);
      assert.equal(/KIND:group/i.test(ex.text), false);
      const all = await who.ctx.exportCollection({ collection: { href: book.href, kind: 'addressbook', displayName: 'x' }, includeGroups: true });
      assert.equal(all.count, 4);
      assert.equal(all.groupsExcluded, 0);
    }
    // a single contact export is its own text
    const one = alice.ctx.exportItem({ text: (await alice.client.getItem(`${book.href}a.vcf`)).text, displayName: 'Ada Export' });
    assert.equal(one.count, 1);
    // the export carries what the UI needs to re-import: a plan over it sees 2 contacts and 2 groups
    const { planImport } = await import('../../../src/js/model/importplan.js');
    const plan = planImport((await alice.ctx.exportCollection({ collection: { href: book.href, kind: 'addressbook', displayName: 'x' }, includeGroups: true })).text, [], { collectionHref: '/alice/other/' });
    assert.deepEqual(plan.counts, { new: 4, duplicate: 0, invalid: 0, unsupported: 0, 'file-duplicate': 0 });
  } finally {
    await alice.dispose();
    await agent.dispose();
  }
});

itp('export of a calendar is ONE merged VCALENDAR with its VTIMEZONE once', async () => {
  const cal = await newBook('alice', { 'agent-1': 'read' }, { tag: 'cal', kind: 'calendar' });
  const alice = account('alice');
  const agent = account('agent-1');
  try {
    await alice.ctx.access.refetch();
    await agent.ctx.access.refetch();
    for (let i = 1; i <= 3; i++) await alice.client.putItem(`${cal.href}e${i}.ics`, event(`event-${i}@example.org`, `Meeting ${i}`, `2026060${i}T090000`, 'Europe/Paris'), { create: true });
    for (const who of [alice, agent]) {
      const ex = await who.ctx.exportCollection({ collection: { href: cal.href, kind: 'calendar', displayName: 'Work' }, now: () => new Date(2026, 10, 13) });
      assert.equal(ex.ok, true);
      assert.equal(ex.count, 3);
      assert.equal(ex.filename, 'work-2026-11-13.ics');
      assert.equal((ex.text.match(/^BEGIN:VCALENDAR/gm) || []).length, 1, 'one calendar');
      assert.equal((ex.text.match(/^BEGIN:VEVENT/gm) || []).length, 3);
      assert.equal((ex.text.match(/^BEGIN:VTIMEZONE/gm) || []).length, 1, 'the zone is not repeated');
      assert.ok(ex.text.startsWith('BEGIN:VCALENDAR\r\n') && ex.text.endsWith('END:VCALENDAR\r\n'));
    }
    // an empty calendar exports as empty, said as such
    const empty = await newBook('alice', {}, { tag: 'cal', kind: 'calendar' });
    await alice.ctx.access.refetch();
    const ex = await alice.ctx.exportCollection({ collection: { href: empty.href, kind: 'calendar', displayName: 'Nothing' } });
    assert.equal(ex.count, 0);
    assert.equal(ex.empty, true);
  } finally {
    await alice.dispose();
    await agent.dispose();
  }
});
