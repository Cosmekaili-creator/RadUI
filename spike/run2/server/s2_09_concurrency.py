#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-9: concurrency primitives for the conflict dialog.

Two clients edit the same contact (If-Match staleness): exact status codes,
headers and bodies. PUT with If-None-Match: * on an existing name; PUT with
If-Match on a deleted item; DELETE with a stale If-Match; DELETE of an
already-deleted item with and without If-Match; If-Match: * ; unquoted and
weak ETag forms; GET of the item after a 412 yields "theirs"; two simultaneous
writers racing on one If-Match; both address books and calendars.
"""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, card30, event,  # noqa: E402
                    short, VCF, ICS)


def show(r):
    hdrs = {k: v for k, v in r.headers.items() if k in ("content-type", "etag")}
    return "%d %s body %s" % (r.status, hdrs or "{}", short(r.body, 140) or "(empty)")


def main():
    require_memory()
    c = Checker("S2-9 conflict primitives (If-Match / If-None-Match)")
    s = standard_stack("s209")
    try:
        for kind, base, ext, make, hdr in (
                ("book", "/alice/contacts/", "vcf",
                 lambda n: card30("cc", n), VCF),
                ("calendar", "/alice/cal-work/", "ics",
                 lambda n: event("cc", n), ICS)):
            path = base + "cc." + ext
            # A and B (alice and bob, both writers) read the same version
            p0 = s.req("PUT", path, "alice", make("Original Name"), hdr)
            e0 = s.req("GET", path, "alice").headers["etag"]
            e0_bob = s.req("GET", path, "bob").headers["etag"]
            c.expect("%s/both-clients-see-same-etag" % kind,
                     p0.headers["etag"] == e0 == e0_bob, "PUT, owner GET, "
                     "grantee GET ETags equal: %s" % (e0 == e0_bob))
            pa = s.req("PUT", path, "alice", make("Alice Edit"),
                       dict(hdr, **{"If-Match": e0}))
            c.expect("%s/first-writer-wins" % kind, pa.status == 204,
                     "client A If-Match(e0) -> %s" % show(pa))
            pb = s.req("PUT", path, "bob", make("Bob Edit"),
                       dict(hdr, **{"If-Match": e0}))
            c.expect("%s/stale-if-match-is-412" % kind, pb.status == 412,
                     "client B If-Match(e0) -> %s" % show(pb))
            c.info("%s/412-response-details" % kind,
                   "status %d, headers %s, body %r" % (
                       pb.status, sorted(pb.headers), pb.body[:120]))
            c.expect("%s/412-has-no-current-etag" % kind,
                     "etag" not in pb.headers,
                     "the 412 carries no ETag header: the client must GET "
                     "'theirs' (ETag header present: %s)" % ("etag" in pb.headers))
            g = s.req("GET", path, "bob")
            c.expect("%s/get-after-412-returns-theirs" % kind,
                     g.status == 200 and b"Alice Edit" in g.body and
                     g.headers["etag"] == pa.headers["etag"],
                     "B's GET shows A's edit and A's ETag")
            # retry with the fresh etag
            pr = s.req("PUT", path, "bob", make("Bob Edit"),
                       dict(hdr, **{"If-Match": g.headers["etag"]}))
            c.expect("%s/retry-with-fresh-etag" % kind, pr.status == 204,
                     "B If-Match(fresh) -> %d" % pr.status)
            e1 = pr.headers["etag"]
            # If-Match forms
            for label, val in (("unquoted", e1.strip('"')), ("weak", "W/" + e1),
                               ("star", "*"), ("list-with-current",
                                                '"deadbeef", ' + e1),
                               ("garbage", "not an etag")):
                r = s.req("PUT", path, "alice", make("Form " + label),
                          dict(hdr, **{"If-Match": val}))
                c.info("%s/if-match-%s" % (kind, label),
                       "If-Match %s -> %d" % (
                           "<current etag, %s>" % label if label not in (
                               "star", "garbage") else val, r.status))
                if r.status == 204:
                    e1 = r.headers["etag"]
            # If-None-Match: *
            r = s.req("PUT", path, "alice", make("Again"),
                      dict(hdr, **{"If-None-Match": "*"}))
            c.expect("%s/if-none-match-star-on-existing" % kind, r.status == 412,
                     "PUT If-None-Match: * on an existing name -> %s" % show(r))
            r = s.req("PUT", base + "fresh." + ext, "alice",
                      make("Fresh").replace("cc", "fresh"),
                      dict(hdr, **{"If-None-Match": "*"}))
            c.expect("%s/if-none-match-star-on-new" % kind, r.status == 201,
                     "PUT If-None-Match: * on a new name -> %d" % r.status)
            # no precondition on an existing name overwrites silently
            r = s.req("PUT", base + "fresh." + ext, "alice",
                      make("Blind").replace("cc", "fresh"), hdr)
            c.info("%s/put-without-precondition" % kind,
                   "PUT without If-Match on an existing name -> %d (silent "
                   "overwrite)" % r.status)
            # If-Match on a missing item
            r = s.req("PUT", base + "ghost." + ext, "alice",
                      make("Ghost").replace("cc", "ghost"),
                      dict(hdr, **{"If-Match": e1}))
            c.expect("%s/if-match-on-missing-item" % kind, r.status in (404, 412),
                     "PUT If-Match on a name that does not exist -> %s" % show(r))
            r = s.req("GET", base + "ghost." + ext, "alice")
            c.info("%s/ghost-not-created" % kind, "GET afterwards -> %d" % r.status)
            # DELETE with a stale If-Match
            cur = s.req("GET", path, "alice").headers["etag"]
            r = s.req("DELETE", path, "bob", None, {"If-Match": e0})
            still = s.req("GET", path, "alice").status == 200
            c.expect("%s/delete-stale-if-match-is-412" % kind,
                     r.status == 412 and still,
                     "DELETE If-Match(old) -> %s; item still there: %s" % (
                         show(r), still))
            # DELETE with the fresh one, then again (already deleted)
            r = s.req("DELETE", path, "bob", None, {"If-Match": cur})
            c.expect("%s/delete-fresh-if-match" % kind, r.status == 200,
                     "DELETE If-Match(current) -> %s" % show(r))
            r = s.req("DELETE", path, "alice", None, {"If-Match": cur})
            c.expect("%s/delete-already-deleted-with-if-match" % kind,
                     r.status in (404, 412),
                     "DELETE of an already deleted item with If-Match -> %s"
                     % show(r))
            r2 = s.req("DELETE", path, "alice")
            c.info("%s/delete-already-deleted-without-if-match" % kind,
                   "DELETE without If-Match -> %s" % show(r2))
            r = s.req("PUT", path, "alice", make("Revived"),
                      dict(hdr, **{"If-Match": cur}))
            c.info("%s/put-if-match-after-delete" % kind,
                   "PUT If-Match(old) after the item was deleted -> %s" % show(r))
            r = s.req("GET", path, "alice")
            c.info("%s/get-deleted" % kind, "GET of the deleted item -> %s" % show(r))
            # content-derived ETags: delete + recreate with the same text
            same = make("Reborn")
            s.req("PUT", path, "alice", same, hdr)
            er1 = s.req("GET", path, "alice").headers["etag"]
            s.req("DELETE", path, "alice")
            s.req("PUT", path, "alice", same, hdr)
            er2 = s.req("GET", path, "alice").headers["etag"]
            c.info("%s/recreated-same-text-etag" % kind,
                   "item deleted and recreated with identical text -> same "
                   "ETag: %s (a stale If-Match then matches again; only "
                   "the text matters, not history)" % (er1 == er2))
            # race: two writers with the same If-Match at the same time
            base_etag = s.req("GET", path, "alice").headers["etag"]
            results = []

            def worker(user, name):
                r = s.req("PUT", path, user, make(name),
                          dict(hdr, **{"If-Match": base_etag}))
                results.append((user, r.status))

            ths = [threading.Thread(target=worker, args=(u, n)) for u, n in
                   (("alice", "Race A"), ("bob", "Race B"))]
            for th in ths:
                th.start()
            for th in ths:
                th.join()
            codes = sorted(st for _, st in results)
            c.expect("%s/race-exactly-one-wins" % kind, codes == [204, 412],
                     "two simultaneous PUTs with the same If-Match -> %s"
                     % codes)
            # 4xx body shapes
            r = s.req("PUT", path, "agent-1", make("x"),
                      dict(hdr, **{"If-Match": base_etag}))
            c.info("%s/read-only-put-with-stale-etag" % kind,
                   "agent-1 PUT -> %s (403 comes before any precondition)"
                   % show(r))
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
