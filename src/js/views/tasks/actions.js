// SPDX-License-Identifier: AGPL-3.0-or-later
// What the task buttons do (RUN3 WP C1): one-tap complete / reopen and delete. Every write goes through the store's
// write path (`ctx.app.getStore().writes`); this file only asks the questions and shows conflicts.
//
// complete / reopen are the `complete` and `reopen` operations of `writes.applyOps` (data, replayed on theirs after a
// 412). The base is the version of the task the user was SHOWN (same ETag): if a background sync has replaced it
// meanwhile, nothing is sent and the user is told to look again. A repeating task is never completed here (Q-R3-5:
// completing one occurrence needs RECURRENCE-ID handling that waits for v1.1).

import { confirmDialog } from '../../widgets/dialogs.js';
import { openConflictDialog, modeOf } from '../conflictdialog.js';
import { isolate } from './common.js';

export const defaultActionDeps = () => ({ openConflictDialog, win: globalThis.window });

/**
 * @param {object} o
 * @param {object} o.app @param {object} o.storeCtx @param {object} o.source (createTaskSource)
 * @param {Function} o.t
 * @param {object} [o.deps]
 */
export function createTaskActions({ app, storeCtx, source, t, deps = {} }) {
  const d = { ...defaultActionDeps(), ...deps };
  const writes = () => storeCtx.writes;
  const conflictOf = (res, label) => d.openConflictDialog({ conflict: res, t, writes: writes(), label, feedback: app.feedback, win: d.win });

  return {
    /**
     * Complete a task, or reopen a done one. `rec` is a described record (tasks/list.js). Resolves `{done, result}`:
     * `done` is true when the write succeeded (or the server already held the wanted state).
     */
    async toggleComplete(rec) {
      if (rec.recurring && !rec.done) return { done: false, reason: 'repeating' };
      if (rec.readOnly || rec.listReadOnly) return { done: false, reason: 'readonly' };
      const base = source.baseOf(rec.href);
      if (!base || base.etag !== rec.etag) {
        app.feedback.setStatus(t('tasks.changedMeanwhile', { name: isolate(rec.summary || t('tasks.untitled')) }));
        return { done: false, reason: 'stale' };
      }
      const completing = !rec.done;
      let res = await writes().applyOps({ collection: rec.collection, href: rec.href, base, ops: [{ type: completing ? 'complete' : 'reopen' }], statusKey: completing ? 'tasks.msg.completed' : 'tasks.msg.reopened' });
      if (modeOf(res)) res = await conflictOf(res, rec.summary);
      return { done: Boolean(res && res.ok), result: res };
    },

    /** Delete with a named confirmation (`dialog-delete-task`). Resolves `{done}`. */
    async remove({ collection, entry, summary, uid }) {
      const named = isolate(summary || t('tasks.untitled'));
      const yes = await confirmDialog({
        testid: 'dialog-delete-task',
        confirmTestid: 'dialog-confirm-delete',
        cancelTestid: 'dialog-cancel',
        title: t('tasks.delete.title', { name: named }),
        message: t('tasks.delete.text'),
        confirmLabel: t('tasks.delete.confirm', { name: named }),
        cancelLabel: t('dialog.cancel'),
        danger: true,
        write: true,
        t,
        win: d.win,
      });
      if (!yes) return { done: false };
      let res = await writes().deleteItem({ collection, href: entry.href, etag: entry.etag, uid: uid || null });
      if (res && res.status === 'changed-elsewhere') res = await conflictOf(res, summary);
      const ok = Boolean(res && res.ok && (res.status === 'deleted' || res.status === 'already-deleted'));
      return { done: ok, result: res };
    },
  };
}
