# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plugin test (f): the plugin's own validation of the rights file (D2).

Every bad variant is checked twice: directly through the plugin's validator
(in-process, with the exact reason) and at runtime on a throwaway Radicale,
where the old rules must stay in force and exactly one ERROR line is logged
per rejected file version. A properly formed file is the control: it must be
accepted, otherwise a rejection would prove nothing.
"""
import unittest

from . import support
from .support import (Instance, bad_variants, good_rights, requires_radicale,
                      run_inproc)

EXPECTED_REASON = {
    "truncated-at-section-boundary": "trailer",
    "truncated-original-trailer": "SHA-256",
    "truncated-resigned": "zzz-deny",
    "tampered-byte": "SHA-256",
    "empty": "empty",
    "whitespace-only": "empty",
    "header-only": "trailer",
    "no-trailer": "trailer",
    "trailing-garbage": "trailer",
    "generation-mismatch": "generation",
    "no-header": "header",
    "no-sections": "no sections",
    "zzz-deny-not-last": "zzz-deny",
    "zzz-deny-with-letters": "grant nothing",
    "missing-zzz-deny": "zzz-deny",
    "bad-letter": "letter",
    "letter-d-not-allowed": "letter",
    "bad-regex": "compile",
    "bad-user-regex": "compile",
    "bad-format-placeholder": "forbidden character",
    "group-index-out-of-range": "forbidden character",
    "groups-key": "groups",
    "nul-byte": "NUL",
    "non-ascii": "ASCII",
    "duplicate-section": "already exists",
    "no-permissions-key": "permissions",
}


class VariantCatalogue(unittest.TestCase):
    def test_every_variant_has_an_expected_reason(self):
        names = set(bad_variants()) - {"good"}
        self.assertEqual(names, set(EXPECTED_REASON))


@requires_radicale
class ValidatorUnit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.res = run_inproc("validator")

    def test_f_control_good_file_is_accepted(self):
        self.assertTrue(self.res["good"]["ok"])
        self.assertEqual(self.res["good"]["generation"], 7)

    def test_f_each_bad_variant_is_rejected_for_the_right_reason(self):
        for name, needle in EXPECTED_REASON.items():
            with self.subTest(variant=name):
                got = self.res[name]
                self.assertFalse(got["ok"], "%s was accepted" % name)
                self.assertIn(needle, got["error"])


@requires_radicale
class ValidatorRuntime(unittest.TestCase):
    """Bad files written over a running instance: old rules stay."""

    @classmethod
    def setUpClass(cls):
        cls.inst = Instance("validate")
        cls.addClassCleanup(cls.inst.close)
        # running rules: bob may write cal-bb only; a variant that slipped
        # through would give him cal-aa instead
        data, cls.token = good_rights(1, [("bob", "alice", "cal-bb", "rw")])
        cls.inst.atomic_write(cls.inst.rights_path, data)
        assert cls.inst.start(), cls.inst.log()
        for c in ("cal-aa", "cal-bb"):
            assert cls.inst.make_calendar("alice", c).status == 201

    @classmethod
    def tearDownClass(cls):
        cls.inst.close()

    def view(self):
        return (self.inst.level("bob", "alice", "cal-aa"),
                self.inst.level("bob", "alice", "cal-bb"))

    def errors(self):
        return len(self.inst.log_lines("[ERROR] radui_rights: new rights file"))

    def test_f_bad_files_keep_old_rules_and_log_one_error_each(self):
        inst = self.inst
        self.assertEqual(self.view(), ("-", "W"))
        variants = bad_variants()
        variants.pop("good")
        for i, (name, data) in enumerate(sorted(variants.items())):
            with self.subTest(variant=name):
                before = self.errors()
                how = "atomic" if i % 2 == 0 else "inplace"
                inst.write_rights(data, how)
                for _ in range(4):
                    self.assertEqual(self.view(), ("-", "W"),
                                     "%s changed the active rules" % name)
                self.assertEqual(self.errors() - before, 1,
                                 "expected exactly one ERROR for %s" % name)
                self.assertEqual(inst.probe(self.token), 404)
                self.assertEqual(inst.probe("a" * 32), 401,
                                 "%s: its generation became active" % name)

    def test_f_zzz_control_properly_formed_file_is_accepted(self):
        """Control for the test above: the same generator, a valid result."""
        inst = self.inst
        data = bad_variants()["good"]
        inst.write_rights(data, "atomic")
        self.assertEqual(self.view(), ("W", "-"))
        self.assertEqual(inst.probe("a" * 32), 404)
        # and it can go back
        data, token = good_rights(8, [("bob", "alice", "cal-bb", "rw")])
        inst.write_rights(data, "atomic")
        self.assertEqual(self.view(), ("-", "W"))
        self.assertEqual(inst.probe(token), 404)


if __name__ == "__main__":
    unittest.main()
