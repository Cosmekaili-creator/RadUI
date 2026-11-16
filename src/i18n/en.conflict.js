// SPDX-License-Identifier: AGPL-3.0-or-later
// English dictionary part: conflict (the dialogs shown when the server answered "changed elsewhere" or
// "deleted elsewhere"). `{name}` marks a placeholder; fr.conflict.js has exactly the same keys and placeholders.

export default Object.freeze({
  // edit conflict (412 on save)
  'conflict.title': 'This item was changed elsewhere',
  'conflict.text': '“{name}” was changed on the server after you opened it (another device or another account). Your version is not saved yet.',
  'conflict.textUnnamed': 'This item was changed on the server after you opened it (another device or another account). Your version is not saved yet.',
  'conflict.caption': 'Differences between your version and the version on the server',
  'conflict.col.field': 'Field',
  'conflict.col.mine': 'Yours',
  'conflict.col.theirs': 'Theirs',
  'conflict.empty': '(empty)',
  'conflict.both': 'Changed on both sides',
  'conflict.status.identical': "Already identical on the server: nothing to save.",
  'conflict.photo.changed': 'changed',
  'conflict.photo.unchanged': 'unchanged',
  'conflict.noRows': 'No difference in the fields this app edits could be shown. The version on the server has changed in some other way.',
  'conflict.help': 'Reload theirs discards your changes. Overwrite with mine applies your changes on top of their version and keeps their other changes. Save mine as a copy keeps both versions.',

  // fields (row labels)
  'conflict.field.fn': 'Display name',
  'conflict.field.n': 'Name',
  'conflict.field.nickname': 'Nickname',
  'conflict.field.org': 'Organisation',
  'conflict.field.title': 'Job title',
  'conflict.field.tel': 'Phone',
  'conflict.field.email': 'E-mail',
  'conflict.field.adr': 'Address',
  'conflict.field.url': 'Web address',
  'conflict.field.bday': 'Birthday',
  'conflict.field.anniversary': 'Anniversary',
  'conflict.field.note': 'Note',
  'conflict.field.categories': 'Categories',
  'conflict.field.photo': 'Photo',
  'conflict.field.kind': 'Kind',
  'conflict.field.members': 'Members',

  // buttons
  'conflict.reload': 'Reload theirs',
  'conflict.overwrite': 'Overwrite with mine',
  'conflict.copy': 'Save mine as a copy',
  'conflict.cancel': 'Cancel',
  'conflict.overwriteDisabled': 'Overwriting is not possible: the version on the server cannot be edited by this app.',
  'conflict.copyDisabled.group': 'A group cannot be saved as a copy.',
  'conflict.copyDisabled.other': 'Saving a copy is not possible for this item.',

  // changes that cannot be applied automatically
  'conflict.unmappable.title': 'These changes cannot be applied automatically:',
  'conflict.unmappable.modify': '{field}: your change to “{base}” (now “{mine}”)',
  'conflict.unmappable.remove': '{field}: your removal of “{base}”',
  'conflict.unmappable.explain': 'The matching entry no longer exists in their version, so these changes are left out if you overwrite.',
  'conflict.unmappable.confirm': 'I understand that these changes will be left out.',

  'conflict.nickname.confirm': 'The server keeps only the first nickname of a list. I accept losing: {values}.',

  // where mine won without being asked
  'conflict.notes.title': 'Where your version won:',
  'conflict.note.both-edited': '{field}: both of you edited {parts}; your version won.',
  'conflict.note.theirs-removed': '{field}: they removed it while you edited {parts}; your version was kept.',
  'conflict.note.pref-moved': '{field}: you marked another entry as preferred, so their preferred mark on “{row}” was removed.',
  'conflict.note.generic': '{field}: your version won.',
  'conflict.part.any': 'some parts',
  'conflict.part.value': 'the value',
  'conflict.part.types': 'the types',
  'conflict.part.name': 'the name',
  'conflict.part.units': 'the units',
  'conflict.part.family': 'the family name',
  'conflict.part.given': 'the given name',
  'conflict.part.additional': 'the additional names',
  'conflict.part.prefix': 'the prefix',
  'conflict.part.suffix': 'the suffix',

  // progress, outcomes
  'conflict.working': 'Working…',
  'conflict.again': 'The item changed again before your choice could be saved. Review the new differences.',
  'conflict.err.generic': 'The action did not complete ({status}). Check the item before trying again.',
  'conflict.cancelled': 'Conflict left unresolved: nothing was saved.',

  // deleted elsewhere
  'conflict.deleted.title': 'This item was deleted elsewhere',
  'conflict.deleted.text': '“{name}” was deleted on the server after you opened it. Your version is not saved.',
  'conflict.deleted.textUnnamed': 'This item was deleted on the server after you opened it. Your version is not saved.',
  'conflict.deleted.help': 'Save mine as a copy creates a new item with your version. Discard my changes drops them.',
  'conflict.deleted.discard': 'Discard my changes',

  // changed elsewhere before a delete
  'conflict.changed.text': '“{name}” was changed on the server after you opened it, so it was not deleted.',
  'conflict.changed.textUnnamed': 'This item was changed on the server after you opened it, so it was not deleted.',
  'conflict.changed.help': 'Show their version lets you look at what changed. Delete anyway removes the item together with their changes.',
  'conflict.changed.show': 'Show their version',
  'conflict.changed.deleteAnyway': 'Delete anyway',

  // events and tasks (RUN3): field labels of the difference table, operations that cannot be replayed
  'conflict.field.summary': 'Title',
  'conflict.field.description': 'Description',
  'conflict.field.location': 'Location',
  'conflict.field.start': 'Start',
  'conflict.field.end': 'End',
  'conflict.field.due': 'Due',
  'conflict.field.rrule': 'Repeat rule',
  'conflict.field.exdates': 'Deleted occurrences',
  'conflict.field.overrides': 'Changed occurrences',
  'conflict.field.status': 'Status',
  'conflict.field.transp': 'Shown as',
  'conflict.field.alarms': 'Reminders',
  'conflict.field.priority': 'Priority',
  'conflict.field.percent': 'Percent complete',
  'conflict.occurrence': '{field} (occurrence of {when})',
  'conflict.overwriteDisabled.ops': 'Overwriting is not possible: your change cannot be applied to their version (see the list above).',
  'conflict.unmappable.replay': '{field}: {reason}',
  'conflict.replay.start-mismatch': 'the start of the series was changed elsewhere, so the occurrences you changed cannot be mapped',
  'conflict.replay.allday-toggle-with-exceptions': 'their version has deleted or changed occurrences, which cannot be converted between all-day and timed',
  'conflict.replay.unknown-zone': 'their version uses a time zone this app does not know',
  'conflict.replay.no-master': 'their version has no main event',
  'conflict.replay.error': 'this change no longer applies to their version',
});
