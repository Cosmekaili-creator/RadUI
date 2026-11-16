<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Testing

Everything below runs on throwaway instances (current user, loopback only, directories under the
git-ignored `.throwaway/`). Nothing touches a system service. Names (`alice`, `bob`, `agent-1`,
`example.org`) are placeholders.

| Target | What | Needs | Ports |
|---|---|---|---|
| `make test` | unit tests (Python, Node), repository checks (`tools/spdx.py`, `tools/hardcode-check.py`, `tools/pii-check.py`) | Python 3.11+, Node 20 | none |
| `make test-integration` | `backend/tests/integration/`: lifecycle, robustness, the S3 letter matrix, health, shapes, `max_connections` | Radicale, `bcrypt` | Radicale 15290 to 15296 and 15320 to 15329, backend 15297 to 15299 and 15330 to 15339 |
| `make test-security` | `tests/security/`: negative-security suite | same | 15320 to 15339 |
| `make test-e2e E2E_SUITE=<name>` | `tests/e2e/`: one suite (`shell`, `contacts`, `groups`, `collections`, `import-export`, `conflict`, `pwa`, `security`, `perf`, `agent`, `shots`, `users`, `calendar`, `tasks`) in one Chromium behind the rendered nginx stack | same, nginx, Playwright (outside the repo) | Radicale 15450 to 15454, backend 15455 to 15459, nginx 18120 to 18129 |
| `make test-deploy` | `tests/deploy/nginx_check.py` (rendered templates on an unprivileged nginx) and `tests/fail2ban/run.sh` | nginx, fail2ban-regex | 15310 to 15313, 18090 to 18099 |

Do not run two of these at the same time: they share port ranges.

## Resource rules

A small server (8 GB of RAM, no OOM guard) can freeze for hours under parallel browsers.

* ONE Chromium at a time, no parallel or detached node loops.
* `free -m` first; stop if less than 2000 MB is available (`tests/e2e/run.py` and `e2e.mjs` both refuse).
* Every browser command runs under the cap, with a timeout:
  `sudo -n systemd-run --scope --quiet --uid=<uid> --gid=<gid> -p MemoryMax=2G -p MemorySwapMax=0 -- timeout 600 <cmd>`.
  `make test-e2e` does this (`CAP` in the Makefile).
* Reduced matrix: 390x844 and 1280x800, light and dark, EN and FR only where stated.
* Kill everything at the end: the runners tear down their own processes and directories;
  `pgrep -a 'radicale|nginx|chrom|radui'` must show only system services.

## Playwright setup (outside the repository)

The repository gets no `node_modules`. Install once into a directory of your choice
(`tests/e2e/package.json` pins the version) and point the Makefile at it in the git-ignored `.env.local`:

```
mkdir -p "$PW_DIR" && cd "$PW_DIR" && npm init -y
npm install --save-exact @playwright/test@1.65.0 playwright@1.65.0
PLAYWRIGHT_BROWSERS_PATH="$PW_DIR/browsers" npx playwright install chromium
# .env.local
RADUI_PW_DIR=<PW_DIR>
PLAYWRIGHT_BROWSERS_PATH=<PW_DIR>/browsers
```

## Integration additions (`backend/tests/integration/`)

Shared code: `wp10_support.py` (the existing `harness.py` on its own ports, plus the independent oracle).

### S3 letter matrix (`test_wp10_matrix.py`)

Actors send DAV requests straight to Radicale (production plugin plus the rights file the real backend
generated). The expected result of every cell is computed from the MODEL alone: `wp10_support.v_*` apply
Radicale's `Access.check` rules (read from `radicale/app/*.py`) to the letters of the WP3 oracle
`expected()`. Observed statuses are compared cell by cell. 17 methods x 10 roles = 170 cells:

* methods: PROPFIND, REPORT, GET, PUT new, PUT overwrite, DELETE item, MKCALENDAR, MKCOL addressbook, PROPPATCH,
  DELETE collection, PUT whole collection, MOVE item, nested MKCOL, MOVE collection, PROPFIND / DELETE of the
  principal, MKCOL of a top-level name;
* roles: owner, rw grantee, r grantee, non-granted account, admin, the admin on the principal of an account
  that never logged in (before and after the admin created it with MKCOL), the admin and another user on the
  directory of a tombstoned login, the tombstoned login itself (401).

Observed matrix (status per method, in the order above; "-" cells are 403 unless shown):

```
                         PF  RP  GET PUTn PUTo DELi MKCAL MKCOL PPAT DELc PUTc MOVE nest MVc  PFp DELp MKtop
r grantee               207 207 200  403  403  403  403   403  403  403  403  403  403  403  403  403  403
non-granted             403 x17
rw grantee              207 207 200  201  204  200  403   403  403  403  403  201  403  403  403  403  403
owner                   207 207 200  201  204  200  201   201  207  200  201  201  403  405  207  403  403
admin                   same as owner
admin, no principal yet 404 404 404  409  409  404  409   409  404  404  409  404  409  404  404  404  403
admin, tombstoned dir   same as owner
other user, tombstoned  403 x17
tombstoned login        401 x17
```

