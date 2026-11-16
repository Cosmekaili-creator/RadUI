# SPDX-License-Identifier: AGPL-3.0-or-later
"""M3: the self-heal pass and its timer thread (fake prober, fault injection on
the managed files; the live version is in tests/integration)."""
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import helpers  # noqa: E402
import test_fix_common as C  # noqa: E402
from radui_admin import config, filewrite, generator  # noqa: E402
from radui_admin import model as M  # noqa: E402
from radui_admin import server  # noqa: E402
from radui_admin import validate_candidate as vc  # noqa: E402

NOW = helpers.NOW


class Env:
    def __init__(self, test, **kw):
        self.calls = []
        self.fail = None
        self.root = C.tmp_root(test)

        def validator(model, rights, users):
            self.calls.append(model.generation)
            if self.fail:
                raise vc.CandidateRejected([self.fail])
        self.store = apihelpers.make_store(self.root, validator=validator, **kw)
        self.cfg = self.store.cfg
        self.store.install_initial(C.base_builder().m, probe=False)
        self.calls.clear()

    def expected(self):
        rights, users, _ = generator.generate(self.store.load_model())
        return rights.encode(), users.encode()

    def create(self, login):
        return self.store.apply(lambda old: M.create_account(
            old, login=login, display_name=login.title(),
            hash=helpers.fake_hash(login), now=NOW, by="alice"),
            actor="alice")

    def lines(self, event):
        return [e for e in self.store.test_stream.events()
                if e["event"] == event]

    def damage(self):
        with open(self.cfg.rights_path, "r+b") as fh:   # a torn in-place write
            size = fh.seek(0, os.SEEK_END)
            fh.truncate(size // 2)


class SelfHealPass(unittest.TestCase):
    def test_nothing_to_do_when_files_are_right_and_active(self):
        env = Env(self)
        before = C.read(env.cfg.rights_path)
        self.assertEqual(env.store.self_heal()["state"], "ok")
        self.assertEqual(C.read(env.cfg.rights_path), before)
        self.assertEqual(env.calls, [])
        self.assertEqual(env.lines("self-heal"), [])

    def test_a_damaged_rights_file_is_rewritten_after_validation(self):
        env = Env(self)
        env.damage()
        self.assertNotEqual(C.read(env.cfg.rights_path), env.expected()[0])
        out = env.store.self_heal()
        self.assertEqual(out["state"], "rolled_forward")
        self.assertEqual((C.read(env.cfg.rights_path),
                          C.read(env.cfg.users_path)), env.expected())
        self.assertEqual(env.calls, [env.store.load_model().generation])
        line = env.lines("self-heal")[-1]
        self.assertEqual((line["result"], line["actor"]),
                         ("rolled_forward", "system"))
        self.assertEqual(env.store.self_heal()["state"], "ok")   # and stays ok

    def test_a_missing_or_emptied_file_heals_too(self):
        for how in ("remove", "empty", "garbage"):
            env = Env(self)
            if how == "remove":
                os.unlink(env.cfg.users_path)
            else:
                with open(env.cfg.rights_path, "wb") as fh:
                    fh.write(b"" if how == "empty" else b"[x]\nuser: .*\n")
            self.assertEqual(env.store.self_heal()["state"], "rolled_forward",
                             how)
            self.assertEqual((C.read(env.cfg.rights_path),
                              C.read(env.cfg.users_path)), env.expected(), how)

    def test_a_revert_to_an_older_generation_heals(self):
        env = Env(self)
        env.create("late-1")
        old_rights, old_users = C.read(env.cfg.rights_path), \
            C.read(env.cfg.users_path)
        env.create("late-2")
        env.store.prober.active = False            # Radicale runs the old rules
        for path, data in ((env.cfg.rights_path, old_rights),
                           (env.cfg.users_path, old_users),
                           (env.cfg.lkg_path, old_rights)):
            with open(path, "wb") as fh:
                fh.write(data)
        out = env.store.self_heal()
        self.assertEqual(out["state"], "rolled_forward")
        self.assertEqual((C.read(env.cfg.rights_path),
                          C.read(env.cfg.users_path)), env.expected())
        self.assertIn(b"late-2", C.read(env.cfg.users_path))
        self.assertEqual(env.lines("self-heal")[-1]["generation"],
                         env.store.load_model().generation)

    def test_inactive_with_correct_files_rewrites_once_per_generation(self):
        env = Env(self)
        env.store.prober.active = False            # Radicale is down
        writes = []
        real = env.store._write_managed
        env.store._write_managed = lambda p, t: (writes.append(p), real(p, t))
        first = env.store.self_heal()
        self.assertEqual(first["state"], "rolled_forward")
        n = len(writes)
        self.assertGreaterEqual(n, 2)
        self.assertEqual(env.store.self_heal()["state"], "inactive")
        self.assertEqual(env.store.self_heal()["state"], "inactive")
        self.assertEqual(len(writes), n)           # no rewrite storm
        env.create("late-1")                       # a new generation: new try
        env.store.prober.active = False
        writes.clear()
        self.assertEqual(env.store.self_heal()["state"], "rolled_forward")
        env.store.prober.active = True
        self.assertEqual(env.store.self_heal()["state"], "ok")

    def test_validation_failure_writes_nothing_and_is_logged_once(self):
        env = Env(self)
        env.damage()
        broken = C.read(env.cfg.rights_path)
        env.fail = "probe mismatch"
        for _ in range(3):
            out = env.store.self_heal()
            self.assertEqual(out["state"], "validation_failed")
            self.assertEqual(C.read(env.cfg.rights_path), broken)
        self.assertEqual(len(env.lines("self-heal")), 1)
        env.fail = None
        self.assertEqual(env.store.self_heal()["state"], "rolled_forward")

    def test_model_error_is_reported_and_changes_nothing(self):
        env = Env(self)
        env.damage()
        broken = C.read(env.cfg.rights_path)
        with open(env.cfg.model_path, "w") as fh:
            fh.write("garbage")
        self.assertEqual(env.store.self_heal()["state"], "model_error")
        self.assertEqual(C.read(env.cfg.rights_path), broken)

    def test_it_never_runs_with_a_mutation_in_progress(self):
        env = Env(self)
        inside, release = threading.Event(), threading.Event()
        real = env.store._validator

        def slow(model, rights, users):
            inside.set()
            self.assertTrue(release.wait(10))
            real(model, rights, users)
        env.store._validator = slow
        env.damage()                              # tempting to repair ...
        broken = C.read(env.cfg.rights_path)
        t = threading.Thread(target=env.create, args=("late-1",))
        t.start()
        self.addCleanup(t.join, 10)
        self.addCleanup(release.set)
        self.assertTrue(inside.wait(10))
        self.assertEqual(env.store.self_heal()["state"], "busy")
        self.assertEqual(C.read(env.cfg.rights_path), broken)
        release.set()
        t.join(10)
        # the mutation itself rewrote everything; nothing left to heal
        self.assertEqual(env.store.self_heal()["state"], "ok")

    def test_the_cli_flock_also_blocks_it(self):
        import fcntl
        env = Env(self)
        env.damage()
        fd = os.open(env.cfg.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.assertEqual(env.store.self_heal()["state"], "busy")
        fcntl.flock(fd, fcntl.LOCK_UN)
        self.assertEqual(env.store.self_heal()["state"], "rolled_forward")


class Timer(unittest.TestCase):
    def wait_for(self, cond, seconds=10):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if cond():
                return True
            time.sleep(0.02)
        return cond()

    def test_the_thread_repairs_damage_and_stops_cleanly(self):
        env = Env(self)
        healer = server.SelfHealer(env.store, 0.05)
        self.assertTrue(healer.start())
        self.addCleanup(healer.stop)
        self.assertFalse(healer.start())           # only once
        time.sleep(0.2)
        self.assertEqual(env.lines("self-heal"), [])   # healthy: silent
        env.damage()
        self.assertTrue(self.wait_for(
            lambda: C.read(env.cfg.rights_path) == env.expected()[0]
            and env.lines("self-heal")))       # the line follows the rewrite
        self.assertEqual(len(env.lines("self-heal")), 1)
        t0 = time.monotonic()
        healer.stop()
        self.assertLess(time.monotonic() - t0, 2)
        self.assertFalse(healer._thread.is_alive())
        env.damage()                               # a stopped thread repairs nothing
        time.sleep(0.3)
        self.assertNotEqual(C.read(env.cfg.rights_path), env.expected()[0])

    def test_stop_returns_promptly_even_with_a_long_interval(self):
        env = Env(self)
        healer = server.SelfHealer(env.store, 3600)
        healer.start()
        t0 = time.monotonic()
        healer.stop()
        self.assertLess(time.monotonic() - t0, 2)
        self.assertFalse(healer._thread.is_alive())

    def test_interval_zero_is_off(self):
        env = Env(self)
        healer = server.SelfHealer(env.store, 0)
        self.assertFalse(healer.start())
        self.assertIsNone(healer._thread)
        healer.stop()
        env.damage()
        time.sleep(0.2)
        self.assertNotEqual(C.read(env.cfg.rights_path), env.expected()[0])

    def test_an_exception_in_a_pass_does_not_kill_the_thread(self):
        env = Env(self)
        count = []

        def boom():
            count.append(1)
            if len(count) == 1:
                raise RuntimeError("injected")
            return {"state": "ok"}
        env.store.self_heal = boom
        healer = server.SelfHealer(env.store, 0.03)
        healer.start()
        self.addCleanup(healer.stop)
        self.assertTrue(self.wait_for(lambda: len(count) >= 3))
        self.assertTrue(healer._thread.is_alive())
        self.assertEqual(env.lines("self-heal")[0]["result"],
                         "error:RuntimeError")

    def test_a_mutation_and_the_thread_never_overlap(self):
        env = Env(self)
        healer = server.SelfHealer(env.store, 0.01)
        healer.start()
        self.addCleanup(healer.stop)
        for i in range(8):
            env.create("late-%d" % i)
        self.assertEqual(C.read(env.cfg.rights_path), env.expected()[0])
        self.assertEqual(env.store.reconcile(probe=False)["state"], "ok")
        self.assertEqual(env.lines("self-heal"), [])


class Config(unittest.TestCase):
    base = {"allowed_hosts": ["example.org"]}

    def test_defaults_and_ranges(self):
        c = config.from_dict(self.base)
        self.assertEqual((c.self_heal_interval_s, c.allow_unchecked_users),
                         (60.0, False))
        for v in (0, 1, 60, 86400, 2.5):
            self.assertEqual(config.from_dict(dict(
                self.base, self_heal_interval_s=v)).self_heal_interval_s,
                float(v))
        for bad in (-1, 0.5, 86401, "60", True, None):
            with self.assertRaises(config.ConfigError, msg=repr(bad)):
                config.from_dict(dict(self.base, self_heal_interval_s=bad))
        for bad in (1, "true", None):
            with self.assertRaises(config.ConfigError, msg=repr(bad)):
                config.from_dict(dict(self.base, allow_unchecked_users=bad))
        self.assertTrue(config.from_dict(dict(
            self.base, allow_unchecked_users=True)).allow_unchecked_users)

    def test_example_config_and_deploy_template_still_load(self):
        import tomllib
        repo = helpers.REPO
        with open(os.path.join(repo, "backend", "config.example.toml"),
                  "rb") as fh:
            c = config.from_dict(tomllib.load(fh))
        self.assertEqual(c.self_heal_interval_s, 60.0)
        self.assertEqual(c.trusted_proxies, ("127.0.0.1/32", "::1/128"))
        self.assertFalse(c.allow_unchecked_users)


if __name__ == "__main__":
    unittest.main()
