// SPDX-License-Identifier: AGPL-3.0-or-later
// The calendar toolbar (RUN3 WP B3a): period heading, today / previous / next, the four views, "go to date",
// the display time-zone switcher, search and "New event". Built once; `update(state)` rewrites hrefs, labels and
// the heading in place so the search box keeps its text and focus while the user navigates.
// Test ids: view-month|week|day|agenda, cal-today, cal-prev, cal-next, cal-jump (own date field), period-heading,
// tz-display, cal-search, btn-new-event, calendar-readonly (the reason New is unavailable).

import { h } from '../../ui.js';
import { createDateField } from '../../widgets/datefield.js';
import { openPicker } from '../../widgets/picker.js';
import { shiftDate, todayIn, VIEWS } from '../../calendar/grid.js';
import { recentZones, zoneList, zoneOffsetLabel } from '../../calendar/tzprefs.js';
import { calendarHash, cleanQuery, dayOf, newEventHash, periodText } from './common.js';

const OTHER = '__other';

/**
 * @param {object} o
 * @param {Function} o.t @param {Function} o.tp @param {string} o.lang
 * @param {object} o.ops {onSearch(text), onSearchNow(text), onJump(iso), onZone(tz)}
 * @param {object} o.deps {win, timers, login, storage, now}
 */
