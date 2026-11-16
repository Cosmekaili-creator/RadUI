# SPDX-License-Identifier: AGPL-3.0-or-later
# RadUI locations. Include this file INSIDE the server {} block that serves @@SERVER_NAME@@
# (see radui-vhost-example.conf for a complete vhost). Needs radui-http.conf at http level and
# the two snippets radui-security-headers.inc and radui-proxy-headers.inc in
# @@NGINX_SNIPPETS_DIR@@.
#
# Every location below that answers requests includes the security headers snippet: a location
# level add_header replaces the server-level ones (see the comment in that snippet).

# Content-Security-Policy of the static app and of the Radicale location: no inline script or
# style, no external request of any kind. Defined once here so the locations share one text.
set $radui_csp "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

# Relative redirects: nginx must not rebuild the URL from its own idea of scheme and port.
absolute_redirect off;

location = @@UI_PATH@@ {
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    return 301 @@UI_PATH@@/;
}

# ---- Static web app ---------------------------------------------------------------------------
# The app is a set of static files. Everything may be cached for a few minutes; the files below
# must always be revalidated: the service worker and its file list (a stale one keeps an old app
# alive), the manifest, the page itself and the runtime configuration.
location @@UI_PATH@@/ {
    alias @@UI_DIR@@/;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    add_header Content-Security-Policy $radui_csp always;
    add_header Cache-Control "public, max-age=300" always;
}
location = @@UI_PATH@@/index.html {
    alias @@UI_DIR@@/index.html;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    add_header Content-Security-Policy $radui_csp always;
    add_header Cache-Control "no-cache" always;
}
location = @@UI_PATH@@/config.json {
    alias @@UI_DIR@@/config.json;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    add_header Content-Security-Policy $radui_csp always;
    add_header Cache-Control "no-cache" always;
}
location = @@UI_PATH@@/sw.js {
    alias @@UI_DIR@@/sw.js;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    add_header Content-Security-Policy $radui_csp always;
    add_header Cache-Control "no-cache" always;
}
# The service worker imports this file (the list of files to precache, with a SHA-256 each). A stale
# copy would make a new worker precache a mixed tree, so it is always revalidated like sw.js.
location = @@UI_PATH@@/sw-manifest.js {
    alias @@UI_DIR@@/sw-manifest.js;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    add_header Content-Security-Policy $radui_csp always;
    add_header Cache-Control "no-cache" always;
}
location = @@UI_PATH@@/manifest.webmanifest {
    alias @@UI_DIR@@/manifest.webmanifest;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    add_header Content-Security-Policy $radui_csp always;
    add_header Cache-Control "no-cache" always;
}

# ---- Admin API --------------------------------------------------------------------------------
# Small JSON bodies only (16k is the backend's own cap), rate limited per client address.
# proxy_pass has no URI part, so the request path is passed on unchanged: the backend's
# base_path is @@UI_PATH@@/api.
# The backend sends its own Cache-Control: no-store, X-Content-Type-Options and a
# default-src 'none' CSP; nginx must not add a second Cache-Control (add_header never replaces an
# upstream header, it duplicates it), and the duplicate nosniff is hidden.
location @@UI_PATH@@/api/ {
    limit_req zone=radui_api burst=@@API_BURST@@ nodelay;
    limit_req_status 429;
    client_max_body_size 16k;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    include @@NGINX_SNIPPETS_DIR@@/radui-proxy-headers.inc;
    proxy_hide_header X-Content-Type-Options;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
    proxy_pass http://@@BACKEND_LISTEN@@;
}

# Health: for monitoring on this host only. allow/deny use the connection's own address, so call
# it with the loopback address (curl --resolve @@SERVER_NAME@@:443:127.0.0.1 ...). This location
# does not use the real-IP module: do not add `set_real_ip_from` for it.
location = @@UI_PATH@@/api/health {
    allow 127.0.0.1;
    allow ::1;
    deny all;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    include @@NGINX_SNIPPETS_DIR@@/radui-proxy-headers.inc;
    proxy_hide_header X-Content-Type-Options;
    proxy_pass http://@@BACKEND_LISTEN@@;
}

# ---- Radicale (CalDAV / CardDAV and its built-in web UI) ---------------------------------------
# Same address-header discipline as above. The strict CSP is applied here too; Radicale's own
# built-in UI under /.web/ has not been verified against it. If it breaks and you need it, give
# /.web/ its own location with a looser style-src (and the same two includes) instead of
# loosening the policy for everything.
location / {
    client_max_body_size @@RADICALE_MAX_BODY@@;
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;
    include @@NGINX_SNIPPETS_DIR@@/radui-proxy-headers.inc;
    add_header Content-Security-Policy $radui_csp always;
    proxy_http_version 1.1;
    # Radicale parses and stores large collections item by item.
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_pass http://@@RADICALE_UPSTREAM@@;
}
