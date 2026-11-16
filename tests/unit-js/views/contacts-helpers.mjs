// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the contact screen tests: the fake DOM, a REAL write path and item store over the
// in-memory DAV server of the store tests, a screen context shaped like the shell's, and small query helpers.
// No tests in here.
import { createI18n } from '../_i18n-all.mjs';
import { createReadiness, writeGate } from '../../../src/js/ui.js';
import { exportCollection, exportItem } from '../../../src/js/store/export.js';
import { makeDom, fakeTimers, one } from '../widgets/_dom.mjs';
import { COLL, FakeApi, card, groupCard, makeEnv, model } from '../store/_helpers.mjs';

export { COLL, card, groupCard, one };
export const doc = makeDom();
export const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
export const U1 = 'urn:uuid:11111111-2222-3333-4444-555555555501';
export const U2 = 'urn:uuid:11111111-2222-3333-4444-555555555502';
export const U3 = 'urn:uuid:11111111-2222-3333-4444-555555555503';

export const JANE = card(U1, 'Jane Doe', 'N:Doe;Jane;;;\nTEL;TYPE=CELL:+1 555 0100\nEMAIL;TYPE=HOME:jane@example.org\nORG:Example Org\nNOTE:Line one\\nLine two\n');
export const JOHN = card(U2, 'John Smith', 'N:Smith;John;;;\nEMAIL:john@example.org\n');
export const FAMILY = groupCard(U3, 'Family', [U1], true);

/** Everything a screen needs: a store context over the fake server, a shell-like ctx builder, spies. */
export async function setup({ items = { 'jane.vcf': JANE, 'john.vcf': JOHN }, level = 'own', lang = 'en', online = true, load = false, ownSpace = true } = {}) {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
  writeGate.setReason('offline', null);
  writeGate.setReason('readonly', null);
  const env = await makeEnv({ items, level, load, api: new FakeApi({ ownSpace }) });
  const i18n = createI18n({ lang });
  const t = (k, p) => i18n.t(k, p);
  const tp = (k, n, p) => i18n.tp(k, n, p);
  env.reporter.setTranslator(t);
  const storeCtx = {
    session: env.session,
    reporter: env.reporter,
    access: env.access,
    stores: env.stores,
    scheduler: env.scheduler,
    writes: env.writes,
    setTranslator: (fn) => env.reporter.setTranslator(fn),
    exportCollection: (opts) => exportCollection({ client: env.server.client, reporter: env.reporter, store: env.stores.get(opts.collection.href), ...opts }),
    exportItem: (opts) => exportItem({ reporter: env.reporter, ...opts }),
  };
  const timers = fakeTimers();
  const navs = [];
  const dirty = [];
  const downloads = [];
  const main = doc.createElement('main');
  doc.body.append(main);
  const app = {
    lang,
    session: env.session,
    getStore: async () => storeCtx,
    readiness: createReadiness(() => {}),
    feedback: env.feedback,
    gate: writeGate,
    openItem: (text, kind) => model.openItem(text, kind),
    navigate: (hash, opts) => navs.push({ hash, opts }),
    setDirty: (v) => dirty.push(Boolean(v)),
    firstWeekday: 1,
  };
  const deps = {
    doc,
    win: {},
    timers,
    debounceMs: 10,
    isOnline: () => online,
    now: () => new Date(2026, 5, 15),
    yieldFn: () => Promise.resolve(),
    downloadText: (o) => {
      downloads.push(o);
      return { ok: true, filename: o.filename, bytes: o.text.length };
    },
    loadImportDialog: async () => ({ openImportDialog: (a) => (deps.imported = a) }),
  };
  const ctx = (params = {}, route = { name: 'contacts' }, extra = {}) => ({ root: main, t, tp, params, route, host: 'example.org', restore: null, signal: new AbortController().signal, app, ...extra });
  return { env, storeCtx, ctx, deps, navs, dirty, downloads, timers, t, tp, main, app, i18n };
}

export const q = (root, id) => root.querySelector(`[data-testid="${id}"]`);
export const qa = (root, id) => root.querySelectorAll(`[data-testid="${id}"]`);
export const txt = (root, id) => (q(root, id) ? q(root, id).textContent : null);
export const names = (root) => qa(root, 'contact-row').map((r) => r.textContent);
