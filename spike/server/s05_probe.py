#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S5: the generation probe (anonymous GET on an unguessable path with letter `i`).

Questions: 404 with the rule vs 401 without; how long an anonymous 401 takes
and whether it holds a connection slot (max_connections = 8 by default); what
happens when a real top-level collection exists at the probe path (plan m9);
polling behaviour for a probe that never turns active.
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Instance, gen  # noqa: E402


def main():
    c = Checker("S5 generation probe")
    inst = Instance("s05", rights="radui_rights", level="info", delay=1)
    inst.start()
    tok = inst.model["genToken"]
    path = "/radui-gen-" + tok

    r = inst.req("GET", path)
    c.check("probe/with-rule-404", r.status == 404 and r.dt < 0.2,
            "anonymous GET -> %d in %.3f s" % (r.status, r.dt))
    r = inst.req("HEAD", path)
    c.info("anonymous HEAD -> %d" % r.status)
    other = "/radui-gen-" + gen.new_token()
    lat = []
    codes = []
    for _ in range(6):
        r = inst.req("GET", other)
        lat.append(r.dt)
        codes.append(r.status)
    c.check("probe/without-rule-401-delayed",
            set(codes) == {401} and 0.45 <= min(lat) and max(lat) <= 1.6,
            "6 anonymous GETs on a path with no rule -> %s, latency min %.2f max %.2f s "
            "(delay=1 -> uniform 0.5..1.5 s)" % (sorted(set(codes)), min(lat), max(lat)))
    c.check("probe/401-has-www-authenticate",
            "www-authenticate" in r.headers,
            "WWW-Authenticate present on the anonymous 401: %s (the BACKEND must not relay it)"
            % ("www-authenticate" in r.headers))
    r = inst.req("GET", path + "/x")
    c.check("probe/subpath-not-matched", r.status == 401, "GET <probe>/x -> %d" % r.status)
    r = inst.req("PROPFIND", path, None, None, {"Depth": "0"})
    c.check("probe/propfind-anonymous-refused", r.status == 401,
            "anonymous PROPFIND on the probe path -> %d" % r.status)
    r = inst.req("PUT", path, None, "x")
    c.check("probe/put-anonymous-refused", r.status == 401, "anonymous PUT -> %d" % r.status)
    r = inst.req("GET", path, "alice")
    c.check("probe/authenticated-user-gets-403", r.status == 403,
            "authenticated user GET on the probe path -> %d (zzz-deny; 404 only for anonymous)"
            % r.status)

    # m9: a real top-level collection at the probe path (admin may create top-level names)
    existing = "/radui-gen-" + tok
    r = inst.req("MKCOL", existing + "/", "adm-1")
    r2 = inst.req("GET", existing)
    r3 = inst.req("GET", existing + "/")
    c.check("probe/m9-existing-path-gives-401-not-404",
            r.status == 201 and r2.status == 401 and r3.status == 401,
            "admin MKCOL on the probe path -> %d; anonymous GET afterwards -> %d / %d "
            "(so the probe must tolerate 401 on an existing path, and the `radui-gen-` "
            "prefix must be a reserved collection name)" % (r.status, r2.status, r3.status))
    inst.req("DELETE", existing + "/", "adm-1")  # no D letter: expected 403
    r = inst.req("GET", existing)
    c.info("after the (denied) cleanup attempt the path still answers %d" % r.status)

    # probe polling that never succeeds: 300 ms interval, one probe in flight
    t0 = time.monotonic()
    attempts = []
    while time.monotonic() - t0 < 3.0:
        s = time.monotonic()
        rr = inst.req("GET", "/radui-gen-" + gen.new_token())
        attempts.append((rr.status, rr.dt))
        left = 0.3 - (time.monotonic() - s)
        if left > 0:
            time.sleep(left)
    c.check("probe/pending-poll-count", 2 <= len(attempts) <= 4,
            "3 s window, 300 ms interval, one in flight: %d attempts, statuses %s"
            % (len(attempts), sorted(set(a[0] for a in attempts))))

    # slot occupation: 8 concurrent anonymous 401s, then an authenticated request
    done = []

    def anon():
        done.append(inst.req("GET", "/radui-gen-" + gen.new_token()).dt)

    ths = [threading.Thread(target=anon) for _ in range(8)]
    for t in ths:
        t.start()
    time.sleep(0.15)
    r = inst.req("PROPFIND", "/alice/", "alice", None, {"Depth": "0"})
    waited = r.dt
    for t in ths:
        t.join()
    r_idle = inst.req("PROPFIND", "/alice/", "alice", None, {"Depth": "0"})
    c.check("probe/anonymous-401s-hold-connection-slots", waited > 0.25,
            "authenticated request issued while 8 anonymous 401s were in flight took "
            "%.2f s (idle: %.3f s): each sleeping 401 holds 1 of max_connections=8"
            % (waited, r_idle.dt))
    inst.stop()

    # stock engine: the same probe cannot see a new generation until restart
    inst2 = Instance("s05-stock", rights="from_file", delay=1)
    inst2.start()
    new = gen.default_model(2)
    inst2.write_rights_model(new)
    r = inst2.req("GET", "/radui-gen-" + new["genToken"])
    c.check("probe/stock-reports-401-until-restart", r.status == 401,
            "stock engine after rewrite -> %d" % r.status)
    inst2.restart()
    r = inst2.req("GET", "/radui-gen-" + new["genToken"])
    c.check("probe/stock-reports-404-after-restart", r.status == 404,
            "after restart -> %d" % r.status)
    inst2.stop()

    # variant: admin gets R (not RW) on other users' principal paths
    inst3 = Instance("s05-adminR", rights="radui_rights",
                     gen_opts={"admin_other_principals": "R"})
    inst3.start()
    inst3.req("PROPFIND", "/", "alice", None, {"Depth": "0"})
    r_mk = inst3.req("MKCOL", "/radui-gen-" + gen.new_token() + "/", "adm-1")
    r_own = inst3.req("PROPFIND", "/adm-1/", "adm-1", None, {"Depth": "0"})
    r_oth = inst3.req("PROPFIND", "/alice/", "adm-1", None, {"Depth": "0"})
    r_cal = inst3.make_member("alice", "cal-a")
    r_adm_cal = inst3.req("MKCALENDAR", "/alice/cal-adm/", "adm-1",
                          __import__("common").mkcalendar_body(), __import__("common").XML_HDR)
    c.check("probe/variant-admin-R-cannot-create-top-level-names",
            r_mk.status == 403 and r_own.status == 207 and r_oth.status == 207
            and r_adm_cal.status == 201,
            "admin with RW only on its own principal: MKCOL top-level -> %d, PROPFIND own "
            "-> %d, PROPFIND other principal -> %d, MKCALENDAR inside other principal -> %d"
            % (r_mk.status, r_own.status, r_oth.status, r_adm_cal.status))
    inst3.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
