# SPDX-License-Identifier: AGPL-3.0-or-later
"""passwords.py: D4 rules, generation, hashing, verification."""
import os
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402,F401
from radui_admin import passwords as P  # noqa: E402
from radui_admin.names import ApiError, BCRYPT_HASH_RE  # noqa: E402

COST = 4


def reason(pw, login="alice"):
    try:
        P.validate_password(pw, login)
    except ApiError as e:
        assert e.code == "validation" and e.field == "password"
        return e.reason
    return None


class ValidationTests(unittest.TestCase):
    def test_accepts(self):
        for pw in ("Zq7!kLm2pXw9", "correct horse battery", "a1B2c3D4e5F6",
                   "xqvzjwmkxqvzjwmk", "Ab1\u00e9\u00e8\u00ea\u00eb\u00e9",
                   "Zq7!kLm2" + "pXw9" * 16):
            self.assertIsNone(reason(pw), pw)
            self.assertEqual(P.validate_password(pw), pw)

    def test_length_in_bytes(self):
        self.assertEqual(reason("Zq7!kLm2pXw"), "too_short")          # 11
        self.assertIsNone(reason("Zq7!kLm2pXw9"))                     # 12
        self.assertEqual(reason("\u00e9" * 5), "too_short")      # 10 bytes
        self.assertIsNone(reason("Ab1" + "\u00e9" * 5))          # 13 bytes
        ok72 = "Ab1!" + "z" * 68
        self.assertEqual(len(ok72.encode()), 72)
        self.assertIsNone(reason(ok72))
        self.assertEqual(reason(ok72 + "z"), "too_long")
        self.assertEqual(reason("\u00e9\u00e8" * 18 + "\u00ea"), "too_long")
        self.assertIsNone(reason("\u00e9\u00e8" * 18))          # 72 bytes

    def test_control_and_nul(self):
        for ch in ("\x00", "\n", "\t", "\x1b", "\x7f", "\r"):
            self.assertEqual(reason("Zq7!kLm2" + ch + "pXw9"), "control_character")

    def test_non_string_and_surrogates(self):
        self.assertEqual(reason(None), "not_a_string")
        self.assertEqual(reason(b"Zq7!kLm2pXw9"), "not_a_string")
        self.assertEqual(reason("Zq7!kLm2pX\ud800w9"), "not_utf8")

    def test_login_not_contained(self):
        self.assertEqual(reason("xxAliCExx-Zq7!9", "alice"), "contains_login")
        self.assertIsNone(reason("Zq7!kLm2pXw9", "alice"))
        self.assertIsNone(reason("Zq7!kLm2pXw9", ""))
        self.assertIsNone(reason("Zq7!kLm2pXw9", None))

    def test_common_passwords(self):
        for pw in ("Password1234!", "password123456", "qwertyuiop123",
                   "123456789012", "iloveyou12345", "  ", "aaaaaaaaaaaaaaaa",
                   "P@ssw0rd12345", "1234password", "ADMINISTRATOR99"):
            self.assertIn(reason(pw), ("common", "too_short"), pw)
        self.assertEqual(reason("Password1234!"), "common")
        self.assertEqual(reason("qwertyuiop123"), "common")
        self.assertEqual(reason("aaaaaaaaaaaaaaaa"), "common")

    def test_deny_list_size_and_shape(self):
        self.assertGreaterEqual(len(P.COMMON_PASSWORDS), 190)
        self.assertIsInstance(P.COMMON_PASSWORDS, tuple)
        self.assertEqual(list(P.COMMON_PASSWORDS), sorted(set(P.COMMON_PASSWORDS)))
        self.assertTrue(all(p == p.lower() for p in P.COMMON_PASSWORDS))

    def test_character_classes(self):
        self.assertEqual(reason("mxqvzjwkpdhn"), "weak")               # 1 class
        self.assertEqual(reason("mxqvzjwkpdh1"), "weak")               # 2 classes
        self.assertIsNone(reason("mxqvzjwkpdH1"))                      # 3 classes
        self.assertEqual(reason("mxqvzjw kpdh"), "weak")               # lower+other
        # >= 16 characters: any classes
        self.assertIsNone(reason("zxqvwjkmzxqvwjkm"))
        self.assertEqual(reason("zxqvwjkmzxqvwjk"), "weak")            # 15 chars

    def test_error_dict_has_no_password(self):
        try:
            P.validate_password("Password1234!", "alice")
        except ApiError as e:
            self.assertNotIn("Password1234", str(e.as_dict()))
            self.assertNotIn("Password1234", repr(e))


