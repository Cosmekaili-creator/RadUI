# SPDX-License-Identifier: AGPL-3.0-or-later
"""Failure modes: corrupted model, crash between model and file writes, CLI
recovery, lock sharing, rate limiting (each class has its own stack)."""
import fcntl
import json
import os
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

HELPER = os.path.join(H.HERE, "crash_helper.py")
CRASH_PW = "a long enough passphrase 7!"


def code(resp):
    return resp.json["error"]["code"]


def gen_of(path):
    with open(path, "rb") as fh:
        return int(fh.readline().rsplit(b"=", 1)[1])


@H.requires_radicale
class CorruptModel(unittest.TestCase):
    def setUp(self):
        self.s = H.Stack("corrupt").up()
        self.addCleanup(self.s.close)

    def corrupt(self):
        with open(os.path.join(self.s.state, "model.json"), "w") as fh:
            fh.write('{"schema": 1, "broken')

    def test_read_only_mode_and_cli_restore_while_running(self):
        s = self.s
        self.assertEqual(s.api("POST", "/accounts", "alice", {
            "login": "keep-1", "displayName": "K", "generate": True}
        ).status, 201)
        self.corrupt()
        r = s.api("GET", "/me", "alice")
        self.assertEqual((r.status, code(r)), (503, "model_corrupt"))
        r = s.api("POST", "/accounts", "alice", {
            "login": "x-1", "displayName": "K", "generate": True})
        self.assertEqual((r.status, code(r)), (503, "model_corrupt"))
        h = s.api("GET", "/health").json
        self.assertFalse(h["modelOk"])
        self.assertFalse(h["ok"])
        # Radicale keeps serving with the files it has
        self.assertEqual(s.dav("PROPFIND", "/", "alice",
                               headers={"Depth": "0"}).status, 207)
        rc, out, err = s.cli("show")
        self.assertEqual(rc, 6, out + err)
        rc, out, err = s.cli("restore", "--generation", "1", "--confirm", "restore-1")
        self.assertEqual(rc, 0, out + err)
        self.assertIn("restored as generation", out)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)
        # restored generation 1: keep-1 is gone, alice can log in
        self.assertEqual(s.api("GET", "/accounts/keep-1", "alice").status, 404)
        self.assertTrue(s.api("GET", "/health").json["ok"])

    def test_start_with_corrupt_model_runs_read_only_then_recovers(self):
        s = self.s
        s.stop_backend()
        self.corrupt()
        s.start_backend()
        h = s.api("GET", "/health").json
        self.assertFalse(h["modelOk"])
        self.assertIn("read-only", s.stderr())
        self.assertEqual(s.api("GET", "/me", "alice").status, 503)
        rc, out, err = s.cli("restore", "--generation", "1", "--confirm", "restore-1")
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)
        # nothing was written by the failed start: same managed files
        self.assertTrue(s.api("GET", "/health").json["ok"])

    def test_missing_model_file(self):
        s = self.s
        os.unlink(os.path.join(s.state, "model.json"))
        r = s.api("GET", "/me", "alice")
        self.assertEqual(code(r), "model_corrupt")
        rc, out, err = s.cli("restore", "--generation", "1", "--confirm", "restore-1")
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)


