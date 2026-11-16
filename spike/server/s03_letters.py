#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S3: permission-letter semantics of the planned rights layout (plan 2.4).

Matrix of roles (owner, read-write grantee, read grantee, non-granted user,
admin) x methods, run against the REAL generated rights with
permit_delete_collection = False and permit_overwrite_collection = False.
Expected values come from the plan's "how the letters work out" table; every
cell records expected vs observed, and every denied cell also asserts that the
storage tree is byte-for-byte unchanged. Second part: principal paths,
auto-creation of principals with RW / R / no rule, and the ownSpace=false case.

Cell codes: A = allowed (2xx), D = denied (403).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, XML_HDR, PROPFIND_ALL, PROPPATCH_NAME,  # noqa: E402
                    REPORT_QUERY, MKCOL_BOOK, mkcalendar_body, ics_event, vcard,
                    gen, md_table, tree_hash)

ROLES = ["owner", "rw", "r", "none", "admin"]
USER = {"owner": "alice", "rw": "bob", "r": "agent-1", "none": "eve", "admin": "adm-1"}
ICS = {"Content-Type": "text/calendar; charset=utf-8"}


def build_model():
    m = gen.default_model(1, with_grants=False)
    g = []
    for coll in ("cal-a", "cal-put", "cal-del"):
        g.append({"owner": "alice", "collection": coll, "grantee": "bob",
                  "level": "readwrite"})
        g.append({"owner": "alice", "collection": coll, "grantee": "agent-1",
                  "level": "read"})
    g.append({"owner": "alice", "collection": "book-a", "grantee": "bob",
              "level": "read"})
    m["grants"] = g
    return m


def multi_ics(prefix):
    ev = lambda i: ("BEGIN:VEVENT\r\nUID:%s-%d\r\nDTSTAMP:20260101T000000Z\r\n"  # noqa: E731
                    "DTSTART:20260601T100000Z\r\nSUMMARY:w%d\r\nEND:VEVENT\r\n"
                    % (prefix, i, i))
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI spike//EN\r\n"
            + ev(1) + ev(2) + "END:VCALENDAR\r\n")


