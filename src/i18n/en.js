// SPDX-License-Identifier: AGPL-3.0-or-later
// English dictionary: the aggregator of the part files en.<area>.js (one owner per part).
// A key may appear in ONE part only and both languages carry identical keys and `{placeholders}`
// (tests/unit-js/app/i18n.test.mjs). To add a language: copy the parts to <code>.<area>.js and
// <code>.js, translate every value, and register it in src/js/i18n.js.

import shell from './en.shell.js';
import widgets from './en.widgets.js';
import contacts from './en.contacts.js';
import groups from './en.groups.js';
import collections from './en.collections.js';
import importing from './en.import.js';
import conflict from './en.conflict.js';
import pwa from './en.pwa.js';
import common from './en.common.js';
import settings from './en.settings.js';
import users from './en.users.js';
import calendar from './en.calendar.js';
import event from './en.event.js';
import tasks from './en.tasks.js';
import recur from './en.recur.js';

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
