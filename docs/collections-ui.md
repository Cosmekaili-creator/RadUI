<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Collections and import screens (`src/js/views/collections/`, `src/js/views/importdialog.js`)

The list of calendars and address books, the create and edit forms, the delete dialog and the `.vcf` import
dialog. Plain ES modules on top of `ui.js`, the widgets and the store context. Strings: `i18n/{en,fr}.collections.js`
(`coll.*`, `colour.*`) and `i18n/{en,fr}.import.js` (`import.*`). Styles: `css/collections.css` (design tokens only).
Tests: `node --test tests/unit-js/views` (`collections-*.test.mjs`, `import-*.test.mjs`).

## Screens and registry

| Screen name | Module | Export | Routes |
|---|---|---|---|
| `collections` | `views/collections/screen.js` | `mount` | `#/collections`, `#/collections?dialog=delete\|import&href=<collection href>` |
| `collection-form` | `views/collections/form.js` | `mount` | `#/collections/new-calendar`, `#/collections/new-addressbook`, `#/collections/edit?href=<collection href>` |

`mount(ctx)` follows the shell contract and returns `{title, update(ctx), dispose()}` (the form also `snapshot()`).
Everything is read through `ctx.app.getStore()` (the store context of the session) and written through its
`writes` (`mkcol`, `mkcalendar`, `proppatch`, `deleteCollection`). The collection screens do not need the data model
at mount time (`model` is not set in the registry); the import dialog loads it when it opens.

## List

Sections `collection-list-own` and `collection-list-shared` ("Shared with you"). A `collection-row` carries
`data-href`, `data-kind` (`calendar`, `addressbook`), `data-owner`, `data-level` (`own`, `readwrite`, `read`) and
`data-components` (lower case, comma separated: `vevent,vtodo`, `vcard`). It shows `collection-name`,
`collection-type` (Events, Tasks, Events + Tasks, Address book), `collection-count`, `collection-desc`, the badges
`coll-owner` and `coll-readonly`, `shared-with` and the `collection-tech` details (address, CTag, sync token).

- **Counts** are a Depth-1 ETag listing, two at a time, started after the list is drawn. While one runs the element has
  `aria-busy="true"`; when it is done `aria-busy="false"` and `data-count="<n>"` (a failed count has `data-state="error"`).
- **Shared with** is read-only text from `GET grants?owner=<login>` and only on own collections. There is no Share
  button in this release. When the grants cannot be read the element says so (`data-state="unavailable"`).
- **Actions** (accessible names carry the collection name): `btn-open-collection` (address books only, to
  `#/contacts?ab=<href>`), `btn-edit-collection` (owner), `btn-import` (address books and calendars, owner or read-write grantee),
  `btn-export` (any access), `btn-delete-collection` (owner). A read-only grantee sees Open (address books) and Export.
  Calendar rows have no Open button. Buttons that write are registered with the write gate (offline,
  read-only): they are disabled and their accessible name explains why.
- `btn-new-calendar`, `btn-new-addressbook` only when the account has its own space; otherwise `own-space-disabled`.
- States: `collections-empty`, `collections-error` (with `btn-retry`); `data-state` on `collections-screen` is
  `loading`, `ready` or `error`.
- The list is refreshed on entry, on window focus (at most every 10 s) and after its own writes; it is not polled.
- **Export** downloads through `downloadText` with the name from `exportFileName`. An address book export leaves the
  group cards out and says how many; an empty collection downloads nothing.

## Create and edit

`calendar-form` and `addressbook-form`: `field-coll-name` (required, at most 100 characters), `field-coll-desc`,
`field-color` (`colour-<id>` radios of the eight Okabe-Ito colours plus `field-color-custom` for `#RRGGBB`),
`field-components` (`component-vevent`, `component-vtodo`, at least one), `private-notice`, and under Advanced
`field-coll-slug` (the technical name). `collection-save`, `collection-cancel`.

