<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Admin API

HTTP/1.0 JSON API of `radui-admin`, bound to a loopback address and reached through a
reverse proxy. Every path below is relative to `base_path` (default `/ui/api`). Names
(`alice`, `agent-1`, `example.org`) are placeholders. The model behind it is in
[rights-model.md](rights-model.md); the shell side is in [admin-cli.md](admin-cli.md).

## Authentication

Every endpoint except `GET health` needs `Authorization: Basic <login:password>`. The
backend forwards the header to Radicale as `PROPFIND / Depth: 0` (207 = authenticated,
401 = not, anything else = `502 radicale_unexpected`) with `X-Forwarded-For` set to the
address in the trusted proxy header (default `X-Real-IP`, validated as an IP address,
else the peer address). There is no cache: a disabled account or a new password acts on
the next request. The backend never sends `WWW-Authenticate`.

Header at most 1 KiB, strict base64, UTF-8, login `^[a-z0-9][a-z0-9._-]{1,31}$`,
password at most 72 bytes (longer is refused, Radicale would truncate it). The account
must exist in the model and not be disabled (else `403 forbidden`); admin endpoints
need `admin: true`. 10 failed logins from one address in 10 minutes block that address
for 15 minutes (`429 rate_limited`, `Retry-After`); numbers are configurable. There is no
per-login lockout (it would let anyone lock the admin out).

## Request rules

* `Host` must be one of `allowed_hosts`; `Origin`, if present, one of `allowed_origins`;
  `Sec-Fetch-Site`, if present, `same-origin` or `none`. Otherwise `403 forbidden`.
* POST/PUT/PATCH/DELETE need `X-RadUI: 1` (`400 missing_header`) and
  `Content-Type: application/json` (`415 unsupported_media_type`), a `Content-Length`
  (no chunked encoding or other `Transfer-Encoding`: `400`), and at most 16 KiB
  (`413 too_large`). Bodies are JSON objects (empty body = `{}`), depth at most 4,
  strings at most 128 characters, no duplicate keys, no floats; otherwise `400
  bad_request`. Unknown fields are `422 validation` with `field`.
* A body on GET is refused. Unknown paths are `404`, wrong methods `405` (code
  `bad_request`, `Allow` header).
* `?dryRun=1` on any mutating endpoint returns the planned change and writes nothing.
* Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'`.

## Mutation responses

`{"generation": N, "active": true, ...}`, or `202` with `{"generation": N, "active":
false, "warning": "activation_pending", ...}` when Radicale did not confirm the new
generation within 3 seconds (the files are written; check `GET health`). Dry run:

```json
{"dryRun": true, "noop": false, "summary": "Create account agent-2 (bot)",
 "generation": 7,
 "rights": {"added": [{"user": "^agent-2$", "collection": "^agent-2$", "permissions": "RW"}],
            "removed": []},
 "effective": [{"login": "agent-2", "path": "agent-2/*", "before": "none", "after": "own"}],
 "effectiveTruncated": false}
```

A change that has no effect (same values, same grant) returns the current generation
without writing (`noop`).

## Endpoints

