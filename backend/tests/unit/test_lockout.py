# SPDX-License-Identifier: AGPL-3.0-or-later
"""lockout.py: the lockout matrix."""
import dataclasses
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402
from helpers import MATCHER, NOW, Builder, case_models  # noqa: E402
from radui_admin import expected, generator, lockout, model as M  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402


def world():
    b = Builder().account("alice", admin=True).account("bob", admin=True)
    b.account("carol").account("agent-1", type="bot")
    b.grant("carol", "cal", "agent-1", "read")
    return b.m


def err(old, new, actor=None, **kw):
    try:
        lockout.check_change(old, new, actor, **kw)
    except ApiError as e:
        return (e.code, e.reason)
    return None


def patch(m, login, **kw):
    return M.patch_account(m, login, now=NOW, by="cli", **kw)


class MatrixTests(unittest.TestCase):
    def test_harmless_changes_allowed(self):
        m = world()
        for new in (
            patch(m, "carol", display_name="Caroline"),
            patch(m, "carol", disabled=True),
            patch(m, "carol", admin=True),
            patch(m, "alice", own_space=False),
            M.delete_account(m, "carol", now=NOW, by="cli"),
            M.put_grant(m, owner="carol", collection="x", grantee="agent-1",
                        level="read", now=NOW, by="cli"),
        ):
            self.assertIsNone(err(m, new, "alice"))
            self.assertIsNone(err(m, new, None))

    def test_acting_admin_cannot_remove_own_admin(self):
        m = world()
        for new in (patch(m, "alice", disabled=True),
                    patch(m, "alice", admin=False),
                    M.delete_account(m, "alice", now=NOW, by="cli")):
            self.assertEqual(err(m, new, "alice"), ("lockout_self", "self_lockout"))
            self.assertIsNone(err(m, new, "bob"))          # someone else may
            self.assertIsNone(err(m, new, None))           # CLI may

    def test_last_admin_cannot_be_removed_disabled_or_demoted(self):
        m = Builder().account("alice", admin=True).account("carol").m
        for new in (patch(m, "alice", disabled=True),
                    patch(m, "alice", admin=False),
                    M.delete_account(m, "alice", now=NOW, by="cli")):
            for actor in ("alice", "carol", None):
                self.assertEqual(err(m, new, actor),
                                 ("lockout_last_admin", "no_admin_left"))

    def test_last_admin_among_disabled_admins(self):
        m = world()
        m = patch(m, "bob", disabled=True)
        self.assertEqual(m.admins(), ["alice"])
        new = patch(m, "alice", disabled=True)
        self.assertEqual(err(m, new, "carol")[0], "lockout_last_admin")

    def test_two_admins_one_may_go(self):
        m = world()
        self.assertIsNone(err(m, patch(m, "bob", admin=False), "alice"))
        self.assertIsNone(err(m, patch(m, "bob", disabled=True), "alice"))
        self.assertIsNone(err(m, M.delete_account(m, "bob", now=NOW, by="cli"), "alice"))

    def test_no_admin_at_all_refused_even_for_unrelated_change(self):
        m = Builder().account("carol").m
        new = patch(m, "carol", display_name="C2")
        self.assertEqual(err(m, new)[0], "lockout_last_admin")

    def test_bot_admin_rejected(self):
        m = world()
        acc = dataclasses.replace(m.accounts["agent-1"], admin=True)
        accounts = dict(m.accounts)
        accounts["agent-1"] = acc
        new = M.Model(m.generation + 1, m.gen_token, m.bcrypt_cost, accounts,
                      m.grants, m.tombstones)
        self.assertEqual(err(m, new, "alice"), ("validation", "bot_cannot_be_admin"))

    def test_actor_unknown_or_not_admin_is_ignored(self):
        m = world()
        new = patch(m, "carol", disabled=True)
        self.assertIsNone(err(m, new, "ghost"))
        self.assertIsNone(err(m, new, "carol"))  # a non-admin has no admin access to lose

    def test_actor_already_disabled_not_protected(self):
        m = patch(world(), "bob", disabled=True)
        new = M.delete_account(m, "bob", now=NOW, by="cli")
        self.assertIsNone(err(m, new, "bob"))

    def test_restore_style_change_checked_too(self):
        old = world()
        restored = Builder().account("carol").m
        self.assertEqual(err(old, restored, "alice")[0], "lockout_last_admin")


class ProbeTests(unittest.TestCase):
    def test_probes_cover_expected_shape(self):
        m = world()
        probes = lockout.admin_probes(m)
        self.assertIn(("alice", "", "R"), probes)
        self.assertIn(("alice", "alice", "RW"), probes)
        self.assertIn(("alice", "carol", "RW"), probes)
        self.assertIn(("alice", "carol/radui-probe", "RWrwDO"), probes)
        self.assertIn(("bob", "carol/cal", "RWrwDO"), probes)
        self.assertIn(("alice", "radui-probe-top", "R"), probes)
        n = M.delete_account(m, "carol", now=NOW, by="cli")
        self.assertIn(("alice", "carol", "R"), lockout.admin_probes(n))

    def test_clean_model_has_no_violations(self):
        for model in case_models().values():
            self.assertEqual(lockout.admin_probe_violations(model), [])

    def test_downgraded_admin_probe_is_refused(self):
        m = world()

        def broken(user, path):
            if user == "alice" and path.endswith("/radui-probe"):
                return "RW"
            return expected.expected_letters(m, user, path)
        self.assertEqual(err(m, patch(m, "carol", display_name="X"), "bob",
                             evaluator=broken)[0], "lockout_last_admin")
        bad = lockout.admin_probe_violations(m, broken)
        self.assertTrue(bad)
        self.assertEqual(bad[0][0], "alice")

    @unittest.skipUnless(MATCHER, "no Radicale interpreter configured")
    def test_real_evaluator_through_radicale(self):
        m = world()
        rights = generator.generate(m)[0]
        probes = lockout.admin_probes(m)
        got = MATCHER(rights, [(a, p) for a, p, _ in probes])
        table = {(a, p): g for (a, p, _), g in zip(probes, got)}
        self.assertEqual(
            lockout.admin_probe_violations(m, lambda u, p: table[(u, p)]), [])
        # a file that grants admins less than required is detected
        weak = rights.replace("permissions: RWrwDO", "permissions: RWrwD")
        got = MATCHER(weak, [(a, p) for a, p, _ in probes])
        table = {(a, p): g for (a, p, _), g in zip(probes, got)}
        self.assertTrue(
            lockout.admin_probe_violations(m, lambda u, p: table[(u, p)]))


if __name__ == "__main__":
    unittest.main()
