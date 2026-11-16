<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Administrator client and store

Client side of the admin endpoints in [api.md](api.md). Names are placeholders.

## `src/js/api.js` (additions)

`directory()`, `accounts()`, `account(login)`, `effective(login)`, `createAccount(body, {dryRun})`,
`patchAccount(login, body, {dryRun})`, `resetPassword(login, body, {dryRun})`, `deleteAccount(login, confirm, {dryRun})`,
`putGrant(grant, {dryRun})`. Mutating calls send `X-RadUI: 1` and a JSON body limited to the documented fields;
`dryRun: true` adds `?dryRun=1`. Logins are checked against the service's pattern before any request. Mutations
resolve with `normalizeMutation()`: `{dryRun, noop, generation, active, warning, pending, summary, confirmRequired,
rights, effective, account, grant, deleted, password}`; `pending` is the 202 `activation_pending` case. Errors are
`ApiError` with `kind`, `code`, `field`, `retryAfter` (null without a `Retry-After` header). A password lives only in
request bodies and, when generated, in the one answer that returns it.

## `src/js/store/admin.js`

`createAdminStore({api, client, access, writes, reporter, now, sleep})`.

* Reads: `load({collections})` (accounts, all grants; collections of every enabled account only on request, two
  principals at a time), `loadCollections(login)` (lazy), `effective(login)`, `directory()`, `state`, `subscribe(fn)`.
* Dry runs (no Activity line, no state change): `previewGrant`, `previewAccountChange({login, patch})`, `previewCreateAccount`.
* Changes (queued one at a time; 429 waits `Retry-After`, at most twice and 60 s each; Activity ops `account`, `grant`,
  `password`; the access list is read again when the change concerns the signed-in account): `applyGrant`,
  `applyAccountChange({login, patch})`, `createAccount`, `resetPassword({login, password | generate})`,
  `deleteAccount({login, deleteData, expected, onProgress})`.
* Results: `{ok, status, message, ...}`. `status` is `ok`, `noop`, `pending`, `preview`, `aborted`, `data-left`, `changed` or the
  service's error code (`message` is the `err.api.<code>` text; failures also raise a non-persistent alert, a leftover
  after "delete data" a persistent one).
* Delete with data (D-R3-11): dry run of the account deletion, fresh Depth-1 listing of the principal, compared with
  `expected` (`[{href, etag}]`, the listing the confirmation dialog showed): any added or removed href or different ETag
  returns `changed` (persistent alert `err.api.data_changed`), nothing is deleted; the dialog does not offer "delete
  data" without a listing. Then
  `writes.deleteCollection({href, kind, expectedEtag: <the dialog's ETag>})` one at a time, stop at the first failure, a
  second listing must be empty, only then `DELETE accounts/<login>`. The owner of a collection for grant revocation
  is the first segment of its href (`store/writes.js`), never the signed-in login.
