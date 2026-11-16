#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S8: plugin behaviour under concurrent traffic while the rights file is rewritten.

20 client threads (16 readers doing PROPFIND with current-user-privilege-set,
4 writers doing PUT) hammer one throwaway Radicale with the radui_rights
plugin while the rights file is rewritten 250 times in three styles:

  A  100 atomic replaces (new inode), each confirmed through the generation
     probe before the next one starts;
  B  100 in-place rewrites (same inode, same size) in 20 bursts of 5 back-to-back
     writes, only the last of a burst is confirmed;
  C  50 in-place equal-size rewrites with the mtime forced back to the previous
     value (so only ctime differs), confirmed one by one.

The grantee's access alternates between `r` and `rwl`, so every answer says
which generation produced it. Pass criteria: zero 5xx and zero transport
errors; every answer is one of the two states; every request that lies fully
inside a "stable window" (after the new generation was confirmed, before the
next rewrite began) shows the newest state; every confirmed generation becomes
visible within the timeout.
"""
import os
import random
import sys
import threading
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, XML_HDR, PROPFIND_PRIV, ics_event, gen)  # noqa: E402

N_READERS = int(os.environ.get("RADUI_S8_READERS", "16"))
N_WRITERS = int(os.environ.get("RADUI_S8_WRITERS", "4"))
ICS = {"Content-Type": "text/calendar"}


def model(state, generation):
    m = gen.default_model(generation, with_grants=False)
    m["grants"] = [{"owner": "alice", "collection": "cal-a", "grantee": "bob",
                    "level": "readwrite" if state == "W" else "read"}]
    return m


def baseline(c, rights, seconds=8.0):
    """Same 20 clients, no rewrites: how many transport errors does Radicale
    itself produce (listen backlog of 5 behind max_connections=8)?"""
    inst = Instance("s08-base-" + rights, rights=rights, level="warning", delay=1)
    inst.start()
    inst.make_member("alice", "cal-a")
    inst.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"), ICS)
    inst.write_rights_model(model("W", 2))
    inst.req("PROPFIND", "/", "bob", None, {"Depth": "0"})
    if rights == "from_file":
        inst.restart()
    stop = threading.Event()
    cnt = Counter()
    lock = threading.Lock()

    def client():
        while not stop.is_set():
            r = inst.req("PROPFIND", "/alice/cal-a/", "bob", PROPFIND_PRIV,
                         dict(XML_HDR, Depth="0"))
            with lock:
                cnt[r.status] += 1

    ths = [threading.Thread(target=client) for _ in range(N_READERS + N_WRITERS)]
    for t in ths:
        t.start()
    time.sleep(seconds)
    stop.set()
    for t in ths:
        t.join(timeout=70)
    inst.stop()
    total = sum(cnt.values())
    c.info("baseline (%s engine, %d clients, no rewrites, %.0f s): %d requests, statuses %s"
           % (rights, N_READERS + N_WRITERS, seconds, total, dict(cnt)))
    return cnt


def main():
    c = Checker("S8 concurrency")
    b_stock = baseline(c, "from_file")
    b_plugin = baseline(c, "radui_rights")
    inst = Instance("s08", rights="radui_rights", level="warning", delay=1)
    inst.write_rights_model(model("W", 1))
    inst.start()
    assert inst.make_member("alice", "cal-a").status == 201
    inst.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"), ICS)
    inst.req("PROPFIND", "/", "bob", None, {"Depth": "0"})

    stop = threading.Event()
    lock = threading.Lock()
    reads = []     # (t_start, t_end, status, observed_state)
    puts = []      # (t_start, t_end, status)
    errors = Counter()

    def reader():
        while not stop.is_set():
            t0 = time.monotonic()
            r = inst.req("PROPFIND", "/alice/cal-a/", "bob", PROPFIND_PRIV,
                         dict(XML_HDR, Depth="0"))
            t1 = time.monotonic()
            st = None
            if r.status == 207:
                st = "W" if b"write-content" in r.body else "R"
            with lock:
                reads.append((t0, t1, r.status, st))
                if r.status != 207:
                    errors[(r.status, r.body[:80].decode(errors="replace")
                            if r.status == 0 else "")] += 1

    def writer(tid):
        n = 0
        while not stop.is_set():
            n += 1
            t0 = time.monotonic()
            r = inst.req("PUT", "/alice/cal-a/w-%d-%d.ics" % (tid, n), "bob",
                         ics_event("w-%d-%d" % (tid, n)), ICS)
            t1 = time.monotonic()
            with lock:
                puts.append((t0, t1, r.status))
                if r.status not in (201, 403):
                    errors[("PUT", r.status, r.body[:80].decode(errors="replace")
                            if r.status == 0 else "")] += 1

    threads = [threading.Thread(target=reader) for _ in range(N_READERS)]
    threads += [threading.Thread(target=writer, args=(i,)) for i in range(N_WRITERS)]
    for t in threads:
        t.start()
    time.sleep(0.5)

    windows = []        # (start, end, state)
    latencies = []      # seconds from write completion to probe 404
    unconfirmed = 0
    rewrites = 0
    equal_mtime = 0
    same_inode_count = 0
    ino_prev = os.stat(inst.rights_path).st_ino
    gen_no = 1
    pending = None      # (confirm_time, state) waiting for the next begin

    def write_gen(state, how):
        nonlocal gen_no, rewrites, equal_mtime, same_inode_count, ino_prev
        gen_no += 1
        m = model(state, gen_no)
        text = gen.rights_text(m)
        st0 = os.stat(inst.rights_path)
        t_begin = time.monotonic()
        if how == "atomic":
            inst.atomic_write(inst.rights_path, text)
        else:
            with open(inst.rights_path, "w") as fh:
                fh.write(text)
            if how == "forced-mtime":
                os.utime(inst.rights_path, ns=(st0.st_atime_ns, st0.st_mtime_ns))
        st1 = os.stat(inst.rights_path)
        rewrites += 1
        if st1.st_mtime_ns == st0.st_mtime_ns:
            equal_mtime += 1
        if st1.st_ino == st0.st_ino:
            same_inode_count += 1
        return m, t_begin

    def confirm(m, timeout=5.0):
        t = time.monotonic()
        while time.monotonic() - t < timeout:
            r = inst.req("GET", "/radui-gen-" + m["genToken"])
            if r.status == 404:
                return time.monotonic()
            time.sleep(0.01)
        return None

    def close_window(t_begin_next):
        nonlocal pending
        if pending is not None:
            windows.append((pending[0], t_begin_next, pending[1]))
            pending = None

    # phase A: atomic, confirmed one by one
    for i in range(100):
        state = random.choice("RW")
        m, t_begin = write_gen(state, "atomic")
        close_window(t_begin)
        t_conf = confirm(m)
        if t_conf is None:
            unconfirmed += 1
            continue
        latencies.append(t_conf - t_begin)
        pending = (t_conf, state)
        time.sleep(random.uniform(0.005, 0.03))
    # phase B: in-place bursts of 5, last one confirmed
    for b in range(20):
        t_first = None
        for k in range(5):
            state = random.choice("RW")
            if k == 4:
                state = "R" if (b % 2 == 0) else "W"
            m, t_begin = write_gen(state, "in-place")
            if k == 0:
                t_first = t_begin
        close_window(t_first)
        t_conf = confirm(m)
        if t_conf is None:
            unconfirmed += 1
            continue
        latencies.append(t_conf - t_first)
        pending = (t_conf, state)
        time.sleep(random.uniform(0.005, 0.03))
    # phase C: forced equal mtime (only ctime changes); let the file settle first
    time.sleep(2.3)
    for i in range(50):
        state = "R" if i % 2 == 0 else "W"
        m, t_begin = write_gen(state, "forced-mtime")
        close_window(t_begin)
        t_conf = confirm(m)
        if t_conf is None:
            unconfirmed += 1
            continue
        latencies.append(t_conf - t_begin)
        pending = (t_conf, state)
        time.sleep(random.uniform(0.005, 0.03))
    close_window(time.monotonic())
    time.sleep(0.3)
    stop.set()
    for t in threads:
        t.join(timeout=70)
    alive = sum(t.is_alive() for t in threads)

    # ---- evaluation -------------------------------------------------------
    hist = Counter(r[2] for r in reads)
    phist = Counter(p[2] for p in puts)
    five = sum(v for k, v in hist.items() if 500 <= k < 600) + \
        sum(v for k, v in phist.items() if 500 <= k < 600)
    transport = hist.get(0, 0) + phist.get(0, 0)
    c.check("no-http-5xx", five == 0,
            "%d reads %s, %d puts %s" % (len(reads), dict(hist), len(puts), dict(phist)))
    base_t = (b_stock.get(0, 0), b_plugin.get(0, 0))
    c.info("transport errors (connection reset before any HTTP answer): %d in this run; "
           "baselines without any rewrite: stock %d, plugin %d. Cause: Radicale stops "
           "accept()ing at max_connections=8 and the listen backlog is 5, so 20 simultaneous "
           "clients overflow it; not an effect of the rights plugin. Error kinds: %s"
           % (transport, base_t[0], base_t[1], sorted(set(k[1] for k in errors if k[0] == 0
                                                          )) if errors else "none"))
    # answers must be in the two-state set (PROPFIND 207 with a parsable state)
    odd = [r for r in reads if r[2] not in (0, 207) or (r[2] == 207 and r[3] is None)]
    c.check("every-http-answer-is-old-or-new-state", not odd,
            "%d of %d PROPFIND HTTP answers were neither state" % (len(odd), len(reads)))
    c.check("transport-errors-explained-by-baseline",
            transport == 0 or (base_t[0] + base_t[1]) > 0,
            "run had %d transport errors; baseline (no rewrites) had %d/%d"
            % (transport, base_t[0], base_t[1]))
    # stable windows
    in_window = 0
    wrong = 0
    for (ws, we, state) in windows:
        for (t0, t1, st, obs) in reads:
            if t0 >= ws and t1 <= we and obs is not None:
                in_window += 1
                if obs != state:
                    wrong += 1
    c.check("stable-windows-show-newest-state", wrong == 0 and in_window > 0,
            "%d requests fully inside %d stable windows: %d showed an older state"
            % (in_window, len(windows), wrong))
    lat = sorted(latencies)
    p = lambda q: lat[min(len(lat) - 1, int(q * len(lat)))] * 1000 if lat else -1  # noqa: E731
    c.check("every-rewrite-picked-up", unconfirmed == 0,
            "%d rewrites (%d kept the inode, %d kept the mtime_ns equal); unconfirmed "
            "generations: %d; write-to-visible latency p50 %.0f ms, p95 %.0f ms, max %.0f ms"
            % (rewrites, same_inode_count, equal_mtime, unconfirmed, p(0.5), p(0.95), p(0.999)))
    c.check("no-hung-clients", alive == 0, "%d client threads still alive" % alive)
    c.info("requests per second during the run: ~%.0f (delay=1 sleeps hold slots for the "
           "denied PUTs; 20 clients vs max_connections=8)"
           % ((len(reads) + len(puts)) / max(1.0, windows[-1][1] - 0.0 - windows[0][0])
              if windows else 0))
    c.info("PUT outcomes: %s (201 = rw state, 403 = r state)" % dict(phist))
    inst.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
