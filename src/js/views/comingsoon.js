// SPDX-License-Identifier: AGPL-3.0-or-later
// "Coming soon" page: stands in for the calendar and task routes until their slice ships and for every
// screen whose module has not been delivered yet (see js/screens.js). Test ids: comingsoon-screen,
// comingsoon-home.

import { h } from '../ui.js';
import { LANDING_HASH } from '../router.js';

/** i18n key of the name shown on the page, from the route name or its screen. */
export function comingSoonNameKey(route) {
  const screen = route && route.screen;
  if (screen === 'calendar' || screen === 'event' || screen === 'event-form') return 'comingsoon.name.calendar';
  if (screen === 'tasks' || screen === 'task' || screen === 'task-form') return 'comingsoon.name.tasks';
  if (screen === 'contacts' || screen === 'contact-form' || screen === 'groups') return 'nav.contacts';
  if (screen === 'collections' || screen === 'collection-form') return 'nav.collections';
  return 'comingsoon.name.generic';
}

/**
 * @param {object} ctx {root, t, route}
 */
export function renderComingSoon({ root, t, route }) {
  const name = t(comingSoonNameKey(route));
  root.append(
    h(
      'section',
      { class: 'notfound comingsoon', testid: 'comingsoon-screen', 'aria-labelledby': 'comingsoon-title' },
      h('h1', { class: 'page-title', id: 'comingsoon-title', tabindex: '-1' }, t('comingsoon.title')),
      h('p', null, t('comingsoon.text', { name })),
      h('a', { class: 'btn', href: LANDING_HASH, testid: 'comingsoon-home' }, t('comingsoon.home')),
    ),
  );
  return { title: t('comingsoon.title') };
}
