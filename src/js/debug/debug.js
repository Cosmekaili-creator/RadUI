// SPDX-License-Identifier: AGPL-3.0-or-later
// `#/debug`: read-only diagnostics for people and agents. Shows who the user
// is (account service `me`), the collections the user can reach (own plus
// grants, through discoverAccessible), the item count of each collection and,
// for the first N items of each, whether the data model opens them (ok, or the
// read-only reason). Nothing is ever written.
//
// collectDiagnostics() is DOM-free and takes every dependency as a parameter so
// it can be tested with fakes; renderDebug() draws the result as it arrives.
// Test ids: debug-screen, debug-session (+ debug-session-<field>), debug-health,
// debug-config, debug-collections, debug-collection (data-href, data-status,
// data-source, data-kind), debug-collection-count, debug-items,
// debug-item-row (data-href, data-result, data-reason), debug-summary,
// debug-progress, debug-refresh, debug-signout, debug-dialog-test,
// debug-dialog, debug-dialog-ack, debug-dialog-confirm.
//
// The health card is built from `me` (rightsActive, ok): the account service's
// health endpoint is loopback-only behind the proxy and is never called from
// the browser. The 'Try the blocking dialog' button (debug-dialog-test) is test
// scaffolding: it is drawn only when config.json says "debug": true or the
// address carries ?debug=1.

import { h, fill, openDialog } from '../ui.js';
import { canWriteItems } from '../dav/client.js';

export const DEFAULT_SAMPLE = 5;
export const MAX_SAMPLE = 50;

const KNOWN_KINDS = new Set(['auth', 'forbidden', 'notfound', 'network', 'server', 'unavailable', 'invalid']);

/** A small, safe description of an error (never the response body). */
export function errorInfo(e) {
  const kind = e && typeof e.kind === 'string' ? e.kind : 'other';
  return { kind: KNOWN_KINDS.has(kind) ? kind : 'other', status: e && Number.isInteger(e.status) ? e.status : null };
}

/** Model kind to open a collection's items with ('event' | 'task' | 'contact' | undefined = infer). */
export function itemKindFor(collection) {
  if (collection.kind === 'addressbook') return 'contact';
  const comps = Array.isArray(collection.components) ? collection.components : [];
  if (comps.length === 1 && comps[0] === 'VEVENT') return 'event';
  if (comps.length === 1 && comps[0] === 'VTODO') return 'task';
  return undefined;
}

/** 'ok' | 'readonly' (+ reason) | 'error' for one item text. */
export function classifyItem(text, kind, openItem) {
  try {
    const r = openItem(text, kind);
    if (!r.ok) return { result: 'readonly', reason: r.reason || 'unknown' };
    if (r.readOnly) return { result: 'readonly', reason: r.readOnlyReason || 'unknown' };
    return { result: 'ok', reason: null };
  } catch (e) {
    return { result: 'error', reason: (e && e.name) || 'exception' };
  }
}

/**
 * Health of the account service as reported inside `me`:
 * {state: 'ok'|'degraded'|'unknown', rightsActive: bool|null, ok: bool|null, generation: number|null}.
 * Any reported false means degraded; nothing reported (older server, or `me`
 * unavailable) means unknown.
 */
export function deriveHealth(me) {
  if (!me || !me.ok) return { state: 'unknown', rightsActive: null, ok: null, generation: null };
  const d = me.data;
  const rightsActive = typeof d.rightsActive === 'boolean' ? d.rightsActive : null;
  const ok = typeof d.ok === 'boolean' ? d.ok : null;
  let state = 'unknown';
  if (rightsActive === false || ok === false) state = 'degraded';
  else if (rightsActive === true || ok === true) state = 'ok';
  return { state, rightsActive, ok, generation: Number.isInteger(d.generation) ? d.generation : null };
}

