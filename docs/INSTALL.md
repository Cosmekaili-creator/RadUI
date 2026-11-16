<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Installation

RadUI has three parts that you install on the host that runs Radicale:

* the **web app**: static files (HTML, CSS, ES modules), served by your reverse proxy under `/ui/`;
* the **admin backend** `radui-admin`: a small Python service on a loopback port that is the only
  writer of Radicale's password and rights files (accounts, passwords and who may see what);
* the **rights plugin** `radui_rights.py`: loaded by Radicale, it re-reads the generated rights
  file when it changes, so a rights change needs no Radicale restart.

All host-specific values (names, paths, ports) come from one variables file and are rendered into
the configuration files. This page uses the neutral placeholders `example.org`, `radui`,
`radicale`, `/etc/radui`, `/var/lib/radui`, `/opt/radui` and `/var/www/radui-ui`; replace them in
your own `deploy.local/vars.env` (git-ignored).

## Supported versions

| Component | Supported |
|---|---|
| Radicale | the **3.9** series (tested on 3.9.0). Other versions: see [upgrading-radicale.md](upgrading-radicale.md). The plugin warns when the version is outside the tested range and refuses to run if the internals it uses have changed. |
| Python (backend and CLI) | needs the standard library `tomllib` (Python 3.11 or newer); only 3.13 is tested |
| Python modules | `bcrypt` for the system interpreter (Debian: `python3-bcrypt`); Radicale's own environment needs bcrypt for `htpasswd_encryption = bcrypt` |
| Reverse proxy | nginx (templates provided). Another proxy works if it reproduces the same header rules, see [SECURITY-MODEL.md](SECURITY-MODEL.md) |
| Init system | systemd (units and tmpfiles provided) |
| Browser | a current evergreen browser with ES modules and `fetch` |
| fail2ban | optional (a filter and a jail are provided); 1.x with the systemd backend |

The app is served as static files and there is no Node.js on the server (the deploy tool needs `bash`,
`python3`, `tar`, `sha256sum` and the usual coreutils). The minified files are built from this repository, which is
the source (AGPL-3.0-or-later), on the machine where you deploy from: `make dist` needs `python3`, `node` and
(optional) `terser` (Debian/Ubuntu package `terser`, or `npm i -g terser`; without it `make dist DIST_FLAGS=--no-minify`). End users: [user-guide.md](user-guide.md). No Docker image is provided.

## What you need first

* A working Radicale 3.9 behind nginx over HTTPS, with `[auth] type = htpasswd` and bcrypt
  hashes. RadUI replaces hand-edited `users` and `rights` files: an existing setup is imported once
  (below); a new Radicale can start from an empty model, see "First admin".
* Root on the host, and the Radicale user and group names (the examples use `radicale`).
* A host name with a TLS certificate (`example.org`).
* Python's `bcrypt` module for the system interpreter (`/usr/bin/python3 -c 'import bcrypt'`).
* The release tree on the host: `backend/`, `deploy/`, `tools/`, `src/`.

## Step order

1. **Variables.** `cp deploy/vars.example.env deploy.local/vars.env` and edit every value (each one
   is documented in the file). Check: `python3 tools/render-deploy.py --vars deploy.local/vars.env --check`.
2. **Render.** `python3 tools/render-deploy.py --vars deploy.local/vars.env --out deploy.local/rendered`.
   The render stops with a message when a variable is unset, empty or contains a character that
   could break a configuration file, and when any placeholder is left over.
3. **Install the backend** (user, directories, code, plugin file, configuration, systemd unit).
   `deploy/install-backend.sh --vars deploy.local/vars.env` is a dry run that prints every step;
   add `--apply` as root to do it. It never touches Radicale, nginx or fail2ban, makes a copy of
   anything it replaces (`<thing>.before-radui-<date>`, mode 600) and is safe to run again.
4. **Create the first model** by importing your current files, or start empty (next section).
5. **Switch Radicale** to the generated files and the plugin (one restart), then **nginx**
   (`/ui/`, `/ui/api/`) and, in the same window, **fail2ban**. These are changes to running
   services: follow [deploy/CUTOVER.md](../deploy/CUTOVER.md), which has the checks after each step
   and [deploy/ROLLBACK.md](../deploy/ROLLBACK.md) for the way back. Radicale itself is not changed
   by the install script.
6. **Build and deploy the web app**: commit, then `make dist`, then (a `-dirty` build is refused by `--apply` unless `--allow-dirty` is given) `tools/deploy-static.sh --src dist ...` (below), not a bare copy: the app is an
   installable app with a service worker that precaches every file with a SHA-256, and the tool builds
   that file list (`sw-manifest.js`), copies the files in the order the worker needs (the manifest,
   `sw.js` and `index.html` last), checks every hash afterwards and keeps a backup. First installation
   (dry run first, then `--apply`; the tool never calls `sudo`, so run it with the rights the directory needs):

   ```
   tools/deploy-static.sh --dest /var/www/radui-ui --init
   tools/deploy-static.sh --dest /var/www/radui-ui --init --backup-dir /var/backups/radui --apply
   ```

   `/var/www/radui-ui` is the `UI_DIR` of your variables file. The first installation copies the shipped
   `config.json` next to `index.html`; it holds the app's settings (see [app-shell.md](app-shell.md)) and is
   never overwritten afterwards. The defaults work when the app is served under `/ui/` of the same host
   as Radicale. The nginx location `= /ui/sw-manifest.js` (in `radui-locations.conf`, `Cache-Control:
   no-cache`) must be active before clients rely on updates. Later versions: [UPGRADE-UI.md](UPGRADE-UI.md).
