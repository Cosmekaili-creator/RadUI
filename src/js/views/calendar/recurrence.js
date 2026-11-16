// SPDX-License-Identifier: AGPL-3.0-or-later
// The recurrence builder of the event form (RUN3 D-R3-7). DOM only: the rule model (parse, build, compare, UNTIL typing)
// is calendar/rrule.js and the sentence is calendar/recurtext.js.
//
// Test ids: recurrence-builder, rec-freq, rec-interval, rec-unit, rec-day-<mo..su>, rec-monthly-day, rec-monthly-nth,
// rec-end-never|until|count, rec-until (date field, `rec-until-input`), rec-count, rec-summary (aria-live), rec-error,
// rec-custom (+ rec-custom-raw, btn-replace-rule), rec-exceptions (+ exception-row, btn-restore-exception).
//
// A rule the builder cannot reproduce exactly (BYSETPOS, BYHOUR, several BYMONTH ...) is `custom`: shown as "Custom rule
// (kept as is)", the controls are hidden, and it is never re-emitted unless "Replace with a simple rule" is pressed.
// The builder never writes: `getRule()` returns data ({mode, state | raw}); the form turns it into a patch.

import { h } from '../../ui.js';
import { uniqueId } from '../../widgets/fieldkit.js';
import { createDateField } from '../../widgets/datefield.js';
import { FREQS, WEEKDAYS, defaultState, nthOf, withFreq, withMonthlyMode } from '../../calendar/rrule.js';
import { monthName, summarizeState, weekdayName } from '../../calendar/recurtext.js';
import { weekdayOf } from '../../calendar/grid.js';

const weekdayCode = (iso) => WEEKDAYS[weekdayOf(iso) - 1];
const isoDate = (spec) => (spec && typeof spec.iso === 'string' ? spec.iso.slice(0, 10) : null);

/**
 * The implicit parts of a rule follow the start date: a weekly rule on the old start's weekday moves to the new one, a
 * monthly rule on the old day (or "nth weekday") to the new one, a yearly one likewise. Parts the user changed stay.
 */
export function followStart(state, oldIso, newIso) {
  if (!oldIso || !newIso || oldIso === newIso) return state;
  const next = { ...state };
  const oldWd = weekdayCode(oldIso);
  const newWd = weekdayCode(newIso);
  const oldN = nthOf(oldIso);
  const newN = nthOf(newIso);
  const oldDay = +oldIso.slice(8, 10);
  const newDay = +newIso.slice(8, 10);
  if (state.freq === 'WEEKLY') {
    if ((state.byday || []).length === 1 && state.byday[0] === oldWd) next.byday = [newWd];
  } else if (state.freq === 'MONTHLY' || state.freq === 'YEARLY') {
    if (state.freq === 'YEARLY' && state.bymonth === +oldIso.slice(5, 7)) next.bymonth = +newIso.slice(5, 7);
    if (state.monthly === 'nth') {
      if (state.nth && state.nth.n === oldN.n && state.nth.weekday === oldWd) next.nth = { n: newN.n, weekday: newWd };
    } else if (state.bymonthday === oldDay) next.bymonthday = newDay;
  }
  return next;
}

function shortWeekday(code, lang) {
  const i = WEEKDAYS.indexOf(code);
  try {
    return new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + (i < 0 ? 0 : i))));
  } catch {
    return code;
  }
}

function dayMonthText(month, day, lang) {
  try {
    return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, day)));
  } catch {
    return `${month}-${day}`;
  }
}

