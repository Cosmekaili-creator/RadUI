# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests of tools/sanitize-fixture.py (run by `make test` through unittest discovery)."""
import importlib.util
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "tests", "fixtures")


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    sys.path.insert(0, HERE)
    spec.loader.exec_module(mod)
    return mod


san = load("sanitize_fixture", "sanitize-fixture.py")
pii = load("pii_check_mod", "pii-check.py")


def fixtures():
    for d in ("ics", "vcf"):
        for f in sorted(os.listdir(os.path.join(FIXTURES, d))):
            if f.endswith("." + d):
                with open(os.path.join(FIXTURES, d, f), "r", encoding="utf-8", newline="") as fh:
                    yield "%s/%s" % (d, f), fh.read()


def physical(text):
    return [ln for ln in re.split(r"\r\n|\r|\n", text)]


def skeleton(text):
    """Property structure: (group, name, parameter names, quoting form) per logical line."""
    out = []
    for ln in re.sub(r"(\r\n|\r|\n)[ \t]", "", text).splitlines():
        p = san.split_line(ln)
        if p is None:
            out.append(("?",))
            continue
        group, name, params, _ = p
        out.append((group, name, tuple((t.split("=")[0], '"' in t) for t in params)))
    return out


FREE = ("SUMMARY", "DESCRIPTION", "LOCATION", "NOTE", "FN", "COMMENT")


def values_of(text):
    out = []
    for ln in re.sub(r"(\r\n|\r|\n)[ \t]", "", text).splitlines():
        p = san.split_line(ln)
        if p and p[1].upper() in FREE:
            out.append(p[3])
    return " ".join(out)


def words(text):
    return {w.lower() for w in re.findall(r"[^\W\d_]{6,}", text)}


ORIGINAL_ONLY_STRUCTURE = set("""
example corp calendar contacts address device vendor reminder default mozilla sample
""".split())


class SanitizeTests(unittest.TestCase):
    def test_deterministic_and_salt_dependent(self):
        text = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Zebulon Thornberry\r\nEND:VCARD\r\n"
        a = san.sanitize_text(text, "s1")
        self.assertEqual(a, san.sanitize_text(text, "s1"))
        self.assertNotEqual(a, san.sanitize_text(text, "s2"))
        self.assertNotIn("Zebulon", a)

    def test_structure_and_line_layout_preserved_on_every_fixture(self):
        n = 0
        for name, text in fixtures():
            out = san.sanitize_text(text)
            self.assertEqual(skeleton(text), skeleton(out), name)
            a, b = physical(text), physical(out)
            self.assertEqual(len(a), len(b), name + ": number of physical lines")
            self.assertEqual(text.endswith(("\n", "\r")), out.endswith(("\n", "\r")), name)
            self.assertEqual("\r\n" in text, "\r\n" in out, name)
            for x, y in zip(a, b):
                self.assertEqual(len(x.encode()), len(y.encode()), "%s: octet length of a physical line" % name)
                self.assertEqual(x[:1] in (" ", "\t"), y[:1] in (" ", "\t"), name)
            n += 1
        self.assertGreater(n, 80)

    def test_values_are_replaced_but_names_and_zones_stay(self):
        src = {n: t for n, t in fixtures()}
        out = san.sanitize_text(src["ics/event-vendor-sync.ics"])
        for keep in ("X-EXAMPLE-SYNC-ID", "X-EXAMPLE-SYNC-FLAGS;X-VERSION=2", "TZID=Europe/Paris", "ROLE=REQ-PARTICIPANT", "RESOURCES:"):
            self.assertIn(keep, out)
        self.assertNotIn("Sync-adapter shaped meeting", out)
        self.assertNotIn("Alice Example", out)
        self.assertNotIn("bob@example.org", out)
        self.assertNotIn("7788", out)
        card = san.sanitize_text(src["vcf/vcard30-vendor-device.vcf"])
        self.assertIn("X-SOCIALPROFILE;type=example;x-user=", card)
        self.assertNotIn("dora", card.lower().replace("x-user=", ""))

    def test_free_text_words_do_not_survive(self):
        for name, text in fixtures():
            out = san.sanitize_text(text)
            survivors = (words(values_of(text)) & words(values_of(out))) - ORIGINAL_ONLY_STRUCTURE
            self.assertFalse(survivors, "%s: %s" % (name, sorted(survivors)[:3]))

    def test_references_stay_consistent(self):
        src = {n: t for n, t in fixtures()}
        child = san.sanitize_text(src["ics/todo-related-to-child.ics"])
        parent = san.sanitize_text(src["ics/todo-related-to-parent.ics"])
        ref = re.search(r"^RELATED-TO:(.*)$", child, re.M).group(1).strip()
        uid = re.search(r"^UID:(.*)$", parent, re.M).group(1).strip()
        self.assertEqual(ref, uid)
        g = san.sanitize_text(src["vcf/vcard40-group-kind.vcf"])
        m = san.sanitize_text(src["vcf/vcard30-basic.vcf"])
        self.assertEqual(len(re.findall(r"^MEMBER:urn:uuid:", g, re.M)), 2)

    def test_output_passes_the_generic_pii_rules(self):
        real = (
            "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:urn:uuid:5f0e9d3a-1c2b-4d5e-8f60-0123456789ab\r\n"
            "FN:Zebulon Thornberry\r\nN:Thornberry;Zebulon;;;\r\nORG:Acme Holdings\\, Inc.;Sales\r\n"
            "EMAIL;TYPE=INTERNET:zebulon.thornberry@" "gmail.com\r\nTEL;TYPE=CELL:+41 79 123 45 67\r\n"
            "ADR;TYPE=HOME:;;12 Rue Lafayette;Lausanne;VD;1003;Switzerland\r\n"
            "item1.URL:https://www.thornberry-family.example.net/about\r\nitem1.X-ABLabel:_$!<HomePage>!$_\r\n"
            "BDAY:1979-03-14\r\nX-SOCIALPROFILE;type=twitter;x-user=zthorn:https://twitter.com/zthorn\r\n"
            "X-PRIVATE-FIELD:secret value here\r\nGEO:46.519653;6.632273\r\nEND:VCARD\r\n"
        )
        out = san.sanitize_text(real)
        for leak in ("Zebulon", "Thornberry", "Acme", "gmail", "41 79", "Lafayette", "Lausanne", "Switzerland", "1979", "twitter.com", "zthorn", "secret", "46.519653"):
            self.assertNotIn(leak.lower(), out.lower(), leak)
        self.assertEqual(pii.generic_findings("x.vcf", out), [])
        for keep in ("X-PRIVATE-FIELD:", "item1.X-ABLabel:_$!<HomePage>!$_", "TEL;TYPE=CELL:", "ORG:"):
            self.assertIn(keep, out)

    def test_cli_writes_files_and_directories(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.ics")
            with open(src, "w", newline="") as fh:
                fh.write("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n")
            self.assertEqual(san.main([src, "-o", os.path.join(d, "out.ics")]), 0)
            self.assertTrue(os.path.exists(os.path.join(d, "out.ics")))
            os.mkdir(os.path.join(d, "o"))
            self.assertEqual(san.main([src, "-o", os.path.join(d, "o")]), 0)
            self.assertTrue(os.path.exists(os.path.join(d, "o", "a.ics")))


if __name__ == "__main__":
    unittest.main()
