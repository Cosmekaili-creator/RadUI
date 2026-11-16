// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the task screen tests (WP C1): the calendar test environment (fake DOM, a REAL write path and item
// stores over the in-memory multi-calendar DAV server, the calendars manager, a screen context shaped like the shell's)
// filled with fictional tasks. No tests in here.
import { CAL_A, CAL_B, CAL_RO, DISPLAY_TZ, NOW, all, doc, flush, one, setup as calSetup, text } from './calendar-helpers.mjs';
import { CAL_TASKS } from '../store/_cal.mjs';
import { todoText } from '../tasks/_tasks.mjs';

export { CAL_A, CAL_B, CAL_RO, CAL_TASKS, DISPLAY_TZ, NOW, all, doc, flush, one, text };

const t = (uid, summary, lines = '') => todoText(uid, summary, lines.split('\n').filter(Boolean));

/** Tasks of the fixture: A has an overdue one, a repeating one and a parent with a child and an orphan; TASKS has a done and a today one. */
export const BASE_TASKS = () => ({
  [`${CAL_A}over.ics`]: t('over@example.org', 'Pay the invoice', 'DUE;VALUE=DATE:20260520\nPRIORITY:1\n'),
  [`${CAL_A}rep.ics`]: t('rep@example.org', 'Water the plants', 'DTSTART;VALUE=DATE:20260601\nDUE;VALUE=DATE:20260601\nRRULE:FREQ=WEEKLY;COUNT=10\n'),
  [`${CAL_A}parent.ics`]: t('parent@example.org', 'Project', 'DUE;VALUE=DATE:20260801\n'),
  [`${CAL_A}child.ics`]: t('child@example.org', 'Write the plan', 'RELATED-TO:parent@example.org\nDUE;VALUE=DATE:20260701\n'),
  [`${CAL_A}orphan.ics`]: t('orphan@example.org', 'Lost sub-task', 'RELATED-TO:nowhere@example.org\n'),
  [`${CAL_TASKS}done.ics`]: t('done@example.org', 'Send the report', 'STATUS:COMPLETED\nCOMPLETED:20260501T100000Z\nPERCENT-COMPLETE:100\n'),
  [`${CAL_TASKS}today.ics`]: t('today@example.org', 'Call the plumber', 'DUE;VALUE=DATE:20260603\nPRIORITY:5\n'),
});

export const setup = (opts = {}) => calSetup({ items: BASE_TASKS(), ...opts });

/** One task row by uid. */
export const rowOf = (root, uid) => all(root, 'task-row').find((r) => r.getAttribute('data-uid') === uid || r.getAttribute('data-uid') === `${uid}@example.org`) || null;
export const uidsOf = (root) => all(root, 'task-row').map((r) => r.getAttribute('data-uid').replace('@example.org', ''));
export const inside = (el, id) => el.querySelector(`[data-testid="${id}"]`);
