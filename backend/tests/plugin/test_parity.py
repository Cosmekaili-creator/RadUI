# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plugin test (m3): the plugin accepts and rejects exactly what the backend's
``rightsfile.check_text`` accepts and rejects.

The plugin must not import the backend, but a test may: the cases below are
rendered with the local helpers of ``support.py`` (properly signed, so only
the targeted flaw can be the reason), judged by ``check_text`` in this process
and by the plugin validator in-process under the Radicale interpreter, and the
two accept/reject decisions must be equal for every case.
"""
import hashlib
import os
import random
import sys
import unittest

from . import support
from .support import (Section, header_line, render, render_body,
                      requires_radicale, run_inproc, standard_sections,
                      trailer_for)

sys.path.insert(0, os.path.join(support.REPO, "backend"))
from radui_admin.rightsfile import check_text  # noqa: E402

GEN = 7
SECS = standard_sections("a" * 32, [("bob", "alice", "cal-aa", "rw")])
GOOD = render(SECS, GEN)
BODY = render_body(SECS, GEN)


def signed(body, gen=GEN):
    """``body`` plus a correct trailer (hash over exactly these bytes)."""
    return body + trailer_for(body, gen)


def with_section(extra, at=3):
    secs = list(SECS)
    secs[at:at] = [extra]
    return render(secs, GEN)


def replace_in_body(old, new, count=1):
    assert old in BODY, old
    return signed(BODY.replace(old, new, count))


def _leading_zero_generation():
    body = BODY.replace(b"generation=7", b"generation=07", 1)
    return body + b"# radui-end generation=07 sha256=%s\n" % (
        hashlib.sha256(body).hexdigest().encode())


def named_cases():
    """(name, bytes, should_be_accepted) for the explicit parity cases."""
    c = [("control-good", GOOD, True),
         ("other-generation", render(SECS, 0), True),
         ("all-letters", with_section(Section("x", "^bob$", "^a$", "RWrwDOil")),
          True),
         ("empty-permissions", with_section(Section("x", "^bob$", "^a$", "")),
          True),
         # section names are case sensitive for configparser: not a duplicate
         ("section-names-differing-in-case",
          with_section(Section("G010-ROOT", ".+", "^$", "R")), True)]
    rej = [
        ("missing-final-newline", GOOD[:-1]),
        ("missing-user-key", replace_in_body(b"user: ^alice$\n", b"", 1)),
        ("missing-user-key-in-grant",
         replace_in_body(b"user: ^bob$\ncollection: ^alice/cal-aa$\n",
                         b"collection: ^alice/cal-aa$\n")),
        ("default-section-with-key",
         signed(header_line(GEN) + b"\n[DEFAULT]\nuser: x\n\n"
                + BODY.split(b"\n", 2)[2])),
        ("default-section-empty",
         signed(header_line(GEN) + b"\n[DEFAULT]\n\n"
                + BODY.split(b"\n", 2)[2])),
        ("default-lowercase-name",
         with_section(Section("default", "^bob$", "^a$", "r"))),
        ("default-uppercase-name",
         with_section(Section("DEFAULT", "^bob$", "^a$", "r"))),
        ("duplicate-letters", with_section(Section("x", "^bob$", "^a$", "rrw"))),
        ("duplicate-letters-same-case-pair",
         with_section(Section("x", "^bob$", "^a$", "RWR"))),
        ("empty-collection-pattern",
         with_section(Section("x", "^bob$", "", "r"))),
        ("empty-user-pattern", with_section(Section("x", "", "^a$", "r"))),
        ("extra-unknown-key",
         render(SECS, GEN, extra_keys={"g010-root": "foo: bar"})),
        ("extra-groups-key",
         render(SECS, GEN, extra_keys={"g010-root": "groups: admins"})),
        ("duplicate-section-names", with_section(SECS[2])),
        ("crlf-line-endings", signed(BODY.replace(b"\n", b"\r\n"))),
        ("crlf-in-whole-file", GOOD.replace(b"\n", b"\r\n")),
        ("bom-before-header", signed(b"\xef\xbb\xbf" + BODY)),
        ("bom-unsigned", b"\xef\xbb\xbf" + GOOD),
        ("non-ascii-in-pattern",
         signed(BODY.replace(b"^alice$", "^alic\u00e9$".encode(), 1))),
        ("non-ascii-in-section-name",
         signed(BODY.replace(b"[g010-root]", "[g010-rööt]".encode(), 1))),
        ("trailing-space-after-trailer", GOOD[:-1] + b" \n"),
        ("trailing-space-no-newline", GOOD + b" "),
        ("blank-line-after-trailer", GOOD + b"\n"),
        ("trailing-crlf", GOOD[:-1] + b"\r\n"),
        ("trailing-tab", GOOD[:-1] + b"\t\n"),
        ("tab-in-value", replace_in_body(b"permissions: R\n",
                                         b"permissions:\tR\n")),
        ("comment-line-in-body", replace_in_body(b"[g010-root]\n",
                                                 b"# note\n[g010-root]\n")),
        ("equals-spelling", replace_in_body(b"user: ^alice$\n",
                                            b"user = ^alice$\n")),
        ("keys-reordered", replace_in_body(
            b"user: .+\ncollection: ^$\n", b"collection: ^$\nuser: .+\n")),
        ("extra-blank-line", replace_in_body(b"\n\n[g010", b"\n\n\n[g010")),
        ("leading-zero-generation", _leading_zero_generation()),
        ("brace-in-pattern",
         with_section(Section("x", "^bob$", "^{user}$", "r"))),
        ("percent-in-pattern",
         with_section(Section("x", "^bob$", "^a%$", "r"))),
        ("bad-regex", with_section(Section("x", "^bob$", "^a(", "r"))),
        ("unknown-letter", with_section(Section("x", "^bob$", "^a$", "rx"))),
        ("bad-section-name", with_section(Section("bad name", "^bob$", "^a$",
                                                  "r"))),
        ("long-section-name", with_section(Section("n" * 101, "^bob$", "^a$",
                                                   "r"))),
        ("deny-with-letters", render(SECS[:-1] + [Section(
            "zzz-deny", ".*", ".*", "r")], GEN)),
        ("deny-not-last", render(SECS + [Section("zzz-more", ".+", "^x$",
                                                 "r")], GEN)),
        ("deny-other-patterns", render(SECS[:-1] + [Section(
            "zzz-deny", ".+", ".*", "")], GEN)),
        ("no-sections", render([], GEN)),
        ("empty", b""), ("whitespace-only", b" \n\n"),
        ("nul-byte", GOOD.replace(b"alice", b"al\x00ce", 1)),
        ("del-char", signed(BODY.replace(b"alice", b"al\x7fce", 1))),
        ("generation-mismatch", BODY + trailer_for(BODY, GEN + 1)),
        ("hash-mismatch", GOOD.replace(b"permissions: rw", b"permissions: RW",
                                       1)),
        ("trailer-uppercase-hash", GOOD.replace(
            GOOD[-65:-1], GOOD[-65:-1].upper())),
    ]
    return c + [(n, d, False) for n, d in rej]


def mutated_cases(count=70, seed=20261113):
    """Deterministic random mutations of the good file. Half are re-signed so
    that the trailer hash is right and only the mutation can matter."""
    rnd = random.Random(seed)
    alphabet = ["{", "}", "%", "\t", "\r", "#", ";", "=", ":", "[", "]",
                "é", " ", "\x00", "(", ")", "r", "w", "D", "x", "\n",
                "zzz-deny", "DEFAULT", "groups", "^", "$", ".*"]
    lines = BODY.decode("ascii").split("\n")
    out = []
    for i in range(count):
        ls = list(lines)
        for _ in range(rnd.choice((1, 1, 2, 3))):
            op = rnd.choice(("delete", "duplicate", "swap", "insert-text",
                             "replace-char", "blank", "truncate-line",
                             "swap-letters", "rename-section"))
            k = rnd.randrange(len(ls))
            if op == "delete":
                del ls[k]
            elif op == "duplicate":
                ls.insert(k, ls[k])
            elif op == "swap":
                j = rnd.randrange(len(ls))
                ls[k], ls[j] = ls[j], ls[k]
            elif op == "insert-text":
                pos = rnd.randrange(len(ls[k]) + 1)
                ls[k] = ls[k][:pos] + rnd.choice(alphabet) + ls[k][pos:]
            elif op == "replace-char" and ls[k]:
                pos = rnd.randrange(len(ls[k]))
                ls[k] = ls[k][:pos] + rnd.choice(alphabet) + ls[k][pos + 1:]
            elif op == "blank":
                ls.insert(k, "")
            elif op == "truncate-line":
                ls[k] = ls[k][:rnd.randrange(len(ls[k]) + 1)]
            elif op == "swap-letters" and ls[k].startswith("permissions: "):
                ls[k] = "permissions: " + "".join(
                    rnd.choice("RWrwDOilxd") for _ in range(rnd.randrange(5)))
            elif op == "rename-section" and ls[k].startswith("["):
                ls[k] = "[" + rnd.choice(
                    ["x", "DEFAULT", "default", "g010-root", "a b", "zzz-deny",
                     "café", ""]) + "]"
        body = "\n".join(ls).encode("utf-8")
        if i % 2 == 0:
            data = signed(body)
        else:
            data = body + trailer_for(BODY, GEN)   # stale hash: mostly rejects
        if i % 10 == 9:
            data = data[:-1]
        out.append(("mutant-%03d" % i, data))
    return out


def plugin_verdicts(cases):
    res = run_inproc("parity", files={
        "cases.json": [data.hex() for _, data, *_ in cases]})
    assert len(res) == len(cases)
    return [r["ok"] for r in res], res


def backend_verdict(data):
    return not check_text(data.decode("latin-1"))


class ParityCatalogue(unittest.TestCase):
    def test_named_cases_are_distinct_and_cover_the_listed_flaws(self):
        names = [n for n, *_ in named_cases()]
        self.assertEqual(len(names), len(set(names)))
        for needed in ("missing-final-newline", "missing-user-key",
                       "default-section-with-key", "duplicate-letters",
                       "empty-collection-pattern", "empty-user-pattern",
                       "extra-unknown-key", "duplicate-section-names",
                       "crlf-line-endings", "bom-before-header",
                       "non-ascii-in-pattern", "trailing-space-after-trailer"):
            self.assertIn(needed, names)

    def test_backend_verdict_on_named_cases_is_the_expected_one(self):
        """Independent of the plugin: the references themselves are right
        (otherwise equal verdicts would prove nothing)."""
        for name, data, accepted in named_cases():
            with self.subTest(case=name):
                self.assertEqual(backend_verdict(data), accepted)


@requires_radicale
class PluginParity(unittest.TestCase):
    def test_m3_named_cases_plugin_equals_backend(self):
        cases = named_cases()
        plug, res = plugin_verdicts(cases)
        for (name, data, accepted), ok, r in zip(cases, plug, res):
            with self.subTest(case=name):
                self.assertEqual(ok, backend_verdict(data),
                                 "plugin and check_text disagree: %s" % r)
                self.assertEqual(ok, accepted, r)

    def test_m3_generated_mutations_plugin_equals_backend(self):
        cases = mutated_cases()
        self.assertGreaterEqual(len(cases), 50)
        plug, res = plugin_verdicts(cases)
        accepted = 0
        for (name, data), ok, r in zip(cases, plug, res):
            with self.subTest(case=name):
                self.assertEqual(ok, backend_verdict(data),
                                 "plugin and check_text disagree: %s" % r)
            accepted += ok
        # the sample must exercise both outcomes, or equality proves little
        self.assertGreater(len(cases) - accepted, 20)
        self.assertGreater(accepted, 0)

    def test_m3_exhaustive_single_line_deletions(self):
        """Every single-line deletion of the good body, re-signed."""
        lines = BODY.split(b"\n")
        cases = []
        for k in range(len(lines) - 1):
            cases.append(("del-%02d" % k,
                          signed(b"\n".join(lines[:k] + lines[k + 1:]))))
        plug, res = plugin_verdicts(cases)
        for (name, data), ok, r in zip(cases, plug, res):
            with self.subTest(case=name):
                self.assertEqual(ok, backend_verdict(data), r)


if __name__ == "__main__":
    unittest.main()
