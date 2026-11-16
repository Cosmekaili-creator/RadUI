// SPDX-License-Identifier: AGPL-3.0-or-later
// DOM builders for the event nodes the views place on their grids (RUN3 WP B3a). Every node carries
// `data-testid` (`event-chip` in month, week and day; `event-row` in the agenda and search), `data-uid`,
// `data-href`, `data-calendar`, `data-occurrence`, `data-key` and `data-readonly`, and an accessible name such as
// "Standup, Tue 18 Nov 09:00–09:30, Work". Titles are text nodes only. Colour comes through `vars` (whitelist);
// state is never colour alone: tentative = dashed edge + "?" + the word in the name, cancelled = strike-through.

import { h, vars } from '../../ui.js';
import { COLOUR_ALLOW, NUMBER_ALLOW, detailHashOf, nodeAttrs, timeText } from './common.js';

const colourVars = (rec) => ({ allow: COLOUR_ALLOW, values: { '--cal': rec.color } });

const chipClass = (rec, ...more) => [
  'chip',
  rec.allDay && 'chip--allday',
  rec.status === 'TENTATIVE' && 'chip--tentative',
  rec.status === 'CANCELLED' && 'chip--cancelled',
  rec.virtual && 'chip--birthday',
  rec.unknownZone && 'chip--unknown',
  ...more,
];

/** A signature: a node whose signature is unchanged is kept as it is. */
export const sigOf = (rec, extra = '') => `${rec.name}|${rec.color}|${rec.times.startWall}|${rec.times.endWall}|${rec.readOnly}|${extra}`;

function marks(rec, t) {
  return [
    rec.status === 'TENTATIVE' ? h('span', { class: 'chip__flag', 'aria-hidden': 'true' }, t('cal.flag.TENTATIVE')) : null,
    rec.unknownZone ? h('span', { class: 'chip__flag', 'aria-hidden': 'true' }, '?') : null,
    rec.recurring ? h('span', { class: 'chip__repeat', 'aria-hidden': 'true' }, '↻') : null,
  ];
}

/** Month cell chip, all-day chip and compact week/day block. */
export function buildChip(rec, { t, lang, use24h, block = false, cont = {} }) {
  const timed = !rec.allDay;
  const time = timed && !(cont && cont.contStart) ? timeText(rec.times.startWall, { lang, use24h }) : null;
  const props = {
    class: chipClass(rec, block && 'chip--block', cont.contStart && 'chip--cont-start', cont.contEnd && 'chip--cont-end'),
    href: detailHashOf(rec),
    testid: 'event-chip',
    'aria-label': rec.name,
    vars: colourVars(rec),
    ...nodeAttrs(rec),
  };
  const el = h('a', props, time ? h('span', { class: 'chip__time' }, time) : null, h('span', { class: 'chip__title' }, rec.title), ...marks(rec, t), block && rec.location ? h('span', { class: 'chip__loc' }, rec.location) : null);
  return el;
}

/** Position variables of a week/day block or all-day item (numbers only). */
export function setVars(el, values) {
  const text = {};
  for (const [k, v] of Object.entries(values)) text[k] = String(v);
  return vars(el, text, NUMBER_ALLOW);
}

/** Phone month overview: a dot per event (the list of the selected day carries the names). */
export function buildDot(rec) {
  return h('span', { class: 'dot', 'aria-hidden': 'true', ...nodeAttrs(rec), vars: colourVars(rec) });
}

/** Agenda / search / selected-day row. */
export function buildRow(rec, { t, lang, use24h, day = null }) {
  const times = rec.times;
  const timeCell = rec.allDay
    ? h('span', { class: 'arow__time' }, t('cal.allDay'))
    : h('span', { class: 'arow__time' }, timeText(times.startWall, { lang, use24h }), h('span', { class: 'arow__end' }, timeText(times.endWall, { lang, use24h })));
  const attrs = nodeAttrs(rec);
  if (day) attrs['data-day'] = day;
  return h(
    'a',
    {
      class: ['arow', rec.status === 'CANCELLED' && 'arow--cancelled', rec.status === 'TENTATIVE' && 'arow--tentative', rec.virtual && 'arow--birthday', rec.unknownZone && 'arow--unknown'],
      href: detailHashOf(rec),
      testid: 'event-row',
      'aria-label': rec.name,
      vars: colourVars(rec),
      ...attrs,
    },
    timeCell,
    h(
      'span',
      { class: 'arow__main' },
      h('span', { class: 'arow__title' }, rec.title, rec.status ? h('span', { class: 'tag' }, t(`cal.status.${rec.status}`)) : null, rec.unknownZone ? h('span', { class: 'tag tag--warn' }, t('cal.zoneUnknownShort')) : null),
      h(
        'span',
        { class: 'arow__meta' },
        h('span', { class: 'arow__cal' }, h('span', { class: 'dot', 'aria-hidden': 'true', vars: colourVars(rec) }), rec.calendarName),
        rec.location ? h('span', null, rec.location) : null,
        rec.recurring ? h('span', { class: 'arow__rec' }, t('cal.repeats')) : null,
        rec.readOnly && !rec.virtual ? h('span', null, t('cal.readOnly')) : null,
      ),
    ),
  );
}
