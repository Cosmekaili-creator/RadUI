# SPDX-License-Identifier: AGPL-3.0-or-later
"""ratelimit.py and audit.py."""
import json
import unittest

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
from radui_admin.audit import Audit, scrub
from radui_admin.names import ApiError
from radui_admin.ratelimit import FailureLimiter, RequestRate


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FailureLimiterTests(unittest.TestCase):
    def test_blocks_after_n_failures_and_expires(self):
        clk = Clock()
        lim = FailureLimiter(10, 600, 900, clk)
        for i in range(9):
            self.assertFalse(lim.record_failure("192.0.2.1"))
            lim.check("192.0.2.1")
        self.assertTrue(lim.record_failure("192.0.2.1"))
        with self.assertRaises(ApiError) as cm:
            lim.check("192.0.2.1")
        self.assertEqual(cm.exception.code, "rate_limited")
        self.assertEqual(cm.exception.status, 429)
        self.assertEqual(cm.exception.retry_after, 900)
        lim.check("192.0.2.2")  # other addresses unaffected
        clk.t += 899
        self.assertTrue(lim.is_blocked("192.0.2.1"))
        clk.t += 2
        lim.check("192.0.2.1")

    def test_window_forgets_old_failures(self):
        clk = Clock()
        lim = FailureLimiter(3, 60, 100, clk)
        lim.record_failure("a")
        lim.record_failure("a")
        clk.t += 61
        self.assertFalse(lim.record_failure("a"))
        self.assertFalse(lim.is_blocked("a"))

    def test_memory_is_bounded(self):
        lim = FailureLimiter(10, 600, 900, Clock())
        for i in range(10500):
            lim.record_failure("ip-%d" % i)
        self.assertLessEqual(len(lim._failures), 10001)


class RequestRateTests(unittest.TestCase):
    def test_bucket(self):
        clk = Clock()
        rate = RequestRate(60, 3, clk)
        for _ in range(3):
            rate.check("a")
        with self.assertRaises(ApiError) as cm:
            rate.check("a")
        self.assertEqual(cm.exception.status, 429)
        clk.t += 1.0  # one token per second
        rate.check("a")
        rate.check("b")

    def test_zero_disables(self):
        rate = RequestRate(0, 1)
        for _ in range(100):
            rate.check("a")


class AuditTests(unittest.TestCase):
    def test_one_json_line_with_fixed_fields(self):
        s = apihelpers.ListStream()
        line = Audit(s, clock=lambda: "T").log(
            "account.create", actor="alice", ip="192.0.2.5", target="bob",
            result="ok", generation=4)
        self.assertEqual(s.lines, [line])
        self.assertEqual(list(json.loads(line)), [
            "ts", "event", "actor", "ip", "target", "result", "generation"])

    def test_secrets_never_written(self):
        h = "$2b$04$" + "a" * 53
        for bad in (h, "x " + h, "Basic YWxpY2U6c2VjcmV0cGFzcw==",
                    "basic  YWxpY2U6c2VjcmV0"):
            self.assertEqual(scrub(bad), "[redacted]")
        s = apihelpers.ListStream()
        Audit(s).log("e", target=h, actor="Basic QWxhZGRpbjpvcGVu")
        self.assertNotIn("$2b$", s.lines[0])
        self.assertNotIn("QWxhZGRpbjpvcGVu", s.lines[0])

    def test_control_characters_and_length(self):
        self.assertEqual(scrub("a\nb\x00c"), "a?b?c")
        self.assertEqual(len(scrub("x" * 1000)), 200)
        s = apihelpers.ListStream()
        Audit(s).log("e", target="line1\nline2")
        self.assertEqual(len(s.lines), 1)


if __name__ == "__main__":
    unittest.main()