/**
 * Run all checks. Rejects only for a 401 (the session is invalid) or an abort;
 * every other failure is recorded in the report.
 * @param {object} d
 * @param {{me(): Promise<object>, meAccess(): Promise<object>}} d.api
 * @param {object} d.dav DAV client (listItemEtags, calendarMultiget, addressbookMultiget, ...)
 * @param {(dav: object, api: object) => Promise<{collections: object[], apiError: Error|null, ownError: Error|null}>} d.discover
 * @param {(text: string, kind?: string) => object} d.openItem
 * @param {number} [d.sample] how many items per collection to open
 * @param {AbortSignal} [d.signal]
 * @param {(type: string, payload: object) => void} [d.onEvent] progress: me, health, collections, count, items
 * @param {(entry: {op: string, target?: string, result?: string, detail?: string}) => void} [d.log]
 */
export async function collectDiagnostics({ api, dav, discover, openItem, sample = DEFAULT_SAMPLE, signal, onEvent, log }) {
  const emit = (type, payload) => {
    if (onEvent) onEvent(type, payload);
  };
  const note = (entry) => {
    if (log) log(entry);
  };
  const stopIfAborted = () => {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
  };
  const rethrowAuth = (e) => {
    if (e && e.kind === 'auth') throw e;
  };
  const report = { me: null, health: null, collections: [], discoverErrors: { api: null, own: null }, summary: null };

  const me = await api.me({ signal }).then(
    (data) => ({ ok: true, data }),
    (e) => {
      rethrowAuth(e);
      return { ok: false, error: errorInfo(e) };
    },
  );
  stopIfAborted();
  const health = deriveHealth(me);
  report.me = me;
  report.health = health;
  note({ op: 'me', target: me.ok ? me.data.login : '', result: me.ok ? 'ok' : 'error', detail: me.ok ? '' : me.error.kind });
  note({ op: 'health', result: health.state === 'degraded' ? 'error' : 'info', detail: health.state });
  emit('me', me);
  emit('health', health);

  const found = await discover(dav, api);
  stopIfAborted();
  report.discoverErrors = { api: found.apiError ? errorInfo(found.apiError) : null, own: found.ownError ? errorInfo(found.ownError) : null };
  report.collections = found.collections.map((c) => ({
    href: c.href,
    name: c.displayName || c.name || c.href,
    kind: c.kind || null,
    components: c.components || null,
    source: c.source,
    owner: c.owner || null,
    level: c.level || null,
    status: c.status,
    error: c.error ? errorInfo(c.error) : null,
    writable: c.status === 'ok' ? (c.privileges ? canWriteItems(c) : null) : null,
    count: null,
    countError: null,
    items: [],
    itemsError: null,
  }));
  note({ op: 'discover', target: String(report.collections.length), result: found.ownError && found.apiError ? 'error' : 'ok' });
  emit('collections', report);

  for (const c of report.collections) {
    if (c.status !== 'ok') continue;
    stopIfAborted();
    let hrefs = [];
    try {
      const etags = await dav.listItemEtags(c.href);
      hrefs = etags.map((e) => e.href).sort();
      c.count = hrefs.length;
      note({ op: 'count', target: c.href, result: 'ok', detail: String(c.count) });
    } catch (e) {
      rethrowAuth(e);
      c.countError = errorInfo(e);
      note({ op: 'count', target: c.href, result: 'error', detail: c.countError.kind });
    }
    emit('count', { collection: c });
    stopIfAborted();
    if (!hrefs.length || sample <= 0) {
      emit('items', { collection: c });
      continue;
    }
    const first = hrefs.slice(0, sample);
    try {
      const get = c.kind === 'addressbook' ? dav.addressbookMultiget : dav.calendarMultiget;
      const { items } = await get.call(dav, c.href, first);
      const kind = itemKindFor(c);
      const byHref = new Map(items.map((i) => [i.href, i]));
      for (const href of first) {
        const item = byHref.get(href);
        if (!item) c.items.push({ href, result: 'missing', reason: null });
        else c.items.push({ href, ...classifyItem(item.text, kind, openItem) });
      }
      const bad = c.items.filter((i) => i.result !== 'ok').length;
      note({ op: 'check', target: c.href, result: c.items.some((i) => i.result === 'error') ? 'error' : 'ok', detail: `${c.items.length} opened, ${bad} not ok` });
    } catch (e) {
      rethrowAuth(e);
      c.itemsError = errorInfo(e);
      note({ op: 'check', target: c.href, result: 'error', detail: c.itemsError.kind });
    }
    emit('items', { collection: c });
  }

  report.summary = summarize(report);
  emit('done', report);
  return report;
}

