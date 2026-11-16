// SPDX-License-Identifier: AGPL-3.0-or-later
// The event form (`#/events/new`, `#/events/<key>/edit`): ONE form for both (RUN3 WP B3b). Rules, as for the contact form:
//  - `{text, etag}` of the event is kept from the moment the form opens; every save passes it as `base`;
//  - the patch is built by calendar/formmodel.toPatch(base values, values): a form that changed nothing sends nothing, an
//    untouched time group keeps its TZID and the form of the stored value, an existing zone is rewritten only when its
//    picker was used;
//  - what the patch means for a series (this occurrence, this and following, all) is decided by calendar/scope.planEdit and
//    the result is DATA the write path replays (`applyOps`, `splitWrite`); this file never touches a DAV method;
//  - Save is disabled while a request is in flight; a conflict opens the shared conflict dialog; unsaved input is guarded
//    (app.setDirty) and kept over a language switch (snapshot / restore);
//  - after `unknown-result` a create is retried ONLY with the result's `retry` token.
//
// Test ids: event-form-screen, event-form, field-title, field-calendar, field-allday, field-start-date (-input), field-start-time
// (-input), field-tz-start, field-end-date, field-end-time, field-tz-end, event-when-preview, field-location, field-url,
// field-description, field-categories (chips), field-status, field-transp, alarms (field-alarm-<n>, btn-add-alarm),
// recurrence-builder (rec-*), scope-notice, event-attendees-note, form-errors, form-error-link, form-status, event-save,
// event-cancel, event-form-notfound, event-readonly. Dialogs: dialog-scope-* (scopedialog.js), dialog-rule-exceptions.

import { clear, fill, h } from '../../ui.js';
import { createChips, textField } from '../contacts/formfields.js';
import { buildField, uniqueId } from '../../widgets/fieldkit.js';
import { createDateField } from '../../widgets/datefield.js';
import { createTimeField } from '../../widgets/timefield.js';
import { createAnnouncer } from '../../widgets/timing.js';
import { isolate } from '../../widgets/avatar.js';
import { classify, davErrorKey } from '../../store/errors.js';
import { hashFor } from '../../router.js';
import { STATUS_OPTIONS, TRANSP_OPTIONS, fromItem, newEventValues, toNewFields, toPatch, validate, valuesToSpecs, whenInfo } from '../../calendar/formmodel.js';
import { dateMs, isValidDate, isoOfMs, todayIn } from '../../calendar/grid.js';
import { availableScopes, findOccurrence, isRecurring, planEdit } from '../../calendar/scope.js';
import { loadDisplayZone } from '../../calendar/tzprefs.js';
import { generateVtimezone } from '../../calendar/tz.js';
import { openConflictDialog, modeOf } from '../conflictdialog.js';
import { cleanQuery, dayText, readCalPrefs, timeText } from './common.js';
import { createCalendarSource } from './source.js';
import { createAlarmsEditor } from './alarms.js';
import { createRecurrenceBuilder } from './recurrence.js';
import { createZoneField } from './tzpicker.js';
import { askRuleExceptions } from './scopedialog.js';

const limitCache = new Map();
/** The year up to which the clock changes of an IANA zone are exact in a generated VTIMEZONE, or null (periodic for ever, floating or unknown zone). */
export function tzLimitYear(tzid) {
  if (!tzid || tzid === 'UTC') return null;
  if (!limitCache.has(tzid)) {
    let year = null;
    try {
      const { info } = generateVtimezone(tzid);
      year = info.openEnded === false ? info.coveredThrough : null;
    } catch {
      year = null;
    }
    limitCache.set(tzid, year);
  }
  return limitCache.get(tzid);
}

/** A restored exception (an EXDATE taken back) cannot travel with "this and following": the form refuses instead of dropping it silently. */
export const restoreBlocksSplit = (plan, restoredOps) => Boolean(plan) && plan.action === 'split' && Array.isArray(restoredOps) && restoredOps.length > 0;

const OK_STATUS = new Set(['saved', 'created', 'copied', 'unchanged', 'reloaded', 'discarded']);
const NONE = 'none';
const TIME_PARAM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Browser objects and collaborators; a test passes its own through `mount(ctx, deps)`. */
export function resolveDeps(deps = {}) {
  const win = deps.win || globalThis.window;
  const doc = deps.doc || globalThis.document;
  return {
    win,
    doc,
    now: () => new Date(),
    storage: undefined,
    browserZone: undefined,
    isOnline: () => !win || !win.navigator || win.navigator.onLine !== false,
    openConflictDialog,
    askRuleExceptions,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
    zonePick: undefined,
    ...deps,
  };
}

/** 24-hour clock? The preference wins, else what the language uses. */
export function resolveUse24h(pref, lang) {
  if (typeof pref === 'boolean') return pref;
  try {
    const cycle = new Intl.DateTimeFormat(lang, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle !== 'h11' && cycle !== 'h12';
  } catch {
    return true;
  }
}

const wallOf = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), +(iso.slice(11, 13) || 0), +(iso.slice(14, 16) || 0), +(iso.slice(17, 19) || 0));