/** The text of the two "repeat on" choices of a monthly or yearly rule: {dom, nth}. */
export function monthlyChoices(state, startIso, { t, tp, lang }) {
  const iso = startIso || '2000-01-01';
  const n = nthOf(iso);
  const nth = state.nth || { n: n.n, weekday: weekdayCode(iso) };
  const day = state.bymonthday || +iso.slice(8, 10);
  const month = state.bymonth || +iso.slice(5, 7);
  if (state.freq === 'YEARLY') {
    const name = monthName(month, lang);
    const vowel = /^[aeiouàâéèêîôûh]/i.test(name);
    return {
      dom: t('recur.on.date', { date: dayMonthText(month, day, lang) }),
      nth: t('recur.on.yearly.nth', { nth: t(`recur.nth.${nth.n}`), weekday: weekdayName(nth.weekday, lang), month: t(vowel ? 'recur.of.vowel' : 'recur.of.consonant', { month: name }) }),
    };
  }
  return {
    dom: tp('recur.on.monthday', day, { day }),
    nth: t('recur.on.nth', { nth: t(`recur.nth.${nth.n}`), weekday: weekdayName(nth.weekday, lang) }),
  };
}

/**
 * @param {object} o
 * @param {{mode: 'none'|'builder'|'custom', state?: object, raw?: string, reason?: string}} o.rule
 * @param {() => ({kind: string, iso: string}|null)} o.getStart the form's current start (null while it is incomplete)
 * @param {{type: 'exdate'|'override', spec: object, key: string}[]} [o.exceptions] listed in `rec-exceptions`
 * @param {(key: string, params?: object) => string} o.t
 * @param {(key: string, n: number, params?: object) => string} o.tp
 * @param {() => void} [o.onChange]
 */
