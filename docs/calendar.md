<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Calendar logic (`src/js/calendar/`, no DOM)

Pure modules for the calendar screens (Run 3, WP B1). Node 20 and browsers; tests in `tests/unit-js/calendar/`
and `tests/unit-js/model/event-shift.test.mjs`. Civil dates are ISO strings (`YYYY-MM-DD`) and never go
through the local time zone.

| Module | Role |
|---|---|
| `grid.js` | Periods: `periodRange(view, date, {firstWeekday, phone})` (month = full weeks, 4 to 6 rows; week = 7 days, on a phone 3 days starting at the date; day; agenda = 30 days), `shiftDate`, `todayIn(tz)`, `instantWindow(range, tz)` (padded by a day because all-day and floating values compare as wall clock). |
| `layout.js` | Where occurrences go. Everything is drawn in the display zone; all-day and floating values are not shifted; an unknown zone is drawn at its own wall clock and flagged `unknownZone`; timed events are split at midnight of the display zone. `layoutDay` (lane packing: overlapping events form a cluster, `lanes` = columns of the cluster), `layoutAllDayRow`, `monthCells` (a chip on EACH day of a multi-day event, all-day first, `more` = hidden count), `nowMarker`. A DST day keeps 1440 grid minutes (the grid is a wall clock). |
| `rrule.js` | Recurrence builder model: `parseRule` gives builder state or `custom`, `buildRule` writes it back, `canonicalRule`/`sameRule` compare part maps (order, case, BYDAY order and `INTERVAL=1` do not matter). |
| `recurtext.js` | The sentence, from `recur.*` i18n templates (`src/i18n/{en,fr}.recur.js`) plus Intl names. |
| `scope.js` | `availableScopes`, `planEdit`, `planDelete`, `applyOpsToItem`, `occParamOf`/`findOccurrence`. Pure: it reads an Item and simulates on a fresh copy of `item.raw`. |
| `formmodel.js` | The event form model: `fromItem`, `toPatch`, `validate`, `valuesToSpecs`, `whenInfo`, `newEventValues`, `toNewFields`. |
| `birthdays.js` | The virtual Birthdays calendar. |
| `tzprefs.js` | Display-zone pref (`radui.tz.display.<login>`), recents, the zone list and search, DST gap/overlap status. |
| `search.js` | Folded search over the loaded occurrences. |

Additions to `model/event.js` (and thin `Item` methods): `shiftExceptions`, `truncateSeries`, `untilFor`,
`untilDateOf`, `exceptionsOf`, `orphanedExceptions`, `removeExceptions`, `SeriesError`, and the `exceptions` /
`discardTail` options of `splitSeries`.

## Recurrence rules

A rule is editable only when `build(parse(rule))` equals it as a sorted part map. Everything else (BYSETPOS,
BYHOUR, several BYMONTH, RSCALE, ordinal BYDAY in a weekly rule, an unknown part ...) is `custom`: shown as
"Custom rule (kept as is)" and never re-emitted. An untouched rule is never in a patch.

`UNTIL` follows the DTSTART value type (RFC 5545, section 3.3.10): a DATE for all-day, the end of the chosen day
(23:59:59 in the start's zone) as a UTC date-time for a zoned or UTC start, a local date-time for a floating
start. An UNTIL the user did not touch is re-emitted from its original text (many clients write the START of
the last occurrence; it is kept).

## Editing a series (D-R3-7)

`planEdit(item, {scope, occ, base, patch, exceptions})` returns data: `noop`, `ops`, `split`, or a refusal
(`{ok:false, code}`), or a question `{ok:false, needs:'exceptions', exceptions, orphans, defaultChoice}`.

* scope **this**: one `override` op; `rrule` is refused.
* scope **all**: the form's dates are translated to the master (calendar-day offset between the occurrence and the
  master; time of day and zone are the user's). A changed start adds `shiftExceptions` BEFORE the patch.
* scope **following**: a `split` plan (`splitWrite` in the store). Hidden for the first occurrence.
* `shiftExceptions(from, to)`: every EXDATE value and every override RECURRENCE-ID moves by the same wall-clock
  delta in the master's zone; a date-time UNTIL moves by the same delta (the occurrence count is unchanged),
  a DATE UNTIL by the calendar-day difference. Values written in UTC or in another TZID are converted through the
  instant, shifted in the master's zone and written back in their own form. An override whose DTSTART still equals its
  RECURRENCE-ID follows the series; one the user moved keeps its own DTSTART/DTEND. RDATE is not touched. It throws
  `SeriesError('start-mismatch')` when the master's DTSTART is not `fromStart` (someone else changed it: the store
  lists an unmappable row) and `SeriesError('allday-toggle-with-exceptions')` for all-day <-> timed with exceptions.
