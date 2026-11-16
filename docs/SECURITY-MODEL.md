<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Security model

What RadUI protects, where the trust boundaries are, what each component can and cannot do, and
what it does not guarantee. This page describes the code and the deployment templates of this
repository; it makes no promise beyond them. Names (`alice`, `agent-1`, `example.org`) are
placeholders. To report a vulnerability, see [../SECURITY.md](../SECURITY.md).

## Components and trust boundaries

```
 browser ──HTTPS──> nginx ──loopback──> Radicale          (calendar and contact data, auth, rights)
                      │
                      └────loopback──> radui-admin        (accounts and rights files only)
                                            │  writes: users, rights, rights.lkg (managed dir), own state
                                            └─ asks Radicale with the caller's own credentials

 Radicale ── loads radui_rights.py ── re-reads the generated rights file when it changes
```

* **The browser and everything it displays is untrusted.** Calendar and contact content comes from
  other people and other clients; the app treats every DAV-sourced string as text. ical.js is used
  only to read, never to write.
* **nginx is the trust anchor for the client address.** It terminates TLS, applies the headers,
  the request-size and rate limits, and **overwrites** the forwarded-address headers with the
  address it saw. Radicale and the backend trust that address only because nothing but nginx can
  reach them (both listen on loopback).
* **Radicale holds the data and decides every access** with its own rule engine. RadUI never
  evaluates rights for Radicale; it only generates the file Radicale evaluates.
* **The admin backend holds no calendar data.** Its single job is to write the two files Radicale
  reads, in the one format Radicale's `from_file` understands, from a model it keeps.
* **The host is trusted.** Someone with root, or with the Radicale or backend user, is outside this
  model (see "Not guaranteed").

## What the backend can and cannot do

Rendered unit: `deploy/systemd/radui-admin.service.tpl`. It runs as its own user and group,
`NoNewPrivileges`, an empty capability set, `ProtectSystem=strict` with write access to **two**
directories (its state directory and the managed directory), `ProtectHome`, `PrivateTmp`,
`PrivateDevices`, `RestrictAddressFamilies=AF_INET AF_UNIX`, `IPAddressDeny=any` with
`IPAddressAllow=localhost`, `SystemCallFilter=@system-service`, `UMask=0027`.

| It can | It cannot |
|---|---|
| write `users`, `rights` and `rights.lkg` in the managed directory, and its model and generations in its state directory | write anywhere else on the file system, including Radicale's storage and configuration |
| call Radicale on loopback, with the credentials of the **caller** of the current request | read calendar or contact items directly (no access to the storage); it only sees what the caller itself can see (collection names and types, to check a grant target) |
| verify and create bcrypt password hashes | hold plaintext passwords after a request (a generated password exists only in the response that shows it) |
| start Radicale's interpreter to validate a candidate rights file before writing | open outbound connections to anything but this host |
| change **who** may access **what** | change the content of any collection |

A **compromised backend** (or someone who can write the managed files) can set any password and
grant itself or anyone any access, and can then read the data through Radicale. It can never read
calendar data directly, but because it can rewrite who is allowed to, this is as serious as an
admin account being compromised. Hence the sandbox above, the loopback-only listener, and a state
directory of mode 0700. A compromised **admin account** is the same: it can reassign everything.
Use a strong password for admins, and keep their number small.

The backend has **no secret of its own**: no token, no API key, no credential store. It
authenticates each request by forwarding the caller's `Authorization` header to Radicale
(`PROPFIND /`, 207 means authenticated), then checks that the login is an enabled account in its
model (and an admin, for admin endpoints). There is no second password database. A disabled
account, a changed password or a removed admin acts on the next request: nothing is cached.

## Threats and what answers them

