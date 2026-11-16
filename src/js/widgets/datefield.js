// SPDX-License-Identifier: AGPL-3.0-or-later
// Own typeable date field (SPECS 10a-1): a text input with a visible format hint derived from the
// locale, strict calendar validation, ISO YYYY-MM-DD always accepted, an optional year (vCard
// `--MM-DD` / `--MMDD`), min/max, and an optional picker dialog (a month grid).
//
// Two layers:
//  - DOM-free logic (parseDate, formatDate, localeDatePattern, dateHint, navigateDate, monthGrid, ...),
//    unit-tested in Node and reused by run 3;
//  - rendering (createDateField, openDatePicker) on top of ui.js (h, openDialog); no raw HTML,
//    no style attribute, no inline handler.
//
// Values are plain data `{y, m, d}` (y is null for a date without a year) and an ISO string:
// `YYYY-MM-DD`, or `--MM-DD` when the year is missing.

import { h, openDialog } from '../ui.js';
import { localeFirstWeekday } from '../i18n.js';
import { buildField, fill, identityT, uniqueId } from './fieldkit.js';

export const MIN_YEAR = 1;
export const MAX_YEAR = 9999;
const REFERENCE_LEAP_YEAR = 2000; // a date without a year may be 29 February

// ---------------------------------------------------------------- calendar maths

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Days in a month; a null year is treated as a leap year (29 February is allowed without a year). */
export function daysInMonth(y, m) {
  if (m === 2) return isLeapYear(y === null || y === undefined ? REFERENCE_LEAP_YEAR : y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

const isInt = (n) => Number.isInteger(n);

/** True for a real calendar date; `y` may be null. */
export function isValidYMD(v) {
  if (!v || typeof v !== 'object') return false;
  const { y, m, d } = v;
  if (!(y === null || (isInt(y) && y >= MIN_YEAR && y <= MAX_YEAR))) return false;
  return isInt(m) && m >= 1 && m <= 12 && isInt(d) && d >= 1 && d <= daysInMonth(y, m);
}

/** `YYYY-MM-DD`, or the vCard form `--MM-DD` without a year. '' for anything that is not a valid date. */
export function toISO(v) {
  if (!isValidYMD(v)) return '';
  return v.y === null ? `--${pad(v.m)}-${pad(v.d)}` : `${pad(v.y, 4)}-${pad(v.m)}-${pad(v.d)}`;
}

/**
 * Strict reader of the machine forms: `YYYY-MM-DD`, `YYYYMMDD`, `--MM-DD`, `--MMDD`.
 * @returns {{y: number|null, m: number, d: number}|null} null when the text is not one of them or not a real date
 */
export function fromISO(text) {
  if (typeof text !== 'string') return null;
  let m = text.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  let v = null;
  if (m) v = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  else if ((m = text.match(/^--(\d{2})-?(\d{2})$/))) v = { y: null, m: Number(m[1]), d: Number(m[2]) };
  return v && isValidYMD(v) ? v : null;
}

/** Accept a `{y,m,d}` object or an ISO string; anything else (or an invalid date) gives null. */
export function normalizeYMD(x) {
  if (typeof x === 'string') return fromISO(x);
  if (x && typeof x === 'object') {
    const v = { y: x.y === undefined ? null : x.y, m: x.m, d: x.d };
    return isValidYMD(v) ? v : null;
  }
  return null;
}

/** -1, 0, 1 for two dates that both have a year. */
export function compareYMD(a, b) {
  return a.y !== b.y ? (a.y < b.y ? -1 : 1) : a.m !== b.m ? (a.m < b.m ? -1 : 1) : a.d !== b.d ? (a.d < b.d ? -1 : 1) : 0;
}

function utc(y, m, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt;
}
const fromUtc = (dt) => ({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });

/** ISO weekday of a date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(v) {
  return ((utc(v.y, v.m, v.d).getUTCDay() + 6) % 7) + 1;
}

/** Add days; the result is clamped to the supported years. */
export function addDays(v, n) {
  const r = fromUtc(new Date(utc(v.y, v.m, v.d).getTime() + n * 86400000));
  return r.y < MIN_YEAR ? { y: MIN_YEAR, m: 1, d: 1 } : r.y > MAX_YEAR ? { y: MAX_YEAR, m: 12, d: 31 } : r;
}

/** Add months keeping the day when the target month has it, else its last day; clamped to the supported years. */
export function addMonths(v, n) {
  const index = v.y * 12 + (v.m - 1) + n;
  const y = Math.floor(index / 12);
  if (y < MIN_YEAR) return { y: MIN_YEAR, m: 1, d: Math.min(v.d, 31) };
  if (y > MAX_YEAR) return { y: MAX_YEAR, m: 12, d: Math.min(v.d, 31) };
  const m = index - y * 12 + 1;
  return { y, m, d: Math.min(v.d, daysInMonth(y, m)) };
}

/** Today in a time zone (default: the runtime's), as `{y,m,d}`. */
export function todayYMD(now = new Date(), timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function clampYMD(v, min, max) {
  if (min && compareYMD(v, min) < 0) return { ...min };
  if (max && compareYMD(v, max) > 0) return { ...max };
  return v;
}

/**
 * Keyboard navigation of the picker grid (WAI-ARIA date picker): arrows = day/week, Page Up/Down = month
 * (with Shift: year), Home/End = first/last day of the week. Returns the new focused date clamped to
 * min/max, or null when `key` is not a navigation key.
 */
export function navigateDate(cur, key, { shift = false, firstWeekday = 1, min = null, max = null } = {}) {
  let next;
  switch (key) {
    case 'ArrowLeft':
      next = addDays(cur, -1);
      break;
    case 'ArrowRight':
      next = addDays(cur, 1);
      break;
    case 'ArrowUp':
      next = addDays(cur, -7);
      break;
    case 'ArrowDown':
      next = addDays(cur, 7);
      break;
    case 'PageUp':
      next = addMonths(cur, shift ? -12 : -1);
      break;
    case 'PageDown':
      next = addMonths(cur, shift ? 12 : 1);
      break;
    case 'Home':
      next = addDays(cur, -((isoWeekday(cur) - firstWeekday + 7) % 7));
      break;
    case 'End':
      next = addDays(cur, 6 - ((isoWeekday(cur) - firstWeekday + 7) % 7));
      break;
    default:
      return null;
  }
  return clampYMD(next, min, max);
}

/**
 * The weeks of a month as rows of 7 cells; cells outside the month are null.
 * @returns {({y:number,m:number,d:number}|null)[][]}
 */
export function monthGrid(y, m, firstWeekday = 1) {
  const lead = (isoWeekday({ y, m, d: 1 }) - firstWeekday + 7) % 7;
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth(y, m); d += 1) cells.push({ y, m, d });
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ------------------------------------------------------------------ locale pattern

const patternCache = new Map();
const INVISIBLE_RE = /[\s\u200E\u200F\u061C\u2066-\u2069]/gu;

/**
 * Field order and separator of a locale, from `Intl.DateTimeFormat(lang).formatToParts`:
 * en -> {order: ['m','d','y'], sep: '/'}, fr -> d m y '/', de -> d m y '.', ja -> y m d '/'.
 * An unknown language falls back to English.
 * @returns {{order: ('d'|'m'|'y')[], sep: string}}
 */
export function localeDatePattern(lang = 'en') {
  const key = String(lang);
  if (patternCache.has(key)) return patternCache.get(key);
  let pattern = null;
  for (const tag of [key, 'en']) {
    try {
      const parts = new Intl.DateTimeFormat(tag, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2026, 10, 13)));
      const order = parts.filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year').map((p) => p.type[0]);
      const literal = parts.find((p) => p.type === 'literal');
      let sep = literal ? literal.value.replace(INVISIBLE_RE, '') : '/';
      if (!sep || /[\p{L}\p{N}]/u.test(sep)) sep = '/';
      if (order.length === 3 && new Set(order).size === 3) {
        pattern = Object.freeze({ order: Object.freeze(order), sep: sep[0] });
        break;
      }
    } catch {
      /* try the next tag */
    }
  }
  if (!pattern) pattern = Object.freeze({ order: Object.freeze(['m', 'd', 'y']), sep: '/' });
  patternCache.set(key, pattern);
  return pattern;
}

const asPattern = (p) => (typeof p === 'string' || p === undefined ? localeDatePattern(p || 'en') : p);

/** Format a date in the locale order with a 2-digit day and month and a 4-digit year; the year is dropped when null. */
export function formatDate(v, pattern = 'en') {
  if (!isValidYMD(v)) return '';
  const p = asPattern(pattern);
  const piece = { d: pad(v.d), m: pad(v.m), y: v.y === null ? null : pad(v.y, 4) };
  return p.order
    .map((k) => piece[k])
    .filter((s) => s !== null)
    .join(p.sep);
}

/** The visible format hint, e.g. 'DD/MM/YYYY'. `letters` = {d, m, y} (translated); `yearless` drops the year. */
export function dateHint(pattern = 'en', letters = { d: 'DD', m: 'MM', y: 'YYYY' }, { yearless = false } = {}) {
  const p = asPattern(pattern);
  return p.order
    .filter((k) => !(yearless && k === 'y'))
    .map((k) => letters[k])
    .join(p.sep);
}

/** A fixed, fictional example date used in hints (the day is above 12 so the order is unambiguous). */
export const EXAMPLE_DATE = Object.freeze({ y: 2000, m: 3, d: 24 });

// ------------------------------------------------------------------------ parsing

/**
 * @typedef {object} DateParseOptions
 * @property {string|{order: string[], sep: string}} [pattern='en']  language tag or a pattern
 * @property {boolean} [yearOptional=false]  accept `DD/MM`, `--MM-DD`, `--MMDD` (value.y = null)
 * @property {boolean} [required=false]
 * @property {string|{y,m,d}} [min]  inclusive; ignored for dates without a year
 * @property {string|{y,m,d}} [max]
 */

/**
 * Parse what the user typed.
 *  - ISO `YYYY-MM-DD` (and `YYYYMMDD`) is always accepted; any text starting with a 4-digit year reads as year-month-day;
 *  - otherwise the locale order is used, with `/ . - ,` or a space as separators;
 *  - without a year (`yearOptional`): two numbers in locale order, `--MM-DD` or `--MMDD`;
 *  - real calendar dates only (leap years), the year has exactly 4 digits.
 * @returns {{ok: true, empty: true, value: null, iso: ''}
 *   |{ok: true, empty: false, value: {y: number|null, m: number, d: number}, iso: string, yearless: boolean}
 *   |{ok: false, error: 'required'|'format'|'year'|'month'|'day'|'min'|'max', detail: object}}
 */
export function parseDate(text, { pattern = 'en', yearOptional = false, required = false, min, max } = {}) {
  const p = asPattern(pattern);
  const s = String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200E\u200F\u061C]/g, '')
    .trim();
  if (s === '') return required ? { ok: false, error: 'required', detail: {} } : { ok: true, empty: true, value: null, iso: '' };
  const fail = (error, detail = {}) => ({ ok: false, error, detail });

  let y = null;
  let m;
  let d;
  let dm = s.match(/^--(\d{2})-?(\d{2})$/);
  if (dm) {
    if (!yearOptional) return fail('year');
    [m, d] = [Number(dm[1]), Number(dm[2])];
  } else if ((dm = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  } else {
    let body = s.replace(/[\s./\-,]+$/u, '');
    if (!/^\d/u.test(body)) return fail('format');
    if (p.sep && !/[\s./\-,]/u.test(p.sep)) body = body.split(p.sep).join('/');
    if (!/^\d+(?:[\s./\-,]+\d+)*$/u.test(body)) return fail('format');
    const tokens = body.split(/[^\d]+/u);
    if (tokens.length === 3) {
      let tk;
      if (tokens[0].length === 4) tk = { y: tokens[0], m: tokens[1], d: tokens[2] };
      else {
        tk = {};
        p.order.forEach((k, i) => {
          tk[k] = tokens[i];
        });
      }
      if (tk.y.length !== 4 || tk.m.length > 2 || tk.d.length > 2) return fail('format');
      [y, m, d] = [Number(tk.y), Number(tk.m), Number(tk.d)];
      if (y < MIN_YEAR) return fail('year');
    } else if (tokens.length === 2) {
      if (!yearOptional) return fail('year');
      const order = p.order.filter((k) => k !== 'y');
      const tk = { [order[0]]: tokens[0], [order[1]]: tokens[1] };
      if (tk.m.length > 2 || tk.d.length > 2) return fail('format');
      [m, d] = [Number(tk.m), Number(tk.d)];
    } else return fail('format');
  }
  if (!(m >= 1 && m <= 12)) return fail('month', { month: m });
  if (!(d >= 1 && d <= daysInMonth(y, m))) return fail('day', { day: d, month: m, year: y });
  const value = { y, m, d };
  if (y !== null) {
    const lo = normalizeYMD(min);
    const hi = normalizeYMD(max);
    if (lo && lo.y !== null && compareYMD(value, lo) < 0) return fail('min', { min: toISO(lo) });
    if (hi && hi.y !== null && compareYMD(value, hi) > 0) return fail('max', { max: toISO(hi) });
  }
  return { ok: true, empty: false, value, iso: toISO(value), yearless: y === null };
}

