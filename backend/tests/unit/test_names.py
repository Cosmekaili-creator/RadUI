# SPDX-License-Identifier: AGPL-3.0-or-later
"""names.py: login, collection-name and display-name validation."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402,F401
from radui_admin import names  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402

INJECTIONS = [
    "../x", "a/../b", "a/b", "/a", "a/", "..", ".", "{0}", "a{0}", "{user}",
    "a}b", "50%", "a%b", "%(x)s", "a\nb", "ab\n", "\nab", "a\rb", "a\x00b",
    ".*", "a.*", "(a|b)", "a b", " ab", "ab ", "a\tb", "a;b", "a#b", "a[b]",
    "caf\u00e9", "\uff41\uff42", "\u212a\u212a", "\u0430\u0430", "a" * 33,
    "", "a", "-ab", ".ab", "_ab", "+ab", "a\u200b",
]


class LoginTests(unittest.TestCase):
    def test_valid(self):
        for v in ("alice", "a1", "agent-1", "a.b_c-d", "x" * 32, "0a", "a_"):
            self.assertEqual(names.validate_login(v), v, v)

    def test_injection_suite_rejected_strict_and_folding(self):
        for fold in (True, False):
            for bad in INJECTIONS:
                with self.assertRaises(ApiError, msg=repr(bad)) as cm:
                    names.validate_login(bad, fold=fold)
                self.assertEqual(cm.exception.code, "validation")
                self.assertEqual(cm.exception.field, "login")

    def test_uppercase_rejected_in_strict_mode_folded_otherwise(self):
        with self.assertRaises(ApiError) as cm:
            names.validate_login("Alice", fold=False)
        self.assertEqual(cm.exception.reason, "pattern")
        self.assertEqual(names.validate_login("Alice"), "alice")
        self.assertEqual(names.validate_login("ALICE-1"), "alice-1")

    def test_kelvin_sign_never_folds(self):
        with self.assertRaises(ApiError) as cm:
            names.validate_login("\u212aim")
        self.assertEqual(cm.exception.reason, "non_ascii")

    def test_non_string(self):
        for v in (None, 1, b"alice", ["alice"]):
            with self.assertRaises(ApiError) as cm:
                names.validate_login(v)
            self.assertEqual(cm.exception.reason, "not_a_string")

    def test_reserved(self):
        for r in sorted(names.RESERVED_LOGINS) + ["radui-bot", "radui-gen-x",
                                                  "Root", "ADMIN"]:
            with self.assertRaises(ApiError) as cm:
                names.validate_login(r)
            self.assertEqual(cm.exception.reason, "reserved", r)

    def test_expected_reserved_list(self):
        self.assertEqual(names.RESERVED_LOGINS, frozenset(
            "ui api web sharing token anonymous nobody system root admin "
            "administrator radicale radui".split()))

    def test_extra_reserved(self):
        with self.assertRaises(ApiError) as cm:
            names.validate_login("Billing", extra_reserved=["BILLING"])
        self.assertEqual(cm.exception.reason, "reserved")
        self.assertEqual(names.validate_login("billing"), "billing")

    def test_tombstoned(self):
        with self.assertRaises(ApiError) as cm:
            names.validate_login("bob", tombstoned={"bob": 1})
        self.assertEqual(cm.exception.code, "tombstoned")
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(names.validate_login("carol", tombstoned=["bob"]),
                         "carol")

    def test_field_name_and_dict(self):
        with self.assertRaises(ApiError) as cm:
            names.validate_login("..", field="owner")
        self.assertEqual(cm.exception.field, "owner")
        self.assertEqual(cm.exception.as_dict()["error"]["field"], "owner")
        self.assertEqual(cm.exception.status, 422)
        self.assertIn("ApiError", repr(cm.exception))

    def test_trailing_newline_not_accepted(self):
        # "$" would accept it; the whitelist uses fullmatch
        self.assertFalse(names.is_valid_login("alice\n"))
        self.assertFalse(names.is_valid_collection_name("cal\n"))


class CollectionTests(unittest.TestCase):
    def test_valid(self):
        for v in ("cal", "A", "_x", "a.b", "a@b", "a~b", "a+b", "a-b",
                  "x" * 128, "0", "My.Cal+2@x~y-z"):
            self.assertEqual(names.validate_collection_name(v), v)

    def test_trailing_tilde_rejected(self):
        # Radicale answers 400 for a name ending in "~".
        for bad in ("cal~", "a~~", "a.b~", "x" * 127 + "~"):
            with self.assertRaises(ApiError, msg=repr(bad)) as cm:
                names.validate_collection_name(bad)
            self.assertEqual(cm.exception.code, "unsupported_collection_name")
            self.assertFalse(names.is_valid_collection_name(bad))
        for ok in ("a~b", "x" * 126 + "~b", "~"[:0] + "a", "a.", "a@"):
            self.assertEqual(names.validate_collection_name(ok), ok)
        self.assertFalse(names.is_valid_collection_name("~"))

    def test_injection_suite(self):
        for bad in INJECTIONS + ["x" * 129, ".hidden", "-x", "a\x7f", "a,b"]:
            if names.COLLECTION_RE.fullmatch(bad):
                continue  # valid collection names (e.g. "a", "_ab") are fine
            with self.assertRaises(ApiError, msg=repr(bad)) as cm:
                names.validate_collection_name(bad)
            self.assertEqual(cm.exception.code, "unsupported_collection_name")
            self.assertEqual(cm.exception.status, 422)

    def test_dangerous_names_rejected(self):
        for bad in ("../x", "a/b", "{0}", "%", "a\nb", ".*", "caf\u00e9", ""):
            with self.assertRaises(ApiError):
                names.validate_collection_name(bad)

    def test_uppercase_allowed(self):
        self.assertEqual(names.validate_collection_name("Work"), "Work")

    def test_toplevel_prefix_reserved(self):
        with self.assertRaises(ApiError) as cm:
            names.validate_collection_name("radui-gen-abc", top_level=True)
        self.assertEqual(cm.exception.reason, "reserved_prefix")
        self.assertEqual(names.validate_collection_name("radui-gen-abc"),
                         "radui-gen-abc")

    def test_non_string(self):
        with self.assertRaises(ApiError) as cm:
            names.validate_collection_name(5)
        self.assertEqual(cm.exception.code, "unsupported_collection_name")


class DisplayNameTests(unittest.TestCase):
    def test_valid(self):
        for v in ("Alice", "Agent 1", "Zo\u00e9 \u00c9mile", "x" * 64, "\u65e5\u672c"):
            self.assertEqual(names.validate_display_name(v), v)

    def test_rejected(self):
        for v, reason in [("", "empty_or_padded"), (" a", "empty_or_padded"),
                          ("a ", "empty_or_padded"), ("x" * 65, "too_long"),
                          ("a\nb", "control_character"),
                          ("a\x00b", "control_character"),
                          ("a\u202eb", "control_character"),
                          ("a\u2028b", "control_character"),
                          ("a\ud800b", "control_character"),
                          (None, "not_a_string"), (3, "not_a_string")]:
            with self.assertRaises(ApiError, msg=repr(v)) as cm:
                names.validate_display_name(v)
            self.assertEqual(cm.exception.code, "validation")
            self.assertEqual(cm.exception.reason, reason)
            self.assertEqual(cm.exception.field, "displayName")


class ErrorTableTests(unittest.TestCase):
    def test_codes_match_plan(self):
        for code in ("validation", "tombstoned", "unsupported_collection_name",
                     "lockout_last_admin", "lockout_self", "exists",
                     "model_corrupt"):
            self.assertIn(code, names.ERROR_STATUS)
        self.assertEqual(ApiError("unknown_code", "x").status, 500)
        self.assertEqual(ApiError("bad_request", "x").as_dict(),
                         {"error": {"code": "bad_request", "message": "x"}})


if __name__ == "__main__":
    unittest.main()
