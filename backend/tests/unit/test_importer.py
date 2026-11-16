# SPDX-License-Identifier: AGPL-3.0-or-later
"""importer.py: legacy files -> model, and the equivalence report."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402
from helpers import MATCHER, NOW, TOKEN, fake_hash  # noqa: E402
from radui_admin import expected, generator, importer as I, model as M  # noqa: E402
from radui_admin import rightsfile  # noqa: E402

REAL_ONLY = unittest.skipUnless(MATCHER, "no Radicale interpreter configured")


def users_text(*logins):
    return "# legacy users\n" + "".join(
        "%s:%s\n" % (l, fake_hash(l)) for l in logins)


# Mimics the structure of a hand-written legacy rights file: a root rule, the
# owner's principal and collection rules, per-bot principal read rules and
# shared rules written as alternations.
LEGACY_A = """\
# legacy rights (synthetic)
[root]
user: .+
collection: ^$
permissions: R

[alice-principal]
user: alice
collection: ^alice$
permissions: RW

[alice-own]
user: alice
collection: ^alice/[^/]+$
permissions: rw

[agent-1-principal]
user: agent-1
collection: ^agent-1$
permissions: R

[agent-1-shared]
user: agent-1
collection: ^alice/(cal-work|cal-home|contacts|birthdays)$
permissions: rw

[agent-1-shared-ro]
user: agent-1
collection: ^alice/archive$
permissions: r

[agent-2-principal]
user: agent-2
collection: ^agent-2$
permissions: R

[agent-2-shared]
user: agent-2
collection: ^alice/(cal-work)$
permissions: r
"""

# Generic template rules ({user}) and a wildcard rule for one bot.
LEGACY_B = """\
[root]
user: .+
collection: ^$
permissions: R

[everyone-principal]
user: .+
collection: ^{user}$
permissions: RW

[everyone-own]
user: .+
collection: ^{user}/[^/]+$
permissions: rw

[agent-2-extra]
user: agent-2
collection: ^bob/(listed\\.cal|x\\-y)$
permissions: rw


