// SPDX-License-Identifier: AGPL-3.0-or-later
// Rows of the collections list and the lazy item counts. DOM through h() only: every name, description and
// colour that comes from the server is text or a whitelisted CSS custom property.
//
// Test ids: collection-row (data-href, data-kind, data-owner, data-level, data-components), collection-name,
// collection-type, collection-count (aria-busy, data-count), collection-desc, coll-owner, coll-readonly,
// shared-with, collection-tech, btn-open-collection, btn-edit-collection, btn-import, btn-share, btn-export,
// btn-delete-collection.

import { h } from '../../ui.js';
import { isolate } from '../../widgets/avatar.js';
import { COLOUR_ALLOW, componentsAttr, labelOf, leafOfHref, pool, typeOf } from './model.js';

let rowSeq = 0;

/** Write the outcome of a count into its element. */
export function setCount(el, n, { t, tp }) {
  el.setAttribute('aria-busy', 'false');
  if (n === null) {
    el.setAttribute('data-count', '');
    el.setAttribute('data-state', 'error');
    el.textContent = t('coll.count.failed');
    return;
  }
  el.setAttribute('data-count', String(n));
  el.setAttribute('data-state', 'done');
  el.textContent = tp('coll.count', n);
}

function sharedWith(c, grants, { t }) {
  if (c.level !== 'own' || !grants || grants.state === 'none') return null;
  if (grants.state === 'unavailable') {
    return h('p', { class: 'crow__shared is-private', testid: 'shared-with', 'data-state': 'unavailable' }, t('coll.shared.unavailable'));
  }
  const name = leafOfHref(c.href);
  const list = grants.byName.get(name) || [];
  if (!list.length) return h('p', { class: 'crow__shared is-private', testid: 'shared-with', 'data-count': '0' }, t('coll.shared.private'));
  const parts = [];
  list.forEach((g, i) => {
    if (i) parts.push(', ');
    parts.push(h('span', { class: 'crow__grantee', 'data-login': g.grantee }, h('strong', null, g.grantee), ` (${t(`coll.level.${g.level}`)})`));
  });
  return h('p', { class: 'crow__shared', testid: 'shared-with', 'data-count': String(list.length) }, h('span', { class: 'crow__shared-label' }, t('coll.shared.with')), ' ', parts);
}

/**
 * One list row.
 * @param {object} c entry of the access list
 * @param {object} o {t, tp, grants, handlers: {edit, import, export, delete}}
 * @returns {{el: HTMLElement, count: HTMLElement}}
 */
export function renderRow(c, { t, tp, grants, handlers }) {
  const name = labelOf(c);
  const iso = isolate(name);
  const isBook = c.kind === 'addressbook';
  const own = c.level === 'own';
  const canWrite = c.level === 'own' || c.level === 'readwrite';
  const id = `crow-name-${++rowSeq}`;

  const count = h('span', { class: 'crow__count', testid: 'collection-count', 'aria-busy': 'true', 'data-count': '' }, t('coll.count.pending'));
  const meta = [h('span', { testid: 'collection-type' }, t(`coll.type.${typeOf(c)}`)), count];
  if (!own) meta.push(h('span', { class: 'tag tag--quiet', testid: 'coll-owner' }, t('coll.ownedBy', { owner: c.owner || '?' })));
  if (c.level === 'read') meta.push(h('span', { class: 'tag', testid: 'coll-readonly' }, t('coll.readOnly')));

  const actions = [];
  if (isBook) {
    actions.push(h('a', { class: 'btn', href: `#/contacts?ab=${encodeURIComponent(c.href)}`, testid: 'btn-open-collection', 'aria-label': t('coll.openNamed', { name: iso }) }, t('coll.open')));
  }
  if (own) actions.push(h('button', { type: 'button', class: 'btn', testid: 'btn-edit-collection', write: true, 'aria-label': t('coll.editNamed', { name: iso }), on: { click: () => handlers.edit(c) } }, t('coll.edit')));
  if (canWrite) actions.push(h('button', { type: 'button', class: 'btn', testid: 'btn-import', write: true, 'aria-label': t('coll.importInto', { name: iso }), on: { click: () => handlers.import(c) } }, t('coll.import')));
  if (own && handlers.share) actions.push(h('button', { type: 'button', class: 'btn', testid: 'btn-share', 'aria-label': t('share.openNamed', { name: iso }), on: { click: () => handlers.share(c) } }, t('share.open')));
  actions.push(h('button', { type: 'button', class: 'btn', testid: 'btn-export', 'aria-label': t('coll.exportNamed', { name: iso }), on: { click: () => handlers.export(c) } }, t('coll.export')));
  if (own) actions.push(h('button', { type: 'button', class: 'btn btn--danger-quiet', testid: 'btn-delete-collection', write: true, 'aria-label': t('coll.deleteNamed', { name: iso }), on: { click: () => handlers.delete(c) } }, t('coll.delete')));

  const tech = h(
    'details',
    { class: 'crow__tech', testid: 'collection-tech' },
    h('summary', { testid: 'collection-tech-toggle' }, t('coll.tech.title')),
    h(
      'dl',
      { class: 'crow__techlist' },
      h('div', null, h('dt', null, t('coll.tech.href')), h('dd', { testid: 'collection-href' }, c.href)),
      h('div', null, h('dt', null, t('coll.tech.ctag')), h('dd', { testid: 'collection-ctag' }, c.ctag || '-')),
      h('div', null, h('dt', null, t('coll.tech.syncToken')), h('dd', { testid: 'collection-sync-token' }, c.syncToken || '-')),
    ),
  );

  const el = h(
    'li',
    { class: 'crow', testid: 'collection-row', 'data-href': c.href, 'data-kind': c.kind, 'data-owner': c.owner || '', 'data-level': c.level, 'data-components': componentsAttr(c) },
    h('span', { class: ['crow__swatch', isBook && 'crow__swatch--book'], 'aria-hidden': 'true', vars: !isBook && c.color ? { allow: COLOUR_ALLOW, values: { '--cal': String(c.color) } } : null }),
    h(
      'div',
      { class: 'crow__main' },
      h('h3', { class: 'crow__name', id, testid: 'collection-name' }, h('bdi', null, name)),
      h('p', { class: 'crow__meta' }, meta),
      c.description ? h('p', { class: 'crow__desc', testid: 'collection-desc' }, c.description) : null,
      sharedWith(c, grants, { t }),
      tech,
    ),
    h('div', { class: 'crow__actions' }, actions),
  );
  return { el, count };
}

/**
 * Depth-1 ETag listing of every row, two at a time. A failure marks that row only.
 * @param {{c: object, count: HTMLElement}[]} rows
 */
export async function loadCounts(rows, { dav, signal, t, tp, concurrency = 2, onCount = null }) {
  await pool(
    rows,
    concurrency,
    async (row) => {
      let n = null;
      try {
        n = (await dav.listItemEtags(row.c.href)).length;
      } catch (e) {
        if (e && e.name === 'DavError' && e.kind === 'auth') throw e;
        n = null;
      }
      if (signal && signal.aborted) return;
      setCount(row.count, n, { t, tp });
      if (onCount) onCount(row.c, n);
    },
    signal,
  );
}
