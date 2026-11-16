// SPDX-License-Identifier: AGPL-3.0-or-later
// Own typeable time field (SPECS 10a-1): a text input with a visible format hint, 24 h unless the
// app setting says otherwise, strict validation, ISO `HH:MM` always accepted.
//
// Logic (parseTime, formatTime, ...) is DOM-free; createTimeField renders it with ui.js `h()`.
// Values are plain data `{h, mi}` and the ISO string `HH:MM`.

import { h } from '../ui.js';
import { buildField, identityT, uniqueId } from './fieldkit.js';

const pad = (n) => String(n).padStart(2, '0');
const isInt = (n) => Number.isInteger(n);

/** True for `{h, mi}` with h 0-23 and mi 0-59. */
export function isValidHM(v) {
  return Boolean(v) && typeof v === 'object' && isInt(v.h) && v.h >= 0 && v.h <= 23 && isInt(v.mi) && v.mi >= 0 && v.mi <= 59;
}

/** `HH:MM`, or '' for an invalid value. */
export function timeToISO(v) {
  return isValidHM(v) ? `${pad(v.h)}:${pad(v.mi)}` : '';
}

/** Strict reader of `HH:MM` and `HH:MM:SS` (seconds must be 00). null for anything else. */
export function timeFromISO(text) {
  const m = typeof text === 'string' ? text.match(/^(\d{2}):(\d{2})(?::00)?$/) : null;
  const v = m ? { h: Number(m[1]), mi: Number(m[2]) } : null;
  return v && isValidHM(v) ? v : null;
}

/** Accept `{h, mi}` or an ISO string; else null. */
export function normalizeHM(x) {
  if (typeof x === 'string') return timeFromISO(x);
  return isValidHM(x) ? { h: x.h, mi: x.mi } : null;
}

export const minutesOf = (v) => v.h * 60 + v.mi;

const markerCache = new Map();
/** The AM and PM markers of a language, lower-cased (`Intl` day periods), plus the English ones. */
export function dayPeriods(lang = 'en') {
  const key = String(lang);
  if (markerCache.has(key)) return markerCache.get(key);
  const out = { am: ['am', 'a.m.', 'a.m'], pm: ['pm', 'p.m.', 'p.m'] };
  try {
    const f = new Intl.DateTimeFormat(key, { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' });
    const get = (hour) => f.formatToParts(new Date(Date.UTC(1970, 0, 1, hour, 0))).find((p) => p.type === 'dayPeriod');
    for (const [k, hour] of [
      ['am', 1],
      ['pm', 13],
    ]) {
      const p = get(hour);
      if (p && p.value) out[k] = [...new Set([p.value.toLowerCase().replace(/\s+/g, ''), ...out[k]])];
    }
  } catch {
    /* English markers only */
  }
  markerCache.set(key, out);
  return out;
}

/**
 * Format a time: 24 h as `HH:MM`; 12 h with the locale's AM/PM (`2:30 PM`).
 * @returns {string} '' for an invalid value
 */
export function formatTime(v, { use24h = true, lang = 'en' } = {}) {
  if (!isValidHM(v)) return '';
  if (use24h) return timeToISO(v);
  try {
    return new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit', hourCycle: 'h12', timeZone: 'UTC' }).format(new Date(Date.UTC(1970, 0, 1, v.h, v.mi)));
  } catch {
    return `${v.h % 12 === 0 ? 12 : v.h % 12}:${pad(v.mi)} ${v.h < 12 ? 'AM' : 'PM'}`;
  }
}

/** A fixed, fictional example (14:30). */
export const EXAMPLE_TIME = Object.freeze({ h: 14, mi: 30 });

/**
 * Parse what the user typed.
 * Accepted: `14:30`, `9:05`, `0905`, `930`, `9.30`, `9h30`, `9h`, `9` and ISO `HH:MM[:00]`; with AM/PM (or the
 * language's markers, `a.m.`, `p.m.`) the hour is 1-12. A time typed without a marker is read on the 24-hour
 * clock in both modes (a 12 h field shows it back with its marker). Hours 0-23 and minutes 0-59 only.
 * @param {string} text
 * @param {{lang?: string, required?: boolean, min?: string|{h,mi}, max?: string|{h,mi}}} [opts]
 * @returns {{ok: true, empty: true, value: null, iso: ''}|{ok: true, empty: false, value: {h,mi}, iso: string}
 *   |{ok: false, error: 'required'|'format'|'hour'|'minute'|'min'|'max', detail: object}}
 */
export function parseTime(text, { lang = 'en', required = false, min, max } = {}) {
  let s = String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200E\u200F\u061C]/g, '')
    .trim()
    .toLowerCase();
  if (s === '') return required ? { ok: false, error: 'required', detail: {} } : { ok: true, empty: true, value: null, iso: '' };
  const fail = (error, detail = {}) => ({ ok: false, error, detail });

  // day period marker at the end or at the start (ja: 午後 2:30)
  let period = null;
  const markers = dayPeriods(lang);
  const compact = (str) => str.replace(/\s+/g, '');
  for (const kind of ['am', 'pm']) {
    for (const m of markers[kind]) {
      const c = compact(s);
      if (c.endsWith(m) && c.length > m.length) {
        period = kind;
        s = c.slice(0, c.length - m.length);
        break;
      }
      if (c.startsWith(m) && c.length > m.length) {
        period = kind;
        s = c.slice(m.length);
        break;
      }
    }
    if (period) break;
  }
  s = s.replace(/\s+/g, '');
  let hh;
  let mi = 0;
  let m = s.match(/^(\d{1,2})(?:([:.h])(\d{2})?)?(?::(\d{2}))?$/);
  if (m) {
    if (m[2] && m[2] !== 'h' && m[3] === undefined) return fail('format');
    if (m[4] !== undefined && Number(m[4]) !== 0) return fail('format'); // never drop non-zero seconds silently
    if (m[4] !== undefined && m[3] === undefined) return fail('format');
    hh = Number(m[1]);
    mi = m[3] === undefined ? 0 : Number(m[3]);
  } else if ((m = s.match(/^(\d{1,2})(\d{2})$/))) {
    hh = Number(m[1]);
    mi = Number(m[2]);
  } else return fail('format');

  if (mi > 59) return fail('minute', { minute: mi });
  if (period) {
    if (hh < 1 || hh > 12) return fail('hour', { hour: hh });
    hh = (hh % 12) + (period === 'pm' ? 12 : 0);
  } else if (hh > 23) return fail('hour', { hour: hh });
  const value = { h: hh, mi };
  const lo = normalizeHM(min);
  const hi = normalizeHM(max);
  if (lo && minutesOf(value) < minutesOf(lo)) return fail('min', { min: timeToISO(lo) });
  if (hi && minutesOf(value) > minutesOf(hi)) return fail('max', { max: timeToISO(hi) });
  return { ok: true, empty: false, value, iso: timeToISO(value) };
}

