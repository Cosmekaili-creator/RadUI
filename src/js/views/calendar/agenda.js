// SPDX-License-Identifier: AGPL-3.0-or-later
// Agenda view (30 days from the date) and search results (RUN3 WP B3a): one section per day, keyed `event-row`
// nodes, a section hidden while it has no visible event. Search shows the days that hold a match (taken from ALL
// loaded calendars, so switching a calendar off never rebuilds the list; hidden calendars only flag their rows).
// Test ids: agenda-list, event-row, agenda-empty (nothing in the period), cal-no-match (search without a result).

import { h } from '../../ui.js';
import { layoutDay } from '../../calendar/layout.js';
import { dateMs } from '../../calendar/grid.js';
import { dateText, dayOf, longDayText } from './common.js';
import { createNodeSet } from './keyed.js';
import { buildRow, sigOf } from './nodes.js';

export const SEARCH_DAYS_EITHER_SIDE = 366;

/**
 * @param {object} o {t, tp, lang, tz, use24h, days: ISO[] (the skeleton), search: boolean, today: ISO}
 */
export function createAgendaView({ t, tp, lang, tz, use24h, days, search = false, today = null, empty }) {
  const sections = new Map();
  const list = h('div', { class: 'agenda', testid: search ? 'search-results' : 'agenda-list' });
  for (const d of days) {
    const box = h('ul', { class: 'agenda__list' });
    const id = `ag-${d}`;
    const heading = h(
      'h2',
      { class: ['agenda__date', d === today && 'is-today'], id },
      h('span', { class: 'agenda__num' }, String(dayOf(d))),
      h('span', null, dateText(d, { weekday: 'long' }, lang), h('span', { class: 'agenda__month' }, dateText(d, { month: 'long', year: 'numeric' }, lang)), d === today ? h('span', { class: 'tag tag--accent' }, t('cal.today')) : null),
    );
    const sec = h('section', { class: 'agenda__day', 'data-date': d, hidden: true, 'aria-labelledby': id, 'aria-label': null }, heading, box);
    sections.set(d, { sec, box, set: createNodeSet(box) });
    list.append(sec);
  }
  const emptyEl = h('div', { class: 'empty-inline', hidden: true, testid: search ? 'cal-no-match' : 'agenda-empty' }, empty || t(search ? 'cal.noMatch' : 'cal.emptyPeriod'));
  const el = h('div', { class: 'agenda-wrap' }, list, emptyEl);

  return {
    el,
    kind: 'agenda',
    apply(model) {
      const { records, visible } = model;
      const visibles = records.filter(visible);
      let shown = 0;
      for (const d of days) {
        const s = sections.get(d);
        const all = layoutDay(records, d, tz);
        const vis = layoutDay(visibles, d, tz);
        const ordered = [...all.allDay.map((x) => x.occ), ...all.timed.map((x) => x.occ)];
        s.set.sync(ordered.map((rec) => ({ id: rec.key, sig: sigOf(rec, 'row'), visible: visible(rec), make: () => h('li', { class: 'agenda__item' }, buildRow(rec, { t, lang, use24h, day: d })) })));
        const n = vis.allDay.length + vis.timed.length;
        s.sec.hidden = n === 0;
        s.sec.setAttribute('aria-label', `${longDayText(dateMs(d), { lang })}, ${tp('cal.nEvents', n, { n })}`);
        shown += n;
      }
      emptyEl.hidden = shown > 0;
      return { shown };
    },
    tick() {},
    nodeCount: () => [...sections.values()].reduce((n, s) => n + s.set.size, 0),
    dispose() {
      el.remove();
    },
  };
}

/** The days a search result list needs: the start day of every match (ascending, unique). */
export function searchDays(records, tz) {
  const out = new Set();
  for (const r of records) out.add(new Date(r.times.startWall).toISOString().slice(0, 10));
  return [...out].sort();
}