| # | Threat | Answer | Residual risk |
|---|---|---|---|
| 1 | Password guessing against Radicale or the API | Radicale's delay on a failed login; nginx `limit_req` on `/ui/api/`; the backend's per-address limiter (10 failures in 10 minutes block the address for 15 minutes); the fail2ban jail (10 failures, 10 minutes, ban 1 hour); bcrypt cost 12; password rules for admin-typed passwords | A slow, distributed attack stays below every per-address limit. There is no per-login lockout on purpose: it would let anyone lock the admin out. There is no second factor. The limits are **per address**, so ten failed logins from one shared address (a NAT, a carrier or an office gateway) block everyone behind it, the admin included, for 15 minutes: an accepted trade-off, see "Shared addresses" below |
| 2 | A client chooses the address that fail2ban bans (or avoids a ban) by sending `X-Forwarded-For` | nginx **overwrites** `X-Forwarded-For` and `X-Real-IP` with `$remote_addr` and clears the other headers Radicale or the backend might trust; the filter is anchored so a login containing text that looks like a forwarded address cannot supply one (tested, with a negative control). This overwrite and the jail are a **pair**: never ship the jail alone. The backend honours its own copy of the header (`trusted_proxy_header`, default `X-Real-IP`) only from a peer listed in `trusted_proxies` and only when the value is a plain IP address (see "Trusted proxies" below) | A proxy chain in front of nginx hides the real client; the jail would ban the proxy. Do not use it behind another proxy without extra work |
| 3 | Forged `Host`, `Origin`, cross-site requests to the admin API | The backend checks `Host` against `allowed_hosts`, `Origin` against `allowed_origins`, `Sec-Fetch-Site` (`same-origin` or `none`); mutating calls need `X-RadUI: 1` and `Content-Type: application/json`; credentials are sent as an explicit header by the app, never as cookies or ambient browser authentication, so a foreign page cannot make the browser send them | none known beyond XSS (next row) |
| 4 | Script injection in the app (XSS) | `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`; no inline script, handler or style; no third-party request; vendored, pinned libraries | The credential header is kept in `sessionStorage` (or `localStorage` with "stay signed in") and is readable by script running on the page: an XSS would expose it. Radicale's built-in web UI (`/.web/`) shares the origin and its storage: if you do not use it, switch it off (`[web] type = none`) |
| 5 | Tampering with or truncating the rights file | The file carries a header and a trailer with the generation and a SHA-256 over everything before the trailer; the plugin and the backend validate it independently (structure, letters, patterns compile, `[zzz-deny]` last); only an atomic rename replaces it; an invalid file is rejected and the old rules stay in force, and the failure is logged once | Someone who can write the managed directory can produce a valid file (see "compromised backend") |
| 6 | A rights change not taking effect (or taking effect late) | The backend confirms each generation with an anonymous probe on a secret path (404 = active, 401 = not yet) and reports `active`; the plugin checks the file's stat signature and content hash on every request | A request that was already authorized when a change lands finishes under the old rules (for example a slow upload that began before a revocation); the next request is under the new ones |
| 7 | A stale `rights.lkg` re-granting revoked access after the main file is damaged and Radicale restarts | **Fail-static by design** (see "Stale `rights.lkg`" below): the plugin logs CRITICAL naming the generation it runs on and keeps serving on `.lkg` instead of taking every DAV client offline; the backend's **self-heal timer** repairs the main file; health reports `active: false`; a monitor alert on `ok: false` or `active: false` is a cutover prerequisite | Until the main file is repaired (normally within one self-heal interval, but only while the backend is running), access revoked since the generation in the log line is active again |
| 8 | Wrong rights from a bug in the generator | The generator is a pure function with golden tests; every candidate is evaluated with Radicale's own engine for a probe set that covers every account, tombstoned and disabled login, root, principals, collections and the generation path, and must equal the model's expectation, or nothing is written | The probe set is finite; the rule layout is documented so it can be reviewed ([rights-model.md](rights-model.md)) |
| 9 | Privilege escalation inside the admin API | Admin endpoints require an enabled admin; a `bot` can never be an admin; an admin cannot demote, disable or delete themselves; the last admin cannot be removed; account and collection names are whitelisted and `re.escape`d before they enter a pattern; reserved and deleted logins cannot be created | A malicious admin is an admin. A restore cannot be used to bring back a tombstoned login or an old password hash (see "Restore semantics") |
| 10 | Oversized or malformed requests | nginx `client_max_body_size 16k` on the API; the backend's own cap, `Content-Length` required, no chunked bodies, strict JSON (depth, string length, duplicate keys), request timeouts | The Radicale location allows `RADICALE_MAX_BODY` (default 50M) for calendar uploads |
| 11 | Exhausting Radicale's connection slots (`max_connections`; the template default is 8, the measured recommendation is 32, see [testing.md](testing.md)) | nginx rate limiting on the API; the fail2ban jail; each failed request holds a slot for about a second | The Radicale location (`/`) has no rate limit in the template: a flood of anonymous requests can still queue legitimate clients. Add a `limit_req` there if this matters, with a rate that does not break syncing clients |
| 12 | Other local users reading secrets | State directory 0700; managed files 0640 with the Radicale group; configuration 0640 root:radui and refused by the backend if group- or world-writable; the plugin's temporary copy lives in Radicale's `PrivateTmp` | Radicale's own user can read the hashes in `users` (it has to) |
| 13 | A Radicale upgrade silently changing the internals the plugin uses | Tested-version policy; a WARNING outside the tested range; incompatible internals make the file "unusable" and the plugin fails closed; `radui-admin-cli check-radicale` before the restart; see [upgrading-radicale.md](upgrading-radicale.md) | A change that keeps the same interfaces but different behaviour is only caught by the test suite |