* The same rules apply to the tail of a split: `splitSeries(..., {tailPatch, exceptions})`.
* A rule change with exceptions, or a start change that orphans some (a start on a weekday not in BYDAY), returns the
  question. The dialog has no default to Keep when the orphan list is not empty. Answers: `keep`, `remove` (all),
  `remove-orphans`.
* An "all" change of title or description patches the master only: an override that carries its own text keeps it.
* Deleting: this = `deleteOccurrence`, following = `truncate` (one PUT, no tail), all = the item. A read-only series
  (unknown zone) offers only the whole delete.

## Ops (data, replayed on a fresh `openItem` of each attempt)

`patch`, `override`, `deleteOccurrence`, `removeExdate`, `removeOverride`, `truncate`, `shiftExceptions`, `complete`,
`reopen`. `applyOpsToItem(item, ops)` is the one implementation (`store/calops.js`; `scope.js` runs it with the event model); an op that cannot apply (the occurrence no longer
exists, the start moved, a read-only item) throws and the store shows an unmappable row.

## Birthdays

`birthdayOccurrences(contacts, {from, to, hideKeys})`: yearly all-day events; the age (occurrence year minus
birth year) only when the year is known; the day of birth itself is not a birthday. **A 29 February birthday falls
on 28 February in a year that is not a leap year.** The duplicate filter ("hide those already present in a real
calendar") matches the folded contact name as whole words inside the title of a yearly all-day event (FREQ=YEARLY)
on the same month and day; weekly or one-off events never match.

## Time zones we write (`tz.js`, WP B5)

`generateVtimezone(tzid, {fromYear, toYear})` builds a VTIMEZONE from `Intl` alone: it finds the offset transitions of the
window, groups them by kind, and writes a yearly `RRULE` (`BYDAY=-1SU`, `2SU`, or `BYDAY=SU;BYMONTHDAY=2..8`) only when one
rule reproduces every transition of a run of 4+ years and, for an open-ended rule, still matches Intl for 20+ years beyond the
window. Anything else is written as one `RDATE` line per onset. The result is re-expanded and compared with the transitions
found; a mismatch falls back to RDATEs. Onsets are written in the clock before the change (RFC 5545). No `X-` properties.

Wiring: `Item.save()` and `Item.splitSeries()` (and so `createItem`, `asCopy`, the split tail) pass `prepare: ensureVtimezones`
to the writer. A VTIMEZONE is added for every TZID the item references that has none AND was not referenced when the item was read
(new event, changed start or end zone, split tail). An existing VTIMEZONE is never modified or removed, even when wrong; an edit
that keeps its zones adds nothing; a no-op save sends nothing. Years: from the first event year -1 to the last one +10 (an
unbounded series counts 30 years). `item.tzAdded` / the split result's `tzAdded` list what was added:
`{tzid, form, openEnded, coveredThrough}`.

Limits (the app must show them where a zone is chosen): a zone whose `form` is `rdates` or `mixed` with `openEnded: false`
(Africa/Casablanca around Ramadan; Africa/Cairo, whose rule is "last Thursday at 24:00") is exact only up to `coveredThrough`;
after that the last offset stays in force when the item is read from its VTIMEZONE.
Times before `fromYear` get the offset of 1 January of that year.
The event form shows this limit where the zone is chosen: the persistent line `event-tz-limit` ("Clock changes in this zone are exact up
to {year}.") appears under the date and time fields when the start or end zone has `openEnded: false` (smallest `coveredThrough`
of the two). An existing VTIMEZONE is never regenerated when an item later reaches beyond its span (deferred, see below).

Run 4 candidates (deferred from Run 3):
- Show the instant from Intl for an IANA TZID whose served VTIMEZONE disagrees with it, with the quiet note described in the
  display rule below (today the embedded VTIMEZONE wins).
- Regenerate the VTIMEZONE of Africa/Casablanca and Africa/Cairo when a known TZID's span grows beyond the one already in the item
  (an existing VTIMEZONE is never touched today, so such an item silently keeps its last offset after `coveredThrough`).

Display rule recommended when a served VTIMEZONE disagrees with Intl for an IANA TZID (another client, or the server): show
the instant from Intl (other major clients identify the zone by its IANA name too, and the server-generated ones are known to
be wrong), keep the foreign VTIMEZONE untouched on save, and when the two differ for the event's own times show a quiet note
("time zone definition in this item differs from the system's; shown by the system's"). Only a TZID Intl does not know uses the
embedded VTIMEZONE (as today).

