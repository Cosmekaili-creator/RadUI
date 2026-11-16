// SPDX-License-Identifier: AGPL-3.0-or-later
// English dictionary part: widgets (date and time fields, dialogs, repeatable rows, picker, progress).
// `{name}` marks a placeholder; the French part (fr.widgets.js) has exactly the same keys and placeholders.

export default Object.freeze({
  // dialogs
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Confirm',
  'dialog.ok': 'OK',
  'dialog.typed.label': 'Type the name to confirm',
  'dialog.typed.hint': 'Type {expected} exactly to confirm.',
  'dialog.typed.match': 'The name matches. You can confirm.',
  'dialog.typed.noMatch': 'The name does not match yet.',

  // date field
  'widget.date.letter.d': 'DD',
  'widget.date.letter.m': 'MM',
  'widget.date.letter.y': 'YYYY',
  'widget.date.hint': 'Type the date as {format}, for example {example}. The form YYYY-MM-DD also works.',
  'widget.date.hintYearless': 'Type the date as {format}, or as {formatShort} without the year, for example {example}. The form YYYY-MM-DD also works.',
  'widget.date.pick': 'Pick date',
  'widget.date.pickFor': 'Pick date for {label}',
  'widget.date.err.required': 'Enter a date.',
  'widget.date.err.format': 'This is not a valid date. Use {format}, for example {example}.',
  'widget.date.err.year': 'Add the year, for example {example}.',
  'widget.date.err.month': 'The month must be between 1 and 12.',
  'widget.date.err.day': 'Day {day} does not exist in that month.',
  'widget.date.err.min': 'The date must be {min} or later.',
  'widget.date.err.max': 'The date must be {max} or earlier.',
  'widget.date.picker.title': 'Choose a date: {label}',
  'widget.date.picker.titlePlain': 'Choose a date',
  'widget.date.picker.month': 'Month',
  'widget.date.picker.year': 'Year',
  'widget.date.picker.prevMonth': 'Previous month',
  'widget.date.picker.nextMonth': 'Next month',
  'widget.date.picker.today': 'Today',
  'widget.date.picker.clear': 'Clear date',
  'widget.date.picker.grid': 'Calendar, {month}',
  'widget.date.picker.unavailable': '{date} (not available)',
  'widget.date.picker.keys': 'Arrow keys move by day or week. Page Up and Page Down change the month (with Shift, the year). Home and End go to the start and end of the week. Enter chooses the day.',

  // time field
  'widget.time.format24': 'HH:MM',
  'widget.time.format12': 'h:mm AM/PM',
  'widget.time.hint24': 'Type the time as {format} on the 24-hour clock, for example {example}.',
  'widget.time.hint12': 'Type the time as {format}, for example {example}.',
  'widget.time.err.required': 'Enter a time.',
  'widget.time.err.format': 'This is not a valid time. Use {format}, for example {example}.',
  'widget.time.err.hour': 'The hour must be between 0 and 23 (1 to 12 with AM or PM).',
  'widget.time.err.minute': 'The minutes must be between 00 and 59.',
  'widget.time.err.min': 'The time must be {min} or later.',
  'widget.time.err.max': 'The time must be {max} or earlier.',

  // repeatable rows
  'widget.rep.type': 'Type',
  'widget.rep.custom': 'Custom label',
  'widget.rep.preferred': 'Preferred',
  'widget.rep.clearPref': 'Clear the preferred choice',
  'widget.rep.prefCleared': 'No entry is marked as preferred.',
  'widget.rep.more': 'More fields',
  'widget.rep.remove': 'Remove',
  'widget.rep.added': '{row} added.',
  'widget.rep.removed': '{row} removed.',
  'widget.rep.max': 'You can add at most {max} entries here.',

  // picker
  'widget.picker.search': 'Search',
  'widget.picker.hint': 'Type to filter. Use the Up and Down keys, then Enter to choose.',
  'widget.picker.hintMulti': 'Type to filter. Use the Up and Down keys, then Enter to tick or untick an entry.',
  'widget.picker.count.one': '{n} result',
  'widget.picker.count.other': '{n} results',
  'widget.picker.none': 'No results.',
  'widget.picker.truncated': '{n} results. Showing the first {shown}; type more to narrow the list.',
  'widget.picker.selected.one': '{n} selected',
  'widget.picker.selected.other': '{n} selected',
  'widget.picker.confirm': 'Done',

  // progress
  'widget.progress.counts': '{done} of {total} ({percent}%)',
  'widget.progress.working': 'Working…',
  'widget.progress.cancel': 'Cancel',
  'widget.progress.cancelling': 'Cancelling after the requests in progress…',
  'widget.progress.cancelled': 'Cancelled.',
  'widget.progress.done': 'Done.',
  'widget.progress.failed': 'It did not finish.',
});
