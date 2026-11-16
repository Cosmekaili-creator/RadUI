// SPDX-License-Identifier: AGPL-3.0-or-later
// Operation lists for events and tasks (RUN3 D-R3-5, store/writes.js `applyOps`). An operation is DATA, not a
// closure, so that a 412 "Overwrite with mine" can replay the very same list on their version:
//
//   {type: 'patch', fields}                      master (or the only VTODO): applyEventPatch / applyTodoPatch keys
//   {type: 'override', rid, fields}              create or edit the override of one occurrence (`rid` is a TimeSpec)
//   {type: 'deleteOccurrence', rid}              EXDATE + no override for that occurrence
//   {type: 'removeExdate', rid}                  restore a deleted occurrence
//   {type: 'removeOverride', rid}                the occurrence returns to the series
//   {type: 'truncate', rid}                      the series ends before `rid` (later EXDATE/overrides go with it)
//   {type: 'shiftExceptions', fromStart, toStart}  EXDATE/RECURRENCE-ID/UNTIL follow a moved series start
//   {type: 'complete'} | {type: 'reopen'}        tasks
//
// A TimeSpec is {kind: 'date'|'floating'|'utc'|'zoned', iso, tzid?}. Operations run IN ORDER on a fresh item of
// each attempt; `shiftExceptions` must come BEFORE the `patch` that moves the start (it checks that the master's
// DTSTART is still `fromStart`, addendum M4, and throws a SeriesError('start-mismatch') otherwise).
// No DOM, no network. The event library is imported only when an operation needs it.

import { FieldError } from '../model/writer.js';

export const OP_TYPES = Object.freeze(['patch', 'override', 'deleteOccurrence', 'removeExdate', 'removeOverride', 'truncate', 'shiftExceptions', 'complete', 'reopen']);
const EVENT_ONLY = new Set(['override', 'deleteOccurrence', 'removeExdate', 'removeOverride', 'truncate', 'shiftExceptions']);
const TASK_ONLY = new Set(['complete', 'reopen']);
// operations that use the series helpers; `override`, `deleteOccurrence` and `truncate` first ask whether the occurrence still exists
const LIB_OPS = new Set(['truncate', 'shiftExceptions', 'override', 'deleteOccurrence']);
const CHECKED_RID = new Set(['override', 'deleteOccurrence', 'truncate']);
const NEEDS_RID = new Set(['override', 'deleteOccurrence', 'removeExdate', 'removeOverride', 'truncate']);

const isSpec = (s) => Boolean(s) && typeof s === 'object' && typeof s.kind === 'string' && typeof s.iso === 'string';

/** Is the list well formed (known types, specs present)? Returns an error text or null. */
export function checkOps(ops) {
  if (!Array.isArray(ops) || !ops.length) return 'no operations';
  for (const op of ops) {
    if (!op || !OP_TYPES.includes(op.type)) return `unknown operation ${op && op.type}`;
    if (NEEDS_RID.has(op.type) && !isSpec(op.rid)) return `${op.type} needs an occurrence time`;
    if (op.type === 'shiftExceptions' && !(isSpec(op.fromStart) && isSpec(op.toStart))) return 'shiftExceptions needs fromStart and toStart';
    if ((op.type === 'patch' || op.type === 'override') && (!op.fields || typeof op.fields !== 'object')) return `${op.type} needs fields`;
  }
  return null;
}

/** The Activity operation of a list: complete, reopen, truncate, else update. */
export function opNameOf(ops) {
  const types = new Set((ops || []).map((o) => o.type));
  if (types.has('truncate')) return 'truncate';
  if (types.size === 1 && types.has('complete')) return 'complete';
  if (types.size === 1 && types.has('reopen')) return 'reopen';
  return 'update';
}

/** Does any operation need the series helpers of the event model (loaded lazily)? */
export const needsEventLib = (ops) => (ops || []).some((o) => LIB_OPS.has(o.type));

/**
 * Apply `ops` in order to a fresh `Item`. Throws FieldError / SeriesError / ReadOnlyError when an operation
 * cannot be applied (the occurrence is gone, the series start moved, ...). `lib` is the event model module
 * (needed for truncate and shiftExceptions only); `now` is a Date for `complete`.
 * @returns {boolean} true when the item text changed in memory (the caller asks item.save() for the truth)
 */
export function applyOpsToItem(item, ops, { lib = null, now = new Date() } = {}) {
  const bad = checkOps(ops);
  if (bad) throw new FieldError(bad);
  let changed = false;
  for (const op of ops) {
    if (EVENT_ONLY.has(op.type) && item.kind !== 'event') throw new FieldError(`${op.type} needs an event`);
    if (TASK_ONLY.has(op.type) && item.kind !== 'task') throw new FieldError(`${op.type} needs a task`);
    if (CHECKED_RID.has(op.type)) {
      // a replay on a version that changed meanwhile (D-R3-5.1): the occurrence must still exist, never be brought back
      if (!lib) throw new FieldError('the event library is not loaded');
      if (!lib.isOccurrence(item.root, op.rid, { zones: item.zones })) throw new lib.SeriesError('occurrence-not-found', 'that occurrence no longer exists');
    }
    switch (op.type) {
      case 'patch':
        changed = item.update(op.fields) || changed;
        break;
      case 'override':
        item.upsertOverride(op.rid, op.fields || {});
        changed = true;
        break;
      case 'deleteOccurrence':
        changed = item.deleteOccurrence(op.rid) || changed;
        break;
      case 'removeExdate':
        changed = item.removeExdate(op.rid) || changed;
        break;
      case 'removeOverride':
        changed = item.removeOverride(op.rid) || changed;
        break;
      case 'truncate':
        if (!lib) throw new FieldError('the event library is not loaded');
        item._writable();
        lib.truncateSeries(item.root, op.rid, { zones: item.zones });
        changed = true;
        break;
      case 'shiftExceptions':
        if (!lib) throw new FieldError('the event library is not loaded');
        item._writable();
        changed = lib.shiftExceptions(item.root, op.fromStart, op.toStart, { zones: item.zones }) || changed;
        break;
      case 'complete':
        changed = item.completeTask(now) || changed;
        break;
      case 'reopen':
        changed = item.reopenTask() || changed;
        break;
      default:
        break;
    }
  }
  return changed;
}

/** The occurrence times (TimeSpecs) an operation list targets with a per-occurrence write (for the conflict rows and verification). */
export const occurrencesOfOps = (ops) => (ops || []).filter((o) => o.type === 'override').map((o) => o.rid);

/** Does the (parsed) item hold a recurring event or task? */
export function isRecurring(item) {
  if (!item || !item.ok) return false;
  const f = item.fields();
  return Boolean(f.rrule) || (item.kind === 'event' && item.overrides.length > 0) || (Array.isArray(f.rdates) && f.rdates.length > 0);
}
