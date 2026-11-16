# SPDX-License-Identifier: AGPL-3.0-or-later
# Drop-in for the Radicale unit. Install as
#   /etc/systemd/system/<radicale unit>.d/radui.conf
# (for example /etc/systemd/system/@@RADICALE_UNIT@@.d/radui.conf), then `systemctl daemon-reload`
# and restart Radicale. This is a cutover step (deploy/CUTOVER.md), not part of the backend
# install: until Radicale is restarted with `[rights] type = radui_rights`, nothing changes.
#
# PYTHONPATH makes radui_rights.py importable by Radicale (the directory must be root-owned and
# not writable by the Radicale user). If the unit already sets PYTHONPATH, put both directories in
# ONE Environment= line separated by colons: a later Environment= assignment of the same variable
# replaces the earlier one.
#
# PrivateTmp=yes is REQUIRED. The plugin parses a private temporary copy of the exact bytes it
# validated, so the bytes checked and the bytes parsed cannot differ; another local user must not
# be able to see or replace that copy. If the unit hardens the file system with ProtectSystem=,
# the managed directory only needs to be readable (it is read-only by default under strict).
[Service]
Environment=PYTHONPATH=@@PLUGIN_DIR@@
PrivateTmp=yes
