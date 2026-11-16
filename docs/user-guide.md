<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# User guide

RadUI is a web interface for your calendars and address books, which are stored on a Radicale server.
This guide covers what the app can do today: **contacts, contact groups and collections** (your
address books and calendars). Calendar and task screens and account administration screens are not
part of this version yet; the calendar and task data on the server are not affected by that.

The app follows your browser language (English or French); the language can be switched in the app.
Everything in it can be used with the keyboard.

## Signing in and accounts

Sign in with the login and password of your account. Accounts are created, disabled and given access
by an **administrator** of the server (there is no self-registration and no password recovery by
e-mail: ask your administrator). Depending on how your account was set up you either have your own
space, where you can create address books and calendars, or you only see collections that someone
shared with you. Sharing is also set up by an administrator; the app shows who a collection is shared
with, but does not change it. Sign out when you use a shared device; the app then forgets everything it
loaded. **If your session expires** (for example the administrator disabled the account, or the password
changed), the app takes you back to the sign-in page and **anything you had typed in an open form and not
saved is discarded**; after signing in again, start the entry again. Save longer edits as you go.

## Contacts

Open **Contacts**. The list shows your address book (with several books, a selector appears at the top).

* **Find.** Type in the search box; pick a letter in the A-Z bar to jump; filter by group. Long lists
  load in steps ("Show more").
* **Read.** Select a contact to see its details: phone numbers, e-mail addresses, addresses, web
  addresses, birthday, notes, categories and groups. Phone and e-mail entries are links your device can
  act on.
* **Add and edit.** Use **New contact** or **Edit**. One form is used for both. Fields you do not touch
  are written back exactly as they were, including data this app has no field for (the app edits the
  fields it knows and leaves the rest of the card alone). A photo can be added or removed; very large
  pictures are refused with a reason. If you did not change anything, nothing is sent.
* **Delete.** Deleting asks you to confirm and names the groups the contact would leave.
* **Duplicates.** While you type a new name the form hints at a contact with the same name; it does
  not block saving.
* **Read-only access.** If a book was shared with you read-only, you can look and export, not change.
* Some cards cannot be edited safely (for example a very old vCard 2.1 card, or a card that the server
  could not store without losing data). They are shown read-only with the reason.

### Groups

**Groups** lists your contact groups. A group is a special card that lists its members. Create a group,
rename it, add members from a picker, remove members, or delete the group (the contacts stay). Group
cards never appear in the contact list. A contact without an identifier (UID) cannot be added to a
group; the app tells you so.

## Import and export

* **Import contacts** (`.vcf`, vCard files in UTF-8) is on the contacts page and in the collections
  list. The app reads the file, shows a **preview** (new, duplicate, invalid, unsupported cards, each
  with the reason) and asks before it changes anything. For duplicates you choose to skip them (default),
  replace the existing ones or keep both. A card the server would damage on write is listed and needs
  your explicit confirmation. A progress bar and a **report** per card follow; you can cancel while it runs.
  Files in another encoding are refused with a hint about the likely encoding. `.ics` import is not part
  of this version.
* **Export** an address book (everything, group cards left out) or a single contact as `.vcf`, and a
  calendar as `.ics`. Export works with read-only access.

## Collections

**Collections** lists your own address books and calendars and the ones shared with you, with item
counts. You can create an address book or a calendar (name, description, colour, whether it holds events
and/or tasks), change its name, description and colour, export it, and delete it. Deleting needs you to type the
collection's name, shows how many items it holds and who loses access, offers an export first, and
cannot be undone. A new collection is private until an administrator shares it.

## Language and About

**Settings** lets you switch between English and French; the choice is kept on this device and nothing is
sent to the server. Only the language you use is downloaded, so the first switch takes a moment (the app
shows it is busy); if it cannot be loaded, the current language stays. The **About** section at the bottom
shows the version, the licence (AGPL-3.0-or-later) and a link to the source code of this service, or a note
that your administrator has it. A build made directly from the source shows "development build" as its version.

## When two people change the same item

If someone else saved the same contact after you opened it, the save is refused rather than overwriting
their work, and a dialog shows the fields side by side (yours, theirs). You can:

* **Reload theirs**, dropping your edits;
* **Overwrite with mine**, which re-applies only the changes **you** made on top of their version. Any
  change that cannot be applied automatically is listed first and needs your confirmation;
* **Save mine as a copy**, which creates a new contact (not available for groups);
* **Cancel**, keeping the form as it is.

The same dialog appears when an item was deleted elsewhere (save a copy, or discard) and when you try to
delete something that has changed. Nothing is ever overwritten silently.

## Offline and installing the app

The app can be installed on your phone or computer (the browser offers "Install" or "Add to Home
Screen"). After the first visit it starts without a network connection. **Offline, the app is read-only:**
the application opens, but contacts and collections are not stored on the device, so there is nothing to
show except what was already on the screen, and every button that changes data is disabled with the reason.
When the connection returns the buttons come back.

When a new version of the app is available a banner offers to reload; if you have unsaved edits it asks
first. Until you reload, the page keeps running the old version, and if another tab already updated,
saving is paused with "Reload to continue".

## Privacy

The app talks only to your own server. It sends no analytics and loads nothing from other sites. Your
data stays on the server; the device keeps only the app's files.
