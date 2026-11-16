# SPDX-License-Identifier: AGPL-3.0-or-later
"""model.py: strict schema, operations, limits, generation handling."""
import copy
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402
from helpers import LATER, NOW, TOKEN, Builder, case_models, fake_hash  # noqa: E402
from radui_admin import model as M  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402


def codes(fn, *a, **k):
    try:
        fn(*a, **k)
    except ApiError as e:
        return (e.code, e.field, e.reason)
    raise AssertionError("no ApiError raised")


def base():
    return Builder().account("alice", admin=True).account("bob").account(
        "agent-1", type="bot").m


class JsonTests(unittest.TestCase):
    def test_round_trip_all_cases(self):
        for name, m in case_models().items():
            text = M.dump(m)
            self.assertEqual(M.load(text), m, name)
            self.assertEqual(M.dump(M.load(text)), text)
            self.assertTrue(text.isascii())
            self.assertTrue(text.endswith("}\n"))

    def test_non_ascii_display_name_round_trips(self):
        m = Builder().account("alice", admin=True, display_name="Zo\u00e9").m
        self.assertEqual(M.load(M.dump(m)).accounts["alice"].display_name,
                         "Zo\u00e9")

    def mutate(self, fn):
        obj = json.loads(M.dump(base()))
        fn(obj)
        return json.dumps(obj)

    def assert_corrupt(self, text, reason_part=""):
        with self.assertRaises(ApiError) as cm:
            M.load(text)
        self.assertEqual(cm.exception.code, "model_corrupt")
        self.assertEqual(cm.exception.status, 503)
        self.assertIn(reason_part, cm.exception.reason or "")

    def test_unknown_and_missing_keys(self):
        self.assert_corrupt(self.mutate(lambda o: o.update(extra=1)), "unknown_key")
        self.assert_corrupt(self.mutate(lambda o: o.pop("grants")), "missing_key")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(groups="x")), "unknown_key")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].pop("hash")), "missing_key")
        self.assert_corrupt(self.mutate(
            lambda o: o["tombstones"].update(
                x={"deleted": NOW, "by": "cli", "why": "y"})), "unknown_key")

    def test_schema_and_types(self):
        self.assert_corrupt(self.mutate(lambda o: o.update(schema=2)), "schema")
        self.assert_corrupt(self.mutate(lambda o: o.update(schema=True)), "schema")
        self.assert_corrupt(self.mutate(lambda o: o.update(generation="1")))
        self.assert_corrupt(self.mutate(lambda o: o.update(generation=True)))
        self.assert_corrupt(self.mutate(lambda o: o.update(generation=-1)))
        self.assert_corrupt(self.mutate(lambda o: o.update(generation=1.5)), "float")
        self.assert_corrupt(self.mutate(lambda o: o.update(bcryptCost=3)))
        self.assert_corrupt(self.mutate(lambda o: o.update(bcryptCost=17)))
        self.assert_corrupt(self.mutate(lambda o: o.update(genToken="XYZ")))
        self.assert_corrupt(self.mutate(lambda o: o.update(accounts=[])))
        self.assert_corrupt(self.mutate(lambda o: o.update(grants={})))
        self.assert_corrupt(self.mutate(lambda o: o.update(tombstones=[])))
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(admin=1)), "not_a_bool")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(disabled="no")), "not_a_bool")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(ownSpace=None)), "not_a_bool")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(type=3)), "not_a_string")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(type="robot")), "bad_type")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(hash="plain")), "bad_hash")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(created="2026-13-45T00:00:00Z")),
            "timestamp")
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["bob"].update(displayName="a\nb")),
            "display")

    def test_bot_admin_in_file_rejected(self):
        self.assert_corrupt(self.mutate(
            lambda o: o["accounts"]["agent-1"].update(admin=True)),
            "bot_cannot_be_admin")

    def test_login_keys_checked(self):
        def add(o):
            o["accounts"]["Bad/Login"] = copy.deepcopy(o["accounts"]["bob"])
        self.assert_corrupt(self.mutate(add), "bad_login")

    def test_tombstone_clash_and_validation(self):
        def clash(o):
            o["tombstones"]["bob"] = {"deleted": NOW, "by": "cli"}
        self.assert_corrupt(self.mutate(clash), "tombstoned_and_present")
        self.assert_corrupt(self.mutate(
            lambda o: o["tombstones"].update(
                zed={"deleted": "x", "by": "cli"})), "timestamp")
        self.assert_corrupt(self.mutate(
            lambda o: o["tombstones"].update(
                zed={"deleted": NOW, "by": "A B"})), "bad_actor")
        self.assert_corrupt(self.mutate(
            lambda o: o["tombstones"].update(
                **{"ZED": {"deleted": NOW, "by": "cli"}})), "bad_login")
        self.assert_corrupt(self.mutate(
            lambda o: o["tombstones"].update(zed="x")), "not_an_object")
        self.assert_corrupt(self.mutate(
            lambda o: o["tombstones"].update(
                zed={"deleted": 5, "by": "cli"})), "not_a_string")

    def test_grant_validation_variants(self):
        g = {"owner": "alice", "collection": "c", "grantee": "bob",
             "level": "read", "created": NOW, "by": "cli"}

        def ok(o):
            o["grants"].append(dict(g))
        M.load(self.mutate(ok))

        def bad(reason, **ch):
            def f(o):
                o["grants"].append(dict(g, **ch))
            self.assert_corrupt(self.mutate(f), reason)
        bad("unknown_account", owner="nobody")
        bad("unknown_account", grantee="nobody")
        bad("self_grant", grantee="alice")
        bad("bad_collection_name", collection="../x")
        bad("bad_level", level="admin")
        bad("timestamp", created="yesterday")
        bad("bad_actor", by="A B")
        bad("not_a_string", level=1)
        bad("unknown_key", extra=1)

        def dup(o):
            o["grants"] += [dict(g), dict(g, level="readwrite")]
        self.assert_corrupt(self.mutate(dup), "duplicate_grant")
        self.assert_corrupt(self.mutate(
            lambda o: o["grants"].append("x")), "not_an_object")

    def test_json_level_problems(self):
        self.assert_corrupt("", "invalid_json")
        self.assert_corrupt("{", "invalid_json")
        self.assert_corrupt("[]", "not_an_object")
        self.assert_corrupt('{"schema": NaN}', "invalid_json")
        text = M.dump(base()).replace('"schema": 1', '"schema": 1, "schema": 1')
        self.assert_corrupt(text, "invalid_json")
        self.assert_corrupt(None, "not_text")
        self.assert_corrupt("[" * 5000 + "]" * 5000, "")
        deep = self.mutate(lambda o: o.update(accounts={"bob": {"a": {"b": {"c": {}}}}}))
        self.assert_corrupt(deep, "too_deep")
        long = self.mutate(lambda o: o["accounts"]["bob"].update(displayName="x" * 129))
        self.assert_corrupt(long, "string_too_long")
        longk = self.mutate(lambda o: o["accounts"].update({"k" * 129: {}}))
        self.assert_corrupt(longk, "key_too_long")
        self.assert_corrupt(" " * (M.MAX_MODEL_BYTES + 1), "too_large")

    def test_limits(self):
        self.assertEqual((M.MAX_ACCOUNTS, M.MAX_GRANTS), (200, 2000))
        accounts = {}
        proto = base().accounts["bob"]
        for i in range(201):
            accounts["u%03d" % i] = proto
        with self.assertRaises(ApiError) as cm:
            M.validate(M.Model(1, TOKEN, 4, accounts, (), {}))
        self.assertEqual(cm.exception.reason, "too_many")
        grants = tuple(M.Grant("alice", "c%d" % i, "bob", "read", NOW, "cli")
                       for i in range(2001))
        with self.assertRaises(ApiError) as cm:
            M.validate(M.Model(1, TOKEN, 4, base().accounts, grants, {}))
        self.assertEqual(cm.exception.reason, "too_many")
        tombs = {"t%d" % i: M.Tombstone(NOW, "cli") for i in range(5001)}
        with self.assertRaises(ApiError):
            M.validate(M.Model(1, TOKEN, 4, {}, (), tombs))

    def test_create_refused_at_account_limit(self):
        accounts = {"u%03d" % i: base().accounts["bob"] for i in range(200)}
        m = M.Model(1, TOKEN, 4, accounts, (), {})
        self.assertEqual(codes(
            M.create_account, m, login="extra", display_name="E",
            hash=fake_hash("e"), now=NOW, by="cli"),
            ("validation", "accounts", "limit_reached"))

    def test_put_grant_refused_at_grant_limit(self):
        b = Builder().account("alice", admin=True).account("bob")
        grants = tuple(M.Grant("alice", "c%d" % i, "bob", "read", NOW, "cli")
                       for i in range(2000))
        m = M.Model(1, TOKEN, 4, b.m.accounts, grants, {})
        self.assertEqual(codes(
            M.put_grant, m, owner="alice", collection="zz", grantee="bob",
            level="read", now=NOW, by="cli"),
            ("validation", "grants", "limit_reached"))
        # changing an existing grant at the limit is allowed
        m2 = M.put_grant(m, owner="alice", collection="c1", grantee="bob",
                         level="readwrite", now=NOW, by="cli")
        self.assertEqual(len(m2.grants), 2000)


