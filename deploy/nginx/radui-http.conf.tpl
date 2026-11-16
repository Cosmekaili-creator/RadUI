# SPDX-License-Identifier: AGPL-3.0-or-later
# http-level settings for RadUI. Include this file once, inside the http {} block (for example as
# /etc/nginx/conf.d/radui-http.conf, which the stock nginx.conf includes at http level).

# Extra media types. The stock mime.types has no entry for these extensions, so without this
# block .mjs and .webmanifest are served as application/octet-stream and the browser refuses
# the module scripts. A types {} block at http level ADDS to the one loaded from mime.types
# (include it after `include mime.types;`); a types {} block inside server {} or location {}
# would REPLACE the whole table for that scope.
types {
    text/javascript mjs;
    application/manifest+json webmanifest;
    text/calendar ics;
    text/vcard vcf;
}

# Request rate of the admin API, per client address. Used by `limit_req` in the /api/ location of
# radui-locations.conf. 1 MB of zone memory holds the state of roughly 16000 addresses.
limit_req_zone $binary_remote_addr zone=radui_api:1m rate=@@API_RATE@@;
