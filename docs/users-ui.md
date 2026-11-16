<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Users, permissions and the sharing dialog

Browser side of the account service ([api.md](api.md), [admin-ui.md](admin-ui.md) for the store). Names (`alice`,
`bob`, `agent-1`) are placeholders.

## Screens (`src/js/views/users/`)

One controller, `screen.js` `mount(ctx)`, serves the four routes of the `users` screen (`#/users`, `#/users/new`,
`#/users/permissions`, `#/users/:login`); it reads `route.name`. A non-administrator gets `access-required`
(`role=alert`) on every one of them, without a single call to the account service.

| File | Route | What |
|---|---|---|
| `accounts.js` | `#/users` | table of accounts, `users-status` ("6 accounts · 2 disabled"), counts of own collections read afterwards |
| `form.js` | `#/users/new` | create form; a generated password goes to the one-time dialog BEFORE navigating away |
| `account.js` | `#/users/:login` (`?dialog=reset-password\|delete`) | details and switches, reset, delete, own collections (Share), grants, add access, effective access |
| `matrix.js` | `#/users/permissions` (`?dialog=change&account=&href=&level=`, `?dialog=share&href=`) | collections x enabled non-admin accounts, at most 12 columns, `matrix-filter` |
| `dialogs.js` | | password once, change preview, reset, delete, own-space-off and admin confirmations |
| `model.js`, `parts.js`, `adminstore.js` | | pure helpers, shared widgets, the session-cached admin store |

`adminStoreFor({app, store})` builds the store of the session (cached in `session.data`, disposed with the session,
waits for a 429 `Retry-After` through the session timers). The shell does not provide one.

## Rules the screens follow

* Every grant change is a dry run first (`previewGrant`), then ONE real call from the dialog's confirm button.
* Lock-outs (yourself, the last administrator) disable the button with `aria-disabled` and show `acct-guard`; the
  service refuses them too. Your own password is changed in Settings (`btn-own-settings`).
* Turning an account's own space off while it owns collections needs its login typed; the confirm text comes from the
  service's `confirmRequired` answer.
* "Delete data" lists the collections with an export per collection, then `admin.deleteAccount({deleteData: true})`
  (D-R3-11): collections first, one at a time, stop at the first failure, account last.
* The password of a new or reset account is read once from the service answer, shown in `dialog-password-once` (not
  dismissible before `field-pw-saved` is ticked, `beforeunload` armed), then emptied. It never reaches Activity,
  status, alert, URL or console (static test).

## Sharing dialog (`views/collections/sharedialog.js`)

`openShareDialog({t, tp, app, admin, isAdmin, collection: {owner, name, href, displayName}})` resolves
`{applied, failed}` when it closes. Opened from `btn-share` on a collection row (`#/collections?dialog=share&href=`),
from the matrix row and from the account view. An administrator picks from `directory()` (administrators filtered
out); an owner types a login. Changes are a draft listed in `share-preview`; `share-apply` sends them one after the
other and writes a result per row (`share-result`, `data-result=ok|error`). The dialog stays open until Close.

Test ids: see the header comments of the files and the mockup README table (Users, Matrix, Change preview, Sharing).
