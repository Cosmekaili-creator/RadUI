<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Store layer (`src/js/store/`)

Plain ES modules, no DOM, no dependencies. Timers, listeners, `fetch`, the clock and the model are injected,
so Node tests run everything against fakes (`tests/unit-js/store`). One context exists per login
(`createStoreContext`, `store/index.js`); the session container owns it, so sign-out and session expiry stop
every timer and listener and drop every store.

| Module | Purpose |
|---|---|
| `access.js` | Accessible collections and the access level of each (`own`, `readwrite`, `read`), from `GET me`, `GET me/access` and discovery. |
| `itemstore.js` | One store per collection: server text and ETag only; sync, index hook, change events. |
| `scheduler.js` | When registered stores sync: triggers, backoff, visibility. |
| `writes.js` | The only write path (contacts, events, tasks). |
| `calops.js` | Operation lists for events and tasks (data, not closures), applied to a fresh item. |
| `calendars.js` | Enabled calendars and task lists: one polled store each, parse cache, `occurrences(from, to)`. |
| `importrun.js` | Executes an import plan (`.vcf`; `.ics` with `kind: 'calendar'`). |
| `export.js` | Whole-book and single-item export data. |
| `grants.js` | Grant listing and revocation against the account service. |
| `verify.js` | Write verification (normalised projection per kind) and the NICKNAME guard. |
| `errors.js`, `report.js` | Error classes; Activity, status and alert reporting. |
| `index.js` | `createStoreContext(...)`: wires all of the above for one session. |

## Access levels

`level` is `own` only when `me.ownSpace` is true (with it off, the own collections are not offered), `readwrite` or
`read` from the grant. Nothing is inferred from the DAV privilege list (the field is removed from the entries).
`canWrite(c)` is own or readwrite; `canManage(c)` (edit, delete) is owner only. A collection that is not in the
list has no level: a write is tried and the server decides. After a 403 the writer calls
`access.refetch({reason: '403'})`. The last address book is remembered per login through the session container.

## Item store

Entries are frozen `{href, etag, text}` records and never an `Item` (a failed write can therefore not leave
unsent edits behind). Sync is `syncStep` (sync-collection first, ETag listing as fallback, decision D5). One
sync of a store at a time. An optional `indexer(text, href)` (or `{upsert, remove, clear}`) is called for each
arriving item. A sync that was running during a local write never overwrites the written item; the next sync
then lists everything again to pick up any difference. Events: `subscribe(fn)` receives `{type: 'sync' | 'write' |
'state', ...}`. `refresh({reason})` is a sync, `reload()` forgets the sync state and lists everything again.
Activity gets a `sync` line only when something changed, on a user-started load, and on the first error of a
streak (a poll every minute would otherwise fill the 50-line log).

## Scheduler

Triggers: entering the screen (`enter(store)`: when never synced or last success older than 10 s), window focus,
`visibilitychange` to visible (both within 1 s cost one sync), every 60 s while visible, after each write
(`afterWrite`, 300 ms debounce). Only registered stores are polled. Errors back off 60, 120, 300 s (poll timer
only); a success resets. Nothing runs while hidden or offline. A background sync reports through the callbacks
given to `register(store, {onBusy, onSync})` (`domCallbacks({listEl, rootEl})` builds a pair that sets
`aria-busy` on the list and `data-sync="idle|running|error"` on the screen root); it never touches the global
`data-state`.

## Write path

Every write: write gate (offline or read-only) and level check, a fresh `openItem(text)` for this attempt,
`item.update(patch)`, `item.save()` (writer and fidelity guard, or `checkNewItem`), `{changed: false}` sends no
request, PUT with `If-Match` (verbatim ETag) or `If-None-Match: *`, re-GET, verification, store update,
Activity line, status text. Functions resolve with `{ok, status, message, ...}` and do not throw for expected
failures.

- `saveItem({collection, href, patch, base, baseFields?, acceptNicknameLoss?})` (`base` mandatory)
- `applyOps({collection, href, base, ops, op?})`, `splitWrite({collection, href, base, rid, tailFields?, exceptions?})`, `moveItem({from, to, href, base})` (events and tasks, below)
- `createItem({collection, fields | group, version?, retry?, acceptNicknameLoss?})`, `copyItem({collection, href, patch, base, baseFields?, acceptNicknameLoss?})` (`base` mandatory)
- `deleteItem({collection, href, etag, uid?, groupHrefs?})` (`etag` mandatory), `resolveDeleteAnyway(result)`
- `putGroupMembers({collection, href, delta: {add, remove}, base?})`
- `mkcol({home, name, displayName, description})`, `mkcalendar({home, name, displayName, color, description, components})`
- `proppatch({href, kind, changes})`, `deleteCollection({href, kind, expectedEtag?})`
- `resolveReload(conflict)`, `resolveOverwrite(conflict, {confirmUnmappable, acceptNicknameLoss})`, `resolveCopy(conflict, {acceptNicknameLoss})`
- `isReadOnly(href)`, `validateCollectionName(name)`