## Stale `rights.lkg`: fail-static, with self-heal and an alert

`rights.lkg` is the last rights file proven active. It can therefore be **older** than the main
file by the generations since the last confirmed activation (usually zero or one). If the main
file is damaged or invalid while Radicale (re)starts, the plugin does not fail closed: that would
take every calendar and contact client offline. It runs on `.lkg`, logs one CRITICAL line with the
generation and `source=lkg`, and health shows `active: false`. This is the deliberate
**fail-static** policy; it is acceptable only together with the following three parts:

1. **Self-heal timer in the backend.** On a fixed interval (default 60 seconds, a configuration
   value) the backend checks, while health is not active, whether the rights file on disk differs
   from the text generated from the model or is invalid; if so it runs the same reconcile as at
   start-up and rewrites the files. A Radicale restart while the backend keeps running therefore
   no longer leaves a stale file in force for long. The timer does nothing when the files are
   current and active.
2. **A monitor alert** on health `ok: false` or `active: false` (for longer than a few minutes).
   It is a prerequisite of the cutover ([../deploy/CUTOVER.md](../deploy/CUTOVER.md)); RadUI ships
   no alerting of its own.
3. **A documented fix:** restart the backend, or `radui-admin-cli restore --generation <current>`
   with its typed confirmation ([../deploy/RECOVERY.md](../deploy/RECOVERY.md)).

If the backend itself is down, nothing heals the file; the alert is then the only protection.

## Trusted proxies and the client address

The backend uses the client address for its limiter and its audit lines, and forwards it to
Radicale as `X-Forwarded-For` (where fail2ban reads it). Rules:

* The header named by `trusted_proxy_header` (default `X-Real-IP`) is honoured **only when the TCP
  peer is listed in `trusted_proxies`** (IP addresses or CIDR networks; the default is loopback
  only). From any other peer the header is ignored and the peer's address is used, so a local
  process or a misconfigured listener cannot choose its own limiter key.
* The value must be a plain IPv4 or IPv6 address. Anything else, in particular a scoped address
  (containing `%`) or any text that is not an address, is rejected and the peer address is used.
* **Every deployment must overwrite the header at the proxy** (`proxy_set_header X-Real-IP
  $remote_addr;` and the same for `X-Forwarded-For`; the nginx templates do). A proxy that passes
  the client's own value through defeats the limiter and the jail. If the proxy is not on
  loopback, add its address to `trusted_proxies`.
* A client address behind **another** proxy chain is not supported (see threat 2).

## Shared addresses

The failed-login limiter and the fail2ban jail count per address, and there is no per-login
lockout (threat 1). On an address shared by many people, ten failed logins from anybody block the
whole address, including an admin behind it, for 15 minutes (the backend) or an hour (the jail).
This is accepted: a per-login lockout would let any outsider lock a named account out. The way
out is the host, not the API: restarting `radui-admin` clears the backend's limiter, an operator
releases a jail ban with `fail2ban-client set radui-radicale-auth unbanip <address>`, and
`radui-admin-cli reset-password <login>` works from a root shell regardless of any address block
([../deploy/RECOVERY.md](../deploy/RECOVERY.md)). Put the static addresses of administrators in
`F2B_IGNOREIP`.

