# SPDX-License-Identifier: AGPL-3.0-or-later
"""m6: an intent record (event, actor, target, ip) is written into the
generation directory before a change is published, and a roll-forward writes
the audit line of the interrupted change from it. m4: an unchecked users file
fails the validation unless ``allow_unchecked_users`` is set."""
import argparse
import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import helpers  # noqa: E402
import test_fix_common as C  # noqa: E402
from radui_admin import cli, filewrite, generator  # noqa: E402
from radui_admin import model as M  # noqa: E402
from radui_admin import validate_candidate as vc  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402

NOW = helpers.NOW
INTENT = filewrite.make_intent("account.create", "alice", "carol", "203.0.113.7")


class Env:
    def __init__(self, test, **kw):
        self.crash_at = None
        self.raise_at = None
        self.root = C.tmp_root(test)
        self.store = apihelpers.make_store(self.root, fault=self._fault, **kw)
        self.cfg = self.store.cfg
        self.store.install_initial(C.base_builder().m, probe=False)

    def _fault(self, point):
        if point == self.crash_at:
            raise filewrite.Crash(point)
        if point == self.raise_at:
            raise OSError("injected at " + point)

    def create(self, login="carol-2", intent=INTENT):
        return self.store.apply(lambda old: M.create_account(
            old, login=login, display_name=login.title(),
            hash=helpers.fake_hash(login), now=NOW, by="alice"),
            actor="alice", intent=intent)

    def gen_dir(self, n=None):
        n = n or self.store.load_model().generation
        return os.path.join(self.cfg.generations_dir, str(n))


class IntentRecord(unittest.TestCase):
    def test_a_published_generation_holds_its_intent(self):
        env = Env(self)
        env.create()
        got = C.read_json(os.path.join(env.gen_dir(), "intent.json"))
        self.assertEqual(got, {"event": "account.create", "actor": "alice",
                               "target": "carol", "ip": "203.0.113.7"})
        self.assertEqual(oct(os.stat(os.path.join(
            env.gen_dir(), "intent.json")).st_mode & 0o777), "0o600")

    def test_through_the_api_the_intent_is_the_request(self):
        fx = apihelpers.ApiFixture(C.tmp_root(self))
        r = fx.call("POST", "/accounts", body={
            "login": "carol-2", "displayName": "C", "generate": True})
        self.assertEqual(r.status, 201)
        n = fx.store.load_model().generation
        got = C.read_json(os.path.join(fx.store.cfg.generations_dir, str(n),
                                       "intent.json"))
        self.assertEqual(got, {"event": "account.create", "actor": "alice",
                               "target": "carol-2", "ip": "127.0.0.1"})
        text = json.dumps(got)
        self.assertNotIn("password", text)
        self.assertNotIn("$2", text)

    def test_the_default_intent_has_the_generic_event(self):
        env = Env(self)
        env.create(intent=None)
        got = C.read_json(os.path.join(env.gen_dir(), "intent.json"))
        self.assertEqual((got["event"], got["actor"]),
                         (filewrite.GENERIC_EVENT, "alice"))

    def test_values_are_clipped_and_strings(self):
        got = filewrite.make_intent("e" * 500, None, 12, "x")
        self.assertEqual(len(got["event"]), 200)
        self.assertEqual((got["actor"], got["target"]), (None, "12"))

    def test_a_failed_change_leaves_no_generation_directory(self):
        for point in ("before_model", "after_model", "after_generation",
                      "after_first_file"):
            env = Env(self)
            gens = env.store.generation_numbers()
            env.raise_at = point
            with self.assertRaises(OSError):
                env.create()
            self.assertEqual(env.store.generation_numbers(), gens, point)


