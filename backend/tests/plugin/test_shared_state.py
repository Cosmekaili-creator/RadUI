# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plugin tests (e), (j) and the unit-level checks that complement the live
tests: shared state between Radicale's two rights instances, the version
warning hook, the hash and ctime detection paths, the remembered signature of
a failed file, and a file that disappears.

These run in-process under the Radicale interpreter through ``inproc.py``,
which loads the plugin with Radicale's own loader (``radicale.rights.load``).
"""
import unittest

from .support import info, requires_radicale, run_inproc


@requires_radicale
class SharedState(unittest.TestCase):
    """(e) Radicale's base and sharing rights instances share one state."""

    @classmethod
    def setUpClass(cls):
        cls.res = run_inproc("two-instances")

    def test_e_loaded_through_the_radicale_loader(self):
        self.assertEqual(self.res["class_module"], "radui_rights")
        self.assertTrue(self.res["module_file"].endswith("radui_rights.py"))

    def test_e_both_instances_share_one_state_holder(self):
        self.assertTrue(self.res["same_shared"])
        self.assertEqual(self.res["registry_size"], 1)

    def test_e_startup_line_logged_once_not_twice(self):
        self.assertEqual(self.res["startup_lines"], 1)

    def test_e_change_seen_by_the_instance_that_did_not_read_it(self):
        r = self.res
        self.assertEqual((r["before_first"], r["before_second"]),
                         ("rw", "rw"))
        self.assertEqual(r["after_via_first"], "rw")
        self.assertEqual(r["after_first_old"], "")
        self.assertTrue(r["second_sees_same_state_object"])
        self.assertEqual((r["after_via_second"], r["after_second_old"]),
                         ("rw", ""))
        self.assertEqual(r["reload_lines"], 1,
                         "the second instance must not reload again")

    def test_e_other_rights_file_gets_its_own_state(self):
        self.assertTrue(self.res["other_path_separate"])

    def test_e_threads_on_both_instances_during_rewrites(self):
        self.assertEqual(self.res["thread_errors"], [])
        for pair in self.res["answers"]:
            self.assertIn(pair, (["rw", ""], ["", "rw"]),
                          "answer mixes both generations: %r" % (pair,))
        self.assertGreaterEqual(len(self.res["answers"]), 1)
        info("(e) concurrent answers seen across 60 rewrites: %s; ERROR "
             "lines (torn writes are not possible with rename): %d"
             % (self.res["answers"], self.res["error_lines"]))


@requires_radicale
class VersionWarning(unittest.TestCase):
    """(j) WARNING once when Radicale is outside the tested range."""

    @classmethod
    def setUpClass(cls):
        cls.res = run_inproc("version")

    def test_j_in_range_versions_are_silent(self):
        r = self.res
        self.assertTrue(r["in_range_3_9_0"])
        self.assertTrue(r["in_range_3_9_17"])
        self.assertEqual(r["warnings_after_in_range"], 0)

    def test_j_out_of_range_version_warns_once(self):
        r = self.res
        self.assertFalse(r["in_range_3_10_0"])
        self.assertEqual(r["warnings_after_3_10"], 1)
        self.assertIn("3.10.0", r["message"][0])
        self.assertIn("3.9.x", r["message"][0])
        self.assertIn("check-radicale", r["message"][0])
        self.assertEqual(r["warnings_after_second_out_of_range"], 1)

    def test_j_other_out_of_range_strings(self):
        r = self.res
        self.assertFalse(r["in_range_3_8_9"])
        self.assertFalse(r["in_range_garbage"])
        # cumulative: one before the reset, one more after it (once per reset)
        self.assertEqual(r["warnings_after_reset"], 2)

    def test_j_constructor_path_with_simulated_version(self):
        self.assertEqual(self.res["constructor_warnings_simulated"], 1)

    def test_j_installed_version_is_silent(self):
        r = self.res
        info("(j) installed Radicale version: %s" % r["real_version"])
        if r["real_version"].startswith("3.9."):
            self.assertEqual(r["constructor_warnings_real"], 0)
        else:
            self.assertEqual(r["constructor_warnings_real"], 1)


@requires_radicale
class DetectionPaths(unittest.TestCase):
    """The hash path and the ctime path, deterministically."""

    @classmethod
    def setUpClass(cls):
        cls.res = run_inproc("sha-path")

    def test_hash_path_with_identical_stat_signature(self):
        r = self.res
        self.assertEqual(r["before"], "rw")
        self.assertTrue(r["unsettled_after_fresh_write"])
        self.assertTrue(r["same_size_ino_mtime"], "test not meaningful")
        self.assertTrue(r["forged_sig_equals_recorded"], "test not meaningful")
        self.assertEqual(r["sha_path_unsettled"], ["", "rw"],
                         "equal-length rewrite with identical stat signature "
                         "was not noticed through the content hash")

    def test_ctime_path_with_real_stat(self):
        r = self.res
        self.assertTrue(r["settled_now"], "test not meaningful")
        self.assertTrue(r["real_sig_differs_only_in_ctime"])
        self.assertEqual(r["ctime_path"], ["rw", ""])

    def test_documented_limit_of_a_settled_state(self):
        # INFO, not a pass: with a *forged* identical signature a settled
        # state trusts the stat, by design. The real kernel cannot produce
        # that signature after the 2 s window (ctime always moves).
        r = self.res
        info("settled state + forged identical stat signature: rewrite "
             "%s (documented limit; unreachable with a real filesystem)"
             % ("not noticed" if r["settled_forged_not_detected"] == ["", "rw"]
                else "noticed"))
        self.assertIn(r["settled_forged_not_detected"], (["", "rw"], ["rw", ""]))


@requires_radicale
class FailedFileMemory(unittest.TestCase):
    """A rejected file is remembered and not re-read on every request."""

    @classmethod
    def setUpClass(cls):
        cls.res = run_inproc("failed-signature")

    def test_old_rules_kept(self):
        self.assertTrue(self.res["old_rules_kept"])

    def test_not_reread_per_request(self):
        r = self.res
        self.assertGreaterEqual(r["reads_for_first_request"], 1)
        self.assertEqual(r["reads_for_100_more"], 0)

    def test_one_error_per_failed_version(self):
        r = self.res
        self.assertEqual(r["error_lines"], 1)
        self.assertEqual(r["error_lines_after_touch"], 1)

    def test_repaired_file_loads(self):
        self.assertEqual(self.res["after_repair"], "rw")


@requires_radicale
class MissingFile(unittest.TestCase):
    def test_missing_file_one_error_old_rules_then_recovery(self):
        r = run_inproc("stat-error")
        self.assertEqual(r["before"], "rw")
        self.assertTrue(r["kept"])
        self.assertEqual(r["errors_while_missing"], 1)
        self.assertEqual(r["after_return"], "rw")
        self.assertEqual(r["recovery_lines"], 1)
        self.assertEqual(r["after_new"], "rw")


if __name__ == "__main__":
    unittest.main()
