// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDiagnostics, classifyItem, itemKindFor, summarize, errorInfo, deriveHealth, DEFAULT_SAMPLE } from '../../../src/js/debug/debug.js';
import { ApiError } from '../../../src/js/api.js';
import { DavError } from '../../../src/js/dav/http.js';

const ME = { login: 'alice', displayName: 'Alice', type: 'person', admin: false, ownSpace: true, generation: 2, rightsActive: true, ok: true };
const coll = (over) => ({ href: '/alice/work/', name: 'work', displayName: 'Work', kind: 'calendar', components: ['VEVENT'], source: 'own', owner: 'alice', status: 'ok', privileges: ['read', 'write'], ...over });

function fakes({ collections, etags = {}, texts = {}, meError, me = ME, openItem } = {}) {
  const calls = [];
  const api = {
    me: async () => {
      if (meError) throw meError;
      return me;
    },
    // no health(): the browser must never call the loopback-only health endpoint
    meAccess: async () => ({ grants: [] }),
  };
  const dav = {
    listItemEtags: async (href) => {
      calls.push(['etags', href]);
      const v = etags[href];
      if (v instanceof Error) throw v;
      return (v || []).map((h) => ({ href: h, etag: '"1"' }));
    },
    calendarMultiget: async (href, hrefs) => {
      calls.push(['cal-multiget', href, hrefs]);
      return { items: hrefs.filter((h) => h in texts).map((h) => ({ href: h, etag: '"1"', text: texts[h] })), missing: hrefs.filter((h) => !(h in texts)) };
    },
    addressbookMultiget: async (href, hrefs) => {
      calls.push(['ab-multiget', href, hrefs]);
      return { items: hrefs.map((h) => ({ href: h, etag: '"1"', text: texts[h] || '' })), missing: [] };
    },
  };
  const events = [];
  const logs = [];
  const run = (extra = {}) =>
    collectDiagnostics({
      api,
      dav,
      discover: async () => ({ collections, apiError: null, ownError: null }),
      openItem: openItem || ((text) => (text.startsWith('RO') ? { ok: false, readOnly: true, reason: 'unknown-tzid' } : text.startsWith('WARN') ? { ok: true, readOnly: true, readOnlyReason: 'unknown-tzid' } : text === 'THROW' ? (() => { throw new RangeError('x'); })() : { ok: true, readOnly: false })),
      onEvent: (t, p) => events.push(t),
      log: (e) => logs.push(e),
      ...extra,
    });
  return { run, calls, events, logs };
}

test('errorInfo: safe kinds only, no bodies', () => {
  assert.deepEqual(errorInfo(new DavError('forbidden', { status: 403, body: 'secret text' })), { kind: 'forbidden', status: 403 });
  assert.deepEqual(errorInfo(new ApiError('ratelimited', { status: 429 })), { kind: 'other', status: 429 });
  assert.deepEqual(errorInfo(null), { kind: 'other', status: null });
});

test('itemKindFor', () => {
  assert.equal(itemKindFor({ kind: 'addressbook' }), 'contact');
  assert.equal(itemKindFor({ kind: 'calendar', components: ['VEVENT'] }), 'event');
  assert.equal(itemKindFor({ kind: 'calendar', components: ['VTODO'] }), 'task');
  assert.equal(itemKindFor({ kind: 'calendar', components: ['VEVENT', 'VTODO'] }), undefined);
  assert.equal(itemKindFor({ kind: 'calendar' }), undefined);
});

test('classifyItem: ok, read-only reasons, exceptions', () => {
  const open = (t) => (t === 'a' ? { ok: true, readOnly: false } : t === 'b' ? { ok: false, readOnly: true, reason: 'parse-error' } : t === 'c' ? { ok: true, readOnly: true, readOnlyReason: 'unknown-tzid' } : (() => { throw new TypeError('bad'); })());
  assert.deepEqual(classifyItem('a', 'event', open), { result: 'ok', reason: null });
  assert.deepEqual(classifyItem('b', 'event', open), { result: 'readonly', reason: 'parse-error' });
  assert.deepEqual(classifyItem('c', 'event', open), { result: 'readonly', reason: 'unknown-tzid' });
  assert.deepEqual(classifyItem('d', 'event', open), { result: 'error', reason: 'TypeError' });
});

