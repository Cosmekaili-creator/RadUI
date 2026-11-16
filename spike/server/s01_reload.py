#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S1: are rights cached by stock from_file, and does the plugin hot-reload?

Pass criteria (plan section 4): a rights change has NO effect on the stock
engine until restart, and takes effect on the very next request with the
plugin (atomic replace and in-place rewrite), including the generation probe.
Also measures the per-request cost of the plugin.
"""
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, ics_event, gen, scrub,  # noqa: E402
                    mkcalendar_body)


def setup(inst):
    inst.start()
    assert inst.alive(), "radicale did not start"
    r = inst.make_member("alice", "cal-a")
    assert r.status == 201, r.status
    r = inst.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"),
                 {"Content-Type": "text/calendar"})
    assert r.status == 201, r.status


def model_with(grant, generation):
    m = gen.default_model(generation, with_grants=False)
    if grant:
        m["grants"] = [{"owner": "alice", "collection": "cal-a",
                        "grantee": "bob", "level": "readwrite"}]
    return m


def probe(inst, model):
    return inst.req("GET", "/radui-gen-" + model["genToken"]).status


def run_engine(c, kind):
    inst = Instance("s01-" + kind, rights=("from_file" if kind == "stock"
                                           else "radui_rights"))
    inst.write_rights_model(model_with(True, 1))
    setup(inst)
    bob = lambda: inst.req("GET", "/alice/cal-a/e1.ics", "bob").status  # noqa: E731
    c.check("%s/granted-initially" % kind, bob() == 200, "bob GET -> %d" % bob())

    # 1. revoke through an atomic replace (what the real backend does)
    m2 = model_with(False, 2)
    inst.write_rights_model(m2)
    s_first = bob()
    time.sleep(1.2)
    s_later = bob()
    p = probe(inst, m2)
    if kind == "stock":
        c.check("stock/revoke-ignored-at-runtime", s_first == 200 and s_later == 200,
                "after atomic rewrite bob GET -> %d, 1.2 s later -> %d; new-generation "
                "probe -> %d (404 would mean active)" % (s_first, s_later, p))
        c.check("stock/probe-reports-not-active", p == 401, "probe -> %d" % p)
        inst.restart()
        s_restart = bob()
        c.check("stock/effective-after-restart", s_restart == 403,
                "after restart bob GET -> %d; probe -> %d" % (s_restart, probe(inst, m2)))
    else:
        c.check("plugin/revoke-effective-next-request", s_first == 403 and s_later == 403,
                "after atomic rewrite bob GET -> %d (first request), %d (later); "
                "new-generation probe -> %d" % (s_first, s_later, p))
        c.check("plugin/probe-reports-active", p == 404, "probe -> %d" % p)

        # 2. grant again, in-place rewrite of the same inode
        m3 = model_with(True, 3)
        ino0 = os.stat(inst.rights_path).st_ino
        inst.write_rights_model(m3, atomic=False)
        same_inode = os.stat(inst.rights_path).st_ino == ino0
        s = bob()
        c.check("plugin/grant-effective-in-place-rewrite", s == 200 and same_inode,
                "in-place rewrite (same inode=%s): bob GET -> %d, probe -> %d"
                % (same_inode, s, probe(inst, m3)))

        # 3. rapid equal-size rewrites inside one timestamp granule
        bad = 0
        n = 60
        for i in range(n):
            granted = (i % 2 == 0)
            m = model_with(granted, 10 + i)
            inst.write_rights_model(m, atomic=False)
            s = bob()
            if (s == 200) != granted:
                bad += 1
        c.check("plugin/equal-size-rewrites-all-seen", bad == 0,
                "%d in-place equal-size rewrites each followed immediately by a "
                "request: %d stale answers" % (n, bad))

    # per-request cost in the settled state: alice GET, 300 sequential requests
    time.sleep(2.5)
    ts = []
    for _ in range(300):
        ts.append(inst.req("GET", "/alice/cal-a/e1.ics", "alice").dt)
    med = statistics.median(ts) * 1000
    c.info("%s: median GET latency %.2f ms over 300 requests (bcrypt cost 4)"
           % (kind, med))
    # startup log line
    log = inst.log()
    if kind == "plugin":
        lines = [ln for ln in log.splitlines() if "radui_rights: active" in ln]
        c.check("plugin/startup-warning-line", len(lines) >= 1 and "[WARNING]" in lines[0],
                "%d line(s); first: %s" % (len(lines), scrub(lines[0], inst)[:160]
                                           if lines else "none"))
    inst.stop()
    return med


def main():
    c = Checker("S1 rights cache vs plugin hot-reload")
    m_stock = run_engine(c, "stock")
    m_plugin = run_engine(c, "plugin")
    c.info("plugin overhead per request: %.2f ms (stock %.2f ms, plugin %.2f ms)"
           % (m_plugin - m_stock, m_stock, m_plugin))
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