/**
 * The translated message of a failed parse (`widget.date.err.<code>`); `t` is the app translator.
 */
export function dateErrorMessage(t, result, { pattern = 'en' } = {}) {
  const p = asPattern(pattern);
  const letters = dateLetters(t);
  const d = result.detail || {};
  return t(`widget.date.err.${result.error}`, {
    format: dateHint(p, letters),
    example: formatDate(EXAMPLE_DATE, p),
    min: d.min ? formatDate(fromISO(d.min), p) : '',
    max: d.max ? formatDate(fromISO(d.max), p) : '',
    day: d.day ?? '',
    month: d.month ?? '',
  });
}

function dateLetters(t) {
  return { d: t('widget.date.letter.d'), m: t('widget.date.letter.m'), y: t('widget.date.letter.y') };
}

/** The visible hint text of a field. */
export function dateHintText(t, pattern, { yearOptional = false } = {}) {
  const p = asPattern(pattern);
  const letters = dateLetters(t);
  return t(yearOptional ? 'widget.date.hintYearless' : 'widget.date.hint', {
    format: dateHint(p, letters),
    formatShort: dateHint(p, letters, { yearless: true }),
    example: formatDate(EXAMPLE_DATE, p),
  });
}

// ------------------------------------------------------------------ names (Intl)

