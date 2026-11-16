# SPDX-License-Identifier: AGPL-3.0-or-later
"""``max_connections`` re-measurement: Radicale's default (8) against 32 under
20 simultaneous clients, with real bcrypt cost 12 hashes.

Attacker/load model: a burst of legitimate clients (calendar syncs, agents)
plus the backend's own anonymous generation probe. Recorded per setting:
requests, requests/s, latency p50/p95/p99/max, transport failures by type
(connection reset, refused, timeout), HTTP 5xx, and how many backend
mutations made during the load were confirmed active within the 3 s probe
budget. Runs only with ``RADUI_WP10_PERF=1`` (``make test-integration``
sets it); the numbers go to docs/testing.md.
"""
import json
import os
import socket
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wp10_support as W  # noqa: E402
from plugin import support  # noqa: E402

CLIENTS = int(os.environ.get("RADUI_WP10_CLIENTS", "20"))
SECONDS = float(os.environ.get("RADUI_WP10_SECONDS", "12"))
USERS = ["alice", "p-one", "p-two", "p-three"]


def pct(values, q):
    s = sorted(values)
    return s[min(len(s) - 1, int(q * len(s)))] if s else 0.0


def load(stack, clients, seconds):
    stop = threading.Event()
    lat, errors, codes = [], {}, {}
    lock = threading.Lock()

    def worker(i):
        user = USERS[i % len(USERS)]
        n = 0
        while not stop.is_set():
            n += 1
            t0 = time.monotonic()
            try:
                if n % 5 == 0:
                    r = stack.dav("PUT", "/%s/cal/l-%d-%d.ics" % (user, i, n),
                                  user, support.ics_event("l-%d-%d" % (i, n)),
                                  support.ICS_HDR)
                else:
                    r = stack.dav("PROPFIND", "/%s/cal/" % user, user, None,
                                  dict(support.XML_HDR, Depth="0"))
                status = r.status
                err = None
            except (OSError, Exception) as exc:  # noqa: BLE001
                status, err = None, type(exc).__name__
            dt = time.monotonic() - t0
            with lock:
                if err:
                    errors[err] = errors.get(err, 0) + 1
                else:
                    lat.append(dt)
                    codes[status] = codes.get(status, 0) + 1

    threads = [threading.Thread(target=worker, args=(i,), daemon=True)
               for i in range(clients)]
    # the backend's own mutations (anonymous generation probe) during the load
    mutations = []

    def mutator():
        time.sleep(1.0)
        for k in range(4):
            t0 = time.monotonic()
            r = stack.api("PATCH", "/accounts/mut-1", "alice",
                          {"displayName": "Mutation %d" % k}, timeout=60)
            mutations.append((r.status, bool(r.json and r.json.get("active")),
                              time.monotonic() - t0))
            time.sleep(1.5)

    t_mut = threading.Thread(target=mutator, daemon=True)
    t0 = time.monotonic()
    for t in threads:
        t.start()
    t_mut.start()
    time.sleep(seconds)
    stop.set()
    for t in threads:
        t.join(timeout=60)
    t_mut.join(timeout=60)
    elapsed = time.monotonic() - t0
    return {
        "clients": clients, "seconds": round(elapsed, 1),
        "requests": len(lat) + sum(errors.values()), "ok_answers": len(lat),
        "req_per_s": round(len(lat) / elapsed, 1),
        "p50_ms": round(pct(lat, .5) * 1000), "p95_ms": round(pct(lat, .95) * 1000),
        "p99_ms": round(pct(lat, .99) * 1000), "max_ms": round(max(lat) * 1000) if lat else 0,
        "http_status": dict(sorted(codes.items())),
        "http_5xx": sum(v for k, v in codes.items() if k >= 500),
        "transport_failures": errors,
        "mutations_during_load": [
            {"status": s, "active": a, "seconds": round(d, 2)}
            for s, a, d in mutations],
    }


@unittest.skipUnless(os.environ.get("RADUI_WP10_PERF") == "1",
                     "set RADUI_WP10_PERF=1 (make test-integration)")
@W.requires_radicale
class MaxConnections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = W.WStack("perf", cfg={"bcrypt_cost": 12}, max_connections=8)
        cls.addClassCleanup(s.close)
        s.up()
        # alice came from the legacy import at cost 4: give her a cost 12 hash
        pw = "a long enough passphrase 2!"
        r = s.api("POST", "/accounts/alice/password", "alice", {"password": pw})
        assert r.status == 200, r.json
        s.pw["alice"] = pw
        for login in USERS[1:] + ["mut-1"]:
            s.make_user(login)
        for login in USERS:
            assert s.mkcalendar(login, login, "cal").status in (201, 405), login
        cls.results = {}

    def measure(self, n):
        self.s.set_max_connections(n)
        res = load(self.s, CLIENTS, SECONDS)
        self.results[n] = res
        W.info("max_connections=%d: %s" % (n, json.dumps(res, sort_keys=True)))
        return res

    def test_default_8_against_32(self):
        r8 = self.measure(8)
        r32 = self.measure(32)
        cpus = os.cpu_count()
        W.info("cpus=%s clients=%d seconds=%s bcrypt_cost=12" %
               (cpus, CLIENTS, SECONDS))
        out = os.path.join(W.WP10_DIR, "perf-results.json")
        with open(out, "w") as fh:
            json.dump({"cpus": cpus, "results": self.results}, fh, indent=1)
        # nothing may answer 5xx at either setting
        self.assertEqual(r8["http_5xx"], 0, r8)
        self.assertEqual(r32["http_5xx"], 0, r32)
        # the recommended value: no transport failure at all under 20 clients
        self.assertEqual(r32["transport_failures"], {}, r32)
        # an 8-slot server may drop connections: that is the measurement
        if r8["transport_failures"]:
            W.info("the default (8) dropped connections under %d clients: %s"
                   % (CLIENTS, r8["transport_failures"]))
        else:
            W.info("the default (8) dropped no connection under %d clients "
                   "in this run" % CLIENTS)


if __name__ == "__main__":
    unittest.main()
