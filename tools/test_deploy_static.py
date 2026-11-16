# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for tools/deploy-static.sh. Temporary directories only: no network, no root, no live paths."""
import hashlib
import importlib.util
import os
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRIPT = os.path.join(HERE, "deploy-static.sh")
DATE = "20990101"

_spec = importlib.util.spec_from_file_location("build_sw_manifest", os.path.join(HERE, "build-sw-manifest.py"))
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)

FAKE_SRC = {
    "index.html": "<!doctype html><title>app</title>\n",
    "sw.js": "// worker\n",
    "config.json": '{"shipped": true}\n',
    "package.json": "{}\n",
    "manifest.webmanifest": "{}\n",
    "css/app.css": "body{}\n",
    "i18n/en.js": "export default {};\n",
    "js/app.js": "export {};\n",
    "js/views/a.js": "export {};\n",
    "vendor/ical.js": "// vendored\n",
    "vendor/SHA256SUMS": "deadbeef  ical.js\n",
    "vendor/other/SHA256SUMS": "deadbeef  x\n",
    "js/README.md": "# not deployed\n",
    "README.md": "# not deployed\n",
    "icons/.gitkeep": "",
    "js/SHA256SUMS": "kept: only excluded below vendor/\n",
}
EXPECT_EXCLUDED = {"package.json", "vendor/SHA256SUMS", "vendor/other/SHA256SUMS", "js/README.md", "README.md", "icons/.gitkeep"}


def write_tree(root, files):
    for rel, text in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)


def listing(root):
    out = {}
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            with open(full, "rb") as fh:
                out[os.path.relpath(full, root)] = hashlib.sha256(fh.read()).hexdigest()
    return out


class DeployBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="radui-deploytest-")
        self.addCleanup(self._tmp.cleanup)
        self.tmp = os.path.realpath(self._tmp.name)
        self.src = os.path.join(self.tmp, "src")
        self.dest = os.path.join(self.tmp, "www")
        self.bk = os.path.join(self.tmp, "backups")
        os.makedirs(self.src)
        os.makedirs(self.bk)
        write_tree(self.src, FAKE_SRC)

    def run_deploy(self, *args, env=None, cwd=None, src=True):
        full_env = dict(os.environ, RADUI_DEPLOY_DATE=DATE, TMPDIR=self.tmp)
        full_env.pop("RADUI_DEPLOY_TRACE", None)
        full_env.update(env or {})
        cmd = ["bash", SCRIPT] + (["--src", self.src] if src else []) + list(args)
        return subprocess.run(cmd, capture_output=True, text=True, env=full_env, cwd=cwd, timeout=120)

    def apply(self, *args, **kw):
        return self.run_deploy("--dest", self.dest, "--backup-dir", self.bk, "--apply", *args, **kw)

    def make_dest(self, files=None):
        os.makedirs(self.dest, exist_ok=True)
        write_tree(self.dest, files or {"old.html": "old\n", "config.json": '{"live": true}\n'})

    def backups(self):
        return sorted(os.listdir(self.bk))


