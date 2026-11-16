# SPDX-License-Identifier: AGPL-3.0-or-later
# fail2ban jail for failed Radicale logins. Install as /etc/fail2ban/jail.d/radui-radicale-auth.conf
# (or add the section to jail.local) together with filter.d/radui-radicale-auth.conf, then reload
# fail2ban.
#
# THE PAIR RULE: the jail bans the address in "(forwarded for ...)". Install it only together with
# the nginx change that overwrites X-Forwarded-For with $remote_addr
# (deploy/nginx/radui-proxy-headers.inc.tpl); with the stock $proxy_add_x_forwarded_for a client
# could choose the address that gets banned.
#
# Check before enabling:
#   fail2ban-regex systemd-journal[journalmatch="_SYSTEMD_UNIT=@@RADICALE_UNIT@@"] radui-radicale-auth
[radui-radicale-auth]
enabled      = true
filter       = radui-radicale-auth
backend      = systemd
journalmatch = _SYSTEMD_UNIT=@@RADICALE_UNIT@@
maxretry     = @@F2B_MAXRETRY@@
findtime     = @@F2B_FINDTIME@@
bantime      = @@F2B_BANTIME@@
banaction    = @@F2B_BANACTION@@
port         = @@F2B_PORT@@
ignoreip     = @@F2B_IGNOREIP@@
