# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for tools/render-deploy.py (run with python3 -m unittest)."""
import contextlib
import importlib.util
import io
import os
import re
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location(
    "render_deploy", os.path.join(HERE, "render-deploy.py"))
rd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rd)

EXAMPLE_VARS = os.path.join(REPO, "deploy", "vars.example.env")
DEPLOY = os.path.join(REPO, "deploy")


def write(root, files):
    for rel, content in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = rd.main(list(argv))
        except SystemExit as exc:  # argparse errors
            code = exc.code
    return code, out.getvalue(), err.getvalue()


class ParseVars(unittest.TestCase):
    def test_basic(self):
        values, doc = rd.parse_vars("# about A\nA=1\n\nB = two words\n# about C\nC=\"q\"\n")
        self.assertEqual(values, {"A": "1", "B": "two words", "C": "q"})
        self.assertEqual(doc, {"A", "C"})

    def test_a_comment_covers_the_assignments_directly_below_until_a_blank_line(self):
        _, doc = rd.parse_vars("# one\n# two\nA=1\nB=2\n\nC=3\n")
        self.assertEqual(doc, {"A", "B"})

    def test_duplicate_and_bad_lines(self):
        for text in ("A=1\nA=2\n", "just text\n", "lower=1\n", "1A=2\n"):
            with self.assertRaises(rd.RenderError, msg=text):
                rd.parse_vars(text)

    def test_value_may_contain_equals_sign(self):
        values, _ = rd.parse_vars("A=x=y\n")
        self.assertEqual(values["A"], "x=y")


class RenderText(unittest.TestCase):
    def test_substitutes_every_occurrence(self):
        self.assertEqual(rd.render_text("@@A@@ and @@A@@ @@B@@", {"A": "1", "B": "2"}), "1 and 1 2")

    def test_unset_variable_fails_and_names_it(self):
        with self.assertRaisesRegex(rd.RenderError, "NOPE"):
            rd.render_text("x @@NOPE@@", {"A": "1"}, "t.tpl")

    def test_empty_variable_counts_as_unset(self):
        with self.assertRaisesRegex(rd.RenderError, "A"):
            rd.render_text("@@A@@", {"A": ""})

    def test_values_are_not_expanded_again(self):
        # a value that looks like a placeholder is caught as a left-over, not substituted
        with self.assertRaisesRegex(rd.RenderError, "left over"):
            rd.render_text("@@A@@", {"A": "@@B@@", "B": "x"})

    def test_stray_double_at_fails(self):
        with self.assertRaisesRegex(rd.RenderError, "left over"):
            rd.render_text("a @@ b", {})

    def test_single_at_is_fine(self):
        self.assertEqual(rd.render_text("user@host @@A@@", {"A": "1"}), "user@host 1")


class Values(unittest.TestCase):
    def test_dangerous_characters_are_refused(self):
        for bad in ("a;b", "a\nb", "a{b", "a}b", 'a"b', "a'b", "a$b", "a`b", "a\\b", "a#b", "a@b",
                    "a(b", "a\tb"):
            with self.assertRaises(rd.RenderError, msg=repr(bad)):
                rd.check_values({"A": bad})

    def test_normal_values_pass(self):
        for good in ("example.org", "/var/lib/radui", "127.0.0.1:5233", "120r/m", "127.0.0.1/8 ::1",
                     "http,https", "50M", "_SYSTEMD_UNIT=x.service"):
            rd.check_values({"A": good})

    def test_only_used_variables_are_examined(self):
        rd.check_values({"A": "ok", "B": "bad;value"}, used={"A"})
        with self.assertRaises(rd.RenderError):
            rd.check_values({"A": "ok", "B": "bad;value"}, used={"A", "B"})