class DryRun(DeployBase):
    def test_notice_when_the_source_is_not_a_build(self):
        res = self.run_deploy("--dest", self.dest, "--init")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("has no build-info.json", res.stdout)
        self.assertIn("make dist", res.stdout)

    def test_build_info_is_shown_for_a_build(self):
        write_tree(self.src, {"build-info.json": '{"minified": true, "source": "abc1234", "terser": "5.0.0"}\n'})
        res = self.run_deploy("--dest", self.dest, "--init")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertNotIn("has no build-info.json", res.stdout)
        self.assertIn("abc1234", res.stdout)
        self.assertIn("build-info.json", res.stdout)  # deployed like any other file

    def dirty_build(self):
        write_tree(self.src, {"build-info.json": '{"minified": true, "source": "abc1234-dirty", "terser": "5.0.0"}\n'})

    def test_dirty_build_warns_in_the_dry_run(self):
        self.dirty_build()
        res = self.run_deploy("--dest", self.dest, "--init")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("WARNING", res.stdout)
        self.assertIn("uncommitted", res.stdout)
        self.assertFalse(os.path.exists(self.dest))

    def test_clean_build_has_no_warning(self):
        write_tree(self.src, {"build-info.json": '{"minified": true, "source": "abc1234", "terser": "5.0.0"}\n'})
        res = self.run_deploy("--dest", self.dest, "--init")
        self.assertNotIn("WARNING", res.stdout)

    def test_dirty_build_refuses_apply_without_allow_dirty(self):
        self.dirty_build()
        self.make_dest()
        before = listing(self.dest)
        res = self.apply()
        self.assertEqual(res.returncode, 2)
        self.assertIn("dirty", res.stderr)
        self.assertEqual(listing(self.dest), before)
        self.assertEqual(self.backups(), [])

    def test_allow_dirty_deploys_with_the_warning(self):
        self.dirty_build()
        self.make_dest()
        res = self.apply("--allow-dirty")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("WARNING", res.stdout)
        self.assertEqual(len(self.backups()), 1)

    def test_dry_run_changes_nothing(self):
        self.make_dest()
        before_dest, before_src = listing(self.dest), listing(self.src)
        res = self.run_deploy("--dest", self.dest, "--backup-dir", self.bk)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("DRY RUN", res.stdout)
        self.assertIn("Nothing was changed", res.stdout)
        self.assertEqual(listing(self.dest), before_dest)
        self.assertEqual(listing(self.src), before_src)
        self.assertEqual(self.backups(), [])
        self.assertFalse(os.path.exists(os.path.join(self.src, "sw-manifest.js")))
        self.assertEqual([n for n in os.listdir(self.tmp) if n.startswith("radui-deploy.")], [])

    def test_dry_run_without_backup_dir_is_allowed(self):
        self.make_dest()
        res = self.run_deploy("--dest", self.dest)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_apply_needs_backup_dir(self):
        self.make_dest()
        res = self.run_deploy("--dest", self.dest, "--apply")
        self.assertEqual(res.returncode, 2)
        self.assertIn("--backup-dir is required", res.stderr)

    def test_help(self):
        res = self.run_deploy("--help", src=False)
        self.assertEqual(res.returncode, 0)
        self.assertIn("--dest DIR", res.stdout)

    def test_unknown_argument(self):
        res = self.run_deploy("--bogus", src=False)
        self.assertEqual(res.returncode, 2)


