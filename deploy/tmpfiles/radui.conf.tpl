# SPDX-License-Identifier: AGPL-3.0-or-later
# Directories of the RadUI admin backend. Install as /etc/tmpfiles.d/radui.conf and apply with
#   systemd-tmpfiles --create /etc/tmpfiles.d/radui.conf
# `d` creates a directory and corrects mode and owner of an existing one; no age is given, so
# nothing is ever cleaned up.
#
# Type Path                 Mode  User             Group             Age
# Backend configuration. Searchable by everybody because the managed directory below usually
# lives inside it and Radicale has to reach it; config.toml itself is 0640 root:@@RADUI_GROUP@@.
d @@CONFIG_DIR@@            0755  root             root              -
# Generated users, rights, rights.lkg. Owner: the backend. Group: Radicale, read-only. The setgid
# bit makes new files inherit the Radicale group.
d @@MANAGED_DIR@@           2750  @@RADUI_USER@@   @@RADICALE_GROUP@@ -
# Private state (model, generations, lock file). Nobody else.
d @@STATE_DIR@@             0700  @@RADUI_USER@@   @@RADUI_GROUP@@   -
# Read-only code, root-owned.
d @@INSTALL_DIR@@           0755  root             root              -
d @@PLUGIN_DIR@@            0755  root             root              -
