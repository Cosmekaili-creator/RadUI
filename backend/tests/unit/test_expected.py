# SPDX-License-Identifier: AGPL-3.0-or-later
"""expected.py: the oracle, the probe list and the matcher plumbing."""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402
from helpers import MATCHER, NOW, Builder, case_models  # noqa: E402
from radui_admin import expected as E, generator, model as M  # noqa: E402


def lv(model, user, path):
    return E.expected(model, user, path)


class OracleTests(unittest.TestCase):
    def setUp(self):
        self.m = case_models()["admin-bots-grants"]
        self.tok = self.m.gen_token

    def test_anonymous(self):
        self.assertEqual(lv(self.m, "", "radui-gen-" + self.tok), "generation")
        self.assertEqual(lv(self.m, "", "radui-gen-x"), "none")
        self.assertEqual(lv(self.m, "", ""), "none")
        self.assertEqual(lv(self.m, "", "alice"), "none")

    def test_root_for_every_authenticated_login(self):
        for u in ("alice", "agent-1", "ghost"):
            self.assertEqual(lv(self.m, u, ""), "root")

    def test_admin(self):
        m = self.m
        self.assertEqual(lv(m, "alice", "alice"), "principal")
        self.assertEqual(lv(m, "alice", "bob"), "principal")
        self.assertEqual(lv(m, "alice", "agent-1"), "principal-ro")  # ownSpace off
        self.assertEqual(lv(m, "alice", "ghost"), "principal-ro")
        self.assertEqual(lv(m, "alice", "radui-gen-x"), "principal-ro")
        self.assertEqual(lv(m, "alice", "bob/x"), "admin")
        self.assertEqual(lv(m, "alice", "bob/x/y"), "admin")

    def test_non_admin(self):
        m = self.m
        self.assertEqual(lv(m, "bob", "bob"), "principal")
        self.assertEqual(lv(m, "bob", "alice"), "none")
        self.assertEqual(lv(m, "bob", "bob/c"), "own")
        self.assertEqual(lv(m, "bob", "bob/c/x"), "none")
        self.assertEqual(lv(m, "bob", "alice/cal-work"), "none")
        self.assertEqual(lv(m, "agent-2", "agent-2/c"), "own")
        self.assertEqual(lv(m, "agent-1", "agent-1"), "principal")
        self.assertEqual(lv(m, "agent-1", "agent-1/c"), "none")       # D3

    def test_grants(self):
        m = self.m
        self.assertEqual(lv(m, "agent-1", "alice/cal-work"), "grant-r")
        self.assertEqual(lv(m, "agent-1", "alice/contacts"), "grant-rw")
        self.assertEqual(lv(m, "agent-1", "alice/other"), "none")
        self.assertEqual(lv(m, "agent-2", "alice/contacts"), "none")
        self.assertEqual(lv(m, "agent-1", "alice/cal-work/item"), "none")
        self.assertEqual(lv(m, "agent-1", "bob/shared-tasks"), "grant-rw")

    def test_disabled_tombstoned_unknown(self):
        m = case_models()["disabled"]
        self.assertEqual(lv(m, "bob", "bob"), "none")
        self.assertEqual(lv(m, "bob", ""), "root")
        self.assertEqual(lv(m, "carol", "alice/cal-work"), "none")
        self.assertEqual(lv(m, "bob", "alice/cal-work"), "none")
        self.assertEqual(lv(m, "alice", "bob"), "principal-ro")
        # a disabled OWNER does not revoke its grants; a disabled GRANTEE loses them
        self.assertEqual(lv(m, "carol", "bob/mine"), "grant-rw")
        self.assertEqual(lv(m, "bob", "carol/mine"), "none")
        t = case_models()["tombstoned"]
        self.assertEqual(lv(t, "bob", "bob"), "none")
        self.assertEqual(lv(t, "alice", "bob"), "principal-ro")

    def test_owner_disabled_grantee_keeps_access_grantee_disabled_loses(self):
        b = Builder().account("alice", admin=True).account("bob").account("carol")
        b.grant("bob", "c", "carol", "read")
        self.assertEqual(lv(b.m, "carol", "bob/c"), "grant-r")
        b.disable("bob")                       # owner disabled
        self.assertEqual(lv(b.m, "carol", "bob/c"), "grant-r")
        self.assertEqual(lv(b.m, "bob", "bob/c"), "none")
        b.m = M.enable_account(b.m, "bob", now=NOW, by="cli")
        b.disable("carol")                     # grantee disabled
        self.assertEqual(lv(b.m, "carol", "bob/c"), "none")

    def test_owner_deleted_grants_removed(self):
        b = Builder().account("alice", admin=True).account("bob").account("carol")
        b.grant("bob", "c", "carol", "read").delete("bob")
        self.assertEqual(b.m.grants, ())
        self.assertEqual(lv(b.m, "carol", "bob/c"), "none")

    def test_grant_to_admin_shadowed(self):
        b = Builder().account("alice", admin=True).account("bob").account("carol")
        b.grant("bob", "c", "carol", "read")
        from radui_admin import model as M
        m = M.patch_account(b.m, "carol", admin=True, now=NOW, by="cli")
        self.assertEqual(lv(m, "carol", "bob/c"), "admin")

    def test_paths_must_be_sane(self):
        for bad in ("/a", "a/", "a//b"):
            with self.assertRaises(ValueError):
                lv(self.m, "alice", bad)

    def test_letters_table(self):
        self.assertEqual(E.letters("admin"), "RWrwDO")
        self.assertEqual(E.letters("own"), "rwDO")
        self.assertEqual(E.letters("grant-rw"), "rwl")
        self.assertEqual(E.letters("none"), "")
        self.assertEqual(E.letters("generation"), "i")
        self.assertEqual(E.letter_set("RW"), frozenset("RW"))
        with self.assertRaises(KeyError):
            E.letters("superuser")

    def test_expected_letters(self):
        self.assertEqual(E.expected_letters(self.m, "agent-1", "alice/cal-work"), "r")