test('collectDiagnostics: me, counts, first N items opened, read-only reasons, summary', async () => {
  const hrefs = Array.from({ length: 8 }, (_, i) => `/alice/work/e${i}.ics`);
  const texts = Object.fromEntries(hrefs.map((h, i) => [h, i === 1 ? 'RO tz' : i === 2 ? 'WARN' : 'ok']));
  const f = fakes({ collections: [coll()], etags: { '/alice/work/': [...hrefs].reverse() }, texts });
  const rep = await f.run({ sample: 4 });
  assert.equal(rep.me.ok, true);
  assert.equal(rep.me.data.login, 'alice');
  assert.equal(rep.health.state, 'ok');
  assert.equal(rep.health.generation, 2);
  const c = rep.collections[0];
  assert.equal(c.count, 8);
  assert.equal(c.writable, true);
  assert.deepEqual(c.items.map((i) => i.href), hrefs.slice(0, 4)); // deterministic: sorted, first N
  assert.deepEqual(c.items.map((i) => i.result), ['ok', 'readonly', 'readonly', 'ok']);
  assert.deepEqual(c.items.map((i) => i.reason), [null, 'unknown-tzid', 'unknown-tzid', null]);
  assert.deepEqual(rep.summary, { collections: 1, items: 4, readonly: 2, failed: 0 });
  assert.deepEqual(f.calls.find((x) => x[0] === 'cal-multiget')[2], hrefs.slice(0, 4));
  assert.deepEqual(f.events.slice(0, 3), ['me', 'health', 'collections']);
  assert.equal(f.events.at(-1), 'done');
  assert.ok(f.logs.every((l) => l.op && typeof l.result === 'string'));
  assert.ok(f.logs.some((l) => l.op === 'count' && l.detail === '8'));
});

test('deriveHealth: built from me; any reported false is degraded; nothing reported is unknown', () => {
  const ok = (data) => ({ ok: true, data: { login: 'a', generation: 4, ...data } });
  assert.deepEqual(deriveHealth(ok({ rightsActive: true, ok: true })), { state: 'ok', rightsActive: true, ok: true, generation: 4 });
  assert.equal(deriveHealth(ok({ rightsActive: false, ok: true })).state, 'degraded');
  assert.equal(deriveHealth(ok({ rightsActive: true, ok: false })).state, 'degraded');
  assert.equal(deriveHealth(ok({ rightsActive: true, ok: null })).state, 'ok');
  assert.deepEqual(deriveHealth(ok({ rightsActive: null, ok: null })), { state: 'unknown', rightsActive: null, ok: null, generation: 4 });
  assert.equal(deriveHealth(ok({})).state, 'unknown', 'an older server that omits the fields');
  assert.equal(deriveHealth({ ok: false, error: { kind: 'network' } }).state, 'unknown');
  assert.equal(deriveHealth(null).state, 'unknown');
});

test('collectDiagnostics never calls a health endpoint (the api object has none)', async () => {
  const f = fakes({ collections: [], me: { ...ME, rightsActive: false } });
  const rep = await f.run();
  assert.equal(rep.health.state, 'degraded');
  assert.equal(f.logs.find((l) => l.op === 'health').result, 'error');
});

test('collectDiagnostics: address books use the address-book multiget and kind "contact"', async () => {
  const seen = [];
  const f = fakes({
    collections: [coll({ href: '/alice/people/', kind: 'addressbook', components: ['VCARD'] })],
    etags: { '/alice/people/': ['/alice/people/a.vcf'] },
    texts: { '/alice/people/a.vcf': 'card' },
    openItem: (text, kind) => {
      seen.push(kind);
      return { ok: true, readOnly: false };
    },
  });
  const rep = await f.run();
  assert.deepEqual(seen, ['contact']);
  assert.equal(f.calls.some((x) => x[0] === 'ab-multiget'), true);
  assert.equal(rep.collections[0].items[0].result, 'ok');
});

test('collectDiagnostics: items the server did not return are "missing"; a throwing model is an error', async () => {
  const f = fakes({ collections: [coll()], etags: { '/alice/work/': ['/alice/work/a.ics', '/alice/work/b.ics'] }, texts: { '/alice/work/a.ics': 'THROW' } });
  const rep = await f.run();
  assert.deepEqual(rep.collections[0].items.map((i) => i.result), ['error', 'missing']);
  assert.equal(rep.summary.failed, 2);
});

test('collectDiagnostics: the account service being down is recorded, not fatal', async () => {
  const f = fakes({ collections: [coll()], meError: new ApiError('network') });
  const rep = await f.run();
  assert.equal(rep.me.ok, false);
  assert.equal(rep.me.error.kind, 'network');
  assert.equal(rep.health.state, 'unknown');
  assert.equal(rep.collections.length, 1);
});

test('collectDiagnostics: a count failure is per collection; non-ok collections are skipped', async () => {
  const f = fakes({
    collections: [coll({ href: '/alice/a/' }), coll({ href: '/bob/gone/', source: 'grant', status: 'missing' }), coll({ href: '/bob/locked/', source: 'grant', status: 'inaccessible' })],
    etags: { '/alice/a/': new DavError('server', { status: 500 }) },
  });
  const rep = await f.run();
  assert.equal(rep.collections[0].countError.kind, 'server');
  assert.equal(rep.collections[0].count, null);
  assert.deepEqual(rep.collections.map((c) => c.status), ['ok', 'missing', 'inaccessible']);
  assert.deepEqual(f.calls.filter((x) => x[0] === 'etags').map((x) => x[1]), ['/alice/a/']);
});