/** Totals for the summary line. */
export function summarize(report) {
  const s = { collections: report.collections.length, items: 0, readonly: 0, failed: 0 };
  for (const c of report.collections) {
    if (c.itemsError) s.failed += 1;
    for (const i of c.items) {
      s.items += 1;
      if (i.result === 'readonly') s.readonly += 1;
      else if (i.result !== 'ok') s.failed += 1;
    }
  }
  return s;
}

// ------------------------------------------------------------------ screen

const lastSegment = (href) => {
  const parts = href.split('/').filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : href;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

function parseSample(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_SAMPLE ? n : DEFAULT_SAMPLE;
}

/**
 * @param {object} ctx
 * @param {HTMLElement} ctx.root
 * @param {(k: string, p?: object) => string} ctx.t
 * @param {(k: string, n: number, p?: object) => string} ctx.tp
 * @param {object} ctx.params   route query; `items=<n>` sets the sample size (0-50), `debug=1` shows the test scaffolding
 * @param {AbortSignal} ctx.signal aborted when the user leaves the screen
 * @param {object} ctx.app {api, dav, discover, openItem, readiness, activity, signOut(), configInfo: [[label key, value]], configWarnings, debug}
 */
export function renderDebug(ctx) {
  const { root, t, tp, app } = ctx;
  const sample = parseSample(ctx.params.items);
  const showScaffolding = app.debug === true || ctx.params.debug === '1';
  let run = 0;
  let runAbort = null;

  const kindText = (info) => t(`err.kind.${info.kind}`);
  const kv = (labelKey, value, testid, extra) => h('div', { class: 'kv', 'data-field': testid ? testid.replace(/^debug-/, '') : null }, h('dt', null, t(labelKey)), h('dd', { testid, ...(extra || {}) }, value));

  const progress = h('p', { class: 'muted', testid: 'debug-progress' }, t('debug.running'));
  const summary = h('p', { class: 'debug__summary', testid: 'debug-summary' });
  const sessionBody = h('dl', { class: 'kvs', testid: 'debug-session' });
  const healthBody = h('p', { testid: 'debug-health' }, '…');
  const collectionsBody = h('ul', { class: 'debug__collections', testid: 'debug-collections' });
  const collectionsNote = h('p', { class: 'notice', testid: 'debug-collections-note', hidden: true });
  const refresh = h('button', { type: 'button', class: 'btn', testid: 'debug-refresh', on: { click: () => start() } }, t('debug.refresh'));
  const dialogTest = showScaffolding ? h('button', { type: 'button', class: 'btn', testid: 'debug-dialog-test', on: { click: openTestDialog } }, t('debug.dialogTest')) : null;
  const signout = h('button', { type: 'button', class: 'btn btn--quiet', testid: 'debug-signout', on: { click: () => app.signOut() } }, t('debug.signout'));

  const configRows = (app.configInfo || []).map(([key, value]) => kv(key, String(value), `debug-config-${key.split('.').pop().toLowerCase()}`));
  const configWarnings = (app.configWarnings || []).length
    ? h('div', { class: 'notice notice--warn', testid: 'debug-config-warnings' }, h('strong', null, t('debug.config.warnings')), h('ul', null, app.configWarnings.map((w) => h('li', null, w.key ? `${w.key}: ${w.message}` : w.message))))
    : null;

  root.append(
    h(
      'section',
      { class: 'debug', testid: 'debug-screen', 'aria-labelledby': 'debug-title' },
      h('h1', { class: 'page-title', id: 'debug-title', tabindex: '-1' }, t('debug.title')),
      h('p', { class: 'muted' }, t('debug.intro')),
      h('div', { class: 'debug__toolbar' }, refresh, dialogTest, signout),
      progress,
      h('section', { class: 'card', 'aria-labelledby': 'debug-session-h' }, h('h2', { class: 'section-title', id: 'debug-session-h' }, t('debug.session')), sessionBody),
      h('section', { class: 'card', 'aria-labelledby': 'debug-health-h' }, h('h2', { class: 'section-title', id: 'debug-health-h' }, t('debug.health')), healthBody),
      h('section', { class: 'card', 'aria-labelledby': 'debug-config-h' }, h('h2', { class: 'section-title', id: 'debug-config-h' }, t('debug.config')), h('dl', { class: 'kvs', testid: 'debug-config' }, configRows), configWarnings),
      h('section', { class: 'card', 'aria-labelledby': 'debug-coll-h' }, h('h2', { class: 'section-title', id: 'debug-coll-h' }, t('debug.collections')), summary, collectionsNote, collectionsBody),
    ),
  );

  function openTestDialog() {
    const ack = h('input', { type: 'checkbox', id: 'debug-dialog-ack-input', testid: 'debug-dialog-ack', 'data-autofocus': '' });
    const dlg = openDialog({
      testid: 'debug-dialog',
      title: t('debug.dialog.title'),
      description: t('debug.dialog.body'),
      dismissible: false,
      body: [h('div', { class: 'check' }, ack, h('label', { for: 'debug-dialog-ack-input' }, t('debug.dialog.ack')))],
      actions: [{ testid: 'debug-dialog-confirm', label: t('debug.dialog.confirm'), kind: 'primary', disabled: true }],
    });
    ack.addEventListener('change', () => {
      dlg.buttons['debug-dialog-confirm'].disabled = !ack.checked;
    });
  }

  function drawMe(me) {
    if (!me.ok) {
      fill(sessionBody, h('div', { class: 'notice notice--warn', testid: 'debug-session-limited' }, t('debug.session.limited') + ` (${kindText(me.error)})`));
      return;
    }
    const d = me.data;
    fill(
      sessionBody,
      kv('debug.session.login', d.login, 'debug-session-login'),
      kv('debug.session.name', d.displayName, 'debug-session-name'),
      kv('debug.session.type', d.type ? t(`account.type.${d.type}`) : '-', 'debug-session-type'),
      kv('debug.session.admin', t(d.admin ? 'common.yes' : 'common.no'), 'debug-session-admin'),
      kv('debug.session.ownSpace', t(d.ownSpace ? 'common.yes' : 'common.no'), 'debug-session-ownspace'),
      kv('debug.session.generation', d.generation === null ? '-' : d.generation, 'debug-session-generation'),
      kv('debug.session.source', t('debug.source.backend'), 'debug-session-source'),
    );
  }

  function drawHealth(health) {
    const yn = (v) => (v === null || v === undefined ? '-' : t(v ? 'common.yes' : 'common.no'));
    healthBody.textContent = `${t(`debug.health.${health.state}`)} (${t('debug.health.detail', { generation: health.generation ?? '-', rights: yn(health.rightsActive), ok: yn(health.ok) })})`;
    healthBody.setAttribute('data-result', health.state);
  }

  const itemText = (i) => {
    if (i.result === 'ok') return t('debug.item.ok');
    if (i.result === 'readonly') return t('debug.item.readonly', { reason: i.reason });
    if (i.result === 'missing') return t('debug.item.missing');
    return t('debug.item.error', { reason: i.reason });
  };

  function drawCollection(c) {
    const access = c.writable === true ? 'debug.coll.access.rw' : c.writable === false ? 'debug.coll.access.ro' : 'debug.coll.access.unknown';
    const statusText = c.status === 'error' && c.error ? t('debug.coll.status.error', { kind: kindText(c.error) }) : t(`debug.coll.status.${c.status}`);
    let countText;
    if (c.status !== 'ok') countText = '-';
    else if (c.countError) countText = t('debug.coll.countFailed', { kind: kindText(c.countError) });
    else if (c.count === null) countText = t('debug.coll.countPending');
    else countText = tp('debug.coll.count', c.count);
    const checked = c.items.length;
    const ok = c.items.filter((i) => i.result === 'ok').length;
    const ro = c.items.filter((i) => i.result === 'readonly').length;
    return h(
      'li',
      { class: 'coll', testid: 'debug-collection', 'data-href': c.href, 'data-status': c.status, 'data-source': c.source, 'data-kind': c.kind || '' },
      h('h3', { class: 'coll__name' }, c.name),
      h(
        'dl',
        { class: 'kvs kvs--tight' },
        kv('debug.coll.kind', c.kind ? t(`debug.coll.kind.${c.kind}`) : '-', null),
        kv('debug.coll.source', t(`debug.coll.source.${c.source}`), null),
        kv('debug.coll.owner', c.owner || '-', null),
        kv('debug.coll.access', t(access), null, { 'data-writable': String(c.writable) }),
        kv('debug.coll.status', statusText, null),
        kv('debug.coll.count', countText, 'debug-collection-count', { 'data-count': c.count === null ? '' : String(c.count) }),
      ),
      c.itemsError ? h('p', { class: 'muted' }, t('debug.item.error', { reason: kindText(c.itemsError) })) : null,
      checked ? h('p', { class: 'muted', testid: 'debug-collection-checked' }, t('debug.coll.checked', { n: checked, ok, readonly: ro, failed: checked - ok - ro })) : null,
      checked
        ? h(
            'ul',
            { class: 'coll__items', testid: 'debug-items' },
            c.items.map((i) => h('li', { class: `item item--${i.result}`, testid: 'debug-item-row', 'data-href': i.href, 'data-result': i.result, 'data-reason': i.reason || '' }, h('span', { class: 'item__name' }, lastSegment(i.href)), ' ', h('span', { class: 'item__text' }, itemText(i)))),
          )
        : null,
    );
  }

  function drawCollections(report) {
    const notes = [];
    if (report.discoverErrors.api) notes.push(t('debug.collections.apiError', { kind: kindText(report.discoverErrors.api) }));
    if (report.discoverErrors.own) notes.push(t('debug.collections.ownError', { kind: kindText(report.discoverErrors.own) }));
    collectionsNote.textContent = notes.join(' ');
    collectionsNote.hidden = notes.length === 0;
    if (!report.collections.length) {
      fill(collectionsBody, h('li', { class: 'muted', testid: 'debug-collections-empty' }, t('debug.collections.none')));
      return;
    }
    fill(collectionsBody, report.collections.map(drawCollection));
  }

  function drawSummary(report) {
    const s = summarize(report);
    summary.textContent = t('debug.summary', s);
  }

  async function start() {
    if (runAbort) runAbort.abort();
    const mine = ++run;
    runAbort = new AbortController();
    const abort = runAbort;
    ctx.signal.addEventListener('abort', () => abort.abort(), { once: true });
    const end = app.readiness.begin();
    progress.textContent = t('debug.running');
    progress.setAttribute('data-state', 'running');
    refresh.disabled = true;
    fill(sessionBody);
    healthBody.textContent = '…';
    fill(collectionsBody);
    summary.textContent = '';
    try {
      await collectDiagnostics({
        api: app.api,
        dav: app.dav,
        discover: app.discover,
        openItem: app.openItem,
        sample,
        signal: abort.signal,
        log: (e) => app.activity.add(e),
        onEvent(type, payload) {
          if (mine !== run) return;
          if (type === 'me') drawMe(payload);
          else if (type === 'health') drawHealth(payload);
          else if (type === 'collections' || type === 'count' || type === 'items') {
            // redraw from the live report object
            if (type === 'collections') currentReport = payload;
            drawCollections(currentReport);
            drawSummary(currentReport);
          }
        },
      });
      if (mine !== run) return end(true);
      progress.textContent = t('debug.done');
      progress.setAttribute('data-state', 'done');
      end(true);
    } catch (e) {
      if (mine !== run) return end(true);
      if (e && (e.name === 'AbortError' || e.kind === 'auth')) return end(true); // left the screen, or the session ended
      progress.textContent = t('debug.error.generic', { kind: kindText(errorInfo(e)) });
      progress.setAttribute('data-state', 'error');
      app.activity.add({ op: 'discover', target: '', result: 'error', detail: errorInfo(e).kind });
      end(false);
    } finally {
      if (mine === run) refresh.disabled = false;
    }
  }
  let currentReport = { collections: [], discoverErrors: { api: null, own: null } };

  start();
  return { title: t('debug.title') };
}
