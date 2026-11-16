# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for tools/build-sw-manifest.py (run with python3 -m unittest)."""
import contextlib
import hashlib
import io
import importlib.util
import json
import os
import re
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("build_sw_manifest", os.path.join(HERE, "build-sw-manifest.py"))
bsm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bsm)

TREE = {
    "index.html": b"<!doctype html>\n",
    "config.json": b'{"appTitle": "A"}\n',
    "manifest.webmanifest": b"{}\n",
    "css/app.css": b"body{}\n",
    "js/app.js": b"export default 1;\n",
    "icons/icon-192.png": bytes(range(256)),
    "vendor/lib/1.0/lib.min.js": b"/* lib */\n",
    # excluded:
    "sw.js": b"// worker\n",
    "sw-manifest.js": b"// old output\n",
    "package.json": b"{}\n",
    ".gitkeep": b"",
    "icons/README.md": b"# icons\n",
    "README.md": b"# readme\n",
    "vendor/lib/1.0/SHA256SUMS": b"abc  lib.min.js\n",
}


def write_tree(root, files):
    for rel, data in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)


def run_main(argv):
    with contextlib.redirect_stdout(io.StringIO()):
        return bsm.main(argv)


def load(path):
    """Parse a generated file back into (header lines, manifest dict)."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    body = re.search(r"Object\.freeze\((\{.*\})\);\n\Z", text, re.S).group(1)
    return text, json.loads(body)


class BuildSwManifestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = os.path.join(self.tmp.name, "src")
        self.out = os.path.join(self.tmp.name, "run", "sw-manifest.js")
        write_tree(self.src, TREE)

    def build(self):
        return run_main(["--src", self.src, "--out", self.out])

    def test_lists_the_right_files_with_their_hashes(self):
        self.assertEqual(self.build(), 0)
        _, man = load(self.out)
        paths = [f["path"] for f in man["files"]]
        self.assertEqual(paths, sorted(paths))
        self.assertEqual(
            paths,
            ["config.json", "css/app.css", "icons/icon-192.png", "index.html", "js/app.js", "manifest.webmanifest", "vendor/lib/1.0/lib.min.js"],
        )
        by_path = {f["path"]: f["sha256"] for f in man["files"]}
        self.assertEqual(by_path["js/app.js"], hashlib.sha256(TREE["js/app.js"]).hexdigest())
        self.assertEqual(by_path["icons/icon-192.png"], hashlib.sha256(TREE["icons/icon-192.png"]).hexdigest())
        self.assertIsNone(by_path["config.json"], "deployment-specific file is listed without a hash")

    def test_exclusions(self):
        self.build()
        _, man = load(self.out)
        paths = {f["path"] for f in man["files"]}
        for excluded in ("sw.js", "sw-manifest.js", "package.json", ".gitkeep", "README.md", "icons/README.md", "vendor/lib/1.0/SHA256SUMS"):
            self.assertNotIn(excluded, paths)

    def test_only_top_level_sw_and_package_json_are_excluded(self):
        write_tree(self.src, {"js/sw.js": b"x", "vendor/pkg/package.json": b"{}", "js/SHA256SUMS": b"y"})
        self.build()
        _, man = load(self.out)
        paths = {f["path"] for f in man["files"]}
        self.assertTrue({"js/sw.js", "vendor/pkg/package.json", "js/SHA256SUMS"} <= paths)

    def test_header_and_shape(self):
        self.build()
        text, man = load(self.out)
        self.assertTrue(text.startswith("// SPDX-License-Identifier: AGPL-3.0-or-later\n"))
        self.assertIn("self.RADUI_SW_MANIFEST = Object.freeze(", text)
        self.assertRegex(man["version"], r"^[0-9a-f]{16}$")
        self.assertTrue(text.endswith("\n") and "\r" not in text)

    def test_deterministic_and_independent_of_listing_order(self):
        self.build()
        with open(self.out, "rb") as fh:
            first = fh.read()
        self.build()
        with open(self.out, "rb") as fh:
            self.assertEqual(first, fh.read())
        entries = bsm.collect(self.src)
        self.assertEqual(bsm.version_of(entries), bsm.version_of(list(reversed(entries))))

    def test_version_follows_content_and_paths(self):
        self.build()
        _, before = load(self.out)
        write_tree(self.src, {"js/app.js": b"export default 2;\n"})
        self.build()
        _, changed = load(self.out)
        self.assertNotEqual(before["version"], changed["version"])
        write_tree(self.src, {"js/app.js": TREE["js/app.js"]})
        self.build()
        _, restored = load(self.out)
        self.assertEqual(before["version"], restored["version"])
        write_tree(self.src, {"js/new.js": b"x"})
        self.build()
        _, added = load(self.out)
        self.assertNotEqual(before["version"], added["version"])

    def test_config_json_content_does_not_change_the_version(self):
        self.build()
        _, before = load(self.out)
        write_tree(self.src, {"config.json": b'{"appTitle": "Other deployment"}\n'})
        self.build()
        _, after = load(self.out)
        self.assertEqual(before["version"], after["version"])

    def test_excluded_files_do_not_change_the_version(self):
        self.build()
        _, before = load(self.out)
        write_tree(self.src, {"sw.js": b"// other\n", "icons/README.md": b"other\n", "sw-manifest.js": b"stale\n"})
        self.build()
        _, after = load(self.out)
        self.assertEqual(before["version"], after["version"])

    def test_default_output_is_src_sw_manifest_js_and_is_not_listed(self):
        self.assertEqual(run_main(["--src", self.src]), 0)
        default = os.path.join(self.src, "sw-manifest.js")
        self.assertTrue(os.path.isfile(default))
        _, first = load(default)
        run_main(["--src", self.src])  # the generated file does not feed back into the next run
        _, second = load(default)
        self.assertEqual(first, second)
        self.assertNotIn("sw-manifest.js", [f["path"] for f in second["files"]])

    def test_refuses_a_directory_that_is_not_the_app(self):
        empty = os.path.join(self.tmp.name, "empty")
        os.makedirs(empty)
        with self.assertRaises(SystemExit):
            run_main(["--src", empty, "--out", self.out])
        with self.assertRaises(SystemExit):
            run_main(["--src", os.path.join(self.tmp.name, "missing")])

    def test_symlinks_are_not_listed(self):
        os.symlink(os.path.join(self.src, "index.html"), os.path.join(self.src, "alias.html"))
        self.build()
        _, man = load(self.out)
        self.assertNotIn("alias.html", [f["path"] for f in man["files"]])

    def test_the_real_source_tree_builds(self):
        out = os.path.join(self.tmp.name, "real.js")
        self.assertEqual(run_main(["--src", os.path.join(REPO, "src"), "--out", out]), 0)
        _, man = load(out)
        paths = [f["path"] for f in man["files"]]
        self.assertIn("index.html", paths)
        self.assertIn("manifest.webmanifest", paths)
        for hidden in ("sw.js", "sw-manifest.js", "package.json"):
            self.assertNotIn(hidden, paths)


if __name__ == "__main__":
    unittest.main()
