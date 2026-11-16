// SPDX-License-Identifier: AGPL-3.0-or-later
// The calendar list (RUN3 WP B3a): one checkbox per calendar that holds events (colour through `vars`), the
// virtual Birthdays calendar and its "hide duplicates" box, a count, a polite live line ("Calendar Work shown,
// 12 events") and the fold button. Rows are updated IN PLACE (a toggle never rebuilds the list, so focus stays on
// the checkbox). Desktop: open / rail (colour dots only; names stay in the accessibility tree) / hidden; the choice
// is persisted by the screen. Phone: a disclosure sheet.
// Test ids: calendar-list, calendar-toggle (data-href), calendar-loading, calendar-failed, callist-count,
// callist-live, bday-hide-duplicates, btn-toggle-callist (aria-expanded, aria-controls), cal-list-toggle (phone),
// link-manage-calendars, callist-none.

import { h } from '../../ui.js';
import { BIRTHDAYS_HREF, COLOUR_ALLOW, LIST_STATES } from './common.js';

const BODY_ID = 'cal-list-body';

/** The next fold state when the button is pressed: open -> rail -> hidden -> open. */
export const nextListState = (state) => LIST_STATES[(LIST_STATES.indexOf(state) + 1) % LIST_STATES.length];

export function createCallist({ t, ops, state = 'open' }) {
  let current = state;
  let lastModel = null;
  const rows = new Map(); // href -> {li, cb, tags, loading, failed, label, name}

  const countHead = h('span', { class: 'cal-list__count', testid: 'callist-count' });
  const countPhone = h('span', { class: 'cal-list__count' });
  const live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', testid: 'callist-live' });
  const disclosure = h('button', { type: 'button', class: 'cal-list__disclosure', 'aria-expanded': 'false', 'aria-controls': BODY_ID, testid: 'cal-list-toggle' }, h('span', null, t('cal.calendars')), countPhone);
  const fold = h('button', { type: 'button', class: 'btn btn--icon cal-list__fold', 'aria-controls': BODY_ID, testid: 'btn-toggle-callist' });
  const head = h('div', { class: 'cal-list__head' }, h('h2', { class: 'cal-list__title' }, t('cal.calendars'), ' ', countHead), fold);
  const ul = h('ul', { class: 'cal-list__rows', 'aria-label': t('cal.calendars') });
  const none = h('p', { class: 'cal-list__note', hidden: true, testid: 'callist-none' }, t('cal.noneAccessible'));
  const dupBox = h('input', { type: 'checkbox', id: 'cal-bday-dups', testid: 'bday-hide-duplicates' });
  dupBox.addEventListener('change', () => ops.onHideDup(dupBox.checked));
  const dupRow = h('div', { class: 'cal-list__opt', hidden: true }, dupBox, h('label', { for: 'cal-bday-dups' }, t('cal.bday.hideDup')));
  const bdayNote = h('p', { class: 'cal-list__note', hidden: true }, t('cal.bday.note'));
  const body = h('div', { class: 'cal-list__body', id: BODY_ID }, ul, none, dupRow, bdayNote, h('a', { class: 'link', href: '#/collections', testid: 'link-manage-calendars' }, t('cal.manage')));
  const el = h('aside', { class: 'cal-list', 'aria-label': t('cal.calendars'), testid: 'calendar-list', 'data-list-state': current }, disclosure, head, body, live);

  disclosure.addEventListener('click', () => {
    const open = disclosure.getAttribute('aria-expanded') !== 'true';
    disclosure.setAttribute('aria-expanded', String(open));
    body.classList.toggle('is-open', open);
  });
  fold.addEventListener('click', () => {
    const next = nextListState(current);
    api.setState(next);
    ops.onState(next);
    live.textContent = t(`cal.list.state.${next}`);
  });

  function buildRow(c) {
    const id = `cal-vis-${rows.size}-${Math.abs(hash(c.href))}`;
    const cb = h('input', { type: 'checkbox', class: 'swatch-check', id, testid: 'calendar-toggle', 'data-href': c.href === BIRTHDAYS_HREF ? BIRTHDAYS_HREF : c.href, 'data-uid': c.href, vars: { allow: COLOUR_ALLOW, values: { '--cal': c.color } } });
    const name = h('span', { class: 'cal-list__name' });
    const tags = h('span', { class: 'cal-list__tags' });
    const loading = h('span', { class: 'cal-list__loading', testid: 'calendar-loading', hidden: true }, t('cal.loading'));
    const failed = h('span', { class: 'cal-list__failed', testid: 'calendar-failed', hidden: true }, t('cal.loadFailed'));
    const label = h('label', { for: id, class: 'cal-list__label' }, name, tags);
    const li = h('li', { class: 'cal-list__row', 'data-calendar': c.href }, cb, label, loading, failed);
    cb.addEventListener('change', () => ops.onToggle(c.href, cb.checked, rows.get(c.href)));
    return { li, cb, name, tags, loading, failed, label };
  }

  function paintRow(r, c, on) {
    r.cb.checked = on;
    r.name.textContent = c.name;
    r.cb.setAttribute('aria-label', c.name);
    r.tags.replaceChildren();
    if (c.owner && !c.ownerIsMe) r.tags.append(h('span', { class: 'tag tag--quiet' }, t('cal.ownedBy', { owner: c.owner })));
    if (c.readOnlyTag) r.tags.append(h('span', { class: 'tag' }, t('cal.readOnly')));
    r.loading.hidden = !c.loading;
    r.failed.hidden = !c.failed;
    if (c.loading) r.li.setAttribute('aria-busy', 'true');
    else r.li.removeAttribute('aria-busy');
  }

  const api = {
    el,
    live,
    get state() {
      return current;
    },
    setState(next) {
      if (!LIST_STATES.includes(next)) return;
      current = next;
      el.setAttribute('data-list-state', next);
      fold.setAttribute('aria-expanded', String(next === 'open'));
      const label = t(`cal.list.fold.${next}`);
      fold.setAttribute('aria-label', label);
      fold.setAttribute('title', label);
      fold.replaceChildren(h('span', { 'aria-hidden': 'true' }, next === 'open' ? '‹' : next === 'rail' ? '×' : '›'));
    },
    /**
     * @param {{calendars: object[], hidden: Set<string>, birthdays: {available: boolean, shown: boolean, loading: boolean,
     *   failed: boolean, hideDup: boolean, color: string}}} m
     */
    render(m) {
      lastModel = m;
      const wanted = m.calendars.map((c) => ({ ...c, readOnlyTag: !c.canWrite }));
      if (m.birthdays.available) wanted.push({ href: BIRTHDAYS_HREF, name: t('cal.birthdays'), color: m.birthdays.color, owner: null, ownerIsMe: true, readOnlyTag: true, loading: m.birthdays.loading, failed: m.birthdays.failed });
      const keep = new Set(wanted.map((c) => c.href));
      for (const [href, r] of [...rows]) {
        if (!keep.has(href)) {
          r.li.remove();
          rows.delete(href);
        }
      }
      let on = 0;
      wanted.forEach((c, i) => {
        let r = rows.get(c.href);
        if (!r) {
          r = buildRow(c);
          rows.set(c.href, r);
        }
        const visible = !m.hidden.has(c.href);
        if (visible) on += 1;
        paintRow(r, c, visible);
        if (ul.children[i] !== r.li) ul.insertBefore(r.li, ul.children[i] || null);
      });
      none.hidden = wanted.length > 0;
      const text = `${on}/${wanted.length}`;
      countHead.textContent = text;
      countPhone.textContent = text;
      countHead.setAttribute('data-count', String(on));
      dupRow.hidden = !m.birthdays.available;
      bdayNote.hidden = !m.birthdays.available;
      dupBox.checked = m.birthdays.hideDup;
    },
    row: (href) => rows.get(href) || null,
    announce(text) {
      live.textContent = text;
    },
    get model() {
      return lastModel;
    },
    focusToggle(href) {
      const r = rows.get(href);
      if (r) r.cb.focus();
    },
  };
  api.setState(current);
  return api;
}

function hash(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) n = (n * 31 + s.charCodeAt(i)) | 0;
  return n;
}
