#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-5: collection management over DAV.

* MKCOL / MKCALENDAR on an existing name (same kind, other kind, as grantee).
* a collection name ending in "~".
* DELETE of a collection with a stale, a fresh and no If-Match (owner: an
  administrator, and a non-administrator owner).
* whether a read-write grantee can DELETE the collection itself.
* what a read-only grantee gets on every write.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, card30, event,  # noqa: E402
                    short, mkcol_book, mkcalendar, VCF, ICS, XML, NS)

PROPPATCH = ('<?xml version="1.0"?><D:propertyupdate %s><D:set><D:prop>'
             '<D:displayname>renamed</D:displayname></D:prop></D:set>'
             '</D:propertyupdate>' % NS)


def line(r):
    return "%d %s" % (r.status, short(r.body, 90)) if r.body else str(r.status)


def main():
    require_memory()
    c = Checker("S2-5 collection management over DAV")
    s = standard_stack("s205")
    try:
        # ---- creation on an existing name ---------------------------------------
        r1 = s.req("MKCOL", "/alice/contacts/", "alice", mkcol_book("x"), XML)
        c.expect("mkcol/existing-book-refused", r1.status in (405, 409),
                 "MKCOL on an existing address book -> %s" % line(r1))
        r2 = s.req("MKCALENDAR", "/alice/cal-work/", "alice", mkcalendar("x"), XML)
        c.expect("mkcalendar/existing-calendar-refused", r2.status in (405, 409),
                 "MKCALENDAR on an existing calendar -> %s" % line(r2))
        r3 = s.req("MKCOL", "/alice/cal-work/", "alice", mkcol_book("x"), XML)
        r4 = s.req("MKCALENDAR", "/alice/contacts/", "alice", mkcalendar("x"), XML)
        c.expect("mkcol/other-kind-refused", r3.status in (405, 409)
                 and r4.status in (405, 409),
                 "MKCOL(book) on a calendar name -> %s; MKCALENDAR on a book "
                 "name -> %s" % (line(r3), line(r4)))
        c.info("mkcol/existing-codes", "existing name: MKCOL %d, MKCALENDAR %d "
               "(the UI maps both to a field error)" % (r1.status, r2.status))
        # the existing collection is untouched
        c.expect("mkcol/existing-untouched",
                 s.req("PUT", "/alice/contacts/k1.vcf", "alice", card30("k1"),
                       VCF).status == 201, "the book still accepts writes")
        # create under somebody else's space, as grantee
        r = s.req("MKCOL", "/alice/by-bob/", "bob", mkcol_book("x"), XML)
        c.expect("mkcol/grantee-cannot-create-in-owners-space",
                 r.status == 403, "bob MKCOL /alice/by-bob/ -> %s" % line(r))
        r = s.req("MKCOL", "/alice/by-agent/", "agent-1", mkcol_book("x"), XML)
        c.expect("mkcol/read-grantee-cannot-create", r.status == 403,
                 "agent-1 MKCOL /alice/by-agent/ -> %s" % line(r))
        r = s.req("MKCOL", "/agent-1/own/", "agent-1", mkcol_book("x"), XML)
        c.info("mkcol/legacy-imported-bot-has-own-space",
               "agent-1 (imported from legacy files, ownSpace true) MKCOL "
               "/agent-1/own/ -> %d" % r.status)
        s.make_user("bot-ns", bot=True, ownSpace=False)
        pr = s.req("PROPFIND", "/", "bot-ns", headers={"Depth": "0"})
        r = s.req("MKCOL", "/bot-ns/own/", "bot-ns", mkcol_book("x"), XML)
        c.expect("mkcol/account-without-own-space-cannot-create",
                 r.status == 403, "ownSpace=false account: principal PROPFIND "
                 "-> %d, MKCOL /bot-ns/own/ -> %s" % (pr.status, line(r)))
        # bob creating his own name the owner of another space uses
        r = s.req("MKCOL", "/bob/contacts/", "bob", mkcol_book("x"), XML)
        c.info("mkcol/same-name-in-other-space", "bob MKCOL /bob/contacts/ -> "
               "%d (names are per user)" % r.status)

        # ---- names ending in ~ ------------------------------------------------
        for kind, meth, body in (("calendar", "MKCALENDAR", mkcalendar("t")),
                                 ("book", "MKCOL", mkcol_book("t"))):
            r = s.req(meth, "/alice/tilde~/", "alice", body, XML)
            c.expect("tilde/%s-refused" % kind, r.status == 400,
                     "%s /alice/tilde~/ -> %s (docs/rights-model.md says 400)"
                     % (meth, line(r)))
            r2 = s.req(meth, "/alice/til~de-%s/" % kind, "alice", body, XML)
            c.info("tilde/%s-inside-name" % kind,
                   "%s /alice/til~de-%s/ (tilde not last) -> %d" % (
                       meth, kind, r2.status))
        r = s.req("PUT", "/alice/contacts/item~.vcf", "alice", card30("tl"), VCF)
        c.info("tilde/item-name", "PUT /alice/contacts/item~.vcf -> %d" % r.status)
        r = s.req("PUT", "/alice/contacts/item.vcf~", "alice", card30("tl2"), VCF)
        c.info("tilde/item-name-ends-tilde", "PUT .../item.vcf~ -> %d" % r.status)

        # ---- DELETE of a collection ---------------------------------------------
        def fresh(owner, name, kind="book"):
            if kind == "book":
                assert s.req("MKCOL", "/%s/%s/" % (owner, name), owner,
                             mkcol_book(name), XML).status == 201
                assert s.req("PUT", "/%s/%s/a.vcf" % (owner, name), owner,
                             card30(name + "a"), VCF).status == 201
            else:
                assert s.req("MKCALENDAR", "/%s/%s/" % (owner, name), owner,
                             mkcalendar(name), XML).status == 201
                assert s.req("PUT", "/%s/%s/a.ics" % (owner, name), owner,
                             event(name + "a"), ICS).status == 201
            return s.req("GET", "/%s/%s/" % (owner, name), owner).headers["etag"]

        for owner in ("alice", "bob"):
            for kind in ("book", "calendar"):
                n = "d-%s-%s" % (owner, kind)
                stale = fresh(owner, n, kind)
                ext = "vcf" if kind == "book" else "ics"
                body = card30(n + "b") if kind == "book" else event(n + "b")
                hdr = VCF if kind == "book" else ICS
                assert s.req("PUT", "/%s/%s/b.%s" % (owner, n, ext), owner,
                             body, hdr).status == 201
                cur = s.req("GET", "/%s/%s/" % (owner, n), owner).headers["etag"]
                r = s.req("DELETE", "/%s/%s/" % (owner, n), owner, None,
                          {"If-Match": stale})
                gone = s.req("GET", "/%s/%s/" % (owner, n), owner).status == 404
                c.info("delete/%s/%s/stale-if-match" % (owner, kind),
                       "DELETE with the collection ETag from before a PUT -> "
                       "%s; collection gone afterwards: %s" % (line(r), gone))
                stale_status = r.status
                if gone:
                    n = n + "-2"
                    fresh(owner, n, kind)
                    cur = s.req("GET", "/%s/%s/" % (owner, n), owner).headers["etag"]
                r = s.req("DELETE", "/%s/%s/" % (owner, n), owner, None,
                          {"If-Match": cur})
                gone = s.req("GET", "/%s/%s/" % (owner, n), owner).status == 404
                c.expect("delete/%s/%s/fresh-if-match" % (owner, kind),
                         r.status == 200 and gone,
                         "DELETE with the current collection ETag -> %s; gone: "
                         "%s" % (line(r), gone))
                n3 = "d3-%s-%s" % (owner, kind)
                fresh(owner, n3, kind)
                r = s.req("DELETE", "/%s/%s/" % (owner, n3), owner)
                gone = s.req("GET", "/%s/%s/" % (owner, n3), owner).status == 404
                c.info("delete/%s/%s/no-if-match" % (owner, kind),
                       "DELETE without If-Match -> %s; gone: %s"
                       % (line(r), gone))
        c.info("delete/stale-if-match-summary",
               "last stale-If-Match DELETE status %d: a stale If-Match on a "
               "COLLECTION %s" % (stale_status,
                                  "is refused (412)" if stale_status == 412
                                  else "is NOT enforced"))
        r = s.req("DELETE", "/alice/no-such-collection/", "alice")
        c.info("delete/missing-collection", "DELETE of a missing collection "
               "-> %d" % r.status)

        # ---- grantee DELETE of the collection itself ---------------------------
        fresh("alice", "shared-del")
        s.grant("alice", "shared-del", "bob", "readwrite")
        s.grant("alice", "shared-del", "agent-1", "read")
        etag = s.req("GET", "/alice/shared-del/", "alice").headers["etag"]
        for user, level in (("bob", "readwrite"), ("agent-1", "read")):
            r = s.req("DELETE", "/alice/shared-del/", user, None,
                      {"If-Match": etag})
            still = s.req("GET", "/alice/shared-del/", "alice").status == 200
            c.expect("delete/%s-grantee-cannot-delete-collection" % level,
                     r.status == 403 and still,
                     "%s grantee DELETE of the collection -> %s; collection "
                     "still there: %s" % (level, line(r), still))
        # ... and cannot overwrite it either
        r = s.req("PUT", "/alice/shared-del/", "bob", card30("whole"), VCF)
        c.info("put/rw-grantee-whole-collection", "bob PUT on the collection "
               "URL -> %s" % line(r))
        # rw grantee: PROPPATCH (rename) of the collection
        r = s.req("PROPPATCH", "/alice/shared-del/", "bob", PROPPATCH, XML)
        c.info("proppatch/rw-grantee", "bob PROPPATCH displayname -> %d "
               "(%s)" % (r.status, "forbidden, as documented: grants carry "
                         "the l letter" if r.status == 403 else "allowed"))
        r = s.req("PROPPATCH", "/alice/shared-del/", "alice", PROPPATCH, XML)
        c.expect("proppatch/owner", r.status == 207, "alice PROPPATCH -> %d"
                 % r.status)

        # ---- read-only grantee on every write -----------------------------------
        base = "/alice/contacts/"
        s.req("PUT", base + "ro.vcf", "alice", card30("ro"), VCF)
        ro_etag = s.req("GET", base + "ro.vcf", "alice").headers["etag"]
        attempts = [
            ("PUT-new-item", "PUT", base + "ro-new.vcf", card30("ronew"), VCF),
            ("PUT-replace-item", "PUT", base + "ro.vcf", card30("ro", "Changed Name"),
             dict(VCF, **{"If-Match": ro_etag})),
            ("DELETE-item", "DELETE", base + "ro.vcf", None, {"If-Match": ro_etag}),
            ("DELETE-collection", "DELETE", base, None, {}),
            ("PROPPATCH", "PROPPATCH", base, PROPPATCH, XML),
            ("MOVE-item", "MOVE", base + "ro.vcf", None,
             {"Destination": "http://127.0.0.1:%d%sro-moved.vcf" % (s.rport, base)}),
            ("PUT-on-collection-url", "PUT", base, card30("whole"), VCF),
            ("MKCOL-inside", "MKCOL", base + "sub/", mkcol_book("s"), XML),
            ("MKCALENDAR-in-owners-space", "MKCALENDAR", "/alice/ro-cal/",
             mkcalendar("c"), XML),
        ]
        bad = []
        for name, meth, path, body, hdr in attempts:
            r = s.req(meth, path, "agent-1", body, hdr)
            ok = r.status in (403, 405, 409) or r.status == 400
            c.info("readonly/%s" % name, "agent-1 %s %s -> %s" % (
                meth, path.split("/", 2)[2] or "/", line(r)))
            if r.status < 400:
                bad.append(name)
        after = s.req("GET", base + "ro.vcf", "alice")
        c.expect("readonly/nothing-changed", not bad and after.status == 200
                 and after.headers["etag"] == ro_etag,
                 "no write of the read-only grantee succeeded (succeeded: %s); "
                 "item ETag unchanged: %s" % (bad, after.headers["etag"] == ro_etag))
        c.expect("readonly/write-statuses-are-403",
                 all(s.req(m, p, "agent-1", b, h).status == 403 for n, m, p, b, h
                     in attempts if n not in ("MOVE-item",)),
                 "every write attempt above answers 403")
        r = s.req("PUT", base + "ro-new2.vcf", "bob", card30("ronew2"), VCF)
        c.expect("rw/put-new-item", r.status == 201, "bob PUT new item -> %d"
                 % r.status)
        r = s.req("DELETE", base + "ro-new2.vcf", "bob")
        c.expect("rw/delete-item", r.status == 200, "bob DELETE item -> %d"
                 % r.status)
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
