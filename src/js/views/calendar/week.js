// SPDX-License-Identifier: AGPL-3.0-or-later
// Week and day views (RUN3 WP B3a): header with the days, an all-day strip, and a scrolling hour grid with one
// column per day. The skeleton is built once per period; event blocks are keyed nodes that are inserted, removed
// or flagged `is-off`, and lanes are recomputed in place for the VISIBLE blocks only. Under 900 px the week shows
// 3 days (calendar/grid.js decides). Test ids: week-grid | day-grid, week-day, now-marker, btn-new-event-at.

import { h, vars } from '../../ui.js';
import { dateMs } from '../../calendar/grid.js';
import { layoutAllDayRow, layoutDay, nowMarker } from '../../calendar/layout.js';
import { NUMBER_ALLOW, calendarHash, cleanQuery, dateText, dayOf, longDayText, newEventHash, timeText } from './common.js';
import { createNodeSet } from './keyed.js';
import { buildChip, setVars, sigOf } from './nodes.js';

export const HOUR_PX = 48;
export const FIRST_VISIBLE_HOUR = 7;

/** @param {object} o {t, tp, lang, view: 'week'|'day', range, tz, use24h, query} */
export function createWeekView({ t, tp, lang, view, range, tz, use24h, query = {} }) {
  const days = range.days;
  const grid = h('div', { class: 'tgrid', testid: view === 'day' ? 'day-grid' : 'week-grid', role: 'group', 'aria-label': t('cal.timeGridLabel') });
  vars(grid, { '--cols': String(days.length) }, NUMBER_ALLOW);
  vars(grid, { '--hour': `${HOUR_PX}px` }, /^\d{1,3}px$/);

  const head = h(
    'div',
    { class: 'tgrid__head' },
    h('div', { class: 'tgrid__corner', title: tz }, h('span', { class: 'tgrid__zone' }, tz)),
    days.map((d) =>
      h(
        'div',
        { class: 'tgrid__daycell' },
        h(
          'a',
          { class: 'tgrid__day', href: calendarHash('day', d, query), testid: 'week-day', 'data-date': d, 'aria-label': longDayText(dateMs(d), { lang }) },
          h('span', { class: 'tgrid__dow' }, dateText(d, { weekday: 'short' }, lang)),
          h('span', { class: 'tgrid__num' }, String(dayOf(d))),
        ),
        h('a', { class: 'tgrid__add', href: newEventHash(cleanQuery({ date: d })), testid: 'btn-new-event-at', 'data-date': d, 'aria-label': t('cal.newEventAt', { day: longDayText(dateMs(d), { lang }) }) }, '+'),
      ),
    ),
  );

  const adBox = h('div', { class: 'tgrid__adbox', testid: 'allday-row' });
  const adSet = createNodeSet(adBox);
  const adRow = h('div', { class: 'tgrid__allday' }, h('div', { class: 'tgrid__corner tgrid__corner--label' }, t('cal.allDay')), adBox);

  const gutter = h(
    'div',
    { class: 'tgrid__gutter', 'aria-hidden': 'true' },
    Array.from({ length: 24 }, (_, hr) => h('div', { class: 'tgrid__hour' }, hr === 0 ? '' : timeText(hr * 3600000, { lang, use24h }))),
  );
  const lines = h('div', { class: 'tgrid__lines', 'aria-hidden': 'true' }, Array.from({ length: 24 }, () => h('div', { class: 'tgrid__line' })));
  const cols = new Map();
  for (const d of days) {
    const col = h('div', { class: 'tgrid__col', role: 'group', 'data-date': d, 'aria-label': longDayText(dateMs(d), { lang }) });
    cols.set(d, { col, set: createNodeSet(col), marker: null });
  }
  const body = h('div', { class: 'tgrid__body' }, gutter, h('div', { class: 'tgrid__cols' }, lines, [...cols.values()].map((c) => c.col)));
  const scroller = h('div', { class: 'tgrid__scroll', tabindex: '0', role: 'region', 'aria-label': t('cal.timeGrid'), testid: 'time-scroller' }, body);
  grid.append(head, adRow, scroller);
  scroller.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX;

  function updateMarker(now) {
    const m = nowMarker(days, now, tz);
    for (const c of cols.values()) {
      if (c.marker && (!m || cols.get(m.date) !== c)) {
        c.marker.remove();
        c.marker = null;
      }
    }
    if (!m) return;
    const c = cols.get(m.date);
    if (!c.marker) {
      c.marker = h('div', { class: 'now-line', testid: 'now-marker', role: 'img', 'aria-label': '' }, h('span', { class: 'visually-hidden' }));
      c.col.append(c.marker);
    }
    c.marker.setAttribute('aria-label', t('cal.now', { time: timeText(m.minutes * 60000, { lang, use24h }) }));
    c.marker.firstChild.textContent = t('cal.now', { time: timeText(m.minutes * 60000, { lang, use24h }) });
    setVars(c.marker, { '--start': Math.round(m.minutes * 100) / 100 });
  }

  return {
    el: grid,
    grid,
    scroller,
    kind: view,
    apply(model) {
      const { records, visible } = model;
      const visibles = records.filter(visible);
      // all-day strip
      const allRow = layoutAllDayRow(records, days, tz);
      const visRow = layoutAllDayRow(visibles, days, tz);
      const posOf = new Map(visRow.items.map((i) => [i.occ.key, i]));
      adSet.sync(
        allRow.items.map((it) => {
          const rec = it.occ;
          return { id: rec.key, sig: sigOf(rec, `${it.contStart}|${it.contEnd}`), visible: visible(rec), make: () => buildChip(rec, { t, lang, use24h, cont: it }) };
        }),
      );
      for (const [id, node] of adSet.nodes) {
        const p = posOf.get(id);
        if (p) setVars(node, { '--c': p.col, '--span': p.span, '--r': p.row });
      }
      vars(adBox, { '--rows': String(Math.max(1, visRow.rows)) }, NUMBER_ALLOW);

      // hour columns
      let shown = visRow.items.length;
      for (const d of days) {
        const c = cols.get(d);
        const all = layoutDay(records, d, tz);
        const vis = layoutDay(visibles, d, tz);
        const lanes = new Map(vis.timed.map((s) => [s.occ.key, s]));
        c.set.sync(
          all.timed.map((seg) => {
            const rec = seg.occ;
            return { id: rec.key, sig: sigOf(rec, `${seg.contStart}|${seg.contEnd}`), visible: visible(rec), make: () => buildChip(rec, { t, lang, use24h, block: true, cont: seg }) };
          }),
        );
        for (const seg of all.timed) {
          const node = c.set.nodes.get(seg.occ.key);
          const p = lanes.get(seg.occ.key) || seg;
          const dur = Math.max(p.endMin - p.startMin, 15);
          setVars(node, { '--start': p.startMin, '--dur': Math.max(dur, 20), '--lane': p.lane ?? 0, '--lanes': p.lanes ?? 1 });
          node.classList.toggle('chip--short', dur < 45);
        }
        shown += vis.timed.length;
        c.col.setAttribute('aria-label', `${longDayText(dateMs(d), { lang })}, ${tp('cal.nEvents', vis.timed.length + vis.allDay.length, { n: vis.timed.length + vis.allDay.length })}`);
      }
      updateMarker(model.now);
      return { shown };
    },
    tick(now) {
      updateMarker(now);
    },
    nodeCount: () => adSet.size + [...cols.values()].reduce((n, c) => n + c.set.size, 0),
    dispose() {
      grid.remove();
    },
  };
}
