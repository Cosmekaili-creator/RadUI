// SPDX-License-Identifier: AGPL-3.0-or-later
// Delete a collection: a typed-name confirmation (widgets/dialogs) that shows a FRESH item count, the people who
// lose access, an "Export first" button and passes the ETag it saw when it opened as `expectedEtag`. A changed
// collection (412) re-opens the dialog with the new count. After the delete, grants that could not be revoked
// are shown as a persistent alert. The delete itself is `writes.deleteCollection`; nothing is sent from here.
//
// Test ids: dialog-delete-collection, delete-count (data-count), delete-shared, delete-changed,
// btn-export-first, delete-export-status, field-confirm-name, dialog-confirm-delete, dialog-cancel.

import { h } from '../../ui.js';
import { typedConfirmDialog } from '../../widgets/dialogs.js';
import { isolate } from '../../widgets/avatar.js';
import { exportToFile } from './exporter.js';
import { ensureAlert, grantsLeftText, labelOf, leafOfHref, typedNameFor } from './model.js';

/** Fresh facts for the dialog: ETag (required), item count and grantees (either may be unknown). */
export async function prepareDelete({ app, store, collection }) {
  const owner = String((store.access && store.access.me && store.access.me.login) || (store.session && store.session.login) || '').toLowerCase();
  const name = leafOfHref(collection.href);
  const [coll, items, grants] = await Promise.allSettled([
    app.dav.getCollection(collection.href),
    app.dav.listItemEtags(collection.href),
    app.api && owner ? app.api.grants({ owner }) : Promise.reject(new Error('no account service')),
  ]);
  if (coll.status !== 'fulfilled') return { ok: false, error: coll.reason };
  if (!coll.value.etag) return { ok: false, error: new Error('no etag') };
  return {
    ok: true,
    etag: coll.value.etag,
    count: items.status === 'fulfilled' ? items.value.length : null,
    grantees: grants.status === 'fulfilled' ? grants.value.filter((g) => g.collection === name && String(g.owner).toLowerCase() === owner && g.level && g.level !== 'none') : null,
  };
}

/**
 * @param {object} o
 * @param {object} o.ctx screen context ({app, t, tp})
 * @param {object} o.store the store context (access, writes, exportCollection)
 * @param {object} o.collection access-list entry (must be owned)
 * @param {object} [o.win]
 * @returns {Promise<{deleted: boolean, cancelled?: boolean, result?: object, error?: boolean}>}
 */
export async function openDeleteDialog({ ctx, store, collection, win, _changed = null }) {
  const { app, t, tp } = ctx;
  const { deleteCollection } = store.writes;
  const label = labelOf(collection);
  const iso = isolate(label);
  const prep = await prepareDelete({ app, store, collection });
  if (!prep.ok) {
    ensureAlert(app.feedback, t('coll.delete.prepareFailed', { name: iso }));
    return { deleted: false, error: true };
  }

  const countEl = h('p', { class: 'delete__count', testid: 'delete-count', 'data-count': prep.count === null ? '' : String(prep.count) }, prep.count === null ? t('coll.delete.countUnknown') : tp('coll.delete.count', prep.count, { name: iso }));
  const sharedEl =
    prep.grantees === null
      ? h('p', { class: 'notice notice--warn', testid: 'delete-shared', 'data-state': 'unknown' }, t('coll.delete.sharedUnknown'))
      : prep.grantees.length
        ? h(
            'div',
            { class: 'notice notice--warn', testid: 'delete-shared', 'data-count': String(prep.grantees.length) },
            h('p', null, t('coll.delete.shared')),
            h('ul', null, prep.grantees.map((g) => h('li', { 'data-login': g.grantee }, h('strong', null, g.grantee), ` (${t(`coll.level.${g.level}`)})`))),
          )
        : null;
  const changedEl = _changed ? h('p', { class: 'notice notice--warn', testid: 'delete-changed', tabindex: '-1' }, t('coll.delete.changed', { n: prep.count ?? '?' })) : null;
  const exportStatus = h('p', { class: 'field__hint', role: 'status', testid: 'delete-export-status' });
  const exportBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      testid: 'btn-export-first',
      on: {
        click: async () => {
          exportBtn.disabled = true;
          exportBtn.setAttribute('aria-busy', 'true');
          exportStatus.textContent = t('coll.delete.exporting');
          const out = await exportToFile({ store, collection, includeGroups: true, t });
          exportStatus.textContent = out.text;
          exportBtn.disabled = false;
          exportBtn.removeAttribute('aria-busy');
        },
      },
    },
    t('coll.delete.exportFirst'),
  );
  const body = [
    changedEl,
    h('p', { class: 'notice notice--warn' }, t('coll.delete.irreversible')),
    countEl,
    sharedEl,
    collection.kind === 'addressbook' ? h('p', { class: 'field__hint' }, t('coll.delete.backupGroups')) : null,
    h('div', { class: 'delete__export' }, exportBtn, exportStatus),
  ];

  const expected = typedNameFor(collection);
  const technical = expected !== collection.displayName;
  const ok = await typedConfirmDialog({
    testid: 'dialog-delete-collection',
    inputTestid: 'field-confirm-name',
    confirmTestid: 'dialog-confirm-delete',
    title: t('coll.delete.title', { name: iso }),
    message: t(technical ? 'coll.delete.typeTechnical' : 'coll.delete.type', { name: iso }),
    expected,
    label: t(technical ? 'coll.delete.labelTechnical' : 'coll.delete.label'),
    confirmLabel: t('coll.deleteNamed', { name: iso }),
    body,
    t,
    win,
  });
  if (!ok) return { deleted: false, cancelled: true };

  const end = app.readiness.begin();
  if (app.feedback) app.feedback.setStatus(t('coll.delete.running', { name: iso }));
  let res;
  try {
    res = await deleteCollection({ href: collection.href, kind: collection.kind, expectedEtag: prep.etag });
  } catch {
    end(false);
    ensureAlert(app.feedback, t('coll.delete.failed'));
    return { deleted: false, error: true };
  }
  end(res.ok || res.status === 'changed');
  if (res.status === 'changed') return openDeleteDialog({ ctx, store, collection, win, _changed: res });
  if (res.ok) {
    const left = grantsLeftText(res, t, leafOfHref(collection.href));
    if (left) ensureAlert(app.feedback, left, { scope: null });
    return { deleted: true, result: res };
  }
  if (res.status !== 'auth') ensureAlert(app.feedback, res.message || t('coll.delete.failed'));
  return { deleted: false, result: res };
}