[agent-2-wildcard]
user: agent-2
collection: ^bob/[^/]+$
permissions: r
"""


def run_import(users, rights, admins=("alice",), **kw):
    return I.import_legacy(users, rights, admins=admins, now=NOW, token=TOKEN, **kw)


class ParseTests(unittest.TestCase):
    def test_parse_users(self):
        h = fake_hash("a")
        users, issues = I.parse_users(
            "# c\n\n  \nalice:%s\nbob:%s\nbob:%s\nbroken\n:x\ncarol:\n" % (h, h, h))
        self.assertEqual(sorted(users), ["alice", "bob"])
        codes = sorted(i.code for i in issues)
        self.assertEqual(codes, ["bad_users_line"] * 3 + ["duplicate_login"])

    def test_parse_users_keeps_colons_in_hash_field(self):
        users, _ = I.parse_users("alice:$apr1$x:y\n")
        self.assertEqual(users["alice"], "$apr1$x:y")

    def test_parse_rights(self):
        rules = I.parse_rights(LEGACY_A)
        self.assertEqual(rules[0], I.LegacyRule("root", ".+", "^$", "R", ""))
        self.assertEqual(len(rules), 8)

    def test_parse_rights_errors(self):
        for bad in ("[a]\nuser x\n", "[a]\nuser: x\n[a]\nuser: y\n",
                    "[a]\nuser: x\ncollection: %(zz)s\npermissions: r\n"):
            with self.assertRaises(ValueError):
                I.parse_rights(bad)

    def test_extract_candidates(self):
        rules = I.parse_rights(
            "[a]\nuser: x\ncollection: ^a\\.b/(c\\-d|e)$\npermissions: r\n"
            "[b]\nuser: x\ncollection: ^a/(?:f|g)$\npermissions: r\n"
            "[c]\nuser: x\ncollection: ^h/i$\npermissions: r\n"
            "[d]\nuser: x\ncollection: ^j/[^/]+$\npermissions: r\n"
            "[e]\nuser: x\ncollection: ^k$\npermissions: r\n"
            "[f]\nuser: x\ncollection: ^{user}/[^/]+$\npermissions: r\n"
            "[g]\nuser: x\ncollection: ^l/.*$\npermissions: r\n")
        found, wildcard = I.extract_candidates(rules)
        self.assertEqual(found, {("a.b", "c-d"), ("a.b", "e"), ("a", "f"),
                                 ("a", "g"), ("h", "i")})
        self.assertEqual(wildcard, {"j", "l"})

    def test_legacy_rights_emulation(self):
        lr = I.LegacyRights(I.parse_rights(LEGACY_B))
        self.assertEqual(lr.authorization("zed", "zed/c"), "rw")
        self.assertEqual(lr.authorization("zed", "/zed/"), "RW")
        self.assertEqual(lr.authorization("agent-2", "bob/q"), "r")
        self.assertEqual(lr.authorization("agent-2", "bob/listed.cal"), "rw")
        self.assertEqual(lr.authorization("agent-2", "bob/listedXcal"), "r")
        self.assertEqual(lr.authorization("", ""), "")
        self.assertEqual(lr.authorization("x", ""), "R")

    @REAL_ONLY
    def test_emulation_equals_radicale(self):
        for text in (LEGACY_A, LEGACY_B):
            lr = I.LegacyRights(I.parse_rights(text))
            users = ["", "alice", "bob", "agent-1", "agent-2", "zed", "a.b"]
            paths = ["", "alice", "bob", "agent-1", "agent-2", "zed",
                     "alice/cal-work", "alice/archive", "alice/other",
                     "bob/q", "bob/listed.cal", "bob/listedXcal", "bob/x-y",
                     "agent-1/c", "zed/c", "zed/c/x", "alice/cal-work/x"]
            pairs = [(u, p) for u in users for p in paths]
            real = MATCHER(text, pairs)
            mine = ["".join(sorted(lr.authorization(u, p))) for u, p in pairs]
            self.assertEqual(real, mine)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.res = run_import(users_text("alice", "agent-1", "agent-2"), LEGACY_A)

    def test_ok_and_accounts(self):
        r = self.res
        self.assertTrue(r.ok, r.issues)
        m = r.model
        self.assertEqual(m.generation, 1)
        self.assertEqual(sorted(m.accounts), ["agent-1", "agent-2", "alice"])
        a = m.accounts["alice"]
        self.assertEqual((a.type, a.admin, a.own_space, a.display_name),
                         ("person", True, True, "alice"))
        for bot in ("agent-1", "agent-2"):
            acc = m.accounts[bot]
            self.assertEqual((acc.type, acc.admin, acc.disabled), ("bot", False, False))
            self.assertFalse(acc.own_space)      # legacy rules gave no write below itself
        self.assertEqual(m.accounts["alice"].hash, fake_hash("alice"))  # hash kept
        self.assertEqual(m.bcrypt_cost, 4)
        M.validate(m)

    def test_grants_reconstructed(self):
        got = {g.key: g.level for g in self.res.model.grants}
        self.assertEqual(got, {
            ("alice", "cal-work", "agent-1"): "readwrite",
            ("alice", "cal-home", "agent-1"): "readwrite",
            ("alice", "contacts", "agent-1"): "readwrite",
            ("alice", "birthdays", "agent-1"): "readwrite",
            ("alice", "archive", "agent-1"): "read",
            ("alice", "cal-work", "agent-2"): "read",
        })
        for g in self.res.model.grants:
            self.assertEqual((g.by, g.created), ("import", NOW))

    def test_model_round_trips_and_generates(self):
        m = self.res.model
        self.assertEqual(M.load(M.dump(m)), m)
        rights, users, _ = generator.generate(m)
        self.assertEqual(rightsfile.check_text(rights), [])
        self.assertIn("agent-1:", users)

    @REAL_ONLY
    def test_new_files_match_oracle(self):
        m = self.res.model
        rights = generator.generate(m)[0]
        self.assertEqual(expected.mismatches(m, rights, MATCHER), [])

    @REAL_ONLY
    def test_equivalence_report_has_no_unexplained(self):
        m = self.res.model
        new = generator.generate(m)[0]
        rep = I.equivalence_report(LEGACY_A, new, m, matcher=MATCHER,
                                   result=self.res)
        self.assertEqual(rep.unexplained, [], rep.to_text())
        s = rep.summary()
        self.assertGreater(s["probes"], 50)
        self.assertGreater(s["expected_tightening"], 0)
        self.assertGreater(s["expected_loosening"], 0)
        reasons = {(d.user, d.path, d.reason) for d in rep.differences}
        # rw grants lose PROPPATCH/delete/overwrite on the collection itself
        self.assertIn(("agent-1", "alice/cal-work", "explicit_collection_letters"), reasons)
        # the owner's principal can no longer be deleted
        self.assertIn(("alice", "alice", "principal_explicit_letters"), reasons)
        # a bot gets RW on its own principal, anonymous gets the probe path
        self.assertIn(("agent-1", "agent-1", "own_principal"), reasons)
        self.assertIn(("", "radui-gen-" + m.gen_token, "generation_probe"), reasons)
        # the admin gains access to the bots' principals
        self.assertIn(("alice", "agent-1", "admin_full_access"), reasons)
        text = rep.to_text()
        self.assertIn("unexplained: 0", text)
        self.assertIn("<anonymous>", text)

    @REAL_ONLY
    def test_report_detects_a_loosened_file(self):
        m = self.res.model
        new = generator.generate(m)[0]
        body = new[:new.rindex("# radui-end")]
        loose = body.replace("permissions: r\n\n[s", "permissions: rwl\n\n[s", 1)
        self.assertNotEqual(loose, body)
        text = "%s# radui-end generation=%d sha256=%s\n" % (
            loose, m.generation, rightsfile.sha256_hex(loose))
        rep = I.equivalence_report(LEGACY_A, text, m, matcher=MATCHER,
                                   result=self.res)
        self.assertTrue(rep.unexplained)
        self.assertEqual(rep.unexplained[0].reason, "gained_access")

    @REAL_ONLY
    def test_report_detects_a_tightened_file(self):
        m = self.res.model
        # drop agent-2's grant from the model: new file gives it less than the old
        m2 = M.put_grant(m, owner="alice", collection="cal-work",
                         grantee="agent-2", level="none", now=NOW, by="cli")
        new = generator.generate(m2)[0]
        rep = I.equivalence_report(LEGACY_A, new, m2, matcher=MATCHER,
                                   result=self.res)
        lost = [d for d in rep.unexplained if d.direction == "lost"]
        self.assertTrue(lost)
        self.assertEqual(lost[0].reason, "lost_access")
        self.assertEqual((lost[0].user, lost[0].path), ("agent-2", "alice/cal-work"))


class VariantTests(unittest.TestCase):
    def test_template_rules_give_bots_own_space(self):
        r = run_import(users_text("alice", "bob", "agent-2"), LEGACY_B,
                       admins=["alice"])
        self.assertTrue(r.ok, r.issues)
        for login in ("bob", "agent-2"):
            self.assertTrue(r.model.accounts[login].own_space, login)
        # agent-2 reads and writes some of bob's collections
        got = {g.key: g.level for g in r.model.grants}
        self.assertEqual(got, {("bob", "listed.cal", "agent-2"): "readwrite",
                               ("bob", "x-y", "agent-2"): "readwrite"})
        wild = [i for i in r.issues if i.code == "wildcard_access_not_imported"]
        self.assertEqual([i.subject for i in wild], ["agent-2 -> bob"])
        self.assertIn(("agent-2", "bob", "*"), r.dropped)

    def test_known_collections_enumerate_wildcards(self):
        r = run_import(users_text("alice", "bob", "agent-2"), LEGACY_B,
                       known_collections={"bob": ["cal", "tasks", "My Cal",
                                                  "café"]})
        got = {g.key: g.level for g in r.model.grants}
        self.assertEqual(got[("bob", "cal", "agent-2")], "read")
        self.assertEqual(got[("bob", "tasks", "agent-2")], "read")
        self.assertNotIn(("bob", "My Cal", "agent-2"), got)
        self.assertIn(("agent-2", "bob", "My Cal"), r.dropped)
        unsupported = [i.subject for i in r.issues
                       if i.code == "unsupported_collection_name"]
        self.assertEqual(sorted(unsupported), ["agent-2 -> bob/My Cal",
                                               "agent-2 -> bob/café"])

    @REAL_ONLY
    def test_wildcard_variant_has_no_unexplained(self):
        known = {"bob": ["cal", "My Cal"]}
        r = run_import(users_text("alice", "bob", "agent-2"), LEGACY_B,
                       known_collections=known)
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(LEGACY_B, new, r.model, matcher=MATCHER,
                                   result=r, known_collections=known)
        self.assertEqual(rep.unexplained, [], rep.to_text())
        reasons = {d.reason for d in rep.differences}
        self.assertIn("grant_not_imported", reasons)

    @REAL_ONLY
    def test_wildcard_without_known_collections_explained(self):
        r = run_import(users_text("alice", "bob", "agent-2"), LEGACY_B)
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(LEGACY_B, new, r.model, matcher=MATCHER,
                                   result=r)
        self.assertEqual(rep.unexplained, [], rep.to_text())

    def test_write_without_read_is_reported(self):
        rights = LEGACY_A + "\n[w]\nuser: agent-2\ncollection: ^alice/(wonly)$\npermissions: w\n"
        r = run_import(users_text("alice", "agent-2"), rights)
        self.assertIn("write_without_read", [i.code for i in r.issues])
        self.assertIn(("agent-2", "alice", "wonly"), r.dropped)

    def test_unknown_owner_warning(self):
        rights = LEGACY_A + "\n[g]\nuser: agent-2\ncollection: ^ghost/(x)$\npermissions: r\n"
        r = run_import(users_text("alice", "agent-2"), rights)
        self.assertIn(("unknown_owner", "ghost/x"),
                      [(i.code, i.subject) for i in r.issues])
        self.assertTrue(r.ok)

    def test_groups_warning(self):
        rights = LEGACY_A + "\n[g]\ngroups: staff\ncollection: ^x$\npermissions: r\n"
        r = run_import(users_text("alice"), rights)
        self.assertIn("groups_ignored", [i.code for i in r.issues])

    def test_errors(self):
        h = fake_hash("x")
        users = "alice:%s\nadmin:%s\nBob:%s\nold:{SHA}abc\ndave:%s\n" % (h, h, h, h)
        r = run_import(users, LEGACY_A, admins=["alice", "ghost"])
        self.assertFalse(r.ok)
        codes = {(i.code, i.subject) for i in r.errors}
        self.assertEqual(codes, {("unusable_login", "admin"),
                                 ("unusable_login", "Bob"),
                                 ("unsupported_hash", "old"),
                                 ("admin_not_importable", "ghost")})
        self.assertEqual(r.skipped, frozenset({"admin", "Bob", "old"}))
        self.assertEqual(sorted(r.model.accounts), ["alice", "dave"])

    def test_extra_reserved_logins(self):
        r = run_import(users_text("alice", "billing"), LEGACY_A,
                       extra_reserved=["billing"])
        self.assertIn("billing", r.skipped)

    def test_no_admin_is_not_ok(self):
        r = run_import(users_text("agent-1"), LEGACY_A, admins=["alice"])
        self.assertFalse(r.ok)

    def test_bad_rights_file(self):
        r = run_import(users_text("alice"), "[x\n", admins=["alice"])
        self.assertFalse(r.ok)
        self.assertEqual([i.code for i in r.errors], ["bad_rights_file"])
        self.assertEqual(r.model.accounts, {})

    def test_cost_taken_from_hashes(self):
        h = "$2b$11$" + "a" * 53
        r = run_import("alice:%s\n" % h, LEGACY_A, admins=["alice"])
        self.assertEqual(r.model.bcrypt_cost, 11)

    def test_import_is_deterministic(self):
        a = run_import(users_text("alice", "agent-1", "agent-2"), LEGACY_A)
        b = run_import(users_text("alice", "agent-1", "agent-2"), LEGACY_A)
        self.assertEqual(M.dump(a.model), M.dump(b.model))


class EdgeTests(unittest.TestCase):
    def test_rule_without_user_pattern_is_skipped_like_radicale(self):
        lr = I.LegacyRights(I.parse_rights(
            "[g]\ngroups: staff\ncollection: ^x$\npermissions: r\n"
            "[a]\nuser: alice\ncollection: ^x$\npermissions: rw\n"))
        self.assertEqual(lr.authorization("alice", "x"), "rw")

    def test_too_many_accounts_makes_model_invalid(self):
        users = "".join("%s:%s\n" % ("u%03d" % i, fake_hash("x"))
                        for i in range(M.MAX_ACCOUNTS + 1))
        r = run_import(users, LEGACY_A, admins=["u000"])
        self.assertFalse(r.ok)
        self.assertEqual([i.code for i in r.errors], ["model_invalid"])
        self.assertEqual(r.model.accounts, {})

    @REAL_ONLY
    def test_unusable_account_access_is_explained(self):
        rights = LEGACY_A + (
            "\n[admin-acct]\nuser: admin\ncollection: ^admin$\npermissions: RW\n")
        users = users_text("alice", "agent-1", "admin")
        r = run_import(users, rights)
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(rights, new, r.model, matcher=MATCHER, result=r)
        self.assertEqual(rep.unexplained, [], rep.to_text())
        self.assertIn("account_not_imported", {d.reason for d in rep.differences})

    @REAL_ONLY
    def test_missing_root_rule_is_a_loosening(self):
        rights = LEGACY_A.replace("[root]\nuser: .+\ncollection: ^$\npermissions: R\n", "")
        r = run_import(users_text("alice", "agent-1"), rights)
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(rights, new, r.model, matcher=MATCHER, result=r)
        self.assertEqual(rep.unexplained, [], rep.to_text())
        self.assertIn(("agent-1", "", "root_discovery"),
                      {(d.user, d.path, d.reason) for d in rep.differences})

    @REAL_ONLY
    def test_item_depth_paths_are_not_compared(self):
        r = run_import(users_text("alice", "agent-2"), LEGACY_B,
                       known_collections={"alice": ["a/b"]})
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(LEGACY_B, new, r.model, matcher=MATCHER,
                                   result=r, known_collections={"alice": ["a/b"]})
        self.assertFalse([d for d in rep.differences if d.path.count("/") > 1])


class MoreEdgeTests(unittest.TestCase):
    def test_unanchored_patterns(self):
        rules = I.parse_rights("[a]\nuser: x\ncollection: alice/(a|b)\npermissions: r\n")
        self.assertEqual(I.extract_candidates(rules)[0],
                         {("alice", "a"), ("alice", "b")})

    @REAL_ONLY
    def test_report_without_import_result(self):
        r = run_import(users_text("alice", "agent-2"), LEGACY_A)
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(LEGACY_A, new, r.model, matcher=MATCHER)
        # without the importer's bookkeeping nothing is dropped or skipped
        self.assertEqual(rep.unexplained, [], rep.to_text())


LEGACY_C = """\
[root]
user: .+
collection: ^$
permissions: R

