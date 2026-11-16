// SPDX-License-Identifier: AGPL-3.0-or-later
// The task form model (RUN3 WP C1): the ONLY place where form values become a model patch. No DOM.
//
//   fromItem(item)                      what the form shows (flat strings and arrays)
//   toPatch(base, values, {now})        the patch for the model: ONLY keys whose value differs from what the form
//                                       showed; {} = nothing to save (an untouched form never rewrites the task)
//   validate(base, values, {isNew, zones})   [{field, testId, code}] (codes are `tasks.err.<code>`)
//   newTaskValues({tz})                 a blank form (status NEEDS-ACTION, due and start empty, zone = display zone)
//   toNewFields(values, {now})          the fields of a NEW task (createItem('task', fields))
//   valuesToSpecs(values)               {due, start} TimeSpecs or null
//   withZone(values, which, tz)         the zone picker of 'due' | 'start' changed
//   statusOptions(base), priorityOptions(base)   the select options (a value the form does not know stays selectable)
//
// Rules (SPECS 7, data-model.md): every comparison is made against the DISPLAYED baseline, so an untouched field never
// rewrites the task; the zone of an existing time is the zone of its own TZID (never the display zone) and is rewritten
// only when the picker or the time changed; a due without a time is a DATE; the RRULE is never in a patch (a repeating
// task keeps its rule; completing it is disabled until v1.1, Q-R3-5). Setting the status to COMPLETED also sets
// COMPLETED (UTC now) and PERCENT-COMPLETE 100 unless the user typed a percent; leaving COMPLETED removes COMPLETED and,
// when the percent was 100 and untouched, the percent (as the `reopen` operation does).

import { ValueError } from '../model/contentlines.js';
import { timeInfo } from '../model/icalview.js';
import { isValidDate } from '../calendar/grid.js';
import { displayZone } from '../calendar/tzprefs.js';