/** Weekday names starting at `firstWeekday`: [{short, long}] (7 entries). */
export function weekdayNames(lang, firstWeekday = 1) {
  const short = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' });
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    const iso = ((firstWeekday - 1 + i) % 7) + 1; // 2024-01-01 is a Monday
    const dt = new Date(Date.UTC(2024, 0, iso));
    out.push({ short: short.format(dt), long: long.format(dt) });
  }
  return out;
}

/** The 12 month names in a language. */
export function monthNames(lang) {
  const f = new Intl.DateTimeFormat(lang, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2024, i, 1))));
}

// -------------------------------------------------------------------- the field

/**
 * @param {object} o
 * @param {string} o.testid           `field-bday`: on the wrapper; `-input`, `-picker`, `-error` suffixes
 * @param {string} o.label
 * @param {string} [o.id]
 * @param {(key: string, params?: object) => string} o.t
 * @param {string} [o.lang='en']      drives field order and names
 * @param {string|{y,m,d}|null} [o.value]
 * @param {boolean} [o.yearOptional]  @param {boolean} [o.required] @param {string|object} [o.min] @param {string|object} [o.max]
 * @param {boolean} [o.picker=true]   offer the picker dialog
 * @param {boolean} [o.clearable]     picker has a Clear button (default: not required)
 * @param {HTMLElement} [o.errorRegion]  a caller-provided element that receives the error text
 * @param {number} [o.firstWeekday]   1-7 (default: the locale's)
 * @param {() => Date} [o.now]
 * @param {(result: object) => void} [o.onChange]  called after every commit (blur/change/picker/setValue by the user)
 * @param {(result: object) => void} [o.onInput]   called on each keystroke
 * @param {object} [o.inputProps]     extra attributes of the input (no style, no on*)
 */
