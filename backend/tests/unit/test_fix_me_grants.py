# SPDX-License-Identifier: AGPL-3.0-or-later
"""M2: ``GET me`` carries ``rightsActive`` and ``ok``. M5: a non-admin owner
cannot probe accounts through ``PUT /grants``."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import test_fix_common as C  # noqa: E402


def code(resp):
    return resp.body["error"]["code"]


class MeCarriesHealth(unittest.TestCase):
    def setUp(self):
        self.fx = apihelpers.ApiFixture(C.tmp_root(self))

    def test_me_has_the_old_fields_plus_rights_active_and_ok(self):
        r = self.fx.call("GET", "/me", login="bob")
        self.assertEqual(r.status, 200)
        self.assertEqual(set(r.body), {
            "login", "displayName", "type", "admin", "ownSpace", "generation",
            "rightsActive", "ok"})
        self.assertEqual((r.body["rightsActive"], r.body["ok"]), (True, True))
        self.assertEqual(r.body["login"], "bob")

    def test_me_follows_the_same_data_as_health(self):
        store = self.fx.store
        store.prober.active = False
        store._health = None
        r = self.fx.call("GET", "/me", login="bob")
        h = self.fx.call("GET", "/health", login=None)
        self.assertEqual((r.body["rightsActive"], r.body["ok"]), (False, False))
        self.assertEqual((h.body["active"], h.body["ok"]), (False, False))
        self.assertEqual(set(h.body), {"ok", "generation", "active", "modelOk"})
        store.prober.active = True
        store._health = None
        r = self.fx.call("GET", "/me", login="alice")
        self.assertEqual((r.body["rightsActive"], r.body["ok"]), (True, True))

    def test_health_is_unchanged_and_still_public(self):
        h = self.fx.call("GET", "/health", login=None)
        self.assertEqual(h.status, 200)
        self.assertEqual(set(h.body), {"ok", "generation", "active", "modelOk"})


class GrantProbing(unittest.TestCase):
    def setUp(self):
        b = (C.base_builder().account("dave").account("root-2", admin=True)
             .disable("dave"))
        self.fx = apihelpers.ApiFixture(C.tmp_root(self), builder=b)
        self.fx.dav.kinds[("bob", "cal")] = "calendar"
        self.store = self.fx.store

    def put(self, login, grantee, level="read", owner="bob"):
        return self.fx.call("PUT", "/grants", login=login, body={
            "owner": owner, "collection": "cal", "grantee": grantee,
            "level": level})

    def test_unknown_disabled_and_admin_grantees_answer_the_same(self):
        self.fx.dav.calls.clear()
        answers = [self.put("bob", g) for g in ("ghost-1", "dave", "alice",
                                                "root-2")]
        first = answers[0]
        self.assertEqual((first.status, code(first)), (422, "validation"))
        self.assertEqual(first.body["error"]["field"], "grantee")
        for other in answers[1:]:
            self.assertEqual((other.status, other.body), (first.status,
                                                          first.body))
        self.assertEqual([c for c in self.fx.dav.calls if c[0] == "kind"], [])
        self.assertEqual(self.store.load_model().grants, ())

    def test_level_none_gives_the_same_answer_without_a_grant(self):
        unknown = self.put("bob", "ghost-1", "none")
        disabled = self.put("bob", "dave", "none")
        existing = self.put("bob", "carol", "none")   # exists, no grant
        self.assertEqual(unknown.status, 422)
        for other in (disabled, existing):
            self.assertEqual((other.status, other.body),
                             (unknown.status, unknown.body))

    def test_existing_grantee_still_works_and_can_be_revoked(self):
        r = self.put("bob", "carol")
        self.assertEqual(r.status, 200)
        r = self.put("bob", "carol", "none")
        self.assertEqual(r.status, 200)
        self.assertIsNone(r.body["grant"])

    def test_a_grant_to_a_since_disabled_account_can_still_be_revoked(self):
        self.assertEqual(self.put("bob", "carol").status, 200)
        self.fx.call("PATCH", "/accounts/carol", body={"disabled": True})
        self.assertEqual(self.put("bob", "carol").status, 422)   # no new grant
        r = self.put("bob", "carol", "none")
        self.assertEqual((r.status, r.body["grant"]), (200, None))
        self.assertEqual(self.store.load_model().grants, ())

    def test_ownership_is_checked_before_the_grantee(self):
        # a stranger learns nothing about the grantee: 403 whoever it is
        for grantee in ("ghost-1", "dave", "carol"):
            r = self.put("agent-1", grantee)
            self.assertEqual((r.status, code(r)), (403, "forbidden"), grantee)

    def test_admins_keep_the_specific_errors(self):
        r = self.put("alice", "ghost-1")
        self.assertEqual((r.status, code(r)), (404, "not_found"))
        self.assertEqual(r.body["error"]["field"], "grantee")
        r = self.put("alice", "dave")
        self.assertEqual((r.status, code(r)), (422, "validation"))
        self.assertIn("disabled", r.body["error"]["message"])
        r = self.put("alice", "root-2")
        self.assertEqual(r.status, 422)
        self.assertIn("admins", r.body["error"]["message"])
        r = self.put("alice", "ghost-1", "none")
        self.assertEqual((r.status, code(r)), (404, "not_found"))


if __name__ == "__main__":
    unittest.main()
