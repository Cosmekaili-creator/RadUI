// SPDX-License-Identifier: AGPL-3.0-or-later
// The calendar section of Settings (RUN3 D-R3-9, WP B3b): display time zone, first day of the week, 12 / 24 hour clock,
// the virtual Birthdays calendar and its duplicate filter. Every choice is per login and applies without a reload:
//   - the display zone is tzprefs' own pref (`radui.tz.display.<login>`, recents included), read when the calendar mounts;
//   - the others are `cal.*` preferences of settings/prefs.js, which the calendar screen subscribes to.
// Nothing here writes to the server: the display zone only changes how times are drawn.
//
// Test ids: settings-calendar, settings-tz-display (the zone button; its picker is `zone-picker` / `field-zone-search` /
// `zone-option`), settings-first-weekday, settings-24h, settings-birthdays, settings-bday-hide-duplicates,
// settings-cal-status.

import { fill, h } from '../../ui.js';
import { buildField, uniqueId } from '../../widgets/fieldkit.js';

// The zone picker and the zone preference need the time model (ical.js): they are loaded when this section is built, not with
// Settings, so an account that only uses contacts never pays for them until it opens this screen.

/** The preference names the calendar screen reads (views/calendar/common.js PREF; a test keeps both in step). */
export const PREF = Object.freeze({ firstWeekday: 'cal.firstWeekday', use24h: 'cal.use24h', birthdays: 'cal.birthdays', hideDup: 'cal.hideDupBirthdays' });
const WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
const AUTO = 'auto';

function weekdayName(index, lang) {
  try {
    return new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)));
  } catch {
    return WEEKDAYS[index];
  }
}

/** The three-way clock choice: pref value -> select value and back. */
export const clockChoice = (pref) => (pref === true ? '24' : pref === false ? '12' : AUTO);
export const clockPref = (choice) => (choice === '24' ? true : choice === '12' ? false : null);

/**
 * @param {object} env the settings screen's env {t, tp, app, login, prefs, disposed}
 * @param {object} [deps] {storage, zonePick, win, timers} (tests)
 */
export function calendarSection(env, deps = {}) {
  const { t, app, login, prefs } = env;
  const tp = env.tp || app.tp;
  const lang = app.lang || 'en';
  const status = h('p', { class: 'settings__note', role: 'status', testid: 'settings-cal-status' });
  const say = (what) => {
    status.textContent = t('settings.cal.saved', { what });
    if (app.feedback && app.feedback.setStatus) app.feedback.setStatus(status.textContent);
  };
  const get = (name, fallback) => (prefs ? prefs.get(name, fallback) : fallback);
  const put = (name, value) => {
    if (!prefs) return;
    if (value === null || value === undefined) prefs.remove(name);
    else prefs.set(name, value);
  };

  // ---------------------------------------------------------------- display time zone
  const zoneSlot = h('div', { class: 'settings__zone', testid: 'settings-tz-slot' }, h('p', { class: 'settings__note' }, t('settings.cal.tzLoading')));
  const zoneReady = Promise.all([import('../calendar/tzpicker.js'), import('../../calendar/tzprefs.js')]).then(([picker, zp]) => {
    if (env.disposed && env.disposed()) return null;
    const zone = picker.createZoneField({
      testid: 'settings-tz-display',
      label: t('settings.cal.tz'),
      value: zp.loadDisplayZone(login, { storage: deps.storage, defaultZone: app.timeZone }),
      t,
      tp,
      login,
      storage: deps.storage,
      hint: t('settings.cal.tzHint'),
      deps: { win: deps.win, timers: deps.timers, pick: deps.zonePick },
      onChange: (z) => {
        zp.saveDisplayZone(login, z, { storage: deps.storage });
        say(t('settings.cal.tz'));
      },
    });
    fill(zoneSlot, zone.el);
    return zone;
  });

  // ---------------------------------------------------------------- first weekday
  const wdId = uniqueId('cal-fw');
  const wdSelect = h('select', { class: 'input', id: wdId, testid: 'settings-first-weekday' }, h('option', { value: AUTO }, t('settings.cal.firstWeekday.auto')), ...WEEKDAYS.map((code, i) => h('option', { value: String(i + 1) }, weekdayName(i, lang))));
  const fw = get(PREF.firstWeekday, null);
  wdSelect.value = Number.isInteger(fw) && fw >= 1 && fw <= 7 ? String(fw) : AUTO;
  wdSelect.addEventListener('change', () => {
    put(PREF.firstWeekday, wdSelect.value === AUTO ? null : Number(wdSelect.value));
    say(t('settings.cal.firstWeekday'));
  });
  const wdField = buildField({ id: wdId, label: t('settings.cal.firstWeekday'), testid: null, control: wdSelect });

  // ---------------------------------------------------------------- clock
  const clockId = uniqueId('cal-24h');
  const clockSelect = h(
    'select',
    { class: 'input', id: clockId, testid: 'settings-24h' },
    h('option', { value: AUTO }, t('settings.cal.clock.auto')),
    h('option', { value: '24' }, t('settings.cal.clock.24')),
    h('option', { value: '12' }, t('settings.cal.clock.12')),
  );
  clockSelect.value = clockChoice(get(PREF.use24h, null));
  clockSelect.addEventListener('change', () => {
    put(PREF.use24h, clockPref(clockSelect.value));
    say(t('settings.cal.clock'));
  });
  const clockField = buildField({ id: clockId, label: t('settings.cal.clock'), testid: null, control: clockSelect });

  // ---------------------------------------------------------------- birthdays
  const check = (testid, label, hint, name, fallback) => {
    const id = uniqueId('cal-chk');
    const box = h('input', { type: 'checkbox', id, testid, checked: get(name, fallback) !== false, 'aria-describedby': `${id}-hint` });
    box.addEventListener('change', () => {
      put(name, box.checked);
      say(label);
    });
    return { box, el: h('div', { class: 'check-block' }, h('div', { class: 'check' }, box, h('label', { for: id }, label)), h('p', { class: 'field__hint', id: `${id}-hint` }, hint)) };
  };
  const bday = check('settings-birthdays', t('settings.cal.birthdays'), t('settings.cal.birthdaysHint'), PREF.birthdays, true);
  const dup = check('settings-bday-hide-duplicates', t('settings.cal.hideDup'), t('settings.cal.hideDupHint'), PREF.hideDup, true);
  if (!prefs) for (const c of [wdSelect, clockSelect, bday.box, dup.box]) c.disabled = true;

  const section = h(
    'section',
    { class: 'settings__section', testid: 'settings-calendar', 'aria-labelledby': 'settings-calendar-title' },
    h('h2', { class: 'section-title', id: 'settings-calendar-title' }, t('settings.cal.title')),
    h('p', { class: 'settings__note' }, t('settings.cal.explain')),
    h('div', { class: 'settings__form' }, zoneSlot, wdField.el, clockField.el, bday.el, dup.el),
    status,
  );
  zoneReady.catch(() => fill(zoneSlot, h('p', { class: 'settings__note' }, t('settings.cal.tzFailed'))));
  /** Resolves with the zone control once it is built (tests). */
  section.zoneReady = zoneReady;
  return section;
}