- The technical name follows `^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$`, may not end with `~` and may not start with
  `radui-gen-` (the rules of the backend). It is made from the display name (NFD, ASCII, lower case, `-`) while the
  field is not edited; when that is empty it becomes `calendar-<6 hex>` (`addressbook-<6 hex>` for a book).
- Name collisions are checked against the access list before the request (display names among your own collections,
  technical names among your own collection addresses). A store answer `exists` (405/409) becomes a field error.
  `orphan-grants` and `grants-unchecked` answers stay in the form as text.
- Edit changes the display name, description and (calendars) colour; only changed properties are sent, and nothing at
  all when nothing changed. The components and the URL segment are fixed and the form says so.
- **No concurrency check on edit: the last writer wins.** The edit sends a PROPPATCH for the changed properties
  (name, description, colour) without a precondition, because WebDAV has no ETag on collection properties that
  Radicale honours. If two people edit the same collection, the later save silently replaces the other's change to
  the same property (different properties both survive). Contact and event items are different: they are
  protected by ETags and the conflict dialog.
- The unsaved-input guard is on (`app.setDirty`), the typed input survives a language switch (`snapshot()`), and
  Save is disabled while a request runs.

## Delete

`dialog-delete-collection` (the widgets' typed-confirm dialog): a fresh item count (`delete-count`), the grantees who
lose access (`delete-shared`), `btn-export-first` (address books: with the group cards), `field-confirm-name` and
`dialog-confirm-delete`, disabled until the typed text equals the display name (the technical name when there is no
display name or it holds invisible characters). The collection ETag read when the dialog opened is sent as
`expectedEtag`; a changed collection (412) re-opens the dialog with the new count (`delete-changed`). After the delete,
grants that could not be revoked are shown as a persistent alert.

## Import dialog

```
openImportDialog({ctx, collectionHref, kind}) -> Promise<{done: boolean, report?: object}>   (promise.dialog = controller)
```

The file field never shows the browser's own text: the native `<input type=file>` (`field-import-file`, class `input--file-native`)
is visually hidden but stays focusable and keeps its accessible name (`aria-labelledby` points at the field label); the visible
control is a `<label for>` styled as a button (`btn-choose-file`, "Choose a file" / "Choisir un fichier") followed by the translated
file name or "No file chosen" (`import-file-name`, also in `aria-describedby`). The focus ring is drawn on the button.

`collectionHref` presets the target and decides the kind (`calendar`: `.ics` import of events and tasks through
`planIcsImport`, texts with the `.cal` suffix, rows with `data-component`, notes for a dropped METHOD, a missing
VERSION/PRODID and an unknown time zone, and an `import-report-notes` block; `addressbook`: `.vcf`). `null`: the
person chooses among the writable collections of `kind` (default `addressbook`). A file of the other kind is refused in
text. `ctx` needs
`app.getStore()`, `t`, `tp`. Flow: choose the file (UTF-8 only; a non-UTF-8 file is refused and the likely encoding
is named), the target collection is read in full (`reload`), the plan is made
(`planImport`) and shown as `import-preview` (`import-row`, `data-state` `new`, `duplicate`, `invalid`,
`unsupported`, `file-duplicate`, with a text reason, possible-duplicate hints and warnings about data the server
would cut). `import-policy` (`policy-skip` default, `policy-replace`, `policy-keep`) appears when there are
duplicates; replacing a card the server would damage needs a ticked, listed `import-lossy-confirm`. `import-summary`
and `dialog-import-confirm` ("Import 15 items"); then `import-progress` (a progress bar) with `btn-import-cancel`, and
`import-report` with one `import-report-row` per card (`data-result`: `created`, `replaced`, `skipped`, `failed`).
The preview shows 100 rows first (`btn-import-more`).

## Registry lines

```js
collections: Object.freeze({ family: 'collections', module: './views/collections/screen.js', export: 'mount' }),
'collection-form': Object.freeze({ family: 'collections', module: './views/collections/form.js', export: 'mount' }),
```
