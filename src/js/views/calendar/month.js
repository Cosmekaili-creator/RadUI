// SPDX-License-Identifier: AGPL-3.0-or-later
// Month view (RUN3 WP B3a): a skeleton of day cells built once per period, filled with keyed event chips.
// Desktop: chips in the cells ("+N more" opens the day). Phone: a dot overview plus the selected day's list.
// `apply(model)` only inserts, removes or flags nodes; the grid element, focus and scroll stay.
// Test ids: month-grid, month-cell, month-day, month-more, btn-new-event-at; chips `event-chip`.

import { h } from '../../ui.js';
import { monthCells } from '../../calendar/layout.js';
import { dateMs } from '../../calendar/grid.js';
import { calendarHash, cleanQuery, dateText, dayOf, longDayText, newEventHash } from './common.js';
import { createNodeSet } from './keyed.js';
import { buildChip, buildDot, buildRow, sigOf } from './nodes.js';

export const MAX_CHIPS = 3;
export const MAX_DOTS = 6;

/** @param {{t: Function, tp: Function, lang: string, phone: boolean, query?: object}} o */
export function createMonthView({ t, tp, lang, phone, range, tz, use24h, query = {} }) {
  const cells = new Map();
  const head = h(
    'div',
    { class: 'month__head', role: 'row' },
    Array.from({ length: 7 }, (_, i) => {
      const iso = range.days[i];
      return h('div', { class: 'month__dow', role: 'columnheader', 'aria-label': dateText(iso, { weekday: 'long' }, lang) }, dateText(iso, { weekday: phone ? 'narrow' : 'short' }, lang));
    }),
  );
  const rows = [];
  for (let w = 0; w < range.days.length / 7; w += 1) {
    const rowCells = [];
    for (let i = 0; i < 7; i += 1) {
      const date = range.days[w * 7 + i];
      const num = h('a', { class: 'mcell__num', href: phone ? calendarHash('month', date, query) : calendarHash('day', date, query), testid: 'month-day', 'data-date': date }, String(dayOf(date)));
      const box = h('div', { class: phone ? 'mcell__dots' : 'mcell__items' });
      const more = phone ? null : h('a', { class: 'mcell__more', href: calendarHash('day', date, query), testid: 'month-more', hidden: true });
      const add = phone ? null : h('a', { class: 'mcell__add', href: newEventHash(cleanQuery({ date })), testid: 'btn-new-event-at', 'aria-label': t('cal.newEventAt', { day: longDayText(dateMs(date), { lang }) }) }, '+');
      const cell = h('div', { class: ['mcell', date.slice(0, 7) !== range.month && 'mcell--out', date === range.date && phone && 'mcell--selected'], role: 'gridcell', 'data-date': date, testid: 'month-cell' }, num, add, box, more);
      cells.set(date, { cell, num, box, more, set: createNodeSet(box), date });
      rowCells.push(cell);
    }
    rows.push(h('div', { class: 'month__row', role: 'row' }, rowCells));
  }
  const grid = h('div', { class: 'month', role: 'grid', 'aria-label': dateText(range.date, { month: 'long', year: 'numeric' }, lang), testid: 'month-grid' }, head, rows);

  // phone: the selected day underneath
  let dayList = null;
  let daySet = null;
  let dayEmpty = null;
  let el = grid;
  if (phone) {
    dayList = h('ul', { class: 'agenda__list', testid: 'month-day-list' });
    dayEmpty = h('p', { class: 'muted', hidden: true, testid: 'month-day-empty' }, t('cal.nothingThatDay'));
    el = h(
      'div',
      { class: 'month-wrap' },
      grid,
      h('section', { class: 'dayline', 'aria-label': longDayText(dateMs(range.date), { lang }) }, h('h2', { class: 'dayline__title' }, longDayText(dateMs(range.date), { lang })), dayList, dayEmpty),
    );
    // the list holds <li> wrappers; the set below keys the wrappers
    daySet = createNodeSet(dayList);
  }

  const view = {
    el,
    grid,
    kind: 'month',
    /** model: {records, visible(rec), now, today} */
    apply(model) {
      const { records, visible } = model;
      const placed = monthCells(range, records, tz, { maxChips: Infinity, now: model.now });
      let shown = 0;
      for (const cellModel of placed) {
        const c = cells.get(cellModel.date);
        if (!c) continue;
        const items = cellModel.chips.map((chip) => {
          const rec = chip.occ;
          return {
            id: rec.key,
            sig: sigOf(rec, `${phone}|${chip.contStart}|${chip.contEnd}`),
            visible: visible(rec),
            make: () => (phone ? buildDot(rec) : buildChip(rec, { t, lang, use24h, cont: chip })),
          };
        });
        c.set.sync(items);
        let n = 0;
        let seen = 0;
        const limit = phone ? MAX_DOTS : MAX_CHIPS;
        for (const item of items) {
          const node = c.set.nodes.get(item.id);
          if (item.visible) {
            seen += 1;
            n += 1;
          }
          node.classList.toggle('is-over', item.visible && seen > limit);
        }
        shown += n;
        const label = `${longDayText(dateMs(c.date), { lang })}${cellModel.today ? `, ${t('cal.today')}` : ''}, ${tp('cal.nEvents', n, { n })}`;
        c.num.setAttribute('aria-label', label);
        if (cellModel.today) c.num.setAttribute('aria-current', 'date');
        else c.num.removeAttribute('aria-current');
        c.cell.classList.toggle('mcell--today', cellModel.today);
        if (c.more) {
          c.more.hidden = n <= MAX_CHIPS;
          c.more.textContent = t('cal.more', { n: n - MAX_CHIPS });
          c.more.setAttribute('aria-label', t('cal.moreNamed', { n: n - MAX_CHIPS, day: longDayText(dateMs(c.date), { lang }) }));
        }
      }
      if (phone) {
        const today = placed.find((c) => c.date === range.date);
        const recs = (today ? today.chips : []).map((chip) => chip.occ);
        const items = recs.map((rec) => ({
          id: rec.key,
          sig: sigOf(rec, 'row'),
          visible: visible(rec),
          make: () => h('li', { class: 'agenda__item', 'data-key': rec.key }, buildRow(rec, { t, lang, use24h })),
        }));
        daySet.sync(items);
        dayEmpty.hidden = items.some((i) => i.visible);
      }
      return { shown };
    },
    tick() {},
    nodeCount: () => [...cells.values()].reduce((n, c) => n + c.set.size, 0),
    dispose() {
      el.remove();
    },
  };
  return view;
}
