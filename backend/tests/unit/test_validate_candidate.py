# SPDX-License-Identifier: AGPL-3.0-or-later
"""validate_candidate.py: pre-write validation through Radicale's own code."""
import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402
from radui_admin import generator, rightsfile  # noqa: E402
from radui_admin import validate_candidate as vc  # noqa: E402

PY = helpers.expected.find_radicale_python()


def resign(text, edit):
    """Edit the body of a rights file and re-sign it (header and trailer
    stay valid, so only the semantic checks can catch the edit)."""
    body = text[:text.rindex("# radui-end")]
    gen = int(body.split("\n", 1)[0].rsplit("=", 1)[1])
    body = edit(body)
    return "%s# radui-end generation=%d sha256=%s\n" % (
        body, gen, hashlib.sha256(body.encode()).hexdigest())


@unittest.skipUnless(PY, "Radicale interpreter not found")
class ValidateCandidate(unittest.TestCase):
    def setUp(self):
        b = (helpers.Builder().account("alice", admin=True).account("bob")
             .account("agent-1", type="bot").grant("bob", "cal", "agent-1", "read"))
        self.m = b.m
        self.rights, self.users, _ = generator.generate(self.m)

    def check(self, rights=None, users=None, model=True):
        return vc.validate(rights or self.rights, users or self.users,
                           self.m if model else None, python=PY)

    def rejected(self, **kw):
        with self.assertRaises(vc.CandidateRejected) as cm:
            self.check(**kw)
        return cm.exception.problems

    def test_good_files_pass(self):
        res = self.check()
        self.assertTrue(res.radicale_version.startswith("3."))
        self.assertGreater(res.probes, 50)
        self.assertTrue(res.users_checked)
        self.check(model=False)

    def test_local_checker_rejects_first(self):
        problems = self.rejected(rights=self.rights[:-30])
        self.assertTrue(problems[0].startswith("rights:"))

    def test_semantic_edit_that_stays_well_formed_is_caught_by_probes(self):
        # bob gets an extra letter on his own principal; every format check
        # still passes, only the oracle comparison can notice
        def edit(body):
            names_ = [ln for ln in body.splitlines() if "user-principal-bob" in ln]
            sec = names_[0]
            j = body.index(sec)
            k = body.index("permissions: RW", j)
            return body[:k] + "permissions: RWr" + body[k + len("permissions: RW"):]
        problems = self.rejected(rights=resign(self.rights, edit))
        self.assertTrue(any("bob" in p and "got" in p for p in problems),
                        problems)

    def test_missing_grant_rule_is_caught(self):
        def edit(body):
            start = body.rindex("[", 0, body.index("grant-agent-1"))
            end = body.index("\n\n", start) + 2
            return body[:start] + body[end:]
        problems = self.rejected(rights=resign(self.rights, edit))
        self.assertTrue(any("agent-1" in p for p in problems), problems)

    def test_generation_mismatch_with_model(self):
        other = generator.generate(self.m)[0].replace(
            "generation=%d" % self.m.generation, "generation=999", 1)
        self.assertTrue(self.rejected(rights=other))

    def test_users_problems(self):
        dup = self.users + self.users.splitlines()[1] + "\n"
        problems = self.rejected(users=dup)
        self.assertTrue(problems)
        broken = self.users + "nopassword:\n"
        self.assertTrue(self.rejected(users=broken))
        self.assertTrue(self.rejected(users=self.users.replace("bob:", "bobby:")))
        h = self.m.accounts["bob"].hash
        other = "$2b$04$" + "b" * 53
        self.assertTrue(self.rejected(users=self.users.replace(h, other)))

    def test_missing_plugin_python_and_timeout(self):
        with self.assertRaises(vc.CandidateRejected):
            vc.validate(self.rights, self.users, self.m, python="/nonexistent")
        with self.assertRaises(vc.CandidateRejected):
            vc.validate(self.rights, self.users, self.m, python=PY,
                        plugin_dir="/nonexistent")
        with self.assertRaisesRegex(vc.CandidateRejected, "timed out"):
            vc.validate(self.rights, self.users, self.m, python=PY,
                        timeout=0.01)

    def test_python_without_radicale_is_rejected(self):
        with self.assertRaises(vc.CandidateRejected) as cm:
            vc.validate(self.rights, self.users, self.m,
                        python="/usr/bin/python3")
        self.assertIn("radicale", str(cm.exception).lower())

    def test_validate_files_reads_both(self):
        import apihelpers
        d = apihelpers.make_dir(self)
        rp, up = os.path.join(d, "rights"), os.path.join(d, "users")
        with open(rp, "w") as fh:
            fh.write(self.rights)
        with open(up, "w") as fh:
            fh.write(self.users)
        self.assertTrue(vc.validate_files(rp, up, self.m, python=PY))
        with self.assertRaises(vc.CandidateRejected):
            vc.validate_files(rp, os.path.join(d, "nope"), self.m, python=PY)


if __name__ == "__main__":
    unittest.main()


class ReducePairs(unittest.TestCase):
    def model(self, n):
        b = helpers.Builder().account("alice", admin=True)
        for i in range(n):
            b.account("u%03d" % i)
        b.grant("u000", "cal", "u%03d" % min(50, n - 1), "read")
        b.delete("u001")
        return b.m

    def test_small_models_are_probed_completely(self):
        m = self.model(10)
        pairs = helpers.expected.probe_pairs(m)
        self.assertEqual(vc.reduce_pairs(m, pairs), pairs)

    def test_large_models_are_reduced_but_keep_the_important_pairs(self):
        m = self.model(150)
        pairs = helpers.expected.probe_pairs(m)
        red = vc.reduce_pairs(m, pairs, limit=5000)
        self.assertLess(len(red), len(pairs) // 2)
        keep = set(red)
        for u in m.accounts:               # own principal and own collections
            self.assertIn((u, u), keep)
            self.assertIn((u, u + "/radui-probe"), keep)
        self.assertIn(("u050", "u000/cal"), keep)            # the grant
        self.assertIn(("u050", "u000"), keep)                # its owner
        for u in ("alice", ""):                              # admins, anonymous
            self.assertEqual({p for x, p in pairs if x == u},
                             {p for x, p in red if x == u})
        self.assertIn(("u010", "u001"), keep)                # tombstoned
        self.assertIn(("u010", "radui-probe-top"), keep)
        self.assertIn(("u011", "u010"), keep)                # neighbour sample
        self.assertEqual(vc.reduce_pairs(m, pairs, limit=5000), red)  # stable