**Patch.** An object, or a function `(fields) => patch` called with the fields of the fresh item of each
attempt. Row entries that name an existing row carry the `prop` of the item they were read from: pass
`baseFields` (the fields they came from) so they can be mapped to the fresh item, or pass a builder function.

**Base (mandatory).** `saveItem` and `copyItem` need `base = {text, etag}`: the version the edit started from,
kept from the moment the form opened; without it the call answers `invalid` (`reason: 'base-required'`) and sends
nothing. The store's current copy is never an implicit base (a background sync may have replaced it, and rows
would be written onto the wrong places). Its ETag is the `If-Match`, so a change that arrived after the form
opened is a conflict. With `baseFields`, rows are mapped only when `baseFields` were read from `base.text`
(same UID, same rows, compared by value), else `invalid` (`base-mismatch`). `deleteItem` needs the `etag` the user
was shown (`reason: 'etag-required'`). `putGroupMembers` replays a delta and may use the store's copy.

**Verification.** The owned fields sent and read back are compared as a normalised projection (entries as a
multiset of value, lower-case sorted types, pref, label; members as a set; photo as stripped base64; dates
parsed; text trimmed). Order, case of names, repeated or comma TYPE, parameter order and folding are ignored.
A mismatch gives a persistent alert and an Activity `verify` line with result `error`; nothing is auto-fixed.
NICKNAME is always compared as a list, and a save whose card holds an unescaped multi-value NICKNAME is refused
(`nickname-loss`) unless confirmed with `acceptNicknameLoss: true` (one call only; also available in
`createItem`, `copyItem`, `resolveOverwrite`, `resolveCopy`). The accepted values are then left out of the
verification, so they do not raise a "stored differently" alert. Radicale cuts the list to its first value on every PUT.