Findings the matrix confirms: an rw grantee can add, edit, delete and MOVE items but cannot rename, delete,
overwrite or create collections; nobody (admin included) can delete a principal or create a top-level name;
the admin can edit everything below a principal, including the directory of a tombstoned login (data is not
taken down by deleting the account).

`RwWithoutL` builds ONE rule by hand (the carol grant written `rw` instead of `rwl`, header, trailer and
hash recomputed) and shows that `l` alone blocks PROPPATCH: with `rw` the grantee's PROPPATCH is 207 and
DELETE / PUT-whole-collection stay 403.

### Health (`test_wp10_health.py`)

`health` reports the model generation together with `active` (the probe's answer for the model's token) and
`ok` (active AND the file header at the model's generation). Cases: every mutation; an OLD rights file put back
(both `rights` and `rights.lkg`): `{"ok": false, "generation": 3, "active": false, "modelOk": true}` while
Radicale really runs the older rules; repaired by a backend restart (reconcile logs `rolled_forward`) or by any
new mutation; Radicale restarted on a stale `rights.lkg` after the rights file was ruined; corrupt model.

### Shapes (`test_wp10_shapes.py`)

Exact key sets and types of `health`, `me`, `me/access`, `directory`, `accounts`, `grants`, `effective`,
`generations` and the error body, per role (admin, person, bot, bot with grants, own space off). Also lists
the spike checks that are tautologies (see "Spike checks" below) as INFO and skips, never as passes.

### `max_connections` (`test_wp10_perf.py`, only with `RADUI_WP10_PERF=1`)

20 clients, new connection per request, 80 % PROPFIND and 20 % PUT, bcrypt cost 12 hashes, 4 CPUs, 12 s per
setting, plus 4 backend mutations during the load (the anonymous generation probe needs a free slot).

| `max_connections` | requests/s | latency (ms) | transport failures | HTTP 5xx | mutations active within 3 s |
|---|---|---|---|---|---|
| 8 (default) | 12.5 | p50 865, p95 3735, p99 5218, max 6280 ms | 0 | 0 | 3 of 4 (one `202 activation_pending`, 4.3 s) |
| 32 | 13.7 | p50 1268, p95 1544, p99 2349, max 2360 ms | 0 | 0 | 4 of 4 (all under 2.6 s) |

Throughput is bound by CPU (bcrypt cost 12 on 4 CPUs, about 14 requests/s whatever the setting). A larger value
does not add throughput, it removes queueing in front of Radicale: the tail latency halves and the activation
probe is no longer starved. No connection reset was seen in this client model (the spike saw resets behind the
listen backlog of 5; a client that connects in a burst of more than about 13 sockets can still hit it).
**Recommendation: `max_connections = 32`** (the E2E stack uses it, rendered from `RADICALE_MAX_CONNECTIONS`).
Do not enable `cache_logins` for this.

### Spike checks that cannot fail

Reported as INFO, never as PASS: `s02` E/startup/empty-file, `s14` ics/property-order-recorded and `s18`
sequential/cost12-latency-recorded (condition is the literal `True`); `s07` no-restart-needed (a pid compared
with itself, the script never restarts), `s18` throughput-bounded-by-cpu-not-by-slots (an upper bound: a slower
server passes), `s08` transport-errors-explained-by-baseline (passes whenever the baseline also had errors),
`s06` live-cost/read-from-prefix (passes when any cost field was read). The same rule applies to the tests here:
observations are printed as `INFO` (matrix statuses, perf numbers, Radicale's 72-byte truncation).

## Negative-security suite (`tests/security/`)

`secsupport.py` holds the helpers (raw sockets, state snapshots, a canary server). Every rejected request is
followed by a byte comparison of `model.json`, `rights` and `users`.

| Module | Attacker model | What is asserted |
|---|---|---|
| `test_routes.py` | anyone on the path to the backend; a non-admin account; a stolen bot credential | Routes are ENUMERATED from `Api.routes` and cross-checked with the table of `docs/api.md` (a route missing from the doc or from the suite fails). Every non-public route: 401 without credentials and with wrong ones; a disabled admin 401; person and bot 403 on every admin route (also with `dryRun`, also with a broken body: 403 comes first); the admin can use every route; wrong methods 405 with `Allow`; unknown paths 404 |
| `test_requests.py` | a web page on another origin (CSRF), a script sending malformed HTTP | missing or wrong `X-RadUI` (7 values), 14 content types, 11 foreign `Origin` values, 7 `Sec-Fetch-Site` values, 13 bad `Host` values, missing and duplicate `Host`, `Authorization`, `Origin`, `Sec-Fetch-Site`, `X-RadUI`, `Content-Type`, `Content-Length`; 16 KiB exactly vs one byte over, lying `Content-Length`, chunked and every `Transfer-Encoding`, `Expect`, 70 KB request line, 500 headers, 200 KB header; 40 malformed JSON bodies (nesting, duplicate keys at any depth, NaN, 5000-digit integers, BOM, UTF-16, lone surrogates, 129-character strings and keys); unknown and mass-assignment fields (`hash`, `created`, `generation`, `genToken`, `tombstones`); NUL, controls, bidi and format characters in logins, display names, collection names and passwords; query-string and request-target tricks; unusual methods |
| `test_names.py` | an admin browser tricked into submitting names; an account owner choosing names | about 100 hostile logins (`../`, `%2e%2e`, `{0}`, `{user}`, `%`, newline, `.*`, Cyrillic, fullwidth and Kelvin look-alikes, uppercase, reserved, `radui-`, `radui-gen-`) rejected with no change; existing and tombstoned logins 409 (any case); uppercase folded, never stored as typed; a trailing-dot login matches literally; 36 hostile collection names rejected; valid names with regex characters (`a.b`, `a+b`, `a~b`) match LITERALLY (decoys `aXb`, `aab` stay denied); the generation path cannot be created by anyone; grants to an admin, to oneself, to a disabled, unknown or tombstoned account; owner mismatch gives the same 403 whether the owner exists or not |
| `test_escalation.py` | stolen bot credential; SSRF through credential forwarding; address-header injection | The bot cannot create or become an admin, cannot grant itself or others access to collections it does not own, cannot call `directory`, `accounts`, `effective`, `generations`, cannot read other accounts, cannot reset passwords, sees only its own `me` and `me/access` whatever parameters it sends, and reaches Radicale only through its grants; disable, password reset and delete cut the credential at once. SSRF: 17 forwarding headers, 4 Host values naming a canary, 4 absolute-URI request lines, names with URL syntax: the canary server receives nothing; a hostile upstream answering 301, 302, 307 and 308, 5 MiB, entity declarations, 20000-deep XML, 500, HTML or hanging gives 502 and no redirect is followed. Address headers: 19 `X-Real-IP` shapes (valid IPv4 and IPv6 are used, everything else falls back to the peer), client `X-Forwarded-For` ignored, CRLF and folded continuation lines, checked in Radicale's failed-login line (what fail2ban reads) and in the audit log |
| `test_abuse.py` | password guesser; log reader; flaky machine | per-address limiter (5 failures then 429 even for the right password, `Retry-After`, no `WWW-Authenticate`); NO per-login lockout (the admin logs in from other addresses, after failures from 20 addresses); a success does not reset the counter; unknown logins count, malformed headers do not reach Radicale; token bucket 429; 72 bytes is the ceiling in ASCII, 2-byte and 3-byte encodings (73 refused, never reaches Radicale); weak passwords refused; 10 simultaneous mixed mutations give consecutive generations and a valid rights file (3 more rounds of 10 account creations); `kill -9` of the backend during 10 simultaneous mutations, 4 rounds: restart reconciles, health recovers, `check-radicale` passes, model, `rights` and `users` agree; the logs (backend stdout and stderr, Radicale) contain no password, no bcrypt hash, no `Authorization` value and no base64 of any login:password pair used in the run |

### Findings from the negative suite

* **F1 (low)** `server.py`: `Content-Length` is checked with `str.isdigit()`, which is true for `\xb2`, `\xb9`,
  `\xb3` (Latin-1 digits); `int()` then raises, the handler dies and the connection is dropped with a traceback
  on stderr instead of a 400. Reproduction: `POST /ui/api/accounts/x/password` with header bytes
  `Content-Length: \xb2`. Test: `test_content_length_with_a_latin1_digit_is_a_clean_400` (expected failure).
* **F2 (low, information)** `PUT grants` is a login oracle for ANY account that owns a collection: the answers
  200 / 422 (admin or disabled) / 404 (does not exist) tell logins apart although `GET directory` is admin-only.
  Not a defect of a single endpoint; a design decision to record (the 422 also reveals who is an admin).
* **F3 (low)** `authn.client_ip` uses `ipaddress.ip_address`, which accepts a scoped IPv6 address
  (`2001:db8::1%eth0`); the value with `%` reaches Radicale's failed-login line and the audit log. Reproduction:
  `X-Real-IP: 2001:db8::1%eth0`. Whether the fail2ban filter's address pattern accepts it is for WP11 to check.
  Test: `test_scoped_ipv6_is_not_forwarded_finding_f3` (expected failure).
* **F4 (low, tooling)** `tools/hardcode-check.py` crashes with a `ValueError` traceback on a dotted-quad with
  leading zeros (a documentation-range address written with zero-padded octets) instead of reporting or ignoring it. The test builds such a string at run
  time to avoid it.
* **Notes (by design)** Radicale itself ignores everything after 72 bytes of a password (reproduced direct to
  Radicale); the backend refuses longer passwords so no such password exists. Passwords may contain format and
  separator characters (U+2028, U+200B): only control characters (category Cc) are refused. Rotating
  `X-Real-IP` defeats the per-address limiter when the backend is reached directly: it is only meaningful behind
  a proxy that overwrites the header (`tests/deploy/nginx_check.py` proves nginx does).

## Browser end-to-end (`tests/e2e/`)

One suite per capped run: `make test-e2e E2E_SUITE=<name>` (or `tests/e2e/run.py --suite <name> [scenario ...]`, which
also takes scenario names to run alone and `--fast` for the light scheme only). Never two runs at once, never two
Chromium at once. Ports of this part: Radicale 15450 to 15454, backend 15455 to 15459, nginx 18120 to 18129, run
directories under `.throwaway/e2e/` (removed at the end of every run).

| File | Role |
|---|---|
| `run.py` | Renders `deploy/` (the same renderer as `tests/deploy/nginx_check.py`), starts a throwaway Radicale with the production plugin (`max_connections = 32`), the real backend and an unprivileged nginx with the strict headers. COPIES `src/` (or the built `dist/` with `--www-from dist` / `RADUI_E2E_WWW=dist` / `make test-e2e E2E_WWW_FROM=dist`, after `make dist`) into the run directory, builds `sw-manifest.js` there with `tools/build-sw-manifest.py` (never into `src/`), seeds, writes `stack.json`, starts the runner, tears everything down. |
| `e2e.mjs` | The runner: loads `scenarios/<suite>.mjs` (`agent/flows.mjs` for `agent`), runs its scenarios in order, prints PASS / FAIL / TODO / INFO, checks that no log holds a password. |
| `lib/common.mjs`, `lib/ui.mjs` | Pages with their collectors, the per-page audits, DAV and account-service calls from Node, card helpers, the EXIF test JPEG, the form and list helpers. |
| `scenarios/*.mjs` | The suites. |
| `agent/flows.mjs` | The agent-operability suite (accessible names and test ids only). |
| `hostile/cards.mjs` | The hostile cards and collection properties. Every host is a documentation host. |
| `gen_contacts.py` | Deterministic fictional contacts (syllable lists, `example.org`, phone numbers `+1 555 01xx`). |

**Browser.** `channel: 'chromium'` (the full Chromium in its new headless mode). The headless shell ignores
`--unsafely-treat-insecure-origin-as-secure`, so under it the page is not a secure context: no service worker, no
`crypto.randomUUID`. The run-1 harness used the headless shell and never noticed (see finding F2). Override with
`RADUI_E2E_CHANNEL`. Playwright is installed outside the repository (see above). The host name `example.org` is mapped to
127.0.0.1 inside Chromium only.

**Seed data** (real DAV PUTs and the backend API; only the two big books are copied into the storage as files, so that
the first read is cold, as after a restore):

| Account | Data |
|---|---|
| `alice` (admin) | `contacts`: vCard 3.0, 33 contacts (9 named ones from `gen_contacts.core_cards`, 24 generated) and the two Apple-form groups "Family" and "Book club". `contacts40`: vCard 4.0, 15 contacts and one `KIND:group`; read-write grant to bob. Calendars `cal-work` (3 events), `personal` (1). Suite `contacts` and `shots` also: `big-book` (520 cards, file copy). Suite `perf`: `perf-book` (2,000 cards, half 3.0 and half 4.0, 5 % with a photo, file copy). |
| `bob` | `bob-book` (3 contacts, read-only grant to agent-1), `bob-cal` (2 events, read grant to agent-1), a read-write grant on alice's `contacts40`. |
| `agent-1` | The legacy read-write grants on alice's `cal-work` and `contacts`, plus the two read grants of bob. |
| `carol` | `ownSpace = false`, no grants. |

Scenarios that change data make their own address book or calendar through DAV (random name), so no scenario depends
on another and any scenario can be run alone. An "outside" edit (the other writer of the conflict tests, the hostile
cards, a deleted-behind-the-UI collection) is a Node request straight to Radicale.

**Standard per-page checks** (`pageChecks`, run on every page and dialog the suites capture): zero console errors, zero
uncaught page errors, zero CSP violations (`securitypolicyviolation` listener), zero failed requests, zero requests to
another host, no horizontal overflow, every visible control has a Chromium-computed accessible name AND a `data-testid`,
text contrast of 4.5:1 (3:1 large text). With a modal dialog open only the dialog is audited (the page behind it is
inert); controls inside a closed `<details>` are not audited. Console lines the browser writes for answers a scenario
provokes on purpose (412 of a conflict, 404 of a deleted card, the 404 probe of a collection create, net errors while
offline) are matched one by one against the responses seen and listed as expected; any other console error fails.

**Findings.** A check of a defect in `src/` that is certain and reproduced is reported as `TODO <finding id>` and does
not count as a failure (`checkTodo`); when the defect is fixed the same check passes and says so. Nothing else is
marked. The findings of this run are listed under "Findings of the WP10 browser suites" below.

### Suites

| Suite | Checks (last green run) | Content |
|---|---|---|
| `shell` | 765 | The run-1 scenarios (login in FR and EN, wrong password, the native-prompt detector with its positive control, storage, routes, the blocking dialog, language and theme, keyboard and Tab order, agent-1 diagnostics, CSP surface, the 8-combination matrix, the login limiter last). Login lands on `#/contacts`; Tab order is skip link, brand, language, theme, Activity, sign-out, the three nav links, the screen; the PWA manifest is linked and served. |
| `contacts` | 435 | List (sort by family name, A-Z with `#`, accents and ligatures folded in search, phone digits, deep-linked search, group filter), windowing of 520 cards, detail (tel, mailto, export), create with a real JPEG whose EXIF orientation is 6 (stored photo is upright, portrait, at most 256 px, no EXIF), edit one field at a time with a DAV diff of the card, "No changes to save", field errors (`aria-invalid`, `aria-describedby`, summary links, EN and FR), birthday typed and picked in EN and FR order, duplicate hint, delete with the group note and group cleanup, read-only and read-write grantees, an account without an own space, offline banner and disabled writes, a language switch that keeps typed input (search and form), a keyboard-only create, an insecure context (no `crypto.randomUUID`: Create still works with a version-4 UID; with no secure random source at all it shows a persistent message and writes nothing), the placeholder "Choose a contact to see it here" only when the list is not empty, a language switch while a create is in flight (a held PUT: exactly one card). |
| `groups` | 151 | Create in a 3.0 book (Apple form) and a 4.0 book (`KIND:group`), name errors, rename (only FN, N, REV change), add and remove members through the picker and from the contact (only the group card is written, member cards keep their ETags), unknown members kept, delete. |
| `collections` | 253 | The list, create a calendar (errors, hostile colour, collisions by display name, by technical name and by race, the reserved prefix) and an address book, an orphan grant that is revoked before the create and one that cannot be revoked (create refused), edit (and PROPPATCH 403 for a grantee), delete (typed name, export first with the group card, a concurrent change answered 412, grants revoked, grants left behind raise a persistent alert), grantees, no own space, deep links `?dialog=delete|import`, a French phone pass, and the session ending (password reset to a 401, sign-out in a second tab) while the delete dialog is open. |
| `import-export` | 161 | `.vcf` import with skip, replace (lossy confirmation, the server really cuts TITLE) and keep both (MEMBER remapped), a Windows-1252 file, an `.ics` file, vCard 2.1, cancel and Esc before the run, cancel during a 600-card run and resume with skip, the report; whole-book export (group cards left out and counted), single-contact export, the `.ics` export of a calendar, the styled and still labelled file field, and the session ending (401, second tab) while the import dialog is open. Downloads are compared with what the server holds. |
| `conflict` | 191 | An outside PUT while the form is open: the dialog (EN desktop, FR phone dark), reload, overwrite (three-way merge, a second 412, the unmappable confirmation), copy (disabled on a group card with its reason), cancel and Esc, deleted elsewhere (copy, discard, cancel), delete refused (show theirs, delete anyway, cancel), a group card, and the session ending (a password reset behind the page, a sign-out in a second tab) while the conflict dialog is open: the dialog closes, the login screen shows, no DAV or account-service request follows, no credential is left. |
| `pwa` | 91 | Manifest and icons (declared sizes are the real sizes), the worker reaches `activated` and caches exactly the manifest, nothing of DAV or `api/` comes from the worker or sits in a cache, offline reload with the banner, the update flow (a `sw-manifest.js` rebuilt in the run directory with a bumped version, banner, the dirty form asks first, the old cache is deleted), a second tab that goes stale and closes its write gate (review M4), a tampered precached file makes the install fail. |
| `security` | 211 | Hostile cards by DAV PUT (script and img payloads in FN, N, ORG, NICKNAME, NOTE; `javascript:`, `data:`, `vbscript:` URLs; credentials in a URL; an SVG PHOTO in both versions; `VALUE=uri` PHOTO to an outside host; a truncated JPEG, a huge declared PNG, an HTML body as PHOTO; bidi characters; mail and tel values), a 5 MB PHOTO, an export, hostile collection names, descriptions and colour, and ten hostile hashes. Pass: 0 dialogs, 0 CSP violations, 0 requests to another host (every one is aborted and counted), payloads shown literally, no injected element, no `javascript:` link, no photo unless valid. Radicale refuses a PHOTO that is not base64 (400); that is asserted, not rendered. |
| `perf` | 22 | 2,000 file-seeded contacts, a warm-up read, then the numbers below. |
| `agent` | 25 | `agent/flows.mjs`: sign in, create a contact with a photo, edit it, create a group and add a member, resolve a conflict, import a `.vcf`, export, create a calendar, rename it, delete a collection, sign out. Only `getByRole`, `getByLabel`, `getByTestId`; waits only on `data-state` and `data-sync`. The first scenario lints the file (no CSS or XPath locator, no evaluate, no mouse, no coordinates) and proves the patterns on samples. |
| `shots` | 901 | The screenshot matrix, as `<screen>-<viewport>-<scheme>-<lang>.png` in `tests/e2e/shots/`: phone 390x844 and desktop 1280x800, light and dark, EN and FR, for login, list, detail, the new-contact form (empty, errors, filled), the delete dialog, the import dialog, collections (list, new calendar, its errors, the delete dialog); in English also groups, group detail, the edit form and the conflict dialog. Full-page captures can show the fixed skip link or the fixed tab bar in the middle of the page: a capture artefact. |
| `users` | 335 | Run 3a (`scenarios/users.mjs`; its scenarios share the bot account of `create-bot`, so run the suite whole): accounts list (desktop and phone), create a bot (errors, existing login, generated password in the one-time dialog that Esc, the backdrop and a hash change cannot close), sign in as it, non-admin sees no Users entry and `access-required` (bot and carol, desktop and phone, no admin call made), reset password, disable and enable (login fails), no self-lockout, permission matrix (cancel, apply, filter, read-only grantee over DAV and in the browser, account view add and revoke, effective access), share dialog (owner typed login with one unknown login, administrator directory), own space off with the typed login, delete with keep data and delete data, an administrator changes her own password in Settings (typed and generated, reload keeps the session), contacts layout at 1440, 1920 and 390 px, French create form. Screenshots `users-*` and `contacts-layout-*` in `tests/e2e/shots/`. About 100 s. |
| `calendar` | 339 | Run 3b (`scenarios/calendar.mjs`, Europe/Paris browser, 24-hour clock, Monday first through per-login preferences; the seed adds the calendars Work and Home, a book with three birthdays, a read grant for agent-1; every mutating scenario makes its own calendar). Views and navigation (week, month, day, agenda, jump, today, search, bad routes, status line), stable calendar toggles and the fold state, birthdays (age, leap-free duplicates filter, contact link), time zones (the display switcher writes nothing and leaves every ETag alone, two-zone event, unknown zone read-only and deletable, DST-gap preview), create (timed, all-day, validation error), edit and delete, weekly create in another zone with an alarm, edit this / this and following / all and delete this / following / all checked over DAV, the rule-exceptions dialog, move, conflict and Overwrite, read-only grantee and an account without calendars, Settings, a hostile-content event, keyboard and agent operability, phone 390 px, French dark. Screenshots `calendar-*`, `event-*`. About 60 to 110 s. |
| `tasks` | 167 | Run 3c (`scenarios/tasks.mjs`, Europe/Paris browser; the seed `seed_tasks` adds the task lists Tasks (nine tasks relative to today) and Chores (read grant for agent-1)): list, filters, sort and list toggles by URL, one-tap complete and reopen checked over DAV, the repeating task that cannot be completed, second client (412 gives the conflict dialog, Overwrite replays `complete`), create / errors / edit that keeps every other line / no-change save / discard guard / delete, sub-tasks and orphans, empty, no-list and read-only states, navigation and keyboard, phone, French dark. The `.ics` import lives in `import-export` (`ics-import`, `ics-keep-both`, `ics-refusals`, `ics-phone`). |

Run times on the 4-CPU host, each one capped run: `shell` 35 s (the run-1 scenarios took 270 s when the matrix
waited on a missing status line), `contacts` 92 s, `groups` 10 s, `collections` 25 s, `import-export` 45 s, `conflict` 16 s,
`pwa` 15 s, `security` 31 s, `perf` 75 s (24 s of it the warm-up), `agent` 4 s, `shots` about 75 to 165 s.

### Performance (suite `perf`, 2,000 contacts, bcrypt cost of the throwaway stack)

| Measure | Target | Measured |
|---|---|---|
| First read of 2,000 file-seeded cards (Radicale builds its item cache) | n/a | 23 to 24 s (then 0.19 s) |
| Reload to `data-state=ready`, first 250 rows drawn | under 3 s | 1.40 to 1.45 s (median of 3: 1.43 s) |
| Filter and render after a keystroke (debounce excluded) | under 100 ms | worst 40 ms over 35 keystrokes |
| Keystroke to painted, with the 250 ms input debounce | reported | worst about 290 to 300 ms |
| DOM nodes, 250 rows / 500 rows | under 5,000 | 2,157 / 4,163 |
| JS heap after a forced GC (CDP `Runtime.getHeapUsage`), 500 rows | under 150 MB | 7 MB |
| Shipped bytes, whole app tree | reported | 1,189 KB raw, 410 KB gzipped (118 files; JS 1,044 KB raw / 341 KB gzipped, CSS 50 / 14, i18n 115 / 38, vendored 92 / 28, icons 58 / 42) |
| Loaded for the login screen / up to the first contact list | reported | 350 KB in 46 requests / 1,206 KB in 133 requests (raw: nginx does not compress here) |

The 100 ms target is read as "filter and render"; the debounce of the search box is a design decision and is reported
separately. There is no minifier: the 250 KB budget of SPECS 6 is not met (decision Q7 is the owner's).

### Hostile and attacker cases covered

Card data (any account that can write to a book you can read, an imported file, a sync partner): markup and script in
every text property, scripts in an SVG photo, outside-host photos, oversized photos, `javascript:` and `data:` links,
bidirectional control characters, a PHOTO that decodes to nothing. Collection data: markup in names and descriptions,
a CSS-injection colour (`red;background:url(...)`), shown to the owner and to a grantee. URL: ten hostile hashes and
query parameters. Network: every request that leaves the stack is aborted by route interception and counted. The
existing negative suites (`tests/security/`) cover the account service itself.

### Findings of the WP10 browser suites

Found by the first pass of the suites (all reproduced twice) and fixed by the Run 2 fix batch; the same checks are plain
`check`s now and pass:

| Id | Severity | Finding | Now checked in |
|---|---|---|---|
| F1 | low | Controls without a `data-testid` (SPECS 5.3). **Fixed for the contact and group screens** (`contact-phone-link`, `contact-email-link`, `contact-url-link`, `group-member-link`, `name-more-toggle`, `<kind>-more-toggle`). **Still open on the collection screens**: the `<summary>` of a row ("Technical details", `collection-tech`) and of the forms ("Advanced", `collection-advanced`) have none. | every page check; the open part is reported as TODO F1 (collections, shots, security) |
| F2 | low | `crypto.randomUUID` was used unguarded where a page is served over plain http. | `contacts/insecure-context` (two cases) |
| F3 | low | A focused search box kept its old text when the URL changed `q`. | `contacts/list` |
| F4 | medium | The first click on Create was lost after an invalid date (the blur error moved the button). | `contacts/errors`: ONE click lists the problems |
| F5 | low | An untouched calendar edit form wrote a default colour. | `collections/edit`: no PROPPATCH, "No changes to save" |
| F6 | low | Focus was lost to `<body>` after cancelling the conflict dialog. | `conflict/cancel` |
| F7 | medium | An offline cold start on `#/contacts?ab=<book>` said "not found". | `pwa/offline` |

Open at the end of this pass:

| Id | Severity | Finding | Reproduction |
|---|---|---|---|
| F1 (rest) | low | `<summary>` toggles of the collection screens have no `data-testid`. | Any page check of `#/collections` or a collection form. |

Added in the final pass (all pass): a session that ends while the conflict, import or collection-delete dialog is open
(password reset behind the page, and a sign-out in a second tab) closes the dialog, shows the login screen and sends no
DAV or account-service request afterwards (review M1); a language switch during an in-flight create produces one card
(the select is disabled while the create runs); the import file field is styled and still labelled; the placeholder of the
detail pane is hidden for an empty book and for an account without a book.

Observations (not failures): Radicale answers 400 to a PHOTO that is not base64 and to a card without UID, so those cannot
reach the UI. An import row for an invalid or unsupported card shows "(no name)" even when the card has an FN. The
detail pane still says "Choose a contact to see it here" after a search that matches nothing (the book is not empty). A book
that reaches the storage by file copy cannot be listed with correct counts before its first read finishes; the suites
warm it first.

## Round-trip and store integration (WP9)

Two suites drive the contact modules against a REAL Radicale. Both start and remove their own throwaway instance.

### UI operations round trip (`make test-roundtrip`, `tests/roundtrip/ui-ops.test.mjs`)

Runs next to the corpus harness (`run.sh`, simple instance, port 15300 to 15309, one account). Helpers: `uilib.mjs`
(a DAV client that counts requests per method, the form edit registry, the one-edit flow). Every edit goes through
`contacts/formmodel.js` (`toFormValues` -> edit -> `toPatch`) and the model, never straight into the model.

* Form no-op, for every contact fixture of the flat corpus (group cards and `server-refused/` excluded): an untouched
  form gives `{}`, `{changed:false}` and NO PUT; textarea-normalised values change nothing; an unrelated edit keeps
  every ADR, TEL, EMAIL, URL and `X-ABLabel` line (review M1).
* Every single-field form edit (name parts, org, title, note, nickname, rows: value, type, add, remove, custom
  label, bday, anniversary on 4.0, categories, photo new and removed): PUT with If-Match -> GET; the semantic diff
  of the served text before and after names only the edited property (`compare.mjs` machinery, managed properties
  ignored, `X-ABLABEL` / `X-ABADR` allowed for row edits), no lossy allowlist rule fires on writer output, the
  `store/verify.js` projection passes on the GET result, and the served text re-opens as a form that is a no-op.
* Photos (3.0 and 4.0, 3 KB and 150 KB: identical base64; removal), custom-label rows, CATEGORIES with commas and
  semicolons, anniversary (written on 4.0, refused and read-only on 3.0), blank-row cards.
* Groups, both forms: add and remove one member: only the group card changes, member cards keep bytes and ETags,
  unknown (`mailto:`) members pass through.
* Rebase onto a concurrently edited card (`conflict.js` three-way merge, PUT -> GET), a row they deleted is
  `unmappable` and not guessed, a membership change rebases as one delta.
* `.vcf` import (`vcf/import/book-basic.vcf`, a subdirectory the flat corpus loaders do not scan): `planImport` /
  `resolveImport` output PUT -> GET; a row is flagged `lossy` exactly when Radicale damages it; skip, replace
  (stale ETag refused, lossy rows held back until `confirmLossy`) and keep-both with MEMBER remapping.

About 100 tests, about 70 s on the 4-CPU host.

### Store integration (`tests/integration/dav/run.sh`)

`run.sh` runs `dav.test.mjs` on its simple instance (port 15270 to 15279), then `contacts.test.mjs`,
`collections.test.mjs`, `import.test.mjs` and `calendar.test.mjs` on a second stack started by `stack.py`: Radicale with the PRODUCTION
rights plugin, users and rights generated by the real backend, ports 15430 to 15449 (accounts `alice` administrator
and owner, `bob`, `agent-1`; every test creates its own collections through DAV and grants through the account
service). `run.sh store` runs only the second part, `run.sh dav` only the first. `prodenv.mjs` builds one REAL
`createStoreContext` per account (a session, activity log, write gate and recording DAV and API clients); `gen.mjs`
makes deterministic fictional contacts. `account(login, {hook})` takes an async `hook(call)` that runs after every DAV
response and before the app sees it: a test uses it to make ANOTHER client act at an exact moment (an outside PUT between the
two PUTs of a split, or between the copy and the delete of a move).

* `calendar` (Run 3, WP B4): `splitWrite` with a real outside PUT between the tail and the truncated original (the
  compensation leaves exactly the outside version; Overwrite replays the split), `moveItem` between calendars, with an
  outside PUT on the source between copy and delete (addendum M5) and onto a read-only target (local refusal, then the
  server's 403, nothing deleted), the 412 replay of an override operation (Overwrite; an occurrence deleted elsewhere is
  unmappable), and `calendars.js` picking an outside edit up with its next sync.

* `contacts`: access levels (own, readwrite, read), sync / outside edit / sync, the form through `saveItem`
  (no-op sends nothing), a REAL 412 with every resolution (reload, overwrite incl. the unmappable confirmation and a
  second 412, copy, deleted elsewhere, delete anyway), review C1 (a stale base after a sync replaced the store copy
  is a conflict and never overwrites; no `base` is `invalid`; a base/rows mismatch is `invalid`) and M2 (`deleteItem`
  needs the ETag, a stale one is `changed-elsewhere`), both group forms (one PUT on the group card, a stale base
  rebased as a delta), bulk delete with group cleanup, permissions, and the 2,000-contact scale smoke test (seeded
  by PUT, one warm-up read, load, search, save, incremental sync; timings are printed as diagnostics; skipped when
  `RADUI_IT_SKIP_SCALE` is set).
* `collections`: mkcol / mkcalendar, review C2 (an existing shared name sends no grant call and keeps every grant,
  whether or not the access list knows it; a new name with orphan grants revokes them first, before the MKCOL), a
  stale and a fresh collection ETag for delete (also after a PROPPATCH), grants revoked after a delete, grantee
  PROPPATCH and DELETE refused (403) at both layers, `getCollectionText` for both kinds through `store/export.js`.
* `import`: 500 fictional cards with progress and the final report, cancel then resume with `skip`, review M5 (the
  session ending stops the import, no PUT afterwards), policies through the store, a read-only grantee, UTF-8 and
  BOM rules, a UID conflict.

Measured on the 4-CPU host (bcrypt cost 4): whole `run.sh` about 3.5 minutes (the 2,000-contact seed is 140 s: a PUT
costs about 70 ms and grows with the book); 500-card import about 20 s.

## Known gaps

* The service worker is tested in Chromium only; iOS Safari's install and update behaviour is not tested.
* Screen-reader announcements (live regions, dialog announcements) are NOT tested; only the accessibility tree
  names are.
* `max_connections` was measured with new-connection clients on a 4-CPU machine; keep-alive clients and a
  different CPU count shift the numbers, not the conclusion.
* Plain http between Chromium and nginx (the secure-context flag works only in the full Chromium, see the browser
  note above); the TLS vhost is covered by `nginx -t` only.
* The negative suite reaches the backend directly for header-injection cases; the nginx overwrite of
  `X-Real-IP` and `X-Forwarded-For` is covered by `tests/deploy/nginx_check.py`.
* Radicale at DEBUG log level (which may log more) was not tested; production runs at WARNING.
* fail2ban ban behaviour (not the filter) is not exercised.
