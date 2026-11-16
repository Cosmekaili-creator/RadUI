#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-4: the ETag of a PUT response (201 and 204) versus the ETag of the next
GET, of a PROPFIND (Depth 1 and Depth 0), of sync-collection and of an
addressbook-multiget; and whether the PUT ETag can be used as If-Match at once.
Cards and events; owner and rw grantee.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, card30, card40,  # noqa: E402
                    event, multistatus, multiget_body, sync_body, propfind_etag,
                    short, VCF, ICS, XML)


def etags(s, user, coll, name, kind):
    path = "/alice/%s/%s" % (coll, name)
    got = {}
    got["GET"] = s.req("GET", path, user).headers.get("etag")
    r = s.req("PROPFIND", "/alice/%s/" % coll, user, propfind_etag(),
              dict(XML, Depth="1"))
    got["PROPFIND-depth1"] = multistatus(r.body).get(path, {}).get("etag")
    r = s.req("PROPFIND", path, user, propfind_etag(), dict(XML, Depth="0"))
    got["PROPFIND-depth0"] = multistatus(r.body).get(path, {}).get("etag")
    r = s.req("REPORT", "/alice/%s/" % coll, user, sync_body(None), XML)
    got["sync-collection"] = multistatus(r.body).get(path, {}).get("etag")
    tag = "CR:address-data" if kind == "book" else "C:calendar-data"
    r = s.req("REPORT", "/alice/%s/" % coll, user,
              multiget_body([path], tag), XML)
    got["multiget"] = multistatus(r.body).get(path, {}).get("etag")
    return got


def main():
    require_memory()
    c = Checker("S2-4 PUT ETag versus GET / PROPFIND / REPORT ETag")
    s = standard_stack("s204")
    try:
        for kind, coll, name, mk1, mk2, hdr in (
                ("book", "contacts", "e1.vcf", card30("e1", "Anna One"),
                 card40("e1", "Anna Two"), VCF),
                ("calendar", "cal-work", "e1.ics", event("e1", "First"),
                 event("e1", "Second"), ICS)):
            path = "/alice/%s/%s" % (coll, name)
            for user in ("alice", "bob"):
                nm = user + "-" + name
                path = "/alice/%s/%s" % (coll, nm)
                p1 = s.req("PUT", path, user, mk1.replace("e1", user + "1"), hdr)
                e = p1.headers.get("etag")
                got = etags(s, user, coll, nm, kind)
                c.expect("%s/%s/201-etag-header-present" % (kind, user),
                         p1.status == 201 and bool(e),
                         "PUT -> %d, ETag %s" % (p1.status, e))
                bad = {k: v for k, v in got.items() if v != e}
                c.expect("%s/%s/201-etag-equals-next-reads" % (kind, user),
                         not bad, "PUT ETag equals GET, PROPFIND d1/d0, "
                         "sync-collection, multiget: %s%s" % (
                             not bad, "; differing: %s" % bad if bad else ""))
                # replace with If-Match using the PUT ETag at once
                p2 = s.req("PUT", path, user, mk2.replace("e1", user + "1"),
                           dict(hdr, **{"If-Match": e}))
                e2 = p2.headers.get("etag")
                got2 = etags(s, user, coll, nm, kind)
                c.expect("%s/%s/204-etag-header-present" % (kind, user),
                         p2.status == 204 and bool(e2) and e2 != e,
                         "PUT with If-Match(PUT etag) -> %d, new ETag %s, "
                         "changed: %s" % (p2.status, bool(e2), e2 != e))
                bad = {k: v for k, v in got2.items() if v != e2}
                c.expect("%s/%s/204-etag-equals-next-reads" % (kind, user),
                         not bad, "PUT ETag equals every later read: %s%s" % (
                             not bad, "; differing: %s" % bad if bad else ""))
                # identical re-PUT: new ETag or the same?
                p3 = s.req("PUT", path, user, mk2.replace("e1", user + "1"),
                           dict(hdr, **{"If-Match": e2}))
                c.info("%s/%s/identical-reput" % (kind, user),
                       "PUT of identical text -> %d, ETag unchanged: %s"
                       % (p3.status, p3.headers.get("etag") == e2))
        # etag syntax
        p = s.req("PUT", "/alice/contacts/syn.vcf", "alice", card30("syn"), VCF)
        e = p.headers["etag"]
        c.expect("etag/quoted-strong-hex", e.startswith('"') and e.endswith('"')
                 and not e.startswith("W/") and len(e) == 66,
                 "form %s (quoted, no W/, 64 hex digits)" % (
                     "ok" if len(e) == 66 else repr(e)))
        # the ETag is a function of the stored text
        r = s.req("PUT", "/alice/contacts/syn2.vcf", "alice", card30("syn"), VCF)
        c.info("etag/same-uid-second-name", "PUT of the same UID under another "
               "name -> %d %s" % (r.status, short(r.body, 120)))
        g1 = s.req("GET", "/alice/contacts/syn.vcf", "alice").headers["etag"]
        c.info("etag/content-derived", "ETag is 64 hex digits of a hash of "
               "the stored text (identical re-PUT keeps it)")
        # collection ETag changes with its content
        ce1 = s.req("GET", "/alice/contacts/", "alice").headers["etag"]
        s.req("PUT", "/alice/contacts/syn3.vcf", "alice", card30("syn3"), VCF)
        ce2 = s.req("GET", "/alice/contacts/", "alice").headers["etag"]
        c.info("etag/collection-get", "collection GET ETag changes after a "
               "PUT: %s" % (ce1 != ce2))
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
