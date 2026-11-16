<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Deploying a new version of the web app

This page is for the operator who already runs RadUI (see [INSTALL.md](INSTALL.md)) and wants to put a
new version of the static app (`src/`) on the server. It does not cover the backend or Radicale
(see [ADMIN.md](ADMIN.md) and [upgrading-radicale.md](upgrading-radicale.md)). Paths and host names
below are placeholders: `/var/www/radui-ui` is the served directory (`UI_DIR`), `/var/backups/radui`
a directory for backups, `example.org` your host. Use your own values.

The app is served by a service worker that precaches every file with a SHA-256 and refuses to install
unless **all** files match (no mixed trees). The deploy tool exists to make that safe: it copies the
files in the right order, verifies the hashes afterwards and keeps a backup. Do not replace it with a
bare `rsync` or `cp -r`: a copy that lists `sw-manifest.js` before the other files exist, or leaves old
files next to new ones, can make every client's worker install fail and keep the old version.

## 1. Before you deploy

1. **Run the tests** on the release tree: `make test` (and `make test-deploy` if you changed the nginx
   templates). The deploy tool itself needs only `bash`, `python3` and `sha256sum`; it builds the
   file list `sw-manifest.js` for you in a temporary copy, so `make build` is not required and `src/`
   is never written to.
   **Build the tree to deploy**: `make dist && python3 tools/size-report.py --www dist` (needs `terser` and `node`, see
   INSTALL.md; the report must say OK), then deploy with `--src dist`. **Commit, then `make dist`, then deploy**: a build made from a working tree with uncommitted changes has a `-dirty` source label in `build-info.json`; the dry run prints a WARNING and `--apply` is refused unless you pass `--allow-dirty`. A `--src` without `build-info.json` is the
   unminified source: the tool deploys it with a notice (harmless, just bigger). A browser tab opened before a
   deploy and without a service worker may ask for a file name that the new version no longer has (the dictionary
   part files are gone): a reload fixes it.
2. **Commit the source** (a local `git commit` is enough) so that the tree you deploy can be rebuilt
   and a rollback point exists for the source as well as for the server.
3. **Check the free disk space** (`df -h /`) and that nothing else is deploying.
4. **Check the nginx rules once** (and again after any change of the nginx templates). The worker needs
   `no-cache` on the entry files, in particular on the generated file list:

   ```
   for f in index.html sw.js sw-manifest.js manifest.webmanifest config.json; do
     printf '%-24s' "$f"; curl -sI "https://example.org/ui/$f" | grep -i '^cache-control' || echo MISSING
   done
   ```

   Each line must show `Cache-Control: no-cache`. Other static files may show `public, max-age=300`.
   If `sw-manifest.js` does not, apply the `location = <UI>/sw-manifest.js` block of
   `deploy/nginx/radui-locations.conf.tpl` (re-render, diff against the live snippet, back the snippet up,
   `nginx -t`, reload) **before** the first deploy of a version that ships the file. A cached list lets
   a new worker precache a mixed tree. The file is `404` until the first deploy: check again afterwards.

## 2. Deploy

Run the tool as a user that may write the served directory and the backup directory (the script never
calls `sudo`; use `sudo` or a shell with the right account yourself).

```
# dry run: reports what would change, changes nothing
tools/deploy-static.sh --dest /var/www/radui-ui --backup-dir /var/backups/radui

# do it
tools/deploy-static.sh --dest /var/www/radui-ui --backup-dir /var/backups/radui --apply
```

What `--apply` does, in order:

1. builds `sw-manifest.js` in a temporary copy of the `--src` tree (`src/`, normally `dist/`) and stops if the file list of the script and
   the one of `tools/build-sw-manifest.py` differ;
2. writes `/var/backups/radui/radui-ui.before-ui-deploy-<YYYYMMDD>.tar.gz` (mode 600) from the current
   served directory. An existing backup is **never** overwritten: a second deploy on the same day needs
   `--tag <other>`;
3. copies the assets, then `js/`, then **`sw-manifest.js`, `sw.js` and `index.html` last**, each file
   written under a temporary name and moved into place;
4. with `--prune` only: deletes files in the served directory that are not part of the app (never
   `config.json`);
5. checks every SHA-256 of the manifest against the file now in place. On any mismatch it exits with
   status 3, names the file and prints the rollback command;
6. prints a summary and the exact rollback command.

Options worth knowing: `--src DIR` (default `src/` of the repository), `--init` (first installation:
creates the directory), `--prune`, `--tag TAG`. `config.json` is never overwritten once it exists (the
first installation copies the shipped one): the live copy carries your settings. A second run on the same
tree prints `unchanged` and makes no backup. The tool refuses an empty destination, `/`, top-level system
directories, your home directory and any directory that contains or lies inside `--src`.

