<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Tasks (`src/js/tasks/`, `src/js/views/tasks/`, WP C1)

The merged task list (`#/tasks`), the task detail (`#/tasks/<key>?list=<href>`) and the task form
(`#/tasks/new?list=`, `#/tasks/<key>/edit?list=`). Logic without DOM in `tasks/`, screens in `views/tasks/`,
styles in `css/tasks.css`, strings in `i18n/{en,fr}.tasks.js` (keys `tasks.*`). Tests: `tests/unit-js/tasks/` and
`tests/unit-js/views/tasks-*.test.mjs`, plus a block at the end of `tests/roundtrip/ui-ops-events.test.mjs`
(complete / reopen / one edit, PUT then GET, against a throwaway Radicale).

| File | Role |
|---|---|
| `tasks/list.js` | `describeTask` (a record from a parsed task), `matches`/`countFilters` (open, today, overdue, done, all), `compareTasks` (due, priority), `buildTree` (RELATED-TO hierarchy), `makeTaskKeyer` (route key). |
| `tasks/formmodel.js` | `fromItem`, `toPatch`, `validate`, `newTaskValues`, `toNewFields`, `withZone`, select options. The only place where form values become a model patch. |
| `views/tasks/screen.js` | `mount` (the list) and `mountTask` (the detail). Loading, states, list toggles, filters, complete. |
| `views/tasks/rows.js` | The keyed row tree: rows are inserted, removed and moved one by one; a row whose signature is unchanged is not touched. |
| `views/tasks/source.js` | Data layer over `ctx.calendars`: the task lists of the account, load on first switch-on, records, lookup by route key, relatives. |
| `views/tasks/form.js` | The form (new and edit are one form). |
| `views/tasks/detail.js`, `actions.js`, `common.js` | Detail builder; complete / reopen / delete; hashes, prefs, texts. |

## Behaviour

- **Merged list.** Every collection that accepts VTODO is a task list (a component set that is unknown counts as
  accepting). Each has a toggle (`tasklist-toggle`); the choice is the per-login preference `tasks.hidden` (not in the URL).
  A list is fetched the first time it is switched on; hidden lists stay loaded while the screen is open (parents are looked up there).
  Leaving the screen releases the lists.
- **State in the URL:** `filter=open|today|overdue|done|all` and `sort=due|priority`. An unknown value falls back to `open` / `due`.
  A route change with the same screen updates in place (same list element, same row nodes).
- **Today and overdue** are judged in the DISPLAY zone (the pref of the calendar). A DATE due is overdue from the next day on; a
  date-time due once it has passed (by its instant; floating values by the wall clock). A due in an unknown zone is read at its
  own wall clock. Done = COMPLETED or CANCELLED (or a COMPLETED timestamp without STATUS).
- **Sort.** Due: earliest first, no due date last. Priority: 1 first, no priority last. Ties: the other key, title, href.
- **Rows.** `task-row` (`data-uid`, `data-href`, `data-list`, `data-status`, `data-readonly`, `data-key`, `data-depth`).
  Priority is bars plus a word (1-4 high, 5 medium, 6-9 low, 0 none); overdue is red plus "Overdue since ...".
- **Complete.** `task-complete` (`aria-pressed`) is the `complete` / `reopen` operation of `writes.applyOps` (STATUS,
  COMPLETED (UTC now), PERCENT-COMPLETE 100; reopen: NEEDS-ACTION, no COMPLETED, no PERCENT-COMPLETE). The base is the version
  that was shown (same ETag), else nothing is sent. **A repeating task cannot be completed** (disabled, with the accessible
  name "Repeating tasks can't be completed here yet", Q-R3-5; reopening a done one is allowed). A read-only list or task says so
  the same way. After a completion that removes the row, the focus goes to the row now in its place.
- **Sub-tasks.** A child names its parent with RELATED-TO (no RELTYPE or PARENT); a parent may name children with RELTYPE=CHILD.
  Children are nested under the parent (a parent that does not match the filter stays as context when a child matches). A
  claim to a UID that no loaded task has makes an orphan: top level with "Parent not found". Cycles are cut. Editing the
  hierarchy is v1.1.
- **Form.** Fields `field-summary`, `field-list` (new only), `field-due-date/-time`, `field-tz-due`, `field-start-*`,
  `field-tz-start`, `field-priority`, `field-status`, `field-percent`, `field-categories`, `field-description`; `task-save`,
  `task-cancel`, `task-delete` (`dialog-delete-task`). A form that changed nothing sends nothing ("No changes to save"). A
  due or start without a time is a DATE; a time typed into one takes the display zone; the zone of an existing time (TZID, UTC,
  floating) is never rewritten unless the zone picker or the time changed. DUE and DTSTART must both have a time or both be
  dates (RFC 5545). Status Done also sets COMPLETED and 100 %; leaving Done removes them. The RRULE is shown read-only and is
  never in a patch. A priority such as 3 stays selectable. Unsaved input is guarded; a language switch keeps it.
- **States.** `tasks-nolist` (no task list: create button to `#/collections/new-calendar?components=VTODO`, which starts with
  tasks ticked; without own space a plain explanation), `tasks-empty`, `tasks-filter-empty`, `tasks-readonly` (nothing writable:
  New is disabled with an explanation), `tasks-error` / `tasks-offline` + `btn-retry`, `tasks-status` (persistent line:
  "12 open · 3 overdue · 2 task lists").
- **Detail.** `task-detail` with read-only fields, the rule as a sentence, the parent and children as links, `task-readonly` /
  `task-raw` for an unknown zone (delete only), `task-complete`, `btn-edit-task`, `btn-delete-task`.
- **Navigation entry.** `nav-tasks` is shown since `'3c'` is in `ENABLED_SLICES` (js/app.js; switched on after the `tasks` E2E suite
  passed). The "New task" manifest shortcut points at the working form route. The zone buttons are named "Due time zone" and "Start time zone".
- **E2E.** `tests/e2e/scenarios/tasks.mjs` (`make test-e2e E2E_SUITE=tasks`); the seed is `seed_tasks` in `tests/e2e/run.py` (dates relative to today in Europe/Paris).

## Test ids

Screen: `tasks-screen` (`data-state`, `data-sync`, `data-filter`, `data-sort`), `task-filters`, `task-filter-<f>` (+ `-count`),
`task-sort`, `btn-new-task`, `tasklist-bar`, `tasklist-toggle` (`data-href`), `tasklist-loading`, `tasklist-failed`,
`tasklist-live`, `tasks-status`, `task-list`, `task-row`, `task-complete`, `task-open`, `task-due`, `task-priority`,
`task-repeats`, `task-orphan`, `task-context`, `task-subtasks`. States: `tasks-empty` (`btn-new-task-empty`), `tasks-nolist`
(`btn-create-task-list`), `tasks-readonly`, `tasks-filter-empty`, `tasks-error`, `tasks-offline`, `btn-retry`. Detail:
`task-screen`, `task-detail`, `task-title`, `task-status`, `task-start`, `task-due`, `task-priority`, `task-percent`,
`task-categories`, `task-description`, `task-recurrence`, `task-parent`, `task-children`, `task-meta`, `task-readonly`,
`task-raw`, `btn-edit-task`, `btn-delete-task`, `btn-back`, `task-notfound`. Form: `task-form-screen`, `task-form`, the
`field-*` ids above, `form-errors`, `form-error-link`, `form-status`, `task-form-notfound`, `task-form-readonly`,
`task-form-nolist`.
