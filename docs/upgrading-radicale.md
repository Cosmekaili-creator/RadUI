<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Upgrading Radicale

RadUI's rights plugin (`backend/plugin/radui_rights.py`) and the admin backend's validation step use
a few Radicale internals (listed in `backend/plugin/README.md`). Radicale does not promise those
stay stable, so **every Radicale upgrade is a compatibility check**, not a routine package update.

## Tested-version policy

* The supported Radicale versions are the series listed in the plugin (`TESTED_SERIES`, currently
  **3.9.x**) and in the project's test matrix. The test suite is run against each supported series
  with a throwaway Radicale (`RADICALE_BIN=<path> python3 -m unittest discover -s backend/tests`).
* **Patch releases inside a tested series** (3.9.x) are expected to work: do the checks below, no
  code change is normally needed.
* **A Radicale outside the tested range** may still work. The plugin logs a WARNING at start that
  names the version and the tested range. If one of the internals changed incompatibly, the plugin
  treats the rights file as unusable and Radicale refuses to start (fails closed), with a message
  naming the installed version and pointing here.
* A series is added to `TESTED_SERIES` only after the full test suite passed against it and a
  real upgrade ran cleanly.

## Procedure for every upgrade

Do it in a maintenance window you can extend; the running Radicale process keeps working with its
old code until you restart it.

1. **Read the Radicale changelog** for the new version, looking for changes to `rights`
   (`from_file`, `BaseRights`), `config` (`copy`, `update`), `log` and plugin loading.
2. **Back up** Radicale's configuration and the collections, as in `deploy/CUTOVER.md` step 4.
3. **Install the new version without restarting Radicale.** (A virtual environment in a new
   directory is easiest to roll back; an in-place `pip install` is fine if you keep the old version
   number to hand.)
4. **Run the pre-restart check in the new Radicale environment, as the service user:**

   ```
   sudo -u radui radui-admin-cli check-radicale
   ```

   It validates the generated `users` and `rights` files with the **new** Radicale's own engine
   (the interpreter named by `radicale_python` in `/etc/radui/config.toml`; point it at the new
   environment first if you installed into a new directory) and compares them with the model. It
   must print `OK radicale <new version>, <n> probes`. Any `FAIL` line: **do not restart Radicale**;
   put the old version back or fix the plugin first.
5. If the version is outside the tested range, also diff `radicale/rights/from_file.py` and the
   internals table in `backend/plugin/README.md` against the new version, and run the plugin tests
   against it: `RADICALE_BIN=<new radicale> python3 -m unittest discover -s backend/tests -p 'test_*.py'`.
6. **Restart Radicale** (1 to 3 seconds of refused connections).
7. **Verify:** `journalctl -u radicale -n 30` shows one WARNING line `radui_rights: active,
   hot-reload enabled ...`, no CRITICAL or ERROR line, and no "outside the tested range" warning if
   the version is in range; `curl -s -H 'Host: <name>' http://127.0.0.1:<backend port>/ui/api/health`
   shows `"active": true`; a real client still syncs; `radui-admin-cli smoke ...` passes (see
   `deploy/CUTOVER.md` step 8).
8. After a successful run on a new series, extend `TESTED_SERIES` in the plugin and the CI matrix
   in the same change that records the result.

If the plugin cannot be made to work quickly, set `[rights] type = from_file` and restart: the
generated file is in the standard format, only the hot reload is lost (see `deploy/RECOVERY.md`).
