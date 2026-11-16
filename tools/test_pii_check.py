# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for tools/pii-check.py (run with python3 -m unittest)."""
import contextlib
import importlib.util
import io
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "pii_check", os.path.join(HERE, "pii-check.py"))
pii = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pii)


def write(root, files):
    for rel, content in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(path, mode) as fh:
            fh.write(content)


def run(root, *extra):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        code = pii.main(["--root", root] + list(extra))
    return code, out.getvalue()


class GenericChecks(unittest.TestCase):
    def check(self, line, expect_fail, needle=None):
        with tempfile.TemporaryDirectory() as root:
            write(root, {"tests/fixtures/vcf/a.vcf": line + "\n"})
            code, out = run(root)
            self.assertEqual(code, 1 if expect_fail else 0, out)
            if needle:
                self.assertIn(needle, out)

    def test_example_emails_ok(self):
        self.check("EMAIL:alice@example.org", False)
        self.check("EMAIL:bob@example.com", False)

    def test_real_looking_email_flagged(self):
        self.check("EMAIL:" + "jane" + "@" + "mail" + ".test.io", True, "a.vcf:1")

    def test_reserved_phone_ranges_ok(self):
        self.check("TEL:+1-555-0123", False)
        self.check("TEL:(212) 555-0142", False)
        self.check("TEL:555-0100", False)  # 7 digits: below the phone threshold
        self.check("TEL:+1 555 555 0199", False)
        self.check("TEL:+44 20 7946 0123", False)
        self.check("TEL:+44 (0)20 7946 0999", False)

    def test_other_phones_flagged(self):
        self.check("TEL:+41 79 123 45 67", True, "phone")
        self.check("TEL:+44 20 7123 4567", True, "phone")
        self.check("TEL:555-0200 ext 5-1234567", True)

    def test_dates_and_timestamps_not_phones(self):
        self.check("DTSTART:20261112T093000Z", False)
        self.check("DESCRIPTION:due 2026-11-12 and id 12345678", False)
        self.check("UID:1234-5678-9012-3456", False)

    def test_gps(self):
        self.check("GEO:12.34;56.78", False)
        self.check("GEO:12.3456;-56.7890", True, "GPS")
        self.check("GEO:geo:48.8584,2.2945", True, "GPS")

    def test_generic_checks_limited_to_fixture_like_dirs(self):
        with tempfile.TemporaryDirectory() as root:
            write(root, {"src/a.js": "// " + "jane" + "@" + "mail" + ".test.io\n"})
            self.assertEqual(run(root)[0], 0)


