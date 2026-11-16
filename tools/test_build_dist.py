# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for tools/build-dist.py (run with python3 -m unittest). Temporary directories only: no network, no live paths.

The tests that minify need the system `terser`; they are skipped without it. All need `node`."""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DEPLOY = os.path.join(HERE, "deploy-static.sh")


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bd = _load("build_dist", "build-dist.py")
HAVE_NODE = shutil.which("node") is not None
HAVE_TERSER = shutil.which("terser") is not None
SPDX = "// SPDX-License-Identifier: AGPL-3.0-or-later\n"

FAKE_SRC = {
    "index.html": "<!doctype html><title>app</title>\n",
    "sw.js": SPDX + "'use strict';\nimportScripts('sw-manifest.js');\nconst PREFIX = 'x-';\nself.addEventListener('install', () => { console.log(PREFIX); });\n",
    "sw-manifest.js": "// stale generated file\n",
    "config.json": '{"shipped": true}\n',
    "package.json": '{"type": "module"}\n',
    "css/app.css": "body { color: red; }\n",
    "js/app.js": SPDX + "import { SUPPORTED_LANGUAGES } from './i18n.js';\nexport class Thing { run(items) { const total = items.length; return total + SUPPORTED_LANGUAGES.length; } }\n",
    "js/i18n.js": SPDX + "export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'fr']);\n",
    "i18n/en.js": SPDX + "import a from './en.alpha.js';\nimport b from './en.beta.js';\nexport default Object.freeze({ ...a, ...b });\n",
    "i18n/en.alpha.js": SPDX + "export default { 'a.one': 'One', 'a.café': 'Café \"quoted\" \\\\ back' };\n",
    "i18n/en.beta.js": SPDX + "export default { 'b.two': 'Two {n}' };\n",
    "i18n/fr.js": SPDX + "import a from './fr.alpha.js';\nimport b from './fr.beta.js';\nexport default Object.freeze({ ...a, ...b });\n",
    "i18n/fr.alpha.js": SPDX + "export default { 'a.one': 'Un', 'a.café': 'Café' };\n",
    "i18n/fr.beta.js": SPDX + "export default { 'b.two': 'Deux {n}' };\n",
    "vendor/ical.js": "/* vendored, kept as is */var ICAL={};\n",
    "vendor/SHA256SUMS": "deadbeef  ical.js\n",
}


def write_tree(root, files):
    for rel, text in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)


def tree_hashes(root):
    out = {}
    for dirpath, _d, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            with open(full, "rb") as fh:
                out[os.path.relpath(full, root)] = hashlib.sha256(fh.read()).hexdigest()
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="radui-buildtest-")
        self.addCleanup(self._tmp.cleanup)
        self.tmp = os.path.realpath(self._tmp.name)
        self.src = os.path.join(self.tmp, "src")
        self.out = os.path.join(self.tmp, "dist")
        write_tree(self.src, FAKE_SRC)

    def build(self, minify=False, out=None, **kw):
        return bd.build(self.src, out or self.out, minify=minify, label=kw.pop("label", "test-label"), **kw)


@unittest.skipUnless(HAVE_NODE, "node is not installed")
class UnsafeOut(Base):
    def test_refused_outputs(self):
        for bad in (self.src, os.path.join(self.src, "js"), os.path.join(self.src, "new"), self.tmp, os.path.dirname(self.tmp)):
            with self.assertRaises(bd.BuildError, msg=bad):
                self.build(out=bad)
        self.assertTrue(os.path.isfile(os.path.join(self.src, "index.html")))

    def test_root_empty_and_home(self):
        for bad in ("/", "", "   "):
            with self.assertRaises(bd.BuildError, msg=repr(bad)):
                bd.check_paths(self.src, bad)
        saved = os.environ.get("HOME")
        os.environ["HOME"] = self.tmp  # also refuses a home directory that is an ancestor of src
        try:
            with self.assertRaises(bd.BuildError):
                bd.check_paths(self.src, self.tmp)
        finally:
            if saved is None:
                os.environ.pop("HOME")
            else:
                os.environ["HOME"] = saved

    def test_non_empty_directory_without_marker_is_refused_and_untouched(self):
        other = os.path.join(self.tmp, "precious")
        write_tree(other, {"keep.txt": "do not delete\n"})
        with self.assertRaises(bd.BuildError):
            self.build(out=other)
        self.assertTrue(os.path.isfile(os.path.join(other, "keep.txt")))

    def test_symlink_and_file_are_refused(self):
        link = os.path.join(self.tmp, "link")
        os.symlink(self.tmp, link)
        with self.assertRaises(bd.BuildError):
            self.build(out=link)
        afile = os.path.join(self.tmp, "afile")
        write_tree(self.tmp, {"afile": "x\n"})
        with self.assertRaises(bd.BuildError):
            self.build(out=afile)

    def test_previous_build_is_replaced_completely(self):
        self.build()
        write_tree(self.out, {"stale.txt": "left over\n"})
        self.build()
        self.assertFalse(os.path.exists(os.path.join(self.out, "stale.txt")))

    def test_source_without_index_html(self):
        os.remove(os.path.join(self.src, "index.html"))
        with self.assertRaises(bd.BuildError):
            self.build()


@unittest.skipUnless(HAVE_NODE, "node is not installed")
class PlainBuild(Base):
    def test_copy_flatten_and_build_info(self):
        res = self.build()
        self.assertEqual(res["languages"], ["en", "fr"])
        names = sorted(os.listdir(os.path.join(self.out, "i18n")))
        self.assertEqual(names, ["en.js", "fr.js"])  # no part files
        self.assertFalse(os.path.exists(os.path.join(self.out, "sw-manifest.js")))
        for rel in ("index.html", "config.json", "package.json", "css/app.css", "vendor/ical.js", "js/app.js"):
            self.assertTrue(os.path.isfile(os.path.join(self.out, rel)), rel)
        with open(os.path.join(self.out, "i18n", "en.js"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertTrue(text.startswith(SPDX))
        self.assertIn("export default Object.freeze({", text)
        info = json.load(open(os.path.join(self.out, "build-info.json")))
        self.assertEqual(info, {"minified": False, "source": "test-label", "terser": None})
        self.assertNotIn(self.tmp, json.dumps(info))
        # the source tree is untouched
        self.assertTrue(os.path.isfile(os.path.join(self.src, "i18n", "en.alpha.js")))
        self.assertTrue(os.path.isfile(os.path.join(self.src, "sw-manifest.js")))

    def test_flattened_equals_aggregator_and_a_difference_is_caught(self):
        self.build()
        for lang in ("en", "fr"):
            bd.verify_flattened(bd.find_node(), os.path.join(self.src, "i18n", lang + ".js"), os.path.join(self.out, "i18n", lang + ".js"))
        bad = os.path.join(self.tmp, "bad.js")
        with open(os.path.join(self.out, "i18n", "en.js"), encoding="utf-8") as fh:
            text = fh.read().replace("One", "Uno")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write(text)
        shutil.copy(os.path.join(self.src, "package.json"), os.path.join(self.tmp, "package.json"))
        with self.assertRaises(bd.BuildError):
            bd.verify_flattened(bd.find_node(), os.path.join(self.src, "i18n", "en.js"), bad)
        # a key order difference is a difference too (the app iterates the keys)
        swapped = os.path.join(self.tmp, "swapped.js")
        with open(swapped, "w", encoding="utf-8") as fh:
            fh.write(SPDX + "export default Object.freeze({\"b.two\": \"Two {n}\", \"a.one\": \"One\", \"a.café\": \"Café \\\"quoted\\\" \\\\ back\"});\n")
        with self.assertRaises(bd.BuildError):
            bd.verify_flattened(bd.find_node(), os.path.join(self.src, "i18n", "en.js"), swapped)

    def test_missing_aggregator_for_a_supported_language_fails(self):
        os.remove(os.path.join(self.src, "i18n", "fr.js"))
        with self.assertRaises(bd.BuildError):
            self.build()

    def test_deterministic(self):
        self.build()
        first = tree_hashes(self.out)
        self.build()
        self.assertEqual(first, tree_hashes(self.out))

    def test_main_reports_errors_without_traceback(self):
        self.assertEqual(bd.main(["--src", self.src, "--out", self.src]), 2)
        self.assertEqual(bd.main(["--src", self.src, "--out", self.out, "--no-minify", "--source-label", "x"]), 0)


@unittest.skipUnless(HAVE_NODE and HAVE_TERSER, "node and terser are needed")
class MinifiedBuild(Base):
    def test_minify_keeps_spdx_vendor_and_class_names(self):
        res = self.build(minify=True)
        self.assertEqual(res["minified_files"], 3)  # js/app.js, js/i18n.js, sw.js
        app = open(os.path.join(self.out, "js", "app.js"), encoding="utf-8").read()
        self.assertTrue(app.startswith(SPDX))
        self.assertIn("class Thing", app)  # --keep-classnames
        self.assertNotIn("const total", app)  # mangled
        self.assertLess(len(app), len(FAKE_SRC["js/app.js"]))
        sw = open(os.path.join(self.out, "sw.js"), encoding="utf-8").read()
        self.assertTrue(sw.startswith(SPDX))
        self.assertIn('importScripts("sw-manifest.js")', sw)
        self.assertEqual(open(os.path.join(self.out, "vendor", "ical.js"), "rb").read(), FAKE_SRC["vendor/ical.js"].encode())
        info = json.load(open(os.path.join(self.out, "build-info.json")))
        self.assertTrue(info["minified"])
        self.assertRegex(info["terser"], r"^\d+\.\d+\.\d+")

    def test_syntax_error_fails_the_build(self):
        write_tree(self.src, {"js/broken.js": SPDX + "export const = ;\n"})
        with self.assertRaises(bd.BuildError):
            self.build(minify=True)

    def test_deterministic_with_terser(self):
        self.build(minify=True)
        first = tree_hashes(self.out)
        self.build(minify=True)
        self.assertEqual(first, tree_hashes(self.out))

    def test_missing_terser_gives_a_hint(self):
        saved = os.environ["PATH"]
        os.environ["PATH"] = self.tmp  # no terser here
        try:
            with self.assertRaises(bd.BuildError) as cm:
                bd.find_terser()
        finally:
            os.environ["PATH"] = saved
        self.assertIn("--no-minify", str(cm.exception))


@unittest.skipUnless(HAVE_NODE, "node is not installed")
class DeployFromDist(Base):
    """tools/deploy-static.sh --src <built dist> works unchanged and its hash check passes."""

    def deploy(self, *args):
        env = dict(os.environ, RADUI_DEPLOY_DATE="20990101", TMPDIR=self.tmp)
        return subprocess.run(["bash", DEPLOY, "--src", self.out, *args], capture_output=True, text=True, env=env, timeout=120)

    def test_dry_run_lists_no_part_files_and_apply_verifies(self):
        self.build()
        dest = os.path.join(self.tmp, "www")
        bk = os.path.join(self.tmp, "bk")
        os.makedirs(bk)
        dry = self.deploy("--dest", dest, "--init")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertNotIn("en.alpha", dry.stdout)
        self.assertNotIn("fr.beta", dry.stdout)
        self.assertIn("i18n/en.js", dry.stdout)
        self.assertIn("build-info.json", dry.stdout)
        self.assertIn('"source": "test-label"', dry.stdout)
        self.assertFalse(os.path.exists(dest))
        done = self.deploy("--dest", dest, "--init", "--apply", "--backup-dir", bk)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("manifest entries and sw.js, sw-manifest.js verified", done.stdout)
        self.assertTrue(os.path.isfile(os.path.join(dest, "build-info.json")))
        manifest = open(os.path.join(dest, "sw-manifest.js"), encoding="utf-8").read()
        for rel in ("i18n/en.js", "i18n/fr.js", "build-info.json"):
            self.assertIn('"%s"' % rel, manifest)
        self.assertNotIn("en.alpha", manifest)
        # the dist tree itself is never written to
        self.assertFalse(os.path.exists(os.path.join(self.out, "sw-manifest.js")))
        again = self.deploy("--dest", dest, "--apply", "--backup-dir", bk)
        self.assertIn("unchanged", again.stdout)


@unittest.skipUnless(HAVE_NODE, "node is not installed")
class RealTree(unittest.TestCase):
    """The repository's own src/ builds, flattens (proven equal) and its manifest can be generated from dist."""

    def test_real_src_builds_and_manifest_comes_from_dist(self):
        with tempfile.TemporaryDirectory(prefix="radui-buildreal-") as tmp:
            out = os.path.join(tmp, "dist")
            res = bd.build(os.path.join(REPO, "src"), out, minify=False, label="test")
            self.assertIn("en", res["languages"])
            for lang in res["languages"]:
                self.assertTrue(os.path.isfile(os.path.join(out, "i18n", lang + ".js")))
            leftovers = [n for n in os.listdir(os.path.join(out, "i18n")) if n.count(".") > 1]
            self.assertEqual(leftovers, [])
            self.assertFalse(os.path.exists(os.path.join(out, "sw-manifest.js")))
            man = _load("bsm", "build-sw-manifest.py")
            target = os.path.join(tmp, "manifest.js")
            man.build(out, target)
            text = open(target, encoding="utf-8").read()
            self.assertIn('"i18n/en.js"', text)
            self.assertIn('"build-info.json"', text)
            self.assertNotIn('"i18n/en.shell.js"', text)


if __name__ == "__main__":
    unittest.main()
