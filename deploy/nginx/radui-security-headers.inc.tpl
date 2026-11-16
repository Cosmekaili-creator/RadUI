# SPDX-License-Identifier: AGPL-3.0-or-later
# Security headers. Include this file in EVERY location that sends a response of its own.
#
# Why it is an include and not set once at server level: nginx only inherits add_header from the
# enclosing level when the current level has no add_header of its own. A location that adds a
# single header (a Cache-Control, a CSP) silently drops every header set above it. Putting the
# same include in every location keeps the set identical everywhere. If you add a location, add
# this include to it.
add_header Strict-Transport-Security "max-age=@@HSTS_MAX_AGE@@" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "geolocation=(), camera=(), microphone=()" always;
