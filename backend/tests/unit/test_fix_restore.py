# SPDX-License-Identifier: AGPL-3.0-or-later
"""M1: restore keeps tombstones, current password hashes and the disabled state
authoritative; the restored generation gives grants, ownSpace and admin flags.
Covers the store, the API (confirmation, dry run) and the CLI."""
import argparse
import contextlib
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import helpers  # noqa: E402
import test_fix_common as C  # noqa: E402
from radui_admin import cli, plan  # noqa: E402
from radui_admin import model as M  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402

NOW = helpers.NOW


def code(resp):
    return resp.body["error"]["code"] if isinstance(resp.body, dict) \
        and "error" in resp.body else None


class RestoreBase(unittest.TestCase):
    def setUp(self):
        b = C.base_builder().grant("bob", "cal", "agent-1", "read")
        self.fx = apihelpers.ApiFixture(C.tmp_root(self), builder=b)
        self.store = self.fx.store
        self.base = self.store.load_model().generation

    def call(self, *a, **kw):
        return self.fx.call(*a, **kw)

    def model(self):
        return self.store.load_model()


class StoreSemantics(RestoreBase):
    def test_password_reset_since_is_never_reverted(self):
        old_hash = self.model().accounts["agent-1"].hash
        r = self.call("POST", "/accounts/agent-1/password",
                      body={"password": "a different long passphrase 9!"})
        self.assertEqual(r.status, 200)
        new = self.model().accounts["agent-1"]
        self.assertNotEqual(new.hash, old_hash)
        res = self.store.restore(self.base, "alice")
        got = res.new.accounts["agent-1"]
        self.assertEqual((got.hash, got.password_changed),
                         (new.hash, new.password_changed))
        self.assertNotEqual(got.hash, old_hash)

    def test_deleted_login_is_not_revived_and_stays_tombstoned(self):
        self.assertEqual(self.call("DELETE", "/accounts/agent-1",
                                   body={"confirm": "agent-1"}).status, 200)
        res = self.store.restore(self.base, "alice")
        self.assertNotIn("agent-1", res.new.accounts)
        self.assertIn("agent-1", res.new.tombstones)
        self.assertEqual(res.plan["restore"]["accountsDropped"], ["agent-1"])
        # the grant to the dropped login is not brought back either
        self.assertEqual([g.grantee for g in res.new.grants], [])
        # and the login is still reserved
        self.assertEqual(self.call("POST", "/accounts", body={
            "login": "agent-1", "displayName": "X", "generate": True}).status,
            409)

    def test_account_disabled_since_stays_disabled(self):
        self.call("PATCH", "/accounts/carol", body={"disabled": True})
        res = self.store.restore(self.base, "alice")
        self.assertTrue(res.new.accounts["carol"].disabled)
        self.assertNotIn("carol", res.new.enabled())

    def test_grants_ownspace_and_admin_flags_come_from_the_snapshot(self):
        self.call("POST", "/accounts", body={
            "login": "root-2", "displayName": "R", "admin": True,
            "generate": True})
        mid = self.model().generation          # root-2 exists, is admin
        self.call("PUT", "/grants", login="bob", body={
            "owner": "bob", "collection": "cal", "grantee": "agent-1",
            "level": "none"})
        self.call("PATCH", "/accounts/root-2",
                  body={"admin": False, "ownSpace": False})
        self.assertEqual(self.model().grants, ())
        res = self.store.restore(mid, "alice")
        m = res.new
        self.assertEqual([(g.owner, g.collection, g.grantee, g.level)
                          for g in m.grants], [("bob", "cal", "agent-1", "read")])
        self.assertTrue(m.accounts["root-2"].admin)
        self.assertTrue(m.accounts["root-2"].own_space)
        self.assertEqual(sorted((f["login"], f["field"])
                                for f in res.plan["restore"]["flagsChanged"]),
                         [("root-2", "admin"), ("root-2", "ownSpace")])

    def test_account_created_after_the_snapshot_is_removed_and_listed(self):
        self.call("POST", "/accounts", body={
            "login": "later-1", "displayName": "L", "generate": True})
        res = self.store.restore(self.base, "alice")
        self.assertNotIn("later-1", res.new.accounts)
        self.assertNotIn("later-1", res.new.tombstones)
        self.assertEqual(res.plan["restore"]["accountsRemoved"], ["later-1"])

    def test_a_bot_never_becomes_admin_through_a_snapshot(self):
        # snapshot where the login was a person and admin ... now it is a bot
        b = helpers.Builder().account("alice", admin=True) \
            .account("agent-1", admin=True)
        src = b.m
        cur = helpers.Builder().account("alice", admin=True) \
            .account("agent-1", type="bot").m
        merged = plan.merge_restore(cur, src)
        self.assertFalse(merged.accounts["agent-1"].admin)

    def test_restoring_the_current_generation_repairs_without_changes(self):
        cur = self.model().generation
        res = self.store.restore(cur, "alice")
        self.assertEqual(res.new.generation, cur + 1)
        self.assertEqual(dict(res.new.accounts), dict(self.model().accounts))
        r = res.plan["restore"]
        self.assertEqual([r["accountsDropped"], r["accountsRemoved"],
                          r["grantsAdded"], r["grantsRemoved"],
                          r["flagsChanged"]], [[], [], [], [], []])

    def test_lost_model_takes_the_stored_generation_as_it_is(self):
        os.unlink(self.store.cfg.model_path)
        res = self.store.restore(self.base, None, probe=False)
        self.assertIn("agent-1", res.new.accounts)
        self.assertFalse(res.plan["restore"]["currentModel"])

    def test_lockout_rules_still_apply(self):
        # snapshot: alice is the only admin; now bob is admin and alice is not
        self.call("PATCH", "/accounts/bob", body={"admin": True})
        self.call("PATCH", "/accounts/alice", body={"admin": False},
                  login="bob")
        with self.assertRaises(ApiError) as cm:
            self.store.restore(self.base, "bob")   # bob would lose admin
        self.assertEqual(cm.exception.code, "lockout_self")

    def test_merge_is_pure_and_matches_dry_run(self):
        self.call("DELETE", "/accounts/agent-1", body={"confirm": "agent-1"})
        before = C.read(self.store.cfg.model_path)
        dry = self.store.restore(self.base, "alice", dry_run=True)
        self.assertEqual(C.read(self.store.cfg.model_path), before)
        real = self.store.restore(self.base, "alice")
        self.assertEqual(dry.plan["restore"], real.plan["restore"])


