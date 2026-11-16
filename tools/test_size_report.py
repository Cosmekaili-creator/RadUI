# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for tools/size-report.py (run with python3 -m unittest). Temporary directories only."""
import contextlib
import gzip
import importlib.util
import io
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("size_report", os.path.join(HERE, "size-report.py"))
sr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sr)


def filler(n):
    return "// " + ("x" * n) + "\n"


TREE = {
    "index.html": "<!doctype html>\n",
    "css/app.css": "body{}\n",
    "vendor/ical.js": "var ICAL={};\n",
    "build-info.json": '{"minified": true, "source": "t", "terser": "1.0.0"}\n',
    "i18n/en.js": "export default Object.freeze({});\n",
    "i18n/fr.js": "export default Object.freeze({});\n",
    "i18n/en.shell.js": "export default {};\n",
    "js/app.js": ("/* import lazy from './comment.js'; */\n// import line from './line.js';\n"
                  "import { a } from './a.js';\nimport b from \"./sub/b.js\";\nimport './side.js';\n"
                  "export { c } from './c.js';\nexport * from './d.js';\nimport { t } from './i18n.js';\n"
                  "const lazyLoad = () => import('./lazy.js');\n"),
    "js/a.js": "export const a = 1;\n",
    "js/sub/b.js": "import { a } from '../a.js';\nexport default a;\n",
    "js/side.js": "\n",
    "js/c.js": "export const c = 1;\n",
    "js/d.js": "export const d = 1;\n",
    "js/lazy.js": filler(5000),
    "js/comment.js": filler(5000),
    "js/line.js": filler(5000),
    "js/i18n.js": "import en from '../i18n/en.js';\nimport fr from '../i18n/fr.js';\nexport const t = [en, fr];\n",
    "js/model/item.js": "export const item = 1;\n",
    "js/store/index.js": "import { item } from '../model/item.js';\nexport const store = item;\n",
    "js/views/calendar/screen.js": filler(3000) + "export const mount = 1;\n",
    "js/views/contacts/screen.js": "export const mount = 1;\n",
    "js/views/tasks/screen.js": "export const mount = 1;\n",
}


def write_tree(root, files):
    for rel, text in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)


class SizeReportTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="radui-sizetest-")
        self.addCleanup(self._tmp.cleanup)
        self.www = self._tmp.name
        write_tree(self.www, TREE)

    def test_static_imports_parser(self):
        text = TREE["js/app.js"]
        self.assertEqual(sorted(sr.static_imports(text)),
                         ["./a.js", "./c.js", "./d.js", "./i18n.js", "./side.js", "./sub/b.js"])

    def test_closure_follows_static_only_and_skips_dictionaries(self):
        rels = sr.closure(self.www, ["js/app.js"])
        self.assertEqual(rels, ["js/a.js", "js/app.js", "js/c.js", "js/d.js", "js/i18n.js", "js/side.js", "js/sub/b.js"])
        for lazy in ("js/lazy.js", "js/comment.js", "js/line.js"):
            self.assertNotIn(lazy, rels)
        self.assertFalse([r for r in rels if r.startswith("i18n/")])

    def test_missing_import_target_stops(self):
        write_tree(self.www, {"js/a.js": "import './nope.js';\n"})
        with self.assertRaises(SystemExit):
            sr.closure(self.www, ["js/app.js"])

    def test_report_counts_one_language_and_gzip_levels(self):
        rep = sr.report(self.www, "en")
        cal = rep["first_screen"]["calendar"]
        con = rep["first_screen"]["contacts"]
        self.assertGreater(cal["raw"], con["raw"])  # the calendar screen is bigger
        expected = sum(len(open(os.path.join(self.www, r), "rb").read()) for r in
                       sr.closure(self.www, sr.BASE_ENTRIES + [sr.SCREENS["contacts"]]) + ["i18n/en.js"])
        self.assertEqual(con["raw"], expected)
        data = open(os.path.join(self.www, "js/a.js"), "rb").read()
        self.assertEqual(sr.sizes(data)["gzip6"], len(gzip.compress(data, compresslevel=6, mtime=0)))
        self.assertEqual(sorted(rep["languages"]), ["en", "fr"])
        self.assertEqual(rep["part_files"], ["i18n/en.shell.js"])
        self.assertEqual(rep["build_info"]["source"], "t")

    def test_budget_exit_status_and_output(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sr.main(["--www", self.www]), 0)
            self.assertEqual(sr.main(["--www", self.www, "--budget-kb", "0.001"]), 1)
        text = out.getvalue()
        self.assertIn("first screen: calendar", text)
        self.assertIn("OVER BUDGET", text)
        self.assertIn("dictionary part files", text)

    def test_json_output(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            sr.main(["--www", self.www, "--json"])
        self.assertIn("calendar", json.loads(out.getvalue())["first_screen"])

    def test_missing_language(self):
        with self.assertRaises(SystemExit):
            sr.report(self.www, "de")


if __name__ == "__main__":
    unittest.main()
