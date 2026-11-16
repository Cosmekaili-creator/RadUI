<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Recovery from a root shell

For an operator with a root shell and the placeholders of [CUTOVER.md](CUTOVER.md). The admin CLI
runs as the service user and uses the same lock and the same write code as the API, so it is safe
while the service runs. Command reference: `docs/admin-cli.md`.

```
alias radui='sudo -u radui radui-admin-cli'
```

Start with what is broken:

```
systemctl status radicale radui-admin --no-pager
journalctl -u radicale -n 50 --no-pager
journalctl -u radui-admin -n 50 --no-pager
curl -s -H 'Host: example.org' http://127.0.0.1:5233/ui/api/health      # ok, active, modelOk
radui check-radicale
```

## An account's password is lost, or the only admin cannot sign in

```
radui reset-password <login>            # prints a new password once; the old one stops working
```

It works with the service stopped (add `--no-probe` when Radicale is not running, so the command
does not wait for the activation probe). Hand the password over through a channel you trust and ask
the person to change it.

## Bring back an earlier state of accounts and rights

```
radui show                              # accounts, grants, tombstones and the stored generations
radui restore --generation <N> --dry-run
radui restore --generation <N> --confirm restore-<N>     # becomes a NEW generation
```

A restore never undoes a security action taken since: **tombstoned logins stay deleted, current
password hashes are kept (a reset password is not reverted) and accounts disabled since stay
disabled.** It restores grants, `ownSpace` and admin flags. The dry run lists what would change,
including the accounts dropped because they are tombstoned. A real restore needs the typed
confirmation `restore-<N>` (the CLI option is shown by `radui restore --help`). The last three
generations and the import baseline are kept. `restore` also works when
`model.json` is missing or corrupt (the API then answers `503 model_corrupt` until it is fixed).

## The managed files were damaged, edited by hand, or a change was interrupted

The service compares the files with the model on every start and rolls them forward, and its
**self-heal timer** (every 60 seconds by default) does the same while health is not active and the
rights file on disk differs from the generated text or is invalid. With the backend running this
usually repairs itself within a minute; otherwise `systemctl restart radui-admin` is the first
thing to try. To do it by hand: `radui restore --generation <current generation> --confirm
restore-<current generation>` regenerates `users`, `rights` and `rights.lkg` from the model.
`radui check-radicale` shows whether the files pass Radicale's own engine (it must end with
`users compared`).

## Stale `rights.lkg` (a revoked access may be active again)

`rights.lkg` is the last version proven active, so it can be **older** than the main rights file.
If the main file is damaged and Radicale starts, the plugin runs on `.lkg` and logs a CRITICAL line:
`radui_rights: rights file unusable (...); running on the last-known-good copy ... generation=N source=lkg`.
Anything revoked since generation N is allowed again until the main file is repaired. Treat it as
an incident:

This is the **fail-static** policy: Radicale keeps serving on `.lkg` rather than going offline,
the backend's self-heal timer repairs the main file within one interval while the backend runs,
and the monitor alert on health `ok: false` / `active: false` tells you it happened. If the alert
fires and the timer has not cleared it:

1. Restart the backend (`systemctl restart radui-admin`; it reconciles on start), or
   `radui restore --generation <current generation> --confirm restore-<current generation>`: both
   files are rewritten from the model (restore keeps tombstones and current password hashes). The
   plugin switches to the repaired main file on the next request.
2. `curl ... /ui/api/health` shows `active: true` and `ok: true`; the Radicale journal shows a
   `reloaded` line.
