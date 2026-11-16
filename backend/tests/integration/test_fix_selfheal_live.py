# SPDX-License-Identifier: AGPL-3.0-or-later
"""M3 live: a real backend and a real Radicale (production plugin). Fault
injection on the managed files while both run; the backend's self-heal timer
must put things right within its interval, and health must say ``active``."""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_fix_stack as F  # noqa: E402

INTERVAL = 1
WAIT = 25


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


class LiveBase(unittest.TestCase):
    cfg = {"self_heal_interval_s": INTERVAL}

    def setUp(self):
        self.s = F.FStack("heal", cfg=self.cfg).up()
        self.addCleanup(self.s.close)
        self.rights = os.path.join(self.s.managed, "rights")
        self.lkg = self.rights + ".lkg"

    def health(self):
        r = self.s.api("GET", "/health")
        self.assertEqual(r.status, 200)
        return r.json

    def wait(self, cond, seconds=WAIT):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if cond():
                return True
            time.sleep(0.25)
        return cond()

    def healthy(self):
        h = self.health()
        return h["ok"] and h["active"]

    def heals(self):
        return self.s.stdout().count('"event":"self-heal"')


@F.requires_radicale
class DamagedMainFile(LiveBase):
    def test_a_torn_rights_file_is_rewritten_and_health_returns_to_active(self):
        s = self.s
        s.make_user("late-1")
        good = read(self.rights)
        self.assertTrue(self.wait(self.healthy))
        with open(self.rights, "r+b") as fh:         # in-place truncation
            fh.truncate(len(good) // 2)
        self.assertNotEqual(read(self.rights), good)
        self.assertTrue(self.wait(lambda: read(self.rights) == good),
                        "the file was not rewritten within the interval")
        self.assertTrue(self.wait(self.healthy), self.health())
        self.assertEqual(s.cli("check-radicale")[0], 0)
        self.assertGreaterEqual(self.heals(), 1)
        self.assertIn('"result":"rolled_forward"', s.stdout())
        self.assertEqual(s.mkcalendar("late-1", "late-1", "c").status, 201)

    def test_a_removed_users_file_and_a_garbage_rights_file_heal(self):
        s = self.s
        good_rights = read(self.rights)
        good_users = read(os.path.join(s.managed, "users"))
        os.unlink(os.path.join(s.managed, "users"))
        replace(self.rights, b"[x]\nuser: .*\n")
        self.assertTrue(self.wait(lambda: read(self.rights) == good_rights and
                                  os.path.exists(os.path.join(s.managed,
                                                              "users"))))
        self.assertEqual(read(os.path.join(s.managed, "users")), good_users)
        self.assertTrue(self.wait(self.healthy))


@F.requires_radicale
class StaleState(LiveBase):
    def test_a_revert_to_a_stale_state_heals(self):
        s = self.s
        s.make_user("late-1")
        old = read(self.rights)
        s.make_user("late-2")
        replace(self.rights, old)                  # a backup put back by hand
        replace(self.lkg, old)
        self.assertTrue(self.wait(lambda: header_gen(read(self.rights))
                                  == s.model().generation))
        self.assertTrue(self.wait(self.healthy), self.health())
        # Radicale really runs the new rules again
        self.assertEqual(s.mkcalendar("late-2", "late-2", "c").status, 201)

    def test_radicale_restarted_on_a_stale_lkg_heals_while_the_backend_runs(self):
        s = self.s
        s.make_user("late-1")
        stale = read(self.rights)
        s.make_user("late-2")
        # the main rights file is unusable and the last-known-good one is older
        replace(self.lkg, stale)
        replace(self.rights,
                b"# radui-admin generated; DO NOT EDIT. generation=99\n")
        s.stop_radicale()
        s.start_radicale()
        self.assertIn("rights file unusable", s.radicale_log_text())
        self.assertTrue(self.wait(lambda: header_gen(read(self.rights))
                                  == s.model().generation))
        self.assertTrue(self.wait(self.healthy), self.health())
        self.assertEqual(s.mkcalendar("late-2", "late-2", "c").status, 201)
        self.assertEqual(read(self.lkg), read(self.rights))


@F.requires_radicale
class SwitchedOff(LiveBase):
    cfg = {"self_heal_interval_s": 0}

    def test_interval_zero_leaves_a_damaged_file_alone(self):
        s = self.s
        good = read(self.rights)
        with open(self.rights, "r+b") as fh:
            fh.truncate(len(good) // 2)
        time.sleep(3)
        self.assertNotEqual(read(self.rights), good)
        self.assertEqual(self.heals(), 0)
        # the manual fix is still there: a backend restart reconciles
        s.stop_backend()
        s.start_backend()
        self.assertEqual(read(self.rights), good)


@F.requires_radicale
class QuietWhenHealthy(LiveBase):
    def test_no_self_heal_lines_and_the_backend_stops_cleanly(self):
        time.sleep(3.5)
        self.assertEqual(self.heals(), 0)
        self.assertTrue(self.healthy())
        t0 = time.monotonic()
        self.s.stop_backend()                      # SIGTERM: must not hang
        self.assertLess(time.monotonic() - t0, 10)
        self.assertNotIn("Traceback", self.s.stderr())


if __name__ == "__main__":
    unittest.main()