class RollForwardUsesTheIntent(unittest.TestCase):
    def crash(self, point, **kw):
        env = Env(self, **kw)
        env.crash_at = point
        with self.assertRaises(filewrite.Crash):
            env.create()
        return env

    def test_crash_points_replay_the_original_event(self):
        for point in ("after_model", "after_generation", "after_first_file"):
            env = self.crash(point)
            fresh = C.fresh_store(env.store)          # the restarted process
            out = fresh.reconcile(probe=False)
            self.assertEqual(out["state"], "rolled_forward", point)
            lines = fresh.test_stream.events()
            self.assertEqual(len(lines), 1, (point, lines))
            line = lines[0]
            self.assertEqual((line["event"], line["actor"], line["target"],
                              line["ip"], line["result"]),
                             ("account.create", "alice", "carol", "203.0.113.7",
                              "rolled_forward"), point)
            self.assertEqual(line["generation"],
                             fresh.load_model().generation)
            # replayed once only
            self.assertEqual(fresh.reconcile(probe=False)["state"], "ok")
            self.assertEqual(len(fresh.test_stream.events()), 1)
            gdir = env.gen_dir()
            self.assertTrue(os.path.exists(os.path.join(
                gdir, "intent.replayed.json")))
            self.assertFalse(os.path.exists(os.path.join(gdir, "intent.json")))
            rights, users, _ = generator.generate(fresh.load_model())
            self.assertEqual(C.read(env.cfg.rights_path), rights.encode())

    def test_crash_before_the_model_leaves_nothing_behind_after_reconcile(self):
        env = self.crash("before_model")
        self.assertTrue(os.path.isdir(env.gen_dir(env.store.load_model()
                                                   .generation + 1)))
        gens_listed = env.store.generation_numbers()
        fresh = C.fresh_store(env.store)
        self.assertEqual(fresh.reconcile(probe=False)["state"], "ok")
        self.assertEqual(fresh.test_stream.events(), [])
        self.assertEqual(fresh.generation_numbers(), gens_listed[:-1])

    def test_a_generation_with_a_model_is_never_dropped_as_an_orphan(self):
        env = self.crash("after_model")
        fresh = C.fresh_store(env.store)
        fresh.reconcile(probe=False)
        self.assertIn(fresh.load_model().generation,
                      fresh.generation_numbers())
        self.assertTrue(os.path.exists(os.path.join(
            env.gen_dir(), "model.json")))

    def test_generic_or_damaged_intents_give_the_generic_line(self):
        env = self.crash("after_generation")
        with open(os.path.join(env.gen_dir(), "intent.json"), "w") as fh:
            fh.write('{"event": 5}')
        fresh = C.fresh_store(env.store)
        self.assertEqual(fresh.reconcile(probe=False)["state"], "rolled_forward")
        line = fresh.test_stream.events()[0]
        self.assertEqual((line["event"], line["actor"]), ("reconcile", "system"))
        env = Env(self)
        env.crash_at = "after_first_file"
        with self.assertRaises(filewrite.Crash):
            env.create(intent=None)
        fresh = C.fresh_store(env.store)
        fresh.reconcile(probe=False)
        self.assertEqual(fresh.test_stream.events()[0]["event"], "reconcile")

    def test_a_stale_intent_of_an_abandoned_attempt_is_overwritten(self):
        env = self.crash("before_model")          # intent of attempt 1 left over
        env.crash_at = None
        env.create("carol-3", intent=filewrite.make_intent(
            "account.create", "alice", "carol-3", "198.51.100.1"))
        got = C.read_json(os.path.join(env.gen_dir(), "intent.json"))
        self.assertEqual(got["target"], "carol-3")

    def test_restore_and_import_carry_their_own_events(self):
        env = Env(self)
        base = env.store.load_model().generation
        got = C.read_json(os.path.join(env.gen_dir(base), "intent.json"))
        self.assertEqual(got["event"], "import")
        env.create()
        env.store.restore(base, "alice", intent=filewrite.make_intent(
            "generation.restore", "alice", "generation %d" % base, "127.0.0.1"))
        got = C.read_json(os.path.join(env.gen_dir(), "intent.json"))
        self.assertEqual((got["event"], got["target"]),
                         ("generation.restore", "generation %d" % base))


class UsersCheck(unittest.TestCase):
    """m4: ``users_checked`` False is a failure unless allowed."""

    def store(self, **cfg):
        root = C.tmp_root(self)
        stream = apihelpers.ListStream()
        c = apihelpers.make_cfg(root, **cfg)
        from radui_admin.audit import Audit
        s = filewrite.Store(c, audit=Audit(stream),
                            prober=apihelpers.FakeProber(c, True))
        return s

    def result(self, checked):
        return vc.Result("3.x", 10, checked)

    def test_writer_refuses_when_the_users_check_could_not_run(self):
        s = self.store()
        m = C.base_builder().m
        with mock.patch.object(filewrite.vc, "validate",
                               return_value=self.result(False)):
            with self.assertRaises(ApiError) as cm:
                s.install_initial(m, probe=False)
        self.assertEqual(cm.exception.reason, "candidate_rejected")
        self.assertIn("users file could not be checked",
                      " ".join(cm.exception.detail))
        self.assertFalse(os.path.exists(s.cfg.model_path))
        self.assertFalse(os.path.exists(s.cfg.users_path))

    def test_writer_accepts_it_when_allowed(self):
        s = self.store(allow_unchecked_users=True)
        with mock.patch.object(filewrite.vc, "validate",
                               return_value=self.result(False)):
            s.install_initial(C.base_builder().m, probe=False)
        self.assertTrue(os.path.exists(s.cfg.model_path))

    def test_writer_accepts_a_checked_result_by_default(self):
        s = self.store()
        with mock.patch.object(filewrite.vc, "validate",
                               return_value=self.result(True)):
            s.install_initial(C.base_builder().m, probe=False)
        self.assertTrue(os.path.exists(s.cfg.model_path))

    def test_reconcile_and_self_heal_use_the_same_rule(self):
        env_store = apihelpers.make_store(C.tmp_root(self))
        env_store.install_initial(C.base_builder().m, probe=False)
        os.unlink(env_store.cfg.users_path)
        env_store._validator = None
        with mock.patch.object(filewrite.vc, "validate",
                               return_value=self.result(False)):
            out = env_store.self_heal()
        self.assertEqual(out["state"], "validation_failed")
        self.assertIn("could not be checked", out["detail"])
        self.assertFalse(os.path.exists(env_store.cfg.users_path))

    def check(self, store, **kw):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.cmd_check(store, store.cfg, argparse.Namespace())
        return rc, out.getvalue()

    def test_check_radicale_fails_with_a_clear_message(self):
        store = apihelpers.make_store(C.tmp_root(self))
        store.install_initial(C.base_builder().m, probe=False)
        with mock.patch.object(cli.vc, "validate_files",
                               return_value=self.result(False)):
            rc, out = self.check(store)
        self.assertEqual(rc, cli.EX_FAIL)
        self.assertIn("FAIL", out)
        self.assertIn("users file could not be checked", out)
        self.assertIn("allow_unchecked_users", out)
        with mock.patch.object(cli.vc, "validate_files",
                               return_value=self.result(True)):
            rc, out = self.check(store)
        self.assertEqual(rc, cli.EX_OK)
        self.assertIn("users compared", out)

    def test_check_radicale_passes_when_allowed(self):
        store = apihelpers.make_store(C.tmp_root(self),
                                      allow_unchecked_users=True)
        store.install_initial(C.base_builder().m, probe=False)
        with mock.patch.object(cli.vc, "validate_files",
                               return_value=self.result(False)):
            rc, out = self.check(store)
        self.assertEqual(rc, cli.EX_OK)
        self.assertIn("parsed only", out)


if __name__ == "__main__":
    unittest.main()
