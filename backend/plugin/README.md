<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# radui_rights: Radicale rights plugin with hot reload

`radui_rights.py` lets Radicale pick up a changed rights file on the next request,
without a restart, while Radicale's own `from_file` code stays the only rule matcher.
It also refuses any rights file that does not pass the integrity checks below, so a
truncated, tampered or half-written file can never replace working rules.

It is a single module with no dependency except Radicale. It never imports anything from
the RadUI admin backend.

## Install and configure

1. Copy `radui_rights.py` somewhere only root can write, for example `/opt/radui/plugin/`
   (owner root, mode 0644).
2. Make it importable by Radicale and give the service a private `/tmp` (systemd drop-in,
   for example `/etc/systemd/system/radicale.service.d/radui.conf`):

   ```ini
   [Service]
   Environment=PYTHONPATH=/opt/radui/plugin
   PrivateTmp=yes
   ```

   `PrivateTmp=yes` is required: the plugin parses a private temporary copy of the exact
   bytes it validated, so that the bytes checked and the bytes parsed cannot differ. Another
   local user must not be able to see or replace that file.
3. Radicale configuration:

   ```ini
   [rights]
   type = radui_rights
   file = /etc/radui/managed/rights
   permit_delete_collection = False
   permit_overwrite_collection = False
   ```

   `file` is the managed rights file written by the admin backend. `file + ".lkg"` is the
   last-known-good copy. The two `permit_*` settings make a missing `D` or `O` letter mean
   "no", which is what the generated rules assume.
4. Run Radicale at log level `warning` or lower: the plugin's one startup line and every
   reload are logged at WARNING, because INFO lines never appear in a production setup.

The rights file is only ever replaced by an atomic rename. The plugin copes with in-place
writes (it re-reads on a changed signature and rejects a torn file), but nothing else
should write it that way.

## What the plugin accepts

A rights file is accepted only if all of this holds. The plugin has its own check (it does
not trust the writer and never imports the admin backend), and since the fix of finding m3
it is **exactly as strict as the backend validator** `radui_admin.rightsfile.check_text`:
the rules are duplicated here, and a parity test
(`backend/tests/plugin/test_parity.py`) runs named and generated malformed files through
both and requires identical accept/reject decisions.

- the file is not empty, is ASCII only (so no BOM and no UTF-8), has no control character
  except the line feed (so no NUL, no CR/CRLF, no TAB, no DEL) and is at most 4 MiB (the one
  plugin-only rule: a size guard);
- the first line is `# radui-admin generated; DO NOT EDIT. generation=<N>`;
- the last line is `# radui-end generation=<N> sha256=<hex>` (lower-case hex, `N` without
  leading zeros), with the same `N` in both, ended by exactly one newline: a missing final
  newline, trailing whitespace or a blank line after the trailer is refused. The hash is the
  SHA-256 of every byte before that line;
- it has at least one section, there is no `[DEFAULT]` section (any case, with or without
  keys), section names are unique, match `[A-Za-z0-9._-]{1,100}`;
- the last section is `[zzz-deny]` with `user: .*`, `collection: .*` and empty
  `permissions`;
- every section has exactly the keys `user`, `collection` and `permissions`: a missing key
  (including `user`), an unknown key and any `groups` key are refused;
- values are printable ASCII and contain none of `{`, `}`, `%`; `user` and `collection` are
  not empty;
- every `permissions` value uses only the letters `R W r w D O i l`, each at most once;
- every `user` and `collection` pattern compiles as a regular expression (after the
  `.format()` substitution Radicale applies at request time; with braces refused this is the
  identity, so a bad regex is refused instead of turning into HTTP 500 on every request);
- the text is canonical: re-rendering the parsed sections (`key: value` spelling, keys in
  the order user, collection, permissions, one blank line after each section, no comments)
  reproduces the body byte for byte, so nothing hides in a spelling the backend never writes;
- Radicale's own parser accepts it and finds the same section list.

**Generation probe contract.** The plugin serves no probe of its own. The generated file
must contain a rule that lets an anonymous request reach an unguessable path, for example
`user: ^$`, `collection: ^radui-gen-<random token>$`, `permissions: i`. The backend sends
an anonymous `GET` to that path after writing a file: HTTP 404 means the new generation is
active, 401 means it is not yet. The plugin only requires that the file as a whole passes
the checks above.

## How a change is detected

Every request compares the file's `(st_ino, st_mtime_ns, st_ctime_ns, st_size)` with the
signature recorded at the last read. A changed signature triggers a read, with the file
stat'ed before and after and re-read if it moved. The SHA-256 of the content decides whether
anything changed: same hash means no rebuild, different hash means validate, build, swap.

A file whose newest timestamp is younger than 2 s when it is read is "unsettled": it is
re-read and re-hashed on every request until it settles. This closes the window in which an
equal-length rewrite inside one timestamp granule could keep an identical stat signature.
After the window, a rewrite that restores `mtime` with `utime` still changes `ctime`.

All state is one immutable tuple (engine, signature, hash, generation, source, failure
record) replaced by a single assignment, so a request sees one consistent version. The state
is module-level and shared per rights file path: Radicale builds its rights object twice
(application and sharing), and both see the same rules, with one startup line.

A request that already passed its authorization when a change lands finishes under the
rules it started with (a PUT is authorized before its body is read, so a slow upload that
began before a revocation can still complete). The next request is already under the new
rules.

## Failure modes