class OperationTests(unittest.TestCase):
    def test_empty_model(self):
        m = M.empty_model()
        self.assertEqual(m.generation, 0)
        self.assertRegex(m.gen_token, r"^[0-9a-f]{32}$")
        self.assertNotEqual(M.new_gen_token(), M.new_gen_token())

    def test_create_bumps_generation_and_token(self):
        m = base()
        n = M.create_account(m, login="Carol", display_name="Carol",
                             hash=fake_hash("carol"), now=LATER, by="alice")
        self.assertEqual(n.generation, m.generation + 1)
        self.assertNotEqual(n.gen_token, m.gen_token)
        self.assertIn("carol", n.accounts)
        self.assertNotIn("carol", m.accounts)          # original untouched
        a = n.accounts["carol"]
        self.assertEqual((a.type, a.admin, a.disabled, a.own_space,
                          a.created, a.password_changed),
                         ("person", False, False, True, LATER, LATER))
        n2 = M.create_account(m, login="carol", display_name="C",
                              hash=fake_hash("c"), now=NOW, by="cli", token="b" * 32)
        self.assertEqual(n2.gen_token, "b" * 32)

    def test_create_errors(self):
        m = base()
        kw = dict(display_name="X", hash=fake_hash("x"), now=NOW, by="cli")
        self.assertEqual(codes(M.create_account, m, login="alice", **kw)[0], "exists")
        self.assertEqual(codes(M.create_account, m, login="ALICE", **kw)[0], "exists")
        self.assertEqual(codes(M.create_account, m, login="root", **kw),
                         ("validation", "login", "reserved"))
        self.assertEqual(codes(M.create_account, m, login="radui-x", **kw)[2],
                         "reserved")
        self.assertEqual(codes(M.create_account, m, login="../x", **kw)[0],
                         "validation")
        self.assertEqual(codes(M.create_account, m, login="zed",
                               extra_reserved=["zed"], **kw)[2], "reserved")
        self.assertEqual(codes(M.create_account, m, login="zed", type="robot", **kw)[1],
                         "type")
        self.assertEqual(codes(M.create_account, m, login="zed", admin="yes", **kw)[1],
                         "admin")
        self.assertEqual(codes(M.create_account, m, login="zed", own_space=1, **kw)[1],
                         "ownSpace")
        self.assertEqual(codes(M.create_account, m, login="zed", type="bot",
                               admin=True, **kw),
                         ("validation", "admin", "bot_cannot_be_admin"))
        self.assertEqual(codes(M.create_account, m, login="zed",
                               display_name="", hash=fake_hash("x"), now=NOW,
                               by="cli")[1], "displayName")
        self.assertEqual(codes(M.create_account, m, login="zed",
                               display_name="X", hash="nope", now=NOW,
                               by="cli")[2], "bad_hash")

    def test_tombstoned_login_cannot_be_recreated(self):
        m = M.delete_account(base(), "bob", now=LATER, by="alice")
        self.assertIn("bob", m.tombstones)
        self.assertNotIn("bob", m.accounts)
        self.assertEqual(codes(M.create_account, m, login="bob",
                               display_name="B", hash=fake_hash("b"),
                               now=NOW, by="cli")[0], "tombstoned")
        self.assertEqual(m.tombstones["bob"], M.Tombstone(LATER, "alice"))

    def test_patch(self):
        m = base()
        n = M.patch_account(m, "bob", display_name="Robert", admin=True,
                            own_space=False, now=NOW, by="alice")
        a = n.accounts["bob"]
        self.assertEqual((a.display_name, a.admin, a.own_space),
                         ("Robert", True, False))
        self.assertEqual(n.generation, m.generation + 1)
        self.assertIs(M.patch_account(
            m, "bob", display_name=m.accounts["bob"].display_name, now=NOW,
            by="a"), m)

    def test_patch_noop_returns_same_object(self):
        m = base()
        same = M.patch_account(m, "bob", admin=False, disabled=False,
                               now=NOW, by="cli")
        self.assertIs(same, m)
        self.assertIs(M.patch_account(m, "bob", now=NOW, by="cli"), m)

    def test_patch_errors(self):
        m = base()
        self.assertEqual(codes(M.patch_account, m, "nobody", now=NOW, by="a")[0],
                         "not_found")
        self.assertEqual(codes(M.patch_account, m, "Bob", now=NOW, by="a")[0],
                         "not_found")
        self.assertEqual(codes(M.patch_account, m, 5, now=NOW, by="a")[0],
                         "not_found")
        self.assertEqual(codes(M.patch_account, m, "bob", type="robot", now=NOW,
                               by="a")[1], "type")
        self.assertEqual(codes(M.patch_account, m, "bob", disabled="x", now=NOW,
                               by="a")[1], "disabled")
        self.assertEqual(codes(M.patch_account, m, "bob", display_name="\n", now=NOW,
                               by="a")[1], "displayName")

    def test_bot_cannot_be_admin_in_any_way(self):
        m = base()
        self.assertEqual(codes(M.patch_account, m, "agent-1", admin=True,
                               now=NOW, by="a")[2], "bot_cannot_be_admin")
        # demoting to bot while still admin is refused ...
        self.assertEqual(codes(M.patch_account, m, "alice", type="bot",
                               now=NOW, by="a")[2], "bot_cannot_be_admin")
        # ... but allowed together with admin=False
        n = M.patch_account(m, "alice", type="bot", admin=False, now=NOW, by="a")
        self.assertEqual(n.accounts["alice"].type, "bot")

    def test_disable_enable(self):
        m = base()
        d = M.disable_account(m, "bob", now=NOW, by="alice")
        self.assertTrue(d.accounts["bob"].disabled)
        self.assertEqual(d.accounts["bob"].hash, m.accounts["bob"].hash)  # kept
        self.assertIs(M.disable_account(d, "bob", now=NOW, by="alice"), d)
        e = M.enable_account(d, "bob", now=NOW, by="alice")
        self.assertFalse(e.accounts["bob"].disabled)

    def test_set_password_hash(self):
        m = base()
        n = M.set_password_hash(m, "bob", hash=fake_hash("new"), now=LATER, by="a")
        self.assertEqual(n.accounts["bob"].hash, fake_hash("new"))
        self.assertEqual(n.accounts["bob"].password_changed, LATER)
        self.assertEqual(n.accounts["bob"].created, NOW)
        self.assertEqual(codes(M.set_password_hash, m, "bob", hash="x", now=NOW)[2],
                         "bad_hash")
        self.assertEqual(codes(M.set_password_hash, m, "zzz", hash=fake_hash("a"),
                               now=NOW)[0], "not_found")

    def test_delete_removes_grants_both_sides(self):
        b = Builder().account("alice", admin=True).account("bob").account("carol")
        b.grant("alice", "c1", "bob", "read").grant("bob", "c2", "carol", "read")
        b.grant("alice", "c3", "carol", "read")
        n = M.delete_account(b.m, "bob", now=LATER, by="alice")
        self.assertEqual([g.key for g in n.grants], [("alice", "c3", "carol")])
        self.assertEqual(codes(M.delete_account, n, "bob", now=NOW, by="a")[0],
                         "not_found")

    def test_put_grant_levels(self):
        m = base()
        g1 = M.put_grant(m, owner="alice", collection="cal", grantee="bob",
                         level="read", now=NOW, by="alice")
        self.assertEqual(g1.grants[0].level, "read")
        self.assertEqual(g1.grants[0].created, NOW)
        self.assertIs(M.put_grant(g1, owner="alice", collection="cal",
                                  grantee="bob", level="read", now=LATER,
                                  by="alice"), g1)
        g2 = M.put_grant(g1, owner="alice", collection="cal", grantee="bob",
                         level="readwrite", now=LATER, by="alice")
        self.assertEqual(len(g2.grants), 1)
        self.assertEqual((g2.grants[0].level, g2.grants[0].created),
                         ("readwrite", NOW))
        g3 = M.put_grant(g2, owner="alice", collection="cal", grantee="bob",
                         level="none", now=LATER, by="alice")
        self.assertEqual(g3.grants, ())
        self.assertIs(M.put_grant(g3, owner="alice", collection="cal",
                                  grantee="bob", level="none", now=NOW, by="a"), g3)

    def test_put_grant_errors(self):
        m = base()
        kw = dict(now=NOW, by="cli")
        self.assertEqual(codes(M.put_grant, m, owner="alice", collection="c",
                               grantee="bob", level="write", **kw)[1], "level")
        self.assertEqual(codes(M.put_grant, m, owner="alice", collection="c",
                               grantee="bob", level=None, **kw)[1], "level")
        self.assertEqual(codes(M.put_grant, m, owner="nobody", collection="c",
                               grantee="bob", level="read", **kw)[0], "not_found")
        self.assertEqual(codes(M.put_grant, m, owner="alice", collection="c",
                               grantee="nobody", level="read", **kw)[1], "grantee")
        self.assertEqual(codes(M.put_grant, m, owner="alice", collection="../x",
                               grantee="bob", level="read", **kw)[0],
                         "unsupported_collection_name")
        self.assertEqual(codes(M.put_grant, m, owner="alice", collection="c",
                               grantee="alice", level="read", **kw)[2], "self_grant")
        self.assertEqual(codes(M.put_grant, m, owner="bob", collection="c",
                               grantee="alice", level="read", **kw)[2],
                         "grantee_is_admin")

    def test_grants_to_tombstoned_or_unknown_refused(self):
        m = M.delete_account(base(), "bob", now=LATER, by="alice")
        self.assertEqual(codes(M.put_grant, m, owner="alice", collection="c",
                               grantee="bob", level="read", now=NOW, by="a")[0],
                         "not_found")

    def test_grant_ordering_canonical(self):
        b = Builder().account("alice", admin=True).account("bob").account("carol")
        b.grant("bob", "z", "carol", "read").grant("alice", "a", "carol", "read")
        b.grant("alice", "b", "bob", "read")
        self.assertEqual([g.key for g in b.m.grants],
                         [("alice", "b", "bob"), ("alice", "a", "carol"),
                          ("bob", "z", "carol")])

    def test_own_space_losses(self):
        m = base()
        n = M.patch_account(m, "bob", own_space=False, now=NOW, by="a")
        self.assertEqual(M.own_space_losses(m, n), ["bob"])
        self.assertEqual(M.own_space_losses(n, m), [])

    def test_read_helpers(self):
        m = M.disable_account(base(), "bob", now=NOW, by="a")
        self.assertEqual(m.admins(), ["alice"])
        self.assertEqual(m.enabled(), ["agent-1", "alice"])
        self.assertIsNone(m.find_grant("alice", "c", "bob"))

    def test_model_is_immutable(self):
        m = base()
        with self.assertRaises(Exception):
            m.generation = 5
        with self.assertRaises(TypeError):
            m.accounts["x"] = None

    def test_account_keys_sorted_in_dump(self):
        text = M.dump(base())
        self.assertLess(text.index('"agent-1"'), text.index('"alice"'))


if __name__ == "__main__":
    unittest.main()