class RenderTree(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = os.path.join(self.tmp.name, "deploy")
        write(self.src, {"a/one.conf.tpl": "name=@@N@@\n", "two.txt.tpl": "@@N@@-@@M@@\n",
                         "static.conf": "no placeholder\n", "vars.env": "# the name\nN=x\n# m\nM=y\n"})
        self.vars = os.path.join(self.src, "vars.env")

    def test_render_strips_suffix_and_keeps_tree(self):
        out = rd.render_tree(self.src, {"N": "x", "M": "y"})
        self.assertEqual(out, {"a/one.conf": "name=x\n", "two.txt": "x-y\n"})

    def test_missing_variable_writes_nothing(self):
        outdir = os.path.join(self.tmp.name, "out")
        code, _, err = run("--vars", self.vars, "--src", self.src, "--out", outdir)
        self.assertEqual(code, 0)
        os.remove(os.path.join(outdir, "two.txt"))
        write(self.src, {"vars.env": "# n\nN=x\n"})
        outdir2 = os.path.join(self.tmp.name, "out2")
        code, _, err = run("--vars", self.vars, "--src", self.src, "--out", outdir2)
        self.assertEqual(code, 1)
        self.assertIn("M", err)
        self.assertFalse(os.path.exists(outdir2))

    def test_untemplated_placeholder_is_caught(self):
        write(self.src, {"oops.conf": "x @@N@@\n"})
        with self.assertRaisesRegex(rd.RenderError, "not a template"):
            rd.render_tree(self.src, {"N": "x", "M": "y"})

    def test_output_inside_the_template_dir_is_refused(self):
        code, _, err = run("--vars", self.vars, "--src", self.src, "--out", os.path.join(self.src, "out"))
        self.assertEqual(code, 1)
        self.assertIn("inside", err)

    def test_out_is_required_without_check(self):
        code, _, _ = run("--vars", self.vars, "--src", self.src)
        self.assertEqual(code, 2)

    def test_check_mode_writes_nothing_and_validates(self):
        before = sorted(os.listdir(self.tmp.name))
        code, out, _ = run("--vars", self.vars, "--src", self.src, "--check")
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(os.listdir(self.tmp.name)), before)
        self.assertFalse(os.path.exists(os.path.join(self.src, "two.txt")))

    def test_check_mode_reports_undocumented_unused_and_undefined(self):
        write(self.src, {"vars.env": "N=x\n# m\nM=y\n"})
        code, _, err = run("--vars", self.vars, "--src", self.src, "--check")
        self.assertEqual(code, 1)
        self.assertIn("without a comment", err)
        write(self.src, {"vars.env": "# n\nN=x\n# m\nM=y\n# extra\nEXTRA=z\n"})
        code, _, err = run("--vars", self.vars, "--src", self.src, "--check")
        self.assertEqual(code, 1)
        self.assertIn("no template uses", err)
        write(self.src, {"vars.env": "# n\nN=x\n"})
        code, _, err = run("--vars", self.vars, "--src", self.src, "--check")
        self.assertEqual(code, 1)

    def test_rendering_twice_gives_identical_files(self):
        o1, o2 = (os.path.join(self.tmp.name, n) for n in ("o1", "o2"))
        self.assertEqual(run("--vars", self.vars, "--src", self.src, "--out", o1)[0], 0)
        self.assertEqual(run("--vars", self.vars, "--src", self.src, "--out", o2)[0], 0)
        for rel in ("a/one.conf", "two.txt"):
            with open(os.path.join(o1, rel)) as a, open(os.path.join(o2, rel)) as b:
                self.assertEqual(a.read(), b.read())


class RepositoryDeployTree(unittest.TestCase):
    """The real templates with the shipped example variables."""

    def setUp(self):
        with open(EXAMPLE_VARS, encoding="utf-8") as fh:
            self.values, self.documented = rd.parse_vars(fh.read(), EXAMPLE_VARS)

    def test_check_passes(self):
        code, out, err = run("--vars", EXAMPLE_VARS, "--check")
        self.assertEqual(code, 0, err)

    def test_every_variable_is_documented_used_and_valid(self):
        rd.check_variables_file(DEPLOY, self.values, self.documented)
        rd.check_values(self.values)

    def test_no_placeholder_is_left_in_any_output(self):
        rendered = rd.render_tree(DEPLOY, self.values)
        self.assertGreaterEqual(len(rendered), 10)
        for rel, text in rendered.items():
            self.assertNotIn("@@", text, rel)

    def test_rendered_values_end_up_in_the_output(self):
        rendered = rd.render_tree(DEPLOY, self.values)
        self.assertIn("ReadWritePaths=%s %s" % (self.values["STATE_DIR"], self.values["MANAGED_DIR"]),
                      rendered["systemd/radui-admin.service"])
        self.assertIn("server_name %s;" % self.values["SERVER_NAME"],
                      rendered["nginx/radui-vhost-example.conf"])

    def test_example_values_are_neutral_placeholders(self):
        self.assertEqual(self.values["SERVER_NAME"], "example.org")
        self.assertEqual(self.values["RADUI_USER"], "radui")
        self.assertEqual(self.values["RADICALE_GROUP"], "radicale")
        for key in ("CONFIG_DIR", "STATE_DIR", "INSTALL_DIR"):
            self.assertRegex(self.values[key], r"^/(etc|var/lib|opt)/radui")
        self.assertEqual(self.values["UI_DIR"], "/var/www/radui-ui")

    def test_every_template_and_script_carries_the_spdx_header(self):
        tag = "SPDX-License-Identifier: AGPL-3.0-or-later"
        for base, _dirs, files in os.walk(DEPLOY):
            for f in files:
                path = os.path.join(base, f)
                with open(path, encoding="utf-8") as fh:
                    head = "".join(fh.readline() for _ in range(6))
                self.assertIn(tag, head, path)

    def test_nginx_pair_rule_and_header_discipline(self):
        out = rd.render_tree(DEPLOY, self.values)
        proxy = out["nginx/radui-proxy-headers.inc"]
        self.assertIn("proxy_set_header X-Forwarded-For $remote_addr;", proxy)
        self.assertNotIn("proxy_add_x_forwarded_for;", proxy.replace("$proxy_add_x_forwarded_for appended", ""))
        for name in ("X-Forwarded-Host", "X-Remote-Addr", "Forwarded"):
            self.assertRegex(proxy, r'proxy_set_header %s "";' % name)
        # every location that answers includes the security headers
        locs = out["nginx/radui-locations.conf"]
        blocks = re.findall(r"^location [^{]+\{(.*?)^\}", locs, re.S | re.M)
        self.assertGreaterEqual(len(blocks), 8)
        for b in blocks:
            self.assertIn("radui-security-headers.inc", b)


if __name__ == "__main__":
    unittest.main()
