# Contacts logic (`src/js/contacts/`)

Internal design notes for the DOM-free contact modules. They run unchanged in a browser and in
Node 20; browser image APIs are passed in as parameters. Tests: `node --test tests/unit-js/contacts`.
The user-facing description of the contacts screens is separate.

| Module | Role |
|---|---|
| `formmodel.js` | The only place where form values become a model patch. `toFormValues(fields)`, `toPatch(baseFields, values)`, `validate(baseFields, values)`, `newCardPatch(values, {version, uid})`, `serverLossWarnings(fields)`. Works on `item.fields()`; imports no Item. |
| `index.js` | One summary per item version (`summarize`), list building, search, collation, A-Z letters, windowing, duplicate hint, route keys. |
| `photo.js` | Upload processing (`processPhoto`) and the display check of an existing photo (`canDisplayPhoto`), both from header-read sizes. |
| `groups.js` | Group list and detail data, membership patches, rename, new group cards, groups of a contact, picker candidates. |

## Form to patch

- Every comparison is against what the form *displayed* (`toFormValues(base)`), never the raw card.
  A field the user did not touch therefore never reaches the card, whatever the card holds.
- Rows are matched by the original `prop` handle. An unchanged row is echoed with its original
  handle, its original `types` array, `pref: undefined` and `label: undefined`.
- The type select replaces only the one mapped TYPE token; other tokens stay. A row's `pref` is sent
  only if its radio changed; the label only if it was edited (a label of `""` means unchanged, `null`
  removes it). TEL `main` is the `TYPE=MAIN` token. A card that already carries the Apple built-in
  label `_$!<Main>!$_` also shows `main` and keeps that form; choosing `main` writes the token, never the label.
- Only the first NICKNAME value is shown and written (one value). CATEGORIES are chips. A TEL written
  as a URI is shown without `tel:` and restored on write. N, ADR and ORG patches name only the changed
  parts; the model keeps the raw text of the others. Further ORG units are kept.
- FN follows the name parts only while FN was not edited and equals the composition of the original
  parts (`followFn`). FN is never emptied by an edit: it falls back to the organisation, or nothing is
  written.
- Dates: `{year|null, month, day}`. A text-valued date stays read-only until "Replace" is chosen. An
  anniversary is written only on vCard 4.0; on 3.0 existing X-ABDATE and X-ANNIVERSARY values are shown
  read-only.
- A blank row (`ADR;TYPE=home:;;;;;;`, an empty labelled TEL) that was blank in the baseline too is
  echoed unchanged; only a row that was filled and is now blank is removed.
- A key that is absent from `values` is untouched. A blank row is not written; a cleared existing row is
  removed. Rows are not reordered.
- Validation covers changed or new values only, so an old odd value never blocks an unrelated edit.
  Errors are `{field, testId, key, row?, params?}`.

## Interface trap: newlines

An HTML single-line `<input>` strips `\n` from its value, so a street read back from an input differs
from `12 Main St\nApt 3`; the row then counts as changed and the newline is lost on save. ADR parts
(street, extended, ...) and NOTE must be edited in a `<textarea>` and handed back byte for byte. The model
treats text that is equal after CR/LF normalisation as unchanged (test `a value with a newline ...`).

## Known limits

- The server cuts a multi-value `NICKNAME` to its first value on any PUT (`serverLossWarnings`).
- Removing an Apple address row also removes its `X-ABADR` sibling, which the fidelity guard refuses
  today (test `formmodel.test.mjs`, "known: the guard refuses ...").
- Photos: the header window is 512 KB; a JPEG whose frame header lies further in is refused for display.
