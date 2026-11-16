# SPDX-License-Identifier: AGPL-3.0-or-later
"""Backend ``health`` reports the ACTIVE generation next to the MODEL
generation, also after Radicale was made to run an older rights generation.

Actor model: an operator (or an accident) puts an older rights file back, or
Radicale restarts on a stale ``rights.lkg``. ``health`` must then say
``active: false`` / ``ok: false`` instead of repeating the model's number, and
a backend restart (reconcile) or an API restore must bring everything back.
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wp10_support as W  # noqa: E402

HEALTH_CACHE_WAIT = 2.3  # backend caches health for 2 s per model signature


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def replace(path, data):
    tmp = path + ".new"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.chmod(tmp, 0o640)
    os.rename(tmp, path)


def header_gen(data):
    return int(data.split(b"\n", 1)[0].rsplit(b"=", 1)[1])


@W.requires_radicale
class HealthGeneration(unittest.TestCase):
    def setUp(self):
        self.s = W.WStack("health").up()
        self.addCleanup(self.s.close)
        self.rights = os.path.join(self.s.managed, "rights")
        self.lkg = self.rights + ".lkg"

    def health(self, wait=True):
        if wait:
            time.sleep(HEALTH_CACHE_WAIT)
        r = self.s.api("GET", "/health")
        self.assertEqual(r.status, 200)
        self.assertEqual(set(r.json), {"ok", "generation", "active", "modelOk"})
        return r.json

    def create(self, login):
        self.s.make_user(login)

    def test_active_generation_follows_every_mutation(self):
        s = self.s
        h = self.health(wait=False)
        self.assertEqual(h, {"ok": True, "generation": 1, "active": True,
                             "modelOk": True})
        for i, login in enumerate(("late-1", "late-2", "late-3"), 2):
            self.create(login)
            h = self.health()
            self.assertEqual(h["generation"], i)
            self.assertEqual(header_gen(read(self.rights)), i)
            self.assertTrue(h["ok"] and h["active"])
            token = s.model().gen_token
            self.assertEqual(s.radicale_probe(token), 404)
            self.assertEqual(read(self.rights), read(self.lkg))

    def test_old_rights_file_put_back(self):
        s = self.s
        self.create("late-1")
        old_rights = read(self.rights)            # generation 2
        old_gen = header_gen(old_rights)
        self.create("late-2")                       # generation 3
        self.assertGreater(s.model().generation, old_gen)
        # a revert: both the rights file and the last-known-good copy are
        # replaced by the older generation (a backup restored by hand)
        replace(self.rights, old_rights)
        replace(self.lkg, old_rights)
        h = self.health()
        self.assertEqual(h["generation"], s.model().generation)  # the model
        self.assertFalse(h["active"], h)
        self.assertFalse(h["ok"], h)
        self.assertTrue(h["modelOk"])
        # Radicale really runs the OLD rules: late-2 has no principal rule
        self.assertEqual(s.dav("PROPFIND", "/", "late-2",
                               headers={"Depth": "0"}).status, 207)
        self.assertEqual(s.mkcalendar("late-2", "late-2", "c").status, 403)
        W.info("health after reverting rights to generation %d (model %d): %s"
               % (old_gen, s.model().generation, json.dumps(h)))
        # the backend restart reconciles (rolls the files forward) ...
        s.stop_backend()
        s.start_backend()
        h = self.health()
        self.assertTrue(h["ok"] and h["active"], h)
        self.assertEqual(header_gen(read(self.rights)), s.model().generation)
        self.assertEqual(s.mkcalendar("late-2", "late-2", "c").status, 201)
        self.assertIn('"result":"rolled_forward"', s.stdout())

    def test_revert_repaired_by_api_restore_without_restart(self):
        s = self.s
        self.create("late-1")
        old = read(self.rights)
        self.create("late-2")
        replace(self.rights, old)
        replace(self.lkg, old)
        self.assertFalse(self.health()["active"])
        # any new mutation writes a new generation and the plugin picks it up
        r = s.api("POST", "/accounts/late-1/password", "alice",
                  {"generate": True})
        self.assertEqual(r.status, 200, r.json)
        self.assertTrue(r.json["active"])
        s.pw["late-1"] = r.json["password"]
        h = self.health()
        self.assertTrue(h["ok"] and h["active"], h)
        self.assertEqual(h["generation"], s.model().generation)

    def test_radicale_restart_on_a_stale_lkg(self):
        s = self.s
        self.create("late-1")
        stale = read(self.rights)
        self.create("late-2")
        # the rights file is unusable and the last-known-good one is older
        replace(self.lkg, stale)
        replace(self.rights, b"# radui-admin generated; DO NOT EDIT. generation=99\n")
        s.stop_radicale()
        s.start_radicale()
        self.assertIn("rights file unusable", s.radicale_log_text())
        h = self.health()
        self.assertFalse(h["active"], h)
        self.assertFalse(h["ok"], h)
        self.assertTrue(h["modelOk"])
        s.stop_backend()
        s.start_backend()
        h = self.health()
        self.assertTrue(h["ok"] and h["active"], h)
        self.assertEqual(s.mkcalendar("late-2", "late-2", "c").status, 201)

    def test_model_corrupt_health_still_answers(self):
        s = self.s
        self.create("late-1")
        with open(os.path.join(s.state, "model.json"), "w") as fh:
            fh.write("{")
        h = self.health()
        self.assertFalse(h["modelOk"])
        self.assertFalse(h["ok"])
        self.assertFalse(h["active"])
        # the generation shown is the one in the managed file header
        self.assertEqual(h["generation"], header_gen(read(self.rights)))


if __name__ == "__main__":
    unittest.main()