export function createToolbar({ t, lang, firstWeekday, ops, deps = {} }) {
  const now = deps.now || (() => Date.now());
  let state = null;
  let lastQ = '';

  const heading = h('h1', { class: 'period', testid: 'period-heading', tabindex: '-1' });
  const today = h('a', { class: 'btn cal__today', testid: 'cal-today' }, t('cal.today'));
  const prev = h('a', { class: 'btn btn--icon cal__prev', testid: 'cal-prev' }, h('span', { 'aria-hidden': 'true' }, '‹'));
  const next = h('a', { class: 'btn btn--icon cal__next', testid: 'cal-next' }, h('span', { 'aria-hidden': 'true' }, '›'));
  const seg = h('nav', { class: 'seg cal__views', 'aria-label': t('cal.viewSwitch') });
  const viewLinks = new Map();
  for (const v of VIEWS) {
    const a = h('a', { class: 'seg__item', testid: `view-${v}` }, t(`cal.view.${v}`));
    viewLinks.set(v, a);
    seg.append(a);
  }
  const newBtn = h('a', { class: 'btn btn--primary cal__new', testid: 'btn-new-event' }, t('cal.newEvent'));
  const newNote = h('p', { class: 'cal__note', id: 'cal-new-note', testid: 'calendar-readonly', hidden: true }, t('cal.readOnlyNote'));

  const jump = createDateField({
    testid: 'cal-jump',
    label: t('cal.jump'),
    t,
    lang,
    picker: true,
    firstWeekday,
    now: () => new Date(now()),
    onChange: (r) => {
      if (r && r.ok && !r.empty && r.iso) ops.onJump(r.iso);
    },
  });

  const zoneSelect = h('select', { class: 'zone-switch__select', id: 'cal-tz', testid: 'tz-display', 'aria-label': t('cal.tz.label') });
  const zone = h('div', { class: 'zone-switch' }, h('label', { class: 'zone-switch__label', for: 'cal-tz' }, t('cal.tz.viewingIn')), zoneSelect);
  zoneSelect.addEventListener('change', async () => {
    if (zoneSelect.value !== OTHER) {
      ops.onZone(zoneSelect.value);
      return;
    }
    const back = state ? state.tz : '';
    zoneSelect.value = back;
    const options = zoneList({ recent: recentZones(deps.login || '', { storage: deps.storage }), seen: state ? state.seenZones : [], browser: state ? state.tz : undefined }).map((z) => ({ id: z.id, label: z.id.replace(/_/g, ' '), sublabel: zoneOffsetLabel(z.id, now()) }));
    const chosen = await openPicker({
      name: 'zone',
      title: t('cal.tz.pickTitle'),
      description: t('cal.tz.explain'),
      searchLabel: t('cal.tz.search'),
      options,
      selected: back ? [back] : [],
      t,
      tp: deps.tp,
      win: deps.win,
      timers: deps.timers,
    });
    if (chosen && chosen.length) ops.onZone(chosen[0]);
    else zoneSelect.focus();
  });

  const search = h('input', { type: 'search', class: 'input cal__search-input', id: 'cal-search', testid: 'cal-search', autocomplete: 'off', placeholder: t('cal.search.placeholder'), 'aria-label': t('cal.search.label') });
  search.addEventListener('input', () => ops.onSearch(search.value));
  const searchForm = h('form', { class: 'cal__search', role: 'search' }, search);
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    ops.onSearchNow(search.value);
  });

  const el = h(
    'div',
    { class: 'cal__toolbar', testid: 'cal-toolbar' },
    h('div', { class: 'cal__row cal__row--top' }, heading, h('div', { class: 'cal__nav' }, today, prev, next), newBtn),
    newNote,
    h('div', { class: 'cal__row cal__row--tools' }, seg, zone, h('div', { class: 'cal__jump' }, jump.el), searchForm),
  );

  function fillZones(tz, recents) {
    zoneSelect.replaceChildren();
    const list = [...new Set([tz, ...recents])].filter(Boolean);
    const group = h('optgroup', { label: t('cal.tz.recent') });
    for (const z of list) group.append(h('option', { value: z }, `${z.replace(/_/g, ' ')} (${zoneOffsetLabel(z, now())})`));
    zoneSelect.append(group, h('option', { value: OTHER }, t('cal.tz.other')));
    zoneSelect.value = tz;
  }

  return {
    el,
    heading,
    search,
    jump,
    zoneSelect,
    newBtn,
    /** state: {view, date, range, q, tz, recents, seenZones, phone, canCreate, createReason, newHref, query} */
    update(s) {
      state = s;
      const { view, date, range, q, phone } = s;
      const query = cleanQuery({ q });
      const txt = periodText(view, range, { lang });
      heading.replaceChildren();
      if (view === 'day') {
        heading.className = 'period period--day';
        heading.append(h('span', { class: 'period__num' }, String(dayOf(range.start))), h('span', { class: 'period__stack' }, h('span', { class: 'period__main' }, txt.main), h('span', { class: 'period__sub' }, txt.sub)));
      } else {
        heading.className = 'period';
        heading.append(h('span', { class: 'period__main' }, txt.main), h('span', { class: 'period__sub' }, txt.sub));
      }
      today.setAttribute('href', calendarHash(view, todayIn(s.tz, now()), query));
      prev.setAttribute('href', calendarHash(view, shiftDate(view, date, -1, { phone }), query));
      next.setAttribute('href', calendarHash(view, shiftDate(view, date, 1, { phone }), query));
      prev.setAttribute('aria-label', t(`cal.prev.${view}`));
      next.setAttribute('aria-label', t(`cal.next.${view}`));
      for (const [v, a] of viewLinks) {
        a.setAttribute('href', calendarHash(v, date, query));
        if (v === view) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      jump.setValue(date);
      // the box follows the URL only when the URL changed (Back, a link); text typed but not yet pushed stays
      if ((q || '') !== lastQ) {
        lastQ = q || '';
        if ((deps.doc || globalThis.document).activeElement !== search || search.value !== lastQ) search.value = lastQ;
      }
      fillZones(s.tz, s.recents);
      if (s.canCreate) {
        newBtn.setAttribute('href', s.newHref || newEventHash({ date }));
        newBtn.removeAttribute('aria-disabled');
        newBtn.removeAttribute('aria-describedby');
        newNote.hidden = true;
      } else {
        newBtn.removeAttribute('href');
        newBtn.setAttribute('role', 'link');
        newBtn.setAttribute('aria-disabled', 'true');
        newBtn.setAttribute('aria-describedby', 'cal-new-note');
        newNote.textContent = s.createReason || t('cal.readOnlyNote');
        newNote.hidden = false;
      }
    },
    focusHeading() {
      heading.focus();
    },
  };
}