export const LIMITS = Object.freeze({ summary: 1000, description: 20000, category: 255 });
export const STATUS_VALUES = Object.freeze(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']);
/** Priority choices of the form: none, high (1), medium (5), low (9). Any other stored value is added as its own choice. */
export const PRIORITY_PRESETS = Object.freeze([0, 1, 5, 9]);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const norm = (s) => String(s === undefined || s === null ? '' : s).replace(/\r\n?/g, '\n');
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function hhmm(iso) {
  const t = iso.slice(11, 19);
  return t.endsWith(':00') ? t.slice(0, 5) : t;
}

function partsOfSpec(spec, which) {
  if (!spec) return { [`${which}Date`]: '', [`${which}Time`]: '', [`${which}Tz`]: '', [`${which}Kind`]: '' };
  const date = spec.iso.slice(0, 10);
  if (spec.kind === 'date') return { [`${which}Date`]: date, [`${which}Time`]: '', [`${which}Tz`]: '', [`${which}Kind`]: 'date' };
  return {
    [`${which}Date`]: date,
    [`${which}Time`]: hhmm(spec.iso),
    [`${which}Tz`]: spec.kind === 'utc' ? 'UTC' : spec.tzid || '',
    [`${which}Kind`]: spec.kind,
  };
}

/** The form values of a task (an Item of kind 'task'). */
export function fromItem(item) {
  const f = item.fields();
  return {
    summary: f.summary,
    description: norm(f.description),
    status: f.status || '',
    priority: String(Number.isInteger(f.priority) ? f.priority : 0),
    percent: f.percent === null || f.percent === undefined ? '' : String(f.percent),
    categories: f.categories.slice(),
    ...partsOfSpec(f.due, 'due'),
    ...partsOfSpec(f.start, 'start'),
    rrule: f.rrule || null,
    recurring: Boolean(f.rrule),
  };
}

/** A blank form. `tz` is the display zone: it becomes the zone of a due or start time the user types. */
export function newTaskValues({ tz = 'UTC' } = {}) {
  const kind = tz === 'UTC' ? 'utc' : 'zoned';
  return {
    summary: '',
    description: '',
    status: 'NEEDS-ACTION',
    priority: '0',
    percent: '',
    categories: [],
    dueDate: '',
    dueTime: '',
    dueTz: tz,
    dueKind: kind,
    startDate: '',
    startTime: '',
    startTz: tz,
    startKind: kind,
    rrule: null,
    recurring: false,
  };
}

/** The zone picker of `which` ('due' | 'start') changed: 'UTC' is written as Z, a zone as TZID. */
export function withZone(values, which, tz) {
  return { ...values, [`${which}Tz`]: tz, [`${which}Kind`]: tz === 'UTC' ? 'utc' : tz ? 'zoned' : 'floating' };
}

function specOf(values, which, defaultTz) {
  const date = values[`${which}Date`];
  if (!date) return null;
  const time = norm(values[`${which}Time`]).trim();
  if (!time) return { kind: 'date', iso: date };
  const iso = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const kind = values[`${which}Kind`];
  if (kind === 'floating') return { kind: 'floating', iso };
  // a time added to a date-only value takes the default zone (the display zone); only an existing floating time stays floating
  const tz = values[`${which}Tz`] || defaultTz || '';
  if (!tz) return { kind: 'floating', iso };
  if (tz === 'UTC' && kind !== 'zoned') return { kind: 'utc', iso };
  return { kind: 'zoned', iso, tzid: tz };
}

/** {due, start} TimeSpecs (null for an empty date). `defaultTz`: the zone of a time typed into a date-only value. Throws ValueError on a bad date or time. */
export function valuesToSpecs(values, { defaultTz = '' } = {}) {
  for (const w of ['due', 'start']) {
    const date = values[`${w}Date`];
    if (!date) continue;
    if (!isValidDate(date)) throw new ValueError(`invalid ${w} date`);
    const time = norm(values[`${w}Time`]).trim();
    if (time && !TIME_RE.test(time)) throw new ValueError(`invalid ${w} time`);
  }
  return { due: specOf(values, 'due', defaultTz), start: specOf(values, 'start', defaultTz) };
}

function groupChanged(base, values, which) {
  return ['Date', 'Time', 'Tz', 'Kind'].some((k) => (base[`${which}${k}`] || '') !== (values[`${which}${k}`] || ''));
}

const utcNow = (now) => ({ kind: 'utc', iso: new Date(now).toISOString().slice(0, 19) });

/**
 * The model patch (keys of applyTodoPatch): summary, description, due, start, priority, status, percent, completed,
 * categories. `rrule` is never in it.
 */
export function toPatch(base, values, { now = Date.now(), defaultTz = '' } = {}) {
  const patch = {};
  if (norm(values.summary) !== norm(base.summary)) patch.summary = norm(values.summary).trim();
  if (norm(values.description) !== norm(base.description)) patch.description = norm(values.description);
  const cats = (values.categories || []).map((c) => String(c).trim()).filter(Boolean);
  if (!sameList(cats, base.categories || [])) patch.categories = cats;
  if (String(values.priority) !== String(base.priority)) {
    const n = Number(values.priority);
    patch.priority = n === 0 ? null : n;
  }
  const percentTyped = String(values.percent).trim() !== String(base.percent).trim();
  if (percentTyped) patch.percent = String(values.percent).trim() === '' ? null : Number(values.percent);
  if ((values.status || '') !== (base.status || '')) {
    patch.status = values.status || null;
    if (values.status === 'COMPLETED') {
      patch.completed = utcNow(now);
      if (!percentTyped && String(base.percent).trim() !== '100') patch.percent = 100;
    } else if (base.status === 'COMPLETED') {
      patch.completed = null;
      if (!percentTyped && String(base.percent).trim() === '100') patch.percent = null;
    }
  }
  const dueChanged = groupChanged(base, values, 'due');
  const startChanged = groupChanged(base, values, 'start');
  if (dueChanged || startChanged) {
    const specs = valuesToSpecs(values, { defaultTz });
    if (dueChanged) patch.due = specs.due;
    if (startChanged) patch.start = specs.start;
  }
  return patch;
}

/** The fields of a NEW task (createItem('task', fields)). */
export function toNewFields(values, { now = Date.now(), defaultTz = '' } = {}) {
  const { due, start } = valuesToSpecs(values, { defaultTz });
  const fields = { summary: norm(values.summary).trim() };
  if (norm(values.description)) fields.description = norm(values.description);
  if (due) fields.due = due;
  if (start) fields.start = start;
  const n = Number(values.priority);
  if (Number.isInteger(n) && n > 0) fields.priority = n;
  if (values.status) fields.status = values.status;
  const pct = String(values.percent).trim();
  if (pct !== '') fields.percent = Number(pct);
  if (values.status === 'COMPLETED') {
    fields.completed = utcNow(now);
    if (pct === '') fields.percent = 100;
  }
  const cats = (values.categories || []).map((c) => String(c).trim()).filter(Boolean);
  if (cats.length) fields.categories = cats;
  return fields;
}

/** The status choices: the four RFC values, preceded by "none" when the task has no STATUS (or an unknown one). */
export function statusOptions(base) {
  const list = [...STATUS_VALUES];
  const cur = base && base.status;
  return cur && !list.includes(cur) ? ['', cur, ...list] : cur === '' ? ['', ...list] : list;
}

/** The priority choices: none, high, medium, low, plus the stored value when it is another number (a 3 stays a 3). */
export function priorityOptions(base) {
  const cur = base ? Number(base.priority) : 0;
  return Number.isInteger(cur) && cur > 0 && cur <= 9 ? [...new Set([...PRIORITY_PRESETS, cur])].sort((a, b) => a - b) : [...PRIORITY_PRESETS];
}

const zoneKnown = (zones, tz) => (zones && typeof zones.get === 'function' ? Boolean(zones.get(tz)) : Boolean(displayZone(tz)));

/**
 * Structured field errors. Like the contact and event forms, only values that changed (or are new) are judged, so an
 * old task with an odd value can still be saved after an unrelated edit. [{field, testId, code}]
 */
export function validate(base, values, { isNew = false, zones = null, defaultTz = '' } = {}) {
  const errs = [];
  const add = (field, testId, code) => errs.push({ field, testId, code });
  const b = base || {};
  if ((isNew || norm(values.summary) !== norm(b.summary)) && !norm(values.summary).trim()) add('summary', 'field-summary', 'summary-required');
  if (norm(values.summary).length > LIMITS.summary) add('summary', 'field-summary', 'too-long');
  if (norm(values.description).length > LIMITS.description && (isNew || norm(values.description) !== norm(b.description))) add('description', 'field-description', 'too-long');
  const pct = String(values.percent).trim();
  if ((isNew || pct !== String(b.percent || '').trim()) && pct !== '' && !(/^\d{1,3}$/.test(pct) && Number(pct) >= 0 && Number(pct) <= 100)) add('percent', 'field-percent', 'percent');
  if (!Number.isInteger(Number(values.priority)) || Number(values.priority) < 0 || Number(values.priority) > 9) add('priority', 'field-priority', 'priority');
  if (b.recurring && values.status === 'COMPLETED' && (b.status || '') !== 'COMPLETED') add('status', 'field-status', 'recurring-complete');
  const touched = (w) => isNew || groupChanged(b, values, w);
  let datesOk = true;
  for (const w of ['due', 'start']) {
    if (!touched(w)) continue;
    const date = values[`${w}Date`];
    const time = norm(values[`${w}Time`]).trim();
    if (!date) {
      if (time) {
        add(w, `field-${w}-date`, 'date-required');
        datesOk = false;
      }
      continue;
    }
    if (!isValidDate(date)) {
      add(w, `field-${w}-date`, 'date-invalid');
      datesOk = false;
    }
    if (time && !TIME_RE.test(time)) {
      add(w, `field-${w}-time`, 'time-invalid');
      datesOk = false;
    }
    if (time && values[`${w}Tz`] && values[`${w}Tz`] !== (b[`${w}Tz`] || '') && !zoneKnown(zones, values[`${w}Tz`])) {
      add(w, `field-tz-${w}`, 'tz-unknown');
      datesOk = false;
    }
  }
  if (datesOk && (touched('due') || touched('start')) && values.dueDate && values.startDate) {
    const dueTimed = Boolean(norm(values.dueTime).trim());
    const startTimed = Boolean(norm(values.startTime).trim());
    if (dueTimed !== startTimed) add('due', 'field-due-date', 'date-types-differ'); // RFC 5545: DUE and DTSTART have the same value type
    else {
      try {
        const { due, start } = valuesToSpecs(values, { defaultTz });
        const z = zones || { get: (tz) => displayZone(tz) };
        const s = timeInfo(start, z);
        const d = timeInfo(due, z);
        const before = s.instant !== null && d.instant !== null ? d.instant < s.instant : d.wallMs < s.wallMs;
        if (before) add('due', dueTimed ? 'field-due-time' : 'field-due-date', 'due-before-start');
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
      }
    }
  }
  return errs;
}

/** Is the patch empty (nothing to save)? */
export const isEmptyPatch = (patch) => !patch || Object.keys(patch).length === 0;
