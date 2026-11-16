# SPDX-License-Identifier: AGPL-3.0-or-later
"""rightsfile.py: rendering and every D2 rejection rule."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402
from helpers import MATCHER, case_models  # noqa: E402
from radui_admin import generator, rightsfile as R  # noqa: E402
from radui_admin.rightsfile import Section, check_text, error_codes, render  # noqa: E402

DENY = Section("zzz-deny", ".*", ".*", "")
GOOD = [Section("g010-root", ".+", "^$", "R"),
        Section("s0001-x", "^alice$", "^alice$", "RW"), DENY]


def forge(body_lines, generation=3, trailer_gen=None, digest=None):
    """Build a text with a correct (or overridden) trailer from raw lines."""
    body = "\n".join(body_lines) + "\n"
    h = R.sha256_hex(body) if digest is None else digest
    tg = generation if trailer_gen is None else trailer_gen
    return "%s# radui-end generation=%s sha256=%s\n" % (body, tg, h)


def lines(sections=GOOD, generation=3):
    out = ["%s%d" % (R.HEADER_PREFIX, generation), ""]
    for s in sections:
        out += ["[%s]" % s.name, "user: %s" % s.user,
                "collection: %s" % s.collection,
                "permissions: %s" % s.permissions, ""]
    return out


class RenderTests(unittest.TestCase):
    def test_render_good_and_checker_accepts(self):
        text = render(GOOD, 3)
        self.assertEqual(check_text(text), [])
        self.assertTrue(text.startswith(
            "# radui-admin generated; DO NOT EDIT. generation=3\n\n[g010-root]\n"))
        trailer = text.rstrip("\n").rsplit("\n", 1)[1]
        body = text[:text.rindex("# radui-end")]
        self.assertEqual(trailer, "# radui-end generation=3 sha256=%s"
                         % R.sha256_hex(body))
        self.assertEqual(R.parse_sections(text), GOOD)

    def test_render_refuses_unsafe_input(self):
        bad_sections = [
            GOOD[:-1] + [Section("zzz-deny", ".*", ".*", "r")],
            GOOD[:-1],                                       # no deny last
            [GOOD[0], Section("s1", "^a{0}$", "^x$", "r"), DENY],
            [GOOD[0], Section("s1", "^a$", "^50%$", "r"), DENY],
            [GOOD[0], Section("s1", "^a$", "^x$", "rwd"), DENY],
            [GOOD[0], Section("s1", "^a$", "^x\n$", "r"), DENY],
            [GOOD[0], Section("s1", "^a$", "^caf\u00e9$", "r"), DENY],
            [GOOD[0], Section("s1", "^(a$", "^x$", "r"), DENY],
            [GOOD[0], Section("s 1", "^a$", "^x$", "r"), DENY],
            [GOOD[0], Section("DEFAULT", "^a$", "^x$", "r"), DENY],
            [GOOD[0], GOOD[0], DENY],                        # duplicate name
            [],
        ]
        for secs in bad_sections:
            with self.assertRaises(ValueError, msg=repr(secs)):
                render(secs, 1)

    def test_render_refuses_bad_generation(self):
        for g in (-1, "3", True, None):
            with self.assertRaises(ValueError):
                render(GOOD, g)

    def test_render_round_trip_guard(self):
        # normally check_text already fails first; force the second guard
        with mock.patch.object(R, "parse_sections", return_value=[]), \
                mock.patch.object(R, "check_text", return_value=[]):
            with self.assertRaises(ValueError):
                render(GOOD, 3)

    def test_render_refuses_non_string_fields(self):
        with self.assertRaises(ValueError):
            render([Section("a", None, "x", "r"), DENY], 1)


class CheckTests(unittest.TestCase):
    def codes(self, text):
        return error_codes(check_text(text))

    def test_generated_files_accepted(self):
        for model in case_models().values():
            self.assertEqual(check_text(generator.generate(model)[0]), [])

    def test_empty_and_non_text(self):
        for v in ("", "   \n", None, b"x", 5):
            self.assertEqual(self.codes(v), ["empty"])

    def test_non_ascii_and_control(self):
        good = render(GOOD, 3)
        self.assertEqual(self.codes(good.replace("alice", "al\u00efce", 1)),
                         ["non_ascii"])
        self.assertEqual(self.codes(good.replace("\n", "\r\n")),
                         ["control_chars"])
        self.assertEqual(self.codes(good.replace("[g010", "\x00[g010", 1)),
                         ["control_chars"])
        self.assertEqual(self.codes(good.replace("[g010", "\x7f[g010", 1)),
                         ["control_chars"])
        self.assertEqual(self.codes(good.replace("[g010", "\t[g010", 1)),
                         ["control_chars"])

    def test_no_final_newline_or_extra_blank(self):
        good = render(GOOD, 3)
        self.assertEqual(self.codes(good.rstrip("\n")), ["bad_trailer"])
        self.assertEqual(self.codes(good + "\n"), ["bad_trailer"])
        self.assertEqual(self.codes("# only one line\n"), ["bad_trailer"])

    def test_bad_header_and_trailer(self):
        good = render(GOOD, 3)
        self.assertEqual(self.codes(good.replace("generated;", "generated:", 1)),
                         ["bad_header"])
        no_header = good.split("\n", 1)[1]
        self.assertIn("bad_header", self.codes(no_header))
        self.assertEqual(self.codes(good.replace("radui-end", "radui-fin")),
                         ["bad_trailer"])
        self.assertEqual(self.codes(good.replace("sha256=", "sha256=Z")),
                         ["bad_trailer"])
        self.assertEqual(self.codes(good.replace("generation=3", "generation=03", 1)),
                         ["bad_header"])
        self.assertEqual(sorted(self.codes(good.replace("generation=3", "x", 1)
                                           .replace("radui-end generation=3", "radui-end x"))),
                         ["bad_header", "bad_trailer"])

    def test_generation_mismatch(self):
        text = forge(lines(generation=3), trailer_gen=4)
        self.assertEqual(self.codes(text), ["generation_mismatch"])

    def test_hash_mismatch_flipped_byte(self):
        good = render(GOOD, 3)
        body_end = good.rindex("# radui-end")
        for i in range(0, body_end, 7):
            flipped = good[:i] + ("b" if good[i] != "b" else "c") + good[i + 1:]
            self.assertTrue(self.codes(flipped), "flip at %d accepted" % i)
        text = good.replace("RW", "RWr", 1)
        self.assertEqual(self.codes(text), ["hash_mismatch"])

    def test_hash_flip_in_trailer(self):
        good = render(GOOD, 3)
        flipped = good[:-3] + ("0" if good[-3] != "0" else "1") + good[-2:]
        self.assertEqual(self.codes(flipped), ["hash_mismatch"])

    def test_truncation_at_every_section_boundary(self):
        good = render(GOOD, 3)
        body = good[:good.rindex("# radui-end")]
        trailer = good[len(body):]
        marks = [i + 1 for i, c in enumerate(body) if c == "\n"]
        self.assertGreater(len(marks), 8)
        for cut in marks[:-1]:
            truncated = body[:cut] + trailer          # old trailer, shorter body
            self.assertIn("hash_mismatch", self.codes(truncated), cut)
            self.assertTrue(self.codes(body[:cut]), cut)     # trailer gone
        # even a re-hashed truncation that drops [zzz-deny] is refused
        cut = body.index("[zzz-deny]")
        text = forge(body[:cut].rstrip("\n").split("\n") + [""])
        self.assertIn("last_section_not_deny", self.codes(text))

    def test_header_only_is_not_a_valid_file(self):
        text = forge(["%s3" % R.HEADER_PREFIX, ""])
        self.assertEqual(self.codes(text), ["no_sections"])

    def test_missing_or_misplaced_deny(self):
        s = [GOOD[0], DENY, GOOD[1]]
        self.assertIn("last_section_not_deny", self.codes(forge(lines(s))))
        s = GOOD[:-1]
        self.assertIn("last_section_not_deny", self.codes(forge(lines(s))))
        s = GOOD[:-1] + [Section("zzz-deny", ".*", ".*", "r")]
        self.assertEqual(self.codes(forge(lines(s))), ["last_section_not_deny"])
        s = GOOD[:-1] + [Section("zzz-deny", "^a$", ".*", "")]
        self.assertEqual(self.codes(forge(lines(s))), ["last_section_not_deny"])

    def test_groups_key_rejected(self):
        ls = lines()
        ls.insert(ls.index("[g010-root]") + 4, "groups: admins")
        self.assertIn("groups_key", self.codes(forge(ls)))

    def test_other_keys_and_missing_keys(self):
        ls = lines()
        ls.insert(ls.index("[g010-root]") + 4, "extra: 1")
        self.assertIn("bad_keys", self.codes(forge(ls)))
        ls = lines()
        i = ls.index("[g010-root]")
        del ls[i + 2]                      # drop "collection"
        self.assertIn("bad_keys", self.codes(forge(ls)))

    def test_bad_letters(self):
        for letters in ("rwd", "x", "RR", "RWrwDOilu", "R W", "o", "E"):
            s = [Section("s1", "^a$", "^a$", letters)] + [DENY]
            self.assertIn("bad_letters", self.codes(forge(lines(s))), letters)

    def test_all_allowed_letters_accepted(self):
        s = [Section("s1", "^a$", "^a$", "RWrwDOil"), DENY]
        self.assertEqual(self.codes(forge(lines(s))), [])

    def test_forbidden_characters_in_patterns(self):
        for pat in ("^a{0}$", "^a}$", "^a%$", "^a{{b}}$", "^%(x)s$"):
            s = [Section("s1", "^a$", pat, "r"), DENY]
            self.assertIn("forbidden_chars", self.codes(forge(lines(s))), pat)
        s = [Section("s1", pat := "^a{$", "^a$", "r"), DENY]
        self.assertIn("forbidden_chars", self.codes(forge(lines(s))), pat)

    def test_uncompilable_patterns(self):
        for pat in ("^(a$", "^[a$", "^a**$", "(?P<x>a)(?P<x>b)", "\\"):
            s = [Section("s1", "^a$", pat, "r"), DENY]
            self.assertIn("bad_pattern", self.codes(forge(lines(s))), pat)
            s = [Section("s1", pat, "^a$", "r"), DENY]
            self.assertIn("bad_pattern", self.codes(forge(lines(s))), pat)

    def test_empty_patterns(self):
        s = [Section("s1", "", "^a$", "r"), DENY]
        self.assertIn("empty_pattern", self.codes(forge(lines(s))))
        s = [Section("s1", "^a$", "", "r"), DENY]
        self.assertIn("empty_pattern", self.codes(forge(lines(s))))

    def test_parse_errors(self):
        ls = lines()
        ls.insert(2, "not a key value line")
        self.assertEqual(self.codes(forge(ls)), ["parse_error"])
        ls = lines() + lines(GOOD)[2:]          # duplicate sections
        self.assertEqual(self.codes(forge(ls)), ["parse_error"])

    def test_default_section_rejected(self):
        ls = lines()
        ls.insert(2, "[DEFAULT]")
        ls.insert(3, "user: x")
        ls.insert(4, "")
        self.assertIn("default_section", self.codes(forge(ls)))

    def test_bad_section_names(self):
        for name in ("a b", "a/b", "a]b", "x" * 101):
            s = [Section(name, "^a$", "^a$", "r"), DENY]
            try:
                codes = self.codes(forge(lines(s)))
            except Exception as exc:               # pragma: no cover
                self.fail(repr(exc))
            self.assertTrue(codes, name)

    def test_noncanonical_spacing_rejected(self):
        text = render(GOOD, 3)
        loose = text.replace("user: ^alice$", "user:   ^alice$", 1)
        body = loose[:loose.rindex("# radui-end")]
        again = "%s# radui-end generation=3 sha256=%s\n" % (body, R.sha256_hex(body))
        self.assertEqual(self.codes(again), ["not_canonical"])

    def test_comment_inside_body_rejected(self):
        ls = lines()
        ls.insert(3, "# sneaky comment")
        self.assertEqual(self.codes(forge(ls)), ["not_canonical"])

    def test_upper_case_keys_rejected_as_not_canonical(self):
        ls = [l.replace("permissions:", "Permissions:") for l in lines()]
        self.assertEqual(self.codes(forge(ls)), ["not_canonical"])

    def test_error_str(self):
        e = R.RightsError("x", "y")
        self.assertEqual(str(e), "x: y")


@unittest.skipUnless(MATCHER, "no Radicale interpreter configured")
class RadicaleAcceptsTests(unittest.TestCase):
    def test_accepted_text_loads_in_radicale(self):
        for model in case_models().values():
            text = generator.generate(model)[0]
            self.assertEqual(MATCHER(text, [("alice", "")]), ["R"])

    def test_checker_agrees_on_pattern_errors(self):
        s = [Section("s1", "^a$", "^(a$", "r"), DENY]
        text = forge(lines(s))
        self.assertIn("bad_pattern", error_codes(check_text(text)))


if __name__ == "__main__":
    unittest.main()
