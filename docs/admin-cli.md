<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Admin CLI and recovery

`radui-admin-cli [--config FILE] <command>` runs on the host, as the user that owns the
state directory (the same user as the service). It uses the same write code as the API
and takes the same `flock` on `<state_dir>/.lock`, so it is safe while the service
runs; if the service holds the lock for more than `lock_timeout_s` the command exits 5.
Configuration: `--config`, else `RADUI_CONFIG`, else `/etc/radui/config.toml`.
Both launchers (`radui-admin`, `radui-admin-cli`) run `python3 -I` and add their own
package directory to `sys.path`.

## Commands

| Command | What it does |
|---|---|
| `import --admin LOGIN [--admin ...] [--users F] [--rights F] [--collections F] [--report F] [--dry-run]` | Reads a legacy Radicale `users` and `rights` pair (defaults: Radicale's `/etc/radicale/users` and `/etc/radicale/rights`), makes the named logins admins and every other login a bot, rebuilds grants, generates generation 1, validates it with Radicale's own engine and prints the equivalence report (old against new effective rights). Writes nothing if there is an error or an unexplained difference; refuses when a model already exists. `--collections` is a JSON file `{owner: [collection, ...]}` for legacy wildcard rules. Generation 1 is kept as a baseline. |
| `check-radicale` | Validates the managed `users` and `rights` files, and compares them with the model when it loads, using the Radicale interpreter (`radicale_python`, `-I`). Run it before restarting Radicale after an upgrade. It fails (exit 1) when the users file could not be checked with Radicale's own parser (`users parsed only`, for example after a Radicale change of internals) unless the configuration says `allow_unchecked_users = true`; run it as the user that owns the managed files and expect `users compared`. |
| `reset-password LOGIN [--no-probe]` | Generates a new password, stores its hash and prints the password once. |
| `restore --generation N [--dry-run] [--confirm restore-N] [--no-probe]` | Makes the stored generation `N` the base of a new generation. Tombstones, current password hashes and the current `disabled` state stay as they are now (a deleted login is not revived, a reset password is not reverted, a disabled account is not re-enabled); grants, `ownSpace` and `admin` flags come from `N`; accounts created after `N` are removed. `--dry-run` prints the dropped accounts, grants added and removed and flags changed and writes nothing. Without `--dry-run` the flag `--confirm restore-N` is required (exit 2 otherwise). Works when `model.json` is missing or corrupt (then `N` is used as it is). Same semantics as the API. |
| `show` | Accounts, grants, tombstones and stored generations, without hashes. |
| `smoke --radicale-url URL --admin-login LOGIN` | Creates a temporary bot, checks root and own principal (207), another principal (403), MKCALENDAR and DELETE in its own space (201, 200), an optional admin view (password in `RADUI_SMOKE_ADMIN_PASSWORD`), deletes the account and checks its login is refused (401). The empty principal directory of the temporary login stays in the storage (nobody may delete a principal over DAV) and its login stays tombstoned. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | a check or the smoke test failed |
| 2 | usage or configuration error |
| 3 | refused: unknown login or generation, a model already exists, lockout rule, validation |
| 4 | import has errors or unexplained differences |
| 5 | busy: another change holds the lock |
| 6 | model missing or corrupt |
| 7 | the generated files failed validation (nothing was changed) |

## Recovery from a root shell

Run as the service user, for example `sudo -u radui radui-admin-cli ...`.

* **Locked out (password lost):** `reset-password <login>`; the new password is shown once.
* **Model corrupt or missing** (`health` shows `modelOk: false`, API answers 503
  `model_corrupt`): `show` lists the generations still stored; `restore --generation N`
  picks one. The running service notices the new model by itself. The last three
  generations and the import baseline are kept in `<state_dir>/generations/`.
* **Managed files damaged or edited by hand:** `check-radicale` shows it; Radicale keeps
  its old rules at runtime (the plugin refuses a bad file) and `rights.lkg` is the copy it
  starts from. `restore --generation <current> --confirm restore-<current>` regenerates
  both files from the model; restarting the service does the same (it reconciles on every
  start). While the service runs, its self-heal timer (`self_heal_interval_s`, default 60 s)
  rewrites damaged or stale managed files by itself after validating them.
* **Crash in the middle of a change:** nothing to do. On start the service compares the
  managed files with the model, validates, rolls them forward and writes the audit line of
  the interrupted change (from its intent record; a generic `reconcile` line without one).
* **Plugin or Radicale problem that cannot be fixed quickly:** set `type = from_file` in
  Radicale's `[rights]` section and restart Radicale; the file is in the standard format.
  Changes then take effect only after a restart.
* **Back to the original files:** the original `users` and `rights` of the legacy setup
  are never modified by RadUI; pointing Radicale's configuration back at them and
  restarting is the full rollback (changes made since are lost unless the managed files
  are copied first).
