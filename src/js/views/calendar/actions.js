// SPDX-License-Identifier: AGPL-3.0-or-later
// What the buttons of the event detail do (RUN3 WP B3a): edit (scope question for a series), delete (a named
// confirmation, or the scope dialog for a series), move to another calendar and export. Every write goes through
// the store's write path (ctx.app.getStore().writes); this file only asks the questions and shows conflicts.
//
// Interface used from WP B3b: `./scopedialog.js` exports `askScope({mode: 'edit' | 'delete', isFirst, title, t}) ->
// Promise<'this' | 'following' | 'all' | null>` (dialog ids dialog-scope-edit / dialog-scope-delete, buttons
// scope-this, scope-following, scope-all, scope-cancel). When the module is absent a plain dialog with the same ids
// and buttons stands in, so this file works on its own.

import { h, openDialog } from '../../ui.js';
import { confirmDialog } from '../../widgets/dialogs.js';
import { isolate } from '../../widgets/avatar.js';
import { availableScopes, isRecurring, planDelete } from '../../calendar/scope.js';
import { openConflictDialog, modeOf } from '../conflictdialog.js';
import { downloadText } from '../download.js';
import { hashFor } from '../../router.js';
import { cleanQuery } from './common.js';

export const defaultActionDeps = () => ({
  loadScopeDialog: () => import('./scopedialog.js'),
  openConflictDialog,
  downloadText,
  win: globalThis.window,
  doc: globalThis.document,
});

/** The edit form route of an occurrence: `#/events/<key>/edit?cal=&occ=&scope=`. */
export const editHashOf = (key, { cal, occ, scope }) => hashFor('/events/:key/edit', { key }, cleanQuery({ cal, occ: occ === 'single' ? '' : occ, scope }));

/** The scope question: B3b's dialog when present, else a plain one with the same ids. */
export async function askScopeWith(deps, opts) {
  try {
    const mod = await deps.loadScopeDialog();
    if (mod && typeof mod.askScope === 'function') return await mod.askScope(opts);
  } catch {
    /* the module is not delivered (yet): the plain dialog below */
  }
  return plainScopeDialog(opts, deps.win);
}

function plainScopeDialog({ mode, isFirst, title, t }, win) {
  return new Promise((resolve) => {
    let answer = null;
    const pick = (value) => () => {
      answer = value;
    };
    const actions = [
      { testid: 'scope-this', label: t(`cal.scope.${mode}.this`), kind: 'primary', onClick: pick('this') },
      ...(isFirst ? [] : [{ testid: 'scope-following', label: t(`cal.scope.${mode}.following`), onClick: pick('following') }]),
      { testid: 'scope-all', label: t(`cal.scope.${mode}.all`), onClick: pick('all') },
      { testid: 'scope-cancel', label: t('dialog.cancel'), cancel: true },
    ];
    openDialog({ testid: `dialog-scope-${mode}`, title: t(`cal.scope.${mode}.title`, { name: title }), description: t('cal.scope.text'), actions, focus: 'cancel', win, onClose: () => resolve(answer) });
  });
}

/**
 * @param {object} o
 * @param {object} o.app @param {object} o.storeCtx @param {object} o.source
 * @param {Function} o.t
 * @param {object} [o.deps] defaultActionDeps overrides (tests)
 */
