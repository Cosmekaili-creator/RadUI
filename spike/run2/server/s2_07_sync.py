#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-7: what sync-collection reports (a) after a collection is deleted and
recreated under the same name (old token), (b) after an item is replaced,
deleted, recreated, (c) as a read-only grantee, for address books and
calendars. The question behind it: can an incremental client miss deletions
and carry stale items across a delete-and-recreate?
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, card30, event,  # noqa: E402
                    multistatus, sync_body, sync_token, error_names, short,
                    mkcol_book, mkcalendar, VCF, ICS, XML)


def sync(s, user, path, token):
    r = s.req("REPORT", path, user, sync_body(token), XML)
    return r, multistatus(r.body), sync_token(r.body)


def summarize(ents, base):
    return {k.replace(base, ""): ("404" if "404" in (v["status"] or "") else "200")
            for k, v in sorted(ents.items()) if k != base}


def main():
    require_memory()
    c = Checker("S2-7 sync-collection across replace, delete, recreate")
    s = standard_stack("s207")
    try:
        for kind, mk, put_hdr, ext, make, mkbody in (
                ("book", "MKCOL", VCF, "vcf",
                 lambda u, n="X": card30(u, n), mkcol_book("sync")),
                ("calendar", "MKCALENDAR", ICS, "ics",
                 lambda u, n="X": event(u, n), mkcalendar("sync"))):
            coll = "sy-" + kind
            base = "/alice/%s/" % coll
            assert s.req(mk, base, "alice", mkbody, XML).status == 201
            s.grant("alice", coll, "agent-1", "read")
            for i in "abc":
                assert s.req("PUT", base + i + "." + ext, "alice",
                             make("sy" + i, "Item " + i), put_hdr).status == 201
            r, ents, t0 = sync(s, "alice", base, None)
            c.expect("%s/initial" % kind, r.status == 207 and len(
                summarize(ents, base)) == 3 and bool(t0),
                     "empty token -> %d, 3 items, token %s" % (
                         r.status, (t0 or "")[:48]))
            # replace one item
            e = s.req("GET", base + "b." + ext, "alice").headers["etag"]
            assert s.req("PUT", base + "b." + ext, "alice", make("syb", "Item B2"),
                         dict(put_hdr, **{"If-Match": e})).status == 204
            r, ents, t1 = sync(s, "alice", base, t0)
            sm = summarize(ents, base)
            c.expect("%s/replaced-item-reported-once-as-200" % kind,
                     sm == {"b." + ext: "200"} and t1 != t0,
                     "after replacing b: %s, token changed: %s" % (sm, t1 != t0))
            # re-PUT with identical text
            e = s.req("GET", base + "b." + ext, "alice").headers["etag"]
            s.req("PUT", base + "b." + ext, "alice", make("syb", "Item B2"),
                  dict(put_hdr, **{"If-Match": e}))
            r, ents, t1b = sync(s, "alice", base, t1)
            c.info("%s/identical-reput" % kind, "re-PUT of identical text -> "
                   "token unchanged: %s, entries %s" % (t1b == t1,
                                                        summarize(ents, base)))
            # delete + create in between two syncs
            s.req("DELETE", base + "c." + ext, "alice")
            s.req("PUT", base + "d." + ext, "alice", make("sysd", "Item D"), put_hdr)
            r, ents, t2 = sync(s, "alice", base, t1b)
            sm = summarize(ents, base)
            c.expect("%s/delete-and-create" % kind,
                     sm == {"c." + ext: "404", "d." + ext: "200"},
                     "after delete c + create d: %s" % sm)
            # delete and recreate an item under the same name between syncs
            s.req("DELETE", base + "d." + ext, "alice")
            s.req("PUT", base + "d." + ext, "alice", make("sysd2", "Item D again"),
                  put_hdr)
            r, ents, t2b = sync(s, "alice", base, t2)
            c.info("%s/item-deleted-and-recreated-same-name" % kind,
                   "reported as %s" % summarize(ents, base))
            # ---- delete + recreate the COLLECTION ---------------------------------
            old = t2b
            assert s.req("DELETE", base, "alice").status == 200
            r, ents, t = sync(s, "alice", base, old)
            c.info("%s/old-token-on-deleted-collection" % kind,
                   "REPORT while the collection does not exist -> %d" % r.status)
            assert s.req(mk, base, "alice", mkbody, XML).status == 201
            s.grant("alice", coll, "agent-1", "read")  # grants survive a delete
            r, ents, t = sync(s, "alice", base, old)
            c.expect("%s/old-token-after-recreate-is-refused" % kind,
                     r.status in (403, 409) and not ents,
                     "old token on the recreated EMPTY collection -> %d %s "
                     "(error condition %s); a 207 with no entries here would "
                     "make a client keep its stale items" % (
                         r.status, short(r.body, 70), error_names(r.body)))
            # recreated collection with other content under the same item names
            for i in "ab":
                s.req("PUT", base + i + "." + ext, "alice",
                      make("new" + i, "New " + i), put_hdr)
            r, ents, t = sync(s, "alice", base, old)
            c.expect("%s/old-token-after-recreate-with-content" % kind,
                     r.status in (403, 409) and not ents,
                     "old token on the recreated collection with 2 items -> %d "
                     "(error %s)" % (r.status, error_names(r.body)))
            r, ents, tn = sync(s, "alice", base, None)
            c.expect("%s/fresh-token-after-recreate" % kind,
                     r.status == 207 and len(summarize(ents, base)) == 2
                     and tn != old,
                     "empty token -> 207, %s, new token differs: %s" % (
                         summarize(ents, base), tn != old))
            # a garbage token and a token of another collection
            r, ents, _ = sync(s, "alice", base,
                              "http://radicale.org/ns/sync/" + "0" * 64)
            c.info("%s/unknown-token" % kind, "well-formed unknown token -> %d "
                   "%s" % (r.status, error_names(r.body)))
            r, ents, _ = sync(s, "alice", base, "garbage")
            c.info("%s/malformed-token" % kind, "malformed token -> %d %s" % (
                r.status, error_names(r.body)))
            # the read-only grantee sees the same
            r, ents, ta = sync(s, "agent-1", base, None)
            r2, ents2, _ = sync(s, "agent-1", base, old)
            c.expect("%s/read-grantee" % kind,
                     r.status == 207 and r2.status in (403, 409),
                     "agent-1: empty token -> %d (%d items); old token -> %d"
                     % (r.status, len(summarize(ents, base)), r2.status))
            # a token taken by one user is valid for another reader
            ro, entso, to = sync(s, "alice", base, None)
            rb, entsb, _ = sync(s, "bob" if False else "agent-1", base, to)
            c.info("%s/token-shared-between-users" % kind, "a token from alice "
                   "used by agent-1 -> %d, entries %d" % (
                       rb.status, len(summarize(entsb, base))))
            # same name, same items, same text: is the old token still valid?
            base2 = "/alice/sy2-%s/" % kind
            assert s.req(mk, base2, "alice", mkbody, XML).status == 201
            s.req("PUT", base2 + "a." + ext, "alice", make("same", "Same"), put_hdr)
            r, ents, tk = sync(s, "alice", base2, None)
            s.req("DELETE", base2, "alice")
            assert s.req(mk, base2, "alice", mkbody, XML).status == 201
            s.req("PUT", base2 + "a." + ext, "alice", make("same", "Same"), put_hdr)
            r, ents, tk2 = sync(s, "alice", base2, tk)
            c.info("%s/recreate-with-identical-content" % kind,
                   "old token after delete + recreate + identical item -> %d, "
                   "entries %s (%s)" % (r.status, summarize(ents, base2),
                                        "token still accepted, no deletions "
                                        "to report" if r.status == 207 else
                                        "token refused: a full resync follows"))
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
