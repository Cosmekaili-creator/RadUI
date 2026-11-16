#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S9: cost of a restart (fallback activation mode), on a throwaway only.

Measures stop time, start time and the window in which connections are refused,
with an empty store and, when RADUI_SNAPSHOT_COLLECTIONS points to an extracted
copy of a real collections directory, with a store of realistic size (copied
into the throwaway; the original is never touched). Then the outcome of PUTs
that are in flight when the process is stopped: graceful SIGTERM with a slow
upload, SIGKILL in the middle of an upload, and SIGKILL during a stream of
whole-item overwrites (the item must always be entirely one of the versions).
"""
import hashlib
import os
import shutil
import signal
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, XML_HDR, ics_event, gen, basic, REPORT_QUERY,  # noqa: E402
                    mkcalendar_body)

ICS = {"Content-Type": "text/calendar"}


def big_event(uid, tag, size):
    body = ics_event(uid, "v-" + tag)
    pad = ("X-PAD:" + "p" * 70 + "\r\n") * (size // 76)
    return body.replace("END:VEVENT", pad + "END:VEVENT")


def downtime_probe(inst, stop, out):
    first_fail = None
    last_fail = None
    fails = 0
    while not stop.is_set():
        try:
            s = socket.create_connection(("127.0.0.1", inst.port), timeout=0.2)
            s.close()
        except OSError:
            fails += 1
            now = time.monotonic()
            first_fail = first_fail or now
            last_fail = now
        time.sleep(0.01)
    out["first_fail"], out["last_fail"], out["fails"] = first_fail, last_fail, fails


def timed_restart(inst, probe_url_path="/", user="adm-1"):
    stop = threading.Event()
    out = {}
    th = threading.Thread(target=downtime_probe, args=(inst, stop, out))
    th.start()
    time.sleep(0.1)
    t0 = time.monotonic()
    inst.stop()
    t_stopped = time.monotonic()
    pid = inst.start()
    t_ready = time.monotonic()
    r = inst.req("PROPFIND", probe_url_path, user, None, {"Depth": "0"})
    t_first = time.monotonic()
    time.sleep(0.1)
    stop.set()
    th.join()
    gap = (out["last_fail"] - out["first_fail"]) if out.get("first_fail") else 0.0
    return {"stop_s": t_stopped - t0, "start_s": t_ready - t_stopped,
            "first_request_s": t_first - t_ready, "refused_window_s": gap,
            "refused_attempts": out["fails"], "status": r.status, "pid": pid}


def main():
    c = Checker("S9 restart cost")

    # ---- empty store ---------------------------------------------------------
    inst = Instance("s09", rights="radui_rights", delay=1)
    inst.start()
    inst.make_member("alice", "cal-a")
    res = timed_restart(inst)
    c.check("restart/empty-store", res["status"] == 207,
            "stop %.2f s, start-to-listening %.2f s, first request %.3f s, connections "
            "refused for %.2f s (%d attempts at 10 ms), first request status %d"
            % (res["stop_s"], res["start_s"], res["first_request_s"],
               res["refused_window_s"], res["refused_attempts"], res["status"]))
    inst.stop()

    # ---- realistic store -----------------------------------------------------
    src = os.environ.get("RADUI_SNAPSHOT_COLLECTIONS")
    if src and os.path.isdir(src):
        inst = Instance("s09-big", rights="radui_rights", delay=1)
        dst = inst.collections_dir()
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst, symlinks=True)
        files = sum(len(f) for _, _, f in os.walk(dst))
        size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(dst) for f in fs)
        inst.start()
        ok = inst.alive()
        c.info("store copy: %d files, %.1f MB" % (files, size / 1e6))
        for label in ("cold", "warm"):
            res = timed_restart(inst, "/", "adm-1")
            r = inst.req("PROPFIND", "/", "adm-1", None, dict(XML_HDR, Depth="1"))
            c.check("restart/realistic-store/%s" % label, ok and res["status"] == 207,
                    "stop %.2f s, start %.2f s, first PROPFIND / %.3f s, refused window %.2f s; "
                    "admin PROPFIND / Depth 1 -> %d in %.2f s"
                    % (res["stop_s"], res["start_s"], res["first_request_s"],
                       res["refused_window_s"], r.status, r.dt))
        inst.stop()
        shutil.rmtree(inst.dir, ignore_errors=True)

    # ---- in-flight PUTs --------------------------------------------------------
    inst = Instance("s09-flight", rights="radui_rights", delay=1)
    inst.start()
    assert inst.make_member("alice", "cal-a").status == 201
    old = big_event("e1", "old", 300000)
    assert inst.req("PUT", "/alice/cal-a/e1.ics", "alice", old, ICS).status == 201
    old_etag = inst.req("GET", "/alice/cal-a/e1.ics", "alice").headers.get("etag")
    new = big_event("e1", "new", 300000).encode()

    def slow_put(inst_, body, pause_after, hold):
        """Send headers + part of the body, wait for `hold()`, send the rest."""
        s = socket.create_connection(("127.0.0.1", inst_.port), timeout=60)
        head = ("PUT /alice/cal-a/e1.ics HTTP/1.1\r\nHost: x\r\nAuthorization: %s\r\n"
                "Content-Type: text/calendar\r\nContent-Length: %d\r\n\r\n"
                % (basic("alice", inst_.pw["alice"]), len(body))).encode()
        s.sendall(head + body[:pause_after])
        hold()
        try:
            s.sendall(body[pause_after:])
            data = s.recv(4096)
        except OSError as exc:
            data = repr(exc).encode()
        s.close()
        return data.split(b"\r\n", 1)[0]

    # (a) graceful SIGTERM while an upload is half-way
    state = {}

    def hold_term():
        time.sleep(0.3)
        state["t0"] = time.monotonic()
        os.killpg(inst.proc.pid, signal.SIGTERM)
        time.sleep(1.5)        # client keeps the request open for 1.5 s more
        state["alive_during"] = inst.proc.poll() is None

    line = slow_put(inst, new, 100000, hold_term)
    t_exit = None
    try:
        inst.proc.wait(30)
        t_exit = time.monotonic() - state["t0"]
    except Exception:  # noqa: BLE001
        pass
    inst.proc = None
    inst.start()
    got = inst.req("GET", "/alice/cal-a/e1.ics", "alice").body
    is_new = b"v-new" in got
    c.check("inflight/sigterm-waits-for-the-upload-and-completes-it",
            state.get("alive_during") is True and is_new and b"20" in line[:12],
            "SIGTERM mid-upload: process still alive 1.5 s later = %s, response line %r, "
            "item now entirely new = %s, process exited %.1f s after SIGTERM"
            % (state.get("alive_during"), line.decode(errors="replace")[:20], is_new,
               t_exit if t_exit is not None else -1))

    # (b) SIGKILL in the middle of an upload: item must remain entirely the old/new one
    cur = inst.req("GET", "/alice/cal-a/e1.ics", "alice").body
    newer = big_event("e1", "newer", 300000).encode()

    def hold_kill():
        time.sleep(0.3)
        os.killpg(inst.proc.pid, signal.SIGKILL)
        time.sleep(0.3)

    slow_put(inst, newer, 100000, hold_kill)
    inst.proc.wait()
    inst.proc = None
    inst.start()
    after = inst.req("GET", "/alice/cal-a/e1.ics", "alice").body
    coll = os.path.join(inst.collections_dir(), "alice", "cal-a")
    stray = [f for f in os.listdir(coll) if f not in ("e1.ics", ".Radicale.props",
                                                      ".Radicale.cache")]
    c.check("inflight/sigkill-mid-upload-item-unchanged", after == cur and not stray,
            "item identical to the pre-kill version = %s; stray files in the collection "
            "directory: %s" % (after == cur, stray or "none"))

    # (c) SIGKILL during a stream of whole-item overwrites
    versions = {}
    bad = 0
    rounds = 6
    for rnd in range(rounds):
        stop = threading.Event()

        def stream():
            n = 0
            while not stop.is_set():
                n += 1
                body = big_event("e1", "r%d-%d" % (rnd, n), 150000)
                h = hashlib.sha256(body.encode()).hexdigest()
                versions[h] = True
                inst.req("PUT", "/alice/cal-a/e1.ics", "alice", body, ICS, timeout=5)

        th = threading.Thread(target=stream)
        th.start()
        time.sleep(0.4 + 0.07 * rnd)
        os.killpg(inst.proc.pid, signal.SIGKILL)
        stop.set()
        th.join()
        inst.proc.wait()
        inst.proc = None
        inst.start()
        r = inst.req("GET", "/alice/cal-a/e1.ics", "alice")
        text = r.body.decode()
        ok = r.status == 200 and text.startswith("BEGIN:VCALENDAR") \
            and text.rstrip().endswith("END:VCALENDAR") and text.count("BEGIN:VEVENT") == 1 \
            and "v-" in text
        # the served text is Radicale's re-serialisation, so compare structure + marker
        marker = [ln for ln in text.splitlines() if ln.startswith("SUMMARY:")]
        if not ok or len(marker) != 1:
            bad += 1
    c.check("inflight/sigkill-during-overwrite-stream-item-always-whole", bad == 0,
            "%d kills during a PUT stream: %d times the item was not a complete, valid "
            "version" % (rounds, bad))
    inst.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
