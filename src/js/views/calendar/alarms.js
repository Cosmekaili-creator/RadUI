// SPDX-License-Identifier: AGPL-3.0-or-later
// The reminders of the event form (RUN3 D-R3-8): up to three simple alarms, one select each (`field-alarm-<n>`),
// `btn-add-alarm`, `btn-remove-alarm`. An alarm the presets cannot express (45 minutes, "before the END", after the start)
// is kept as a "custom" choice showing its own text, never rewritten. Foreign alarms (audio, absolute, repeating, e-mail)
// are not editable: the editor only says how many are kept as they are (`alarms-foreign`). No notification is ever fired.

import { h } from '../../ui.js';
import { uniqueId } from '../../widgets/fieldkit.js';
import { ALARM_PRESETS, MAX_ALARMS, alarmOfPreset, alarmPresetId } from '../../calendar/formmodel.js';

function unitText(lang, unit, n) {
  try {
    return new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'long' }).format(n);
  } catch {
    return `${n} ${unit}`;
  }
}

/** "45 minutes", "2 hours", "3 days" for a number of seconds (the largest unit that divides it exactly). */
export function amountText(seconds, lang = 'en') {
  const s = Math.abs(seconds);
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (s % size === 0 && s >= size) return unitText(lang, unit, s / size);
  return unitText(lang, 'second', s);
}

/** The visible text of an alarm that is not one of the presets. */
export function customAlarmText(alarm, t, lang = 'en') {
  const end = alarm.related === 'END';
  if (alarm.seconds === 0) return t(end ? 'event.alarm.custom.atEnd' : 'event.alarm.custom.atStart');
  const when = alarm.seconds < 0 ? 'before' : 'after';
  return t(`event.alarm.custom.${end ? 'end' : 'start'}.${when}`, { amount: amountText(alarm.seconds, lang) });
}

/**
 * @param {object} o
 * @param {(key: string, params?: object) => string} o.t
 * @param {(key: string, n: number, params?: object) => string} [o.tp]
 * @param {string} [o.lang]
 * @param {{seconds: number, related: string}[]} [o.alarms] the modelled alarms of the event
 * @param {number} [o.foreign] how many alarms are kept as they are
 * @param {() => void} [o.onChange]
 */
export function createAlarmsEditor({ t, tp, lang = 'en', alarms = [], foreign = 0, onChange } = {}) {
  const plural = (key, n, params) => (tp ? tp(key, n, params) : t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...params }));
  // each row: {choice: preset id | 'custom', alarm: {seconds, related}}
  let rows = alarms.map((a) => ({ choice: alarmPresetId(a), alarm: { seconds: a.seconds, related: a.related === 'END' ? 'END' : 'START' } }));
  const list = h('div', { class: 'alarms__list', testid: 'alarm-list' });
  const addBtn = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-add-alarm', on: { click: () => add() } }, t('event.alarm.add'));
  const maxNote = h('p', { class: 'field__hint', testid: 'alarms-max', hidden: true }, t('event.alarm.max', { n: MAX_ALARMS }));
  const foreignEl = h('p', { class: 'field__hint', testid: 'alarms-foreign', hidden: foreign <= 0 }, foreign > 0 ? plural('event.alarm.foreign', foreign) : '');
  const legend = h('legend', { class: 'field__label' }, t('event.alarm.legend'));
  const el = h('fieldset', { class: 'field alarms', testid: 'alarms' }, legend, list, h('div', { class: 'alarms__actions' }, addBtn), maxNote, foreignEl);
  const emit = () => onChange && onChange();

  function optionsFor(row) {
    const out = ALARM_PRESETS.map((p) => h('option', { value: p.id, selected: row.choice === p.id }, t(`event.alarm.${p.id}`)));
    if (row.choice === 'custom') out.push(h('option', { value: 'custom', selected: true }, customAlarmText(row.alarm, t, lang)));
    return out;
  }
  function draw(focusIndex = null) {
    while (list.firstChild) list.removeChild(list.firstChild);
    rows.forEach((row, i) => {
      const id = uniqueId('alarm');
      const select = h('select', { class: 'input', id, testid: `field-alarm-${i + 1}`, 'aria-label': t('event.alarm.row', { n: i + 1 }) }, ...optionsFor(row));
      select.addEventListener('change', () => {
        row.choice = select.value;
        if (select.value !== 'custom') {
          const p = alarmOfPreset(select.value);
          if (p) row.alarm = p;
        }
        emit();
      });
      const rm = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-remove-alarm', 'aria-label': t('event.alarm.remove', { n: i + 1 }), on: { click: () => remove(i) } }, t('event.alarm.removeShort'));
      list.append(h('div', { class: 'alarms__row', testid: 'alarm-row' }, select, rm));
    });
    const full = rows.length >= MAX_ALARMS;
    addBtn.disabled = full;
    maxNote.hidden = !full;
    if (focusIndex !== null) {
      const sel = list.querySelectorAll('select')[focusIndex];
      if (sel) sel.focus();
    }
  }
  function add() {
    if (rows.length >= MAX_ALARMS) return;
    rows.push({ choice: '10m', alarm: alarmOfPreset('10m') });
    draw(rows.length - 1);
    emit();
  }
  function remove(i) {
    rows.splice(i, 1);
    draw(null);
    const target = list.querySelectorAll('select')[Math.min(i, rows.length - 1)];
    (target || addBtn).focus();
    emit();
  }
  draw();
  return {
    el,
    /** The alarms the form shows now ('none' rows are dropped), in row order. */
    values() {
      const kept = rows.filter((r) => r.choice !== 'none').map((r) => ({ seconds: r.alarm.seconds, related: r.alarm.related }));
      return kept;
    },
    setError(msg) {
      if (msg) addBtn.setAttribute('aria-invalid', 'true');
      else addBtn.removeAttribute('aria-invalid');
    },
    focus: () => addBtn.focus(),
    get rowCount() {
      return rows.length;
    },
  };
}
