# SPDX-License-Identifier: AGPL-3.0-or-later
# Request headers sent to the two backends (RadUI admin API and Radicale). Include this file in
# every proxied location (proxy_set_header follows the same inheritance rule as add_header: one
# directive in a location drops all the inherited ones).
#
# THE PAIR RULE: the two address headers below are OVERWRITTEN with $remote_addr, never appended
# to ($proxy_add_x_forwarded_for would keep what the client sent). Radicale logs the forwarded
# address of every failed login, and the fail2ban jail (deploy/fail2ban) bans by that address.
# With a forwarded value the client can choose, an attacker could pick whom the jail bans, or
# never be banned. So this overwrite and the fail2ban jail are a PAIR: never ship the jail
# without this, and never loosen this while the jail is active.
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;

# Headers Radicale or the backend would trust if a client could send them. An empty value
# means the header is not sent upstream at all.
proxy_set_header X-Forwarded-Host "";
proxy_set_header X-Forwarded-Port "";
proxy_set_header X-Forwarded-Server "";
proxy_set_header X-Remote-Addr "";
proxy_set_header X-Remote-User "";
proxy_set_header X-Script-Name "";
proxy_set_header Forwarded "";