class Apply(DeployBase):
    def test_backup_name_mode_and_never_overwritten(self):
        self.make_dest()
        res = self.apply()
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        name = "www.before-ui-deploy-%s.tar.gz" % DATE
        self.assertEqual(self.backups(), [name])
        path = os.path.join(self.bk, name)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        listing_out = subprocess.run(["tar", "-tzf", path], capture_output=True, text=True).stdout
        self.assertIn("www/old.html", listing_out)
        self.assertIn("tar -xzf", res.stdout)
        self.assertIn(path, res.stdout)
        with open(path, "rb") as fh:
            original = fh.read()
        # a changed source on the same day with the same tag: refused, backup untouched, dest untouched
        write_tree(self.src, {"css/app.css": "body{color:red}\n"})
        before = listing(self.dest)
        res2 = self.apply()
        self.assertEqual(res2.returncode, 2)
        self.assertIn("never overwritten", res2.stderr)
        self.assertEqual(listing(self.dest), before)
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), original)
        # another tag works
        res3 = self.apply("--tag", "second")
        self.assertEqual(res3.returncode, 0, res3.stdout + res3.stderr)
        self.assertEqual(len(self.backups()), 2)

    def test_idempotent_second_run_makes_no_backup(self):
        self.make_dest()
        self.assertEqual(self.apply().returncode, 0)
        res = self.apply()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("unchanged", res.stdout)
        self.assertIn("Nothing to do", res.stdout)
        self.assertEqual(len(self.backups()), 1)

    def test_copy_order_late_files_last(self):
        self.make_dest()
        res = self.apply(env={"RADUI_DEPLOY_TRACE": "1"})
        self.assertEqual(res.returncode, 0, res.stderr)
        order = [l.split(" ", 2)[2] for l in res.stdout.splitlines() if l.startswith("TRACE copy ")]
        self.assertEqual(order[-3:], ["sw-manifest.js", "sw.js", "index.html"])
        self.assertEqual(len(order), len(set(order)))
        first_js = min(i for i, p in enumerate(order) if p.startswith("js/"))
        last_asset = max(i for i, p in enumerate(order[:-3]) if not p.startswith("js/"))
        self.assertLess(last_asset, first_js, "assets are copied before js/")
        self.assertNotIn("config.json", order, "an existing config.json is not copied")

    def test_first_install_with_init_copies_shipped_config(self):
        self.assertFalse(os.path.exists(self.dest))
        refused = self.run_deploy("--dest", self.dest, "--backup-dir", self.bk, "--apply")
        self.assertEqual(refused.returncode, 2)
        self.assertIn("--init", refused.stderr)
        self.assertFalse(os.path.exists(self.dest))
        res = self.apply("--init", env={"RADUI_DEPLOY_TRACE": "1"})
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        with open(os.path.join(self.dest, "config.json")) as fh:
            self.assertEqual(fh.read(), FAKE_SRC["config.json"])
        self.assertIn("TRACE copy config.json", res.stdout)
        self.assertEqual(self.backups(), [], "nothing existed, so nothing is backed up")
        self.assertTrue(os.path.isfile(os.path.join(self.dest, "sw-manifest.js")))

    def test_existing_config_json_is_preserved(self):
        self.make_dest()
        self.assertEqual(self.apply("--keep-config").returncode, 0)
        with open(os.path.join(self.dest, "config.json")) as fh:
            self.assertEqual(fh.read(), '{"live": true}\n')
        write_tree(self.src, {"config.json": '{"shipped": "changed"}\n'})
        self.assertEqual(self.apply("--tag", "again", "--prune").returncode, 0)
        with open(os.path.join(self.dest, "config.json")) as fh:
            self.assertEqual(fh.read(), '{"live": true}\n')

    def test_files_have_mode_644(self):
        self.make_dest()
        self.assertEqual(self.apply().returncode, 0)
        for rel in ("index.html", "js/app.js", "sw-manifest.js"):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dest, rel)).st_mode), 0o644, rel)

    def test_src_is_never_written(self):
        self.make_dest()
        before = listing(self.src)
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual(listing(self.src), before)

    def test_relative_dest_works(self):
        self.make_dest()
        res = self.run_deploy("--dest", "www", "--backup-dir", "backups", "--apply", cwd=self.tmp)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.dest, "index.html")))
        self.assertEqual(self.backups(), ["www.before-ui-deploy-%s.tar.gz" % DATE])

    def test_tampered_file_is_caught_after_copy(self):
        self.make_dest()
        res = self.apply(env={"RADUI_DEPLOY_TEST_TAMPER": "js/app.js"})
        self.assertEqual(res.returncode, 3)
        self.assertIn("VERIFICATION FAILED", res.stderr)
        self.assertIn("js/app.js (hash mismatch)", res.stderr)
        self.assertIn("tar -xzf", res.stderr)
        self.assertIn(os.path.join(self.bk, "www.before-ui-deploy-%s.tar.gz" % DATE), res.stderr)

    def test_tampered_sw_js_is_caught(self):
        self.make_dest()
        res = self.apply(env={"RADUI_DEPLOY_TEST_TAMPER": "sw.js"})
        self.assertEqual(res.returncode, 3)
        self.assertIn("sw.js", res.stderr)

    def test_rollback_command_restores_the_old_tree(self):
        self.make_dest({"old.html": "old\n", "index.html": "OLD INDEX\n", "config.json": "{}\n"})
        before = listing(self.dest)
        res = self.apply()
        self.assertEqual(res.returncode, 0, res.stderr)
        line = [l for l in res.stdout.splitlines() if l.strip().startswith("rollback:")][0]
        cmd = line.split("rollback:", 1)[1].strip()
        self.assertTrue(cmd.startswith("tar -xzf"))
        subprocess.run(cmd, shell=True, check=True)
        restored = listing(self.dest)
        for rel, digest in before.items():
            self.assertEqual(restored[rel], digest, rel)