def main():
    c = Checker("S3 letter semantics")
    inst = Instance("s03", model=build_model())
    inst.start()
    assert inst.alive()
    own = lambda *a, **k: inst.req(*a, **k)  # noqa: E731
    # setup as owner
    for name in ("cal-a", "cal-put", "cal-del", "del-owner", "del-admin"):
        assert own("MKCALENDAR", "/alice/%s/" % name, "alice", mkcalendar_body(),
                   XML_HDR).status == 201, name
    assert own("MKCOL", "/alice/book-a/", "alice", MKCOL_BOOK, XML_HDR).status == 201
    assert own("PUT", "/alice/cal-a/base.ics", "alice", ics_event("base"), ICS).status == 201
    assert own("PUT", "/alice/cal-put/base.ics", "alice", ics_event("pbase"), ICS).status == 201
    assert own("PUT", "/alice/book-a/c1.vcf", "alice", vcard("c1"),
               {"Content-Type": "text/vcard"}).status == 201
    # eve/agent-1/bob/adm-1 principals exist after first login
    for r in ROLES:
        inst.req("PROPFIND", "/", USER[r], None, {"Depth": "0"})

    rows = []
    mismatches = []

    def cell(action, role, expected, do, prep=None, destructive=True):
        """Run one cell; do() returns a Resp."""
        if prep:
            prep()
        before = tree_hash(inst)
        r = do()
        after = tree_hash(inst)
        allowed = 200 <= r.status < 300
        obs = "A" if allowed else ("D" if r.status == 403 else "?")
        ok = obs == expected
        side = ""
        if not allowed and before != after:
            ok = False
            side = " SIDE-EFFECT"
        rows.append((action, role, expected, r.status, obs, "ok" if ok else "MISMATCH" + side))
        if not ok:
            mismatches.append((action, role, expected, r.status))
        return r

    exp = lambda *v: dict(zip(ROLES, v))  # noqa: E731
    A, D = "A", "D"

    # ---- read-type methods ---------------------------------------------------
    for role, e in exp(A, A, A, D, A).items():
        u = USER[role]
        cell("PROPFIND collection", role, e,
             lambda u=u: inst.req("PROPFIND", "/alice/cal-a/", u, PROPFIND_ALL,
                                  dict(XML_HDR, Depth="0")))
    for role, e in exp(A, A, A, D, A).items():
        u = USER[role]
        cell("REPORT calendar-query", role, e,
             lambda u=u: inst.req("REPORT", "/alice/cal-a/", u, REPORT_QUERY,
                                  dict(XML_HDR, Depth="1")))
    for role, e in exp(A, A, A, D, A).items():
        u = USER[role]
        cell("GET item", role, e, lambda u=u: inst.req("GET", "/alice/cal-a/base.ics", u))
    for role, e in exp(A, A, A, D, A).items():
        u = USER[role]
        cell("GET collection (whole)", role, e, lambda u=u: inst.req("GET", "/alice/cal-a/", u))

    # ---- item writes ---------------------------------------------------------
    for role, e in exp(A, A, D, D, A).items():
        u = USER[role]
        cell("PUT new item", role, e,
             lambda u=u, role=role: inst.req(
                 "PUT", "/alice/cal-a/new-%s.ics" % role, u,
                 ics_event("new-" + role), dict(ICS, **{"If-None-Match": "*"})))
    for role, e in exp(A, A, D, D, A).items():
        u = USER[role]
        cell("PUT overwrite item", role, e,
             lambda u=u: inst.req("PUT", "/alice/cal-a/base.ics", u,
                                  ics_event("base", "overwritten-by-" + u), ICS))
    for role, e in exp(A, A, D, D, A).items():
        u = USER[role]
        cell("DELETE item", role, e,
             lambda role=role, u=u: inst.req("DELETE", "/alice/cal-a/del-%s.ics" % role, u),
             prep=lambda role=role: inst.req("PUT", "/alice/cal-a/del-%s.ics" % role,
                                             "alice", ics_event("del-" + role), ICS))
    for role, e in exp(A, A, D, D, A).items():
        u = USER[role]
        cell("MOVE item (same collection)", role, e,
             lambda role=role, u=u: inst.req(
                 "MOVE", "/alice/cal-a/mv-%s.ics" % role, u, None,
                 {"Destination": "http://127.0.0.1:%d/alice/cal-a/mv2-%s.ics"
                  % (inst.port, role)}),
             prep=lambda role=role: inst.req("PUT", "/alice/cal-a/mv-%s.ics" % role,
                                             "alice", ics_event("mv-" + role), ICS))
    for role, e in exp(A, A, D, D, A).items():
        u = USER[role]
        cell("PUT item into address book (rw only on calendar)", role,
             {"owner": A, "rw": D, "r": D, "none": D, "admin": A}[role],
             lambda role=role, u=u: inst.req(
                 "PUT", "/alice/book-a/n-%s.vcf" % role, u, vcard("n-" + role),
                 {"Content-Type": "text/vcard"}))

    # ---- collection creation / properties ---------------------------------------
    for role, e in exp(A, D, D, D, A).items():
        u = USER[role]
        cell("MKCALENDAR in owner's principal", role, e,
             lambda role=role, u=u: inst.req(
                 "MKCALENDAR", "/alice/mk-%s/" % role, u, mkcalendar_body(), XML_HDR))
    for role, e in exp(A, D, D, D, A).items():
        u = USER[role]
        cell("MKCOL address book in owner's principal", role, e,
             lambda role=role, u=u: inst.req(
                 "MKCOL", "/alice/ab-%s/" % role, u, MKCOL_BOOK, XML_HDR))
    for role, e in exp(D, D, D, D, A).items():
        u = USER[role]
        cell("MKCOL plain (untagged) collection in principal", role, e,
             lambda role=role, u=u: inst.req("MKCOL", "/alice/plain-%s/" % role, u))
    for role, e in exp(D, D, D, D, D).items():
        u = USER[role]
        cell("MKCALENDAR nested inside a calendar", role, e,
             lambda role=role, u=u: inst.req(
                 "MKCALENDAR", "/alice/cal-a/sub-%s/" % role, u, mkcalendar_body(), XML_HDR))
        cell("MKCOL plain nested inside a calendar", role, e,
             lambda role=role, u=u: inst.req("MKCOL", "/alice/cal-a/subp-%s/" % role, u))
    for role, e in exp(A, D, D, D, A).items():
        u = USER[role]
        cell("PROPPATCH collection (rename)", role, e,
             lambda u=u: inst.req("PROPPATCH", "/alice/cal-a/", u, PROPPATCH_NAME, XML_HDR))

    # ---- whole-collection PUT ----------------------------------------------------
    for role, e in exp(A, D, D, D, A).items():
        u = USER[role]
        cell("PUT creating a new collection", role, e,
             lambda role=role, u=u: inst.req(
                 "PUT", "/alice/put-new-%s/" % role, u, multi_ics("pn" + role), ICS))
    for role in ("rw", "r", "none", "admin", "owner"):  # owner last: it replaces data
        u = USER[role]
        cell("PUT overwriting an existing collection", role,
             {"owner": A, "rw": D, "r": D, "none": D, "admin": A}[role],
             lambda role=role, u=u: inst.req(
                 "PUT", "/alice/cal-put/", u, multi_ics("po" + role), ICS))

    # ---- collection deletion -----------------------------------------------------
    for role in ("rw", "r", "none"):
        u = USER[role]
        cell("DELETE collection", role, D,
             lambda u=u: inst.req("DELETE", "/alice/cal-del/", u))
    cell("DELETE collection", "admin", A,
         lambda: inst.req("DELETE", "/alice/del-admin/", "adm-1"))
    cell("DELETE collection", "owner", A,
         lambda: inst.req("DELETE", "/alice/del-owner/", "alice"))

    # ---- principal paths ---------------------------------------------------------------
    prow = []

    def pcell(label, expected, do):
        before = tree_hash(inst)
        r = do()
        after = tree_hash(inst)
        allowed = 200 <= r.status < 300
        obs = "A" if allowed else ("D" if r.status == 403 else "?")
        ok = obs == expected and (allowed or before == after)
        prow.append((label, expected, r.status, "ok" if ok else "MISMATCH"))
        if not ok:
            mismatches.append((label, "-", expected, r.status))

    for role, e in exp(A, D, D, D, A).items():
        pcell("PROPFIND /alice/ Depth 0 as %s" % role, e,
              lambda u=USER[role]: inst.req("PROPFIND", "/alice/", u, PROPFIND_ALL,
                                            dict(XML_HDR, Depth="0")))
    for role in ("owner", "admin"):
        pcell("DELETE principal /alice/ as %s" % role, D,
              lambda u=USER[role]: inst.req("DELETE", "/alice/", u))
    pcell("DELETE principal /eve/ as admin", D,
          lambda: inst.req("DELETE", "/eve/", "adm-1"))
    pcell("PROPFIND / Depth 0 as non-granted", A,
          lambda: inst.req("PROPFIND", "/", "eve", PROPFIND_ALL, dict(XML_HDR, Depth="0")))
    pcell("MKCOL top-level /zz-new/ as owner", D,
          lambda: inst.req("MKCOL", "/zz-owner/", "alice"))
    pcell("MKCALENDAR top-level /zz-cal/ as owner", D,
          lambda: inst.req("MKCALENDAR", "/zz-cal/", "alice", mkcalendar_body(), XML_HDR))
    pcell("MKCOL top-level /zz-adm/ as admin (admin principal rule)", A,
          lambda: inst.req("MKCOL", "/zz-adm/", "adm-1"))
    pcell("PROPPATCH own principal as owner", A,
          lambda: inst.req("PROPPATCH", "/alice/", "alice", PROPPATCH_NAME, XML_HDR))

    print()
    print(md_table(rows, ["action", "role", "expected", "status", "observed", "verdict"]))
    print()
    print(md_table(prow, ["principal-level action", "expected", "status", "verdict"]))
    print()
    c.check("matrix/all-cells-as-planned", not mismatches,
            "%d cells + %d principal cells; mismatches: %s"
            % (len(rows), len(prow), mismatches if mismatches else "none"))
    c.check("matrix/denied-cells-have-no-side-effects",
            not any("SIDE-EFFECT" in r[5] for r in rows),
            "storage tree hash unchanged after every denied request")
    inst.stop()

    # ---- principal auto-creation and ownSpace=false -----------------------------------
    def autocreate(variant):
        m = gen.default_model(1, with_grants=False)
        m["grants"] = [{"owner": "alice", "collection": "cal-a",
                        "grantee": "agent-1", "level": "readwrite"}]
        i2 = Instance("s03-ac-" + variant, model=m, level="info",
                      ownspace_false_principal=variant)
        i2.start()
        i2.make_member("alice", "cal-a")
        i2.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"), ICS)
        dir_before = os.path.isdir(os.path.join(i2.collections_dir(), "agent-1"))
        off = len(i2.log())
        r0 = i2.req("PROPFIND", "/", "agent-1", None, {"Depth": "0"})
        created = os.path.isdir(os.path.join(i2.collections_dir(), "agent-1"))
        r_get = i2.req("GET", "/alice/cal-a/e1.ics", "agent-1")
        r_put = i2.req("PUT", "/alice/cal-a/e2.ics", "agent-1", ics_event("e2"), ICS)
        r_own = i2.req("PROPFIND", "/agent-1/", "agent-1", PROPFIND_ALL,
                       dict(XML_HDR, Depth="0"))
        r_mk = i2.req("MKCALENDAR", "/agent-1/mine/", "agent-1", mkcalendar_body(), XML_HDR)
        warned = "Access to principal path" in i2.log_since(off)
        r_root1 = i2.req("PROPFIND", "/", "agent-1", PROPFIND_ALL, dict(XML_HDR, Depth="1"))
        i2.stop()
        return (dir_before, r0.status, created, r_get.status, r_put.status,
                r_own.status, r_mk.status, warned, r_root1.status)

    arows = []
    for variant in ("RW", "R", "none"):
        (pre, s0, created, sg, sp, so, smk, warned, sroot) = autocreate(variant)
        arows.append((variant, s0, created, sg, sp, so, smk, warned, sroot))
    print()
    print(md_table(arows, ["ownSpace=false principal rule", "first PROPFIND /",
                           "principal dir created", "GET granted item",
                           "PUT granted (rw)", "PROPFIND own principal",
                           "MKCALENDAR in own principal", "warning logged",
                           "PROPFIND / Depth 1"]))
    by = {a[0]: a for a in arows}
    c.check("autocreate/RW-creates-principal", by["RW"][2] is True,
            "rule RW: principal directory created at first request = %s" % by["RW"][2])
    c.check("autocreate/R-does-not-create", by["R"][2] is False,
            "rule R: created = %s, warning logged = %s" % (by["R"][2], by["R"][7]))
    c.check("autocreate/no-rule-does-not-create", by["none"][2] is False,
            "no rule: created = %s" % by["none"][2])
    c.check("ownSpace-false/can-use-grants-in-all-variants",
            all(a[3] == 200 and a[4] in (201, 204) for a in arows),
            "granted GET/PUT statuses per variant: %s" % [(a[0], a[3], a[4]) for a in arows])
    c.check("ownSpace-false/cannot-create-own-collections",
            all(a[6] == 403 for a in arows),
            "MKCALENDAR in own principal per variant: %s" % [(a[0], a[6]) for a in arows])
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
