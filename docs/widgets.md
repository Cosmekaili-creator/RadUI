<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Shared widgets (`src/js/widgets/`)

Plain ES modules on top of `ui.js` (`h`, `openDialog`, `vars`, `setDataImage`, `writeGate`). Each widget keeps
its logic DOM-free (unit-tested in Node) and renders with `h()` only: no raw HTML, no `style` attribute, no inline
handler. Strings come from `i18n/{en,fr}.widgets.js` (keys `widget.*` and `dialog.*`); every widget takes the app
translator `t` (and `tp` where plurals are used) from its caller. Styles: `css/widgets.css` (design tokens only).

Tests: `node --test tests/unit-js/widgets` (a small fake DOM lives in `tests/unit-js/widgets/_dom.mjs`).

## Date and time fields

`datefield.js`
- Logic: `parseDate(text, {pattern, yearOptional, required, min, max})`, `formatDate(v, pattern)`,
  `localeDatePattern(lang)` (order and separator from `Intl.DateTimeFormat(lang).formatToParts`), `dateHint`,
  `fromISO`/`toISO`, `normalizeYMD`, `isValidYMD`, `compareYMD`, `addDays`, `addMonths`, `navigateDate`, `monthGrid`,
  `weekdayNames`, `monthNames`, `todayYMD(now, timeZone)`, `dateErrorMessage`, `dateHintText`.
- Values: `{y, m, d}` (`y` is `null` without a year) and the ISO string (`YYYY-MM-DD`, or `--MM-DD` without a year).
- Parse result: `{ok:true, empty, value, iso, yearless}` or `{ok:false, error, detail}` with `error` one of
  `required format year month day min max`.
- Accepted input: the locale order with `/ . - ,` or a space; ISO `YYYY-MM-DD` and `YYYYMMDD` always (any text that starts
  with a 4-digit year reads year-month-day); with `yearOptional` also `DD/MM` in locale order, `--MM-DD`, `--MMDD`.
  Real calendar dates only (leap years), a 4-digit year, min and max inclusive (ignored without a year).
- `createDateField({testid, label, t, lang, value, yearOptional, required, min, max, picker, clearable, errorRegion,
  firstWeekday, onChange, onInput})` returns `{el, input, pickerButton, value, iso, parse(), validate(), setValue(v),
  setError(msg), focus(), openPicker()}`. The text is normalised to the locale form on `change`; the error line is
  persistent text linked by `aria-describedby` and goes away when the text becomes valid. `Alt+Down` opens the picker.
- `openDatePicker({t, lang, label, testid, value, min, max, firstWeekday, clearable, now})` resolves
  `{value: {y,m,d}|null}` (`null` = cleared) or `null` when cancelled.
- Test ids: wrapper `<testid>`, `<testid>-input`, `<testid>-picker` (button), `<testid>-hint`, `<testid>-error`; picker
  dialog `<testid>-picker-dialog` with `-picker-grid`, `-picker-day` (`data-date`), `-picker-month`, `-picker-year`,
  `-picker-prev`, `-picker-next`, `-picker-today`, `-picker-clear`, `-picker-month-label` (live), `dialog-cancel`.
- Picker keys: arrows (day, week), Page Up/Down (month; Shift: year), Home/End (start/end of the week), Enter or
  Space chooses, Esc cancels. Today and Clear are buttons; month and year are a select and a number field.

