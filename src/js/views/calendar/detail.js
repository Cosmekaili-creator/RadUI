// SPDX-License-Identifier: AGPL-3.0-or-later
// The event detail (RUN3 WP B3a): a side panel on desktop, a page on phones (same builder). Everything is text
// nodes; the URL is a link only when it is plain http(s) (contacts/links.js allowlist), the description is shown
// in a `<pre>`-wrap block, attendees are read-only rows. An event whose time zone is unknown (item.js category c) is
// shown at its own wall clock with a warning and the raw text; it can be deleted but not edited or moved.
// Test ids: event-detail, event-title, event-when, event-zone-start, event-zone-end, event-floating, event-tz-warning,
// event-readonly, event-raw, event-location, event-url, event-description, event-categories, event-status,
// event-recurrence, event-attendees (attendee-row), event-alarms, event-meta, btn-edit-event, btn-delete-event,
// btn-move-event, btn-export-event, btn-close-detail, btn-back.

import { h } from '../../ui.js';
import { readEvent } from '../../model/event.js';
import { specFromInfo } from '../../model/icalview.js';
import { summarizeRule } from '../../calendar/recurtext.js';
import { alarmPresetId } from '../../calendar/formmodel.js';
import { wallInZone } from '../../calendar/tzprefs.js';
import { capText, webHref } from '../contacts/links.js';
import { isolate } from '../../widgets/avatar.js';
import { dayText, timeText } from './common.js';

const PARTSTATS = new Set(['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED', 'IN-PROCESS', 'COMPLETED']);

/** The zone lines of an occurrence: {start, end, floating, allDay, unknown} (each a text or null). */
export function zoneLines(occ, { tz, lang, use24h, t }) {
  const o = { start: null, end: null, floating: null, allDay: false, unknown: false };
  const s = occ.start;
  const e = occ.end || occ.start;
  if (s.kind === 'date') {
    o.allDay = true;
    return o;
  }
  if (s.kind === 'floating') {
    o.floating = t('cal.detail.floating');
    return o;
  }
  const fmt = (info, key) => {
    if (info.tzClass === 'unknown') return t('cal.detail.zoneUnknownLine', { time: `${timeText(info.wallMs, { lang, use24h })}`, zone: info.tzid });
    if (info.instant === null) return null;
    const localWall = wallInZone(info.instant, tz);
    const sameDay = Math.floor(localWall / 86400000) === Math.floor(info.wallMs / 86400000);
    const local = sameDay ? timeText(localWall, { lang, use24h }) : `${dayText(localWall, { lang })} ${timeText(localWall, { lang, use24h })}`;
    const zone = info.kind === 'utc' ? 'UTC' : info.tzid;
    if (zone === tz) return t('cal.detail.inZone', { zone });
    return t(key, { time: timeText(info.wallMs, { lang, use24h }), zone, local });
  };
  o.unknown = s.tzClass === 'unknown' || e.tzClass === 'unknown';
  o.start = fmt(s, 'cal.detail.zoneStart');
  if ((e.tzid || null) !== (s.tzid || null) || e.kind !== s.kind) o.end = fmt(e, 'cal.detail.zoneEnd');
  return o;
}

function alarmText(a, t) {
  const id = alarmPresetId(a);
  if (id !== 'custom') return t(`cal.detail.alarm.${id}`);
  const min = Math.round(Math.abs(a.seconds) / 60);
  const end = a.related === 'END';
  return t(`cal.detail.alarm.custom.${a.seconds <= 0 ? 'before' : 'after'}${end ? 'End' : ''}`, { n: min });
}

function personText(prop) {
  const cn = prop.param('CN');
  const name = cn && cn.values.length ? cn.values[0].text : '';
  const addr = String(prop.value || '').replace(/^mailto:/i, '').trim();
  return { name: name || addr, addr, partstat: (prop.param('PARTSTAT') && prop.param('PARTSTAT').values[0] ? prop.param('PARTSTAT').values[0].text : '').toUpperCase() };
}

