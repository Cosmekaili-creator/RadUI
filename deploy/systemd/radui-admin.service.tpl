# SPDX-License-Identifier: AGPL-3.0-or-later
# RadUI admin backend. Rendered from deploy/systemd/radui-admin.service.tpl; install as
# /etc/systemd/system/radui-admin.service (deploy/install-backend.sh does it).
#
# The service listens on loopback only and writes exactly two directories: its private state
# and the managed directory that holds the users and rights files Radicale reads.
[Unit]
Description=RadUI admin backend (accounts and rights for Radicale)
After=network.target
# Crash-loop protection. These are [Unit] directives; in [Service] they are silently ignored.
StartLimitIntervalSec=300
StartLimitBurst=6

[Service]
Type=simple
User=@@RADUI_USER@@
Group=@@RADUI_GROUP@@
WorkingDirectory=@@STATE_DIR@@
# The launcher is started through the system interpreter in isolated mode (-I): no user site
# directory, no PYTHON* environment variables, no script directory on sys.path.
ExecStart=/usr/bin/python3 -I @@INSTALL_DIR@@/backend/bin/radui-admin --config @@CONFIG_DIR@@/config.toml
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

# Sandbox.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=@@STATE_DIR@@ @@MANAGED_DIR@@
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
UMask=0027
CapabilityBoundingSet=
AmbientCapabilities=
LockPersonality=true
ProtectClock=true
ProtectControlGroups=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectProc=invisible
ProcSubset=pid
RemoveIPC=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

# Network: the backend only talks to Radicale and to the reverse proxy, both on this host.
# AF_INET6 is left out; add it (and nothing else) if BACKEND_LISTEN or RADICALE_UPSTREAM is an
# IPv6 address.
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_INET AF_UNIX

# The backend changes the group of the managed files (fchown) and starts the interpreter that
# validates a candidate, so @privileged and @resources are NOT denied here: @system-service
# alone is the filter. MemoryDenyWriteExecute is not set (it can break some interpreters).
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