@H.requires_radicale
class CrashReconcile(unittest.TestCase):
    def setUp(self):
        self.s = H.Stack("crash").up()
        self.addCleanup(self.s.close)

    def crash(self, point, action, login):
        p = subprocess.run([H.PYTHON, "-I", HELPER, self.s.config_path, point,
                            action, login], capture_output=True, text=True,
                           timeout=60)
        self.assertEqual(p.returncode, 137, p.stdout + p.stderr)

    def test_crash_after_model_write_rolls_forward_on_start(self):
        s = self.s
        rights = os.path.join(s.managed, "rights")
        before = gen_of(rights)
        s.stop_backend()
        self.crash("after_model", "create", "crash-1")
        model = s.read_json(os.path.join(s.state, "model.json"))
        self.assertIn("crash-1", model["accounts"])
        self.assertEqual(model["generation"], before + 1)
        self.assertEqual(gen_of(rights), before)        # files are behind
        self.assertEqual(s.dav("PROPFIND", "/", "alice",
                               headers={"Depth": "0"}).status, 207)
        s.pw["crash-1"] = CRASH_PW
        self.assertEqual(s.dav("PROPFIND", "/", "crash-1",
                               headers={"Depth": "0"}).status, 401)
        s.start_backend()
        self.assertEqual(gen_of(rights), before + 1)    # rolled forward
        self.assertEqual(s.dav("PROPFIND", "/", "crash-1",
                               headers={"Depth": "0"}).status, 207)
        h = s.api("GET", "/health").json
        self.assertEqual((h["ok"], h["generation"]), (True, before + 1))
        events = [json.loads(x) for x in s.stdout().splitlines()]
        rec = [e for e in events if e["event"] == "reconcile"]
        self.assertEqual(len(rec), 1)
        self.assertEqual((rec[0]["result"], rec[0]["generation"]),
                         ("rolled_forward", before + 1))
        self.assertTrue(os.path.isdir(os.path.join(
            s.state, "generations", str(before + 1))))
        rc, out, err = s.cli("check-radicale")
        self.assertEqual(rc, 0, out + err)

    def test_crash_between_the_managed_files_of_a_disable(self):
        s = self.s
        s.api("POST", "/accounts", "alice", {
            "login": "victim", "displayName": "V", "type": "bot",
            "password": CRASH_PW})
        s.pw["victim"] = CRASH_PW
        self.assertEqual(s.dav("PROPFIND", "/", "victim",
                               headers={"Depth": "0"}).status, 207)
        s.stop_backend()
        self.crash("after_first_file", "disable", "victim")
        # users went first: the login is already refused while rights lag
        self.assertEqual(s.dav("PROPFIND", "/", "victim",
                               headers={"Depth": "0"}).status, 401)
        users, rights = (os.path.join(s.managed, n) for n in ("users", "rights"))
        self.assertNotEqual(gen_of(users), gen_of(rights))
        s.start_backend()
        self.assertEqual(gen_of(users), gen_of(rights))
        self.assertTrue(s.api("GET", "/health").json["ok"])

    def test_crash_before_model_write_changes_nothing(self):
        s = self.s
        rights = os.path.join(s.managed, "rights")
        with open(rights, "rb") as fh:
            before = fh.read()
        s.stop_backend()
        self.crash("before_model", "create", "ghost-1")
        s.start_backend()
        with open(rights, "rb") as fh:
            self.assertEqual(fh.read(), before)
        self.assertEqual(s.api("GET", "/accounts/ghost-1", "alice").status, 404)
        events = [json.loads(x) for x in s.stdout().splitlines()]
        self.assertFalse([e for e in events if e["event"] == "reconcile"])

    def test_tampered_managed_file_is_repaired_on_start(self):
        s = self.s
        s.stop_backend()
        users = os.path.join(s.managed, "users")
        with open(users, "a") as fh:
            fh.write("intruder:$2b$04$" + "a" * 53 + "\n")
        s.start_backend()
        with open(users) as fh:
            self.assertNotIn("intruder", fh.read())