[alice-everything]
user: alice
collection: .+
permissions: RWrwDO

[agent-1-principal]
user: agent-1
collection: ^agent-1$
permissions: R

[agent-1-shared]
user: agent-1
collection: ^alice/(cal-work)$
permissions: rw
"""


class AdminCatchAllTests(unittest.TestCase):
    @REAL_ONLY
    def test_admin_dot_plus_rule_is_an_expected_tightening(self):
        r = run_import(users_text("alice", "agent-1"), LEGACY_C)
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(LEGACY_C, new, r.model, matcher=MATCHER,
                                   result=r)
        self.assertEqual(rep.unexplained, [], rep.to_text())
        hit = {(d.user, d.path, d.reason) for d in rep.differences
               if d.reason == "admin_toplevel_write_removed"}
        self.assertIn(("alice", "radui-probe-top", "admin_toplevel_write_removed"), hit)
        self.assertIn(("alice", "radui-gen-" + r.model.gen_token,
                       "admin_toplevel_write_removed"), hit)
        for d in rep.differences:
            if d.reason == "admin_toplevel_write_removed":
                self.assertEqual(d.category, "expected_tightening")

    @REAL_ONLY
    def test_admin_losing_read_is_still_unexplained(self):
        r = run_import(users_text("alice", "agent-1"), LEGACY_C)
        new = generator.generate(r.model)[0]
        body = new[:new.rindex("# radui-end")]
        weak = body.replace("collection: ^[^/]+$\npermissions: R\n",
                            "collection: ^[^/]+$\npermissions: \n", 1)
        self.assertNotEqual(weak, body)
        text = "%s# radui-end generation=%d sha256=%s\n" % (
            weak, r.model.generation, rightsfile.sha256_hex(weak))
        rep = I.equivalence_report(LEGACY_C, text, r.model, matcher=MATCHER,
                                   result=r)
        bad = [d for d in rep.unexplained if d.user == "alice"]
        self.assertTrue(bad)
        self.assertIn("read", bad[0].caps)

    @REAL_ONLY
    def test_non_admin_catch_all_write_is_unexplained(self):
        rights = LEGACY_C.replace("[agent-1-principal]\nuser: agent-1\ncollection: ^agent-1$\npermissions: R",
                                  "[agent-1-principal]\nuser: agent-1\ncollection: .+\npermissions: RW")
        r = run_import(users_text("alice", "agent-1"), rights)
        new = generator.generate(r.model)[0]
        rep = I.equivalence_report(rights, new, r.model, matcher=MATCHER, result=r)
        bad = [d for d in rep.unexplained if d.user == "agent-1"]
        self.assertTrue(bad, rep.to_text())
        self.assertEqual(bad[0].reason, "lost_access")


class CapabilityTests(unittest.TestCase):
    def caps(self, letters, depth, permits):
        return set(I.capabilities(letters, depth, permits))

    def test_old_semantics(self):
        old = I.OLD_PERMITS
        self.assertEqual(self.caps("rw", 2, old),
                         {"read", "write", "delete_collection",
                          "overwrite_collection", "proppatch"})
        self.assertEqual(self.caps("rwd", 2, old),
                         {"read", "write", "overwrite_collection", "proppatch"})
        self.assertEqual(self.caps("rwo", 2, old),
                         {"read", "write", "delete_collection", "proppatch"})
        self.assertEqual(self.caps("RW", 1, old),
                         {"read", "write", "delete_collection",
                          "overwrite_collection", "proppatch"})
        self.assertEqual(self.caps("RWD", 1, old),
                         {"read", "write", "overwrite_collection", "proppatch"})
        self.assertEqual(self.caps("R", 0, old), {"read"})
        self.assertEqual(self.caps("i", 1, old), {"probe"})
        self.assertEqual(self.caps("", 2, old), set())

    def test_new_semantics(self):
        new = I.NEW_PERMITS
        self.assertEqual(self.caps("rwl", 2, new), {"read", "write"})
        self.assertEqual(self.caps("rw", 2, new), {"read", "write", "proppatch"})
        self.assertEqual(self.caps("rwDO", 2, new),
                         {"read", "write", "delete_collection",
                          "overwrite_collection", "proppatch"})
        self.assertEqual(self.caps("RW", 1, new), {"read", "write", "proppatch"})
        self.assertEqual(self.caps("RWrwDO", 2, new),
                         {"read", "write", "delete_collection",
                          "overwrite_collection", "proppatch"})
        self.assertEqual(self.caps("r", 2, new), {"read"})

    def test_report_object(self):
        d = I.Difference("a", "p", "lost", ("read",), "r", "", "unexplained", "x")
        rep = I.Report([d], 3)
        self.assertEqual(rep.summary(), {"probes": 3, "expected_tightening": 0,
                                         "expected_loosening": 0, "unexplained": 1})
        self.assertEqual(rep.by_category("unexplained"), [d])
        self.assertIn("unexplained a p [read] r -> - (x)", rep.to_text())


if __name__ == "__main__":
    unittest.main()