/** "1 h 30", "45 min", "2 d 3 h" from seconds, through the `event.dur.*` templates. */
export function durationText(seconds, t) {
  const total = Math.max(0, Math.round(seconds / 60));
  const d = Math.floor(total / 1440);
  const hh = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts = [];
  if (d) parts.push(t('event.dur.d', { n: d }));
  if (hh) parts.push(t('event.dur.h', { n: hh }));
  if (m || !parts.length) parts.push(t('event.dur.min', { n: hh || d ? String(m).padStart(2, '0') : m }));
  return parts.join(' ');
}

/**
 * The text of `event-when-preview` (always visible, aria-live polite): where the event falls in the display zone, the
 * duration, and the DST notes as TEXT (a time inside a gap does not exist and is stored as the instant after it).
 */
export function previewText(info, values, { t, tp, lang = 'en', use24h = null, displayTz } = {}) {
  if (!info) return '';
  // the end is before the start: say so in words instead of a negative duration ("Mar 3 09:00 to Mar 1 10:00 · 0 min")
  if (typeof info.durationSec === 'number' && (info.allDay ? info.durationSec <= 0 : info.durationSec < 0)) return t('event.preview.endBeforeStart');
  const opt = { lang, use24h };
  const timeOf = (iso) => timeText(wallOf(iso), opt);
  const dayTimeOf = (iso) => `${dayText(wallOf(iso), opt)} ${timeOf(iso)}`;
  if (info.allDay) {
    const days = Math.max(1, Math.round(info.durationSec / 86400));
    return days > 1 ? tp('event.preview.allDayMany', days) : t('event.preview.allDay');
  }
  const sTz = values.startTz;
  const eTz = values.endTz;
  const dur = durationText(info.durationSec, t);
  const sIso = info.start.iso;
  const eIso = info.end.iso;
  let main;
  if (!sTz && !eTz) {
    main = t('event.preview.floating', { start: dayTimeOf(sIso), end: sIso.slice(0, 10) === eIso.slice(0, 10) ? timeOf(eIso) : dayTimeOf(eIso), duration: dur });
  } else if (!info.display) {
    main = t('event.preview.noInstant', { start: dayTimeOf(sIso), end: dayTimeOf(eIso), duration: dur });
  } else {
    const local = (disp, wall) => (disp.slice(0, 10) === wall.slice(0, 10) ? timeOf(disp) : dayTimeOf(disp));
    const there = (when, zone, localText) => t('event.preview.there', { when, zone, local: localText });
    const startClause = sTz === displayTz ? dayTimeOf(sIso) : there(dayTimeOf(sIso), sTz, local(info.display.start, sIso));
    const endWhen = sIso.slice(0, 10) === eIso.slice(0, 10) ? timeOf(eIso) : dayTimeOf(eIso);
    let endClause;
    if (eTz === displayTz || eTz === sTz) endClause = t('event.preview.to', { when: endWhen });
    else endClause = t('event.preview.toThere', { when: endWhen, zone: eTz, local: local(info.display.end, eIso) });
    main = `${startClause} ${endClause} · ${dur}`;
  }
  const notes = [];
  const fullDate = (iso) => dayText(wallOf(iso), opt);
  for (const [gap, zoneOf] of [[info.startGap, sTz], [info.endGap, eTz]]) {
    if (gap) notes.push(t('event.preview.gap', { time: timeOf(gap.wall), zone: gap.tzid || zoneOf, date: fullDate(gap.wall), resolved: timeOf(gap.resolved) }));
  }
  for (const [ov, zoneOf] of [[info.startOverlap, sTz], [info.endOverlap, eTz]]) {
    if (ov) notes.push(t('event.preview.overlap', { time: timeOf(ov.wall), zone: ov.tzid || zoneOf, date: fullDate(ov.wall) }));
  }
  return [main, ...notes].join(' ');
}

const fieldLabelKey = (testId) => `event.f.${String(testId).replace(/^field-/, '')}`;

