#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S4: discovery and grants.

What does a grantee see at the root, can a grantee PROPFIND / REPORT /
sync-collection on a granted collection of another principal, is another
user's principal refused, and what does current-user-privilege-set say for the
`r` grant, the `rwl` grant, the owner and the admin.
"""
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, XML_HDR, PROPFIND_PRIV, REPORT_QUERY,  # noqa: E402
                    mkcalendar_body, MKCOL_BOOK, ics_event, vcard, gen, NS, md_table)

D = "{DAV:}"
SYNC = ('<?xml version="1.0"?><D:sync-collection %s><D:sync-token/>'
        '<D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop>'
        '</D:sync-collection>' % NS)
PROPS_HOME = ('<?xml version="1.0"?><D:propfind %s><D:prop>'
              '<D:current-user-principal/><C:calendar-home-set/>'
              '<CR:addressbook-home-set/><D:resourcetype/></D:prop></D:propfind>' % NS)


def hrefs(resp):
    try:
        root = ET.fromstring(resp.body)
    except ET.ParseError:
        return []
    return sorted(h.text for h in root.iter(D + "href"))


def privileges(resp):
    try:
        root = ET.fromstring(resp.body)
    except ET.ParseError:
        return None
    out = set()
    for ps in root.iter(D + "current-user-privilege-set"):
        for p in ps.iter(D + "privilege"):
            for ch in p:
                out.add(ch.tag.split("}")[1])
    return sorted(out)


def main():
    c = Checker("S4 discovery and grants")
    m = gen.default_model(1, with_grants=False)
    m["grants"] = [
        {"owner": "alice", "collection": "cal-a", "grantee": "bob", "level": "readwrite"},
        {"owner": "alice", "collection": "cal-a", "grantee": "agent-1", "level": "read"},
        {"owner": "alice", "collection": "book-a", "grantee": "bob", "level": "read"}]
    inst = Instance("s04", model=m)
    inst.start()
    ICS = {"Content-Type": "text/calendar"}
    assert inst.make_member("alice", "cal-a").status == 201
    assert inst.make_member("alice", "cal-private").status == 201
    assert inst.req("MKCOL", "/alice/book-a/", "alice", MKCOL_BOOK, XML_HDR).status == 201
    inst.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"), ICS)
    inst.req("PUT", "/alice/cal-private/p1.ics", "alice", ics_event("p1"), ICS)
    inst.req("PUT", "/alice/book-a/c1.vcf", "alice", vcard("c1"), {"Content-Type": "text/vcard"})
    for u in ("bob", "agent-1", "eve", "adm-1"):
        inst.req("PROPFIND", "/", u, None, {"Depth": "0"})

    # root listing per user
    rows = []
    seen = {}
    for u in ("alice", "bob", "agent-1", "eve", "adm-1"):
        r = inst.req("PROPFIND", "/", u, PROPFIND_PRIV, dict(XML_HDR, Depth="1"))
        hs = hrefs(r)
        seen[u] = hs
        rows.append((u, r.status, len(hs), "/" + u + "/" in hs,
                     any(h.startswith("/alice/") and h != "/alice/" for h in hs),
                     len([h for h in hs if h not in ("/", "/" + u + "/")])))
    print(md_table(rows, ["user", "PROPFIND / Depth 1", "hrefs", "sees own principal",
                          "sees entries under /alice/", "other hrefs"]))
    c.check("root/depth1-lists-only-own-principal",
            all(r[1] == 207 for r in rows)
            and seen["bob"] == ["/", "/bob/"] and seen["eve"] == ["/", "/eve/"]
            and seen["agent-1"] == ["/", "/agent-1/"],
            "bob sees %s, eve sees %s, agent-1 sees %s" % (
                seen["bob"], seen["eve"], seen["agent-1"]))
    c.check("root/admin-sees-all-principals",
            set(seen["adm-1"]) >= {"/", "/alice/", "/bob/", "/eve/", "/agent-1/", "/adm-1/"},
            "admin sees %d hrefs" % len(seen["adm-1"]))
    c.check("root/grantee-does-not-discover-granted-collection",
            not any(h.startswith("/alice/") for h in seen["bob"]),
            "granted collections are NOT listed under /; a client needs the direct URL "
            "(or the backend's me/access list)")

    # principal discovery properties
    r = inst.req("PROPFIND", "/bob/", "bob", PROPS_HOME, dict(XML_HDR, Depth="0"))
    c.check("principal/current-user-principal-and-home-set",
            r.status == 207 and b"/bob/" in r.body,
            "PROPFIND /bob/ -> %d; body mentions /bob/ = %s" % (r.status, b"/bob/" in r.body))

    # another user's principal and non-granted collection
    for label, path, who in (("other-principal", "/alice/", "bob"),
                             ("other-principal-depth1", "/alice/", "agent-1"),
                             ("non-granted-collection", "/alice/cal-private/", "bob"),
                             ("non-granted-item", "/alice/cal-private/p1.ics", "bob")):
        method = "GET" if path.endswith(".ics") else "PROPFIND"
        hdr = dict(XML_HDR, Depth="1" if "depth1" in label else "0")
        r = inst.req(method, path, who, PROPFIND_PRIV if method == "PROPFIND" else None, hdr)
        c.check("refused/%s" % label, r.status == 403,
                "%s %s as %s -> %d" % (method, path, who, r.status))

    # granted collection: direct access
    for who in ("bob", "agent-1"):
        r0 = inst.req("PROPFIND", "/alice/cal-a/", who, PROPFIND_PRIV, dict(XML_HDR, Depth="0"))
        r1 = inst.req("PROPFIND", "/alice/cal-a/", who, PROPFIND_PRIV, dict(XML_HDR, Depth="1"))
        rr = inst.req("REPORT", "/alice/cal-a/", who, REPORT_QUERY, dict(XML_HDR, Depth="1"))
        rs = inst.req("REPORT", "/alice/cal-a/", who, SYNC, XML_HDR)
        c.check("granted/%s/propfind-report-sync" % who,
                r0.status == 207 and r1.status == 207 and rr.status == 207
                and rs.status == 207 and b"e1.ics" in rs.body,
                "PROPFIND d0 %d, d1 %d (items listed: %s), REPORT query %d, sync-collection %d"
                % (r0.status, r1.status, b"e1.ics" in r1.body, rr.status, rs.status))
    # privilege sets
    pv = {}
    for label, who, path in (("owner", "alice", "/alice/cal-a/"),
                             ("rwl-grantee", "bob", "/alice/cal-a/"),
                             ("r-grantee", "agent-1", "/alice/cal-a/"),
                             ("admin", "adm-1", "/alice/cal-a/"),
                             ("r-grantee-addressbook", "bob", "/alice/book-a/"),
                             ("owner-item", "alice", "/alice/cal-a/e1.ics"),
                             ("rwl-grantee-item", "bob", "/alice/cal-a/e1.ics"),
                             ("r-grantee-item", "agent-1", "/alice/cal-a/e1.ics")):
        r = inst.req("PROPFIND", path, who, PROPFIND_PRIV, dict(XML_HDR, Depth="0"))
        pv[label] = privileges(r)
    print(md_table([(k, ", ".join(v) if v is not None else "n/a") for k, v in pv.items()],
                   ["viewer", "current-user-privilege-set"]))
    c.check("privilege-set/r-grantee-is-read-only",
            pv["r-grantee"] is not None and not ({"write", "write-content", "bind", "unbind",
                                                  "write-properties"} & set(pv["r-grantee"])),
            "r grantee: %s" % pv["r-grantee"])
    c.check("privilege-set/rwl-grantee-can-write-items-not-properties",
            pv["rwl-grantee"] is not None
            and {"write", "write-content"} <= set(pv["rwl-grantee"])
            and "write-properties" not in pv["rwl-grantee"],
            "rwl grantee: %s; owner: %s" % (pv["rwl-grantee"], pv["owner"]))
    c.check("privilege-set/owner-has-write-properties",
            pv["owner"] is not None and "write-properties" in pv["owner"],
            "owner: %s" % pv["owner"])
    inst.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