class ApiBehaviour(RestoreBase):
    def setUp(self):
        super().setUp()
        self.call("DELETE", "/accounts/agent-1", body={"confirm": "agent-1"})
        self.path = "/generations/%d/restore" % self.base

    def test_confirmation_is_required_and_exact(self):
        before = C.read(self.store.cfg.model_path)
        for body in ({}, {"confirm": ""}, {"confirm": "restore-%d" % (
                self.base + 1)}, {"confirm": "restore"}, {"confirm": True},
                {"confirm": "RESTORE-%d" % self.base}):
            r = self.call("POST", self.path, body=body)
            self.assertEqual((r.status, code(r)), (422, "validation"), body)
            self.assertEqual(r.body["error"]["field"], "confirm")
        self.assertEqual(C.read(self.store.cfg.model_path), before)

    def test_unknown_field_still_rejected_and_unknown_generation_is_404(self):
        r = self.call("POST", self.path, body={"confirm": "restore-%d"
                                               % self.base, "x": 1})
        self.assertEqual(r.status, 422)
        r = self.call("POST", "/generations/999/restore",
                      body={"confirm": "restore-999"})
        self.assertEqual(r.status, 404)

    def test_dry_run_needs_no_confirmation_and_lists_the_changes(self):
        r = self.call("POST", self.path, body={}, query="?dryRun=1")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.body["dryRun"])
        self.assertEqual(r.body["confirm"], "restore-%d" % self.base)
        rep = r.body["restore"]
        self.assertEqual(rep["accountsDropped"], ["agent-1"])
        self.assertEqual(rep["grantsAdded"], [])
        self.assertIn("effective", r.body)
        self.assertEqual(self.model().generation, self.base + 1)  # unchanged

    def test_confirmed_restore_reports_what_it_did(self):
        r = self.call("POST", self.path,
                      body={"confirm": "restore-%d" % self.base})
        self.assertEqual((r.status, r.body["restoredFrom"]), (200, self.base))
        self.assertEqual(r.body["restore"]["accountsDropped"], ["agent-1"])
        self.assertIn("agent-1", self.model().tombstones)
        ev = [e for e in self.store.test_stream.events()
              if e["event"] == "generation.restore"]
        self.assertEqual(ev[-1]["result"], "ok")


class CliBehaviour(RestoreBase):
    def run_cli(self, **kw):
        args = argparse.Namespace(generation=self.base, dry_run=False,
                                  confirm=None, no_probe=True)
        for k, v in kw.items():
            setattr(args, k, v)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.cmd_restore(self.store, self.store.cfg, args)
        return rc, out.getvalue(), err.getvalue()

    def test_confirmation_flag_is_required(self):
        before = C.read(self.store.cfg.model_path)
        rc, out, err = self.run_cli()
        self.assertEqual(rc, cli.EX_USAGE)
        self.assertIn("--confirm restore-%d" % self.base, err)
        rc, out, err = self.run_cli(confirm="restore-%d" % (self.base + 1))
        self.assertEqual(rc, cli.EX_USAGE)
        self.assertEqual(C.read(self.store.cfg.model_path), before)

    def test_dry_run_and_confirmed_restore_use_the_same_semantics(self):
        self.call("DELETE", "/accounts/agent-1", body={"confirm": "agent-1"})
        rc, out, err = self.run_cli(dry_run=True)
        self.assertEqual(rc, cli.EX_OK)
        self.assertIn("dropped (deleted since, stays deleted): agent-1", out)
        rc, out, err = self.run_cli(confirm="restore-%d" % self.base)
        self.assertEqual(rc, cli.EX_OK, err)
        self.assertIn("restored as generation", out)
        self.assertIn("agent-1", self.model().tombstones)
        self.assertNotIn("agent-1", self.model().accounts)


if __name__ == "__main__":
    unittest.main()