test('collectDiagnostics: sample 0 only counts; a 401 rejects; an aborted signal rejects', async () => {
  const f = fakes({ collections: [coll()], etags: { '/alice/work/': ['/alice/work/a.ics'] } });
  const rep = await f.run({ sample: 0 });
  assert.equal(rep.collections[0].count, 1);
  assert.deepEqual(rep.collections[0].items, []);
  assert.equal(f.calls.some((x) => x[0] === 'cal-multiget'), false);

  const unauth = fakes({ collections: [coll()], meError: new ApiError('auth', { status: 401 }) });
  await assert.rejects(unauth.run(), (e) => e.kind === 'auth');
  const davAuth = fakes({ collections: [coll()], etags: { '/alice/work/': new DavError('auth', { status: 401 }) } });
  await assert.rejects(davAuth.run(), (e) => e.kind === 'auth');

  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(fakes({ collections: [coll()] }).run({ signal: ctrl.signal }), (e) => e.name === 'AbortError');
});

test('summarize counts collection-level item errors as failures', () => {
  assert.deepEqual(summarize({ collections: [{ items: [], itemsError: { kind: 'server' } }, { items: [{ result: 'ok' }, { result: 'readonly' }, { result: 'missing' }] }] }), { collections: 2, items: 3, readonly: 1, failed: 2 });
  assert.equal(DEFAULT_SAMPLE, 5);
});

// ------------------------------------------------------------ screen render

import { renderDebug } from '../../../src/js/debug/debug.js';
import { setDocument, createReadiness, createActivityLog } from '../../../src/js/ui.js';
import { createI18n } from '../_i18n-all.mjs';
import { fakeDocument, FakeElement, find, findAll } from './_helpers.mjs';