**Errors.** 412: GET theirs (404 gives `deleted-elsewhere`), then a `conflict` result `{base, mine, theirs, rows,
unmappable, applied, canOverwrite, canCopy, ...}`. Overwrite re-applies my change on theirs with `rebasePatch`;
unmappable operations need `confirmUnmappable: true`; a second 412 returns a new conflict. Copy uses a new UID
and href (not for groups). Group membership is replayed as a delta, automatically once. 403: text, access refetch,
level recomputed. 404: deleted elsewhere, dropped from the store. 413: too large. 401: `auth`, no alert (the
shell's session-expiry path). 5xx and network errors: alert, and the store is synced again; a failed create
returns `retry`, and the retry reuses the same href and UID (a 412 then means the first attempt worked when a GET
shows the same content). `FidelityError`: refused, the item is read-only until a different version (another ETag)
arrives, codes in Activity, the base text returned as `exportText`.

**Events and tasks (RUN3).** `applyOps`, `splitWrite` and `moveItem` are the calendar write paths; `saveItem` on a
calendar item with an object patch is one `patch` operation, and `createItem`/`copyItem` work for events and tasks.
Same result shape and error handling as above; verification is by `projectEvent`/`projectTask` (see below).

- `applyOps({collection, href, base, ops, op?})`: `ops` is an array applied IN ORDER to a fresh `openItem(base.text)` of
  each attempt. Operations are data (`calops.js`): `patch {fields}`, `override {rid, fields}`, `deleteOccurrence {rid}`,
  `removeExdate {rid}`, `removeOverride {rid}`, `truncate {rid}`, `shiftExceptions {fromStart, toStart}`, `complete`,
  `reopen`; `rid` and the starts are TimeSpecs `{kind, iso, tzid?}`. `shiftExceptions` goes BEFORE the `patch` that moves
  the start and refuses (SeriesError `start-mismatch`) when the master's start is no longer `fromStart`, so a shift is never
  applied twice. No change: no request. A 412 returns a conflict `{kind, mine: {ops}, rows, unmappable, canOverwrite, canCopy}`:
  Overwrite replays the same operations on THEIR version (`resolveOverwrite`); an operation that cannot be replayed (the
  occurrence is gone (`override`, `deleteOccurrence` and `truncate` check `isOccurrence` on the fresh item: an occurrence they deleted, or that the rule no longer yields, is never brought back), the start moved, an all-day/timed toggle with exceptions) is listed in `unmappable` as
  `{field: <op type>, op: 'replay', reason}` and Overwrite is disabled and refused (`not-allowed`), never guessed.
  Save as a copy only for a non-recurring item (`canSaveAsCopy(kind, recurring)`). Activity op: `update`, `truncate`,
  `complete` or `reopen`.
- `splitWrite({collection, href, base, rid, tailFields?, exceptions?})` ("this and following"): (a) head and tail from a
  fresh item (`exceptions`: `keep` | `remove` | `remove-orphans`, as `splitSeries`); (b) PUT the tail (new uuid name,
  `If-None-Match`), GET it back and verify, if the read-back differs the tail is deleted again and `tail-mismatch` is
  returned (a failing GET uses the PUT's ETag); (c) PUT the truncated original with `If-Match: base.etag`, GET and verify.
  **Compensation (deleting the tail) happens ONLY when (c) is known not applied**: 412, 403, 404, 413 or 401. After a network
  error or 5xx the original is read: its ETag equals `base.etag`, or its projection equals the base: compensate;
  its projection equals the truncated version: success; anything else, or a failing GET: NOTHING is deleted, a persistent
  alert "result unknown" names both resources, Activity `split` `error`, status `unknown-result`. If the compensation itself
  fails: persistent alert naming both, status `split-incomplete`. A 412 at (c) compensates and returns the conflict
  (`mine: {split: {rid, tailFields, exceptions}}`); Overwrite replays the split on theirs. Result `{href, tailHref,
  tailUid, etag, text, tail: {href, etag, text}}`.
- `moveItem({from, to, href, base})` (events and tasks): needs write access on both collections, a target that supports the
  component (`components` of the access entry) and an item that opens (an unknown time zone is read-only: refused). PUT the
  EXACT server text (no writer, `checkNewItem` only) to `to` under the same file name with `If-None-Match` (a 412 whose
  content is the same item counts as already copied, another content gets a uuid name), read back and compare the
  projections (a mismatch deletes the copy again and keeps the original), then DELETE the source with `If-Match:
  base.etag`. A 412 at that DELETE (an outside PUT between copy and delete) deletes the copy (its own ETag) and returns the
  normal conflict (`mine: {move: {to}}`, "nothing moved"; Overwrite moves THEIR version). Another DELETE failure leaves both
  and raises a persistent "both exist" alert (`move-incomplete`, no retry); a 404 or a lost response with the source gone
  counts as moved.

**Verification of events and tasks.** `projectEvent(item)` / `projectTask(item)` give `{kind, master, overrides}`:
text fields trimmed, categories as a set, times as `{kind, tzid, at, wall}` where `at` is the INSTANT for UTC and zoned
values (the wall clock text for dates and floating), the effective end (DTEND or start + DURATION), the RRULE as a sorted
part map, EXDATE as a set of occurrence keys, modelled alarms as a sorted multiset, overrides keyed by the occurrence
identity of their RECURRENCE-ID. A VTIMEZONE the server adds is therefore never a mismatch. Only what the operations touched
(`touchedOfOps`) is compared; new items, tails and copies are compared completely (`TOUCH_ALL`).
`putNew` recognises a retry whose first attempt worked by projection (never by bytes).

**Calendars manager** (`createCalendars`, also `ctx.calendars`): `enable({href, kind})` opens the item store and registers
it with the scheduler (only enabled stores are polled); `disable(href)` unregisters and drops it; `setEnabled(list)`;
`occurrences(from, to, {limit})` merges `item.expand` of every enabled calendar (window padded by a day, at most 2,000
occurrences per item, `truncated`, `unreadable`, `loading` until the model is loaded); `entries({kind})`; `parse(entry)`
(one parse per href and ETag, for reading only; writes always re-open a fresh item); `subscribe(fn)`.

**Collections.** `mkcol`/`mkcalendar` refuse with `exists` when the href is known to the access list; otherwise the
href is probed first (404: go on; found: `exists`; another error: `grants-unchecked`), so no revocation can ever
run against an existing collection. Then they read `GET grants?owner=<login>`; grants for that name are revoked and
the create is refused with a text error if that fails or the list cannot be read (a 404 means no account
service). `deleteCollection` re-reads the collection ETag just before; a changed ETag or a 412 answers `changed`
with the item count. After the delete the grants are listed again and revoked one by one (Retry-After honoured
on 429; the wait of a disposed session rejects, so the loop stops); grants that cannot be revoked are named in a persistent alert.

## Import and export

`startImport({client, collection, plan, policy, store, onProgress, ...})` returns `{cancel, done}`. The policy is
resolved with `resolveImport` (guards `checkSplit` and `checkNewItem`); `checkNewItem` runs again before each PUT.
The run is tied to the session: disposing it cancels the import, the worker also stops when `session.disposed`, and
nothing is reported afterwards. Three requests at a time; cancel stops after the requests in flight; 401, 403, offline and network loss stop at
once; verification is one `addressbook-multiget` per chunk. The report is `{created, replaced, skipped, failed,
notRun, reasons, items, warnings, verify, stopped}`. A re-run with `skip` is an idempotent resume. `decodeUtf8File`
refuses non-UTF-8 input and strips a byte-order mark.

`exportCollection` uses `getCollectionText` (a book is the cards one after the other, a calendar one merged
VCALENDAR); a book export drops group cards unless `includeGroups`; on a server-side failure a book is rebuilt
from the store's texts. `exportItem` wraps one item text. Both return `{filename, mime, text (CRLF), blob, count}`;
the file name is `<displayname-slug>-<YYYY-MM-DD>.<vcf|ics>`.

## Tests

`node --test tests/unit-js/store` (fake clock, fake document, in-memory DAV server with scriptable failures and a
Radicale-like re-serialisation step, fake account service; `_cal.mjs` adds a multi-calendar server with
`loseResponse` (the PUT is applied, the client sees a network error) and `afterPut` (another client acts in between)).
`static.test.mjs` scans `views/`, `contacts/`, `calendar/` and `tasks/` for direct write calls.