class FirstWorkerRollback(DeployBase):
    """The live tree had no sw.js: a plain restore would leave the new worker in place (QC M6)."""

    SELFDESTRUCT = os.path.join(REPO, "deploy", "sw-selfdestruct.js")

    def rollback_lines(self, stdout):
        lines = stdout.splitlines()
        start = [i for i, l in enumerate(lines) if l.strip().startswith("rollback:")][0]
        out = [lines[start].split("rollback:", 1)[1].strip()]
        for l in lines[start + 1:]:
            t = l.strip()
            if t.startswith(("rm ", "install ")):
                out.append(t)
            else:
                break
        return out

    def test_backup_without_sw_js_prints_the_self_removing_worker_steps(self):
        self.make_dest({"old.html": "old\n", "config.json": "{}\n"})
        res = self.apply()
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        steps = self.rollback_lines(res.stdout)
        self.assertEqual(len(steps), 3, res.stdout)
        self.assertTrue(steps[0].startswith("tar -xzf"))
        self.assertEqual(steps[1], "rm -f '%s/sw-manifest.js'" % self.dest)
        self.assertEqual(steps[2], "install -m 0644 '%s' '%s/sw.js'" % (self.SELFDESTRUCT, self.dest))
        self.assertIn("sw-selfdestruct.js", res.stdout)
        self.assertIn("no-cache", res.stdout)
        self.assertTrue(os.path.isfile(self.SELFDESTRUCT))

    def test_the_printed_steps_really_remove_the_new_worker(self):
        self.make_dest({"old.html": "old\n", "config.json": "{}\n"})
        res = self.apply()
        self.assertEqual(res.returncode, 0, res.stderr)
        for step in self.rollback_lines(res.stdout):
            subprocess.run(step, shell=True, check=True)
        self.assertFalse(os.path.exists(os.path.join(self.dest, "sw-manifest.js")))
        with open(os.path.join(self.dest, "sw.js"), "rb") as a, open(self.SELFDESTRUCT, "rb") as b:
            self.assertEqual(a.read(), b.read())
        self.assertTrue(os.path.exists(os.path.join(self.dest, "old.html")))

    def test_backup_with_sw_js_needs_no_extra_steps(self):
        self.make_dest({"old.html": "old\n", "sw.js": "// previous worker\n", "config.json": "{}\n"})
        res = self.apply()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(len(self.rollback_lines(res.stdout)), 1)
        self.assertNotIn("selfdestruct", res.stdout)

    def test_failed_verification_also_prints_the_worker_steps(self):
        self.make_dest({"old.html": "old\n", "config.json": "{}\n"})
        res = self.apply(env={"RADUI_DEPLOY_TEST_TAMPER": "js/app.js"})
        self.assertEqual(res.returncode, 3)
        self.assertIn("sw-selfdestruct.js", res.stderr)
        self.assertIn("rm -f", res.stderr)

    def test_first_installation_mentions_the_worker_too(self):
        res = self.apply("--init")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("nothing to restore", res.stdout)
        self.assertIn("sw-selfdestruct.js", res.stdout)


class Prune(DeployBase):
    def extra(self):
        write_tree(self.dest, {"stale.js": "x\n", "gone/dir/old.css": "x\n"})

    def test_default_keeps_unknown_files(self):
        self.make_dest()
        self.extra()
        res = self.apply()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.dest, "stale.js")))
        self.assertIn("kept; add --prune", res.stdout)

    def test_dry_run_with_prune_lists_but_keeps(self):
        self.make_dest()
        self.extra()
        res = self.run_deploy("--dest", self.dest, "--prune")
        self.assertIn("files to delete (--prune): 3", res.stdout)
        self.assertTrue(os.path.exists(os.path.join(self.dest, "stale.js")))

    def test_prune_removes_unknown_files_but_never_config_json(self):
        self.make_dest()
        self.extra()
        res = self.apply("--prune")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.dest, "stale.js")))
        self.assertFalse(os.path.exists(os.path.join(self.dest, "old.html")))
        self.assertFalse(os.path.exists(os.path.join(self.dest, "gone")), "empty directories go too")
        self.assertTrue(os.path.exists(os.path.join(self.dest, "config.json")))

    def test_prune_only_run_still_backs_up(self):
        self.make_dest()
        self.assertEqual(self.apply().returncode, 0)
        self.extra()
        res = self.apply("--prune", "--tag", "prune")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(len(self.backups()), 2)
        self.assertFalse(os.path.exists(os.path.join(self.dest, "stale.js")))


