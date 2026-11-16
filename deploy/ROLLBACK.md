<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Rollback

Placeholders as in [CUTOVER.md](CUTOVER.md): `radui`, `radicale`, `/etc/radui`, `/var/lib/radui`,
`/opt/radui`, backups in the archive directory `$A` with names `<thing>.before-radui-<date>`.
Use the values of your own `deploy.local/vars.env`.

Choose the smallest rollback that fixes the problem:

| Situation | Use |
|---|---|
| The plugin or the generated rights misbehave, but the generated `users` and `rights` files are fine and you want to keep the accounts and grants made in RadUI | **Rollback A** |
| Back to exactly the configuration before the cutover | **Rollback B** |
| Only the API or nginx are wrong | **Rollback C** (nginx), Radicale is untouched |
| The fail2ban jail bans the wrong clients | **Rollback D** |
| A new version of the static web app is broken (not nginx) | **Rollback F** |
| The backend itself is the problem and Radicale runs fine | **Rollback E** |

The original `users` and `rights` files are never modified by RadUI, so Rollback B is always
possible. The generated files and RadUI's own state stay on disk under both rollbacks.

## Rollback A: Radicale's own `from_file` on the generated files

The generated rights file is in Radicale's standard `from_file` format (the first and last lines are
comments). Radicale keeps using the same `users` file, so every account and password created in
RadUI keeps working. What is lost: changes to rights take effect **only after a Radicale restart**
from now on: after the next change in RadUI its health shows `active: false` until Radicale is restarted.
The monitor alert on `active: false` (a cutover prerequisite) will fire: silence or remove it for
the duration of this rollback. The backend's self-heal timer only rewrites a managed file that
differs from its model; stop the RadUI service to freeze the files completely.

1. In Radicale's configuration set `[rights]` `type = from_file` (keep `file = <managed dir>/rights`,
   `permit_delete_collection = False`, `permit_overwrite_collection = False`).
2. `systemctl restart radicale` (1 to 3 seconds of refused connections).
3. `journalctl -u radicale -n 20`: no error.
4. Check a sync from a real client.

The drop-in can stay (`PYTHONPATH` and `PrivateTmp=yes` are harmless). To keep working in this
state, stop the RadUI service or accept that its changes need a Radicale restart.

## Rollback B: restore the configuration from before the cutover

What is lost: everything done in RadUI after the cutover (new accounts, new passwords, grants).
If you need to keep some of it, take the generated files out first:
`cp -a /etc/radui/managed /root/radui-managed.<date>` (mode 700 directory, delete it later), or use
Rollback A instead.

1. `systemctl stop radui-admin` (so nothing writes while you restore).
2. Restore the configuration: `install -m <original mode> -o root -g radicale $A/radicale-config.before-radui-<date> /etc/radicale/config`
   (use the owner and mode the original had; compare with `ls -l` of the backup's source).
3. Remove the drop-in: `rm /etc/systemd/system/radicale.service.d/radui.conf`, then `systemctl daemon-reload`.
   (If the unit had a drop-in directory before, restore it from the unit tarball instead.)
4. The original `users` and `rights` files were never touched; confirm with `cmp` against the backups.
5. `systemctl restart radicale`; `journalctl -u radicale -n 20`; check a client sync.
6. Leave the RadUI files in place (disabled) or remove them (Rollback E). Remove the monitor
   alert on the RadUI health answer, or it will report a stopped backend.

## Rollback C: nginx

1. `install -m 0644 $A/vhost.before-radui-<date> <vhost file>` (the backup made in step 10).
2. `nginx -t && systemctl reload nginx`.
3. Remove the snippets if you want: `rm /etc/nginx/snippets/radui-*.inc /etc/nginx/snippets/radui-locations.conf /etc/nginx/conf.d/radui-http.conf`
   (a leftover `radui-http.conf` is harmless).
4. If the fail2ban jail is on, switch it off too (Rollback D): the jail must not run without the
   nginx address overwrite.

## Rollback F: the static web app files

Only for a deploy made with `tools/deploy-static.sh`, which prints the exact commands and keeps a mode-600
backup `<dir>.before-<tag>-<date>.tar.gz` ([docs/UPGRADE-UI.md](../docs/UPGRADE-UI.md)).

1. Restore the backup: `tar -xzf <backup> -C <parent of the served directory>`.
2. **If the backup has no `sw.js`** (the very first deploy of the service worker), this is not enough: the
   restore leaves the new `sw.js` and `sw-manifest.js` in place, and browsers that installed the new worker keep
   serving the new app from their cache. Also run
   `rm -f <served dir>/sw-manifest.js` and
   `install -m 0644 deploy/sw-selfdestruct.js <served dir>/sw.js`. That worker deletes the clients' caches,
   unregisters itself and reloads the pages. Keep it served with `Cache-Control: no-cache` for at least a day
   (longer for devices opened rarely), then delete `sw.js`.
3. Check: `curl -sI https://example.org/ui/sw.js` shows `no-cache`; a browser that had the new version open
   reloads onto the old app.

## Rollback D: fail2ban jail

```
fail2ban-client set radui-radicale-auth unbanip <address>          # to release one address
fail2ban-client stop radui-radicale-auth                           # to stop the jail now
rm /etc/fail2ban/jail.d/radui-radicale-auth.conf /etc/fail2ban/filter.d/radui-radicale-auth.conf
systemctl reload fail2ban
```

## Rollback E: remove the backend

Radicale must not depend on it: check that `[rights] type` is `from_file` or that you accept the
plugin staying configured without the backend (the plugin does not need the backend to run; it only
watches the rights file).

```
systemctl disable --now radui-admin
rm /etc/systemd/system/radui-admin.service && systemctl daemon-reload
rm -r /opt/radui/backend /usr/local/bin/radui-admin-cli
# only if you are sure you do not want the accounts and history any more:
# rm -r /var/lib/radui /etc/radui/config.toml
userdel radui
```

`/etc/radui/managed` is read by Radicale under Rollback A: do not delete it then.

## After any rollback

Record what happened and why, keep the backups, and re-run the checks of CUTOVER.md step 9 on a real
client. A later restore of a RadUI generation (not a rollback) keeps tombstones and current password
hashes, so it does not bring back accounts or passwords removed since; see RECOVERY.md. Do not delete the generated files or the state directory until you know why the cutover was
rolled back.