class ProbeTests(unittest.TestCase):
    def test_probe_contents(self):
        m = case_models()["tombstoned"]
        pairs = E.probe_pairs(m)
        users = {u for u, _ in pairs}
        paths = {p for _, p in pairs}
        self.assertIn("", users)                       # anonymous
        self.assertIn("bob", users)                    # tombstoned login
        self.assertIn("radui-probe-user", users)
        for p in ("", "bob", "bob/radui-probe", "alice/radui-probe/x",
                  "radui-gen-x", "radui-probe-top", "radui-gen-" + m.gen_token,
                  ):
            self.assertIn(p, paths)
        g = E.probe_pairs(case_models()["admin-bots-grants"])
        self.assertIn(("agent-1", "alice/cal-work"), g)
        self.assertIn(("bob", "alice/contacts/x"), g)
        self.assertEqual(len(pairs), len(set(pairs)))
        self.assertEqual(pairs, E.probe_pairs(m))      # deterministic

    def test_every_probe_has_an_answer(self):
        for m in case_models().values():
            for u, p in E.probe_pairs(m):
                E.expected(m, u, p)


class MatcherPlumbingTests(unittest.TestCase):
    def test_find_python_env(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "python")
            with open(fake, "w") as fh:
                fh.write("#!/bin/sh\n")
            os.chmod(fake, 0o755)
            with mock.patch.dict(os.environ, {"RADICALE_PYTHON": fake}):
                self.assertEqual(E.find_radicale_python(d), fake)
            with mock.patch.dict(os.environ, {
                    "RADICALE_PYTHON": "", "RADICALE_BIN": os.path.join(d, "radicale")}):
                self.assertEqual(E.find_radicale_python(d), fake)

    def test_find_python_from_env_local_and_missing(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "bin", "python")
            os.makedirs(os.path.dirname(fake))
            with open(fake, "w") as fh:
                fh.write("x")
            os.chmod(fake, 0o755)
            with open(os.path.join(d, ".env.local"), "w") as fh:
                fh.write("OTHER=1\nRADICALE_BIN='%s'\n"
                         % os.path.join(d, "bin", "radicale"))
            with mock.patch.dict(os.environ, {"RADICALE_PYTHON": "",
                                              "RADICALE_BIN": ""}):
                self.assertEqual(E.find_radicale_python(d), fake)
            with tempfile.TemporaryDirectory() as empty:
                with mock.patch.dict(os.environ, {"RADICALE_PYTHON": "",
                                                  "RADICALE_BIN": ""}):
                    self.assertIsNone(E.find_radicale_python(empty))

    def test_matcher_without_python_raises(self):
        with mock.patch.object(E, "find_radicale_python", return_value=None):
            with self.assertRaises(RuntimeError):
                E.RadicaleMatcher()

    def test_mismatches_with_fake_matcher(self):
        m = case_models()["admin-only"]
        pairs = [("alice", ""), ("alice", "alice")]
        out = E.mismatches(m, "ignored", lambda t, p: ["R", "R"], pairs)
        self.assertEqual(out, [("alice", "alice", "R", "RW")])
        self.assertEqual(E.mismatches(m, "x", lambda t, p: ["R", "WR"], pairs), [])


@unittest.skipUnless(MATCHER, "no Radicale interpreter configured")
class RealMatcherTests(unittest.TestCase):
    def test_matcher_rejects_bad_file(self):
        with self.assertRaises(RuntimeError):
            MATCHER("[broken", [("a", "")])

    def test_matcher_accepts_non_ascii_comments(self):
        # a legacy rights file may carry UTF-8 comments (em dash, accents)
        text = ("# legacy \u2014 comment \u00e9\n[root]\nuser: .+\n"
                "collection: ^$\npermissions: R\n")
        self.assertEqual(MATCHER(text, [("alice", "")]), ["R"])

    def test_matcher_evaluates(self):
        text = generator.generate(case_models()["admin-only"])[0]
        self.assertEqual(MATCHER(text, [("alice", "alice/c"), ("", ""),
                                        ("zed", "alice")]),
                         ["".join(sorted("RWrwDO")), "", ""])


if __name__ == "__main__":
    unittest.main()
