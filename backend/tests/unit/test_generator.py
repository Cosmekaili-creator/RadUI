# SPDX-License-Identifier: AGPL-3.0-or-later
"""Generator: golden files, determinism, layout, injection, Radicale parity."""
import dataclasses
import os
import random
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402
from helpers import GOLDEN, MATCHER, NOW, Builder, case_models  # noqa: E402
from radui_admin import expected, generator, model as M, rightsfile  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402

UPDATE = os.environ.get("RADUI_UPDATE_GOLDEN") == "1"


def _read(path):
    with open(path, encoding="ascii", newline="") as fh:
        return fh.read()


class GoldenTests(unittest.TestCase):
    def check_golden(self, name, suffix, text):
        path = os.path.join(GOLDEN, "%s.%s" % (name, suffix))
        if UPDATE:
            os.makedirs(GOLDEN, exist_ok=True)
            with open(path, "w", encoding="ascii", newline="") as fh:
                fh.write(text)
        self.assertEqual(_read(path), text, "golden mismatch: %s" % path)

    def test_golden_files(self):
        for name, model in sorted(case_models().items()):
            with self.subTest(case=name):
                rights, users, meta = generator.generate(model)
                self.check_golden(name, "rights", rights)
                self.check_golden(name, "users", users)
                self.check_golden(name, "model.json", M.dump(model))
                self.assertEqual(M.dump(M.load(M.dump(model))), M.dump(model))
                self.assertEqual(meta["generation"], model.generation)

    def test_every_case_passes_checker(self):
        for name, model in case_models().items():
            rights, users, _ = generator.generate(model)
            self.assertEqual(rightsfile.check_text(rights), [], name)


