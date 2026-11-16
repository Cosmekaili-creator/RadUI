# SPDX-License-Identifier: AGPL-3.0-or-later
# radui-admin configuration rendered from deploy/backend/config.toml.tpl. Install as
# @@CONFIG_DIR@@/config.toml, owner root, group @@RADUI_GROUP@@, mode 0640 (the backend refuses a
# group- or world-writable file). Every other key keeps its default; see backend/config.example.toml.

radicale_url = "http://@@RADICALE_UPSTREAM@@"
listen = "@@BACKEND_LISTEN@@"
base_path = "@@UI_PATH@@/api"
allowed_hosts = ["@@SERVER_NAME@@"]
allowed_origins = ["https://@@SERVER_NAME@@"]
trusted_proxy_header = "X-Real-IP"
# The reverse proxy runs on this host and overwrites X-Real-IP; only loopback may set it.
trusted_proxies = ["127.0.0.1", "::1"]
managed_dir = "@@MANAGED_DIR@@"
state_dir = "@@STATE_DIR@@"
radicale_group = "@@RADICALE_GROUP@@"
radicale_python = "@@RADICALE_PYTHON@@"
plugin_dir = "@@PLUGIN_DIR@@"