export function createDateField(o) {
  const { testid, label, t = identityT, lang = 'en', yearOptional = false, required = false, picker = true, now = () => new Date(), onChange, onInput } = o;
  const id = o.id || uniqueId('date');
  const pattern = localeDatePattern(lang);
  const letters = dateLetters(t);
  const parseOpts = () => ({ pattern, yearOptional, required, min: o.min, max: o.max });
  const input = h('input', {
    type: 'text',
    id,
    class: 'input datefield__input',
    testid: `${testid}-input`,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: '24',
    placeholder: dateHint(pattern, letters),
    ...(o.inputProps || {}),
  });
  const pickBtn = picker
    ? h(
        'button',
        { type: 'button', class: 'btn btn--small datefield__pick', testid: `${testid}-picker`, 'aria-label': t('widget.date.pickFor', { label }), 'aria-haspopup': 'dialog' },
        t('widget.date.pick'),
      )
    : null;
  const row = h('div', { class: 'datefield__row' }, input, pickBtn);
  // The field's own error line is ALWAYS in the layout (its space is reserved by css, only `visibility`
  // changes): an error that appears on blur must not move the controls below it, or the first click on a
  // button under the field (Create, Save) would be lost between mouse-down and mouse-up. A caller-provided
  // error region keeps its own rules.
  const ownError = o.errorRegion ? null : h('p', { class: 'field__error datefield__error', id: `${id}-error`, 'data-visible': 'false', testid: `${testid}-error` });
  const field = buildField({
    id,
    label,
    testid,
    control: input,
    row,
    hint: o.hint || dateHintText(t, pattern, { yearOptional }),
    errorRegion: o.errorRegion || ownError,
    required,
    className: 'datefield',
  });
  if (ownError) {
    field.el.append(ownError);
    field.setError = (message) => {
      if (message) {
        input.setAttribute('aria-invalid', 'true');
        ownError.textContent = message;
        ownError.setAttribute('data-visible', 'true');
      } else {
        input.removeAttribute('aria-invalid');
        ownError.textContent = '';
        ownError.setAttribute('data-visible', 'false');
      }
    };
  }
  field.el.setAttribute('data-year-optional', yearOptional ? 'true' : 'false');

  let current = null; // last committed {y,m,d}|null

  const parse = () => parseDate(input.value, parseOpts());
  function show(result) {
    field.setError(result.ok ? null : dateErrorMessage(t, result, { pattern }));
    return result;
  }
  function commit() {
    const r = show(parse());
    if (r.ok) {
      current = r.value;
      input.value = r.empty ? '' : formatDate(r.value, pattern);
      field.el.setAttribute('data-value', r.iso);
    } else field.el.setAttribute('data-value', '');
    if (onChange) onChange(r);
    return r;
  }
  input.addEventListener('input', () => {
    const r = parse();
    if (input.getAttribute('aria-invalid') === 'true' && r.ok) show(r); // corrected: the message goes away
    if (onInput) onInput(r);
  });
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (pickBtn && e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      api.openPicker();
    }
  });

  const api = {
    el: field.el,
    input,
    pickerButton: pickBtn,
    errorEl: field.errorEl,
    /** The current value as plain data ({y,m,d} or null when empty or invalid). */
    get value() {
      const r = parse();
      return r.ok && !r.empty ? r.value : null;
    },
    /** The current value as an ISO string ('' when empty or invalid). */
    get iso() {
      const r = parse();
      return r.ok ? r.iso : '';
    },
    /** What the field holds right now (parseDate result), without touching the display. */
    parse,
    /** Validate and show the error; returns the parse result (use before saving). */
    validate: commit,
    /** Set the value from `{y,m,d}`, an ISO string or null; clears the error. */
    setValue(v) {
      const n = v === null || v === undefined || v === '' ? null : normalizeYMD(v);
      current = n;
      input.value = n ? formatDate(n, pattern) : typeof v === 'string' ? v : '';
      field.el.setAttribute('data-value', n ? toISO(n) : '');
      field.setError(null);
    },
    setError: (msg) => field.setError(msg),
    focus: () => input.focus(),
    /** Open the picker dialog; resolves with the chosen {value} or null. */
    async openPicker() {
      if (!pickBtn) return null;
      const r = parse();
      const res = await openDatePicker({
        t,
        lang,
        label,
        testid,
        value: r.ok && !r.empty ? r.value : null,
        min: o.min,
        max: o.max,
        firstWeekday: o.firstWeekday,
        clearable: o.clearable === undefined ? !required : o.clearable,
        now,
      });
      if (res) {
        api.setValue(res.value);
        commit();
        input.focus();
      }
      return res;
    },
    get committed() {
      return current;
    },
  };
  if (o.value) api.setValue(o.value);
  if (pickBtn) pickBtn.addEventListener('click', () => api.openPicker());
  return api;
}