3. Review the audit log (`journalctl -u radui-admin`) for what was revoked between N and now, and
   whether the window was used (Radicale's access log, if enabled).

## The plugin fails to import after a Radicale upgrade

Radicale then refuses to start (the journal names `radui_rights` and an ImportError or an error
that says "Radicale internals changed?" and the installed version). Do not restart in a loop:

1. Get Radicale running: set `[rights] type = from_file` in its configuration (the generated file
   is in `from_file` format), `systemctl restart radicale`. Changes to rights then need a restart.
2. Or put the previous Radicale version back (pip install of the old version, or the package of the
   old version) and restart.
3. Fix properly with [docs/upgrading-radicale.md](../docs/upgrading-radicale.md): run
   `radui check-radicale` against the new version, run the plugin tests, update the plugin, then
   switch back to `type = radui_rights`.

## Radicale will not start

Read `journalctl -u radicale -n 50`. The usual causes:

* **Rights file unusable and no usable `.lkg`:** the plugin raises on purpose (it fails closed).
  `radui restore --generation <N> --no-probe` rewrites both files, then start Radicale.
* **Permissions:** Radicale runs as `radicale` and must read the managed files: the directory is
  `2750 radui:radicale`, the files `0640`, and every parent directory must be searchable by the
  Radicale user. `ls -ld /etc/radui /etc/radui/managed; ls -l /etc/radui/managed`.
* **`PrivateTmp=yes` missing** from the drop-in (the plugin reports that its private temporary
  directory is not usable).
* **A typo in the configuration:** compare with `deploy.local/rendered/radicale/config-snippet.ini`.
* Nothing obvious: Rollback A or B in [ROLLBACK.md](ROLLBACK.md), restart, investigate afterwards.

## The backend will not start, or answers 503

* Config errors are printed once and the process exits with status 2:
  `journalctl -u radui-admin -n 20`; fix `/etc/radui/config.toml` (it must not be group- or
  world-writable) and `systemctl restart radui-admin`.
* `503 model_corrupt` on every endpoint except `health`: see "Bring back an earlier state" above.
* `503 busy` or exit code 5 from the CLI: another change holds the lock for more than 10 seconds;
  look for a stuck `radui-admin-cli` process.
* The service starts "read-only" after a failed reconcile (`model_error`, `validation_failed`
  in the log): `radui restore --generation <N>`.

## The app is stuck on a broken version in browsers (service worker)

Symptom: after a bad web-app deploy, clients keep showing the old or a broken app even though the server
files are right. First deploy a fixed version with `tools/deploy-static.sh` (see
[docs/UPGRADE-UI.md](../docs/UPGRADE-UI.md)); clients pick it up through the update banner. If they cannot
(a worker that serves a broken tree), install the self-unregistering worker as `sw.js` by hand, wait a day
or more, then deploy the real version again. The worker code and the steps are in
[docs/pwa.md](../docs/pwa.md) ("Recovery: removing a bad worker"). Check first that `sw.js` and
`sw-manifest.js` are served with `Cache-Control: no-cache`:

```
curl -sI https://example.org/ui/sw.js | grep -i cache-control
curl -sI https://example.org/ui/sw-manifest.js | grep -i cache-control
```

A web-app deploy is undone with the `tar -xzf ...` command printed by the deploy tool (backups are
`<dir>.before-<tag>-<date>.tar.gz`, mode 600).

## A client address was banned or throttled

```
fail2ban-client status radui-radicale-auth
fail2ban-client set radui-radicale-auth unbanip <address>
```

Add static addresses of administrators to `F2B_IGNOREIP` in `deploy.local/vars.env`, render, install
the jail again, reload fail2ban. An nginx `429` on `/ui/api/` is the rate limit (`API_RATE`,
`API_BURST`): wait a minute. The backend's own limiter blocks an address for 15 minutes after 10
failed logins in 10 minutes (it answers `429` with `Retry-After`); a service restart clears it.
The limit is per address and there is no per-login lockout, so on a **shared address** (an office,
a carrier) one person's mistakes can block everyone there, including the admin. From the root shell
none of this matters: `radui reset-password <login>` and the other CLI commands do not go through
the network, and `systemctl restart radui-admin` plus `fail2ban-client set radui-radicale-auth
unbanip <address>` release the blocks. If the address the limiter shows is always `127.0.0.1`, the
proxy header is not being honoured: check `trusted_proxies` and the nginx overwrite of `X-Real-IP`.

## Last resort

Rollback B returns to the files that existed before RadUI. Nothing in RadUI modifies them.