export function mount(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  const { t, tp } = ctx;
  const lang = app.lang || 'en';
  const isNew = Boolean(ctx.route && ctx.route.name === 'event-new');
  const params = ctx.params || {};
  const login = app.session ? app.session.login : '';
  const prefs = app.prefs ? app.prefs() : null;
  const P = readCalPrefs(prefs, { firstWeekday: app.firstWeekday });
  const use24h = resolveUse24h(P.use24h, lang);
  const displayTz = loadDisplayZone(login, { storage: d.storage, defaultZone: app.timeZone, browserZone: d.browserZone });
  const root = h('section', { class: 'eform', testid: 'event-form-screen', 'data-state': 'loading', 'data-mode': isNew ? 'new' : 'edit' });
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  let disposed = false;
  let F = null;
  let source = null;
  let titleText = isNew ? t('event.form.titleNew') : t('event.form.titleEdit', { name: '' });
  const heading = h('h1', { class: 'page-title', id: 'ef-title', tabindex: '-1' }, titleText);
  const body = h('div', { class: 'eform__body' });
  root.append(heading, body);
  ctx.root.append(root);
  const nav = (hash, opts) => app.navigate(hash, opts);
  const detailHash = (key, query) => hashFor('/events/:key', { key }, cleanQuery(query || {}));

  function stateBox(testid, title, text, actions = []) {
    fill(body, h('div', { class: 'state', testid }, h('h2', { class: 'state__title' }, title), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'state__actions' }, actions) : null));
  }
  const backLink = (hash, label, testid = 'btn-back') => h('a', { class: 'btn', href: hash, testid }, label);
  function finish(ok) {
    root.setAttribute('data-state', ok ? 'ready' : 'error');
    endLoad(ok);
  }

  const pickOcc = (item, param) => {
    if (param && param !== 'single') return findOccurrence(item, param);
    try {
      return item.expand({ limit: 1 }).occurrences[0] || null;
    } catch {
      return null;
    }
  };

  async function load() {
    let storeCtx;
    try {
      storeCtx = await app.getStore();
      await storeCtx.access.load();
      if (disposed) return;
      source = createCalendarSource({ storeCtx, app, t });
    } catch (e) {
      return loadFailure(e);
    }
    const restore = ctx.restore && ctx.restore.mode === (isNew ? 'new' : 'edit') ? ctx.restore : null;
    if (isNew) {
      const writable = source.writable();
      if (!writable.length) {
        stateBox('event-readonly', t('event.form.readonly.title'), t('event.form.noCalendar'), [backLink('#/calendar', t('event.form.back'))]);
        return finish(true);
      }
      const want = typeof params.cal === 'string' ? writable.find((c) => c.href.replace(/\/$/, '') === params.cal.replace(/\/$/, '')) : null;
      F = buildForm({ storeCtx, writable, calendar: restore && restore.calendar ? restore.calendar : (want || writable[0]).href, base: null, item: null, occ: null, scope: null, restore });
      return ready();
    }
    let res;
    try {
      res = await source.resolveEvent({ key: params.key, cal: params.cal, occParam: params.occ });
    } catch (e) {
      return loadFailure(e);
    }
    if (disposed) return;
    if (res.state === 'error') return loadFailure({ kind: res.kind });
    if (res.state !== 'ok') {
      const key = res.state === 'occurrence' ? 'event.notfound.occurrence' : res.state === 'unreadable' ? 'event.form.unreadable' : 'event.notfound.text';
      stateBox('event-form-notfound', t(res.state === 'unreadable' ? 'event.form.readonlyItem.title' : 'event.notfound.title'), t(key), [backLink('#/calendar', t('event.form.back'))]);
      return finish(true);
    }
    const { collection, entry } = res;
    const back = detailHash(params.key, { cal: collection.href, occ: params.occ });
    if (!storeCtx.access.canWrite(collection)) {
      stateBox('event-readonly', t('event.form.readonly.title'), t('event.form.readonly.calendar'), [backLink(back, t('event.form.backToEvent'), 'btn-back-event')]);
      return finish(true);
    }
    // the version the user started from: after a language switch it is the one the first form opened with
    const base = restore && restore.base ? restore.base : { text: entry.text, etag: entry.etag };
    const item = restore && restore.base ? app.openItem(base.text) : res.item;
    const occ = restore && restore.base ? pickOcc(item, params.occ) : res.occ;
    if (item && item.ok && !occ) {
      stateBox('event-form-notfound', t('event.notfound.title'), t('event.notfound.occurrence'), [backLink('#/calendar', t('event.form.back'))]);
      return finish(true);
    }
    const fidelity = storeCtx.writes.isReadOnly(entry.href);
    if (!item || !item.ok || item.readOnly || fidelity) {
      const unknownZone = Boolean(item && item.ok && item.readOnly && item.readOnlyReason === 'unknown-tzid');
      stateBox('event-readonly', t('event.form.readonlyItem.title'), `${t('event.form.readonlyItem.lead')} ${t(`event.form.readonlyItem.${unknownZone ? 'zone' : 'other'}`)}`, [backLink(back, t('event.form.backToEvent'), 'btn-back-event')]);
      return finish(true);
    }
    const scopes = availableScopes(item, occ, 'edit');
    const asked = typeof params.scope === 'string' ? params.scope : '';
    const scope = scopes.length ? (scopes.includes(asked) ? asked : 'all') : null;
    F = buildForm({ storeCtx, writable: [], calendar: collection.href, collection, entry, base, item, occ, scope, restore });
    return ready();
  }

  function ready() {
    if (disposed) return;
    fill(body, F.el);
    F.afterRestore();
    titleText = F.title;
    heading.textContent = titleText;
    finish(true);
    heading.focus();
  }

  function loadFailure(e) {
    const kind = e && typeof e.kind === 'string' && !e.name ? e.kind : classify(e).kind;
    const online = d.isOnline();
    stateBox(online ? 'event-form-error' : 'event-form-offline', t(online ? 'event.form.error.title' : 'event.form.offline.title'), online ? t(davErrorKey(kind)) : t('event.form.offline.text'), [backLink('#/calendar', t('event.form.back'))]);
    finish(false);
  }

  // ---------------------------------------------------------------------------------------------------------------

  function buildForm({ storeCtx, writable, calendar, collection = null, entry = null, base, item, occ, scope, restore }) {
    const writes = storeCtx.writes;
    const zones = item ? item.zones : undefined;
    const base0 = item ? fromItem(item, occ) : newEventValues({ date: validDate(params.date), time: TIME_PARAM.test(params.time || '') ? params.time : '09:00', tz: displayTz });
    const v0 = restore && restore.values ? restore.values : base0;
    const recurring = Boolean(item) && isRecurring(item);
    const state = { busy: false, dirty: false, retry: restore && restore.retry ? restore.retry : null, scope };
    const fields = new Map();
    const say = createAnnouncer({ apply: (x) => (live.textContent = x), ms: 800, timers: d.timers });
    const live = h('p', { class: 'visually-hidden', role: 'status', testid: 'form-status' });
    const errors = h('div', { class: 'form__errors', role: 'alert', tabindex: '-1', testid: 'form-errors', hidden: true });
    const form = h('form', { class: 'form eform__form', novalidate: true, testid: 'event-form', 'aria-labelledby': 'ef-title', 'aria-busy': 'false', 'data-mode': isNew ? 'new' : 'edit', 'data-scope': scope || 'none' });
    const reg = (testid, f) => {
      fields.set(testid, f);
      return f;
    };

    function validDate(x) {
      return isValidDate(x) ? x : todayIn(displayTz, +d.now());
    }

    // ------------------------------------------------------------------ title, calendar
    const fTitle = reg('field-title', textField({ testid: 'field-title', label: t('event.f.title'), value: v0.summary, attrs: { maxlength: '1000' } }));
    let calSelect = null;
    let calBox;
    if (isNew) {
      const id = uniqueId('cal');
      calSelect = h('select', { class: 'input', id, testid: 'field-calendar' }, ...writable.map((c) => h('option', { value: c.href, selected: c.href.replace(/\/$/, '') === String(calendar).replace(/\/$/, '') }, c.label || c.displayName || c.name || c.href)));
      calBox = buildField({ id, label: t('event.f.calendar'), testid: null, control: calSelect }).el;
    } else {
      const name = source.calendars().find((c) => c.href.replace(/\/$/, '') === collection.href.replace(/\/$/, ''));
      calBox = h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('event.f.calendar')), h('p', { class: 'eform__calname', testid: 'event-calendar-name' }, h('bdi', null, name ? name.name : collection.href)));
    }

    // ------------------------------------------------------------------ when
    const allDayId = uniqueId('allday');
    const allDayBox = h('input', { type: 'checkbox', id: allDayId, testid: 'field-allday', checked: Boolean(v0.allDay) });
    const dateField = (which, label, value) => createDateField({ testid: `field-${which}-date`, label, t, lang, picker: true, required: true, clearable: false, firstWeekday: P.firstWeekday, now: d.now, value: value || null, onChange: () => whenChanged(which), onInput: () => softChanged() });
    const timeField = (which, label, value) => createTimeField({ testid: `field-${which}-time`, label, t, lang, use24h, required: true, value: value || null, onChange: () => whenChanged(which), onInput: () => softChanged() });
    const sDate = dateField('start', t('event.f.start-date'), v0.startDate);
    const eDate = dateField('end', t('event.f.end-date'), v0.endDate);
    const sTime = timeField('start', t('event.f.start-time'), v0.startTime);
    const eTime = timeField('end', t('event.f.end-time'), v0.endTime);
    // a time text that was not touched returns the stored value (with its seconds, if any)
    const shown0 = { start: sTime.input.value, end: eTime.input.value };
    const seen = () => [base0.startTz, base0.endTz, v0.startTz, v0.endTz].filter(Boolean);
    const zoneDeps = { win: d.win, timers: d.timers, pick: d.zonePick };
    const sZone = createZoneField({ testid: 'field-tz-start', label: t('event.f.tz-start'), value: v0.startTz, t, tp, login, getSeen: seen, browser: displayTz, storage: d.storage, deps: zoneDeps, onChange: (z) => zoneChanged('start', z) });
    const eZone = createZoneField({ testid: 'field-tz-end', label: t('event.f.tz-end'), value: v0.endTz, t, tp, login, getSeen: seen, browser: displayTz, storage: d.storage, deps: zoneDeps, onChange: () => zoneChanged('end') });
    fields.set('field-start-date', sDate);
    fields.set('field-end-date', eDate);
    fields.set('field-start-time', sTime);
    fields.set('field-end-time', eTime);
    fields.set('field-tz-start', sZone);
    fields.set('field-tz-end', eZone);
    const preview = h('p', { class: 'eform__preview', id: 'ef-preview', role: 'status', 'aria-live': 'polite', testid: 'event-when-preview' });
    // The zone's clock changes are written into the event as a generated VTIMEZONE; for a few zones (Africa/Casablanca,
    // Africa/Cairo) that is exact only up to a year: said where the zone is chosen (docs/calendar.md, "Limits").
    const tzLimit = h('p', { class: 'notice notice--quiet', role: 'status', testid: 'event-tz-limit', hidden: true });
    const whenSet = h(
      'fieldset',
      { class: 'fieldset eform__when', testid: 'event-when' },
      h('legend', { class: 'field__label' }, t('event.f.when')),
      h('div', { class: 'check' }, allDayBox, h('label', { for: allDayId }, t('event.f.allday'))),
      h('div', { class: 'eform__when-row' }, sDate.el, sTime.el, sZone.el),
      h('div', { class: 'eform__when-row' }, eDate.el, eTime.el, eZone.el),
      preview,
      tzLimit,
    );
    let memory = null; // the timed values kept while "all day" is ticked
    let prevWall = null; // the start wall clock before the last change (the end keeps its distance)
    let prevStartTz = sZone.value;

    const normalizeTime = (f, which) => {
      const r = f.parse();
      if (f.input.value === shown0[which]) return v0[`${which}Time`] || '';
      return r.ok && !r.empty ? r.iso : f.input.value.trim();
    };
    const dateIso = (f) => {
      const r = f.parse();
      return r.ok && !r.empty ? r.iso : f.input.value.trim();
    };
    const kindFor = (which, allDay, zone) => (allDay ? 'date' : zone === base0[`${which}Tz`] && base0[`${which}Kind`] !== 'date' ? base0[`${which}Kind`] : zone === 'UTC' ? 'utc' : zone ? 'zoned' : 'floating');

    // ------------------------------------------------------------------ more fields
    const fLocation = reg('field-location', textField({ testid: 'field-location', label: t('event.f.location'), value: v0.location, attrs: { maxlength: '1000' } }));
    const fUrl = reg('field-url', textField({ testid: 'field-url', label: t('event.f.url'), value: v0.url, input: 'url', attrs: { inputmode: 'url', placeholder: t('event.f.urlPlaceholder') } }));
    const fDesc = reg('field-description', textField({ testid: 'field-description', label: t('event.f.description'), value: v0.description, input: 'textarea', attrs: { rows: '4' } }));
    const chips = createChips({ t, items: v0.categories || [], onChange: () => changed() });
    fields.set('field-categories', chips);
    const selectField = (testid, label, options, value) => {
      const id = uniqueId('sel');
      // "not set" is the option value 'none' (an empty option value is read differently by some environments)
      const control = h('select', { class: 'input', id, testid }, ...options.map(([val, text]) => h('option', { value: val || NONE, selected: val === value }, text)));
      const f = buildField({ id, label, testid: null, control });
      f.el.setAttribute('data-field', testid);
      return reg(testid, { el: f.el, control, get value() { return control.value === NONE ? '' : control.value; }, setError: f.setError, focus: () => control.focus() });
    };
    const fStatus = selectField('field-status', t('event.f.status'), STATUS_OPTIONS.map((s) => [s, s ? t(`event.status.${s}`) : t('event.status.none')]), v0.status || '');
    const fTransp = selectField('field-transp', t('event.f.transp'), TRANSP_OPTIONS.map((s) => [s, s ? t(`event.transp.${s}`) : t('event.transp.none')]), v0.transp || '');
    const alarms = createAlarmsEditor({ t, tp, lang, alarms: v0.alarms || [], foreign: v0.foreignAlarms || 0, onChange: () => changed() });
    fields.set('btn-add-alarm', alarms);
    const attendeeCount = item && item.main ? item.main.props('ATTENDEE').length : 0;
    const attendeesNote = attendeeCount ? h('p', { class: 'notice notice--quiet', testid: 'event-attendees-note' }, tp('event.attendeesKept', attendeeCount)) : null;

    // ------------------------------------------------------------------ recurrence
    let rec = null;
    const startSpecOrNull = () => {
      try {
        return valuesToSpecs(collect()).start;
      } catch {
        return null;
      }
    };
    if (scope !== 'this') {
      const exceptions = scope === 'all' && item ? item.exceptions().map((e) => ({ type: e.type, spec: e.spec, key: e.key })) : [];
      rec = createRecurrenceBuilder({ rule: v0.rule, getStart: startSpecOrNull, exceptions, t, tp, lang, firstWeekday: P.firstWeekday, now: d.now, onChange: () => changed() });
      fields.set('recurrence-builder', rec);
    }

    // ------------------------------------------------------------------ collecting
    function collect() {
      const allDay = allDayBox.checked;
      const sz = sZone.value;
      const ez = eZone.value;
      return {
        summary: fTitle.control.value,
        location: fLocation.control.value,
        description: fDesc.control.value,
        url: fUrl.control.value,
        categories: chips.values(),
        status: fStatus.value,
        transp: fTransp.value,
        allDay,
        startDate: dateIso(sDate),
        startTime: allDay ? '' : normalizeTime(sTime, 'start'),
        startTz: allDay ? '' : sz,
        startKind: kindFor('start', allDay, sz),
        endDate: dateIso(eDate),
        endTime: allDay ? '' : normalizeTime(eTime, 'end'),
        endTz: allDay ? '' : ez,
        endKind: kindFor('end', allDay, ez),
        alarms: alarms.values(),
        foreignAlarms: v0.foreignAlarms || 0,
        rule: rec ? rec.getRule() : base0.rule,
        ruleText: base0.ruleText,
        recurring: base0.recurring,
      };
    }
    const restoredOps = () => (rec ? rec.restored().map((rid) => ({ type: 'removeExdate', rid })) : []);

    // ------------------------------------------------------------------ the "when" block
    function syncAllDay() {
      const on = allDayBox.checked;
      for (const el of [sTime.el, eTime.el, sZone.el, eZone.el]) el.hidden = on;
    }
    function updateTzLimit() {
      const limited = allDayBox.checked ? [] : [sZone.value, eZone.value].map((z) => tzLimitYear(z)).filter((y) => y !== null);
      tzLimit.hidden = !limited.length;
      tzLimit.textContent = limited.length ? t('event.tz.limit', { year: Math.min(...limited) }) : '';
    }
    function updatePreview() {
      updateTzLimit();
      const v = collect();
      const info = whenInfo(v, { zones, displayTz });
      const text = info ? previewText(info, v, { t, tp, lang, use24h, displayTz }) : '';
      preview.textContent = text;
      preview.setAttribute('data-gap', info && (info.startGap || info.endGap) ? 'true' : 'false');
    }
    allDayBox.addEventListener('change', () => {
      if (allDayBox.checked) {
        memory = { startTime: normalizeTime(sTime, 'start'), endTime: normalizeTime(eTime, 'end'), startTz: sZone.value, endTz: eZone.value };
      } else {
        const m = memory || { startTime: '09:00', endTime: '10:00', startTz: displayTz, endTz: displayTz };
        sTime.setValue(m.startTime || null);
        eTime.setValue(m.endTime || null);
        sZone.setValue(m.startTz);
        eZone.setValue(m.endTz);
        shown0.start = '\u0000';
        shown0.end = '\u0000';
        prevStartTz = sZone.value;
        if (isValidDate(dateIso(eDate)) && isValidDate(dateIso(sDate)) && dateIso(eDate) < dateIso(sDate)) eDate.setValue(dateIso(sDate));
      }
      syncAllDay();
      prevWall = currentStartWall();
      if (rec) rec.setStart();
      afterWhen();
    });
    function currentStartWall() {
      const sd = dateIso(sDate);
      if (!isValidDate(sd)) return null;
      if (allDayBox.checked) return dateMs(sd);
      const st = normalizeTime(sTime, 'start');
      return /^\d{2}:\d{2}/.test(st) ? wallOf(`${sd}T${st.slice(0, 5)}:00`) : null;
    }
    function whenChanged(which) {
      if (which === 'start') {
        // keep the duration: the end moves with the start (wall clock, the zones stay)
        const was = prevWall;
        const now2 = currentStartWall();
        if (was !== undefined && was !== null && now2 !== null && now2 !== was) {
          const ed = dateIso(eDate);
          if (isValidDate(ed)) {
            const delta = now2 - was;
            if (allDayBox.checked) eDate.setValue(isoOfMs(dateMs(ed) + delta));
            else {
              const et = normalizeTime(eTime, 'end');
              if (/^\d{2}:\d{2}/.test(et)) {
                const moved = new Date(wallOf(`${ed}T${et.slice(0, 5)}:00`) + delta).toISOString();
                eDate.setValue(moved.slice(0, 10));
                eTime.setValue(moved.slice(11, 16));
                shown0.end = '\u0000';
              }
            }
          }
        }
        prevWall = now2;
        if (rec) rec.setStart();
      }
      afterWhen();
    }
    function zoneChanged(which, zone) {
      // the end zone follows the start zone until it was chosen on its own
      if (which === 'start' && eZone.value === prevStartTz) eZone.setValue(zone);
      prevStartTz = sZone.value;
      afterWhen();
    }
    function afterWhen() {
      updatePreview();
      changed();
    }
    function softChanged() {
      changed();
    }
    prevWall = currentStartWall();
    syncAllDay();

    // ------------------------------------------------------------------ dirty
    function computeDirty() {
      const v = collect();
      if (isNew) return JSON.stringify(v) !== initialJson;
      try {
        return Object.keys(toPatch(base0, v, { zones })).length > 0 || restoredOps().length > 0;
      } catch {
        return true;
      }
    }
    let initialJson = null;
    let dirtyQueued = false;
    function changed() {
      if (dirtyQueued || disposed) return;
      dirtyQueued = true;
      Promise.resolve().then(() => {
        dirtyQueued = false;
        if (disposed) return;
        updatePreview();
        state.dirty = computeDirty() || state.retry !== null;
        app.setDirty(state.dirty);
      });
    }
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);

    // ------------------------------------------------------------------ errors
    function clearErrors() {
      for (const f of fields.values()) if (f.setError) f.setError(null);
      errors.hidden = true;
      clear(errors);
    }
    const labelOf = (testId) => {
      const key = fieldLabelKey(testId);
      const text = t(key);
      if (text !== key) return text;
      if (testId === 'btn-add-alarm') return t('event.alarm.legend');
      if (testId === 'recurrence-builder') return t('event.rec.title');
      return '';
    };
    function showErrors(list) {
      clearErrors();
      const items = list.map((e) => {
        const message = e.text || t(`event.err.${e.code}`);
        const f = fields.get(e.testId);
        if (f && f.setError) f.setError(message);
        const prefix = labelOf(e.testId);
        return { text: prefix ? `${prefix}: ${message}` : message, focus: () => (f && f.focus ? f.focus() : errors.focus()) };
      });
      fill(
        errors,
        h('p', { class: 'form__errors-title' }, tp('event.form.errors', items.length, { n: items.length })),
        h('ul', null, items.map((it) => h('li', null, h('button', { type: 'button', class: 'linklike', testid: 'form-error-link', on: { click: () => it.focus() } }, it.text)))),
      );
      errors.hidden = false;
      if (items.length) items[0].focus();
    }
    function showFailure(res, extra = []) {
      clearErrors();
      fill(errors, h('p', { class: 'form__errors-title' }, t('event.form.notSaved')), h('p', null, (res && res.message) || t('event.err.generic')), ...extra);
      errors.hidden = false;
      errors.focus();
    }

    // ------------------------------------------------------------------ save
    const save = h('button', { type: 'submit', class: 'btn btn--primary', testid: 'event-save', write: true }, isNew ? t('event.form.create') : t('event.form.save'));
    const cancelHash = isNew ? '#/calendar' : detailHash(params.key, { cal: collection.href, occ: scope === 'this' ? params.occ : '' });
    const cancel = h('a', { class: 'btn', href: cancelHash, testid: 'event-cancel' }, t('event.form.cancel'));
    const fieldsets = h('fieldset', { class: 'form__fields' });
    function refreshSave() {
      save.disabled = state.busy;
      form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    }
    function lockFields(on) {
      fieldsets.disabled = on;
      save.textContent = on ? t('event.form.retry') : isNew ? t('event.form.create') : t('event.form.save');
    }
    function leaveTo(hash) {
      state.dirty = false;
      app.setDirty(false);
      nav(hash);
    }
    const toDetail = (res) => {
      const cal = isNew ? res.collection || calSelect.value : collection.href;
      if (isNew || res.status === 'copied') return leaveTo(detailHash(res.uid || res.href, { cal }));
      if (res.tailUid) return leaveTo(detailHash(res.tailUid, { cal }));
      return leaveTo(detailHash(params.key, { cal, occ: scope === 'this' ? params.occ : '' }));
    };

    async function handle(res) {
      if (disposed) return null;
      if (!res) return null;
      if (res.ok && OK_STATUS.has(res.status)) {
        toDetail(res);
        return null;
      }
      if (res.status === 'conflict' && res.noop && (res.rows || []).length === 0) {
        const done = writes.resolveReload(res);
        if (done && done.ok) {
          toDetail(done);
          return null;
        }
      }
      if (modeOf(res)) {
        const out = await d.openConflictDialog({ conflict: res, t, writes, label: (fTitle.control.value || base0.summary || '').trim() || undefined, feedback: app.feedback, win: d.win });
        if (out && out.ok) {
          if (out.status === 'discarded') leaveTo('#/calendar');
          else toDetail(out);
        }
        return null;
      }
      if (res.status === 'unknown-result' && isNew && res.retry) {
        state.retry = res.retry;
        lockFields(true);
      }
      if (res.status === 'auth') return null;
      showFailure(res);
      return null;
    }

    const planText = (plan) => {
      const key = `event.err.plan.${plan.code}`;
      const text = t(key);
      return text !== key ? text : plan.message || plan.code;
    };

    async function submit() {
      if (state.busy) return;
      clearErrors();
      const v = collect();
      const errs = validate(base0, v, { isNew, zones });
      if (errs.length) {
        showErrors(errs);
        return;
      }
      let patch = {};
      let fields2 = null;
      try {
        if (isNew) fields2 = toNewFields(v, { zones });
        else patch = toPatch(base0, v, { zones });
      } catch (e) {
        showErrors([{ testId: 'field-start-date', text: (e && e.message) || t('event.err.generic') }]);
        return;
      }
      state.busy = true;
      refreshSave();
      say.flush(t('event.form.saving'));
      try {
        for (let round = 0; round < 3; round += 1) {
          let res;
          if (isNew) {
            res = await writes.createItem({ collection: calSelect.value, kind: 'event', fields: fields2, retry: state.retry || null });
            if (disposed) return;
            if (res && res.ok) res = { ...res, collection: calSelect.value };
          } else {
            let exceptions;
            let plan = planEdit(item, { scope, occ, base: base0, patch, exceptions });
            while (plan && plan.needs === 'exceptions') {
              const choice = await d.askRuleExceptions({ exceptions: plan.exceptions, orphans: plan.orphans, defaultChoice: plan.defaultChoice, t, tp, lang, use24h, win: d.win });
              if (disposed) return;
              if (!choice) return;
              exceptions = choice;
              plan = planEdit(item, { scope, occ, base: base0, patch, exceptions });
            }
            if (!plan.ok) {
              showFailure({ message: planText(plan) });
              return;
            }
            const extra = exceptions === 'remove' ? [] : restoredOps();
            if (plan.action === 'noop' && !extra.length) {
              app.feedback.setStatus(t('store.status.unchanged'));
              say.flush(t('store.status.unchanged'));
              return;
            }
            if (restoreBlocksSplit(plan, extra)) {
              showErrors([{ testId: 'recurrence-builder', code: 'restore-needs-scope' }]);
              return;
            }
            if (plan.action === 'split') {
              res = await writes.splitWrite({ collection: collection.href, href: entry.href, base, rid: plan.rid, tailFields: plan.tailFields, exceptions: plan.tailExceptions });
            } else {
              const ops = [...extra, ...(plan.action === 'ops' ? plan.ops : [])];
              res = await writes.applyOps({ collection: collection.href, href: entry.href, base, ops });
            }
            if (disposed) return;
          }
          const next = await handle(res);
          if (next !== 'again') break;
        }
      } catch {
        if (!disposed) {
          const message = t('event.form.unexpected');
          app.feedback.setAlert(message, { scope: null });
          showFailure({ message });
        }
      } finally {
        state.busy = false;
        if (!disposed) {
          refreshSave();
          const active = d.doc && d.doc.activeElement;
          if (!save.disabled && (!active || active === d.doc.body)) save.focus();
        }
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });

    // ------------------------------------------------------------------ assemble
    const occWall = occ && occ.start ? occ.start.wallMs : null;
    const notice = scope
      ? h('p', { class: 'notice', testid: 'scope-notice', role: 'status' }, t(`event.scope.editing.${scope}`, { date: occWall === null ? '' : dayText(occWall, { lang }) }))
      : null;
    fill(
      fieldsets,
      notice,
      h('div', { class: 'form__grid' }, fTitle.el, calBox),
      whenSet,
      rec ? rec.el : null,
      h('div', { class: 'form__grid' }, fLocation.el, fUrl.el),
      fDesc.el,
      chips.el,
      h('div', { class: 'form__grid' }, fStatus.el, fTransp.el),
      alarms.el,
      attendeesNote,
    );
    fill(form, errors, live, fieldsets, h('div', { class: 'form__actions' }, cancel, save));
    refreshSave();
    updatePreview();
    initialJson = restore && typeof restore.initialJson === 'string' ? restore.initialJson : JSON.stringify(collect());

    const title = isNew ? t('event.form.titleNew') : t('event.form.titleEdit', { name: isolate((base0.summary || '').trim() || t('event.untitled')) });
    return {
      el: form,
      title,
      afterRestore() {
        if (state.retry) lockFields(true);
        changed();
      },
      snapshot() {
        return { mode: isNew ? 'new' : 'edit', base, values: collect(), calendar: calSelect ? calSelect.value : calendar, retry: state.retry, initialJson };
      },
      dispose() {
        say.cancel();
        if (source) source.dispose();
      },
      // exposed for tests
      state,
      collect,
      fields,
      submit,
      rec,
      alarms,
      sZone,
      eZone,
      sDate,
      eDate,
      sTime,
      eTime,
      allDayBox,
      preview,
    };
  }

  load().catch((e) => {
    if (!disposed) loadFailure(e);
  });

  return {
    get title() {
      return titleText;
    },
    snapshot: () => (F ? F.snapshot() : ctx.restore || null),
    dispose() {
      disposed = true;
      app.setDirty(false);
      if (F) F.dispose();
      else if (source) source.dispose();
      clear(root);
      root.remove();
    },
    // exposed for tests
    get form() {
      return F;
    },
  };
}
