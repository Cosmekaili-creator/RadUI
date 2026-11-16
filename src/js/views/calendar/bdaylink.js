// SPDX-License-Identifier: AGPL-3.0-or-later
// A birthday occurrence of the virtual Birthdays calendar (RUN3 WP B3a): a small read-only detail with a link to
// the contact. Nothing about a birthday can be edited, moved or deleted here.
// Test ids: event-detail (data-virtual), event-title, event-when, event-readonly, btn-open-contact.

import { h } from '../../ui.js';
import { contactHash } from './common.js';

/** `#/contacts/<key>?ab=<address book>` of a birthday record. */
export const contactHashOf = (rec) => contactHash(rec.routeKey, rec.ab);

/** The detail body of a birthday record. `ops.onClose` is optional (panel). */
export function buildBirthdayDetail(rec, { t, ops = {} }) {
  const title = rec.occ && rec.occ.title ? rec.occ.title : rec.title;
  return h(
    'section',
    { class: 'event-detail event-detail--birthday', testid: 'event-detail', 'data-virtual': 'true', 'data-calendar': rec.calendar, 'data-key': rec.key, 'data-uid': rec.uid || rec.routeKey || '', 'data-readonly': 'true', 'aria-labelledby': 'event-title' },
    h('h2', { class: 'event-detail__title', id: 'event-title', testid: 'event-title', tabindex: '-1' }, title),
    h('p', { class: 'event-detail__when', testid: 'event-when' }, rec.when),
    rec.age !== null && rec.age !== undefined ? h('p', { testid: 'event-age' }, t('cal.bday.age', { age: rec.age })) : null,
    h('p', { class: 'notice', testid: 'event-readonly' }, t('cal.bday.readonly')),
    h('div', { class: 'detail__actions' }, h('a', { class: 'btn btn--primary', href: contactHashOf(rec), testid: 'btn-open-contact' }, t('cal.bday.openContact', { name: title })), ops.onClose ? h('button', { type: 'button', class: 'btn', testid: 'btn-close-detail', on: { click: () => ops.onClose() } }, t('cal.closeDetail')) : null),
  );
}
