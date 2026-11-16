#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S7: is the users file re-read per request (no restart needed)?

Add a login, remove a login, change a password, "disable" (= remove from the
file, rules stay), re-enable; all without restarting and all effective on the
very next request. Also: rapid in-place equal-size password swaps, with the
default (no cache) and with htpasswd_cache = True for comparison.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bcrypt  # noqa: E402
from common import Checker, Instance, gen, ics_event  # noqa: E402


def status(inst, user, pw):
    return inst.req("PROPFIND", "/", user, None, {"Depth": "0"}, password=pw).status


def hash_of(pw, cost=4):
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=cost)).decode()


def main():
    c = Checker("S7 users re-read")
    inst = Instance("s07", rights="radui_rights", delay=0.2)
    inst.start()
    pid0 = inst.proc.pid
    ICS = {"Content-Type": "text/calendar"}
    assert inst.make_member("alice", "cal-a").status == 201
    inst.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"), ICS)

    # add a login (new account in the model + users file)
    m = inst.model
    m["accounts"]["carol"] = {"admin": False, "ownSpace": True}
    s_before = status(inst, "carol", "carol-pass-1")
    inst.hashes["carol"] = hash_of("carol-pass-1")
    inst.pw["carol"] = "carol-pass-1"
    inst.write_rights_model(m)  # rights first when granting access
    inst.write_users()
    s_after = status(inst, "carol", "carol-pass-1")
    c.check("add/effective-next-request", s_before == 401 and s_after == 207,
            "before %d, right after writing users+rights %d" % (s_before, s_after))
    s_dir = os.path.isdir(os.path.join(inst.collections_dir(), "carol"))
    c.check("add/principal-auto-created", s_dir, "principal directory exists: %s" % s_dir)

    # change password
    inst.hashes["carol"] = hash_of("carol-pass-2")
    inst.write_users()
    s_old = status(inst, "carol", "carol-pass-1")
    s_new = status(inst, "carol", "carol-pass-2")
    c.check("password-change/effective-next-request", s_old == 401 and s_new == 207,
            "old password %d, new password %d" % (s_old, s_new))

    # disable: removed from users, rules stay in rights
    m["accounts"]["carol"]["disabled"] = True
    inst.write_users()  # restricting file first
    s_dis = status(inst, "carol", "carol-pass-2")
    inst.write_rights_model(m)
    s_dis2 = status(inst, "carol", "carol-pass-2")
    carol_dir = os.path.isdir(os.path.join(inst.collections_dir(), "carol"))
    c.check("disable/effective-next-request-data-kept", s_dis == 401 and s_dis2 == 401 and carol_dir,
            "after users write %d, after rights write %d; principal data still on disk: %s"
            % (s_dis, s_dis2, carol_dir))
    # re-enable
    m["accounts"]["carol"]["disabled"] = False
    inst.write_rights_model(m)
    inst.write_users()
    s_re = status(inst, "carol", "carol-pass-2")
    c.check("re-enable/effective-next-request", s_re == 207, "-> %d" % s_re)

    # other users unaffected by all of that
    c.check("others-unaffected", status(inst, "alice", inst.pw["alice"]) == 207,
            "alice -> 207 throughout")

    # rapid in-place equal-size swaps (same inode)
    def swap_test(label, inst_):
        stale = 0
        n = 60
        for i in range(n):
            pw = "swap-pass-%03d" % (i % 2)
            inst_.hashes["bob"] = hash_of(pw)
            inst_.pw["bob"] = pw
            text = gen.users_text({k: v for k, v in inst_.hashes.items()})
            with open(inst_.users_path, "w") as fh:  # in place
                fh.write(text)
            if status(inst_, "bob", pw) != 207:
                stale += 1
        return stale, n

    stale, n = swap_test("default", inst)
    c.check("in-place-equal-size-swaps/default-no-cache", stale == 0,
            "%d in-place equal-size password swaps, each followed by a login: %d stale "
            "answers (htpasswd_cache = False: the file is read on every request)"
            % (n, stale))
    c.check("no-restart-needed", inst.proc.pid == pid0 and inst.alive(),
            "radicale pid unchanged (%s)" % (inst.proc.pid == pid0))
    inst.stop()

    inst2 = Instance("s07-cache", rights="radui_rights", delay=0.2,
                     extra_config="")
    inst2.extra_config = ""
    inst2.write_config()
    # add the cache option to the [auth] section
    with open(inst2.conf_path) as fh:
        txt = fh.read().replace("[auth]\n", "[auth]\nhtpasswd_cache = True\n", 1)
    with open(inst2.conf_path, "w") as fh:
        fh.write(txt)
    inst2.start()
    stale2, n2 = swap_test("cache", inst2)
    c.info("htpasswd_cache = True: %d in-place equal-size swaps, %d stale answers "
           "(change detection there is mtime_ns + size only)" % (n2, stale2))
    inst2.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