class LayoutTests(unittest.TestCase):
    def sections(self, model):
        return generator.rule_list(model)

    def test_admin_only_layout(self):
        s = self.sections(case_models()["admin-only"])
        token = case_models()["admin-only"].gen_token
        self.assertEqual([(x.user, x.collection, x.permissions) for x in s], [
            ("^$", "^radui-gen-" + token + "$", "i"),
            (".+", "^$", "R"),
            ("^alice$", "^alice$", "RW"),
            ("^alice$", "^[^/]+$", "R"),
            ("^alice$", "^[^/]+/.+$", "RWrwDO"),
            (".*", ".*", ""),
        ])

    def test_never_rw_on_toplevel_wildcard(self):
        for model in case_models().values():
            for r in generator.rule_list(model):
                if r.collection == "^[^/]+$":
                    self.assertEqual(r.permissions, "R")

    def test_enumerated_rw_for_ownspace_accounts_only(self):
        model = case_models()["ownspace-false"]
        rows = {(r.user, r.collection): r.permissions
                for r in generator.rule_list(model)}
        self.assertEqual(rows[("^alice$", "^dave$")], "RW")
        self.assertNotIn(("^alice$", "^carol$"), rows)
        # D3: ownSpace=false keeps RW on the principal, no own-collection rule
        self.assertEqual(rows[("^carol$", "^carol$")], "RW")
        self.assertNotIn(("^carol$", "^carol/[^/]+$"), rows)
        self.assertEqual(rows[("^dave$", "^dave/[^/]+$")], "rwDO")

    def test_disabled_and_tombstoned_have_no_rules_or_users_line(self):
        for case in ("disabled", "tombstoned"):
            model = case_models()[case]
            rights, users, _ = generator.generate(model)
            self.assertNotIn("bob", users)
            self.assertNotIn("bob", "".join(
                r.user for r in generator.rule_list(model)))
            for r in generator.rule_list(model):
                # bob may only appear as the OWNER side of a grant
                if case == "tombstoned" or "-grant-" not in r.name:
                    self.assertNotIn("bob", r.collection)
                else:
                    self.assertEqual(r.collection, "^bob/mine$")

    def test_grant_letters(self):
        model = case_models()["admin-bots-grants"]
        got = {(r.user, r.collection): r.permissions
               for r in generator.rule_list(model)}
        self.assertEqual(got[("^agent\\-1$", "^alice/cal\\-work$")], "r")
        self.assertEqual(got[("^agent\\-1$", "^alice/contacts$")], "rwl")

    def test_grants_sorted_and_after_users(self):
        names_ = [r.name for r in generator.rule_list(
            case_models()["admin-bots-grants"])]
        idx = [i for i, n in enumerate(names_) if "-grant-" in n]
        self.assertEqual(idx, list(range(idx[0], idx[0] + len(idx))))
        self.assertEqual(names_[-1], "zzz-deny")
        self.assertTrue(all("-user-" not in n for n in names_[idx[0]:-1]))

    def test_section_names_unique_and_safe(self):
        for model in case_models().values():
            n = [r.name for r in generator.rule_list(model)]
            self.assertEqual(len(n), len(set(n)))

    def test_login_that_looks_like_section_suffix_cannot_collide(self):
        b = Builder().account("alice", admin=True)
        b.account("foo-all").account("foo").account("foo-principal")
        n = [r.name for r in generator.rule_list(b.m)]
        self.assertEqual(len(n), len(set(n)))

    def test_grant_to_admin_not_emitted(self):
        b = Builder().account("alice", admin=True).account("bob")
        # an admin created after the grant keeps the (shadowed) grant
        b.account("carol").grant("bob", "c", "carol", "read")
        m = M.patch_account(b.m, "carol", admin=True, now=NOW, by="cli")
        self.assertEqual(len(m.grants), 1)
        rows = [r for r in generator.rule_list(m) if "-grant-" in r.name]
        self.assertEqual(rows, [])

    def grant_rows(self, model):
        return [(r.user, r.collection, r.permissions)
                for r in generator.rule_list(model) if "-grant-" in r.name]

    def test_disabled_owner_keeps_grants(self):
        b = Builder().account("alice", admin=True).account("bob").account("carol")
        b.grant("bob", "c", "carol", "read").disable("bob")
        self.assertEqual(self.grant_rows(b.m), [("^carol$", "^bob/c$", "r")])

    def test_disabled_grantee_loses_grants_but_model_keeps_them(self):
        b = Builder().account("alice", admin=True).account("bob").account("carol")
        b.grant("bob", "c", "carol", "read").disable("carol")
        self.assertEqual(self.grant_rows(b.m), [])
        self.assertEqual(len(b.m.grants), 1)

    def test_deleted_owner_or_grantee_removes_grants(self):
        for victim in ("bob", "carol"):
            b = Builder().account("alice", admin=True).account("bob")
            b.account("carol").grant("bob", "c", "carol", "read").delete(victim)
            self.assertEqual(b.m.grants, ())
            self.assertEqual(self.grant_rows(b.m), [])

    def test_determinism(self):
        for model in case_models().values():
            self.assertEqual(generator.generate(model), generator.generate(model))
            again = M.load(M.dump(model))
            self.assertEqual(generator.generate(again), generator.generate(model))

    def test_generation_rule_and_trailer(self):
        model = case_models()["admin-bots-grants"]
        rights, _, meta = generator.generate(model)
        self.assertTrue(rights.startswith(
            "# radui-admin generated; DO NOT EDIT. generation=%d\n" % model.generation))
        last = rights.rstrip("\n").rsplit("\n", 1)[1]
        self.assertTrue(last.startswith("# radui-end generation=%d sha256="
                                        % model.generation))
        self.assertIn("^radui-gen-%s$" % model.gen_token, rights)
        self.assertEqual(meta["genToken"], model.gen_token)

    def test_users_text(self):
        model = case_models()["admin-bots-grants"]
        users = generator.users_text(model)
        lines = users.splitlines()
        self.assertTrue(lines[0].startswith("# radui-admin generated"))
        self.assertEqual([l.split(":")[0] for l in lines[1:]],
                         ["agent-1", "agent-2", "alice", "bob"])
        for l in lines[1:]:
            self.assertRegex(l.split(":", 1)[1],
                             r"^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$")

    def test_disabled_account_not_in_users(self):
        users = generator.users_text(case_models()["disabled"])
        self.assertNotIn("bob:", users)
        self.assertIn("carol:", users)

    def test_users_rejects_bad_hash(self):
        model = case_models()["admin-only"]
        acc = dataclasses.replace(model.accounts["alice"], hash="plain")
        bad = dataclasses.replace(model, accounts={"alice": acc})
        with self.assertRaises(ValueError):
            generator.users_text(bad)

    def test_unsafe_names_refused_defence_in_depth(self):
        with self.assertRaises(ValueError):
            generator._esc_login("A/../b")
        with self.assertRaises(ValueError):
            generator._esc_name("a{0}")
        model = case_models()["admin-only"]
        evil = dataclasses.replace(model, accounts={
            "al{0}": model.accounts["alice"]})
        with self.assertRaises(ValueError):
            generator.rule_list(evil)

    def test_users_text_refuses_non_ascii(self):
        # defence in depth: reachable only if the earlier checks were bypassed
        model = case_models()["admin-only"]
        bad = dataclasses.replace(model, accounts={
            "al\u00efce": model.accounts["alice"]})
        with mock.patch.object(generator.names, "is_valid_login",
                               return_value=True), \
                mock.patch.object(generator.names, "BCRYPT_HASH_RE",
                                  mock.Mock(fullmatch=lambda v: True)):
            with self.assertRaises(ValueError):
                generator.users_text(bad)

    def test_escaping_in_output(self):
        rights, _, _ = generator.generate(case_models()["odd-names"])
        self.assertIn(r"^a\.b$", rights)
        self.assertIn(r"^x\-y_z\.0/my\.cal\+1$", rights)
        for bad in "{}%\r":
            self.assertNotIn(bad, rights)


