# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for tools/hardcode-check.py (run with python3 -m unittest)."""
import contextlib
import importlib.util
import io
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "hardcode_check", os.path.join(HERE, "hardcode-check.py"))
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)


def dot(*parts):
    return ".".join(str(p) for p in parts)


class Tree:
    """A temp tree; violating literals are assembled at run time so that this
    test file itself passes the checker."""

    def __init__(self, files, tokens=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        for rel, content in files.items():
            path = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            mode = "wb" if isinstance(content, bytes) else "w"
            with open(path, mode) as fh:
                fh.write(content)
        self.token_file = None
        if tokens is not None:
            self.token_file = os.path.join(self.root, "tokens.txt")
            with open(self.token_file, "w") as fh:
                fh.write("\n".join(tokens) + "\n")

    def run(self):
        out, err = io.StringIO(), io.StringIO()
        argv = ["--root", self.root]
        if self.token_file:
            argv += ["--tokens", self.token_file]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = hc.main(argv)
        return code, out.getvalue(), err.getvalue()

    def close(self):
        self.tmp.cleanup()


class HardcodeCheckTests(unittest.TestCase):
    def check(self, files, tokens=(), expect_fail=True, needle=None):
        tree = Tree(files, list(tokens))
        self.addCleanup(tree.close)
        code, out, _ = tree.run()
        self.assertEqual(code, 1 if expect_fail else 0, out)
        if needle:
            self.assertIn(needle, out)
        return out

    def test_clean_tree_passes(self):
        self.check({"a.txt": "nothing here\n", "b/c.py": "x = 1\n"}, expect_fail=False)

    def test_ipv4_flagged_with_location(self):
        out = self.check({"a.txt": "ok\nhost " + dot(10, 1, 2, 3) + " here\n"},
                         needle="a.txt:2:")
        self.assertIn("IPv4", out)

    def test_ipv4_allowed_ranges(self):
        allowed = [dot(127, 0, 0, 1), dot(0, 0, 0, 0), dot(192, 0, 2, 7),
                   dot(198, 51, 100, 9), dot(203, 0, 113, 200)]
        self.check({"a.txt": "\n".join(allowed) + "\n"}, expect_fail=False)

    def test_other_loopback_and_private_flagged(self):
        self.check({"a.txt": dot(127, 0, 0, 2) + "\n"})
        self.check({"a.txt": dot(192, 168, 0, 1) + "\n"})

    def test_version_numbers_and_bad_octets_not_flagged(self):
        self.check({"a.txt": "version " + dot(1, 2, 3) + " and " + dot(300, 1, 1, 1) + "\n"
                    + "five " + dot(1, 2, 3, 4, 5) + "\n"}, expect_fail=False)

    def test_non_ascii_digit_address_is_reported_not_crashing(self):
        # fullwidth digits: int() accepts them, ipaddress does not
        self.check({"a.txt": "host \uff11.2.3.4 here\n"}, needle="a.txt:1:")

    def test_ipv6(self):
        self.check({"a.txt": "bind ::1\n"}, expect_fail=False)
        self.check({"a.txt": "doc 2001:db8::5 and 2001:0db8:85a3::1\n"}, expect_fail=False)
        self.check({"a.txt": "a = x[::2]\n"}, expect_fail=False)
        self.check({"a.txt": "addr " + "fe80" + "::1" + "\n"}, needle="IPv6")
        self.check({"a.txt": "addr " + ":".join(["2606", "4700", "4700"]) + ":" + ":1111" + "\n"}, needle="IPv6")

    def test_email(self):
        self.check({"a.txt": "mail alice@example.org bob@example.com c@example.net "
                    "d@sub.example.org\n"}, expect_fail=False)
        self.check({"a.txt": "mail " + "someone" + "@" + "mail." + "test.io" + "\n"},
                   needle="e-mail")
        self.check({"a.txt": "@property and pkg@1.2.3 are fine\n"}, expect_fail=False)

    def test_home_paths(self):
        self.check({"a.md": "see " + "/ho" + "me/" + "bob/x\n"}, needle="home path")
        self.check({"a.md": "see " + "/Us" + "ers/" + "bob/x\n"}, needle="home path")
        self.check({"a.md": "~/x and /var/lib/radui and /etc/radui\n"}, expect_fail=False)

    def test_inline_marker_allows_generic_rules(self):
        line = "see " + "/ho" + "me/" + "bob/x  hardcode-ok\n"
        self.check({"a.md": line}, expect_fail=False)
        self.check({"a.md": "x " + dot(10, 1, 2, 3) + " hardcode-ok\n"}, expect_fail=False)

    def test_forbidden_tokens_case_insensitive_substring(self):
        out = self.check({"a.txt": "this mentions Zq" + "Token" + "Corp somewhere\n"},
                         tokens=["zqtokencorp"], needle="a.txt:1:")
        self.assertNotIn("zqtokencorp", out.lower())  # token never echoed

    def test_forbidden_token_in_file_name(self):
        self.check({"zqtokencorp-notes.txt": "clean\n"}, tokens=["zqtokencorp"],
                   needle="file name")

    def test_marker_does_not_exempt_tokens(self):
        self.check({"a.txt": "zqtokencorp hardcode-ok\n"}, tokens=["zqtokencorp"])

    def _identity(self, mapping):
        saved = hc.PUBLIC_IDENTITY
        hc.PUBLIC_IDENTITY = mapping
        self.addCleanup(setattr, hc, "PUBLIC_IDENTITY", saved)

    def test_public_identity_exact_strings_allowed_in_readme_only(self):
        import re
        self._identity({"README.md": (re.compile(r"Zq" + "Token Corp"),
                                      re.compile(r"https://www\.zq" + r"tokencorp\.example(?![\w./:@-])"))})
        line = "Maintained by Zq" + "Token Corp (https://www.zq" + "tokencorp.example).\n"
        # (the temp token file itself lies in the tree, so only README.md's lines are judged)
        out = self.check({"README.md": line}, tokens=["zqtokencorp", "zqtoken corp"])
        self.assertNotIn("README.md", out)
        # same text in another file is still a finding
        self.assertIn("docs/a.md:1:", self.check({"docs/a.md": line}, tokens=["zqtokencorp", "zqtoken corp"]))
        # another host or a path under the allowed site is still a finding in README.md
        self.assertIn("README.md:1:", self.check({"README.md": "see https://rd.zq" + "tokencorp.example\n"}, tokens=["zqtokencorp"]))
        self.assertIn("README.md:1:", self.check({"README.md": "see https://www.zq" + "tokencorp.example/x\n"}, tokens=["zqtokencorp"]))
        # case matters: the exception is exact
        self.assertIn("README.md:1:", self.check({"README.md": "zq" + "token corp\n"}, tokens=["zqtoken corp"]))

    def test_public_identity_is_limited_to_readme(self):
        self.assertEqual(set(hc.PUBLIC_IDENTITY), {"README.md"})

    def test_missing_token_file_warns_but_runs(self):
        tree = Tree({"a.txt": "fine\n"})
        self.addCleanup(tree.close)
        code, out, err = tree.run()
        self.assertEqual(code, 0)
        self.assertIn("warning", err)

    def test_skips_itself_binary_and_vendor_generic(self):
        bad = dot(10, 1, 2, 3)
        files = {
            "tools/hardcode-check.py": bad + "\n",
            "blob.bin": b"\0\1" + bad.encode() + b"\n",
            "src/vendor/lib/x.js": bad + " a" + "@" + "b.test.io\n",
        }
        self.check(files, expect_fail=False)

    def test_forbidden_tokens_apply_to_vendor_and_fixtures(self):
        self.check({"src/vendor/x.js": "zqtokencorp\n"}, tokens=["zqtokencorp"],
                   needle="src/vendor/x.js:1")
        self.check({"tests/fixtures/ics/x.ics": "zqtokencorp\n"}, tokens=["zqtokencorp"],
                   needle="tests/fixtures/ics/x.ics:1")

    def test_fixtures_are_not_exempt_from_generic_rules(self):
        bad = dot(10, 1, 2, 3)
        self.check({"tests/fixtures/ics/x.ics": bad + "\n"},
                   needle="tests/fixtures/ics/x.ics:1")
        self.check({"tests/fixtures/ics/x.ics": "a" + "@" + "b.test.io\n"},
                   needle="e-mail")
        self.check({"tests/fixtures/ics/x.ics": "/ho" + "me/" + "bob\n"},
                   needle="home path")
        self.check({"tests/fixtures/ics/x.ics":
                    "ORGANIZER:mailto:alice@example.org " + dot(192, 0, 2, 1) + "\n"},
                   expect_fail=False)

    def test_vendor_dir_anywhere_is_exempt(self):
        bad = dot(10, 1, 2, 3)
        self.check({"src/vendor/ical/x.js": bad + "\n",
                    "third/vendor/y.js": bad + "\n"}, expect_fail=False)

    def test_explicit_allowlist_entry_is_exempt(self):
        bad = dot(10, 1, 2, 3)
        files = {"tests/fixtures/big/corpus.ics": bad + "\n",
                 "tests/fixtures/big/other.ics": bad + "\n"}
        saved = hc.GENERIC_ALLOWLIST
        hc.GENERIC_ALLOWLIST = ("tests/fixtures/big/corpus.ics",)
        try:
            out = self.check(files, needle="other.ics:1")
            self.assertNotIn("corpus.ics", out)
        finally:
            hc.GENERIC_ALLOWLIST = saved

    def test_zero_padded_ipv4_is_reported_not_a_crash(self):
        out = self.check({"a.txt": "host " + dot("010", 1, 1, 1) + " x\n"},
                         needle="a.txt:1:")
        self.assertIn("zero-padded", out)
        self.check({"a.txt": dot(1, 1, 1, "001") + "\n"}, needle="zero-padded")
        self.check({"a.txt": dot("000", 0, 0, 0) + "\n"}, needle="zero-padded")
        # a plain zero octet is a normal address, not padded
        self.check({"a.txt": dot(0, 0, 0, 0) + "\n"}, expect_fail=False)

    def test_gitignore_fallback_walk(self):
        files = {".gitignore": "secret.txt\nbuild/\n*.log\n",
                 "secret.txt": dot(10, 1, 2, 3) + "\n",
                 "build/o.txt": dot(10, 1, 2, 3) + "\n",
                 "x.log": dot(10, 1, 2, 3) + "\n",
                 "ok.txt": "fine\n"}
        self.check(files, expect_fail=False)
        files["keep.txt"] = dot(10, 1, 2, 3) + "\n"
        self.check(files, needle="keep.txt:1")


if __name__ == "__main__":
    unittest.main()
