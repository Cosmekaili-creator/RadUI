# SPDX-License-Identifier: AGPL-3.0-or-later
"""filewrite.py: write protocol, ordering, fault injection, reconcile."""
import os
import stat
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import helpers  # noqa: E402
from radui_admin import filewrite, generator  # noqa: E402
from radui_admin import model as M  # noqa: E402
from radui_admin import validate_candidate as vc  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402

NOW = helpers.NOW


def base_builder():
    return (helpers.Builder().account("alice", admin=True).account("bob")
            .account("agent-1", type="bot").grant("bob", "cal", "agent-1", "read"))


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


class Env:
    def __init__(self, test, **kw):
        self.root = apihelpers.make_dir(test)
        self.faults = []
        self.crash_at = None
        self.raise_at = None
        self.store = apihelpers.make_store(self.root, fault=self._fault, **kw)
        self.cfg = self.store.cfg
        self.store.install_initial(base_builder().m, probe=False)

    def _fault(self, point):
        self.faults.append(point)
        if point == self.crash_at:
            raise filewrite.Crash(point)
        if point == self.raise_at:
            raise OSError("injected at " + point)

    def files(self):
        return {n: read(p) for n, p in (("model", self.cfg.model_path),
                                        ("rights", self.cfg.rights_path),
                                        ("users", self.cfg.users_path))}

    def create(self, login="carol", **kw):
        return self.store.apply(lambda old: M.create_account(
            old, login=login, display_name=login.title(),
            hash=helpers.fake_hash(login), now=NOW, by="alice", **kw),
            actor="alice")

    def disable(self, login="bob"):
        return self.store.apply(lambda old: M.disable_account(
            old, login, now=NOW, by="alice"), actor="alice")


class WriteOrder(unittest.TestCase):
    def setUp(self):
        self.env = Env(self)
        self.order = []
        real = filewrite.atomic_write

        def spy(path, data, mode=0o640, gid=None):
            where = os.path.dirname(path)
            if where in (self.env.cfg.managed_dir, self.env.cfg.state_dir):
                self.order.append(os.path.basename(path))
            return real(path, data, mode, gid)
        p = mock.patch.object(filewrite, "atomic_write", spy)
        p.start()
        self.addCleanup(p.stop)

    def managed(self):
        return [n for n in self.order if n in ("users", "rights")]

    def test_create_writes_rights_first(self):
        self.env.create()
        self.assertEqual(self.managed(), ["rights", "users"])

    def test_disable_writes_users_first(self):
        self.env.disable("bob")
        self.assertEqual(self.managed(), ["users", "rights"])

    def test_delete_writes_users_first(self):
        self.env.store.apply(lambda old: M.delete_account(
            old, "bob", now=NOW, by="alice"), actor="alice")
        self.assertEqual(self.managed(), ["users", "rights"])

    def test_grant_revoke_and_password_change_write_rights_first(self):
        self.env.store.apply(lambda old: M.put_grant(
            old, owner="bob", collection="cal", grantee="agent-1",
            level="none", now=NOW, by="alice"), actor="alice")
        self.assertEqual(self.managed(), ["rights", "users"])

    def test_model_and_generation_before_managed_files(self):
        self.env.create()
        self.assertEqual(self.order[0], "model.json")
        self.assertLess(self.order.index("model.json"),
                        self.order.index("rights"))
        self.assertEqual(self.order[-1], "rights.lkg")

    def test_managed_files_never_missing_during_write(self):
        seen = []

        def check(point):
            seen.append((point, os.path.exists(self.env.cfg.rights_path),
                         os.path.exists(self.env.cfg.users_path)))
        self.env.store._fault = check
        self.env.create()
        self.env.disable("bob")
        self.assertTrue(seen)
        self.assertTrue(all(r and u for _, r, u in seen), seen)

    def test_no_temp_files_left(self):
        self.env.create()
        for d in (self.env.cfg.managed_dir, self.env.cfg.state_dir):
            self.assertEqual([n for n in os.listdir(d) if n.endswith(".tmp")],
                             [])


