<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Conflict dialogs and the download helper (`src/js/views/`)

## When it opens

The write path (`store/writes.js`, see `store.md`) answers a failed save or delete with a result whose `status` is one of:

| `status` | Variant (`data-testid` of the dialog) |
|---|---|
| `conflict` (the server answered 412 and the item still exists) | `dialog-conflict` |
| `deleted-elsewhere` (the item is gone) | `dialog-deleted-elsewhere` |
| `changed-elsewhere` (a delete was refused because the item changed) | `dialog-changed-elsewhere` |

The screen passes that result to `openConflictDialog`. Nothing here writes to the server: the buttons call
`writes.resolveReload`, `resolveOverwrite`, `resolveCopy` and `resolveDeleteAnyway`. The store writes the Activity lines
and the status text.

## API

```
openConflictDialog({conflict, t, writes, label, feedback, win}) -> Promise<result>
```

- `conflict`: the store result. `t`: the translator. `writes`: the store's write functions. `label`: the item name for the
  text (optional; shown isolated, so right-to-left names do not scramble the sentence).
- `feedback` (optional, the shell's feedback store): the stale "changed elsewhere" alert is dismissed after a resolution,
  and Cancel leaves "nothing was saved" as status text.
- The promise resolves with the final write result of the resolution that succeeded, `{ok: true, status: 'discarded',
  href}` for "Discard my changes", or `{cancelled: true}` (Cancel, Esc). `promise.dialog` is the dialog controller.
- A result that is not a conflict, or a missing `writes`, resolves `{ok: false, status: 'invalid', reason}` and opens nothing.
- `modeOf(result)` returns `'conflict' | 'deleted' | 'changed' | null`; `VARIANTS` lists the test ids per variant.

## Behaviour

- **Edit conflict.** A `<table>` (`conflict-diff`) with one `conflict-field-row` per field (`data-field`, `data-both`),
  columns Field, Yours, Theirs. List values are bulleted, an empty value reads "(empty)", the photo reads "changed" or
  "unchanged". A row changed on both sides carries the text "Changed on both sides". All values are text nodes.
- **Changes that cannot be applied** (`conflict.unmappable`): listed under "These changes cannot be applied
  automatically:". While the list is not empty, Overwrite stays disabled until `conflict-confirm-unmappable` is ticked, and
  `resolveOverwrite(conflict, {confirmUnmappable: true})` is sent only then.
- **Same row edited on both sides** (repeatable fields: phone, email, address, URL). When the base row can no longer be found in
  their version because they changed it too (value or types), it is still the same row if the two lists have the same length,
  the row sits at the same position unmatched, and their row at that position still shares the value text or the set of types with the
  base row (a reordered list, or a row deleted and another one added, fails this and stays in `unmappable`): mine wins on the attributes I changed, theirs keeps the rest (address parts merge),
  and a note "both of you edited the value" (or "the types", or both) is listed when both changed the same part to different results. Different lengths
  (a row was removed or inserted) are never paired: the change stays in `unmappable`. When their row already equals mine, nothing is
  left out, so no confirmation box is shown and Overwrite sends no request: the status reads "Already identical on the server:
  nothing to save." (`conflict.status.identical`; after unmappable changes were confirmed and dropped the plain "No changes to save." is used instead). Before this change a phone edited to different values on both sides was listed as
  "cannot be applied" and dropped (the result read "No changes to save").
- **Notes** (`conflict.notes`): where their version lost without being asked (organisation units edited on both sides, a
  removed name or organisation, a moved preferred mark).
- **Buttons.** Reload theirs (`conflict-reload`), Overwrite with mine (`conflict-overwrite`; disabled when
  `canOverwrite` is false), Save mine as a copy (`conflict-copy`; disabled when `canCopy` is false, for example a group
  card), Cancel (`conflict-cancel`). A disabled button has its reason as visible text (`conflict-overwrite-reason`,
  `conflict-copy-reason`) linked with `aria-describedby`. The write buttons follow the app's write gate (offline,
  read-only).
- **Second conflict.** When a resolution answers with a new conflict (or the item was deleted or changed in the
  meantime), the same dialog is drawn again with the new rows, the confirmation reset and a status line saying so. The
  variant follows the result.
- **Nickname loss.** If the store refuses a save because the server would keep only the first nickname, a second
  required box (`conflict-confirm-nickname`) appears; Overwrite and Copy then retry with `acceptNicknameLoss: true`.
- **Running request.** All buttons are disabled, the dialog has `aria-busy="true"` and `conflict-status` says "Working…".
  Esc cannot close the dialog meanwhile.
- **Failure.** A persistent `role="alert"` text (`conflict-alert`) inside the dialog; the dialog stays open.
- **Focus.** Cancel is focused first (every other button changes data); focus returns to the opener on close.
- **Deleted elsewhere.** Save mine as a copy (`deleted-save-copy`), Discard my changes (`deleted-discard`), Cancel
  (`deleted-cancel`).
- **Delete refused.** Show their version (`changed-show-theirs`, calls `resolveReload`), Delete anyway
  (`changed-delete-anyway`), Cancel (`changed-cancel`).

Other test ids: `conflict-both`, `conflict-no-rows`, `conflict-unmappable` (+ `-item`), `conflict-notes` (+ `-item`),
`conflict-status`, `conflict-alert`, `deleted-copy-reason`.

Strings: `i18n/{en,fr}.conflict.js` (`conflict.*`). Styles: `css/conflict.css` (design tokens only; the dialog scrolls inside
itself; the buttons stack on phones). The stylesheet must be listed in `index.html`.

## Download helper (`download.js`)

```
downloadText({text, mime, filename, doc, win}) -> {ok: true, filename, bytes} | {ok: false, reason}
```

Blob, `URL.createObjectURL`, a temporary `<a download>` that is appended, clicked and removed, and `URL.revokeObjectURL`
after `REVOKE_DELAY_MS`. It never throws: `reason` is `no-text`, `unsupported` or `failed`. `doc` and `win` can be injected.
Also exported: `safeFilename(name)` (no path separators, controls, invisible or reserved characters, no leading dot, no
reserved device name, length capped at 120 characters and 200 bytes, extension kept), `safeMime(mime)` and
`exportFileName(displayName, ext, date)` (`<displayname-slug>-<YYYY-MM-DD>.<ext>`, the store's naming).

## Tests

`node --test tests/unit-js/views` (the fake DOM of `tests/unit-js/widgets/_dom.mjs`, a scriptable `writes`; no browser).

## Events and tasks (RUN3)

The same dialog serves `applyOps`, `splitWrite` and `moveItem` conflicts (`conflict.mine` is `{ops}`, `{split}` or
`{move}`): Reload theirs, Overwrite (replays the operations, the split or the move on their version) and, for a single
non-recurring item, Save mine as a copy. Rows come from `diffOwned(kind, base, mine, theirs, {occurrences})` in
`model/conflict.js` (per-kind registry `FIELDS`: contact, event, task); labels are `conflict.field.<key>`, a row about one
occurrence of a series carries `occurrence` and reads "Title (occurrence of 2026-03-09T09:30:00)". An operation that cannot
be replayed on their version is listed in `unmappable` as `{field, op: 'replay', reason}` (texts `conflict.replay.<code>`):
Overwrite is then disabled with the visible reason `conflict.overwriteDisabled.ops`, and no confirmation box is shown.