| Situation | What happens | Log |
|---|---|---|
| New file fails any check at runtime | Old rules stay in force. The file's signature and hash are remembered: it is not re-read on every request. A new write retries. | one ERROR per rejected version |
| Rights file missing or unreadable at runtime (deleted, EACCES) | Old rules stay in force; no re-read until the stat signature changes. When it is usable again with the same content, nothing is rebuilt. | one ERROR; WARNING "usable again" |
| File changes while it is being read | Re-read up to 5 times; if it never settles the old rules stay | ERROR once |
| Startup: main file unusable, `.lkg` usable | Starts on `.lkg` (see below); keeps watching the main file and switches to it as soon as it is valid | CRITICAL naming the reason and the `.lkg` generation, then the WARNING "active" line |
| Startup: main file missing, `.lkg` usable | Same | same |
| Startup: both unusable | The constructor raises, Radicale does not start (fail closed). The message names the installed Radicale version, the tested range and the `check-radicale` procedure | Radicale's startup error |
| Radicale outside the tested range (3.9.x) | Works as long as the internals below still match; otherwise a failure above | one WARNING |
| Radicale internals changed in an incompatible way | The file is treated as unusable (the message says "Radicale internals changed?") | as above |
| Private temporary directory not writable | Every file is treated as unusable | as above |

### Stale `.lkg`

The `.lkg` copy is written by the backend after it has seen a generation become active.
It can therefore be **older than the main file**, and it can contain access that was revoked
since. If the main file is damaged and Radicale restarts, the plugin runs on the stale
copy, and revoked access is active again until the backend regenerates the file. The
CRITICAL line says which generation is running (`generation=N source=lkg`). Treat it as an
incident. The tests show the exact behaviour (`test_g_stale_lkg_regrants_revoked_access` in
`backend/tests/plugin/test_startup.py`).

**Policy: fail-static, not fail-closed.** Falling back to `.lkg` keeps every DAV client
working; refusing to start would take all of them down. The price is accepted knowingly: a
stale `.lkg` may re-grant access that was revoked since the last confirmed activation (the
exposure is the generations after that activation, usually none or one). Two backend
mechanisms repair it: the **self-heal timer** (the backend periodically compares the file on
disk with the text generated from its model and, when the file is invalid or different,
reconciles it), and the reconcile that a **backend restart** runs on start. Once the main
file is valid again the plugin switches to it on the next request. Health reports
`active: false` while the plugin is not on the confirmed generation; a monitor alert on that
state is a deployment prerequisite.

## Radicale internals this plugin touches

Verified against Radicale 3.9.0. Re-check each one on every Radicale upgrade.

| Internal | Used for |
|---|---|
| `radicale.rights.BaseRights` | base class; constructor takes the configuration; `authorization(user, user_groups, path)` returns the letter string. The plugin forwards `*args, **kwargs` so a changed signature does not break it. |
| `radicale.rights.from_file.Rights(configuration)` | the stock matcher, built from a private temporary copy of the validated bytes |
| `from_file.Rights._rights_config` (ordered dict, section name to `user_pattern`, `collection_pattern`, `allowed_groups`, `permission`) | cross-check that Radicale's parser sees the same sections as the plugin's check; the pattern semantics of `authorization` (`.format()`, group substitution) are mirrored in the compile check |
| `Configuration.copy()` and `Configuration.update({"rights": {"file": path}}, source)` | point a private matcher at the temporary copy (also how `.lkg` is loaded) |
| `radicale.log.logger` | all log lines |
| `radicale.VERSION` | the range warning and the startup failure message |
| `radicale.utils.load_plugin` | loads this module by its `type` name and instantiates `Rights(configuration)`; it runs twice |

## Upgrade procedure

1. Before restarting onto a new Radicale version, run `radui-admin-cli check-radicale`
   (the admin backend's pre-restart check) in the new Radicale environment, as the user Radicale runs as.
   It must pass before the restart.
2. If the version is outside 3.9.x, read the Radicale changelog for `rights`, `config`
   (`copy`, `update`) and `log`, and diff `radicale/rights/from_file.py` against the version
   in the table above.
3. Run the plugin tests against a throwaway Radicale of the new version:
   `RADICALE_BIN=<path to the new radicale> python3 -m unittest discover -s backend/tests -p 'test_*.py'`
   (the plugin tests are in `backend/tests/plugin/`).
4. Restart Radicale, check the log for the single WARNING "active" line and no CRITICAL,
   and check that the backend reports the current generation as active.
5. After a successful run on a new version, extend `TESTED_SERIES` in the module.

Fallback when the plugin breaks and cannot be fixed quickly: set `type = from_file` and
restart Radicale. The file stays in standard `from_file` format; changes then take effect
only on restart.

## Tests

`backend/tests/plugin/` holds unittest-based tests. Every test starts throwaway Radicale
instances (ports 15380-15389, directories under the git-ignored `.throwaway/`) with this
plugin loaded through `PYTHONPATH`, or runs in-process under the Radicale interpreter. They
need `RADICALE_BIN` (environment or `.env.local`) and skip when Radicale is not found. The
rights files are rendered by a local helper in `support.py`, not by the backend.

Under 20 parallel clients Radicale's short accept queue occasionally resets a connection
before any HTTP exchange (the kernel's `ListenOverflows` counter rises, the Radicale log has
no traceback). The concurrency tests retry such a request, count it, and report the count;
they never tolerate an HTTP 5xx.
