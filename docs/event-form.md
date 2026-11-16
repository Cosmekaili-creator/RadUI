<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Event form, recurrence builder, scope dialogs, zone picker (`src/js/views/calendar/`, Run 3 WP B3b)

Logic lives in `src/js/calendar/` (see `calendar.md`); these modules are the DOM around it. Tests: `tests/unit-js/views/event-*.test.mjs`.

| Module | Role |
|---|---|
| `form.js` | `mount(ctx, deps)` for `#/events/new` (`date=`, `time=`, `cal=`) and `#/events/<key>/edit` (`cal=`, `occ=`, `scope=this\|following\|all`); `previewText`, `durationText`, `resolveUse24h`. |
| `recurrence.js` | `createRecurrenceBuilder` (`recurrence-builder`, `rec-*`), `followStart`, `monthlyChoices`. |
| `scopedialog.js` | `askScope({mode, isFirst, title, t})` (`dialog-scope-edit` / `dialog-scope-delete`) and `askRuleExceptions` (`dialog-rule-exceptions`). |
| `tzpicker.js` | `createZoneField` (a button; `field-tz-start`, `field-tz-end`, `settings-tz-display`), `openZonePicker` (`zone-picker`, `field-zone-search`, `zone-option`), `zoneOptions`. |
| `alarms.js` | `createAlarmsEditor`: up to three presets (`field-alarm-<n>`), custom and foreign alarms kept. |
| `../settings/calendar.js` | The calendar section of Settings: display zone, first weekday, clock, birthdays, duplicate filter. |

## How a save works

1. `collect()` reads the controls into the values of `formmodel.fromItem`; `formmodel.validate` names the fields (`form-errors`, one `form-error-link` each, the first field is focused).
2. A new event: `formmodel.toNewFields` and `writes.createItem({kind: 'event'})`. After `unknown-result` the form locks and Save becomes "Try again", which repeats the create with the result's `retry` token only.
3. An existing event: `formmodel.toPatch(base values, values)` (only what changed; an untouched time group keeps its TZID and its stored form, an existing zone is rewritten only when its picker was used), then `scope.planEdit`. The plan is data: `applyOps({ops})`, or `splitWrite({rid, tailFields, exceptions})` for "this and following". `needs: 'exceptions'` opens `dialog-rule-exceptions` and the plan is made again with the answer. Skipped dates the user brought back (`btn-restore-exception`) are `removeExdate` operations placed BEFORE the plan's operations.
4. One request per save (two for a split: the tail, then the truncated original). A conflict opens the shared conflict dialog; "Overwrite" replays the same operations on their version.
5. Unsaved input is guarded with `app.setDirty` and survives a language switch (`snapshot()` keeps the values and the version the user started from).

## Rules worth knowing

* The end follows the start (same distance) until the end was edited; the end zone follows the start zone until it was chosen.
* A scope "this" form has no recurrence builder. A scope "all" form lists the skipped and changed dates (`rec-exceptions`).
* Scope dialogs: no "this and following" for the first occurrence; the delete variant focuses Cancel; `dialog-rule-exceptions` focuses Keep ONLY when nothing would be orphaned (addendum M3), otherwise Cancel, and lists the dates that "will no longer be shown".
* `event-when-preview` (polite live region) says where the event falls in the display zone and how long it lasts, and states a DST gap or a repeated hour as text ("14:30 does not exist in ... on ...; it will be stored as 03:30").
* New events carry a `TZID`; the server and the model add the VTIMEZONE (nothing in the views writes one).
* Reminders: presets none / at start / 5, 10, 15, 30 minutes / 1 hour / 1 day before; an alarm the presets cannot express stays as a "custom" choice showing its own text; other alarms are only counted (`alarms-foreign`).
* An event with an unknown time zone, or in a read-only calendar, shows `event-readonly` instead of the form.
* Settings preferences are per login: `cal.firstWeekday`, `cal.use24h`, `cal.birthdays`, `cal.hideDupBirthdays` (settings/prefs.js, read by the calendar screen, which re-draws at once) and the display zone (`radui.tz.display.<login>`, read when the calendar mounts). Choosing a zone never writes to the server.
