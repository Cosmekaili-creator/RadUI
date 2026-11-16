<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Administration

How accounts and permissions work, what Radicale's rights letters can and cannot express, and
where to look when something goes wrong. Names (`alice`, `agent-1`, `example.org`) are
placeholders. The exact data model and the generated rules are in [rights-model.md](rights-model.md);
the HTTP API is in [api.md](api.md); the shell commands are in [admin-cli.md](admin-cli.md).
Everything an admin can do is available through the API and the CLI; the web app uses the same API.

## The model in one page

RadUI keeps one JSON model of **accounts** and **grants** and generates Radicale's `users` and
`rights` files from it. Nothing else writes those two files: do not edit them by hand (a changed
file is rejected by the plugin and overwritten at the next change).

**Accounts.** One login and one password per account; a bot is simply an account.

| Field | Meaning |
|---|---|
| login | `^[a-z0-9][a-z0-9._-]{1,31}$`, unique; upper-case ASCII is folded to lower case when creating; names such as `admin`, `root`, `radicale`, `api`, `ui`, anything starting `radui-`, and logins deleted earlier are refused |
| display name | up to 64 characters, no control characters |
| type | `person` or `bot` (a label, plus one rule: a `bot` can never be an admin) |
| admin | full access to everything below the principals, and the right to manage accounts and grants |
| ownSpace | may create and use collections of its own (default yes); when off, the account can sign in but has no space of its own |
| disabled | credentials stop working at once; data is kept; may be turned back on |

There is no self-service sign-up, no e-mail and no password recovery by mail: an admin resets
the password. At most 200 accounts and 2000 grants.

**Passwords.** Generated: 20 characters, shown once. Typed by an admin: 12 to 72 bytes (UTF-8), no
control characters, not containing the login, not on a built-in list of common passwords, and at
least three character classes unless 16 or more characters long. Stored as bcrypt (cost 12 by
default). The 72-byte ceiling is bcrypt's: Radicale would silently ignore the rest, so longer
passwords are refused.

**Deleting an account** removes it and its grants, and **tombstones** the login for good: it can
never be created again (so an old grant or log entry can never point at a different person). The
account's collections are **not** deleted by RadUI; remove the data separately if you want it gone.

**Grants.** A grant gives another account access to one collection of an owner:

| Level | Radicale letters on that collection | What the grantee can do |
|---|---|---|
| none | (no rule) | nothing |
| read | `r` | read items and collection properties |
| read and write | `rwl` | read, add, change and **delete items**; not rename, recolour, delete or overwrite the collection; not create collections inside it |

Only the owner of a collection, or an admin, can grant access to it; a grant to an admin is
refused (admins already have everything); the grantee must exist and be enabled to get any effect.
A grantee needs the direct URL of the collection (other people's collections are not discoverable
through Radicale): `GET me/access` lists what the signed-in account may open.

**Own space.** An account with ownSpace has full control of its own principal and of the
collections it creates there (`<login>/<collection>`). Switching ownSpace off while the account
still has collections needs a typed confirmation, because the owner then loses access to them.

**Admins.** Per admin: read and write on the admin's own principal and on every enabled account's
principal that has its own space, read on top-level names, and every letter below any principal.
An admin cannot be given write access on arbitrary top-level names (that would allow creating
collections nobody can delete). Safety rules the backend enforces: the last enabled admin cannot
be removed, disabled or demoted; an admin cannot disable, delete or demote **themselves**; a
change that would leave an admin without full access is refused; a `bot` cannot be an admin.

**Every change** is validated against Radicale's own rule engine on the generated files before it
is written, written atomically, confirmed live by an anonymous probe request to an unguessable
path (the API answers `202` with a warning if Radicale did not confirm within 3 seconds), and
recorded in the audit log (never with passwords). Dry runs (`?dryRun=1`) show the exact rule
changes and the effective-access differences first.

## What Radicale's rights letters cannot do

RadUI can only express what Radicale's `from_file` rules can:

* **Edit cannot be separated from delete.** There is one write letter for items. A read-and-write
  grantee can also delete items.
* **No free/busy-only level**, no "add but not change", no per-item or per-property rights.
* **No inheritance.** A grant covers exactly one collection; there is no "everything below".
* **Discovery.** Other accounts' collections do not show up in a client's home set; the grantee
  must use the URL, or the app's access list.
* **Collection names.** Collections whose names do not match the supported pattern
  (`^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$`, not ending in `~`) stay usable by their owner but cannot be
  granted to others.
* **Nobody can delete a principal over DAV** (no `D` on principals): removing an account's
  directory from the storage is a file-system action.
* Rights files are read by Radicale as text patterns: RadUI whitelist-validates and escapes every
  name before it goes into a pattern; do not work around this with hand-written patterns.