7. **Sign in** at `https://example.org/ui/` as the first admin.

## First admin

The admin backend has no default account and no default password: until a model exists it answers
`503` to everything but `health`.

* **Existing Radicale setup:** `radui-admin-cli import --admin <login> --users <users file>
  --rights <rights file> --dry-run` reads your legacy files, makes the named login an admin and
  every other login an ordinary account (type `bot`) with the grants the old rules gave it, and
  prints an equivalence report (what each login could do before and after, every difference
  explained). Review it, then run it again without `--dry-run`. Your original files are only read.
  Details and the review rules: [deploy/CUTOVER.md](../deploy/CUTOVER.md) step 3.
* **New installation:** the importer needs a legacy pair, so give it a minimal one that contains
  just your first login: an htpasswd file with one bcrypt line (`<login>:<bcrypt hash>`) and this
  rights file, then import with `--admin <login>`; create the other accounts afterwards through
  the API or the web app.

  ```
  [root]
  user: .+
  collection:
  permissions: R

  [principal]
  user: .+
  collection: {user}
  permissions: RW

  [own]
  user: .+
  collection: {user}/[^/]+
  permissions: rw
  ```

  A person's password is never recovered by e-mail: an admin resets it
  (`radui-admin-cli reset-password <login>` prints a new one, once).

## Language

The app ships with **English and French**. The language follows the browser unless
`defaultLanguage` in `config.json` says otherwise, and each user can switch it. To add a language,
add `src/i18n/<code>.js` (and its part files) with exactly the keys and `{placeholders}` of `en.js`,
and add the code to `SUPPORTED_LANGUAGES` in `src/js/i18n.js` (the app loads only the active language
on demand); the test suite fails when a dictionary has a missing, extra or empty key or different
placeholders.

## Source offer (`sourceUrl`)

RadUI is AGPL-3.0-or-later (section 13: users of a network service may get its source). Settings, About
shows the licence and, when `sourceUrl` in `config.json` is set, a link to the source code. **If you run a
modified version, set `sourceUrl` to an `https:` address where your modified source is available.** Left
empty (the default), About shows "The source code of this service is available from its administrator."
Only `https:` addresses are accepted.

## nginx

`deploy/nginx/` has four templates, rendered by step 2:

| File | Where it goes |
|---|---|
| `radui-http.conf` | `http {}` level (for example `/etc/nginx/conf.d/`): media types for `.mjs`, `.webmanifest`, `.ics`, `.vcf`, and the rate-limit zone for the API |
| `radui-security-headers.inc` | included in **every** location (nginx drops inherited `add_header` lines in a location that has one of its own) |
| `radui-proxy-headers.inc` | included in every proxied location: overwrites `X-Forwarded-For` and `X-Real-IP` with the client address and clears `X-Forwarded-Host`, `X-Remote-Addr`, `Forwarded` and the other headers Radicale could trust |
| `radui-locations.conf` | inside the `server {}` block: `/ui/` (static, strict CSP), `/ui/api/` (proxy, `limit_req`, 16 KiB bodies), `/ui/api/health` (loopback only) and `/` (Radicale) |

`radui-vhost-example.conf` shows a complete vhost (HTTP to HTTPS redirect, TLS, the includes).
The address-header overwrite and the fail2ban jail are a **pair**: install both or neither.

## systemd

* `radui-admin.service` (rendered from `deploy/systemd/radui-admin.service.tpl`): its own user and
  group, `ProtectSystem=strict` with write access to the state directory and the managed directory
  only, loopback-only network access, an empty capability set and a system-call filter.
* `radicale-radui.conf`: the **drop-in for the Radicale unit** (`PYTHONPATH` to the plugin
  directory, and `PrivateTmp=yes`, which the plugin requires). Installed at cutover, not before.
* `deploy/tmpfiles/radui.conf`: the directories and their modes (state `0700`, managed directory
  `2750` owner `radui` group `radicale`).

## Radicale configuration

`deploy/radicale/config-snippet.ini` (rendered) lists what changes in Radicale's own configuration:
`[auth]` points at the generated `users`; `[rights]` uses `type = radui_rights` with the generated
`rights` file and `permit_delete_collection = False`, `permit_overwrite_collection = False`; and
`[server] max_connections`. Radicale logs at WARNING or lower so that the plugin's startup line is
visible and the fail2ban filter sees failed logins. See `backend/plugin/README.md` for the
plugin's behaviour and failure modes.

## After the install

* `https://example.org/ui/api/health` is reachable **from the host only** (loopback) and shows
  `ok`, the current `generation` and `active: true` once Radicale runs the generated rights.
* `radui-admin-cli smoke ...` runs a throw-away account through the rights end to end.
* Radicale upgrades: always read [upgrading-radicale.md](upgrading-radicale.md) first.
* Problems: [deploy/RECOVERY.md](../deploy/RECOVERY.md). Day-to-day administration: [ADMIN.md](ADMIN.md).