class DenyList(unittest.TestCase):
    SNAPSHOT = {
        "u/cal/one.ics": (
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Vendorzz//EN\r\n"
            "BEGIN:VEVENT\r\nUID:abc-123\r\nSUMMARY:Lunch with Zyxwvut and Quuxplan\r\n"
            "DESCRIPTION:Call +41 79 123 45\r\n 67 about the Descwordz\r\n"
            "ATTENDEE;CN=Plugh Xyzzy:mailto:plugh.xyzzy" "@corp.invalid\r\n"
            "TZID:Europe/Paris\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"),
        "u/book/two.vcf": ("BEGIN:VCARD\r\nFN:Frobnicate Gamma\r\nitem1.ADR:;;1 Waldo Street;Fredville;;1000;Suisse\r\n"
                           "TITLE:Titleword\r\nNICKNAME:Nickzz,Quux\r\nEND:VCARD\r\n"),
        "u/ignored.txt": "SUMMARY:Notparsed\n",
    }

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.snap = os.path.join(self.tmp.name, "snap")
        self.tree = os.path.join(self.tmp.name, "tree")
        write(self.snap, self.SNAPSHOT)
        os.makedirs(self.tree)

    def test_denylist_contents(self):
        words, emails, phones = pii.build_denylist(self.snap)
        for w in ("zyxwvut", "quuxplan", "plugh", "xyzzy", "frobnicate", "gamma", "waldo", "fredville", "nickzz"):
            self.assertIn(w, words)
        for generic in ("vcalendar", "vevent", "summary", "vendorzz", "europe", "paris", "notparsed"):
            self.assertNotIn(generic, words)
        # only name-bearing properties feed the word list; common vocabulary and short words are out
        for other in ("descwordz", "titleword", "lunch", "street", "suisse", "quux", "with", "call", "walking", "outside"):
            self.assertNotIn(other, words)
        self.assertIn("plugh.xyzzy" "@corp.invalid", emails)
        self.assertIn("41791234567", phones)

    def test_clean_tree_passes_and_generic_words_are_fine(self):
        write(self.tree, {"tests/fixtures/ics/ok.ics":
                          "BEGIN:VCALENDAR\nSUMMARY:Planning session\nEND:VCALENDAR\n"})
        code, out = run(self.tree, "--snapshot", self.snap)
        self.assertEqual(code, 0, out)

    def test_word_match_anywhere_in_tree_and_masked(self):
        write(self.tree, {"docs/x.md": "hello\nthanks Frobnicate!\n",
                          "src/a.js": "// quuxplan\n"})
        code, out = run(self.tree, "--snapshot", self.snap)
        self.assertEqual(code, 1)
        self.assertIn("docs/x.md:2:", out)
        self.assertIn("src/a.js:1:", out)
        self.assertNotIn("robnicate", out)  # never echoed
        self.assertNotIn("uuxplan", out)

    def test_email_and_phone_match(self):
        write(self.tree, {"tests/fixtures/vcf/a.vcf":
                          "EMAIL:Plugh.Xyzzy" "@Corp.Invalid\nTEL:+41 (79) 123-45-67\n"})
        code, out = run(self.tree, "--snapshot", self.snap)
        self.assertEqual(code, 1)
        self.assertIn("a.vcf:1:", out)
        self.assertIn("a.vcf:2:", out)

    def test_frequent_word_is_vocabulary_outside_fixtures_only(self):
        write(self.tree, {"src/a.js": "// frobnicate\n" * 5, "src/b.js": "// quuxplan\n"})
        code, out = run(self.tree, "--snapshot", self.snap)
        self.assertEqual(code, 1)
        self.assertNotIn("src/a.js", out)       # 5 lines: ordinary vocabulary
        self.assertIn("src/b.js:1:", out)       # 1 line: still a finding
        self.assertIn("1 frequent word", out)
        write(self.tree, {"tests/fixtures/ics/f.ics": "SUMMARY:Frobnicate\n"})
        code, out = run(self.tree, "--snapshot", self.snap)
        self.assertIn("tests/fixtures/ics/f.ics:1:", out)  # never exempt in fixtures

    def test_substring_of_larger_word_is_not_a_match(self):
        write(self.tree, {"a.txt": "frobnicates and gammaray\n"})
        self.assertEqual(run(self.tree, "--snapshot", self.snap)[0], 0)

    def test_allow_option_and_vendor_skip(self):
        write(self.tree, {"a.txt": "gamma\n", "src/vendor/v.js": "frobnicate\n"})
        code, _ = run(self.tree, "--snapshot", self.snap, "--allow", "gamma")
        self.assertEqual(code, 0)

    def test_missing_snapshot_dir_is_an_error(self):
        code, _ = run(self.tree, "--snapshot", os.path.join(self.tmp.name, "nope"))
        self.assertEqual(code, 2)

    def test_empty_snapshot_is_an_error(self):
        empty = os.path.join(self.tmp.name, "empty")
        os.makedirs(os.path.join(empty, "sub"))
        code, _ = run(self.tree, "--snapshot", empty)
        self.assertEqual(code, 2)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads everything")
    def test_unreadable_snapshot_dir_is_an_error(self):
        sub = os.path.join(self.snap, "locked")
        os.makedirs(sub)
        with open(os.path.join(sub, "x.vcf"), "w") as fh:
            fh.write("BEGIN:VCARD\nEND:VCARD\n")
        os.chmod(sub, 0)
        self.addCleanup(os.chmod, sub, 0o700)
        code, _ = run(self.tree, "--snapshot", self.snap)
        self.assertEqual(code, 2)

    def test_without_snapshot_only_generic(self):
        write(self.tree, {"a.txt": "frobnicate\n"})
        code, out = run(self.tree)
        self.assertEqual(code, 0)
        self.assertIn("generic checks only", out)


if __name__ == "__main__":
    unittest.main()