## Passwords and clients

Radicale checks the password with bcrypt on **every** request (RadUI does not enable Radicale's
login cache). On a 4-CPU test machine at cost 12 Radicale handled about 16 authenticated requests a
second with its default 8 connection slots; many clients syncing at once queue behind each other.
An anonymous or failed request holds a slot for about a second (Radicale's auth delay), which is why
nginx rate limiting and the fail2ban jail matter. `max_connections` is in the Radicale snippet
(`RADICALE_MAX_CONNECTIONS`); the measured recommendation is 32 (see [testing.md](testing.md)); record the value you chose and re-measure on your machine.

## Day-to-day

* **Create an account for a bot or a person:** `POST accounts` with `generate: true`; the password
  is in the response once. Give it the grants it needs, nothing more.
* **A credential may be stolen:** disable the account (`PATCH accounts/<login>` with
  `disabled: true`) or reset its password; both act on the next request. Then look at the audit
  log and at what the account could reach (`GET effective/<login>`).
* **See who can reach what:** `GET effective/<login>` (admin) and `GET grants`.
* **Go back:** every change creates a numbered generation; `POST generations/<n>/restore` or
  `radui-admin-cli restore --generation <n>` makes an earlier one current as a new generation.
  Restore never undoes a security action: **tombstones and the current password hashes are
  authoritative**, so a deleted login is not brought back, a reset password is not reverted and an
  account disabled since stays disabled. It does restore grants, `ownSpace` and admin flags of
  that generation. Look first with `?dryRun=1` (CLI `--dry-run`): it lists the accounts that would
  be dropped because they are tombstoned, the grants added and removed and the flags changed. A
  real restore needs the typed confirmation `restore-<n>`. The last three generations and the
  import baseline are kept.
* **Health and activity:** `GET health` (loopback only through nginx): `ok`, the model's
  `generation`, `active` (Radicale confirmed that generation), `modelOk`. The backend writes one
  JSON audit line per event to its journal (`journalctl -u radui-admin`): account and grant
  changes, failed and denied logins, rejected requests, start-up reconcile.
* **A locked-out address:** the failed-login limit is per address, with no per-login lockout (that
  would let anyone lock a named account out). Ten failed logins from one address block that whole
  address for 15 minutes, and the optional fail2ban jail for an hour. Behind a shared address (an
  office, a mobile carrier) one person's typing mistakes can therefore block everyone there,
  admins included. Recovery is from the host: `systemctl restart radui-admin` clears the
  backend's block, `fail2ban-client set radui-radicale-auth unbanip <address>` releases a ban, and
  `radui-admin-cli reset-password <login>` needs no network access at all
  ([RECOVERY.md](../deploy/RECOVERY.md)). List the administrators' static addresses in
  `F2B_IGNOREIP`.
* **A stale rights file:** if Radicale restarts while the managed `rights` file is damaged, it runs
  on the last-known-good copy (fail-static) and `GET health` shows `active: false`. The backend's
  self-heal timer (every 60 seconds by default) repairs the file; keep a monitor alert on
  `ok: false` or `active: false`.
* **Who can see whom:** only admins can list accounts. A non-admin who shares one of their
  collections gets the same `grantee_unavailable` answer for an unknown and for a disabled login,
  so the sharing call cannot be used to find out who has an account.
* **Radicale upgrades:** [upgrading-radicale.md](upgrading-radicale.md).
* **Backups:** RadUI does not back up calendar and contact data. Back up Radicale's collections
  directory as you did before, and `/var/lib/radui` (the model and generations) together with
  `/etc/radui/config.toml`.

## Recovery pointers

[deploy/RECOVERY.md](../deploy/RECOVERY.md) has the step-by-step recipes (root shell):

| Problem | Where |
|---|---|
| lost or leaked password, locked-out admin | `radui-admin-cli reset-password <login>` |
| model corrupt (`503 model_corrupt`), unwanted change | `radui-admin-cli show`, `restore --generation <n>` |
| damaged or hand-edited managed files, interrupted change | restart the service (it reconciles) or `restore --generation <current>` with its confirmation |
| Radicale started on a stale `rights.lkg` (CRITICAL log line, health `active: false`) | RECOVERY.md "Stale rights.lkg": the self-heal timer, a backend restart, or `restore --generation <current>` |
| an address is blocked after failed logins | RECOVERY.md "A client address was banned or throttled" |
| plugin fails after a Radicale upgrade | RECOVERY.md, then upgrading-radicale.md |
| Radicale will not start | RECOVERY.md "Radicale will not start" |
| back to the setup before RadUI | [deploy/ROLLBACK.md](../deploy/ROLLBACK.md) (Rollback A keeps the accounts, B restores the old files) |