test('renderDebug draws session, collections, counts and item rows, and readiness follows the requests', async () => {
  setDocument(fakeDocument());
  const i18n = createI18n({ lang: 'en' });
  const states = [];
  const readiness = createReadiness((s) => states.push(s));
  const activity = createActivityLog();
  const hrefs = ['/alice/work/a.ics', '/alice/work/b.ics'];
  const root = new FakeElement('main');
  let signedOut = 0;
  const ctrl = new AbortController();
  const app = {
    api: { me: async () => ME, meAccess: async () => ({ grants: [] }) },
    dav: {
      listItemEtags: async (h) => (h === '/alice/work/' ? hrefs.map((href) => ({ href })) : []),
      calendarMultiget: async (h, list) => ({ items: list.map((href, i) => ({ href, text: i ? 'RO' : 'ok' })), missing: [] }),
    },
    discover: async () => ({ collections: [coll(), coll({ href: '/bob/shared/', source: 'grant', owner: 'bob', level: 'read', privileges: ['read'], name: 'shared' })], apiError: null, ownError: new DavError('network') }),
    openItem: (text) => (text === 'RO' ? { ok: false, readOnly: true, reason: 'parse-error' } : { ok: true, readOnly: false }),
    readiness,
    activity,
    signOut: () => (signedOut += 1),
    configInfo: [['debug.config.appBase', '/app/']],
    configWarnings: [{ key: 'x', message: 'bad' }],
  };
  const ctl = renderDebug({ root, t: i18n.t, tp: i18n.tp, params: { items: '3' }, signal: ctrl.signal, app });
  assert.equal(ctl.title, 'Diagnostics');
  assert.equal(readiness.state, 'loading');
  for (let i = 0; i < 50 && readiness.state === 'loading'; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(readiness.state, 'ready');
  assert.equal(find(root, 'debug-session-login').textContent, 'alice');
  assert.equal(find(root, 'debug-health').textContent, 'Healthy (generation 2, rights active: Yes, service ok: Yes)');
  assert.equal(find(root, 'debug-health').getAttribute('data-result'), 'ok');
  assert.equal(find(root, 'debug-session-type').textContent, 'Person', 'the account type is localized, not the raw value');
  assert.equal(find(root, 'debug-session-admin').textContent, 'No');
  assert.ok(!/true|false/.test(find(root, 'debug-health').textContent), 'booleans are Yes/No');
  const cols = findAll(root, 'debug-collection');
  assert.equal(cols.length, 2);
  assert.equal(cols[1].getAttribute('data-source'), 'grant');
  assert.equal(findAll(root, 'debug-collection-count')[0].getAttribute('data-count'), '2');
  assert.equal(findAll(root, 'debug-collection-count')[0].textContent, '2 items');
  const rows = findAll(root, 'debug-item-row');
  assert.deepEqual(rows.map((r) => r.getAttribute('data-result')), ['ok', 'readonly']);
  assert.equal(rows[1].getAttribute('data-reason'), 'parse-error');
  assert.match(find(root, 'debug-summary').textContent, /2 collections, 2 items opened, 1 read-only, 0 failed/);
  assert.match(find(root, 'debug-collections-note').textContent, /Your own collections could not be listed \(network error\)/);
  assert.equal(find(root, 'debug-config-appbase').textContent, '/app/');
  assert.ok(find(root, 'debug-config-warnings'));
  assert.equal(find(root, 'debug-progress').getAttribute('data-state'), 'done');
  for (const id of ['debug-refresh', 'debug-signout']) assert.ok(find(root, id), id);
  assert.equal(find(root, 'debug-dialog-test'), null, 'the blocking-dialog button is test scaffolding: hidden by default');
  find(root, 'debug-signout').dispatchEvent(new Event('click'));
  assert.equal(signedOut, 1);
  assert.ok(activity.size >= 4);
});

async function renderOnce({ me = ME, lang = 'en', params = {}, extra = {} } = {}) {
  setDocument(fakeDocument());
  const i18n = createI18n({ lang });
  const readiness = createReadiness(() => {});
  const root = new FakeElement('main');
  const app = {
    api: { me: async () => (me instanceof Error ? Promise.reject(me) : me), meAccess: async () => ({ grants: [] }) },
    dav: {},
    discover: async () => ({ collections: [], apiError: null, ownError: null }),
    openItem: () => ({ ok: true, readOnly: false }),
    readiness,
    activity: createActivityLog(),
    signOut() {},
    configInfo: [],
    configWarnings: [],
    ...extra,
  };
  renderDebug({ root, t: i18n.t, tp: i18n.tp, params, signal: new AbortController().signal, app });
  for (let i = 0; i < 50 && readiness.state === 'loading'; i += 1) await new Promise((r) => setTimeout(r, 5));
  return root;
}

test('the blocking-dialog button shows only with app.debug (config.json "debug": true) or ?debug=1', async () => {
  assert.equal(find(await renderOnce(), 'debug-dialog-test'), null);
  assert.equal(find(await renderOnce({ extra: { debug: false } }), 'debug-dialog-test'), null);
  assert.equal(find(await renderOnce({ params: { debug: '0' } }), 'debug-dialog-test'), null);
  assert.ok(find(await renderOnce({ extra: { debug: true } }), 'debug-dialog-test'));
  assert.ok(find(await renderOnce({ params: { debug: '1' } }), 'debug-dialog-test'));
  assert.ok(find(await renderOnce({ params: { debug: '1' } }), 'debug-signout'), 'the other buttons are unaffected');
});

test('the account type is shown as a localized label, in both languages', async () => {
  const bot = { ...ME, type: 'bot', admin: true };
  assert.equal(find(await renderOnce({ me: bot }), 'debug-session-type').textContent, 'Bot (automated account)');
  assert.equal(find(await renderOnce({ me: bot, lang: 'fr' }), 'debug-session-type').textContent, 'Bot (compte automatisé)');
  assert.equal(find(await renderOnce({ lang: 'fr' }), 'debug-session-type').textContent, 'Personne');
  assert.equal(find(await renderOnce({ me: { ...ME, type: null } }), 'debug-session-type').textContent, '-');
  assert.equal(find(await renderOnce({ me: bot, lang: 'fr' }), 'debug-session-admin').textContent, 'Oui');
});

test('the health card is drawn from me: ok, degraded, unknown; booleans are Yes/No', async () => {
  const card = async (opts) => {
    const root = await renderOnce(opts);
    const el = find(root, 'debug-health');
    return [el.getAttribute('data-result'), el.textContent];
  };
  assert.deepEqual(await card(), ['ok', 'Healthy (generation 2, rights active: Yes, service ok: Yes)']);
  assert.deepEqual(await card({ lang: 'fr' }), ['ok', 'En bonne santé (génération 2, droits actifs : Oui, service ok : Oui)']);
  assert.deepEqual(await card({ me: { ...ME, rightsActive: false } }), ['degraded', 'Reports a problem (generation 2, rights active: No, service ok: Yes)']);
  assert.deepEqual(await card({ me: { ...ME, ok: false, rightsActive: false }, lang: 'fr' }), ['degraded', 'Signale un problème (génération 2, droits actifs : Non, service ok : Non)']);
  // an older server that does not report the fields, and a failing `me`
  assert.deepEqual(await card({ me: { ...ME, rightsActive: null, ok: null } }), ['unknown', 'Not reported by the account service (generation 2, rights active: -, service ok: -)']);
  const [state, text] = await card({ me: new ApiError('network') });
  assert.equal(state, 'unknown');
  assert.ok(!/true|false/.test(text));
});