export function createEventActions({ app, storeCtx, source, t, deps = {} }) {
  const d = { ...defaultActionDeps(), ...deps };
  const writes = () => storeCtx.writes;
  const baseOf = (m) => ({ text: m.entry.text, etag: m.entry.etag });

  async function conflictOf(res, label) {
    return d.openConflictDialog({ conflict: res, t, writes: writes(), label, feedback: app.feedback, win: d.win });
  }

  return {
    /** Edit: for a series ask the scope first. Resolves the hash to go to, or null when cancelled / not allowed. */
    async editTarget(model) {
      const { item, rec, occ, collection } = model;
      const params = { cal: collection.href, occ: rec.occParam };
      if (!isRecurring(item)) return editHashOf(rec.routeKey, params);
      const scopes = availableScopes(item, occ, 'edit');
      if (!scopes.length) return null;
      let scope = scopes[0];
      if (scopes.length > 1) {
        scope = await askScopeWith(d, { mode: 'edit', isFirst: !scopes.includes('following'), title: isolate(rec.title), t });
        if (!scope) return null;
      }
      return editHashOf(rec.routeKey, { ...params, scope });
    },

    /** Delete. Resolves `{done: true}` when something was deleted, `{done: false}` otherwise (cancelled, refused, kept). */
    async remove(model) {
      const { item, rec, occ, collection, entry } = model;
      const named = isolate(rec.title);
      let scope = 'all';
      const scopes = isRecurring(item) ? availableScopes(item, occ, 'delete') : [];
      if (scopes.length > 1) {
        scope = await askScopeWith(d, { mode: 'delete', isFirst: !scopes.includes('following'), title: named, t });
        if (!scope) return { done: false };
      }
      const plan = planDelete(item, { scope, occ });
      if (!plan.ok) {
        app.feedback.setAlert(t('cal.err.deleteRefused', { reason: plan.message || plan.code }));
        return { done: false };
      }
      if (plan.action === 'ops') {
        const res = await writes().applyOps({ collection: collection.href, href: entry.href, base: baseOf(model), ops: plan.ops, statusKey: 'store.status.deleted' });
        if (modeOf(res)) {
          const out = await conflictOf(res, rec.title);
          return { done: Boolean(out && out.ok), result: out };
        }
        return { done: Boolean(res && res.ok), result: res };
      }
      const yes = await confirmDialog({
        testid: 'dialog-delete-event',
        confirmTestid: 'dialog-confirm-delete',
        cancelTestid: 'dialog-cancel',
        title: t('cal.delete.title', { name: named }),
        message: isRecurring(item) ? t('cal.delete.textSeries') : t('cal.delete.text'),
        confirmLabel: t('cal.delete.confirm', { name: named }),
        cancelLabel: t('dialog.cancel'),
        danger: true,
        write: true,
        t,
        win: d.win,
      });
      if (!yes) return { done: false };
      let res = await writes().deleteItem({ collection: collection.href, href: entry.href, etag: entry.etag, uid: item.uid });
      if (res && res.status === 'changed-elsewhere') res = await conflictOf(res, rec.title);
      const ok = Boolean(res && res.ok && (res.status === 'deleted' || res.status === 'already-deleted'));
      return { done: ok, result: res };
    },

    /** Move to another writable calendar through a named dialog. Resolves `{done}`. */
    async move(model) {
      const { rec, collection, entry } = model;
      const targets = source.writable().filter((c) => c.href.replace(/\/$/, '') !== collection.href.replace(/\/$/, ''));
      if (!targets.length) return { done: false };
      const select = h('select', { class: 'input', id: 'cal-move-target', testid: 'field-move-target', 'aria-label': t('cal.move.target') }, ...targets.map((c) => h('option', { value: c.href }, c.label || c.displayName || c.name || c.href)));
      let chosen = null;
      await new Promise((resolve) => {
        openDialog({
          testid: 'dialog-move-event',
          title: t('cal.move.title', { name: isolate(rec.title) }),
          description: t('cal.move.text'),
          body: [h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'cal-move-target' }, t('cal.move.target')), select)],
          actions: [
            {
              testid: 'dialog-confirm-move',
              label: t('cal.move.confirm'),
              kind: 'primary',
              write: true,
              onClick: () => {
                chosen = select.value;
              },
            },
            { testid: 'dialog-cancel', label: t('dialog.cancel'), cancel: true },
          ],
          focus: 'field-move-target',
          win: d.win,
          onClose: () => resolve(),
        });
      });
      if (!chosen) return { done: false };
      let res = await writes().moveItem({ from: collection.href, to: chosen, href: entry.href, base: baseOf(model) });
      if (modeOf(res)) res = await conflictOf(res, rec.title);
      return { done: Boolean(res && res.ok), result: res, to: chosen };
    },

    /** Export one event as a `.ics` file. */
    exportIt(model) {
      const { rec, entry, item } = model;
      const res = storeCtx.exportItem({ text: entry.text, displayName: rec.title || 'event', kind: 'calendar', target: item.uid || '' });
      const out = d.downloadText({ text: res.text, mime: res.mime, filename: res.filename, doc: d.doc, win: d.win });
      if (!out.ok) app.feedback.setAlert(t('cal.err.export'));
      return out;
    },
  };
}