class Basics(unittest.TestCase):
    def setUp(self):
        self.env = Env(self)

    def test_install_writes_everything_with_modes(self):
        cfg = self.env.cfg
        gen = self.env.store.load_model().generation
        for path in (cfg.rights_path, cfg.users_path):
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(os.stat(cfg.model_path).st_mode), 0o600)
        gdir = os.path.join(cfg.generations_dir, str(gen))
        self.assertEqual(sorted(os.listdir(gdir)),
                         ["BASELINE", "intent.json", "model.json", "rights",
                          "users"])
        self.assertEqual(read(os.path.join(gdir, "rights")),
                         read(cfg.rights_path))
        self.assertFalse(os.path.exists(cfg.lkg_path))  # no probe at import

    def test_install_refuses_to_overwrite(self):
        with self.assertRaises(ApiError) as cm:
            self.env.store.install_initial(base_builder().m)
        self.assertEqual(cm.exception.code, "exists")

    def test_apply_bumps_generation_and_writes_lkg_only_when_active(self):
        before = self.env.store.load_model().generation
        res = self.env.create()
        self.assertEqual(res.new.generation, before + 1)
        self.assertTrue(res.active)
        self.assertEqual(read(self.env.cfg.lkg_path),
                         read(self.env.cfg.rights_path))

    def test_lkg_not_written_when_probe_fails(self):
        env = Env(self, active=False)
        res = env.create()
        self.assertFalse(res.active)
        self.assertFalse(os.path.exists(env.cfg.lkg_path))
        self.assertEqual(env.store.load_model().generation, res.new.generation)

    def test_noop_writes_nothing(self):
        before = self.env.files()
        res = self.env.store.apply(lambda old: old, actor="alice")
        self.assertTrue(res.noop)
        self.assertEqual(self.env.files(), before)

    def test_dry_run_writes_nothing_and_describes(self):
        before = self.env.files()
        res = self.env.store.apply(lambda old: M.create_account(
            old, login="carol", display_name="C", hash=helpers.fake_hash("c"),
            now=NOW, by="alice"), actor="alice", dry_run=True)
        self.assertTrue(res.dry_run)
        self.assertEqual(self.env.files(), before)
        users = {e["login"] for e in res.plan["effective"]}
        self.assertIn("carol", users)
        added = res.plan["rights"]["added"]
        self.assertTrue(any(r["user"] == "^carol$" for r in added))
        self.assertEqual(res.plan["rights"]["removed"], [])

    def test_lockout_blocks_before_anything_is_written(self):
        before = self.env.files()
        with self.assertRaises(ApiError) as cm:
            self.env.store.apply(lambda old: M.disable_account(
                old, "alice", now=NOW, by="alice"), actor="bob")
        self.assertEqual(cm.exception.code, "lockout_last_admin")
        with self.assertRaises(ApiError) as cm:
            self.env.store.apply(lambda old: M.patch_account(
                old, "alice", admin=False, now=NOW, by="alice"),
                actor="alice")
        self.assertIn(cm.exception.code, ("lockout_last_admin", "lockout_self"))
        self.assertEqual(self.env.files(), before)

    def test_candidate_rejection_writes_nothing(self):
        def bad(m, r, u):
            raise vc.CandidateRejected(["probe mismatch"])
        env = Env(self)
        env.store._validator = bad
        before = env.files()
        with self.assertRaises(ApiError) as cm:
            env.create()
        self.assertEqual(cm.exception.code, "internal")
        self.assertEqual(cm.exception.reason, "candidate_rejected")
        self.assertEqual(env.files(), before)
        self.assertEqual(os.listdir(env.cfg.generations_dir).count("3"), 0)

    def test_op_errors_propagate_without_writing(self):
        before = self.env.files()
        with self.assertRaises(ApiError) as cm:
            self.env.create("alice")
        self.assertEqual(cm.exception.code, "exists")
        self.assertEqual(self.env.files(), before)

    def test_prunes_to_three_and_keeps_baseline(self):
        for i in range(6):
            self.env.create("user%d" % i)
        nums = self.env.store.generation_numbers()
        first = nums[0]
        self.assertEqual(len(nums), 4)  # baseline + newest three
        self.assertTrue(os.path.exists(os.path.join(
            self.env.cfg.generations_dir, str(first), "BASELINE")))
        gens = {g["generation"]: g for g in self.env.store.list_generations()}
        self.assertTrue(gens[nums[-1]]["current"])
        self.assertTrue(gens[first]["baseline"])

    def test_lock_timeout_is_busy(self):
        store = self.env.store
        started, release = threading.Event(), threading.Event()

        def hold():
            with store.locked():
                started.set()
                release.wait(5)
        t = threading.Thread(target=hold)
        t.start()
        started.wait(5)
        try:
            with self.assertRaises(ApiError) as cm:
                self.env.create()
            self.assertEqual(cm.exception.code, "busy")
            self.assertEqual(cm.exception.status, 503)
        finally:
            release.set()
            t.join()

    def test_flock_is_shared_with_other_processes(self):
        import fcntl
        fd = os.open(self.env.cfg.lock_path, os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            with self.assertRaises(ApiError) as cm:
                self.env.create()
            self.assertEqual(cm.exception.code, "busy")
        finally:
            os.close(fd)
        self.env.create()

    def test_concurrent_applies_give_consecutive_generations(self):
        env = Env(self, lock_timeout_s=30)
        start = env.store.load_model().generation
        errors, gens = [], []

        def work(i):
            try:
                gens.append(env.create("w%d" % i).new.generation)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        threads = [threading.Thread(target=work, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(sorted(gens), list(range(start + 1, start + 11)))
        self.assertEqual(len(env.store.load_model().accounts), 13)


class FaultInjection(unittest.TestCase):
    POINTS = ("before_model", "after_model", "after_generation",
              "after_first_file", "after_files")

    def test_error_at_every_point_restores_everything(self):
        for users_first in (False, True):
            for point in self.POINTS:
                env = Env(self)
                before = env.files()
                gens = env.store.generation_numbers()
                env.raise_at = point
                with self.assertRaises(OSError, msg=point):
                    env.disable("bob") if users_first else env.create()
                self.assertEqual(env.files(), before, point)
                self.assertEqual(env.store.generation_numbers(), gens, point)
                self.assertFalse(os.path.exists(env.cfg.lkg_path), point)
                self.assertEqual(env.store.reconcile(probe=False)["state"],
                                 "ok", point)

    def test_failed_write_leaves_store_usable(self):
        env = Env(self)
        env.raise_at = "after_first_file"
        with self.assertRaises(OSError):
            env.create()
        env.raise_at = None
        res = env.create()
        self.assertEqual(res.new.generation,
                         env.store.load_model().generation)
        self.assertEqual(env.store.reconcile(probe=False)["state"], "ok")

    def test_crash_after_model_then_reconcile_rolls_forward(self):
        env = Env(self)
        old_rights = env.files()["rights"]
        env.crash_at = "after_model"
        with self.assertRaises(filewrite.Crash):
            env.create()
        self.assertEqual(env.files()["rights"], old_rights)  # files are behind
        model = env.store.load_model()
        self.assertIn("carol", model.accounts)
        out = env.store.reconcile()
        self.assertEqual(out["state"], "rolled_forward")
        rights, users, _ = generator.generate(model)
        self.assertEqual(env.files()["rights"], rights.encode())
        self.assertEqual(env.files()["users"], users.encode())
        self.assertTrue(os.path.exists(os.path.join(
            env.cfg.generations_dir, str(model.generation), "model.json")))
        events = env.store.test_stream.events()
        self.assertEqual(events[-1]["event"], "reconcile")
        self.assertEqual(events[-1]["result"], "rolled_forward")
        self.assertEqual(events[-1]["generation"], model.generation)
        self.assertEqual(env.store.reconcile()["state"], "ok")

    def test_crash_between_the_two_managed_files(self):
        for fn in ("create", "disable"):
            env = Env(self)
            env.crash_at = "after_first_file"
            with self.assertRaises(filewrite.Crash):
                getattr(env, fn)()
            files = env.files()
            self.assertNotEqual(files["rights"].split(b"\n")[0],
                                files["users"].split(b"\n")[0])
            self.assertEqual(env.store.reconcile()["state"], "rolled_forward")
            self.assertEqual(env.files()["rights"].split(b"\n")[0],
                             env.files()["users"].split(b"\n")[0])

    def test_reconcile_runs_full_validation_first(self):
        env = Env(self)
        env.crash_at = "after_model"
        with self.assertRaises(filewrite.Crash):
            env.create()
        calls = []

        def validator(m, r, u):
            calls.append(m.generation)
            raise vc.CandidateRejected(["nope"])
        env.store._validator = validator
        before = env.files()["rights"]
        out = env.store.reconcile()
        self.assertEqual(out["state"], "validation_failed")
        self.assertTrue(calls)
        self.assertEqual(env.files()["rights"], before)

    def test_reconcile_repairs_tampered_or_missing_files(self):
        env = Env(self)
        with open(env.cfg.rights_path, "ab") as fh:
            fh.write(b"# tampered\n")
        self.assertEqual(env.store.reconcile()["state"], "rolled_forward")
        os.unlink(env.cfg.users_path)
        self.assertEqual(env.store.reconcile()["state"], "rolled_forward")
        self.assertEqual(env.store.reconcile()["state"], "ok")


class CorruptModelAndRestore(unittest.TestCase):
    def test_corrupt_model_is_reported_and_blocks_mutations(self):
        env = Env(self)
        env.create()
        with open(env.cfg.model_path, "w") as fh:
            fh.write("{not json")
        self.assertEqual(env.store.reconcile()["state"], "model_error")
        h = env.store.health()
        self.assertFalse(h["modelOk"])
        self.assertFalse(h["ok"])
        with self.assertRaises(ApiError) as cm:
            env.create("dave")
        self.assertEqual(cm.exception.code, "model_corrupt")
        os.unlink(env.cfg.model_path)
        with self.assertRaises(ApiError) as cm:
            env.store.current_model()
        self.assertEqual(cm.exception.reason, "no_model")

    def test_restore_after_corruption_and_normal_restore(self):
        env = Env(self)
        env.create("carol")
        env.create("dave")
        nums = env.store.generation_numbers()
        with open(env.cfg.model_path, "w") as fh:
            fh.write("garbage")
        res = env.store.restore(nums[-2], None, probe=False)
        self.assertEqual(res.new.generation, nums[-1] + 1)
        m = env.store.load_model()
        self.assertIn("carol", m.accounts)
        self.assertNotIn("dave", m.accounts)
        self.assertEqual(env.store.reconcile(probe=False)["state"], "ok")

    def test_restore_keeps_tombstones_and_honours_lockout(self):
        env = Env(self)
        base = env.store.load_model().generation
        env.store.apply(lambda old: M.delete_account(
            old, "bob", now=NOW, by="alice"), actor="alice")
        res = env.store.restore(base, "alice")
        self.assertNotIn("bob", res.new.accounts)   # a deleted login stays deleted
        self.assertIn("bob", res.new.tombstones)
        env.store.apply(lambda old: M.delete_account(
            old, "agent-1", now=NOW, by="alice"), actor="alice")
        gens = env.store.generation_numbers()
        res = env.store.restore(gens[-2], "alice")  # snapshot where agent-1 exists
        self.assertNotIn("agent-1", res.new.accounts)   # deleted since: stays so
        self.assertIn("agent-1", res.new.tombstones)
        with self.assertRaises(ApiError):
            env.store.restore(999, "alice")

    def test_restore_refuses_a_snapshot_that_removes_the_acting_admin(self):
        env = Env(self)
        base = env.store.load_model().generation
        env.store.apply(lambda old: M.create_account(
            old, login="root2", display_name="R", admin=True,
            hash=helpers.fake_hash("r"), now=NOW, by="alice"), actor="alice")
        before = env.files()
        with self.assertRaises(ApiError) as cm:
            env.store.restore(base, "root2")  # snapshot has no root2
        self.assertEqual(cm.exception.code, "lockout_self")
        self.assertEqual(env.files(), before)


class Health(unittest.TestCase):
    def test_health_reports_generation_and_active(self):
        env = Env(self)
        h = env.store.health()
        gen = env.store.load_model().generation
        self.assertEqual(h, {"ok": True, "generation": gen, "active": True,
                             "modelOk": True})
        env.store._health = None
        env.store.prober.active = False
        h = env.store.health()
        self.assertFalse(h["active"])
        self.assertFalse(h["ok"])

    def test_health_refreshes_stale_lkg_once_active(self):
        env = Env(self)
        self.assertFalse(os.path.exists(env.cfg.lkg_path))
        env.store.health()
        self.assertEqual(read(env.cfg.lkg_path), read(env.cfg.rights_path))


if __name__ == "__main__":
    unittest.main()
