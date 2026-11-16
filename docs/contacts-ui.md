<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Contact screens (`src/js/views/contacts/`)

The contacts list and detail, the contact form and the groups screens. They draw what `contacts/` (the DOM-free
logic) and `store/` (the write path) provide; nothing here parses a card by hand or calls a DAV write method.
Styles: `css/contacts.css`. Strings: `i18n/{en,fr}.contacts.js` and `i18n/{en,fr}.groups.js`.
Tests: `node --test tests/unit-js/views` (`contacts-*.test.mjs`; a real write path over an in-memory DAV server and the
fake DOM of `tests/unit-js/widgets/_dom.mjs`).

## Files

| File | Role |
|---|---|
| `screen.js` | `#/contacts` and `#/contacts/<key>`: list pane plus detail pane, search, group filter, windowing, A-Z, delete, export, add to group, import and export buttons. Exports `mount(ctx, deps?)`. |
| `list.js`, `detail.js` | Rendering of the two panes (a model goes in, DOM comes out). |
| `form.js`, `formfields.js` | `#/contacts/new` and `#/contacts/<key>/edit`: one form for both; field builders (text, chips, photo block). |
| `groups.js` | `#/contacts/groups` and `#/contacts/groups/<key>`. |
| `bookdata.js` | Which book is open (`pickBook`), the summaries of its cards (cached on the session container), group data, store change events. |
| `common.js`, `links.js` | Injectable dependencies, hashes, labels, formatting; the link allowlists. |

`mount(ctx)` answers at once; the data loads behind it. The shell's readiness stays `loading` until then, and the screen
root carries `data-state="loading|ready|error"`. Background syncs only set `aria-busy` on `contact-list` and
`data-sync="idle|running|error"` on the root. `mount(ctx, deps)` takes optional dependencies (`processPhoto`,
`photoApi`, `downloadText`, `openConflictDialog`, `loadImportDialog`, `now`, `timers`, `isOnline`, `yieldFn`) so tests
run without a browser.

## `ctx.app.getStore()`

`async () => storeContext`: loads `store/index.js` and the data model on the first call and creates ONE
`createStoreContext(...)` per login session; it is cached in `session.data` and disposed with the session. Concurrent
callers share one promise, a failed start is not cached, and `getStore.setTranslator(t)` is called on a language change.
Implemented by `createStoreGetter` in `js/app.js`. The context offers `access`, `stores`, `scheduler`, `writes`,
`exportCollection`, `exportItem`, `startImport`.

## Rules

- **Address book.** `pickBook`: `ab` must equal the href of a discovered address book, else a "not found" state;
  without it the last book used by this login, else the first own book, else the first grant. A book selector appears
  only with several books; links then carry `ab`. An own book is writable only when the account has an own space.
- **List.** Group cards are never listed, counted, searched or offered. Sort and letters come from `contacts/index.js`.
  250 rows per window with "Show N more (M not shown)"; an A-Z button sets `from=<letter>`; "Show earlier" reveals the
  rows before the window. Search is debounced into the URL (`q`); the count status is throttled while typing. Rows show
  initials only; photos appear in the detail only, after `canDisplayPhoto`, through `ui.setDataImage`.
- **Detail.** Phone links are `tel:` with digits and `+`; e-mail links only for a plain address (encoded, no `?` or `&`);
  web links only for http and https without credentials (`rel="noopener noreferrer"`, `target="_blank"`); anything else is
  text. Names are wrapped in `<bdi>`. An item that does not open (parse error, vCard 2.1, ...) or that the fidelity guard
  refused is read-only: the reason and a raw view (PHOTO payloads abbreviated) are shown; delete and export stay.