@H.requires_radicale
class CliRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = H.Stack("cli", cfg={"lock_timeout_s": 1}).up()
        cls.addClassCleanup(cls.s.close)

    def test_a_show_has_no_hashes(self):
        rc, out, err = self.s.cli("show")
        self.assertEqual(rc, 0, err)
        self.assertIn("account alice", out)
        self.assertIn("admin", out)
        self.assertIn("grant   alice/cal-work -> agent-1 (readwrite)", out)
        self.assertNotIn("$2", out + err)

    def test_b_check_radicale_ok(self):
        rc, out, err = self.s.cli("check-radicale")
        self.assertEqual(rc, 0, out + err)
        self.assertIn("OK radicale 3.", out)

    def test_c_reset_password_shows_it_once(self):
        s = self.s
        rc, out, err = s.cli("reset-password", "agent-1")
        self.assertEqual(rc, 0, err)
        new = out.split("(shown once):")[1].strip()
        self.assertEqual(len(new), 20)
        self.assertEqual(s.api("GET", "/me", "agent-1", password=new).status,
                         200)
        self.assertEqual(s.api("GET", "/me", "agent-1").status, 401)
        self.assertNotIn(new, s.stdout() + s.stderr() + err)
        s.pw["agent-1"] = new
        rc, out, err = s.cli("reset-password", "nobody-here")
        self.assertEqual(rc, 3)

    def test_d_restore_unknown_generation_and_second_import_refused(self):
        s = self.s
        self.assertEqual(s.cli("restore", "--generation", "9999", "--confirm", "restore-9999")[0], 3)
        rc, out, err = s.cli(
            "import", "--admin", "alice", "--users", s.legacy_users,
            "--rights", s.legacy_rights)
        self.assertEqual(rc, 3, out + err)
        rc, out, err = s.cli("restore", "--generation", "1", "--dry-run")
        self.assertEqual(rc, 0, out + err)
        self.assertIn("dry run", out)

    def test_e_smoke_lifecycle(self):
        s = self.s
        rc, out, err = s.cli(
            "smoke", "--radicale-url", "http://127.0.0.1:%d" % s.rport,
            "--admin-login", "alice",
            env={"RADUI_SMOKE_ADMIN_PASSWORD": s.pw["alice"]})
        self.assertEqual(rc, 0, out + err)
        self.assertNotIn("FAIL", out)
        self.assertGreaterEqual(out.count("PASS"), 8)
        self.assertNotIn(s.pw["alice"], out + err)
        rc, out, err = s.cli("smoke", "--radicale-url",
                             "http://127.0.0.1:%d" % s.rport,
                             "--admin-login", "agent-1")
        self.assertEqual(rc, 3)  # not an admin

    def test_f_cli_and_server_share_the_lock(self):
        s = self.s
        fd = os.open(os.path.join(s.state, ".lock"), os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            t0 = time.time()
            rc, out, err = s.cli("reset-password", "agent-1")
            self.assertEqual(rc, 5, out + err)
            self.assertLess(time.time() - t0, 5)
            r = s.api("POST", "/accounts", "alice", {
                "login": "locked-1", "displayName": "L", "generate": True})
            self.assertEqual((r.status, code(r)), (503, "busy"))
        finally:
            os.close(fd)
        self.assertEqual(s.api("POST", "/accounts", "alice", {
            "login": "locked-1", "displayName": "L", "generate": True}
        ).status, 201)

    def test_g_damaged_rights_file_is_detected_and_restore_repairs_it(self):
        s = self.s
        rights = os.path.join(s.managed, "rights")
        with open(rights, "rb") as fh:
            good = fh.read()
        with open(rights, "r+b") as fh:        # in-place truncation (a torn write)
            fh.truncate(len(good) // 2)
        rc, out, err = s.cli("check-radicale")
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL", out)
        # Radicale rejects the torn file at runtime and keeps its old rules
        self.assertEqual(s.dav("PROPFIND", "/", "alice",
                               headers={"Depth": "0"}).status, 207)
        gen = s.read_json(os.path.join(s.state, "model.json"))["generation"]
        rc, out, err = s.cli("restore", "--generation", str(gen), "--confirm", "restore-%d" % gen)
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(s.cli("check-radicale")[0], 0)
        self.assertTrue(s.api("GET", "/health").json["ok"])
        self.assertIn("[ERROR] radui_rights", s.radicale_log_text())


@H.requires_radicale
class RateLimits(unittest.TestCase):
    def test_failed_logins_block_the_address(self):
        s = H.Stack("rate", cfg={"rate_limit_failures": 3,
                                 "rate_limit_window_s": 60,
                                 "rate_limit_block_s": 5}).up()
        self.addCleanup(s.close)
        for _ in range(3):
            self.assertEqual(s.api("GET", "/me", "alice",
                                   password="wrong").status, 401)
        r = s.api("GET", "/me", "alice", password="wrong")
        self.assertEqual((r.status, code(r)), (429, "rate_limited"))
        self.assertIn("retry-after", r.headers)
        # even the right password is refused while the address is blocked
        self.assertEqual(s.api("GET", "/me", "alice").status, 429)
        self.assertEqual(s.api("GET", "/health").status, 200)
        # a different client address (trusted proxy header) is not blocked
        self.assertEqual(s.api("GET", "/me", "alice", headers={
            "X-Real-IP": "192.0.2.77"}).status, 200)
        self.assertEqual(s.api("GET", "/me", "alice", password="x", headers={
            "X-Real-IP": "192.0.2.77"}).status, 401)
        # no per-login lockout: after the block expires alice logs in again
        time.sleep(5.3)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)
        events = [json.loads(x) for x in s.stdout().splitlines()]
        self.assertTrue([e for e in events if e["result"] == "blocked"])
        self.assertNotIn("www-authenticate", s.seen_headers)

    def test_request_rate_limit(self):
        s = H.Stack("rate2", cfg={"requests_per_minute": 60,
                                  "requests_burst": 5}).up()
        self.addCleanup(s.close)
        codes = [s.api("GET", "/me", "alice").status for _ in range(8)]
        self.assertEqual(codes[:5], [200] * 5)
        self.assertIn(429, codes)
        self.assertEqual(s.api("GET", "/health").status, 200)


if __name__ == "__main__":
    unittest.main()
