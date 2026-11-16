#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S17: sync-collection (RFC 6578) behaviour of Radicale.

Token format, initial sync, no-change sync, incremental sync after create /
modify / delete / move, status of an unknown or malformed token, a token whose
history was removed from the cache, and the same calls as a read-only grantee.
"""
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, XML_HDR, NS, MKCOL_BOOK, ics_event, vcard,  # noqa: E402
                    gen)

D = "{DAV:}"
TOKEN_RE = re.compile(r"^http://radicale\.org/ns/sync/[0-9a-f]{64}$")


def sync_body(token, level="1"):
    tok = "<D:sync-token>%s</D:sync-token>" % token if token else "<D:sync-token/>"
    return ('<?xml version="1.0"?><D:sync-collection %s>%s<D:sync-level>%s</D:sync-level>'
            '<D:prop><D:getetag/></D:prop></D:sync-collection>' % (NS, tok, level))


def parse(resp):
    """Return (token, {href: status_text}, error-element-names)."""
    try:
        root = ET.fromstring(resp.body)
    except ET.ParseError:
        return None, {}, []
    token = None
    t = root.find(D + "sync-token")
    if t is not None:
        token = t.text
    entries = {}
    for r in root.iter(D + "response"):
        href = r.find(D + "href").text
        st = r.find(D + "status")
        ps = r.find(".//" + D + "propstat/" + D + "status")
        entries[href] = (st.text if st is not None else ps.text if ps is not None else "?")
    errs = [e.tag.split("}")[1] for e in root.iter() if root.tag.endswith("error")
            and e is not root]
    return token, entries, errs


def main():
    c = Checker("S17 sync-collection")
    m = gen.default_model(1, with_grants=False)
    m["grants"] = [{"owner": "alice", "collection": "cal-a", "grantee": "agent-1",
                    "level": "read"}]
    inst = Instance("s17", model=m, rights="radui_rights")
    inst.start()
    ICS = {"Content-Type": "text/calendar"}
    assert inst.make_member("alice", "cal-a").status == 201
    base = "/alice/cal-a/"
    for i in (1, 2, 3):
        assert inst.req("PUT", base + "e%d.ics" % i, "alice", ics_event("e%d" % i), ICS).status == 201

    def sync(token, user="alice", level="1", path=base):
        r = inst.req("REPORT", path, user, sync_body(token, level), XML_HDR)
        return r, parse(r)

    r, (t0, ent, _) = sync(None)
    c.check("initial/status-and-token-format",
            r.status == 207 and t0 is not None and TOKEN_RE.match(t0) is not None,
            "empty token -> %d; token %s...; format http://radicale.org/ns/sync/<64 hex>: %s"
            % (r.status, (t0 or "")[:34], bool(t0 and TOKEN_RE.match(t0))))
    c.check("initial/lists-all-items-with-200",
            sorted(ent) == [base + "e1.ics", base + "e2.ics", base + "e3.ics"]
            and all("200" in v for v in ent.values()),
            "%d entries: %s" % (len(ent), sorted(set(ent.values()))))
    r, (t1, ent, _) = sync(t0)
    c.check("nochange/empty-and-token-stable", r.status == 207 and not ent and t1 == t0,
            "%d entries; token unchanged: %s" % (len(ent), t1 == t0))

    inst.req("PUT", base + "e4.ics", "alice", ics_event("e4"), ICS)
    r, (t2, ent, _) = sync(t0)
    c.check("incremental/create", list(ent) == [base + "e4.ics"] and t2 != t0,
            "entries %s; token changed: %s" % (sorted(os.path.basename(k) for k in ent), t2 != t0))
    inst.req("PUT", base + "e1.ics", "alice", ics_event("e1", "changed"), ICS)
    r, (t3, ent, _) = sync(t2)
    c.check("incremental/modify", list(ent) == [base + "e1.ics"] and "200" in ent[base + "e1.ics"],
            "entries %s status %s" % (sorted(os.path.basename(k) for k in ent),
                                      sorted(set(ent.values()))))
    inst.req("DELETE", base + "e2.ics", "alice")
    r, (t4, ent, _) = sync(t3)
    c.check("incremental/delete-reported-as-404",
            list(ent) == [base + "e2.ics"] and "404" in ent[base + "e2.ics"],
            "entries %s status %s" % (sorted(os.path.basename(k) for k in ent),
                                      sorted(set(ent.values()))))
    inst.req("MOVE", base + "e3.ics", "alice", None,
             {"Destination": "http://127.0.0.1:%d%se3m.ics" % (inst.port, base)})
    r, (t5, ent, _) = sync(t4)
    c.info("MOVE e3 -> e3m: entries %s" % {os.path.basename(k): v[9:15] for k, v in ent.items()})
    # catch-up across several changes at once
    r, (t6, ent, _) = sync(t0)
    c.check("incremental/catch-up-from-old-token",
            r.status == 207 and t6 == t5 and len(ent) >= 4,
            "from the first token: %d entries %s, final token equals latest: %s"
            % (len(ent), sorted(set(v[9:15] for v in ent.values())), t6 == t5))

    # invalid tokens
    for label, tok in (("garbage", "not-a-token"),
                       ("well-formed-but-unknown",
                        "http://radicale.org/ns/sync/" + "0" * 64),
                       ("other-namespace", "urn:example:sync:1"),
                       ("wrong-length", "http://radicale.org/ns/sync/abcd")):
        r, (t, ent, errs) = sync(tok)
        c.info("invalid token (%s) -> HTTP %d, error elements %s, body starts %r" % (
            label, r.status, errs, r.body[:60].decode(errors="replace")))
    r_bad, (_, _, errs_bad) = sync("http://radicale.org/ns/sync/" + "0" * 64)
    c.check("invalid-token/status-is-4xx-with-valid-sync-token-error",
            400 <= r_bad.status < 500 and "valid-sync-token" in errs_bad,
            "unknown token -> %d, error %s (client must restart with an empty token)"
            % (r_bad.status, errs_bad))
    r, _ = sync(t0, level="infinity")
    c.info("sync-level infinity -> %d" % r.status)

    # history removed: delete the cache of the collection (simulates a purge)
    cache = os.path.join(inst.collections_dir(), "alice", "cal-a", ".Radicale.cache",
                         "sync-token")
    existed = os.path.isdir(cache)
    if existed:
        shutil.rmtree(cache)
    r, (t7, ent, errs) = sync(t0)
    c.check("purged-history/old-token-rejected-or-full-resync",
            r.status in (403, 400, 410) or (r.status == 207 and len(ent) >= 3),
            "sync-token cache dir existed: %s; after removing it the old token gives HTTP %d "
            "(%d entries, errors %s)" % (existed, r.status, len(ent), errs))
    r, (t8, ent, _) = sync(None)
    c.check("purged-history/empty-token-always-works", r.status == 207 and len(ent) >= 3,
            "empty token -> %d, %d entries, new token %s" % (r.status, len(ent),
                                                              bool(t8 and TOKEN_RE.match(t8))))
    # read-only grantee
    rg, (tg, ent, _) = sync(None, user="agent-1")
    inst.req("PUT", base + "e5.ics", "alice", ics_event("e5"), ICS)
    rg2, (tg2, ent2, _) = sync(tg, user="agent-1")
    c.check("grantee/read-only-sync", rg.status == 207 and rg2.status == 207
            and list(ent2) == [base + "e5.ics"],
            "read grantee initial %d (%d entries), incremental %d entries %s"
            % (rg.status, len(ent), rg2.status, sorted(os.path.basename(k) for k in ent2)))
    rn, _ = sync(None, user="eve")
    c.check("non-granted/sync-refused", rn.status == 403, "-> %d" % rn.status)
    # address book
    assert inst.req("MKCOL", "/alice/book-a/", "alice", MKCOL_BOOK, XML_HDR).status == 201
    inst.req("PUT", "/alice/book-a/c1.vcf", "alice", vcard("c1"), {"Content-Type": "text/vcard"})
    rb, (tb, entb, _) = sync(None, path="/alice/book-a/")
    c.check("addressbook/sync", rb.status == 207 and TOKEN_RE.match(tb or "") and len(entb) == 1,
            "-> %d, token ok, %d entries" % (rb.status, len(entb)))
    # sync token differs per collection, is deterministic for the same state
    r_a, (ta, _, _) = sync(None)
    r_b, (tb2, _, _) = sync(None)
    c.check("token-deterministic-for-same-state", ta == tb2, "two initial syncs, equal tokens: %s"
            % (ta == tb2))
    inst.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