const field = (label, testid, ...kids) => h('div', { class: 'detail__row', testid }, h('dt', null, label), h('dd', null, ...kids));

/**
 * @param {object} o
 * @param {object} o.model {rec, item, occ, entry, collection, canWrite, canMove, readOnlyReason}
 * @param {object} o.ops {onEdit, onDelete, onMove, onExport, onClose?}
 * @param {boolean} [o.page] true on the full-page route (a back link instead of a close button)
 */
export function buildDetail({ model, t, tp, lang, tz, use24h, ops, page = false, backHash = '#/calendar' }) {
  const { rec, item, occ } = model;
  const comp = occ && occ.component ? occ.component : item.main;
  let f = null;
  try {
    f = readEvent(comp);
  } catch {
    f = null;
  }
  const title = rec.title;
  const zones = zoneLines(occ, { tz, lang, use24h, t });
  const named = isolate(title);
  const reason = model.readOnlyReason;
  const readOnlyText = reason === 'calendar' ? t('cal.detail.readonlyCalendar', { cal: model.collection.label || model.collection.displayName || '' }) : reason === 'unknown-tzid' ? t('cal.detail.readonlyZone') : reason ? t('cal.detail.readonlyOther') : null;
  const masterFields = item.fields();
  let recurrence = null;
  if (masterFields.rrule) recurrence = summarizeRule(masterFields.rrule, specFromInfo(item.eventModel().start), { t, tp, lang, zones: item.zones });
  else if (masterFields.rdates && masterFields.rdates.length) recurrence = t('cal.detail.rdates');

  const actions = h(
    'div',
    { class: 'detail__actions' },
    model.canWrite && !reason ? h('button', { type: 'button', class: 'btn btn--primary', testid: 'btn-edit-event', 'aria-label': t('cal.detail.editNamed', { name: named }), write: true, on: { click: () => ops.onEdit() } }, t('cal.detail.edit')) : null,
    model.canWrite ? h('button', { type: 'button', class: 'btn btn--danger-quiet', testid: 'btn-delete-event', 'aria-label': t('cal.detail.deleteNamed', { name: named }), write: true, on: { click: () => ops.onDelete() } }, t('cal.detail.delete')) : null,
    model.canWrite && !reason && model.canMove ? h('button', { type: 'button', class: 'btn', testid: 'btn-move-event', 'aria-label': t('cal.detail.moveNamed', { name: named }), write: true, on: { click: () => ops.onMove() } }, t('cal.detail.move')) : null,
    h('button', { type: 'button', class: 'btn', testid: 'btn-export-event', 'aria-label': t('cal.detail.exportNamed', { name: named }), on: { click: () => ops.onExport() } }, t('cal.detail.export')),
    !page && ops.onClose ? h('button', { type: 'button', class: 'btn', testid: 'btn-close-detail', on: { click: () => ops.onClose() } }, t('cal.closeDetail')) : null,
  );

  const rows = [];
  if (zones.start) rows.push(h('p', { class: 'detail__zone', testid: 'event-zone-start' }, zones.start));
  if (zones.end) rows.push(h('p', { class: 'detail__zone', testid: 'event-zone-end' }, zones.end));
  if (zones.floating) rows.push(h('p', { class: 'detail__zone', testid: 'event-floating' }, zones.floating));

  const list = [];
  if (f && f.location) list.push(field(t('cal.detail.location'), 'event-location', f.location));
  if (f && f.url) {
    const href = webHref(f.url);
    list.push(field(t('cal.detail.url'), 'event-url', href ? h('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer' }, f.url) : f.url));
  }
  if (f && f.description) {
    const cap = capText(f.description, 20000);
    list.push(field(t('cal.detail.description'), 'event-description', h('pre', { class: 'prose' }, cap.text)));
  }
  if (f && f.categories.length) list.push(field(t('cal.detail.categories'), 'event-categories', h('span', { class: 'chips' }, ...f.categories.map((c) => h('span', { class: 'tag' }, c)))));
  if (rec.status) list.push(field(t('cal.detail.status'), 'event-status', t(`cal.status.${rec.status}`)));
  if (recurrence) list.push(field(t('cal.detail.repeats'), 'event-recurrence', recurrence, occ.source === 'override' ? h('span', { class: 'meta-line' }, ` ${t('cal.detail.overridden')}`) : null));
  const attendees = comp.props('ATTENDEE');
  const organizer = comp.prop('ORGANIZER');
  if (attendees.length || organizer) {
    const people = [];
    if (organizer) {
      const p = personText(organizer);
      people.push(h('li', { class: 'attendee', testid: 'attendee-row', 'data-role': 'organizer' }, h('bdi', null, p.name), ' ', h('span', { class: 'tag tag--quiet' }, t('cal.detail.organizer'))));
    }
    for (const a of attendees) {
      const p = personText(a);
      people.push(h('li', { class: 'attendee', testid: 'attendee-row', 'data-partstat': p.partstat || null }, h('bdi', null, p.name), p.partstat ? h('span', { class: 'tag tag--quiet' }, PARTSTATS.has(p.partstat) ? t(`cal.detail.partstat.${p.partstat}`) : p.partstat) : null));
    }
    list.push(field(t('cal.detail.attendees'), 'event-attendees', h('ul', { class: 'attendees' }, ...people), h('p', { class: 'meta-line' }, t('cal.detail.attendeesNote'))));
  }
  if (f && (f.alarms.length || f.foreignAlarms)) {
    const bits = f.alarms.map((a) => alarmText(a, t));
    const foreign = Array.isArray(f.foreignAlarms) ? f.foreignAlarms.length : Number(f.foreignAlarms) || 0;
    list.push(field(t('cal.detail.alarms'), 'event-alarms', bits.length ? h('ul', null, ...bits.map((b) => h('li', null, b))) : null, foreign ? h('p', { class: 'meta-line' }, tp('cal.detail.alarmsOther', foreign, { n: foreign })) : null));
  }

  const raw = reason === 'unknown-tzid' || reason === 'fidelity' ? capText(model.entry.text, 100000) : null;
  return h(
    'section',
    { class: 'event-detail', testid: 'event-detail', 'aria-labelledby': 'event-title', 'data-uid': rec.uid || '', 'data-href': rec.href || '', 'data-calendar': rec.calendar, 'data-occurrence': rec.occParam, 'data-key': rec.key, 'data-readonly': reason || !model.canWrite ? 'true' : 'false' },
    page ? h('a', { class: 'link detail__back', href: backHash, testid: 'btn-back' }, t('cal.detail.back')) : null,
    h('h2', { class: 'event-detail__title', id: 'event-title', testid: 'event-title', tabindex: '-1' }, title),
    h('p', { class: 'event-detail__when', testid: 'event-when' }, rec.when),
    ...rows,
    zones.unknown ? h('p', { class: 'notice notice--warn', role: 'note', testid: 'event-tz-warning' }, t('cal.detail.zoneWarning')) : null,
    readOnlyText ? h('p', { class: 'notice', testid: 'event-readonly' }, readOnlyText) : null,
    h('dl', { class: 'detail__list' }, ...list),
    raw ? h('div', { class: 'detail__raw' }, h('h3', { class: 'detail__rawtitle' }, t('cal.detail.rawTitle')), h('pre', { class: 'prose', testid: 'event-raw' }, raw.text)) : null,
    h('p', { class: 'meta-line', testid: 'event-meta' }, t('cal.detail.meta', { cal: model.collection.label || model.collection.displayName || '', file: String(model.entry.href).split('/').filter(Boolean).pop() || '' })),
    actions,
  );
}