- **Form.** `{text, etag}` is kept from the moment the form opens; every save passes `base` and `baseFields` and a patch
  built by `formmodel.toPatch`; no change means no request ("No changes to save"). Address street and extended parts and the
  note are textareas. Validation messages sit next to the fields (`aria-describedby`) with a summary of links. Save is disabled
  while a request runs. A conflict with nothing different is "already saved"; a real conflict opens the conflict dialog. A
  multi-value nickname is warned about before saving. After an unknown result a new contact is retried only with the
  result's `retry` token (the fields lock meanwhile). Categories are chips. A text-valued birthday is read-only until
  "Replace"; the anniversary is read-only with a note on vCard 3.0. Unsaved input is flagged through `app.setDirty`; a language
  switch keeps typed input, added rows and the opened base (`snapshot()` / `ctx.restore`).
- **Delete.** A named dialog (`dialog-delete-contact`, Cancel focused) with the groups the contact leaves; the shown ETag
  is passed; a card changed elsewhere opens the conflict dialog ("Delete anyway" is its choice).
- **Groups.** Membership is only ever edited on the group card: one `putGroupMembers` PUT per change, member cards are never
  written; unresolved members are shown as unknown and kept. A contact without a UID is refused with a text reason.
- **Read-only, offline.** A read-only grantee sees no edit, delete, import or group write; "New contact" stays visible with
  `aria-disabled` and a description. Offline, write controls are disabled by the write gate and say why in their name.

## Test ids

List: `contacts-screen`, `contacts-pane`, `contacts-book`, `contacts-search`, `contacts-group`, `contacts-count`, `contact-list`,
`contact-row` (`data-uid`, `data-href`, `data-letter`, `data-readonly`), `az-index`, `az-<L>`, `az-hash`, `btn-new-contact`,
`btn-import-vcf`, `btn-export-book`, `btn-groups`, `btn-show-more`, `btn-show-earlier`; states `contacts-empty`, `contacts-nobook`,
`contacts-noaccess`, `contacts-readonly`, `contacts-no-match`, `contacts-error`, `contacts-offline`, `contacts-notfound`,
`contacts-loading`, `btn-retry`.

Detail: `contact-detail` (`data-uid`, `data-href`), `contact-avatar`, `contact-name`, `contact-nickname`, `contact-org`,
`btn-edit-contact`, `btn-delete-contact`, `btn-export-contact`, `contact-phone`, `contact-email`, `contact-address`, `contact-url`,
`contact-birthday`, `contact-anniversary`, `contact-note`, `contact-categories`, `contact-groups`, `btn-add-to-group`,
`contact-meta`, `contact-readonly-reason`, `contact-raw`, `contact-notfound`, `btn-back`, `photo-note`; dialogs `dialog-delete-contact`
(`dialog-confirm-delete`, `dialog-cancel`, `delete-groups-note`), `group-picker`.

Form: `contact-form`, `contact-form-screen`, `field-fn|prefix|given|additional|family|suffix|nickname|org|department|title|bday|
anniversary|categories|note|photo`, `phone-row|email-row|address-row|url-row` with `field-<k>-type|custom|pref`, value fields
`field-phone-value`, `field-email-value`, `field-url-value`, `field-address-street|extended|pobox|code|city|region|country`,
`btn-add-<k>`, `btn-remove-<k>`, `btn-choose-photo`, `btn-remove-photo`, `photo-status`, `photo-preview`, `duplicate-hint`,
`form-errors`, `form-error-link`, `contact-save`, `contact-cancel`, `btn-add-category`, `btn-remove-category`, `category-chip`,
`btn-replace-bday`, `dialog-nickname-loss`, `contact-form-readonly`.

Groups: `groups-screen`, `group-list`, `group-row`, `btn-new-group`, `dialog-new-group` (`field-group-name`, `dialog-create-group`),
`group-detail`, `field-group-rename`, `btn-rename-group`, `group-format-note`, `member-list`, `member-row`, `member-unknown-row`,
`btn-remove-member`, `btn-add-member`, `member-picker` (`field-member-search`, `member-option`), `btn-delete-group`,
`dialog-delete-group`, `groups-empty`, `group-notfound`.