// -------------------------------------------------------------------- the picker

/**
 * Open the month-grid picker dialog.
 * Keys in the grid: arrows (day, week), Page Up/Down (month; Shift: year), Home/End (start/end of the week),
 * Enter or Space on a day chooses it, Esc cancels. Buttons: previous/next month, month and year fields,
 * Today, Clear (when `clearable`), Cancel.
 * @returns {Promise<{value: {y,m,d}|null}|null>} the chosen date (`value: null` = cleared), or null when cancelled
 */
export function openDatePicker({ t = identityT, lang = 'en', label = '', testid = 'field-date', value = null, min, max, firstWeekday, clearable = false, now = () => new Date(), win } = {}) {
  const lo = normalizeYMD(min);
  const hi = normalizeYMD(max);
  const fw = Number.isInteger(firstWeekday) && firstWeekday >= 1 && firstWeekday <= 7 ? firstWeekday : localeFirstWeekday(lang);
  const today = todayYMD(now());
  const selected = value && value.y !== null ? value : null;
  const inRange = (v) => (!lo || lo.y === null || compareYMD(v, lo) >= 0) && (!hi || hi.y === null || compareYMD(v, hi) <= 0);
  let focusDay = clampYMD(selected || today, lo && lo.y !== null ? lo : null, hi && hi.y !== null ? hi : null);
  let result = null;
  let ctrl = null;
  const months = monthNames(lang);
  const names = weekdayNames(lang, fw);
  const fullFmt = new Intl.DateTimeFormat(lang, { dateStyle: 'full', timeZone: 'UTC' });
  const base = `${testid}-picker`;
  const monthLabelId = uniqueId('cal-month');

  const monthSelect = h(
    'select',
    { class: 'input input--compact cal__month', testid: `${base}-month`, 'aria-label': t('widget.date.picker.month') },
    months.map((name, i) => h('option', { value: String(i + 1) }, name)),
  );
  const yearInput = h('input', { type: 'number', class: 'input input--compact cal__year', testid: `${base}-year`, 'aria-label': t('widget.date.picker.year'), min: String(MIN_YEAR), max: String(MAX_YEAR), step: '1', inputmode: 'numeric' });
  const prevBtn = h('button', { type: 'button', class: 'btn btn--small cal__nav', testid: `${base}-prev`, 'aria-label': t('widget.date.picker.prevMonth') }, '‹');
  const nextBtn = h('button', { type: 'button', class: 'btn btn--small cal__nav', testid: `${base}-next`, 'aria-label': t('widget.date.picker.nextMonth') }, '›');
  const live = h('p', { class: 'visually-hidden', role: 'status', id: monthLabelId, testid: `${base}-month-label` });
  const thead = h('thead', null, h('tr', null, names.map((n) => h('th', { scope: 'col', abbr: n.long }, n.short))));
  const tbody = h('tbody');
  const grid = h('table', { class: 'cal__grid', role: 'grid', 'aria-labelledby': monthLabelId, testid: `${base}-grid` }, thead, tbody);
  const help = h('p', { class: 'field__hint cal__help', testid: `${base}-help` }, t('widget.date.picker.keys'));

  const dayButton = (cell) => {
    const iso = toISO(cell);
    const enabled = inRange(cell);
    const isFocus = compareYMD(cell, focusDay) === 0;
    const isSel = selected && compareYMD(cell, selected) === 0;
    const isToday = compareYMD(cell, today) === 0;
    const name = fullFmt.format(new Date(Date.UTC(cell.y, cell.m - 1, cell.d)));
    return h(
      'td',
      { role: 'gridcell', 'aria-selected': isSel ? 'true' : null },
      h(
        'button',
        {
          type: 'button',
          class: ['cal__day', isSel ? 'is-selected' : null, isToday ? 'is-today' : null],
          testid: `${base}-day`,
          'data-date': iso,
          tabindex: isFocus ? '0' : '-1',
          disabled: !enabled,
          'aria-label': enabled ? name : t('widget.date.picker.unavailable', { date: name }),
          'aria-current': isToday ? 'date' : null,
          on: {
            click: () => {
              result = { value: { y: cell.y, m: cell.m, d: cell.d } };
              ctrl.close('pick');
            },
          },
        },
        String(cell.d),
      ),
    );
  };

  function render({ announce = false } = {}) {
    monthSelect.value = String(focusDay.m);
    yearInput.value = String(focusDay.y);
    prevBtn.disabled = focusDay.y <= MIN_YEAR && focusDay.m === 1;
    nextBtn.disabled = focusDay.y >= MAX_YEAR && focusDay.m === 12;
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    for (const week of monthGrid(focusDay.y, focusDay.m, fw)) tbody.append(h('tr', null, week.map((cell) => (cell ? dayButton(cell) : h('td', { class: 'cal__blank', 'aria-hidden': 'true' })))));
    grid.setAttribute('aria-label', t('widget.date.picker.grid', { month: `${months[focusDay.m - 1]} ${focusDay.y}` }));
    if (announce) live.textContent = `${months[focusDay.m - 1]} ${focusDay.y}`;
  }
  const focusCell = () => {
    const btn = tbody.querySelector(`[data-date="${toISO(focusDay)}"]`);
    if (btn && !btn.disabled) btn.focus();
  };
  function moveTo(next, { focus = true } = {}) {
    const monthChanged = next.y !== focusDay.y || next.m !== focusDay.m;
    focusDay = next;
    render({ announce: monthChanged });
    if (focus) focusCell();
  }

  grid.addEventListener('keydown', (e) => {
    const next = navigateDate(focusDay, e.key, { shift: Boolean(e.shiftKey), firstWeekday: fw, min: lo && lo.y !== null ? lo : null, max: hi && hi.y !== null ? hi : null });
    if (!next) return;
    e.preventDefault();
    moveTo(next);
  });
  prevBtn.addEventListener('click', () => moveTo(addMonths({ ...focusDay, d: 1 }, -1), { focus: false }));
  nextBtn.addEventListener('click', () => moveTo(addMonths({ ...focusDay, d: 1 }, 1), { focus: false }));
  monthSelect.addEventListener('change', () => moveTo({ y: focusDay.y, m: Number(monthSelect.value), d: Math.min(focusDay.d, daysInMonth(focusDay.y, Number(monthSelect.value))) }, { focus: false }));
  yearInput.addEventListener('change', () => {
    const y = Number(yearInput.value);
    if (Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR) moveTo({ y, m: focusDay.m, d: Math.min(focusDay.d, daysInMonth(y, focusDay.m)) }, { focus: false });
    else yearInput.value = String(focusDay.y);
  });

  render();
  live.textContent = `${months[focusDay.m - 1]} ${focusDay.y}`;
  const actions = [
    {
      testid: `${base}-today`,
      label: t('widget.date.picker.today'),
      disabled: !inRange(today),
      onClick: () => {
        result = { value: { ...today } };
      },
    },
  ];
  if (clearable)
    actions.push({
      testid: `${base}-clear`,
      label: t('widget.date.picker.clear'),
      onClick: () => {
        result = { value: null };
      },
    });
  actions.push({ testid: 'dialog-cancel', label: t('dialog.cancel'), cancel: true });

  return new Promise((resolve) => {
    ctrl = openDialog({
      testid: `${base}-dialog`,
      title: label ? t('widget.date.picker.title', { label }) : t('widget.date.picker.titlePlain'),
      body: [h('div', { class: 'cal__head' }, prevBtn, monthSelect, yearInput, nextBtn), live, grid, help],
      actions,
      win,
      onClose: () => resolve(result),
    });
    ctrl.dialog.classList.add('dialog--cal');
    focusCell();
  });
}