/** Translated message of a failed parse (`widget.time.err.<code>`). */
export function timeErrorMessage(t, result, { use24h = true, lang = 'en' } = {}) {
  const d = result.detail || {};
  return t(`widget.time.err.${result.error}`, {
    format: timeFormatText(t, use24h),
    example: formatTime(EXAMPLE_TIME, { use24h, lang }),
    min: d.min ? formatTime(timeFromISO(d.min), { use24h, lang }) : '',
    max: d.max ? formatTime(timeFromISO(d.max), { use24h, lang }) : '',
  });
}

/** 'HH:MM' or 'h:mm AM/PM' (translated). */
export function timeFormatText(t, use24h) {
  return t(use24h ? 'widget.time.format24' : 'widget.time.format12');
}

/** The visible hint text of a field. */
export function timeHintText(t, { use24h = true, lang = 'en' } = {}) {
  return t(use24h ? 'widget.time.hint24' : 'widget.time.hint12', { format: timeFormatText(t, use24h), example: formatTime(EXAMPLE_TIME, { use24h, lang }) });
}

/**
 * @param {object} o
 * @param {string} o.testid   `field-start-time`: wrapper; `-input` and `-error` suffixes
 * @param {string} o.label
 * @param {(key: string, params?: object) => string} o.t
 * @param {string} [o.lang]  @param {boolean} [o.use24h=true]  @param {string|{h,mi}|null} [o.value]
 * @param {boolean} [o.required] @param {string|object} [o.min] @param {string|object} [o.max]
 * @param {HTMLElement} [o.errorRegion]  caller-provided error element
 * @param {(result: object) => void} [o.onChange] @param {(result: object) => void} [o.onInput]
 */
export function createTimeField(o) {
  const { testid, label, t = identityT, lang = 'en', use24h = true, required = false, onChange, onInput } = o;
  const id = o.id || uniqueId('time');
  const parseOpts = () => ({ lang, required, min: o.min, max: o.max });
  const input = h('input', {
    type: 'text',
    id,
    class: 'input timefield__input',
    testid: `${testid}-input`,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: '12',
    placeholder: timeFormatText(t, use24h),
    ...(o.inputProps || {}),
  });
  const field = buildField({ id, label, testid, control: input, hint: o.hint || timeHintText(t, { use24h, lang }), errorRegion: o.errorRegion, required, className: 'timefield' });
  const parse = () => parseTime(input.value, parseOpts());
  function show(result) {
    field.setError(result.ok ? null : timeErrorMessage(t, result, { use24h, lang }));
    return result;
  }
  function commit() {
    const r = show(parse());
    if (r.ok) {
      input.value = r.empty ? '' : formatTime(r.value, { use24h, lang });
      field.el.setAttribute('data-value', r.iso);
    } else field.el.setAttribute('data-value', '');
    if (onChange) onChange(r);
    return r;
  }
  input.addEventListener('input', () => {
    const r = parse();
    if (input.getAttribute('aria-invalid') === 'true' && r.ok) show(r);
    if (onInput) onInput(r);
  });
  input.addEventListener('change', commit);
  const api = {
    el: field.el,
    input,
    errorEl: field.errorEl,
    /** The value as plain data ({h, mi}) or null when empty or invalid. */
    get value() {
      const r = parse();
      return r.ok && !r.empty ? r.value : null;
    },
    /** The value as `HH:MM` ('' when empty or invalid). */
    get iso() {
      const r = parse();
      return r.ok ? r.iso : '';
    },
    parse,
    validate: commit,
    setValue(v) {
      const n = v === null || v === undefined || v === '' ? null : normalizeHM(v);
      input.value = n ? formatTime(n, { use24h, lang }) : typeof v === 'string' ? v : '';
      field.el.setAttribute('data-value', n ? timeToISO(n) : '');
      field.setError(null);
    },
    setError: (msg) => field.setError(msg),
    focus: () => input.focus(),
  };
  if (o.value) api.setValue(o.value);
  return api;
}
