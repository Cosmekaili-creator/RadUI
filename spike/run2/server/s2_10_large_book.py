#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-10: a 2,000-contact address book at bcrypt cost 12, max_connections 32.

Fictional cards are written straight into the throwaway storage directory (the
filesystem seeding method of the integration harness), then timed: baseline
authenticated request, sync-collection (cold item cache, warm, with a token),
the Depth-1 ETag listing, a full addressbook-multiget of all 2,000 cards, the
same in 10 chunks of 200, the whole-collection GET, one PUT, and what a second
client experiences while a big multiget is running. Every timing is INFO (the
machine decides the numbers); the PASS/FAIL lines check correctness (counts,
status codes, no 5xx, no dropped connection).
"""
import base64
import hashlib
import os
import re
import statistics
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, multistatus,  # noqa: E402
                    sync_body, sync_token, multiget_body, propfind_etag, mkcol_book,
                    short, VCF, XML)

N = int(os.environ.get("RADUI_S210_COUNT", "2000"))


def photo_b64(i):
    raw = b""
    n = 0
    while len(raw) < 12000:
        raw += hashlib.sha256(("photo-%d-%d" % (i, n)).encode()).digest()
        n += 1
    return base64.b64encode(raw).decode()


def make_card(i):
    ver = "4.0" if i % 2 else "3.0"
    lines = ["BEGIN:VCARD", "VERSION:" + ver, "UID:bulk-%05d" % i,
             "FN:Person%05d Example" % i, "N:Example;Person%05d;;;" % i,
             "ORG:Example Org %d" % (i % 97),
             "TEL;TYPE=CELL:+1555%07d" % i, "TEL;TYPE=WORK:+1555%07d" % (i + 7),
             "EMAIL;TYPE=INTERNET:person%05d@example.org" % i,
             "ADR;TYPE=HOME:;;%d Main Street;Springfield;;12345;Exampleland" % i,
             "NOTE:Generated fictional contact number %d" % i,
             "CATEGORIES:Group%d,Everyone" % (i % 12)]
    if i % 20 == 0:
        b64 = photo_b64(i)
        folded = "PHOTO;ENCODING=b;TYPE=JPEG:" + b64
        out, first = [], True
        while folded:
            n = 75 if first else 74
            out.append(folded[:n] if first else " " + folded[:n])
            folded = folded[n:]
            first = False
        lines += out
    lines.append("END:VCARD")
    return "\r\n".join(lines) + "\r\n"


def rss_mb(pid):
    try:
        with open("/proc/%d/status" % pid) as fh:
            for ln in fh:
                if ln.startswith("VmRSS:"):
                    return int(ln.split()[1]) // 1024
    except OSError:
        pass
    return -1


def timed(fn):
    t0 = time.monotonic()
    r = fn()
    return r, time.monotonic() - t0


def seed_book(s, name, count):
    """Create ``alice/<name>`` and copy ``count`` cards into its directory."""
    assert s.req("MKCOL", "/alice/%s/" % name, "alice", mkcol_book(name),
                 XML).status == 201
    root = os.path.join(s.storage_root(), "alice", name)
    total = 0
    for i in range(count):
        text = make_card(i)
        total += len(text)
        with open(os.path.join(root, "bulk-%05d.vcf" % i), "wb") as fh:
            fh.write(text.encode())
    return total


def main():
    require_memory()
    c = Checker("S2-10 2,000-contact address book, bcrypt 12, max_connections 32")
    s = standard_stack("s210", max_connections=32, cost=12)
    try:
        # alice came from the legacy import at cost 4: give her a cost-12 hash
        pw = "a long enough passphrase 2!"
        r = s.api("POST", "/accounts/alice/password", "alice", {"password": pw})
        assert r.status == 200
        s.pw["alice"] = pw
        c.info("setup", "bcrypt cost %d for alice and bob (backend config), "
               "max_connections 32, Radicale %s, %d CPUs" % (
                   12, "3.x", os.cpu_count()))
        base = "/alice/big/"
        t0 = time.monotonic()
        total = seed_book(s, "big", N)
        s.grant("alice", "big", "bob", "readwrite")
        c.info("seed", "%d cards written by file copy in %.2f s, %.1f MB on disk "
               "(every 20th card has a ~12 KB photo)" % (
                   N, time.monotonic() - t0, total / 1e6))
        pid = s.rproc.pid

        # baseline: one authenticated request that touches no items
        ts = []
        for _ in range(5):
            r, dt = timed(lambda: s.req("PROPFIND", base, "alice", propfind_etag(),
                                        dict(XML, Depth="0")))
            ts.append(dt)
        c.expect("baseline/ok", r.status == 207, "PROPFIND Depth 0 -> %d" % r.status)
        c.info("baseline/authenticated-request",
               "median %.0f ms, min %.0f ms over 5 (bcrypt cost 12 verification "
               "is the floor of every request)" % (
                   statistics.median(ts) * 1000, min(ts) * 1000))
        r, dt = timed(lambda: s.req("PROPFIND", base, "bob", propfind_etag(),
                                    dict(XML, Depth="0")))
        c.info("baseline/grantee", "PROPFIND Depth 0 as rw grantee: %.0f ms" % (dt * 1000))

        # sync-collection, cold then warm
        r, dt = timed(lambda: s.req("REPORT", base, "alice", sync_body(None), XML))
        ents = {k: v for k, v in multistatus(r.body).items() if k != base}
        token = sync_token(r.body)
        c.expect("sync/cold-lists-all", r.status == 207 and len(ents) == N,
                 "REPORT sync-collection, empty token -> %d, %d entries, %d "
                 "bytes" % (r.status, len(ents), len(r.body)))
        cold_sync = dt
        c.info("sync/cold-time", "%.2f s (first read of %d never-seen cards: "
               "Radicale builds its item cache)" % (dt, N))
        warm = []
        for _ in range(3):
            r, dt = timed(lambda: s.req("REPORT", base, "alice", sync_body(None), XML))
            warm.append(dt)
        c.info("sync/warm-time", "initial sync again (cache warm): median "
               "%.2f s, %d bytes" % (statistics.median(warm), len(r.body)))
        r, dt = timed(lambda: s.req("REPORT", base, "alice", sync_body(token), XML))
        c.expect("sync/token-no-change", r.status == 207 and not {
            k for k in multistatus(r.body) if k != base},
                 "sync with the current token -> %d, no entries" % r.status)
        c.info("sync/token-no-change-time", "%.0f ms" % (dt * 1000))
        r, dt = timed(lambda: s.req("REPORT", base, "bob", sync_body(None), XML))
        gn = len([k for k in multistatus(r.body) if k != base])
        c.expect("sync/grantee", r.status == 207 and gn == N,
                 "rw grantee initial sync -> %d, %d entries, %.2f s" % (
                     r.status, gn, dt))

        # the Depth-1 ETag listing (the fallback path)
        r, dt = timed(lambda: s.req("PROPFIND", base, "alice", propfind_etag(),
                                    dict(XML, Depth="1")))
        lst = {k: v for k, v in multistatus(r.body).items() if k != base}
        c.expect("etag-listing/all", r.status == 207 and len(lst) == N and all(
            v["etag"] for v in lst.values()),
                 "PROPFIND Depth 1 getetag -> %d, %d entries with ETag, %d bytes"
                 % (r.status, len(lst), len(r.body)))
        c.info("etag-listing/time", "%.2f s" % dt)
        c.expect("etag-listing/equals-sync", {k: v["etag"] for k, v in lst.items()}
                 == {k: v["etag"] for k, v in ents.items()},
                 "ETags of the listing equal the sync-collection ETags")
        hrefs = sorted(ents)

        # full multiget
        rss0 = rss_mb(pid)
        body = multiget_body(hrefs)
        r, dt = timed(lambda: s.req("REPORT", base, "alice", body, XML))
        got = {k: v for k, v in multistatus(r.body).items() if k != base}
        ok = len(got) == N and all(v["data"] and "BEGIN:VCARD" in v["data"]
                                   for v in got.values())
        c.expect("multiget/full-2000", r.status == 207 and ok,
                 "one addressbook-multiget of %d hrefs (request %d bytes) -> "
                 "%d, %d cards back, response %.1f MB" % (
                     N, len(body), r.status, len(got), len(r.body) / 1e6))
        c.info("multiget/full-time", "%.2f s cold, Radicale RSS %d MB -> %d MB"
               % (dt, rss0, rss_mb(pid)))
        r, dt = timed(lambda: s.req("REPORT", base, "alice", body, XML))
        c.info("multiget/full-time-repeat", "%.2f s" % dt)
        etag_ok = all(got[h]["etag"] == ents[h]["etag"] for h in hrefs)
        c.expect("multiget/etags-equal-sync", etag_ok,
                 "multiget ETags equal the sync ETags for every card")
        # chunks of 200, sequential
        t0 = time.monotonic()
        n_back = 0
        codes = set()
        for i in range(0, N, 200):
            rr = s.req("REPORT", base, "alice", multiget_body(hrefs[i:i + 200]), XML)
            codes.add(rr.status)
            n_back += len([k for k in multistatus(rr.body) if k != base])
        dt = time.monotonic() - t0
        c.expect("multiget/chunks-of-200", codes == {207} and n_back == N,
                 "%d chunks of 200: statuses %s, %d cards back" % (
                     (N + 199) // 200, sorted(codes), n_back))
        c.info("multiget/chunks-of-200-time", "%.2f s in total (vs the single "
               "request above; each chunk pays the bcrypt floor once)" % dt)
        # whole-collection GET
        r, dt = timed(lambda: s.req("GET", base, "alice"))
        n = len(re.findall(r"^BEGIN:VCARD\r?$", r.body.decode(), re.M))
        c.expect("collection-get/2000", r.status == 200 and n == N,
                 "GET of the collection -> %d, %d cards, %.1f MB, %.2f s" % (
                     r.status, n, len(r.body) / 1e6, dt))
        # one PUT and the incremental sync after it
        g = s.req("GET", base + "bulk-00001.vcf", "alice")
        text = g.body.decode().replace("Person00001 Example", "Person00001 Edited")
        r, dt = timed(lambda: s.req("PUT", base + "bulk-00001.vcf", "alice", text,
                                    dict(VCF, **{"If-Match": g.headers["etag"]})))
        c.expect("put/one-card-in-2000", r.status == 204,
                 "PUT with If-Match -> %d in %.0f ms" % (r.status, dt * 1000))
        r, dt = timed(lambda: s.req("REPORT", base, "alice", sync_body(token), XML))
        sm = {k for k in multistatus(r.body) if k != base}
        c.expect("sync/incremental-after-put", r.status == 207 and sm == {
            base + "bulk-00001.vcf"}, "sync with the old token -> %d, entries %s "
                 "(%.0f ms)" % (r.status, sorted(k.rsplit("/", 1)[1] for k in sm),
                                dt * 1000))
        # which first read pays for the cold item cache? one fresh book each
        cold = {}
        for label, name in (("etag-listing", "cold-listing"), ("multiget", "cold-multiget"),
                            ("collection-get", "cold-get")):
            seed_book(s, name, N)
            cb = "/alice/%s/" % name
            if label == "etag-listing":
                r, dt = timed(lambda: s.req("PROPFIND", cb, "alice", propfind_etag(),
                                            dict(XML, Depth="1")))
                n = len([k for k in multistatus(r.body) if k != cb])
            elif label == "multiget":
                hr = ["%sbulk-%05d.vcf" % (cb, i) for i in range(N)]
                r, dt = timed(lambda: s.req("REPORT", cb, "alice", multiget_body(hr), XML))
                n = len([k for k in multistatus(r.body) if k != cb])
            else:
                r, dt = timed(lambda: s.req("GET", cb, "alice"))
                n = len(re.findall(r"^BEGIN:VCARD\r?$", r.body.decode(), re.M))
            cold[label] = dt
            c.expect("cold-cache/%s-correct" % label, r.status in (200, 207) and n == N,
                     "first request on a never-read book of %d cards: %d, %d "
                     "cards" % (N, r.status, n))
        c.info("cold-cache/first-read-times", "sync-collection %.1f s, "
               "etag-listing %.1f s, multiget %.1f s, whole-collection GET %.1f s "
               "(first read of filesystem-seeded cards; later reads 0.4-0.5 s). "
               "Cards written through PUT do not pay this: the PUT builds the "
               "cache entry" % (cold_sync, cold["etag-listing"], cold["multiget"],
                                cold["collection-get"]))
        # a cold read must not starve the others
        seed_book(s, "cold-contend", N)
        lat2, codes2 = [], []

        def coldsync():
            r = s.req("REPORT", "/alice/cold-contend/", "alice", sync_body(None), XML)
            codes2.append(r.status)

        def small2():
            for _ in range(5):
                r, d = timed(lambda: s.req("PROPFIND", "/alice/contacts/", "bob",
                                           propfind_etag(), dict(XML, Depth="0")))
                codes2.append(r.status)
                lat2.append(d)
                time.sleep(1.0)

        th = [threading.Thread(target=coldsync), threading.Thread(target=small2)]
        t0 = time.monotonic()
        for x in th:
            x.start()
        for x in th:
            x.join()
        c.expect("cold-cache/no-starvation", set(codes2) <= {207} and len(lat2) == 5,
                 "a cold sync of %d cards and 5 small requests of another client "
                 "at the same time: statuses %s" % (N, sorted(set(codes2))))
        c.info("cold-cache/small-request-latency-during-cold-read",
               "median %.0f ms, max %.0f ms (baseline ~320 ms); whole run %.1f s"
               % (statistics.median(lat2) * 1000, max(lat2) * 1000,
                  time.monotonic() - t0))
        # contention: small requests while a full multiget runs
        lat, codes_par, errors = [], [], []

        def small():
            for _ in range(6):
                r, d = timed(lambda: s.req("PROPFIND", "/alice/contacts/", "bob",
                                           propfind_etag(), dict(XML, Depth="0")))
                (errors if r.status == 0 else codes_par).append(r.status)
                lat.append(d)

        def big():
            r = s.req("REPORT", base, "alice", body, XML)
            codes_par.append(r.status)

        th = [threading.Thread(target=big)] + [threading.Thread(target=small)
                                               for _ in range(3)]
        t0 = time.monotonic()
        for x in th:
            x.start()
        for x in th:
            x.join()
        c.expect("contention/no-5xx-no-drop", not errors and all(
            x < 500 for x in codes_par),
                 "1 full multiget + 3 clients x 6 small requests in parallel: "
                 "statuses %s, transport errors %d" % (sorted(set(codes_par)),
                                                       len(errors)))
        c.info("contention/small-request-latency",
               "median %.0f ms, max %.0f ms while the big request runs; whole "
               "run %.2f s" % (statistics.median(lat) * 1000, max(lat) * 1000,
                               time.monotonic() - t0))
        c.info("memory", "Radicale RSS %d MB at the end; free memory %s" % (
            rss_mb(pid), os.popen("free -m | awk '/^Mem:/ {print $7\" MB available\"}'").read().strip()))
        log = s.radicale_log_text()
        c.expect("no-errors-in-radicale-log", "ERROR" not in log and
                 "Traceback" not in log, "no ERROR or traceback in the Radicale "
                 "log (%d lines)" % len(log.splitlines()))
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
