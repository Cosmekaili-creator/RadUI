<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Calendar screens (`src/js/views/calendar/`, WP B3a)

The calendar screen (`#/calendar/<view>/<date>`) and the event detail (`#/events/<key>`). They draw what `calendar/`
(DOM-free logic, [calendar.md](calendar.md)) and `store/` (`ctx.calendars` and the write path, [store.md](store.md))
provide. Styles: `css/calendar.css`. Strings: `i18n/{en,fr}.calendar.js` (keys `cal.*`). Tests:
`tests/unit-js/views/calendar-*.test.mjs` (a real write path over the in-memory DAV server of the store tests).
The event form, the recurrence builder, the scope dialogs, the time-zone picker and the Settings section belong to WP B3b
(`event-*` files of the same directory, `css/event.css`, `i18n/{en,fr}.event.js`).

| File | Role |
|---|---|
| `screen.js` | `mount(ctx, deps?)` for the calendar and `mountEvent(ctx, deps?)` for the page route. Loading, states, toggles, search, zone, the desktop detail panel. |
| `source.js` | Data layer: the calendars of the account, load on first switch-on, occurrence records of a period, the Birthdays calendar, event lookup by route key. |
| `common.js` | Preferences, hashes, `describeOccurrence` (the record every view draws), accessible names, date text. |
| `keyed.js` | `createNodeSet(box)`: keyed insert / remove / `is-off` / replace-on-change, moves a node only when its place is wrong. |
| `nodes.js` | Event chips (`event-chip`), agenda rows (`event-row`), dots. |
| `month.js`, `week.js`, `agenda.js` | The views (week.js serves week and day). Skeleton once per period, `apply({records, visible, now})` in place. |
| `toolbar.js`, `callist.js` | Toolbar (heading, today, prev, next, views, jump date field, zone switcher, search, New) and the calendar list. |
| `detail.js`, `bdaylink.js`, `detailmodel.js`, `actions.js` | The detail, the birthday detail, resolving the item/occurrence/read-only reason, edit / delete / move / export. |

## Behaviour

- **State in the URL:** `view`, `date`, `q` (search) and, on desktop, `ev` (route key), `cal`, `occ` for the open detail.
  Visible calendars and the list fold state are per-login preferences (`cal.hidden`, `cal.listState`), not in the URL.
- **Preferences read (written by Settings, WP B3b):** `cal.firstWeekday` (1-7), `cal.use24h`, `cal.birthdays` (show the
  virtual calendar, default on), `cal.hideDupBirthdays` (default on), plus the display zone (`radui.tz.display.<login>`).
  Every one applies without a reload (the screen subscribes to `app.prefs()`; the zone is read on mount).
- **Loading:** a calendar is fetched only when first switched on (`calendar-loading` on its row, one sync). Hidden calendars
  stay loaded (and polled) while the screen is open so showing them again is instant; leaving the screen releases them.
  Everything enabled is loaded in full (Q-R3-8): search runs over the loaded items, ±366 days around the date.
- **Stable toggling:** the grid element, scroller, focus and open detail are untouched by a toggle. Nodes are keyed by
  `href#RECURRENCE-ID`; they are flagged `is-off` or inserted/removed one by one. Month "+N more", week lanes and the
  counters are recomputed in place for the VISIBLE events only.
- **Time zone:** the grid is drawn in the display zone; all-day and floating values are not shifted; an unknown zone is drawn at
  its own wall clock with a "?" and "time zone unknown" in its name. Changing the display zone only redraws (no request).
- **Detail:** a side panel on desktop (the calendar stays), a page on phones and for deep links. `event-readonly` (read-only
  calendar, unknown zone, fidelity refusal), `event-tz-warning`, `event-raw`. An unknown-zone event can be deleted, not
  edited or moved. URLs are links only when plain http(s) without credentials. Birthdays open a read-only detail with
  "Open contact".
- **Edit:** the button asks the scope for a series (`askScope` of WP B3b; a plain dialog with the same ids stands in when
  that module is absent) and goes to `#/events/<key>/edit?cal=&occ=&scope=`.
- **Delete / move:** through `writes.deleteItem` (shown ETag), `writes.applyOps` (`deleteOccurrence`, `truncate`) and
  `writes.moveItem`; conflicts open the shared conflict dialog.
- **Navigation entry:** `nav-calendar` stays hidden until `'3b'` is added to `ENABLED_SLICES` (js/app.js) by the last WP of
  the slice.

## Test ids

Screen: `calendar-screen` (`data-state`, `data-sync`, `data-view`, `data-list-state`), `cal-toolbar`, `view-month|week|day|agenda`,
`cal-today`, `cal-prev`, `cal-next`, `cal-jump` (`-input`, `-picker`), `period-heading`, `tz-display`, `cal-search`, `btn-new-event`,
`calendar-readonly`, `cal-status`, `cal-content`. List: `calendar-list`, `calendar-toggle` (`data-href`), `calendar-loading`,
`calendar-failed`, `callist-count`, `callist-live`, `cal-list-toggle` (phone), `btn-toggle-callist`, `bday-hide-duplicates`,
`link-manage-calendars`, `callist-none`. Views: `month-grid`, `month-cell`, `month-day`, `month-more`, `month-day-list`,
`week-grid`, `day-grid`, `week-day`, `allday-row`, `time-scroller`, `now-marker`, `btn-new-event-at`, `agenda-list`,
`search-results`, `agenda-empty`, `cal-no-match`. Event nodes: `event-chip` (month, week, day), `event-row` (agenda, search),
all with `data-uid`, `data-href`, `data-calendar`, `data-occurrence` (RECURRENCE-ID or `single`), `data-key`, `data-readonly`.
States: `calendar-empty`, `btn-new-calendar`, `calendar-noaccess`, `calendar-error`, `calendar-offline`, `btn-retry`.
Detail: `event-panel`, `event-screen`, `event-detail`, `event-title`, `event-when`, `event-zone-start`, `event-zone-end`,
`event-floating`, `event-location`, `event-url`, `event-description`, `event-categories`, `event-status`, `event-recurrence`,
`event-attendees` (`attendee-row`), `event-alarms`, `event-meta`, `event-readonly`, `event-tz-warning`, `event-raw`,
`btn-edit-event`, `btn-delete-event`, `btn-move-event`, `btn-export-event`, `btn-close-detail`, `btn-back`, `btn-open-contact`,
`event-notfound`, `event-loading`; dialogs `dialog-delete-event` (`dialog-confirm-delete`, `dialog-cancel`), `dialog-move-event`
(`field-move-target`, `dialog-confirm-move`), and the scope dialog ids (`dialog-scope-edit|delete`, `scope-this`, `scope-following`,
`scope-all`, `scope-cancel`).
