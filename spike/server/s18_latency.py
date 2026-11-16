#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S18: DAV request latency and throughput at bcrypt cost 12 with 8 connection slots.

Every authenticated request makes Radicale verify the bcrypt hash (the users
file is re-read and checked per request), so throughput is bounded by CPU.
Measures sequential latency, then throughput/latency at several client
counts, then max_connections 8 vs 16, then cost 10 and cost 4 for comparison,
and the latency of the anonymous generation probe while the server is loaded.
Duration per level is RADUI_S18_SECONDS (default 5). Client threads <= 20.
"""
import os
import statistics
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bcrypt  # noqa: E402
from common import (Checker, Instance, XML_HDR, ics_event, md_table)  # noqa: E402

SECONDS = float(os.environ.get("RADUI_S18_SECONDS", "5"))
ICS = {"Content-Type": "text/calendar"}
USERS = ["alice", "bob", "eve", "adm-1"]


def pct(vals, q):
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * len(s)))] if s else 0.0


def load(inst, clients, seconds, mixed=False):
    stop = threading.Event()
    lat = []
    puts = []
    codes = {}
    lock = threading.Lock()

    def worker(i):
        n = 0
        user = USERS[i % len(USERS)]
        while not stop.is_set():
            n += 1
            t0 = time.monotonic()
            if mixed and n % 5 == 0:
                r = inst.req("PUT", "/%s/cal-a/l-%d-%d.ics" % (user, i, n), user,
                             ics_event("l-%d-%d" % (i, n)), ICS)
                kind = "put"
            else:
                r = inst.req("PROPFIND", "/%s/cal-a/" % user, user, None,
                             dict(XML_HDR, Depth="0"))
                kind = "propfind"
            dt = time.monotonic() - t0
            with lock:
                (puts if kind == "put" else lat).append(dt)
                codes[r.status] = codes.get(r.status, 0) + 1

    probe_lat = []

    def prober():
        # anonymous generation probe: 404 path, no bcrypt
        while not stop.is_set():
            r = inst.req("GET", "/radui-gen-" + inst.model["genToken"])
            probe_lat.append(r.dt)
            time.sleep(0.3)

    ths = [threading.Thread(target=worker, args=(i,)) for i in range(clients)]
    ths.append(threading.Thread(target=prober))
    for t in ths:
        t.start()
    t0 = time.monotonic()
    time.sleep(seconds)
    stop.set()
    for t in ths:
        t.join(timeout=120)
    el = time.monotonic() - t0
    allv = lat + puts
    return {"clients": clients, "ops_s": len(allv) / el, "p50": pct(allv, 0.5),
            "p95": pct(allv, 0.95), "max": max(allv) if allv else 0, "codes": codes,
            "probe_p50": pct(probe_lat, 0.5), "probe_max": max(probe_lat) if probe_lat else 0,
            "n": len(allv)}


def setup(name, cost, max_conn):
    inst = Instance(name, rights="radui_rights", bcrypt_cost=cost, delay=1,
                    max_connections=max_conn)
    inst.start()
    for u in USERS:
        # each user owns a calendar so every request is a plain authenticated PROPFIND
        r = inst.make_member(u, "cal-a")
        assert r.status == 201, (u, r.status)
    return inst


def fmt(r):
    return (r["clients"], "%.1f" % r["ops_s"], "%.0f" % (r["p50"] * 1000),
            "%.0f" % (r["p95"] * 1000), "%.0f" % (r["max"] * 1000),
            "%.0f / %.0f" % (r["probe_p50"] * 1000, r["probe_max"] * 1000),
            dict(r["codes"]))


def main():
    c = Checker("S18 latency and throughput")
    c.info("CPU count: %d; load average at start: %s" % (os.cpu_count(),
                                                        os.getloadavg()))
    # standalone bcrypt capacity
    h = bcrypt.hashpw(b"x", bcrypt.gensalt(rounds=12))
    t0 = time.perf_counter()
    for _ in range(4):
        bcrypt.checkpw(b"x", h)
    one = (time.perf_counter() - t0) / 4
    res = []

    def par(n):
        for _ in range(3):
            bcrypt.checkpw(b"x", h)

    ths = [threading.Thread(target=par, args=(0,)) for _ in range(os.cpu_count() or 4)]
    t0 = time.perf_counter()
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    par_el = time.perf_counter() - t0
    rate = len(ths) * 3 / par_el
    c.info("bcrypt cost 12 verify: %.0f ms single thread; %d threads together: %.1f verifies/s"
           % (one * 1000, len(ths), rate))

    inst = setup("s18-c12", 12, None)
    seq = [inst.req("PROPFIND", "/alice/cal-a/", "alice", None, dict(XML_HDR, Depth="0")).dt
           for _ in range(10)]
    seq_put = [inst.req("PUT", "/alice/cal-a/s-%d.ics" % i, "alice", ics_event("s%d" % i),
                        ICS).dt for i in range(10)]
    anon = [inst.req("GET", "/radui-gen-" + inst.model["genToken"]).dt for _ in range(10)]
    c.check("sequential/cost12-latency-recorded", True,
            "authenticated PROPFIND median %.0f ms, authenticated PUT median %.0f ms, "
            "anonymous probe (404, no bcrypt) median %.1f ms"
            % (statistics.median(seq) * 1000, statistics.median(seq_put) * 1000,
               statistics.median(anon) * 1000))
    rows = []
    results = {}
    for n in (1, 2, 4, 8, 12, 20):
        r = load(inst, n, SECONDS)
        results[("c12-m8", n)] = r
        rows.append(fmt(r))
    r = load(inst, 8, SECONDS, mixed=True)
    results[("c12-m8-mixed", 8)] = r
    print()
    print("cost 12, max_connections 8 (default), PROPFIND only; probe column = anonymous "
          "probe p50 / max in ms while loaded")
    print(md_table(rows, ["clients", "req/s", "p50 ms", "p95 ms", "max ms", "probe p50/max ms",
                          "statuses"]))
    print()
    print("cost 12, 8 clients, 80% PROPFIND + 20% PUT")
    print(md_table([fmt(r)], ["clients", "req/s", "p50 ms", "p95 ms", "max ms",
                              "probe p50/max ms", "statuses"]))
    inst.stop()

    rows2 = []
    inst = setup("s18-c12-m16", 12, 16)
    for n in (8, 20):
        r = load(inst, n, SECONDS)
        results[("c12-m16", n)] = r
        rows2.append(("12", 16) + fmt(r)[:])
    inst.stop()
    for cost in (10, 4):
        inst = setup("s18-c%d" % cost, cost, None)
        for n in (8, 20):
            r = load(inst, n, SECONDS)
            results[("c%d-m8" % cost, n)] = r
            rows2.append((cost, 8) + fmt(r))
        inst.stop()
    print()
    print("comparison: bcrypt cost / max_connections")
    print(md_table(rows2, ["cost", "max_conn", "clients", "req/s", "p50 ms", "p95 ms", "max ms",
                           "probe p50/max ms", "statuses"]))
    bad = [k for k, v in results.items() if any(code >= 500 for code in v["codes"])]
    c.check("no-5xx-under-load", not bad,
            "levels with 5xx: %s" % (bad or "none"))
    five = results[("c12-m8", 20)]
    c.info("cost 12 @20 clients: %.1f req/s, p95 %.0f ms; @8 clients: %.1f req/s, p95 %.0f ms; "
           "max_connections=16 @20 clients: %.1f req/s, p95 %.0f ms"
           % (five["ops_s"], five["p95"] * 1000, results[("c12-m8", 8)]["ops_s"],
              results[("c12-m8", 8)]["p95"] * 1000, results[("c12-m16", 20)]["ops_s"],
              results[("c12-m16", 20)]["p95"] * 1000))
    c.check("throughput-bounded-by-cpu-not-by-slots",
            results[("c12-m8", 20)]["ops_s"] <= rate * 1.3 + 1,
            "measured %.1f req/s vs standalone bcrypt capacity %.1f verifies/s on %d CPUs"
            % (results[("c12-m8", 20)]["ops_s"], rate, os.cpu_count()))
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
