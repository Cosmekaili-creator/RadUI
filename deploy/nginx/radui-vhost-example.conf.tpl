# SPDX-License-Identifier: AGPL-3.0-or-later
# Complete example vhost: Radicale at /, RadUI at @@UI_PATH@@/ and its admin API at
# @@UI_PATH@@/api/, for @@SERVER_NAME@@. Install it as a site file and adapt the TLS lines to your
# certificate setup. Needs, at http level, radui-http.conf (media types and the rate-limit zone).
#
# Files to install first (deploy/CUTOVER.md has the order):
#   radui-http.conf                 -> /etc/nginx/conf.d/        (http level)
#   radui-security-headers.inc,
#   radui-proxy-headers.inc,
#   radui-locations.conf            -> @@NGINX_SNIPPETS_DIR@@/
#
# The X-Forwarded-For overwrite in radui-proxy-headers.inc and the fail2ban jail in deploy/fail2ban
# are a PAIR: ship both or neither.

server {
    listen 80;
    listen [::]:80;
    server_name @@SERVER_NAME@@;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name @@SERVER_NAME@@;

    ssl_certificate     @@TLS_CERT@@;
    ssl_certificate_key @@TLS_KEY@@;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    server_tokens off;

    # Server-level default for anything not covered by a location. The locations below repeat
    # the headers themselves (see radui-security-headers.inc).
    include @@NGINX_SNIPPETS_DIR@@/radui-security-headers.inc;

    include @@NGINX_SNIPPETS_DIR@@/radui-locations.conf;
}
