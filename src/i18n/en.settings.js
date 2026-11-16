// SPDX-License-Identifier: AGPL-3.0-or-later
// English dictionary, settings part: the Settings screen (`#/settings`). The French part (fr.settings.js)
// must have exactly the same keys and placeholders. WP B3b adds the calendar preferences section keys
// (settings.cal.*) to this file.

export default Object.freeze({
  'settings.title': 'Settings',
  'settings.status': 'Signed in as {login}. Your preferences are kept in this browser, separately for each account.',
  'settings.status.admin': 'Signed in as {login} (administrator). Your preferences are kept in this browser, separately for each account.',

  // account
  'settings.account.title': 'Your account',
  'settings.account.login': 'Login',
  'settings.account.name': 'Display name',
  'settings.account.type': 'Type',
  'settings.account.admin': 'Administrator',
  'settings.account.loading': 'Loading your account details…',
  'settings.account.unavailable': 'Your account details are unavailable because the account service did not answer.',

  // own password
  'settings.password.title': 'Password',
  'settings.password.intro': 'Choose a new password for your own account. You stay signed in on this device.',
  'settings.password.new': 'New password',
  'settings.password.repeat': 'Repeat the new password',
  'settings.password.hint': 'At most 72 bytes (most characters count as one; accented letters and symbols count as two or more).',
  'settings.password.save': 'Change password',
  'settings.password.saving': 'Changing the password…',
  'settings.password.generate': 'Generate a password instead',
  'settings.password.adminOnly': 'Ask an administrator to reset your password.',
  'settings.password.err.required': 'Enter the new password.',
  'settings.password.err.repeatRequired': 'Type the new password a second time.',
  'settings.password.err.mismatch': 'The two passwords are not the same.',
  'settings.password.err.tooLong': 'This password is longer than 72 bytes. Choose a shorter one.',
  'settings.password.err.rejected': 'The server did not accept this password. Nothing was changed.',
  'settings.password.err.forbidden': 'You are not allowed to change this password.',
  'settings.password.err.rateLimited': 'Too many attempts. Wait a moment, then try again.',
  'settings.password.err.network': 'The server could not be reached. Nothing was changed.',
  'settings.password.err.generic': 'The password could not be changed. Nothing was changed.',
  'settings.password.done': 'Your password was changed. This device keeps you signed in with the new one.',
  'settings.password.pending': 'Saved; the server is still applying it. This device keeps you signed in with the new password.',
  'settings.password.once.title': 'Your new password',
  'settings.password.once.text': 'This password is shown only once. Store it in a password manager now: it cannot be shown again.',
  'settings.password.once.label': 'New password',
  'settings.password.once.ack': 'I have saved the new password',
  'settings.password.once.copy': 'Copy password',
  'settings.password.once.copied': 'Copied.',
  'settings.password.once.copyFailed': 'The password could not be copied. Select it and copy it by hand.',
  'settings.password.once.confirm': 'Done',

  // language
  'settings.language.title': 'Language',
  'settings.language.en': 'English',
  'settings.language.fr': 'Français',
  'settings.language.saved': 'Language changed.',

  // about
  'settings.about.title': 'About',
  'settings.about.app': 'Application',
  'settings.about.appName': 'RadUI',
  'settings.about.version': 'Version',
  'settings.about.versionLoading': 'Loading…',
  'settings.about.versionDev': 'development build',
  'settings.about.licence': 'Licence',
  'settings.about.licenceName': 'AGPL-3.0-or-later',
  'settings.about.source': 'Source code',
  'settings.about.sourceNone': 'The source code of this service is available from its administrator.',
  'settings.about.sourceIntro': 'The complete source code of this version is available at:',

  // this device
  'settings.device.title': 'This device',
  'settings.device.text': 'Signing out and forgetting this device removes your sign-in and your saved preferences for this account from this browser. Nothing on the server changes.',
  'settings.device.forget': 'Sign out and forget this device',
  'settings.device.diagnostics': 'Open diagnostics',

  // calendar preferences (WP B3b; views/settings/calendar.js)
  'settings.cal.title': 'Calendar',
  'settings.cal.explain': 'These choices stay in this browser, separately for each account. The display time zone only changes how times are drawn: events keep their own zones and nothing is written to the server.',
  'settings.cal.tz': 'Display time zone',
  'settings.cal.tzHint': 'Calendar times are shown in this zone.',
  'settings.cal.tzLoading': 'Loading the time zones…',
  'settings.cal.tzFailed': 'The time zone list could not be loaded.',
  'settings.cal.firstWeekday': 'First day of the week',
  'settings.cal.firstWeekday.auto': 'Follow the language',
  'settings.cal.clock': 'Clock',
  'settings.cal.clock.auto': 'Follow the language',
  'settings.cal.clock.24': '24-hour',
  'settings.cal.clock.12': '12-hour (AM/PM)',
  'settings.cal.birthdays': 'Show birthdays',
  'settings.cal.birthdaysHint': 'A read-only calendar built from the birth dates in your address books.',
  'settings.cal.hideDup': 'Hide birthdays that are already in a calendar',
  'settings.cal.hideDupHint': 'Skips a birthday when a yearly all-day event with the same name and date exists.',
  'settings.cal.saved': '{what}: saved on this device.',
});