class GenerationTests(unittest.TestCase):
    def test_shape(self):
        for _ in range(200):
            pw = P.generate_password()
            self.assertEqual(len(pw), 20)
            self.assertTrue(pw.isascii())
            self.assertRegex(pw, r"^[A-Za-z0-9]+$")
            self.assertFalse(set(pw) & set("0OoIl1"))
            self.assertTrue(set(pw) <= set(P.GENERATED_ALPHABET))
            self.assertRegex(pw, r"[a-z]")
            self.assertRegex(pw, r"[A-Z]")
            self.assertRegex(pw, r"[0-9]")

    def test_generated_pass_validation(self):
        for _ in range(100):
            self.assertIsNone(reason(P.generate_password(), "alice"))

    def test_unique_and_alphabet(self):
        self.assertEqual(len(P.GENERATED_ALPHABET), 56)
        self.assertEqual(len({P.generate_password() for _ in range(100)}), 100)

    def test_length_floor(self):
        self.assertEqual(len(P.generate_password(12)), 12)
        with self.assertRaises(ValueError):
            P.generate_password(11)


class HashingTests(unittest.TestCase):
    def test_hash_and_verify(self):
        h = P.hash_password("Zq7!kLm2pXw9", COST)
        self.assertRegex(h, BCRYPT_HASH_RE.pattern)
        self.assertTrue(h.startswith("$2b$04$"))
        self.assertEqual(P.hash_cost(h), 4)
        self.assertTrue(P.verify_password("Zq7!kLm2pXw9", h))
        self.assertFalse(P.verify_password("Zq7!kLm2pXw8", h))
        self.assertFalse(P.verify_password("", h))
        self.assertNotEqual(h, P.hash_password("Zq7!kLm2pXw9", COST))  # salted

    def test_unicode_password(self):
        h = P.hash_password("p\u00e4ssw\u00f6rd-\u65e5\u672c-1", COST)
        self.assertTrue(P.verify_password("p\u00e4ssw\u00f6rd-\u65e5\u672c-1", h))

    def test_default_cost_is_12(self):
        self.assertEqual(P.DEFAULT_COST, 12)

    def test_over_72_bytes_never_verifies(self):
        pw72 = "A" * 72
        h = P.hash_password(pw72, COST)
        self.assertTrue(P.verify_password(pw72, h))
        self.assertFalse(P.verify_password(pw72 + "B", h))   # bcrypt would accept
        with self.assertRaises(ValueError):
            P.hash_password(pw72 + "B", COST)

    def test_bad_inputs(self):
        h = P.hash_password("Zq7!kLm2pXw9", COST)
        self.assertFalse(P.verify_password("x", "plain"))
        self.assertFalse(P.verify_password("x", None))
        self.assertFalse(P.verify_password(None, h))
        self.assertFalse(P.verify_password("x", h[:-1]))
        self.assertFalse(P.verify_password("a\ud800", h))
        for cost in (3, 17):
            with self.assertRaises(ValueError):
                P.hash_password("Zq7!kLm2pXw9", cost)
        with self.assertRaises(ValueError):
            P.hash_cost("nope")

    def test_unexpected_library_output_refused(self):
        with mock.patch.object(P.bcrypt, "hashpw", return_value=b"nope"):
            with self.assertRaises(RuntimeError):
                P.hash_password("Zq7!kLm2pXw9", COST)

    def test_cost_encoded(self):
        h = P.hash_password("Zq7!kLm2pXw9", 5)
        self.assertEqual(P.hash_cost(h), 5)

    def test_constant_time_equals(self):
        self.assertTrue(P.constant_time_equals("abc", "abc"))
        self.assertFalse(P.constant_time_equals("abc", "abd"))
        self.assertFalse(P.constant_time_equals("abc", "abcd"))
        self.assertTrue(P.constant_time_equals("\u00e9", "\u00e9"))

    def test_python_hash_verifies_in_radicale_format(self):
        # Radicale's htpasswd reads $2b$ hashes; the format regexp must agree
        h = P.hash_password("Zq7!kLm2pXw9", COST)
        self.assertIsNotNone(re.fullmatch(r"\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}", h))


if __name__ == "__main__":
    unittest.main()
