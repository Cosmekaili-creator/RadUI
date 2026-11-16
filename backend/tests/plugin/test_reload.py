# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plugin tests (a) and (b): reload after atomic replace; equal-length rewrites.

(b) writes two rights files of identical length (a grant that switches between
two collection names of the same length), in place and with the mtime restored
by ``os.utime``, inside and after the 2 s window in which the plugin does not
trust an unchanged stat signature.
"""
import os
import time
import unittest

from . import support
from .support import Instance, good_rights, info, requires_radicale

GRANT_AA = [("bob", "alice", "cal-aa", "rw")]
GRANT_BB = [("bob", "alice", "cal-bb", "rw")]


def pair(gen):
    """Two same-length rights files: bob may write cal-aa, or cal-bb."""
    a, _ = good_rights(gen, GRANT_AA)
    b, _ = good_rights(gen + 1, GRANT_BB)
    assert len(a) == len(b)
    return a, b


@requires_radicale
class AtomicReplace(unittest.TestCase):
    """(a) A change made by atomic rename applies on the next request."""

    @classmethod
    def setUpClass(cls):
        cls.inst = Instance("reload-a")
        cls.addClassCleanup(cls.inst.close)
        cls.token = cls.inst.bootstrap()

    @classmethod
    def tearDownClass(cls):
        cls.inst.close()

    def test_a_atomic_rename_applies_on_next_request(self):
        inst = self.inst
        self.assertEqual(inst.level("bob", "alice", "cal-aa"), "-")
        for round_no in range(5):
            data, token = good_rights(10 + 2 * round_no, GRANT_AA)
            inst.write_rights(data, "atomic")
            self.assertEqual(inst.level("bob", "alice", "cal-aa"), "W",
                             "grant not effective on the very next request")
            self.assertEqual(inst.probe(token), 404, "new generation inactive")
            data, token = good_rights(11 + 2 * round_no, [])
            inst.write_rights(data, "atomic")
            self.assertEqual(inst.level("bob", "alice", "cal-aa"), "-",
                             "revocation not effective on the very next request")
            self.assertEqual(inst.probe(token), 404)

    def test_a_old_generation_token_no_longer_active(self):
        inst = self.inst
        data, old_token = good_rights(100, [])
        inst.write_rights(data)
        self.assertEqual(inst.probe(old_token), 404)
        data, new_token = good_rights(101, [])
        inst.write_rights(data)
        self.assertEqual(inst.probe(new_token), 404)
        self.assertEqual(inst.probe(old_token), 401)

    def test_a_rename_of_backdated_file_with_old_mtime(self):
        """A replacement file whose mtime lies far in the past (a restored
        backup) is a different inode and must still be picked up."""
        inst = self.inst
        data, _ = good_rights(120, GRANT_AA)
        tmp = inst.rights_path + ".stage"
        with open(tmp, "wb") as fh:
            fh.write(data)
        old = time.time_ns() - 400 * 86400 * 10 ** 9
        os.utime(tmp, ns=(old, old))
        os.replace(tmp, inst.rights_path)
        self.assertEqual(inst.level("bob", "alice", "cal-aa"), "W")
        data, _ = good_rights(121, [])
        inst.write_rights(data)
        self.assertEqual(inst.level("bob", "alice", "cal-aa"), "-")

    def test_a_reload_is_logged_at_warning(self):
        inst = self.inst
        before = len(inst.log_lines("[WARNING] radui_rights: reloaded"))
        data, _ = good_rights(130, GRANT_AA)
        inst.write_rights(data)
        inst.level("bob", "alice", "cal-aa")
        lines = inst.log_lines("[WARNING] radui_rights: reloaded")
        self.assertEqual(len(lines), before + 1)
        self.assertIn("generation", lines[-1])
        self.assertIn("-> 130", lines[-1])

    def test_a_startup_warning_line_present_once(self):
        # Radicale builds the rights class twice; the plugin shares state, so
        # the "active" line appears exactly once.
        lines = self.inst.log_lines("radui_rights: active, hot-reload enabled")
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("[WARNING]", lines[0])


@requires_radicale
class EqualLengthRewrites(unittest.TestCase):
    """(b) Same size, same inode, same mtime: only ctime and the content hash
    can reveal the change."""

    @classmethod
    def setUpClass(cls):
        cls.inst = Instance("reload-b")
        cls.addClassCleanup(cls.inst.close)
        cls.inst.bootstrap()
        cls.sig_identical = 0

    @classmethod
    def tearDownClass(cls):
        cls.inst.close()

    def expect(self, which):
        """Assert bob's access: 'aa' = writes cal-aa only, 'bb' = cal-bb."""
        inst = self.inst
        aa = inst.level("bob", "alice", "cal-aa")
        bb = inst.level("bob", "alice", "cal-bb")
        want = ("W", "-") if which == "aa" else ("-", "W")
        self.assertEqual((aa, bb), want, "stale rights after equal-length "
                                         "rewrite (expected %s)" % which)

    def reload_count(self):
        return len(self.inst.log_lines("[WARNING] radui_rights: reloaded"))

    def test_b1_inplace_inside_window_with_utime(self):
        """Rewrite in place and restore the old mtime, right after a request
        (the plugin's last read is younger than 2 s): SHA path."""
        inst = self.inst
        a, b = pair(200)
        inst.write_rights(a, "atomic")
        self.expect("aa")
        start = self.reload_count()
        flips = 0
        for i in range(30):
            nxt, name = (b, "bb") if i % 2 == 0 else (a, "aa")
            last = os.stat(inst.rights_path)
            before, after = inst.write_rights(nxt, "inplace-samelen",
                                              keep_mtime=True)
            # the test is only meaningful if size, inode and mtime are equal
            self.assertEqual(before.st_size, after.st_size)
            self.assertEqual(before.st_ino, after.st_ino)
            self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
            self.assertEqual(len(nxt), before.st_size)
            if (last.st_ctime_ns == after.st_ctime_ns):
                type(self).sig_identical += 1
            self.expect(name)
            flips += 1
        self.assertEqual(self.reload_count() - start, flips,
                         "every flip must be one real reload")
        info("equal-length in-place+utime flips inside the window: %d, of "
             "which %d had a fully identical stat signature (SHA path alone)"
             % (flips, self.sig_identical))

    def test_b2_inplace_inside_window_without_utime(self):
        inst = self.inst
        a, b = pair(300)
        inst.write_rights(a, "atomic")
        self.expect("aa")
        for i in range(10):
            nxt, name = (b, "bb") if i % 2 == 0 else (a, "aa")
            before, after = inst.write_rights(nxt, "inplace-samelen")
            self.assertEqual(before.st_size, after.st_size)
            self.expect(name)

    def test_b3_inplace_after_window_with_utime_ctime_path(self):
        """The file is older than 2 s when the plugin reads it (state
        settled); the rewrite restores mtime, so only ctime differs."""
        inst = self.inst
        a, b = pair(400)
        inst.write_rights(a, "atomic")
        time.sleep(2.3)
        self.expect("aa")      # reads the file: now settled
        time.sleep(0.2)
        start = self.reload_count()
        for i in range(3):
            nxt, name = (b, "bb") if i % 2 == 0 else (a, "aa")
            time.sleep(2.2)    # settle again after our own reload
            self.expect("aa" if name == "bb" else "bb")  # re-read: settled
            before, after = inst.write_rights(nxt, "inplace-samelen",
                                              keep_mtime=True)
            self.assertEqual((before.st_ino, before.st_mtime_ns, before.st_size),
                             (after.st_ino, after.st_mtime_ns, after.st_size))
            self.assertNotEqual(before.st_ctime_ns, after.st_ctime_ns,
                                "ctime must differ for this path to be tested")
            self.expect(name)
        self.assertEqual(self.reload_count() - start, 3)

    def test_b4_inplace_after_window_without_utime(self):
        inst = self.inst
        a, b = pair(500)
        inst.write_rights(a, "atomic")
        time.sleep(2.3)
        self.expect("aa")
        before, after = inst.write_rights(b, "inplace-samelen")
        self.assertEqual(before.st_size, after.st_size)
        self.expect("bb")

    def test_b5_timestamp_only_change_does_not_reload(self):
        """Same content, new timestamps/ctime (touch, chmod): re-read and
        compared by hash, but no engine rebuild and no reload line."""
        inst = self.inst
        a, b = pair(600)
        inst.write_rights(a, "atomic")
        self.expect("aa")
        time.sleep(2.3)
        self.expect("aa")
        start = self.reload_count()
        os.utime(inst.rights_path)
        os.chmod(inst.rights_path, 0o640)
        for _ in range(3):
            self.expect("aa")
        self.assertEqual(self.reload_count(), start)


if __name__ == "__main__":
    unittest.main()
