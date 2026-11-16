// SPDX-License-Identifier: AGPL-3.0-or-later
// French dictionary: the aggregator of the part files fr.<area>.js (one owner per part).
// A key may appear in ONE part only and both languages carry identical keys and `{placeholders}`
// (tests/unit-js/app/i18n.test.mjs). To add a language: copy the parts to <code>.<area>.js and
// <code>.js, translate every value, and register it in src/js/i18n.js.

import shell from './fr.shell.js';
import widgets from './fr.widgets.js';
import contacts from './fr.contacts.js';
import groups from './fr.groups.js';
import collections from './fr.collections.js';
import importing from './fr.import.js';
import conflict from './fr.conflict.js';
import pwa from './fr.pwa.js';
import common from './fr.common.js';
import settings from './fr.settings.js';
import users from './fr.users.js';
import calendar from './fr.calendar.js';
import event from './fr.event.js';
import tasks from './fr.tasks.js';
import recur from './fr.recur.js';

export default Object.freeze({
  ...shell,
  ...widgets,
  ...contacts,
  ...groups,
  ...collections,
  ...importing,
  ...conflict,
  ...pwa,
  ...common,
  ...settings,
  ...users,
  ...calendar,
  ...event,
  ...tasks,
  ...recur,
});