class ExclusionLists(DeployBase):
    def deployed(self):
        found = set()
        for dirpath, _d, names in os.walk(self.dest):
            for n in names:
                found.add(os.path.relpath(os.path.join(dirpath, n), self.dest).replace(os.sep, "/"))
        return found

    def test_fake_tree_matches_the_generator(self):
        self.make_dest({"x": "x\n"})
        self.assertEqual(self.apply("--prune").returncode, 0)
        expected = {e["path"] for e in gen.collect(self.src)} | {"sw.js", "sw-manifest.js"}
        self.assertEqual(self.deployed(), expected)
        for rel in EXPECT_EXCLUDED:
            self.assertNotIn(rel, self.deployed())
        self.assertIn("js/SHA256SUMS", self.deployed())  # excluded only below vendor/

    def test_real_source_tree_matches_the_generator(self):
        real = os.path.join(REPO, "src")
        self.make_dest({"x": "x\n"})
        res = subprocess.run(
            ["bash", SCRIPT, "--src", real, "--dest", self.dest, "--backup-dir", self.bk, "--apply", "--prune"],
            capture_output=True, text=True, env=dict(os.environ, RADUI_DEPLOY_DATE=DATE, TMPDIR=self.tmp), timeout=120,
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        expected = {e["path"] for e in gen.collect(real)} | {"sw.js", "sw-manifest.js"}
        self.assertEqual(self.deployed(), expected)
        # the deployed manifest lists exactly the deployed files (minus the two special ones)
        with open(os.path.join(self.dest, "sw-manifest.js"), encoding="utf-8") as fh:
            text = fh.read()
        for path in expected - {"sw.js", "sw-manifest.js"}:
            self.assertIn('"path": "%s"' % path, text)
        for path in ("sw.js", "sw-manifest.js", "package.json"):
            self.assertNotIn('"path": "%s"' % path, text)

    def test_generator_exclusion_rules_have_not_drifted(self):
        # if the generator learns a new exclusion, this test and deploy-static.sh must be updated together
        self.assertEqual(gen.ROOT_EXCLUDED, {"sw.js", "sw-manifest.js", "package.json"})
        self.assertEqual(gen.ANYWHERE_EXCLUDED, {".gitkeep", "README.md"})
        for rel in EXPECT_EXCLUDED:
            self.assertTrue(gen.excluded(rel), rel)
        self.assertFalse(gen.excluded("js/SHA256SUMS"))
        self.assertFalse(gen.excluded("js/package.json"))


class UnsafeDest(DeployBase):
    def refuses(self, dest, *extra):
        res = self.run_deploy("--dest", dest, *extra)
        self.assertEqual(res.returncode, 2, "%r: %s" % (dest, res.stdout + res.stderr))
        return res

    def test_empty_and_blank(self):
        self.assertIn("empty", self.refuses("").stderr)
        self.assertIn("empty", self.refuses("   ").stderr)

    def test_root_and_system_directories(self):
        for bad in ("/", "//", "/etc", "/usr", "/var", "/var/www", "/home", "/tmp", "/opt"):
            self.assertIn("refusing", self.refuses(bad).stderr, bad)
        self.assertIn("refusing", self.refuses("/etc/../").stderr)
        self.assertIn("refusing", self.refuses(self.tmp + "/../../../..", "--init").stderr)

    def test_home_directory(self):
        self.assertIn("home", self.refuses(os.path.expanduser("~")).stderr)

    def test_dest_inside_or_around_src(self):
        self.assertIn("inside --src", self.refuses(os.path.join(self.src, "css"), "--init").stderr)
        self.assertIn("contains --src", self.refuses(self.tmp).stderr)

    def test_dest_is_a_file(self):
        path = os.path.join(self.tmp, "afile")
        write_tree(self.tmp, {"afile": "x"})
        self.assertIn("not a directory", self.refuses(path).stderr)

    def test_backup_dir_inside_dest(self):
        self.make_dest()
        inner = os.path.join(self.dest, "bk")
        os.makedirs(inner)
        res = self.run_deploy("--dest", self.dest, "--backup-dir", inner, "--apply")
        self.assertEqual(res.returncode, 2)
        self.assertIn("inside --dest", res.stderr)

    def test_missing_dest_argument(self):
        res = self.run_deploy()
        self.assertEqual(res.returncode, 2)
        self.assertIn("--dest is required", res.stderr)

    def test_source_without_index_html(self):
        os.remove(os.path.join(self.src, "index.html"))
        self.make_dest()
        res = self.run_deploy("--dest", self.dest)
        self.assertEqual(res.returncode, 2)

    def test_bad_tag(self):
        self.make_dest()
        res = self.run_deploy("--dest", self.dest, "--tag", "a/b")
        self.assertEqual(res.returncode, 2)


if __name__ == "__main__":
    unittest.main()
