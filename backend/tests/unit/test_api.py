# SPDX-License-Identifier: AGPL-3.0-or-later
"""api.py: per-request checks, error model, endpoints (stubbed Radicale)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import helpers  # noqa: E402
from radui_admin import api as api_mod  # noqa: E402

ADMIN_ROUTES = [
    ("GET", "/directory", None), ("GET", "/accounts", None),
    ("POST", "/accounts", {"login": "zed", "displayName": "Z", "generate": True}),
    ("GET", "/accounts/bob", None), ("PATCH", "/accounts/bob", {"disabled": True}),
    ("DELETE", "/accounts/bob", {"confirm": "bob"}),
    ("POST", "/accounts/bob/password", {"generate": True}),
    ("GET", "/effective/bob", None), ("GET", "/generations", None),
    ("POST", "/generations/1/restore", {}),
]


def code(resp):
    return resp.body["error"]["code"]


class Fixture(unittest.TestCase):
    def setUp(self):
        self.fx = apihelpers.ApiFixture(apihelpers.make_dir(self))
        self.call = self.fx.call
        self.store = self.fx.store


class RequestChecks(Fixture):
    def test_host_origin_fetch_site(self):
        r = self.call("GET", "/me", headers={"host": "evil.example.net"})
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        r = self.call("GET", "/me", headers={"host": None})
        self.assertEqual(r.status, 403)
        r = self.call("GET", "/me", headers={"origin": "https://evil.example.net"})
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        r = self.call("GET", "/me", headers={"origin": "null"})
        self.assertEqual(r.status, 403)
        r = self.call("GET", "/me", headers={"sec-fetch-site": "cross-site"})
        self.assertEqual(r.status, 403)
        for ok in ("same-origin", "none"):
            self.assertEqual(self.call(
                "GET", "/me", headers={"sec-fetch-site": ok}).status, 200)
        self.assertEqual(self.call("GET", "/me", headers={
            "origin": None, "sec-fetch-site": None}).status, 200)

    def test_mutations_need_header_and_json_content_type(self):
        r = self.call("POST", "/accounts/bob/password", body={"generate": True},
                      headers={"x-radui": None})
        self.assertEqual((r.status, code(r)), (400, "missing_header"))
        r = self.call("POST", "/accounts/bob/password", body={"generate": True},
                      headers={"x-radui": "0"})
        self.assertEqual(code(r), "missing_header")
        for ctype in (None, "text/plain", "application/x-www-form-urlencoded",
                      "application/json; charset=latin-1", "application/jsonx"):
            r = self.call("POST", "/accounts/bob/password",
                          body={"generate": True},
                          headers={"content-type": ctype})
            self.assertEqual((r.status, code(r)), (415, "unsupported_media_type"),
                             ctype)
        r = self.call("POST", "/accounts/bob/password", body={"generate": True},
                      headers={"content-type": "Application/JSON; charset=UTF-8"})
        self.assertEqual(r.status, 200)

    def test_routing_errors(self):
        self.assertEqual(self.call("GET", "/nope").status, 404)
        r = self.call("PUT", "/me", body={})
        self.assertEqual((r.status, code(r)), (405, "bad_request"))
        self.assertIn("GET", r.headers["Allow"])
        self.assertEqual(self.call("GET", "/accounts/Bad%20x").status, 404)
        self.assertEqual(self.call("GET", "/accounts/ghost").status, 404)
        self.assertEqual(self.call("GET", "/me/").status, 404)
        r = self.fx.api.dispatch(api_mod.Request(
            "GET", "/other/me", {"host": "example.org"}, b"", "127.0.0.1"))
        self.assertEqual(r.status, 404)

    def test_dry_run_flag_validation(self):
        self.assertEqual(self.call("GET", "/me", query="?dryRun=1").status, 400)
        self.assertEqual(self.call("POST", "/accounts/bob/password",
                                   body={"generate": True},
                                   query="?dryRun=yes").status, 400)

    def test_no_www_authenticate_ever(self):
        for r in (self.call("GET", "/me", login=None),
                  self.call("GET", "/me", password="wrong"),
                  self.call("GET", "/me", headers={"authorization": "Basic !!"}),
                  self.call("GET", "/accounts", login="bob")):
            self.assertNotIn("www-authenticate",
                             {k.lower() for k in r.headers})


class Authentication(Fixture):
    def test_missing_malformed_wrong_password(self):
        r = self.call("GET", "/me", login=None)
        self.assertEqual((r.status, code(r)), (401, "unauthenticated"))
        self.assertEqual(self.fx.dav.calls, [])
        r = self.call("GET", "/me", headers={"authorization": "Basic zzz"})
        self.assertEqual(r.status, 401)
        self.assertEqual(self.fx.dav.calls, [])  # nothing forwarded
        r = self.call("GET", "/me", password="wrong")
        self.assertEqual(r.status, 401)
        self.assertEqual(self.fx.dav.calls[-1][0], "authenticate")

    def test_limiter_blocks_after_failures(self):
        for _ in range(3):
            self.assertEqual(self.call("GET", "/me", password="bad").status, 401)
        r = self.call("GET", "/me", password="bad")
        self.assertEqual((r.status, code(r)), (429, "rate_limited"))
        self.assertIn("Retry-After", r.headers)
        # a correct password from the blocked address is refused too
        self.assertEqual(self.call("GET", "/me").status, 429)
        # health stays reachable
        self.assertEqual(self.call("GET", "/health", login=None).status, 200)

    def test_forwarded_address_comes_from_trusted_header(self):
        self.call("GET", "/me", headers={"x-real-ip": "192.0.2.50"})
        self.assertEqual(self.fx.dav.calls[0], ("authenticate", "alice",
                                                "192.0.2.50"))
        self.fx.dav.calls.clear()
        self.call("GET", "/me", headers={"x-real-ip": "not an ip"})
        self.assertEqual(self.fx.dav.calls[0][2], "127.0.0.1")

    def test_unknown_or_disabled_account_is_forbidden(self):
        self.fx.dav.passwords["ghost"] = "pw"
        r = self.call("GET", "/me", login="ghost", password="pw")
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        self.assertEqual(self.call("PATCH", "/accounts/bob",
                                   body={"disabled": True}).status, 200)
        r = self.call("GET", "/me", login="bob")
        self.assertEqual(r.status, 403)

    def test_bot_and_person_cannot_call_admin_endpoints(self):
        for login in ("bob", "agent-1"):
            for method, path, body in ADMIN_ROUTES:
                r = self.call(method, path, login=login, body=body)
                self.assertEqual((r.status, code(r)), (403, "forbidden"),
                                 "%s %s %s" % (login, method, path))
        self.assertEqual(self.store.load_model().generation,
                         self.store.current_model().generation)
        self.assertNotIn("zed", self.store.load_model().accounts)

    def test_failed_auth_and_denials_are_audited(self):
        self.call("GET", "/me", password="bad")
        self.call("GET", "/accounts", login="bob")
        ev = [e["event"] for e in self.store.test_stream.events()]
        self.assertIn("auth.failed", ev)
        self.assertIn("auth.denied", ev)


class BodyLimits(Fixture):
    def post(self, raw):
        return self.call("POST", "/accounts/bob/password", raw=raw)

    def test_malformed_and_limits(self):
        for raw in (b"{", b"[1]", b'"x"', b"null", b'{"generate": true,}',
                    b'{"a":1,"a":2}', b"\xff\xfe", b'{"x": NaN}',
                    b'{"generate": 1.5}', b'{"a":{"b":{"c":{"d":1}}}}',
                    b'{"generate": "' + b"x" * 129 + b'"}',
                    b'{"generate": "\\ud800"}', b"[" * 5000):
            r = self.post(raw)
            self.assertEqual((r.status, code(r)), (400, "bad_request"), raw[:30])

    def test_depth_four_and_128_chars_accepted_in_shape(self):
        # depth 4: object -> object -> object -> value (rejected later as an
        # unknown field, which proves the parser let it through)
        r = self.post(b'{"a":{"b":{"c":1}}}')
        self.assertEqual(code(r), "validation")
        r = self.post(json.dumps({"password": "x" * 128}).encode())
        self.assertEqual(code(r), "validation")  # too long for a password

    def test_empty_body_is_empty_object(self):
        r = self.post(b"")
        self.assertEqual((r.status, code(r)), (422, "validation"))
        self.assertEqual(r.body["error"]["field"], "password")


class Accounts(Fixture):
    def create(self, **kw):
        body = {"login": "carol", "displayName": "Carol", "generate": True}
        body.update(kw)
        return self.call("POST", "/accounts", body=body, query=kw.pop("_q", ""))

    def test_create_with_generated_password(self):
        r = self.create()
        self.assertEqual(r.status, 201)
        pw = r.body["password"]
        self.assertEqual(len(pw), 20)
        self.assertEqual(r.body["account"]["login"], "carol")
        self.assertTrue(r.body["active"])
        self.assertNotIn("hash", json.dumps(r.body))
        self.assertEqual(r.body["generation"],
                         self.store.load_model().generation)
        from radui_admin import passwords
        self.assertTrue(passwords.verify_password(
            pw, self.store.load_model().accounts["carol"].hash))

    def test_typed_password_not_echoed_and_validated(self):
        r2 = self.call("POST", "/accounts", body={
            "login": "carol", "displayName": "C",
            "password": "correct horse battery 7"})
        self.assertEqual(r2.status, 201)
        self.assertNotIn("password", r2.body)
        for bad in ("short", "x" * 73, "dave-password-1", "password1234"):
            rr = self.call("POST", "/accounts", body={
                "login": "dave", "displayName": "D", "password": bad})
            self.assertEqual((rr.status, code(rr)), (422, "validation"), bad)
            self.assertEqual(rr.body["error"]["field"], "password")

    def test_inactive_generation_returns_202(self):
        self.store.prober.active = False
        r = self.create()
        self.assertEqual((r.status, r.body["warning"]), (202,
                                                         "activation_pending"))
        self.assertFalse(r.body["active"])
        self.assertIn("password", r.body)  # still shown once

    def test_validation_and_conflicts(self):
        cases = [({"login": "Alice"}, 409, "exists"),   # folds to alice
                 ({"login": "root"}, 422, "validation"),
                 ({"login": "radui-x"}, 422, "validation"),
                 ({"login": "a"}, 422, "validation"),
                 ({"login": "café"}, 422, "validation"),
                 ({"type": "robot"}, 422, "validation"),
                 ({"admin": "yes"}, 422, "validation"),
                 ({"displayName": ""}, 422, "validation"),
                 ({"displayName": "x" * 65}, 422, "validation"),
                 ({"displayName": "a\nb"}, 422, "validation"),
                 ({"extra": 1}, 422, "validation"),
                 ({"password": "x" * 20}, 422, "validation")]  # both given
        for patch, status, c in cases:
            r = self.create(**patch)
            self.assertEqual((r.status, code(r)), (status, c), patch)

    def test_bot_cannot_be_admin(self):
        r = self.create(type="bot", admin=True)
        self.assertEqual((r.status, code(r)), (422, "validation"))
        self.assertEqual(r.body["error"]["field"], "admin")

    def test_account_limit(self):
        fx = apihelpers.ApiFixture(apihelpers.make_dir(self), max_accounts=3)
        r = fx.call("POST", "/accounts", body={
            "login": "zed", "displayName": "Z", "generate": True})
        self.assertEqual((r.status, code(r)), (422, "validation"))

    def test_dry_run_returns_plan_and_writes_nothing(self):
        before = self.store.load_model().generation
        r = self.call("POST", "/accounts", body={
            "login": "carol", "displayName": "C", "generate": True},
            query="?dryRun=1")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.body["dryRun"])
        self.assertIn("carol", r.body["summary"])
        self.assertNotIn("password", r.body)
        self.assertTrue(r.body["rights"]["added"])
        self.assertTrue(any(e["login"] == "carol" for e in r.body["effective"]))
        self.assertEqual(self.store.load_model().generation, before)
        self.assertNotIn("carol", self.store.load_model().accounts)
        self.assertEqual(self.call("POST", "/accounts", body={
            "login": "carol", "displayName": "C", "generate": True}).status,
            201)

    def test_tombstoned_login_cannot_be_recreated(self):
        r = self.call("DELETE", "/accounts/bob", body={"confirm": "bob"})
        self.assertEqual(r.status, 200)
        r = self.create(login="bob")
        self.assertEqual((r.status, code(r)), (409, "tombstoned"))
        self.assertEqual(self.call("GET", "/accounts/bob").status, 404)

    def test_delete_needs_typed_confirmation(self):
        for body in ({}, {"confirm": "alice"}, {"confirm": "BOB"},
                     {"confirm": True}):
            r = self.call("DELETE", "/accounts/bob", body=body)
            self.assertEqual(r.status, 422, body)
        self.assertIn("bob", self.store.load_model().accounts)
        r = self.call("DELETE", "/accounts/bob", body={"confirm": "bob"},
                      query="?dryRun=1")
        self.assertEqual(r.status, 200)
        self.assertIn("bob", self.store.load_model().accounts)

    def test_lockout_codes(self):
        r = self.call("PATCH", "/accounts/alice", body={"disabled": True})
        self.assertEqual((r.status, code(r)), (409, "lockout_last_admin"))
        self.call("POST", "/accounts", body={
            "login": "root2", "displayName": "R", "admin": True,
            "generate": True})
        r = self.call("PATCH", "/accounts/alice", body={"disabled": True})
        self.assertEqual((r.status, code(r)), (409, "lockout_self"))
        r = self.call("DELETE", "/accounts/alice", body={"confirm": "alice"})
        self.assertEqual(code(r), "lockout_self")
        r = self.call("PATCH", "/accounts/alice", body={"admin": False})
        self.assertEqual(code(r), "lockout_self")
        r = self.call("PATCH", "/accounts/root2", body={"disabled": True})
        self.assertEqual(r.status, 200)  # another admin may disable root2

    def test_patch_fields_and_no_change(self):
        r = self.call("PATCH", "/accounts/bob", body={"displayName": "Robert"})
        self.assertEqual(r.body["account"]["displayName"], "Robert")
        gen = r.body["generation"]
        r = self.call("PATCH", "/accounts/bob", body={"displayName": "Robert"})
        self.assertEqual(r.body["generation"], gen)  # no new generation
        for body in ({}, {"confirm": "bob"}, {"unknown": 1},
                     {"admin": "x"}, {"type": "bot", "admin": True}):
            self.assertEqual(self.call("PATCH", "/accounts/bob",
                                       body=body).status, 422, body)

    def test_own_space_off_needs_confirmation_when_collections_exist(self):
        self.fx.dav.owned = 2
        r = self.call("PATCH", "/accounts/bob", body={"ownSpace": False})
        self.assertEqual((r.status, code(r)), (422, "validation"))
        self.assertEqual(r.body["error"]["field"], "confirm")
        r = self.call("PATCH", "/accounts/bob", body={"ownSpace": False},
                      query="?dryRun=1")
        self.assertTrue(r.body["confirmRequired"])
        r = self.call("PATCH", "/accounts/bob",
                      body={"ownSpace": False, "confirm": "bob"})
        self.assertEqual(r.status, 200)
        self.assertFalse(r.body["account"]["ownSpace"])
        self.assertEqual(self.fx.dav.calls[-3:][0][0], "count")

    def test_own_space_off_without_collections_needs_no_confirmation(self):
        self.fx.dav.owned = 0
        r = self.call("PATCH", "/accounts/bob", body={"ownSpace": False})
        self.assertEqual(r.status, 200)
        self.fx.dav.owned = 5  # turning it ON never asks
        r = self.call("PATCH", "/accounts/bob", body={"ownSpace": True})
        self.assertEqual(r.status, 200)

    def test_password_reset(self):
        old = self.store.load_model().accounts["bob"].hash
        r = self.call("POST", "/accounts/bob/password", body={"generate": True})
        self.assertEqual(r.status, 200)
        self.assertEqual(len(r.body["password"]), 20)
        self.assertNotEqual(self.store.load_model().accounts["bob"].hash, old)
        r = self.call("POST", "/accounts/bob/password",
                      body={"password": "a long enough passphrase!"})
        self.assertNotIn("password", r.body)
        r = self.call("POST", "/accounts/bob/password",
                      body={"password": "a long enough passphrase!",
                            "generate": True})
        self.assertEqual(r.status, 422)
        self.assertEqual(self.call("POST", "/accounts/ghost/password",
                                   body={"generate": True}).status, 404)

    def test_listing_never_contains_hashes(self):
        for path in ("/accounts", "/accounts/bob", "/directory", "/me",
                     "/me/access", "/grants", "/generations"):
            r = self.call("GET", path)
            self.assertEqual(r.status, 200, path)
            self.assertNotIn("$2b$", json.dumps(r.body), path)
            self.assertNotIn("hash", json.dumps(r.body).lower(), path)


class Grants(Fixture):
    def setUp(self):
        super().setUp()
        self.fx.dav.kinds[("bob", "cal")] = "calendar"
        self.fx.dav.kinds[("bob", "book")] = "addressbook"
        self.fx.dav.kinds[("bob", "plain")] = "other"

    def put(self, login="bob", **kw):
        body = {"owner": "bob", "collection": "cal", "grantee": "agent-1",
                "level": "read"}
        body.update(kw)
        return self.call("PUT", "/grants", login=login, body=body,
                         query=kw.pop("_q", ""))

    def test_owner_grants_changes_and_revokes(self):
        r = self.put()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.body["grant"]["level"], "read")
        gen = r.body["generation"]
        self.assertEqual(self.put().body["generation"], gen)  # idempotent
        r = self.put(level="readwrite")
        self.assertEqual(r.body["grant"]["level"], "readwrite")
        self.assertEqual(r.body["grant"]["grantedBy"], "bob")
        r = self.put(level="none")
        self.assertIsNone(r.body["grant"])
        self.assertEqual(self.store.load_model().grants, ())

    def test_only_owner_or_admin(self):
        r = self.put(login="agent-1")
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        self.assertEqual(self.put(login="alice").status, 200)  # admin for bob

    def test_collection_checks_use_callers_credentials(self):
        self.assertEqual(self.put(collection="nothere").status, 404)
        self.assertEqual(code(self.put(collection="nothere")),
                         "collection_not_found")
        r = self.put(collection="plain")
        self.assertEqual((r.status, code(r)), (422, "validation"))
        self.assertEqual(self.put(collection="book").status, 200)
        self.assertEqual(self.fx.dav.calls[-1][0], "kind")
        # revocation never needs the collection to exist (a grant must exist)
        self.fx.dav.kinds[("bob", "gone")] = "calendar"
        self.assertEqual(self.put(collection="gone").status, 200)
        del self.fx.dav.kinds[("bob", "gone")]
        self.assertEqual(self.put(collection="gone", level="none").status, 200)

    def test_grantee_rules(self):
        r = self.put(grantee="alice")        # admin: already full access
        self.assertEqual(r.status, 422)
        r = self.put(grantee="bob")          # self
        self.assertEqual(r.status, 422)
        r = self.put(grantee="ghost")        # owner: no account probing (M5)
        self.assertEqual((r.status, code(r)), (422, "validation"))
        r = self.put(login="alice", grantee="ghost")   # admin: specific error
        self.assertEqual((r.status, code(r)), (404, "not_found"))
        self.call("PATCH", "/accounts/agent-1", body={"disabled": True})
        r = self.put()
        self.assertEqual(r.body["error"]["field"], "grantee")
        r = self.put(login="alice")
        self.assertEqual(r.body["error"]["field"], "grantee")

    def test_bad_input_rejected_before_any_dav_call(self):
        for patch in ({"collection": "../x"}, {"collection": "a/b"},
                      {"collection": "c~"}, {"collection": ""},
                      {"level": "write"}, {"owner": "Bob"}, {"extra": 1}):
            self.fx.dav.calls.clear()
            r = self.put(**patch)
            self.assertEqual(r.status, 422, patch)
            self.assertNotIn("kind", [c[0] for c in self.fx.dav.calls], patch)
        r = self.call("PUT", "/grants", body={"owner": "bob"})
        self.assertEqual(r.status, 422)

    def test_dry_run_and_limit(self):
        r = self.put(_q="?dryRun=1") if False else self.call(
            "PUT", "/grants", body={"owner": "bob", "collection": "cal",
                                    "grantee": "agent-1", "level": "read"},
            login="bob", query="?dryRun=1")
        self.assertEqual(r.status, 200)
        self.assertIn("agent-1", r.body["summary"])
        self.assertEqual(self.store.load_model().grants, ())
        fx = apihelpers.ApiFixture(apihelpers.make_dir(self), max_grants=1)
        fx.dav.kinds.update({("bob", "a"): "calendar", ("bob", "b"): "calendar"})
        b = {"owner": "bob", "collection": "a", "grantee": "agent-1",
             "level": "read"}
        self.assertEqual(fx.call("PUT", "/grants", login="bob", body=b).status,
                         200)
        b["collection"] = "b"
        self.assertEqual(fx.call("PUT", "/grants", login="bob", body=b).status,
                         422)

    def test_get_grants_scoping(self):
        self.put()
        r = self.call("GET", "/grants", login="bob")
        self.assertEqual(len(r.body), 1)
        r = self.call("GET", "/grants", login="agent-1")
        self.assertEqual(r.body, [])           # own collections only
        r = self.call("GET", "/grants", login="agent-1", query="?owner=bob")
        self.assertEqual(r.status, 403)
        r = self.call("GET", "/grants", login="alice", query="?grantee=agent-1")
        self.assertEqual(len(r.body), 1)
        r = self.call("GET", "/grants", login="alice", query="?owner=agent-1")
        self.assertEqual(r.body, [])
        self.assertEqual(self.call("GET", "/grants", query="?x=1").status, 400)
        self.assertEqual(self.call("GET", "/grants",
                                   query="?owner=A%2Fb").status, 422)

    def test_me_access_shapes(self):
        self.put(level="readwrite")
        r = self.call("GET", "/me/access", login="agent-1")
        self.assertEqual(set(r.body), {"login", "admin", "ownSpace", "grants"})
        g = r.body["grants"][0]
        self.assertEqual(g["href"], "/bob/cal/")
        self.assertEqual((g["owner"], g["collection"], g["level"],
                          g["grantedBy"]), ("bob", "cal", "readwrite", "bob"))
        self.assertIn("created", g)
        r = self.call("GET", "/me/access", login="alice")
        self.assertEqual(r.body["principals"], ["agent-1", "alice", "bob"])
        self.assertEqual(r.body["grants"], [])
        r = self.call("GET", "/me/access", login="bob")
        self.assertNotIn("principals", r.body)


class OtherEndpoints(Fixture):
    def test_me_directory_health(self):
        r = self.call("GET", "/me", login="agent-1")
        self.assertEqual(r.body["type"], "bot")
        self.assertFalse(r.body["admin"])
        self.assertEqual(self.call("GET", "/directory", login="bob").status, 403)
        r = self.call("GET", "/directory")
        self.assertEqual({d["login"] for d in r.body},
                         {"alice", "bob", "agent-1"})
        self.assertEqual(set(r.body[0]), {"login", "displayName", "type"})
        r = self.call("GET", "/health", login=None)
        self.assertEqual(set(r.body), {"ok", "generation", "active", "modelOk"})

    @unittest.skipUnless(helpers.MATCHER, "Radicale interpreter not found")
    def test_effective_checked_against_radicale(self):
        self.fx.store._matcher = lambda rights, pairs: helpers.MATCHER(
            rights, pairs)
        self.call("PUT", "/grants", login="bob", body={
            "owner": "bob", "collection": "cal", "grantee": "agent-1",
            "level": "read"})
        self.fx.dav.kinds[("bob", "cal")] = "calendar"
        self.call("PUT", "/grants", login="bob", body={
            "owner": "bob", "collection": "cal", "grantee": "agent-1",
            "level": "read"})
        r = self.call("GET", "/effective/agent-1")
        self.assertEqual(r.status, 200)
        by = {e["path"]: e for e in r.body}
        self.assertEqual(by["/bob/cal"]["letters"], "r")
        self.assertEqual(by["/agent-1/*"]["letters"], "rwDO")
        self.assertEqual(by["/"]["letters"], "R")
        r = self.call("GET", "/effective/alice")
        by = {e["path"]: e for e in r.body}
        self.assertEqual(by["/bob/*"]["level"], "admin")
        self.assertEqual(by["/radui-probe-top"]["letters"], "R")
        self.assertEqual(self.call("GET", "/effective/ghost").status, 404)

    def test_generations_and_restore(self):
        first = self.store.load_model().generation
        self.call("POST", "/accounts", body={
            "login": "carol", "displayName": "C", "generate": True})
        r = self.call("GET", "/generations")
        self.assertEqual([g["generation"] for g in r.body],
                         [first, first + 1])
        self.assertEqual([g["current"] for g in r.body], [False, True])
        r = self.call("POST", "/generations/%d/restore" % first, body={},
                      query="?dryRun=1")
        self.assertEqual(r.status, 200)
        self.assertIn("carol", self.store.load_model().accounts)
        r = self.call("POST", "/generations/%d/restore" % first, body={})
        self.assertEqual((r.status, code(r)), (422, "validation"))  # no confirm
        r = self.call("POST", "/generations/%d/restore" % first,
                      body={"confirm": "restore-%d" % first})
        self.assertEqual((r.status, r.body["restoredFrom"]), (200, first))
        self.assertEqual(r.body["generation"], first + 2)
        self.assertNotIn("carol", self.store.load_model().accounts)
        self.assertEqual(self.call("POST", "/generations/999/restore",
                                   body={}).status, 404)

    def test_corrupt_model_gives_503_but_health_works(self):
        with open(self.store.cfg.model_path, "w") as fh:
            fh.write("{")
        r = self.call("GET", "/me")
        self.assertEqual((r.status, code(r)), (503, "model_corrupt"))
        r = self.call("GET", "/health", login=None)
        self.assertEqual(r.status, 200)
        self.assertFalse(r.body["modelOk"])

    def test_audit_lines_for_mutations_contain_no_secrets(self):
        r = self.call("POST", "/accounts", body={
            "login": "carol", "displayName": "C", "generate": True})
        pw = r.body["password"]
        text = "\n".join(self.store.test_stream.lines)
        self.assertNotIn(pw, text)
        self.assertNotIn("$2b$", text)
        self.assertNotIn("Basic", text)
        ev = [e for e in self.store.test_stream.events()
              if e["event"] == "account.create"][0]
        self.assertEqual((ev["actor"], ev["target"], ev["result"]),
                         ("alice", "carol", "ok"))
        self.assertEqual(ev["generation"], r.body["generation"])


if __name__ == "__main__":
    unittest.main()