Delete old backups when the new version has run for a while; the tool never removes any.

## 3. Check the result

From any machine (read-only):

```
curl -sI https://example.org/ui/sw-manifest.js | grep -i '^\(HTTP\|cache-control\|content-type\)'
curl -s  https://example.org/ui/sw-manifest.js | grep '"version"'
curl -sI https://example.org/ui/sw.js | grep -i '^cache-control'
```

The `version` equals the one printed by the deploy tool in its first step ("sw-manifest: N files,
version ..."). Then open the app in a browser that had the previous version open.

## 4. What users with the app already open see

* The browser looks for a new `sw.js` when a tab becomes visible (at most once an hour) and on
  navigation. The new worker downloads and verifies the whole new tree in the background and then
  **waits**: nothing changes on screen.
* The app shows an update banner with a reload button. Pressing it asks the usual "Discard unsaved
  changes?" question when a form has edits, then reloads onto the new version.
* A tab that is not reloaded keeps running the old code (its files come from the old cache). If another
  tab already applied the update, this tab is marked stale: write buttons are disabled with the reason
  "Reload to continue" until it is reloaded, so old code never writes against new modules.
* Because open pages are served from the cache, an operator who sees nothing change should look for the
  banner before assuming the deploy failed (and for the three headers of section 1).
* If the install of the new worker fails (a hash does not match, a file is missing), clients simply stay
  on the old version; the tool's verification step is there to catch this first.

## 5. Roll back

The tool prints the commands. The first one always restores the backup:

```
tar -xzf '/var/backups/radui/radui-ui.before-ui-deploy-<YYYYMMDD>.tar.gz' -C '/var/www'
```

It puts back every file that existed before. Files that did not exist before the deploy stay in place;
delete them, or (better) check out the previous version and run the deploy tool again with `--prune` and a
new `--tag`, which gives an exact copy of the old tree with a new, consistent manifest.

**If the previous deployment had no `sw.js` (the first deploy of the service worker), the restore alone
is NOT enough.** The backup contains no worker, so `tar` leaves the new `sw.js` and `sw-manifest.js`
where they are, and every browser that already installed the new worker keeps serving the new app from
its cache (cache-first). The tool notices this (it looks for `sw.js` in the directory before copying) and
prints two more commands after the restore:

```
rm -f '/var/www/radui-ui/sw-manifest.js'
install -m 0644 '<repository>/deploy/sw-selfdestruct.js' '/var/www/radui-ui/sw.js'
```

`deploy/sw-selfdestruct.js` is a worker that installs at once, deletes every `radui-shell-*` cache,
unregisters itself and reloads the open pages from the network. Keep it served with
`Cache-Control: no-cache` for at least the browsers' worker update interval (a day or more; longer for
devices that are opened rarely), then delete `sw.js`. Check with
`curl -sI https://example.org/ui/sw.js | grep -i cache-control`.

When the previous deployment did have a `sw.js`, the restore puts back the old `sw.js`, and clients that
installed the new version simply see the old one as another update.

## 6. Recovery: a worker that keeps a broken app alive

If clients are stuck on a broken version (a worker that installed but serves a broken tree), deploying
a fixed version is the first answer: the next visit installs it and the banner appears. When even that
cannot reach the clients, replace `sw.js` by the self-removing worker `deploy/sw-selfdestruct.js`
(its code is also in [pwa.md](pwa.md#recovery-removing-a-bad-worker)), **by hand** (the deploy tool
would not leave a foreign `sw.js` in place):

```
cp /var/www/radui-ui/sw.js /var/backups/radui/sw.js.before-recovery-<YYYYMMDD>
install -m 0644 deploy/sw-selfdestruct.js /var/www/radui-ui/sw.js
```

Browsers check `sw.js` on navigation and when a page becomes visible again; the new worker deletes the
`radui-shell-*` caches, unregisters itself and reloads the open pages from the network. After a few
days, run the deploy tool again: it sees that `sw.js` differs and puts the real one back. Users can also
clear the site data of the app in the browser settings.

## Tests of the tool

`python3 -m unittest tools/test_deploy_static.py` (temporary directories only: dry run, backup name and
mode, copy order, config preservation, hash verification, pruning, idempotency, the exclusion list
against the generator, refused destinations, the rollback of a first worker deploy) and
`node --test tests/unit-js/pwa/selfdestruct.test.mjs` (the self-removing worker in a `node:vm` sandbox).