## Restore semantics

Restoring an earlier generation must never undo a security action taken since. **Tombstones and
the current password hashes are authoritative:**

* a tombstoned (deleted) login is never revived, even if the chosen generation held it as an
  account: it is dropped from the restored accounts;
* for an account present in both the chosen generation and the current model, the **current**
  `hash` and `passwordChanged` are kept, so a password reset is never reverted;
* an account disabled since stays disabled (the current `disabled` value is kept);
* what the generation does restore: grants, `ownSpace` and admin flags.

`?dryRun=1` (CLI: `--dry-run`) lists exactly what would change: the accounts dropped because they
are tombstoned, grants added and removed, flags changed, and the effective-access delta. A real
restore requires the typed confirmation `restore-<n>` (for generation `n`) so it cannot be
triggered by accident; the lockout rules still apply. The result is a **new** generation; the old
one is not modified.

## Enumeration

The directory of accounts is admin-only (`GET directory`, `GET accounts`). A non-admin who owns a
collection can still grant access on it, and the answer must not reveal which logins exist or
are disabled: for a non-admin, an unknown or a disabled grantee gives the same `422 validation`
(reason `grantee_unavailable`), decided after the collection-ownership check; a `none` request is a no-op only when a
matching grant exists, otherwise it gets the same answer. Admins get the precise
errors. When an owner-facing sharing picker is added, it needs a directory and this property will
have to be revisited.

## Scenario: a bot's credential is stolen

An attacker has the password of `agent-1`, an ordinary account of type `bot`.

* They can do what `agent-1` could: use its own space (if enabled) and the collections granted to
  it, at the granted level (a read grant: read only; a read-and-write grant: read, add, change and
  **delete items**). They can reach nothing else: the rules name `agent-1` exactly and everything
  else falls through to "deny".
* They **cannot** use the admin API (the account is not an admin, and a `bot` can never be one),
  change anyone's rights, delete, rename, recolour or overwrite a shared collection, or create
  collections inside a collection that was shared with it.
* Items they delete or change are not recoverable by RadUI. Back up the collections.
* **Response:** an admin disables the account or resets its password (`PATCH accounts/agent-1` with
  `disabled: true`, or `POST accounts/agent-1/password`). Both take effect on the next request, with
  no restart, and the API confirms `active: true` once Radicale runs the new generation. Then
  review the audit log, Radicale's logs, and `GET effective/agent-1` to bound what was reachable.
* **Detection:** failed logins appear in Radicale's journal (with the client address nginx saw) and
  in the backend audit log as `auth.failed`; successful logins are not logged at WARNING level.
  Unusual traffic is the operator's to notice: there is no built-in alerting.

## Headers (nginx templates)

