# Data model (`src/js/model/`)

Plain ES modules, no dependencies, no DOM: they run unchanged in a browser and in Node 20.
Tests: `node --test tests/unit-js/model`.

## Principles

- The unit of truth is the item text **as served by Radicale** (its re-serialisation). The
  tokenizer accepts CRLF, LF and lone CR and works in LF in memory. Every PUT body is CRLF with a
  final CRLF.
- Parse, change only the properties the UI owns, serialise. Every other line (`X-*`, `ATTENDEE`,
  `ORGANIZER`, `GEO`, `ATTACH`, unknown parameters, vCard groups, photos, unmodelled alarms)
  is re-emitted from its original text, so a no-edit round trip is byte-exact against the
  LF-normalised input re-emitted with CRLF. Blank lines and a leading BOM are the only things
  dropped.
- Across the server fidelity is **semantic**: Radicale re-orders, re-cases and re-folds on
  storage. A save with no change to an owned property returns `{changed:false}` and no request
  is sent. RadUI never computes an ETag.
- ical.js (vendored) is used **only to read** iCalendar data, and never on vCards. It is never
  used to write.

## Module map

| Module | Role |
|---|---|
| `contentlines.js` | iCalendar and vCard (RFC 5545 and RFC 6350) tokenizer and component tree (`parse`, `Component`, `Property`); property groups (`item1.TEL`), quoted and multi-valued parameters; value codecs (TEXT escape, date/time, duration, RRULE). Each property keeps its original unfolded line (`raw`) and its original physical lines (`folded`). |
| `writer.js` | Our serializer: value-type registry, `foldLine` (75 octets, never inside a UTF-8 sequence), `emit`, mutation primitives, writer-managed properties, `serialize`. |
| `icalview.js` | Read view on ical.js: time zones, recurrence expansion (`expandEvents`), time values. |
| `event.js`, `todo.js`, `vcard.js` | Registries of the owned properties with read/patch functions; recurrence helpers, alarms, contact groups, photo, new-item builders. |
| `item.js` | `openItem`, `createItem`, the `Item` facade. |
| `fidelity.js` | Guards run before every PUT (`checkFidelity`, `checkNewItem`, `checkSplit`). |
| `conflict.js` | After a 412: `diffOwned` (three-way diff of the contact's owned fields) and `rebasePatch` (row-level three-way merge for "Overwrite with mine"). Pure functions. |
| `importplan.js` | `.vcf` import planning: `splitVcf`, `planImport`, `resolveImport` (policies skip / replace / keep-both). Pure functions; the store executes the operations. |
| `tests/lib/semdiff.js` | Semantic diff used by the round-trip tests. |

## Public API (summary)

```
openItem(text, kind?)  ->  { ok:false, readOnly:true, reason, message, raw }
                         | Item   (ok:true; readOnly may still be true, see time zones)
createItem(kind, fields, {uid, prodid, version})   kind: 'event' | 'task' | 'contact'
createGroupItem(name, memberUids, {uid, prodid, form})   form: 'rfc6350' | 'apple'
```

`Item`: `fields()`, `update(patch, {recurrenceId})`, `save({now}) -> {changed:false} | {changed:true, text}`,
`addExdate`, `removeExdate`, `addRdate`, `upsertOverride`, `removeOverride`, `deleteOccurrence`,
`splitSeries(spec, {newUid, prodid, now}) -> {tailText, tailUid}`, `completeTask`, `reopenTask`,
`expand({from, to, limit}) -> {occurrences, truncated}`, `eventModel()`, plus `root`, `main`,
`overrides`, `uid`, `tz`, `warnings`, `baseline`, `raw`.

Refusal reasons of `openItem`: `empty`, `parse-error`, `multiple-uids`, `multiple-vcards`,
`multiple-calendars`, `no-uid`, `unsupported-version`, `unsupported-component`,
`mixed-components`, `wrong-kind`, `no-master`, `multiple-masters`, `multiple-tasks`,
`invalid-value`. The caller shows the item read-only with a raw viewer and never rewrites it.

Patch keys are the keys `fields()` returns; keys that are absent are not touched, and a value
equal to the current one changes nothing (foreign escaping and parameter forms survive).
Time values are `{kind:'date'|'floating'|'utc'|'zoned', iso, tzid?}`.

## Time zones (every TZID is classified)

1. A VTIMEZONE is embedded: its STANDARD/DAYLIGHT onsets are generated with ical.js and a wall
   clock time is resolved as RFC 5545 section 3.3.5 requires (a time in a gap uses the offset
   before the gap, an ambiguous one the first occurrence).
2. No VTIMEZONE but `Intl` accepts the name: instants come from `Intl`; the TZID is kept and
   nothing is added.
3. Neither (also an offset-style name such as `UTC+02:00`, and a VTIMEZONE that cannot be
   interpreted): the item opens with `readOnly: true`, a `warnings` entry
   `{code:'unknown-tzid', tzid}` and no instant (`instant: null`). It is drawn at its wall-clock
   time and never treated as floating. Every mutator and `save()` throw `ReadOnlyError`.

Floating times and all-day `VALUE=DATE` values are used as they are and are never converted.
Recurrences are expanded on the wall clock and then converted to instants; floating and all-day
values are compared as if their wall clock were UTC, so callers pad the window by a day.

## Writing

- Touched properties are serialised by `formatProperty`: TEXT values are escaped through the
  value-type registry (`VALUE_TYPES`; URI, binary, raw and time values are not), an edited
  property keeps its name case, group prefix and parameter form, a new property is upper-case.
- Folding is at 75 octets; continuation lines are at most 75 octets including the leading space.
- Writer-managed properties, applied on a copy at save time to every touched component:
  `DTSTAMP`, `LAST-MODIFIED` and `SEQUENCE`+1 (VEVENT; VTODO has no SEQUENCE bump), vCard
  `REV` (written in the form the card already uses, extended for 3.0, basic for 4.0).
  `UID`, `PRODID` and `VERSION` are written only for new items and never changed on foreign ones.
- Events: only relative DISPLAY alarms without `REPEAT` are modelled; every other VALARM is kept
  untouched. An event that uses `DURATION` gets its `DURATION` rewritten when the end is edited.
- Recurrence: `addExdate`; `upsertOverride` (the override VEVENT stays in the same resource);
  `splitSeries` puts `UNTIL` on the old series (a `COUNT` becomes `UNTIL`, later `EXDATE`,
  `RDATE` and overrides move) and returns the text of a new item with a new UID.
- vCard: the `VERSION` is never changed. Apple `itemN.` siblings (`X-ABLabel`) move with their
  property (`moveEntry`, `removeWithSiblings`, labels on entries). `PHOTO` is never
  re-serialised: a new photo is `PHOTO;ENCODING=b;TYPE=JPEG:<b64>` (3.0) or
  `PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:<b64>` (4.0). The 4.0 form is a Radicale workaround, not
  strict RFC 6350: the server loses the payload of a `data:` URI. A new nickname is written as
  exactly one value (the server keeps only the first of a list). An empty `X-ABLabel` sibling is
  kept when entries are echoed back (label `""` means unchanged, `null` removes it). Groups are `KIND:group` + `MEMBER` or the Apple form
  (`X-ADDRESSBOOKSERVER-KIND` / `-MEMBER`); the form already used by a card is kept.

## Contact form shapes (vcard.js)

What the contact form needs so that an untouched field never changes a card:

- **TYPE is a token set.** `splitTypes(types, mapped)` gives the one token the type select shows
  (the first one `mapped` knows, e.g. `MAPPED_TYPES.tel`) and the rest (`INTERNET`, `VOICE`, a
  second mapped token, `x-*`). `replaceMappedType(types, mapped, next)` replaces only that token.
  Tokens that survive keep their original spelling. `pref` is sent in an entry only when the
  preferred radio was changed: `undefined` keeps `PREF=1`/`PREF=2` (4.0) and every `TYPE=pref`
  row (3.0) as they are.
- **NICKNAME** is compared against the value the form shows, the first of a list (`a,b`). An
  untouched multi-value NICKNAME stays; an edit writes exactly one value (K3).
- **CATEGORIES** is an array of strings; an escaped comma (`Friends\, family`) stays inside one
  category and is written back escaped.
- **`TEL;VALUE=uri:tel:+1-555-0100`:** `telUriForm(prop)`, `stripTel(value)` (display) and
  `restoreTel(display, form)` (write: the `tel:` prefix is restored, spaces become `-`).
  `setEntries` restores the prefix itself when it is missing.
- **N, ADR, ORG** re-encode per part (an ORG name edit keeps empty middle units: `Acme;;Sales` becomes
  `NewCo;;Sales`): a part whose displayed value did not change keeps its raw
  text (`Alex,Alexis` is not re-joined as `Alex\, Alexis`). A part may be a string or a list of
  strings. `mergeStructured(raw, obj, fields)` is the primitive.
- **Photo:** `readPhotoData(card, {maxBytes})` gives `{ok:true, mime, base64, bytes}` or
  `{ok:false, reason}` (`none`, `external-uri`, `not-base64`, `bad-base64`, `unsupported-mime`,
  `too-large`). It never decodes an image and never returns SVG; the caller still checks the
  magic bytes and the pixel size. `fields().photoSig` is a cheap change signature of the payload.
- **Groups:** `isGroupCard` (both forms), `memberMatches(member, uid)` (`urn:uuid:` optional,
  UUIDs case-insensitive), `addMember` / `removeMember` (touch only that member line; unknown
  and foreign members such as `mailto:` stay), the patch key `membersDelta: {add, remove}`,
  `pickNewCardVersion(cards)` (majority 3.0/4.0, 3.0 for none or a tie) and `pickGroupForm(cards)`
  (existing group cards by majority, else by majority VERSION: 3.0 gives the Apple form,
  4.0 RFC 6350; an empty book gives Apple).
- **Anniversary:** an anniversary is written only on vCard 4.0 (`ANNIVERSARY`). On 3.0 the
  existing `itemN.X-ABDATE` (Anniversary label) and `X-ANNIVERSARY` values are read-only:
  `fields().anniversaries` lists them (`readAnniversaries`), `anniversaryPolicy(card)` says
  whether the field is writable. `item.update(patch, {strict: true})` refuses an anniversary
  change on a 3.0 card; the default stays permissive (the round-trip edit registry writes one
  on every card).
- **Apple labels:** `labelInfo(label)` maps `_$!<Mobile>!$_` to `{builtin: true, key: 'mobile',
  text: 'Mobile'}` (`APPLE_LABELS` lists the keys); other labels come back as written. The model
  itself keeps the raw label (it is what is written back).

## New items from existing ones

- `item.asCopy({uid})` returns a NEW item with the current in-memory state of this one (apply the
  patch first), `uid` on every UID line (the overrides of a recurring event too), a PRODID when the
  source had none, and the managed properties of a new item. Group cards are refused, read-only
  items throw `ReadOnlyError`.
- `checkNewItem(text, {requireProdid})` also requires exactly one UID line for a VCARD.
- `checkSplit(sourceText, outText, {uidMap, complete})` guards a resource cut out of a larger text
  (the `.vcf` and `.ics` imports). Every
  logical line of the output must be a line of the source (consumed one for one, folding and line
  endings do not matter), except UID lines and MEMBER lines rewritten through `uidMap`
  (`{oldUid: newUid}`; the key `""` means "the source has no UID, this one was added"). For a
  calendar split, `dropped: ['METHOD']` names properties that may be missing from the output in
  `complete` mode and `added: [lines]` the exact wrapper lines (`VERSION:2.0`, `PRODID:...`) the
  output may carry although the source lacks them. With
  `complete` every source line must also be present. Codes: `split-parse`, `split-foreign-line`,
  `split-uid`, `split-member`, `split-missing-line`.

## Conflicts (conflict.js)

`diffOwned(base, mine, theirs)` takes Items or `fields()` objects (`mine` is base with my patch
applied) and returns rows `{field, kind, mine, theirs, both, changedMine, changedTheirs}` for the
fields either side changed and on which mine and theirs now differ; `both` marks a field both sides
changed; a photo is only `'changed'` / `'unchanged'`.

`rebasePatch(baseFields, minePatch, theirsFields)` is the row-level three-way merge behind
"Overwrite with mine". `baseFields` is `fields()` of the item the form was opened on (its entries
carry the base `prop`); `minePatch` is the patch the form built; `theirsFields` is `fields()` of
their item. The result `{patch, unmappable, applied, notes, noop}` has a patch for THEIR item
(`theirsItem.update(result.patch)`; its entries reference their `prop` objects).

- Operations (add, remove, modify of a row) come from base to mine through the base `prop`
  identity and are replayed on theirs; rows are matched by their base (value, types), identical
  rows one by one. Rows I did not touch follow theirs; where both sides changed an attribute
  (value, types, pref, label) mine wins, and an ADR row merges per part.
- An operation that cannot be matched (the row was deleted or changed by them) is returned in
  `unmappable` as `{field, op: 'modify'|'remove', reason: 'row-not-found', base, mine}` and is
  never guessed or dropped; the dialog lists it and asks for confirmation. A removal of a row they
  also deleted cannot be told apart from a change and is listed as well.
- Scalars (fn, title, note, kind, nickname, dates) are set when I changed them and theirs differs;
  N and ORG merge per part; categories merge as a set (their additions stay); a photo set wins,
  a removal applies only when they still have a photo.
- Preferred rows: when I marked a row preferred (or added one) and they newly marked a DIFFERENT
  row, mine wins: their mark is cleared (`applied` op `unpref`, note `pref-moved`). Rows already
  preferred in the base are left alone.
- `notes` lists where mine silently won, for the dialog: `both-edited` (ORG units edited on both
  sides) and `theirs-removed` (they removed ORG or N while I edited a part; my version is kept).
- Membership is always a delta (`patch.membersDelta`), also available alone as
  `rebaseMembership(delta, theirsMembers)` and `membershipDelta(baseList, newList)`.
- Group cards cannot be saved as a copy (`canSaveAsCopy`).

## Import planning (importplan.js)

`.vcf` here; the `.ics` import is the next section. Pure functions; the caller decodes the file as UTF-8,
the store runs the operations.

- `planImport(text, known, {collectionHref, limits, random})` splits the file (`splitVcf`) and
  returns `{fatal, rows, counts}`. `known` is `[{href, etag, uid, fn?, emails?}]`. Row states:
  `new`, `duplicate` (same UID as a known item), `invalid` (does not parse, too large,
  unterminated, text outside a card), `unsupported` (vCard 2.1 or another version),
  `file-duplicate` (a later card with a UID already seen in the file; the first is kept). Rows carry
  `reason`, `uid`, `href` (where it would be created, or the existing item), `fn`, `version`,
  `isGroup`, `generatedUid` (a card without UID gets one: the only mutation), `hints`
  (same name or e-mail, different UID: information only) and `text`/`source`.
- Limits (`LIMITS`): 10 MB file, 5,000 cards and 20,000 chunks (cards plus junk; `fatal` refuses the
  whole file with `file-too-large`, `too-many-items` or `too-many-chunks`; the splitter stops
  scanning at the chunk cap), 1 MB per card (the card becomes `invalid`).
- **Lossy cards.** Radicale damages some input on storage (docs/roundtrip.md rules
  `text-cut-at-unescaped-comma` and `photo-data-uri-payload-dropped`). `lossyProperties(item)`
  names them: NOTE, TITLE, NICKNAME or an `X-` property with an unescaped comma, and a
  `PHOTO:data:` URI. A row carries them in `lossy` and `plan.lossy` lists the flagged cards; the
  text is never rewritten. `resolveImport` skips a REPLACE with such a card (`skipped` reason
  `lossy-needs-confirmation`, a `lossy-skipped` entry in `problems`, `counts.lossySkipped`) unless
  its UID is in `opts.confirmLossy`; creates (new cards, keep-both) go ahead, their operation has
  `lossy` and `counts.lossy` counts them, so the dialog can warn.
- `resolveImport(plan, 'skip'|'replace'|'keep-both', {collectionHref, random})` returns
  `{operations, skipped, counts, problems}`. An operation is `{op: 'create'|'replace', index, href,
  uid, text (CRLF), etag?}`: a create is sent with `If-None-Match: *`, a replace to the existing href
  with `If-Match` of the existing ETag. keep-both gives a duplicate a new UID (same style) and a
  new href and rewrites the MEMBER lines of every imported group card that point at a re-keyed UID.
- Cards are imported line for line (no re-serialisation). Every operation is verified with
  `checkSplit(source, out, {complete: true})` and `checkNewItem(out, {requireProdid: false})`
  (PRODID is optional in a foreign vCard); a card the guard refuses is skipped with
  `guard-failed`.
- File names: `<uid>.vcf` when the UID matches `^[A-Za-z0-9._@-]{1,100}$` (and does not start with
  a dot), else `<uuid>.vcf`; names are unique against the known items case-insensitively.

## `.ics` import planning (importics.js)

`planIcsImport(text, known, {collectionHref, limits, random, components})` and `resolveIcsImport` live in
`importics.js`; `importplan.js` re-exports `planIcsImport` and `resolveImport` dispatches to `resolveIcsImport` for
a plan whose `kind` is `'calendar'`, so `store/importrun.js` (`kind: 'calendar'`) runs both the same way. `known`
is `[{href, etag, uid}]` (`calendarUidOf(text)` reads the UID of a stored item). `components` is what the target
accepts (default VEVENT and VTODO).

- **Splitting** (`splitIcs`) is line level: a file may hold several VCALENDARs; every top-level component is cut
  out as it is (LF, original folding) and parsed on its own, so one broken component is reported and skipped
  without hiding the others. Text outside a calendar and an unterminated calendar or component are `invalid` rows.
- **Grouping.** VEVENT/VTODO are grouped by UID: the master and its overrides (RECURRENCE-ID) stay in ONE
  resource, wherever they stand in the file. The same UID + RECURRENCE-ID twice keeps the first (`file-duplicate`).
  A component without UID becomes its own resource with a generated UID (`generatedUid`, note `generated-uid`:
  the only invented line). An empty UID is `invalid` (`empty-uid`). An event and a task with the same UID are
  `invalid` (`mixed-components`).
- **Resource text** is written by our own raw-lines writer, never by ical.js: the source `BEGIN:VCALENDAR` line, the
  source header lines (VERSION, PRODID, CALSCALE, X-WR-...; `METHOD` is dropped and reported as note
  `method-dropped`; a missing VERSION or PRODID is added and reported as `wrapper-added`), exactly the VTIMEZONEs
  the resource references (the one of its own calendar, else the first of the file), then the components as they
  stand in the file, then `END:VCALENDAR`. Source lines are never re-folded or reordered.
- **Skipped and reported per row** (`unsupported`, reason `unsupported-component`, `row.component` names it):
  VJOURNAL, VFREEBUSY, any other component, and VEVENT/VTODO the target does not accept. A resource `openItem` refuses
  is listed and never uploaded: `invalid` (`parse-error`, `invalid-value`, `no-master` = overrides without their
  master, `multiple-masters`, `multiple-tasks`, `multiple-uids`, `too-large`) or `unsupported` (`unsupported-version`).
- **Unknown TZID.** A TZID that neither a VTIMEZONE of the file nor `Intl` knows is NOT rewritten: the resource is
  imported as it is with note `unknown-tzid` (`tzids`); the app then shows it read-only.
- **Lossy.** `lossyCalendarProperties(root)`: SUMMARY, DESCRIPTION, LOCATION, COMMENT and unknown `X-` TEXT
  properties of the events, tasks and their alarms with an unescaped comma (rule `text-cut-at-unescaped-comma`;
  a property with `VALUE` other than TEXT is ignored). Same `lossy` / `confirmLossy` contract as the contacts.
- **Policies.** skip (default), replace (PUT to the existing href with the existing ETag), keep-both (the UID line of
  the master AND of every override is rewritten to one new UID, new href). RELATED-TO references to a re-keyed UID
  are NOT remapped (a child task of a re-keyed parent keeps pointing at the original).
- **Guard.** Every operation passes `checkSplit(source, out, {complete: true, dropped: ['METHOD'], added})` against its
  own source slice (the file lines it was cut from) and `checkNewItem(out, {requireProdid: false})`.
- Limits as for `.vcf` (`ICS_LIMITS` equals `LIMITS`): 10 MB, 5,000 events and tasks, 1 MB per resource, 20,000
  chunks. Rows are numbered in file order. File names `<uid>.ics` (safe UIDs) else `<uuid>.ics`.

## Fidelity guard

`checkFidelity(before, after, {allowOverrides})` throws `FidelityError` unless the new text
re-parses, keeps the same set of components (except VTIMEZONE, override VEVENTs and relative
DISPLAY VALARMs), keeps every untouched line (after LF normalisation and unfolding) in order,
leaves an unchanged VTIMEZONE alone, never drops a VTIMEZONE that a TZID parameter in the new
text still refers to (adding one, or removing one nothing refers to, is allowed), and keeps UID, VERSION and PRODID. "Untouched" means not
an owned property, not a writer-managed one, and not a sibling in the property group of an
owned property. An `X-ABLabel` always travels with its parent; every other sibling (`X-ABADR`,
`X-ABDATE`, `X-ABRELATEDNAMES` ...) is tolerated only when no owned line of its group survives
unchanged in the new text (the row was removed or replaced), so removing the last ADR row takes
its `itemN.X-ABADR` with it, while a sibling dropped next to a kept parent, and any unrelated line,
is refused. `Item.save()` runs it; `checkNewItem` covers new items (see above for `checkSplit`).

## Test corpus

`tests/fixtures/ics` and `tests/fixtures/vcf` hold fictional items (example.org, reserved
phone ranges, fake coordinates). `tests/fixtures/manifest.json` lists the kind and the expected
verdict of each file. The cards for the contact form (multi-TYPE, multi-PREF, `VALUE=uri` TEL,
category with an escaped comma, N/ADR/ORG comma lists, X-ABDATE and ANNIVERSARY, text and
year-less BDAY, multi-value NICKNAME, Apple built-in labels, both group forms with unknown
members, vCard 2.1, hostile text, bidi text) and `import-mixed.vcf` (good, bad and duplicate
cards in one file) are in `vcf/`. Radicale answers 400 to a card without UID, so
`vcf/server-refused/vcard30-no-uid.vcf` lives in a subdirectory the corpus loaders do not scan. Line endings are CRLF unless the file name says LF or CR.