| Method and path | Who | Body or query | Answer |
|---|---|---|---|
| `GET health` | anyone | | `{ok, generation, active, modelOk}`; `generation` is the model's, `active` is the probe's answer for that generation, `ok` also needs the managed files at that generation |
| `GET me` | any account | | `{login, displayName, type, admin, ownSpace, generation, rightsActive, ok}`; `rightsActive` and `ok` are `active` and `ok` of `GET health` (same data, same 2 s cache), so the browser never calls `health` (the proxy restricts it to the server itself) |
| `GET me/access` | any account | | `{login, admin, ownSpace, grants: [{href, owner, collection, level, grantedBy, created}], principals?}`; `principals` (enabled logins) only for admins; `href` is `/<owner>/<collection>/` |
| `GET directory` | admin | | `[{login, displayName, type}]` of enabled accounts |
| `GET accounts`, `GET accounts/{login}` | admin | | `{login, displayName, type, admin, disabled, ownSpace, created, passwordChanged}` (never a hash) |
| `POST accounts` | admin | `{login, displayName, type?: person\|bot, admin?, ownSpace?, password \| generate: true}` | `201 {account, password?, generation, active}`; the generated password appears only here; `admin: true` is refused for `bot` |
| `PATCH accounts/{login}` | admin | any of `displayName, type, admin, ownSpace, disabled`, plus `confirm` | `{account, generation, active}`; `ownSpace` true to false while the account owns collections needs `confirm: "<login>"` (counted by listing the principal with the admin's credentials); a dry run reports `confirmRequired` |
| `POST accounts/{login}/password` | admin | `{password}` or `{generate: true}` | `{generation, active, password?}` (only generated ones are returned) |
| `DELETE accounts/{login}` | admin | `{confirm: "<login>"}` | `{deleted, generation, active}`; the login is tombstoned for good, grants naming it are removed, data is untouched |
| `GET grants?owner=&grantee=` | admin: all; others: own collections only | | `[{owner, collection, grantee, level, grantedBy, created}]` |
| `PUT grants` | owner of the path, or admin | `{owner, collection, grantee, level: none\|read\|readwrite}` | `{grant \| null, generation, active}`; idempotent; the backend checks with the caller's own credentials that the collection exists and is a calendar or address book (not for `none`); the grantee must be an enabled non-admin account. For a caller who is **not** an admin, an unknown, a disabled and an admin grantee all answer the same `422 validation` (`field: "grantee"`, same message; checked after the ownership check), and so does `level: "none"` when no such grant exists: nothing can be probed to learn which logins exist. A grant to a since-disabled grantee can still be revoked. Admins keep the specific errors (`404 not_found`, `grantee_disabled`, `grantee_is_admin`) |
| `GET effective/{login}` | admin | | `[{path, level, letters}]` from the model, confirmed with Radicale's own rights engine on the managed files |
| `GET generations` | admin | | `[{generation, current, baseline, accounts, grants, modified}]` |
| `POST generations/{n}/restore` | admin | `{confirm: "restore-<n>"}` (not needed with `?dryRun=1`) | `{generation, active, restoredFrom, restore}`; creates a NEW generation, see "Restore" below; lockout rules apply; `404 not_found` for an unknown generation, `422 validation` (`field: "confirm"`) without the exact confirmation |

## Restore

A restore never undoes a security action taken since the stored generation. The
**current** state stays authoritative for:

* tombstones: a deleted login is never revived and stays reserved (a snapshot account
  whose login is tombstoned now is dropped, and so are grants naming it);
* password hashes and `passwordChanged` of every account that exists now (a reset is
  never reverted);
* `disabled` (an account disabled since is not re-enabled);
* `displayName`, `type` and `created` of existing accounts.

The stored generation contributes the **grants**, `ownSpace` and the `admin` flags (an
account that is a bot now never becomes admin). Accounts created after the stored
generation are removed (going back), without a tombstone. The lockout rules apply to the
result as for any change. When the current model is missing or corrupt there is nothing
to keep and the stored generation is used as it is (`restore.currentModel: false`).

`?dryRun=1` (no confirmation needed) and the real answer carry the same report:
`restore: {accountsDropped, accountsRemoved, grantsAdded, grantsRemoved, flagsChanged:
[{login, field, before, after}], currentModel}`, next to the usual `rights` diff and
`effective` access changes. A dry run also returns the `confirm` string to send.
`radui-admin-cli restore` has the same semantics and a `--confirm` flag.

## Client address

Per-IP limits and the `X-Forwarded-For` sent to Radicale (it lands in Radicale's
failed-login log line that fail2ban reads) use one validated address. The header named
by `trusted_proxy_header` is honoured only when the TCP peer is in `trusted_proxies`
(default: loopback) **and** its whole value is one plain IPv4 or IPv6 address. A value
containing `%` (a scoped IPv6 address), a list, a port, a name or any control character
is ignored. In every other case the peer address is used. The proxy must overwrite the
header on every request.

## Errors

`{"error": {"code": "...", "message": "...", "field": "..."}}` (`field` only where
relevant).

| Status | Codes |
|---|---|
| 400 | `bad_request`, `missing_header` |
| 401 | `unauthenticated` |
| 403 | `forbidden` (also bad Host, Origin or Fetch-Site) |
| 404 | `not_found`, `collection_not_found` |
| 409 | `exists`, `tombstoned`, `lockout_last_admin`, `lockout_self` |
| 413 / 415 | `too_large` / `unsupported_media_type` |
| 422 | `validation` (with `field`), `unsupported_collection_name` |
| 429 | `rate_limited` (`Retry-After`) |
| 500 | `internal` (including a candidate that failed validation: nothing was changed) |
| 502 / 503 | `radicale_unexpected` / `busy` (lock held longer than 10 s), `model_corrupt` |

When the model cannot be loaded every endpoint except `health` answers
`503 model_corrupt` until `radui-admin-cli restore` fixes it; the model file is re-read
when it changes, no restart is needed.

## Audit log

One JSON line per event on standard output: `ts, event, actor, ip, target, result,
generation`. Events: `startup`, `reconcile`, `self-heal`, `auth.failed`,
`auth.denied`, `request.rejected`, `account.create|update|password|delete`,
`grant.put`, `generation.restore` (a `.dryrun` suffix for dry runs). Passwords,
hashes and `Authorization` values are never written.

Before a change is published, its event, actor, target and client address are written to
`<state_dir>/generations/<N>/intent.json`. If the process dies half way, the next start
(or self-heal pass) rolls the files forward and writes the audit line **of the original
change** (for example `account.create`, `result: "rolled_forward"`) from that record,
then renames it `intent.replayed.json`. Without a usable record the generic `reconcile`
line is written.

## Self-heal

Every `self_heal_interval_s` seconds (default 60, `0` = off) the backend checks that the
managed files equal what the model generates and that the generation probe answers
"active". If not, it runs the same reconcile as at start: full validation first, then it
rewrites the files and writes a `self-heal` audit line (`rolled_forward`, or
`validation_failed` once per distinct failure). This repairs a damaged or reverted rights
file, and a Radicale that restarted on a stale `rights.lkg`, without a backend restart.
It never runs at the same time as a change (the pass is skipped when the lock is held)
and stops with the service. With correct files and a negative probe (Radicale down) the
files are rewritten once per model generation, not every pass. Pair it with a monitor
alert on `ok: false` from `GET health`.

## Generation probe

After writing, the backend polls an anonymous `GET /radui-gen-<token>` on `radicale_url`
every 300 ms, one request at a time, for at most 3 seconds: 404 = the new generation is
active, 401 = not yet. Only then is `rights.lkg` refreshed. The plugin exposes no
endpoint of its own, so there is no second source of truth; `Prober.generation()` returns
the generation in the header of the managed rights file (what was written, not proof of
activation) and is used for display only.