| Header | Value | Where |
|---|---|---|
| `Strict-Transport-Security` | `max-age=<HSTS_MAX_AGE>` (no `includeSubDomains`, no `preload`: add them yourself if you know you want them) | every location |
| `X-Content-Type-Options` | `nosniff` | every location (the backend's own copy is hidden so it is sent once) |
| `X-Frame-Options` | `DENY` | every location |
| `Referrer-Policy` | `no-referrer` | every location |
| `Permissions-Policy` | `geolocation=(), camera=(), microphone=()` | every location |
| `Content-Security-Policy` | the policy of threat 4 | static app locations and the Radicale location; the API answers carry the backend's `default-src 'none'` |
| `Cache-Control` | `no-cache` for `index.html`, `config.json`, `sw.js`, `sw-manifest.js` and the web manifest; `public, max-age=300` for the other static files; the API's own `no-store` | static app; API |

### Service worker, file list and update gate

* **`sw-manifest.js`** is generated at deploy time (`tools/build-sw-manifest.py`, run by
  `tools/deploy-static.sh`; not in git). It lists every static file with its SHA-256. It is served with
  `Cache-Control: no-cache` like `sw.js` and `index.html`, so a worker never installs from a stale list.
  The worker fetches each file bypassing the HTTP cache, compares the hash and **fails the install** on any
  difference: a tampered or half-deployed tree is never cached or run from the cache. This is an integrity
  check against deployment mistakes and cache poisoning, not against an attacker who can write the served
  directory (such an attacker also writes the list).
* **Allowlist.** The worker answers only GET requests of the same origin, inside its scope, for listed
  files, `config.json` (network first) and navigations to the app entry. It never calls `respondWith` for
  CalDAV/CardDAV paths, the API, other origins, requests with a query string or `Range`, or other methods.
  It has no runtime cache: it can never store a response that carries account data, and credentials, data
  and API responses never enter a cache the worker owns. Offline, the app is read-only.
* **Cache rules.** Caches are named `radui-shell-<version>`; older ones are deleted on activation. Updates
  wait until the user presses reload (`skipWaiting` only on request).
* **Stale-tab gate.** A tab whose worker was replaced by another tab's update would mix old modules with new
  files; it marks itself stale and the write gate refuses writes ("Reload to continue") until it reloads.
* **Deploy order and backup.** `tools/deploy-static.sh` copies `sw-manifest.js`, `sw.js` and `index.html` last,
  verifies every hash after the copy and writes a mode-600 backup first ([UPGRADE-UI.md](UPGRADE-UI.md)).
  Recovery from a bad worker: [pwa.md](pwa.md).

Because nginx drops inherited `add_header` lines in any location that declares one of its own, the
five baseline headers are one include repeated in every location. The test script
`tests/deploy/nginx_check.py` compares the header set location by location.

## Rate limiting (layers)

1. **nginx** `limit_req` on `/ui/api/` per client address (default 120 requests a minute, burst 30;
   `429`); the health location is exempt (loopback only).
2. **Backend**: failed-login limiter per address (10 in 10 minutes, then 15 minutes' block with
   `Retry-After`) and a request-rate limiter (default 300 a minute, burst 60); numbers are
   configuration values.
3. **Radicale**: an incorrect-authentication delay (default 1 second) and `max_connections`.
4. **fail2ban** (optional): bans an address at the firewall after repeated failed logins.

## fail2ban and the address headers: a pair

The jail bans the address in Radicale's log line `Failed login attempt from <proxy> (forwarded for
'<client>')`. That address is trustworthy only because nginx overwrites `X-Forwarded-For` with the
connection's address (`proxy_set_header X-Forwarded-For $remote_addr;`, never
`$proxy_add_x_forwarded_for`). The filter is anchored at the start of the log line with the trusted
proxy address, takes the first and genuine forwarded address, and does not match lines that have
no forwarded address or come from another peer. `tests/fail2ban/run.sh` proves, with fail2ban's own
engine, that genuine failures (IPv4 and IPv6) yield the right address and that a login containing
a fake `(forwarded for '<address>')` marker does not yield the attacker's address, and it shows that
the simpler, unanchored filter *is* fooled.

## Logging and audit

* **Backend:** one JSON line per event on standard output (the journal): `ts, event, actor, ip,
  target, result, generation`. Events: start-up and reconcile, failed and denied authentication,
  rejected requests, account create/update/password/delete, grant changes, generation restores,
  and the CLI's reset and restore. Passwords, hashes and `Authorization` values are never written
  (values are scrubbed as a second line of defence). The address is the one nginx forwarded in
  `X-Real-IP`, used only when the peer is in `trusted_proxies` and the value is a plain IP
  address, else the peer address.
* **Radicale:** at WARNING: failed logins (with the forwarded address) and the plugin's start-up,
  reload and rejection lines. Successful logins are INFO and not visible at the recommended level.
* **nginx:** the access log records request lines and addresses but not the `Authorization`
  header.
* There is no log shipping, alerting or retention policy in RadUI: use your journal and log
  rotation settings.

## Not guaranteed

* Security of Radicale itself, of nginx, of the kernel and of TLS configuration beyond what the
  templates set.
* Protection against an attacker with root on the host, or with the Radicale or backend account.
* Confidentiality of a credential that is typed into a compromised browser or device, or stored by
  "stay signed in" on a shared device.
* Calendar and contact **content** safety: items are stored and displayed as sent by clients; only
  the app's own rendering is defended (text only, strict CSP).
* Availability: a restart of Radicale is needed once at cutover and after Radicale upgrades.
* Recovery of deleted items or of passwords; backups are the operator's responsibility.
* Anything on versions of Radicale outside the tested series.

By default the backend listens on loopback only, there are no default credentials, there is no
telemetry and no external request.
