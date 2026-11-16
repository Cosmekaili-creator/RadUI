# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plugin tests (c), (d) and (i): behaviour under concurrent traffic.

(c) no 201 on a PUT that started after an ``r`` generation was confirmed;
(d) a slow-body PUT in flight while rights are revoked;
(i) 20 threads of traffic while 200 rewrites alternate two generations.

All traffic runs against a throwaway Radicale with at most 20 client threads.
"""
import itertools
import random
import socket
import threading
import time
import unittest
from collections import Counter

from . import support
from .support import (ICS_HDR, Instance, good_rights, ics_event, info,
                      requires_radicale)

GRANT_RW = [("bob", "alice", "cal-aa", "rw")]
GRANT_R = [("bob", "alice", "cal-aa", "r")]
WRITE_MODES = ("atomic", "inplace", "inplace-keep-mtime")
# Radicale's accept queue is short; under 20 parallel clients the kernel
# occasionally resets a connection before any HTTP exchange (ListenOverflows
# in /proc/net/netstat rises during these runs, with no Traceback in the
# Radicale log). Such a request never reached the plugin; it is retried and
# counted, and reported as INFO. An HTTP 5xx is never tolerated.
TRANSPORT_RETRIES = 2


def write_mode(inst, data, mode):
    if mode == "inplace-keep-mtime":
        return inst.write_rights(data, "inplace", keep_mtime=True)
    return inst.write_rights(data, mode)


class Traffic:
    """Client threads that record what each request saw.

    The driver marks phases. A request that *starts* while the phase is "W"
    or "R" is registered as in flight; before the next rewrite the driver
    closes the phase and waits until every registered request has finished.
    So a judged request started after its generation was confirmed and ended
    before the next rewrite began: the server cannot have evaluated it under
    any other generation (a request that merely queued in the listen backlog
    during the next rewrite is not judged).
    """

    def __init__(self, inst, readers, writers):
        self.inst = inst
        self.records = []      # (kind, status, state, phase)
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.phase = None      # None | "W" | "R"
        self.inflight = 0
        self.transport_errors = 0
        self.stop = threading.Event()
        self.threads = []
        self.counter = itertools.count()
        for _ in range(readers):
            self.threads.append(threading.Thread(target=self.reader))
        for i in range(writers):
            self.threads.append(threading.Thread(target=self.writer,
                                                 args=(i,)))

    def _enter(self):
        with self.lock:
            ph = self.phase
            if ph is not None:
                self.inflight += 1
            return ph

    def _leave(self, ph, record):
        with self.cond:
            self.records.append(record + (ph,))
            if ph is not None:
                self.inflight -= 1
                self.cond.notify_all()

    def reader(self):
        while not self.stop.is_set():
            ph = self._enter()
            for _ in range(TRANSPORT_RETRIES + 1):
                status, writable = self.inst.can_write("bob", "alice", "cal-aa")
                if status != 0:
                    break
                self.count_transport_error()
            state = ("W" if writable else "R") if status == 207 else None
            self._leave(ph, ("propfind", status, state))

    def writer(self, tid):
        while not self.stop.is_set():
            ph = self._enter()
            for _ in range(TRANSPORT_RETRIES + 1):
                # a fresh item name per attempt: a reset PUT may have landed
                uid = "t%d-%d" % (tid, next(self.counter))
                r = self.inst.put_event("bob", "alice", "cal-aa", uid)
                if r.status != 0:
                    break
                self.count_transport_error()
            self._leave(ph, ("put", r.status, None))

    def count_transport_error(self):
        with self.lock:
            self.transport_errors += 1

    def start(self):
        for t in self.threads:
            t.start()

    def open_phase(self, name):
        with self.lock:
            self.phase = name

    def close_phase(self, timeout=30.0):
        """Stop judging new requests, wait for the judged ones to finish."""
        with self.cond:
            self.phase = None
            deadline = time.monotonic() + timeout
            while self.inflight > 0:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise AssertionError("requests did not drain")
                self.cond.wait(left)

    def finish(self):
        self.stop.set()
        for t in self.threads:
            t.join(timeout=60)
        return self.records


def drive(inst, traffic, rewrites, hold=None):
    """Rewrite the rights file ``rewrites`` times, alternating a ``W`` and an
    ``R`` generation, in rotating write styles. Each rewrite is confirmed
    through the probe, then its phase is opened for judging, held, closed and
    drained before the next rewrite begins. Returns the unconfirmed count."""
    unconfirmed = 0
    for i in range(rewrites):
        state = "W" if i % 2 == 0 else "R"
        data, token = good_rights(1000 + i, GRANT_RW if state == "W" else GRANT_R)
        write_mode(inst, data, WRITE_MODES[i % len(WRITE_MODES)])
        if inst.confirm(token, timeout=5.0) is None:
            unconfirmed += 1
            continue
        traffic.open_phase(state)
        time.sleep(random.uniform(*(hold or {}).get(state, (0.005, 0.03))))
        traffic.close_phase()
    return unconfirmed


def judge(records):
    """Return (judged, wrong, judged_by_phase) for the phase-tagged records."""
    judged = Counter()
    wrong = []
    for kind, status, state, phase in records:
        if phase is None:
            continue
        judged[(kind, phase)] += 1
        if kind == "put":
            expected = 201 if phase == "W" else 403
            if status != expected:
                wrong.append((kind, status, phase))
        elif state != phase:
            wrong.append((kind, status, phase))
    return judged, wrong


@requires_radicale
class NoCreateAfterRevocation(unittest.TestCase):
    """(c) A PUT that started after an ``r`` generation was confirmed active
    must never return 201 (and, symmetrically, a PUT started after an ``rw``
    generation was confirmed must not be denied)."""

    @classmethod
    def setUpClass(cls):
        cls.inst = Instance("race-c")
        cls.addClassCleanup(cls.inst.close)
        cls.inst.bootstrap(collections=("cal-aa",), grants=GRANT_RW)

    @classmethod
    def tearDownClass(cls):
        cls.inst.close()

    def test_c_no_201_after_r_generation_confirmed(self):
        inst = self.inst
        traffic = Traffic(inst, readers=0, writers=14)
        traffic.start()
        time.sleep(0.5)
        unconfirmed = drive(inst, traffic, 70,
                         hold={"R": (0.05, 0.15), "W": (0.25, 0.4)})
        records = traffic.finish()
        self.assertEqual(unconfirmed, 0, "a generation was never confirmed")
        for kind, status, state, phase in records:
            self.assertTrue(0 < status < 500, "bad status %r" % status)
        self.assertNotIn("Traceback", inst.log())
        if traffic.transport_errors:
            info("(c) %d TCP-level resets retried" % traffic.transport_errors)
        judged, wrong = judge(records)
        r_puts = [r for r in records if r[3] == "R" and r[0] == "put"]
        self.assertEqual([w for w in wrong if w[2] == "R"], [],
                         "PUT started after an r generation was confirmed "
                         "was not denied")
        self.assertEqual([w for w in wrong if w[2] == "W"], [],
                         "PUT started after an rw generation was confirmed "
                         "was denied")
        # meaningful only if both kinds of request were really judged
        self.assertGreater(judged[("put", "R")], 150)
        self.assertGreater(judged[("put", "W")], 100)
        self.assertEqual(sum(1 for r in r_puts if r[1] == 201), 0)
        info("(c) 70 rewrites, %d PUTs judged after R (all 403), %d after W "
             "(all 201)" % (judged[("put", "R")], judged[("put", "W")]))


@requires_radicale
class SlowBodyRevocation(unittest.TestCase):
    """(d) A PUT whose body is still being sent when rights are revoked."""

    @classmethod
    def setUpClass(cls):
        cls.inst = Instance("race-d")
        cls.addClassCleanup(cls.inst.close)
        cls.token = cls.inst.bootstrap(collections=("cal-aa",),
                                       grants=GRANT_RW)

    @classmethod
    def tearDownClass(cls):
        cls.inst.close()

    def slow_put(self, uid, revoke):
        inst = self.inst
        import base64
        body = ics_event(uid).encode()
        auth = base64.b64encode(("bob:%s" % inst.pw["bob"]).encode()).decode()
        head = ("PUT /alice/cal-aa/%s.ics HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n"
                "Authorization: Basic %s\r\nContent-Type: text/calendar\r\n"
                "Content-Length: %d\r\nConnection: close\r\n\r\n"
                % (uid, inst.port, auth, len(body))).encode()
        sock = socket.create_connection(("127.0.0.1", inst.port), timeout=30)
        try:
            sock.sendall(head + body[:60])
            time.sleep(0.5)           # the server has seen the headers
            revoke()
            sock.sendall(body[60:])
            data = b""
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
        finally:
            sock.close()
        status = int(data.split(b" ", 2)[1]) if data.startswith(b"HTTP/") else 0
        return status

    def test_d_inflight_put_during_revocation(self):
        inst = self.inst
        self.assertEqual(inst.level("bob", "alice", "cal-aa"), "W")
        revoked = {}

        def revoke():
            data, token = good_rights(50, [])
            inst.write_rights(data, "atomic")
            revoked["confirmed"] = inst.confirm(token, timeout=5) is not None

        status = self.slow_put("slow-1", revoke)
        self.assertTrue(revoked["confirmed"], "revocation never became active")
        self.assertLess(status, 500, "server error on in-flight PUT")
        self.assertNotEqual(status, 0, "no response to the in-flight PUT")
        info("(d) slow-body PUT in flight during revocation -> %d: %s rules "
             "applied (authorization happens before the body is read)"
             % (status, "OLD" if status == 201 else "NEW"))
        # the next request is denied, whichever rules the in-flight one saw
        r = inst.put_event("bob", "alice", "cal-aa", "after-revoke")
        self.assertEqual(r.status, 403, "next PUT not denied")
        self.assertEqual(inst.level("bob", "alice", "cal-aa"), "-")
        # a second slow PUT, started after the revocation, is denied outright
        status2 = self.slow_put("slow-2", lambda: None)
        self.assertEqual(status2, 403)


@requires_radicale
class ConcurrentRewrites(unittest.TestCase):
    """(i) 19 client threads while 200 rewrites alternate two generations."""

    @classmethod
    def setUpClass(cls):
        cls.inst = Instance("race-i")
        cls.addClassCleanup(cls.inst.close)
        cls.inst.bootstrap(collections=("cal-aa",), grants=GRANT_RW)

    @classmethod
    def tearDownClass(cls):
        cls.inst.close()

    def test_i_no_5xx_and_consistent_answers(self):
        inst = self.inst
        traffic = Traffic(inst, readers=12, writers=7)
        traffic.start()
        time.sleep(0.5)
        unconfirmed = drive(inst, traffic, 200,
                         hold={"R": (0.0, 0.02), "W": (0.0, 0.05)})
        records = traffic.finish()
        self.assertEqual(unconfirmed, 0)
        statuses = Counter((r[0], r[1]) for r in records)
        server_errors = {k: v for k, v in statuses.items()
                         if k[1] >= 500 or k[1] == 0}
        self.assertEqual(server_errors, {}, "5xx or unrecoverable transport errors")
        self.assertNotIn("Traceback", inst.log())
        for kind, status, state, phase in records:
            if kind == "propfind":
                self.assertIn(state, ("W", "R"), "bad PROPFIND answer %r" % status)
            else:
                self.assertIn(status, (201, 403))
        judged, wrong = judge(records)
        self.assertEqual(wrong, [], "answers disagree with the confirmed "
                                    "generation")
        self.assertGreater(sum(judged.values()), 500)
        # final state equals the last generation written (200th: state R)
        self.assertEqual(inst.level("bob", "alice", "cal-aa"), "R")
        info("(i) %d requests, statuses %s, %d judged, 0 wrong; %d TCP-level "
             "resets retried (not HTTP errors)"
             % (len(records), dict(statuses), sum(judged.values()),
                traffic.transport_errors))


if __name__ == "__main__":
    unittest.main()
