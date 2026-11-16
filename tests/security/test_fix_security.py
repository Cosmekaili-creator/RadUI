# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fix work order 1, against a real backend and Radicale (ports 15360-15374).

* M4: when the TCP peer is not a trusted proxy the address header is ignored
  (the limiter key and the value Radicale logs are the peer), and a scoped
  IPv6 value never reaches Radicale's log.
* M5: an owner cannot tell an unknown, a disabled and an admin account apart.
* M1: a restore after a password reset or a delete does not bring back the old
  hash or the login, and it needs the typed confirmation.
"""
import os
import re
import sys
import time
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(
    __file__))))
INTEG = os.path.join(REPO, "backend", "tests", "integration")
sys.path.insert(0, INTEG)
import test_fix_stack as F  # noqa: E402

FORWARDED = re.compile(r"\(forwarded for '([^']*)'\)")
SCOPED = "2001:db8::1%a') x (forwarded for '198.51.100.99"


def code(r):
    return r.json["error"]["code"] if r.json and "error" in r.json else None


@F.requires_radicale
class UntrustedPeer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # loopback (the test client) is NOT a trusted proxy here
        s = cls.s = F.FStack("untrusted", cfg={
            "trusted_proxies": ["192.0.2.0/24"], "rate_limit_failures": 3,
            "rate_limit_window_s": 60, "rate_limit_block_s": 60}).up()
        cls.addClassCleanup(s.close)

    def test_spoofed_address_header_neither_keys_the_limiter_nor_is_logged(self):
        s = self.s
        before = len(s.radicale_log_text())
        statuses = []
        for i in range(5):
            r = s.api("GET", "/me", "alice", password="wrong-%d" % i, headers={
                "X-Real-IP": "203.0.113.%d" % (i + 1)})
            statuses.append(r.status)
        self.assertEqual(statuses, [401, 401, 401, 429, 429])
        time.sleep(0.2)
        logged = FORWARDED.findall(s.radicale_log_text()[before:])
        self.assertTrue(logged)
        self.assertEqual(set(logged), {"127.0.0.1"})
        # the genuine credentials of a blocked address are refused too
        self.assertEqual(s.api("GET", "/me", "alice", headers={
            "X-Real-IP": "203.0.113.200"}).status, 429)


@F.requires_radicale
class ScopedAddress(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = F.FStack("scoped", cfg={"rate_limit_failures": 3,
                                            "rate_limit_window_s": 60,
                                            "rate_limit_block_s": 60}).up()
        cls.addClassCleanup(s.close)

    def test_scoped_ipv6_with_an_injected_log_fragment(self):
        s = self.s
        before = len(s.radicale_log_text())
        r = s.api("GET", "/me", "alice", password="wrong", headers={
            "X-Real-IP": SCOPED})
        self.assertEqual(r.status, 401)
        time.sleep(0.2)
        log = s.radicale_log_text()[before:]
        self.assertEqual(FORWARDED.findall(log), ["127.0.0.1"])
        self.assertNotIn("198.51.100.99", log)
        self.assertNotIn("%a", log)
        audit = [ln for ln in s.stdout().splitlines() if "auth.failed" in ln]
        self.assertTrue(audit)
        self.assertNotIn("198.51.100.99", audit[-1])
        # the attacker's chosen key is not a key: three more failures block
        # the peer address
        for _ in range(2):
            s.api("GET", "/me", "alice", password="wrong", headers={
                "X-Real-IP": SCOPED})
        self.assertEqual(s.api("GET", "/me", "alice", headers={
            "X-Real-IP": SCOPED}).status, 429)


@F.requires_radicale
class NoAccountProbing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = F.FStack("probing").up()
        cls.addClassCleanup(s.close)
        s.make_user("owner-1")
        s.make_user("carol-1")
        s.make_user("off-1")
        s.make_user("admin-2", admin=True)
        assert s.mkcalendar("owner-1", "owner-1", "mine").status == 201
        assert s.api("PATCH", "/accounts/off-1", "alice",
                     {"disabled": True}).status == 200

    def put(self, grantee, level="read", who="owner-1"):
        return self.s.api("PUT", "/grants", who, {
            "owner": "owner-1", "collection": "mine", "grantee": grantee,
            "level": level})

    def test_unknown_disabled_and_admin_grantees_give_identical_answers(self):
        answers = [self.put(g) for g in ("ghost-1", "off-1", "alice",
                                         "admin-2")]
        for r in answers:
            self.assertEqual((r.status, code(r)), (422, "validation"))
            self.assertEqual(r.json, answers[0].json)
        self.assertEqual(self.put("carol-1").status, 200)
        self.assertEqual(self.put("carol-1", "none").status, 200)

    def test_revocation_without_a_grant_is_the_same_for_every_login(self):
        answers = [self.put(g, "none") for g in ("ghost-1", "off-1",
                                                 "carol-1", "alice")]
        for r in answers:
            self.assertEqual((r.status, code(r)), (422, "validation"))
            self.assertEqual(r.json, answers[0].json)

    def test_the_admin_still_gets_the_specific_errors(self):
        r = self.put("ghost-1", who="alice")
        self.assertEqual((r.status, code(r)), (404, "not_found"))
        r = self.put("off-1", who="alice")
        self.assertIn("disabled", r.json["error"]["message"])


@F.requires_radicale
class RestoreKeepsSecurityActions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = F.FStack("restore").up()
        cls.addClassCleanup(s.close)

    def test_restore_does_not_re_arm_a_reset_password_or_a_deleted_login(self):
        s = self.s
        s.make_user("temp-1", bot=True)
        base = s.model().generation         # temp-1 exists in this snapshot
        old_pw = s.pw["agent-1"]
        r = s.api("POST", "/accounts/agent-1/password", "alice",
                  {"generate": True})
        self.assertEqual(r.status, 200)
        new_pw = r.json["password"]
        s.pw["agent-1"] = new_pw
        self.assertEqual(s.api("DELETE", "/accounts/temp-1", "alice",
                               {"confirm": "temp-1"}).status, 200)
        path = "/generations/%d/restore" % base
        r = s.api("POST", path, "alice", {})
        self.assertEqual((r.status, code(r)), (422, "validation"))
        r = s.api("POST", path, "alice", {"confirm": "restore-%d" % (base + 1)})
        self.assertEqual(r.status, 422)
        gen_before = s.model().generation
        dry = s.api("POST", path, "alice", {}, query="?dryRun=1")
        self.assertEqual(dry.status, 200)
        self.assertEqual(s.model().generation, gen_before)
        self.assertEqual(set(dry.json["restore"]), {
            "accountsDropped", "accountsRemoved", "grantsAdded",
            "grantsRemoved", "flagsChanged", "currentModel"})
        self.assertEqual(dry.json["restore"]["accountsDropped"], ["temp-1"])
        self.assertEqual(dry.json["restore"]["accountsRemoved"], [])
        r = s.api("POST", path, "alice", {"confirm": "restore-%d" % base})
        self.assertEqual(r.status, 200, r.json)
        self.assertTrue(r.json["active"])
        # the NEW password still works, the OLD one does not
        self.assertEqual(s.api("GET", "/me", "agent-1").status, 200)
        self.assertEqual(s.api("GET", "/me", "agent-1",
                               password=old_pw).status, 401)
        self.assertEqual(s.dav("PROPFIND", "/", "agent-1",
                               headers={"Depth": "0"}).status, 207)
        self.assertEqual(s.dav("PROPFIND", "/", "agent-1", password=old_pw,
                               headers={"Depth": "0"}).status, 401)
        # the deleted login stays gone and reserved
        self.assertEqual(s.api("GET", "/accounts/temp-1", "alice").status, 404)
        self.assertIn("temp-1", s.model().tombstones)
        r = s.api("POST", "/accounts", "alice", {
            "login": "temp-1", "displayName": "T", "generate": True})
        self.assertEqual(code(r), "tombstoned")
        self.assertTrue(s.api("GET", "/health").json["ok"])


@F.requires_radicale
class RestoreCli(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = F.FStack("restore-cli").up()
        cls.addClassCleanup(s.close)

    def test_cli_needs_the_confirmation_flag(self):
        s = self.s
        gen = s.model().generation
        rc, out, err = s.cli("restore", "--generation", str(gen))
        self.assertEqual(rc, 2, out + err)
        self.assertEqual(s.model().generation, gen)
        rc, out, err = s.cli("restore", "--generation", str(gen), "--dry-run")
        self.assertEqual(rc, 0, out + err)
        rc, out, err = s.cli("restore", "--generation", str(gen), "--confirm",
                             "restore-%d" % gen)
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(s.model().generation, gen + 1)
        self.assertTrue(s.api("GET", "/health").json["ok"])


if __name__ == "__main__":
    unittest.main()