export function createRecurrenceBuilder({ rule = { mode: 'none' }, getStart = () => null, exceptions = [], t, tp, lang = 'en', firstWeekday = 1, now = () => new Date(), onChange } = {}) {
  let mode = rule.mode === 'builder' || rule.mode === 'custom' ? rule.mode : 'none';
  const custom = rule.mode === 'custom' ? { raw: rule.raw, reason: rule.reason } : null;
  let state = rule.mode === 'builder' ? { ...rule.state, byday: [...(rule.state.byday || [])] } : null;
  let lastState = state;
  let origEnd = state ? state.end : null;
  let lastStartIso = isoDate(getStart());
  const ids = uniqueId('rec');
  const emit = () => onChange && onChange();
  const startIso = () => isoDate(getStart()) || new Date(now()).toISOString().slice(0, 10);
  const startSpec = () => getStart() || { kind: 'floating', iso: `${startIso()}T00:00:00` };
  const restored = [];

  // ------------------------------------------------------------------ controls
  const freqOptions = [['NONE', t('event.rec.freq.NONE')], ...FREQS.map((f) => [f, t(`event.rec.freq.${f}`)])];
  if (custom) freqOptions.push(['CUSTOM', t('recur.custom')]);
  const freq = h('select', { class: 'input', id: `${ids}-freq`, testid: 'rec-freq', 'aria-describedby': 'rec-summary' }, ...freqOptions.map(([v, l]) => h('option', { value: v }, l)));
  const interval = h('input', { type: 'number', class: 'input input--narrow', id: `${ids}-interval`, testid: 'rec-interval', min: '1', max: '999', inputmode: 'numeric' });
  const unit = h('span', { class: 'rec__unit', testid: 'rec-unit' });
  const dayBoxes = new Map();
  const order = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(firstWeekday - 1 + i) % 7]);
  const days = h(
    'fieldset',
    { class: 'fieldset fieldset--inline rec__days', testid: 'rec-weekdays' },
    h('legend', { class: 'field__label' }, t('event.rec.weekdays')),
    order.map((code) => {
      const box = h('input', { type: 'checkbox', value: code, testid: `rec-day-${code.toLowerCase()}`, 'aria-label': weekdayName(code, lang) });
      dayBoxes.set(code, box);
      return h('label', { class: 'daybox' }, box, h('span', { 'aria-hidden': 'true' }, shortWeekday(code, lang)));
    }),
  );
  const monthlyName = `${ids}-monthly`;
  const mDay = h('input', { type: 'radio', name: monthlyName, value: 'dom', testid: 'rec-monthly-day' });
  const mNth = h('input', { type: 'radio', name: monthlyName, value: 'nth', testid: 'rec-monthly-nth' });
  const mDayText = h('span');
  const mNthText = h('span');
  const monthly = h('fieldset', { class: 'fieldset fieldset--inline', testid: 'rec-monthly' }, h('legend', { class: 'field__label' }, t('event.rec.repeatOn')), h('label', { class: 'radio' }, mDay, mDayText), h('label', { class: 'radio' }, mNth, mNthText));
  const endName = `${ids}-end`;
  const endNever = h('input', { type: 'radio', name: endName, value: 'never', testid: 'rec-end-never' });
  const endUntil = h('input', { type: 'radio', name: endName, value: 'until', testid: 'rec-end-until' });
  const endCount = h('input', { type: 'radio', name: endName, value: 'count', testid: 'rec-end-count' });
  const until = createDateField({ testid: 'rec-until', label: t('event.rec.untilLabel'), t, lang, picker: true, firstWeekday, now, onChange: () => untilChanged(), onInput: () => untilChanged() });
  const count = h('input', { type: 'number', class: 'input input--narrow', testid: 'rec-count', min: '1', max: '9999', inputmode: 'numeric', 'aria-label': t('event.rec.countLabel') });
  const ends = h(
    'fieldset',
    { class: 'fieldset rec__ends', testid: 'rec-ends' },
    h('legend', { class: 'field__label' }, t('event.rec.ends')),
    h('div', { class: 'radio-row' }, h('label', { class: 'radio' }, endNever, h('span', null, t('event.rec.end.never')))),
    h('div', { class: 'radio-row' }, h('label', { class: 'radio' }, endUntil, h('span', null, t('event.rec.end.until'))), until.el),
    h('div', { class: 'radio-row' }, h('label', { class: 'radio' }, endCount, h('span', null, t('event.rec.end.count'))), h('span', { class: 'with-suffix' }, count, h('span', { 'aria-hidden': 'true' }, t('event.rec.times')))),
  );
  const every = h('div', { class: 'rec__every' }, h('label', { for: `${ids}-interval` }, t('event.rec.every')), interval, unit);
  const details = h('div', { class: 'rec__details', testid: 'rec-details' }, every, days, monthly, ends);
  const summary = h('p', { class: 'rec__summary', id: 'rec-summary', testid: 'rec-summary', 'aria-live': 'polite' });
  const error = h('p', { class: 'field__error', testid: 'rec-error', hidden: true });
  const replace = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-replace-rule', on: { click: () => replaceRule() } }, t('event.rec.replace'));
  const customBox = h('div', { class: 'notice', testid: 'rec-custom', hidden: true }, h('p', null, t('event.rec.customText')), h('p', null, h('code', { class: 'rec__raw', testid: 'rec-custom-raw' }, custom ? custom.raw : '')), replace);
  const exList = h('ul', { class: 'exlist', testid: 'rec-exceptions' });
  const exBox = h('div', { class: 'field rec__exceptions', hidden: !exceptions.length }, h('span', { class: 'field__label', id: `${ids}-ex` }, t('event.rec.exceptions')), exList);
  const el = h(
    'fieldset',
    { class: 'fieldset rec', testid: 'recurrence-builder' },
    h('legend', { class: 'field__label' }, t('event.rec.title')),
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: `${ids}-freq` }, t('event.rec.repeat')), freq),
    customBox,
    details,
    summary,
    error,
    exBox,
  );

  // ------------------------------------------------------------------ state <-> controls
  function labels() {
    const s = state || defaultState(startSpec(), 'MONTHLY');
    const c = monthlyChoices(s.freq === 'YEARLY' ? s : { ...s, freq: 'MONTHLY' }, startIso(), { t, tp, lang });
    mDayText.textContent = c.dom;
    mNthText.textContent = c.nth;
  }
  function drawControls() {
    const f = mode === 'custom' ? 'CUSTOM' : mode === 'none' ? 'NONE' : state.freq;
    freq.value = f;
    customBox.hidden = mode !== 'custom';
    details.hidden = mode !== 'builder';
    if (mode === 'builder') {
      interval.value = Number.isFinite(state.interval) ? String(state.interval) : '';
      unit.textContent = tp(`event.rec.unit.${state.freq}`, Number.isFinite(state.interval) ? state.interval : 1);
      days.hidden = state.freq !== 'WEEKLY';
      for (const [code, box] of dayBoxes) box.checked = (state.byday || []).includes(code);
      monthly.hidden = state.freq !== 'MONTHLY' && state.freq !== 'YEARLY';
      labels();
      mDay.checked = state.monthly !== 'nth';
      mNth.checked = state.monthly === 'nth';
      const end = state.end || { type: 'never' };
      endNever.checked = end.type === 'never';
      endUntil.checked = end.type === 'until';
      endCount.checked = end.type === 'count';
      if (end.type === 'until') until.setValue(end.date || '');
      count.value = end.type === 'count' && Number.isFinite(end.count) ? String(end.count) : count.value || '10';
    }
    refreshSummary();
  }
  function readControls() {
    if (mode !== 'builder') return;
    const next = { ...state };
    next.freq = freq.value === 'CUSTOM' || freq.value === 'NONE' ? state.freq : freq.value;
    const iv = interval.value.trim();
    next.interval = /^\d{1,3}$/.test(iv) ? +iv : NaN;
    next.byday = WEEKDAYS.filter((c) => dayBoxes.get(c).checked);
    next.monthly = mNth.checked ? 'nth' : 'dom';
    const type = endUntil.checked ? 'until' : endCount.checked ? 'count' : 'never';
    if (type === 'until') {
      const r = until.parse();
      const date = r.ok && !r.empty ? r.iso : until.input.value.trim();
      const same = origEnd && origEnd.type === 'until' && origEnd.rawDate === date;
      next.end = same ? { type, date, raw: origEnd.raw, rawDate: origEnd.rawDate } : { type, date };
    } else if (type === 'count') {
      const c = count.value.trim();
      next.end = { type, count: /^\d{1,4}$/.test(c) ? +c : NaN };
    } else next.end = { type };
    state = next;
    lastState = state;
  }
  function refreshSummary() {
    let text = '';
    try {
      if (mode === 'none') text = t('recur.none');
      else if (mode === 'custom') text = t('recur.custom');
      else if (Number.isFinite(state.interval) && state.interval >= 1) text = summarizeState(state, { t, tp, lang, startSpec: startSpec() });
      else text = t('event.rec.incomplete');
    } catch {
      text = t('event.rec.incomplete');
    }
    summary.textContent = text;
    if (mode === 'builder') unit.textContent = tp(`event.rec.unit.${state.freq}`, Number.isFinite(state.interval) ? state.interval : 1);
  }
  function untilChanged() {
    if (mode !== 'builder') return;
    endUntil.checked = true;
    endNever.checked = false;
    endCount.checked = false;
    changed();
  }
  function changed() {
    readControls();
    refreshSummary();
    emit();
  }

  function setFreq(value) {
    if (value === 'NONE') {
      mode = 'none';
      if (state) lastState = state;
    } else if (value === 'CUSTOM') {
      mode = 'custom';
    } else {
      const base = state || lastState || defaultState(startSpec(), value);
      const keep = { interval: Number.isFinite(base.interval) ? base.interval : 1, end: base.end || { type: 'never' }, wkst: base.wkst || null };
      state = { ...withFreq({ ...base, ...keep }, value, startSpec()), interval: keep.interval, end: keep.end, wkst: keep.wkst };
      lastState = state;
      mode = 'builder';
    }
    drawControls();
    emit();
  }
  function replaceRule() {
    mode = 'builder';
    state = defaultState(startSpec(), 'WEEKLY');
    lastState = state;
    origEnd = null;
    const opt = freq.querySelectorAll('option').find((o) => o.value === 'CUSTOM');
    if (opt) opt.remove();
    drawControls();
    emit();
    freq.focus();
  }

  freq.addEventListener('change', () => setFreq(freq.value));
  for (const input of [interval, count]) input.addEventListener('input', changed);
  for (const box of dayBoxes.values()) box.addEventListener('change', changed);
  for (const r of [mDay, mNth, endNever, endUntil, endCount]) r.addEventListener('change', changed);
  count.addEventListener('focus', () => {
    if (mode === 'builder' && !endCount.checked) {
      endCount.checked = true;
      endNever.checked = false;
      endUntil.checked = false;
      changed();
    }
  });

  // ------------------------------------------------------------------ exceptions
  function drawExceptions() {
    while (exList.firstChild) exList.removeChild(exList.firstChild);
    const shown = exceptions.filter((e) => !restored.some((r) => r.key === e.key));
    exBox.hidden = !exceptions.length;
    if (!shown.length) {
      exList.append(h('li', { class: 'meta-line' }, t(exceptions.length ? 'event.rec.allRestored' : 'event.rec.noExceptions')));
      return;
    }
    for (const e of shown) {
      const text = exceptionText(e.spec, lang);
      const row = h('li', { class: 'exlist__row', testid: 'exception-row', 'data-type': e.type, 'data-key': e.key }, h('span', null, text, ' ', h('span', { class: 'meta-line' }, t(e.type === 'override' ? 'event.exc.type.override' : 'event.exc.type.exdate'))));
      if (e.type === 'exdate') {
        row.append(h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-restore-exception', 'aria-label': t('event.rec.restore', { date: text }), on: { click: () => restore(e) } }, t('event.rec.restoreShort')));
      }
      exList.append(row);
    }
  }
  function restore(e) {
    restored.push(e);
    drawExceptions();
    const first = exList.querySelector('[data-testid="btn-restore-exception"]');
    (first || freq).focus();
    emit();
  }

  // ------------------------------------------------------------------ init
  if (mode === 'builder') {
    // the date field shows the stored UNTIL day
    if (state.end && state.end.type === 'until') until.setValue(state.end.date);
  }
  drawControls();
  drawExceptions();

  return {
    el,
    get mode() {
      return mode;
    },
    /** {mode: 'none'} | {mode: 'builder', state} | {mode: 'custom', raw, reason} */
    getRule() {
      if (mode === 'custom') return { mode: 'custom', raw: custom.raw, reason: custom.reason };
      if (mode === 'none') return { mode: 'none' };
      readControls();
      return { mode: 'builder', state };
    },
    /** The EXDATE entries the user chose to bring back (ops `removeExdate`, applied before anything else). */
    restored: () => restored.map((e) => e.spec),
    restoredEntries: () => restored.slice(),
    /** Tell the builder the form's start changed (the implicit parts follow it). */
    setStart() {
      const now2 = isoDate(getStart());
      if (mode === 'builder' && lastStartIso && now2) {
        readControls();
        state = followStart(state, lastStartIso, now2);
        lastState = state;
      }
      if (now2) lastStartIso = now2;
      drawControls();
    },
    summary: () => summary.textContent,
    setError(msg) {
      error.textContent = msg || '';
      error.hidden = !msg;
      if (msg) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
    },
    focus: () => freq.focus(),
    /** Set the exception rows (the form passes them for the scope "all" only). */
    setExceptions(list) {
      exceptions.splice(0, exceptions.length, ...list);
      drawExceptions();
    },
  };
}

function exceptionText(spec, lang) {
  const [y, mo, d] = spec.iso.slice(0, 10).split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, +(spec.iso.slice(11, 13) || 0), +(spec.iso.slice(14, 16) || 0));
  try {
    const opts = { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' };
    if (spec.kind !== 'date') Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
    return new Intl.DateTimeFormat(lang, opts).format(new Date(wall));
  } catch {
    return spec.iso;
  }
}
