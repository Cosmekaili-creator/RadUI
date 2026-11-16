# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plugin tests (g) and (h): startup with a bad file, the ``.lkg`` fallback
and its staleness, and an unreadable rights file.

The ``.lkg`` file is the last version the backend saw become active. It can
be older than the file it replaces: when the main file is unusable at startup
the plugin runs on the stale copy, which can include access that was revoked
since. ``test_g_stale_lkg_regrants_revoked_access`` shows exactly that; the
README documents it.
"""
import os
import unittest

from . import support
from .support import Instance, good_rights, info, requires_radicale

GRANT_AA = [("bob", "alice", "cal-aa", "rw")]


def prepared(name):
    """An instance whose storage holds alice/cal-aa and whose server is
    stopped (the rights files are set by each test before starting)."""
    inst = Instance(name)
    data, _ = good_rights(1, [])
    inst.atomic_write(inst.rights_path, data)
    assert inst.start(), inst.log()
    assert inst.make_calendar("alice", "cal-aa").status == 201
    inst.stop()
    return inst


def corrupt(data):
    """Flip one byte inside the body: the trailer hash no longer matches."""
    b = bytearray(data)
    b[b.index(b"permissions: rw") + 14] = ord("R")
    return bytes(b)


@requires_radicale
class LkgStartup(unittest.TestCase):
    def setUp(self):
        self.inst = prepared("startup")

    def tearDown(self):
        self.inst.close()

    def bob(self):
        return self.inst.level("bob", "alice", "cal-aa")

    def test_g_bad_main_good_lkg_starts_on_lkg(self):
        inst = self.inst
        main, _ = good_rights(6, [])
        lkg, token = good_rights(5, GRANT_AA)
        inst.atomic_write(inst.rights_path, corrupt(main + b""))
        inst.atomic_write(inst.lkg_path, lkg)
        self.assertTrue(inst.start(), inst.log())
        self.assertEqual(self.bob(), "W")
        crit = inst.log_lines("[CRITICAL] radui_rights: rights file unusable")
        self.assertEqual(len(crit), 1, inst.log())
        self.assertIn("generation=5 source=lkg", crit[0])
        self.assertEqual(inst.probe(token), 404)
        # the bad main is remembered: no per-request noise
        for _ in range(10):
            self.bob()
        self.assertEqual(len(inst.log_lines("[ERROR]")), 0)
        self.assertEqual(len(inst.log_lines("[CRITICAL]")), 1)

    def test_g_stale_lkg_regrants_revoked_access(self):
        """The documented hazard: lkg = generation 5 (bob has access); main =
        generation 6 (access revoked) but unusable after a crash or a bad
        copy. After a restart the revoked access is back until the backend
        regenerates the file."""
        inst = self.inst
        revoked, rev_token = good_rights(6, [])
        stale, _ = good_rights(5, GRANT_AA)
        inst.atomic_write(inst.rights_path, revoked)
        inst.atomic_write(inst.lkg_path, stale)
        self.assertTrue(inst.start(), inst.log())
        self.assertEqual(self.bob(), "-", "main file is fine: revoked")
        inst.stop()
        # now the main file is damaged (truncated)
        inst.atomic_write(inst.rights_path, revoked[:len(revoked) // 2])
        self.assertTrue(inst.start(), inst.log())
        self.assertEqual(self.bob(), "W",
                         "stale lkg re-granted access that was revoked")
        info("(g) stale .lkg: revoked access (gen 6) is active again from the "
             "gen 5 lkg after a restart with a damaged main file; CRITICAL "
             "line names generation=5")
        self.assertEqual(inst.probe(rev_token), 401,
                         "the revoked generation must not look active")
        # repairing the main file takes over at once
        inst.write_rights(revoked, "atomic")
        self.assertEqual(self.bob(), "-")
        self.assertEqual(inst.probe(rev_token), 404)
        self.assertEqual(len(inst.log_lines("source lkg -> file")), 1)

    def test_g_missing_main_good_lkg_starts_then_main_appears(self):
        inst = self.inst
        lkg, _ = good_rights(5, GRANT_AA)
        inst.atomic_write(inst.lkg_path, lkg)
        if os.path.exists(inst.rights_path):
            os.unlink(inst.rights_path)
        self.assertTrue(inst.start(), inst.log())
        self.assertEqual(self.bob(), "W")
        for _ in range(5):
            self.bob()
        self.assertEqual(len(inst.log_lines("[ERROR]")), 0)
        main, token = good_rights(6, [])
        inst.write_rights(main, "atomic")
        self.assertEqual(self.bob(), "-")
        self.assertEqual(inst.probe(token), 404)

    def test_g_good_main_ignores_bad_lkg(self):
        inst = self.inst
        main, token = good_rights(6, GRANT_AA)
        inst.atomic_write(inst.rights_path, main)
        inst.atomic_write(inst.lkg_path, b"garbage\n")
        self.assertTrue(inst.start(), inst.log())
        self.assertEqual(self.bob(), "W")
        self.assertEqual(len(inst.log_lines("[CRITICAL]")), 0)

    def test_g_both_bad_refuses_to_start_with_documented_message(self):
        inst = self.inst
        main, _ = good_rights(6, GRANT_AA)
        lkg, _ = good_rights(5, GRANT_AA)
        inst.atomic_write(inst.rights_path, corrupt(main))
        inst.atomic_write(inst.lkg_path, corrupt(lkg))
        self.assertTrue(inst.start_expect_failure(),
                        "Radicale started with two unusable rights files")
        log = inst.log()
        self.assertIn("no usable rights file", log)
        self.assertIn("Radicale 3.9.", log)      # the installed version
        self.assertIn("3.9.x", log)               # the tested range
        self.assertIn("check-radicale", log)
        self.assertIn(inst.rights_path, log)
        self.assertIn(inst.lkg_path, log)

    def test_g_bad_main_without_lkg_refuses_to_start(self):
        inst = self.inst
        main, _ = good_rights(6, GRANT_AA)
        inst.atomic_write(inst.rights_path, corrupt(main))
        if os.path.exists(inst.lkg_path):
            os.unlink(inst.lkg_path)
        self.assertTrue(inst.start_expect_failure())
        self.assertIn("check-radicale", inst.log())

    def test_g_empty_main_and_no_lkg_refuses_to_start(self):
        inst = self.inst
        inst.atomic_write(inst.rights_path, b"")
        self.assertTrue(inst.start_expect_failure())
        self.assertIn("rights file is empty", inst.log())


@requires_radicale
class UnreadableFile(unittest.TestCase):
    """(h) EACCES on the rights file (chmod 000 as the same user)."""

    @classmethod
    def setUpClass(cls):
        cls.inst = Instance("eacces")
        cls.addClassCleanup(cls.inst.close)
        data, cls.token = good_rights(1, GRANT_AA)
        cls.inst.atomic_write(cls.inst.rights_path, data)
        assert cls.inst.start(), cls.inst.log()
        assert cls.inst.make_calendar("alice", "cal-aa").status == 201

    @classmethod
    def tearDownClass(cls):
        cls.inst.close()

    def bob(self):
        return self.inst.level("bob", "alice", "cal-aa")

    def test_h_eacces_keeps_old_rules_and_logs_one_error(self):
        inst = self.inst
        if os.geteuid() == 0:
            self.skipTest("chmod 000 does not block root")
        self.assertEqual(self.bob(), "W")
        errors_before = len(inst.log_lines("[ERROR]"))
        os.chmod(inst.rights_path, 0)
        try:
            with self.assertRaises(PermissionError):
                open(inst.rights_path, "rb").close()   # test is meaningful
            for _ in range(30):
                self.assertEqual(self.bob(), "W")
            lines = inst.log_lines("[ERROR]")
            self.assertEqual(len(lines) - errors_before, 1, lines)
            self.assertIn("cannot use rights file", lines[-1])
            self.assertIn("Permission denied", lines[-1])
            # a replacement by rename works even while the old file is 000
            data, token = good_rights(2, [])
            inst.atomic_write(inst.rights_path, data)
            self.assertEqual(self.bob(), "-")
            self.assertEqual(inst.probe(token), 404)
        finally:
            os.chmod(inst.rights_path, 0o640)

    def test_h_readable_again_same_content_no_reload(self):
        inst = self.inst
        if os.geteuid() == 0:
            self.skipTest("chmod 000 does not block root")
        data, token = good_rights(3, GRANT_AA)
        inst.write_rights(data, "atomic")
        self.assertEqual(self.bob(), "W")
        reloads = len(inst.log_lines("radui_rights: reloaded"))
        errors = len(inst.log_lines("[ERROR]"))
        os.chmod(inst.rights_path, 0)
        try:
            for _ in range(5):
                self.assertEqual(self.bob(), "W")
        finally:
            os.chmod(inst.rights_path, 0o640)
        for _ in range(5):
            self.assertEqual(self.bob(), "W")
        self.assertEqual(len(inst.log_lines("[ERROR]")) - errors, 1)
        self.assertEqual(len(inst.log_lines("radui_rights: reloaded")), reloads)
        self.assertEqual(len(inst.log_lines("usable again")), 1)
        # and a later change still applies
        data, token = good_rights(4, [])
        inst.write_rights(data, "atomic")
        self.assertEqual(self.bob(), "-")


@requires_radicale
class UnreadableAtStartup(unittest.TestCase):
    def test_h_eacces_main_at_startup_falls_back_to_lkg(self):
        if os.geteuid() == 0:
            self.skipTest("chmod 000 does not block root")
        inst = prepared("eacces-start")
        try:
            main, _ = good_rights(6, [])
            lkg, _ = good_rights(5, GRANT_AA)
            inst.atomic_write(inst.rights_path, main)
            inst.atomic_write(inst.lkg_path, lkg)
            os.chmod(inst.rights_path, 0)
            self.assertTrue(inst.start(), inst.log())
            self.assertEqual(inst.level("bob", "alice", "cal-aa"), "W")
            crit = inst.log_lines("[CRITICAL]")
            self.assertEqual(len(crit), 1)
            self.assertIn("Permission denied", crit[0])
            for _ in range(5):
                inst.level("bob", "alice", "cal-aa")
            self.assertEqual(len(inst.log_lines("[ERROR]")), 0)
            os.chmod(inst.rights_path, 0o640)
            self.assertEqual(inst.level("bob", "alice", "cal-aa"), "-")
        finally:
            inst.close()


if __name__ == "__main__":
    unittest.main()