`timefield.js`: `parseTime(text, {lang, required, min, max})`, `formatTime(v, {use24h, lang})`, `timeToISO`,
`timeFromISO`, `normalizeHM`, `timeErrorMessage`, `timeHintText`, `createTimeField({testid, label, t, lang, use24h,
value, required, min, max, errorRegion, onChange, onInput})` (same members as the date field, without a picker).
Values `{h, mi}` and `HH:MM`. Accepts `14:30`, `0930`, `9.30`, `9h30`, `9`, `2:30 PM` (also the language's markers) and
ISO `HH:MM[:00]`; a time without a marker is read on the 24-hour clock. Test ids `<testid>`, `-input`, `-hint`, `-error`.

## Dialogs (`dialogs.js`)

All return a Promise; the controller of the opened dialog is on `promise.dialog`. Built on `openDialog` by composition.
- `confirmDialog({title, message, confirmLabel, cancelLabel, danger, focus, body, write, testid, confirmTestid,
  cancelTestid, t})` resolves `true` only for the confirm button (Esc, Cancel, anything else: `false`). `danger`
  focuses Cancel. Defaults: dialog `dialog-confirmation`, buttons `dialog-confirm` and `dialog-cancel`.
- `typedConfirmDialog({title, message, expected, label, confirmLabel, cancelLabel, body, write, testid, inputTestid,
  confirmTestid, t})`: confirm is disabled until the input equals `expected` (NFC, no trimming, case-sensitive); the
  input has the focus; Enter confirms only on a match; a `role=status` line (`<testid>-match`) says whether it matches.
  Defaults: `dialog-typed-confirm`, `field-confirm-name`, `dialog-confirm`. `matchesTyped(input, expected)` is exported.
- `oneTimeDialog({title, message, body, confirmLabel, ackLabel, testid, confirmTestid, ackTestid, t})`: non-dismissible
  (SPECS 10b-4); with `ackLabel` the confirm stays disabled until the box is ticked. Defaults: `dialog-once`,
  `dialog-once-confirm`, `dialog-once-ack`. `hasBlockingDialog` and `guardDialog` are re-exported from `ui.js`.

## Avatar and names (`avatar.js`)

`createAvatar({name, uid, size: 'sm'|'md'|'lg'|'xl', photo: {mime, base64}, decorative, noNameLabel, testid})`:
initials, colour class `avatar--c0..c7` from `hashString(uid || name)`, photo through `setDataImage` with fall-back to
initials (refused photo, or an `error` event). `data-photo="true|false"`. Decorative avatars are `aria-hidden`; otherwise
`role="img"` named after the person. Also `initialsOf`, `hashString`, `toneIndex`, `toneClass`, `bdiName(name)` (a
`<bdi>` element) and `isolate(name)` (FSI/PDI for plain strings) for names in rows and accessible names (m6).

## Repeatable rows (`repeatable.js`)

- Model (DOM-free): `createRowsModel({kind, rows, blank, defaultType, max})` with `rows`, `addRow`, `removeRow`,
  `update`, `markChanged`, `setPreferred`, `clearPreferred`, `removed`, `dirty`, `snapshot`. Each row has `key`, `orig`
  (the caller's handle, untouched; `null` for new rows), `type`, `custom`, `pref`, `values`, and derived `changed`,
  `typeChanged`, `prefChanged`, `changedFields`.
- Rendering: `createRepeatable({kind, t, labels: {legend, row, add, remove}, types, customValue, fields, rows, blank,
  defaultType, preferred, max, announce, onChange})` returns `{el, model, addRow, removeRow, refresh, setError,
  clearErrors, focusField, focusAdd}`. Labels carry `{n}`: `'Phone {n}'`, `'Remove phone {n}'`.
- Test ids (k = kind): `<k>-row` (`data-key`, `data-new`), `field-<k>-type`, `field-<k>-custom`, `field-<k>-pref`,
  value fields `field-<k>` (one field) or `field-<k>-<name>`, `btn-add-<k>`, `btn-remove-<k>`, `btn-clear-pref-<k>`,
  `<k>-more`, `<k>-max`. After add the first field of the new row gets the focus; after remove the row that took its
  place (else the previous one, else Add). `announce(text)` receives 'Phone 3 added.' / 'Phone 2 removed.'.

## Picker (`picker.js`, `fold.js`)

- `foldText`, `foldTokens`, `matchesTokens` (NFD, marks stripped, lower case, oe/ae/ss, apostrophes folded).
- `searchOptions(options, query, {limit})` -> `{items (at most 50), total, truncated}`, `buildIndex`, `createPickerState`.
- `openPicker({name, title, description, searchLabel, options: [{id, label, sublabel, keywords, disabled}], multiple,
  selected, confirmLabel, write, t, tp, debounceMs, announceMs, timers})` resolves the chosen ids (one in single mode) or
  `null`. Test ids (x = name): `<x>-picker`, `field-<x>-search`, `<x>-list`, `<x>-option` (`data-id`),
  `<x>-result-count` (polite live), `<x>-selected-count`, `<x>-picker-confirm` (multi), `dialog-cancel`.
- Keys in the search field: Up/Down, Page Up/Down, Enter (choose, or tick/untick in multi mode), Esc. List refresh is
  debounced (120 ms), the live count is throttled (500 ms).

## Progress (`progress.js`)

`createProgress({name, label, t, value, max, cancelable, onCancel, cancelLabel, format, announceMs})` returns `{el, set,
complete, fail, markCancelled, state, dispose}`. The bar (`<x>-progress`) is a `role=progressbar` with `aria-valuenow`
(omitted when the total is unknown) and `aria-valuetext`; visible text `<x>-progress-text`; a visually hidden polite
status `<x>-progress-status` updated at most every 2 s (final states at once); wrapper `<x>-progress-box`
(`data-state` running, cancelling, cancelled, done, error); cancel button `btn-<x>-cancel`. The fill width is the CSS
variable `--progress` set through `vars()`.

## Shared helpers

`fieldkit.js` (`uniqueId`, `fill`, `buildField`), `timing.js` (`debounce`, `createAnnouncer`).