@unittest.skipUnless(MATCHER, "no Radicale interpreter configured")
class RadicaleParityTests(unittest.TestCase):
    """Generated text evaluated by Radicale's own matcher equals the oracle."""

    def test_all_cases_all_probes(self):
        for name, model in sorted(case_models().items()):
            with self.subTest(case=name):
                rights, _, _ = generator.generate(model)
                bad = expected.mismatches(model, rights, MATCHER)
                self.assertEqual(bad, [], bad[:5])

    def test_probe_count_nontrivial(self):
        self.assertGreater(len(expected.probe_pairs(
            case_models()["admin-bots-grants"])), 100)

    def test_oracle_has_teeth(self):
        # a tampered rights text must be detected by the comparison
        model = case_models()["admin-bots-grants"]
        rights, _, _ = generator.generate(model)
        tampered = rights.replace("permissions: r\n", "permissions: rwl\n", 1)
        self.assertNotEqual(tampered, rights)
        body = tampered.rsplit("# radui-end", 1)[0]
        text = "%s# radui-end generation=%d sha256=%s\n" % (
            body, model.generation, rightsfile.sha256_hex(body))
        self.assertTrue(expected.mismatches(model, text, MATCHER))

    def test_radicale_accepts_every_golden_file(self):
        for name in case_models():
            text = _read(os.path.join(GOLDEN, name + ".rights"))
            self.assertEqual(len(MATCHER(text, [("alice", "")])), 1)

    def test_first_match_wins_admin_not_shadowed(self):
        model = case_models()["two-admins"]
        rights, _, _ = generator.generate(model)
        pairs = [("alice", "bob"), ("alice", "carol"), ("alice", "dave"),
                 ("alice", "alice"), ("alice", "carol/cal"),
                 ("bob", "alice/x"), ("bob", "toplevel-unknown")]
        got = MATCHER(rights, pairs)
        self.assertEqual(
            [frozenset(g) for g in got],
            [frozenset(s) for s in ("RW", "RW", "R", "RW", "RWrwDO",
                                    "RWrwDO", "R")])


@unittest.skipUnless(MATCHER, "no Radicale interpreter configured")
class RandomModelTests(unittest.TestCase):
    """Seeded random operation sequences: oracle == Radicale on every probe."""

    LOGINS = ["alice", "bob", "carol", "a.b", "x-y_z", "n0", "agent-1",
              "agent.2", "u" + "9" * 31]
    COLLS = ["cal", "My.Cal+1", "x@y~z", "_t", "A-1", "c" * 128]

    def test_random_sequences(self):
        rnd = random.Random(20261112)
        for seq in range(20):
            b = Builder().account("alice", admin=True)
            for step in range(40):
                op = rnd.choice(["acct", "acct", "acct", "grant", "grant",
                                 "grant", "grant", "grant", "disable",
                                 "enable", "delete", "own", "admin"])
                login = rnd.choice(self.LOGINS)
                have = sorted(b.m.accounts)
                try:
                    if op == "acct":
                        b.account(login, type=rnd.choice(["person", "bot"]),
                                  own_space=rnd.random() < 0.7)
                    elif op == "grant":
                        b.grant(rnd.choice(have), rnd.choice(self.COLLS),
                                rnd.choice(have),
                                rnd.choice(["none", "read", "readwrite", "read"]))
                    elif op == "disable":
                        b.disable(login)
                    elif op == "enable":
                        b.m = M.enable_account(b.m, login, now=NOW, by="cli")
                    elif op == "delete" and login != "alice":
                        b.delete(login)
                    elif op == "own":
                        b.m = M.patch_account(b.m, login, now=NOW, by="cli",
                                              own_space=rnd.random() < 0.5)
                    elif op == "admin":
                        b.m = M.patch_account(b.m, login, now=NOW, by="cli",
                                              admin=rnd.random() < 0.5)
                except ApiError:
                    continue
            with self.subTest(seq=seq, accounts=len(b.m.accounts)):
                rights, users, _ = generator.generate(b.m)
                self.assertEqual(rightsfile.check_text(rights), [])
                bad = expected.mismatches(b.m, rights, MATCHER)
                self.assertEqual(bad, [], bad[:3])
                self.assertEqual(generator.generate(M.load(M.dump(b.m))),
                                 (rights, users, generator.generate(b.m)[2]))


if __name__ == "__main__":
    unittest.main()
