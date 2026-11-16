; SPDX-License-Identifier: AGPL-3.0-or-later
; Changes to make in Radicale's configuration file at cutover (deploy/CUTOVER.md). Merge them into
; the existing sections; do not add a second section with the same name. install-backend.sh only
; PRINTS this file, it never edits Radicale's configuration.
;
; Back up the configuration first, and run `radui-admin-cli check-radicale` before restarting.

[server]
; Radicale handles at most this many requests at once; further connections wait in the listen
; queue. An unauthenticated or failed request holds a slot while Radicale applies its auth delay
; (about one second), so with many clients and the default of 8 slots some connections can be
; reset before any HTTP exchange when the queue overflows. The value below is Radicale's default.
; Re-measure on the real machine before changing it (the throwaway tests report resets).
max_connections = @@RADICALE_MAX_CONNECTIONS@@

[auth]
; The generated password file, bcrypt hashes. Written only by the admin backend.
type = htpasswd
htpasswd_filename = @@MANAGED_DIR@@/users
htpasswd_encryption = bcrypt

[rights]
; The plugin (backend/plugin/radui_rights.py) reloads the generated rights file when it changes,
; so a change takes effect on the next request without a restart. Radicale's own from_file code
; still does all the matching.
type = radui_rights
file = @@MANAGED_DIR@@/rights
; Required by the generated rules: a missing D or O letter then means "no". Without these two
; lines a collection could be deleted or overwritten by anyone who may write to it.
permit_delete_collection = False
permit_overwrite_collection = False

[logging]
; The plugin logs its startup line and every reload at WARNING, and the fail2ban filter reads
; WARNING lines: do not set the level above warning.
level = warning
