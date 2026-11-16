#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S6: bcrypt interoperability between the backend's bcrypt and Radicale's.

Hashes made with the system Python's bcrypt are verified by Radicale (which
runs in its own virtualenv with its own bcrypt). Costs 4 and 12, $2a/$2b/$2y
prefixes, passwords of 71/72/73/80 bytes, non-ASCII and colon-containing
passwords. Also reports the cost distribution of an existing users file
(prefix only; never the hash) when RADUI_USERS_SAMPLE points to one.
"""
import os
import re
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bcrypt  # noqa: E402
from common import (Checker, Instance, gen, RADICALE_BIN,  # noqa: E402
                    radicale_python_version, basic)


def login_status(inst, user, password):
    return inst.req("PROPFIND", "/", user, None, {"Depth": "0"}, password=password).status


def main():
    c = Checker("S6 bcrypt")
    c.info("backend bcrypt %s; radicale venv bcrypt %s" % (
        bcrypt.__version__, radicale_python_version("bcrypt")))

    sample = os.environ.get("RADUI_USERS_SAMPLE")
    if sample and os.path.exists(sample):
        pref = Counter()
        with open(sample) as fh:
            for line in fh:
                if ":" in line and not line.lstrip().startswith("#"):
                    h = line.rstrip("\n").split(":", 1)[1]
                    m = re.match(r"^(\$2[abxy]\$\d\d)\$", h)
                    pref[m.group(1) if m else "other"] += 1
        c.info("existing users file: hash prefix distribution %s" % dict(pref))
        costs = {p.split("$")[2] for p in pref if p.startswith("$2")}
        c.check("live-cost/read-from-prefix", len(costs) >= 1,
                "cost field(s) present in the sample: %s" % sorted(costs))

    # timing of one hash/verify at cost 12 on this machine (single thread)
    t0 = time.perf_counter()
    h12 = bcrypt.hashpw(b"timing-probe", bcrypt.gensalt(rounds=12))
    t_hash = time.perf_counter() - t0
    t0 = time.perf_counter()
    bcrypt.checkpw(b"timing-probe", h12)
    t_check = time.perf_counter() - t0
    c.info("cost 12: hashpw %.0f ms, checkpw %.0f ms (single thread)"
           % (t_hash * 1000, t_check * 1000))

    inst = Instance("s06", rights="radui_rights", bcrypt_cost=12, delay=0.2)
    users = {}
    pws = {
        "p71": "a" * 71, "p72": "b" * 72, "p73": "c" * 73, "p80": "d" * 80,
        "uni": "pässwörd-€-ok-1234", "colon": "has:colon:inside-pass",
        "space": " lead and trail ",
    }
    m = gen.default_model(1, with_grants=False)
    for name in pws:
        m["accounts"]["u-" + name] = {"admin": False, "ownSpace": True}
    inst.model = m
    inst.set_passwords()
    for name, pw in pws.items():
        h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=12)).decode()
        inst.hashes["u-" + name] = h
        inst.pw["u-" + name] = pw
    # alternate prefixes for alice/bob
    h_a = bcrypt.hashpw(b"prefix-a-pass", bcrypt.gensalt(rounds=12, prefix=b"2a")).decode()
    inst.hashes["alice"] = h_a
    inst.pw["alice"] = "prefix-a-pass"
    h_y = "$2y$" + bcrypt.hashpw(b"prefix-y-pass", bcrypt.gensalt(rounds=12)).decode()[4:]
    inst.hashes["bob"] = h_y
    inst.pw["bob"] = "prefix-y-pass"
    inst.write_users()
    inst.write_rights_model(m)
    inst.start()

    for name in ("alice", "bob"):
        h = inst.hashes[name]
        s = login_status(inst, name, inst.pw[name])
        bad = login_status(inst, name, "wrong-password-x")
        c.check("prefix/%s" % h[:4], s == 207 and bad == 401,
                "hash prefix %s cost %s: correct pw -> %d, wrong pw -> %d" % (
                    h[:4], h[4:7], s, bad))
    s = login_status(inst, "adm-1", inst.pw["adm-1"])
    t0 = time.monotonic()
    login_status(inst, "adm-1", inst.pw["adm-1"])
    dt = time.monotonic() - t0
    c.check("cost12/backend-hash-verified-by-radicale", s == 207,
            "$2b$12 hash made by backend bcrypt %s, verified by Radicale's bcrypt: %d; "
            "request latency %.0f ms" % (bcrypt.__version__, s, dt * 1000))

    for name, pw in pws.items():
        u = "u-" + name
        s = login_status(inst, u, pw)
        info = "len=%d bytes" % len(pw.encode())
        if name in ("p71", "p72", "uni", "colon", "space"):
            c.check("password/%s" % name, s == 207, "%s -> %d" % (info, s))
        else:
            # > 72 bytes: backend bcrypt 4.x truncates silently, Radicale's 5.x refuses
            s72 = login_status(inst, u, pw.encode()[:72].decode())
            c.info("password/%s: %s: full password -> %d, first 72 bytes only -> %d"
                   % (name, info, s, s72))
    # decisive facts for passwords.py: the 72-byte rule must be enforced by the backend
    py = os.path.join(os.path.dirname(os.path.realpath(
        subprocess.run(["which", RADICALE_BIN], capture_output=True, text=True).stdout.strip()
        or RADICALE_BIN)), "python")
    out = subprocess.run([py, "-c",
                          "import bcrypt;h=bcrypt.hashpw(b'x'*80,bcrypt.gensalt(4))"],
                         capture_output=True, text=True)
    c.info("radicale-venv bcrypt hashing an 80-byte password: %s"
           % ("accepted (truncates)" if out.returncode == 0
              else "refused: " + out.stderr.strip().splitlines()[-1][:80]))
    r73 = login_status(inst, "u-p73", "c" * 73)
    r_other_suffix = login_status(inst, "u-p73", "c" * 72 + "ZZZ-different-suffix")
    c.check("password/over-72-bytes-truncated-by-radicale",
            r73 == 207 and r_other_suffix == 207,
            "Radicale truncates to 72 bytes itself (logs a warning): 73-byte password -> %d, "
            "same first 72 bytes with a different suffix -> %d. Consequence: the backend must "
            "reject passwords > 72 bytes (plan 2.1 / 2.7) so no account can have one" % (
                r73, r_other_suffix))
    inst.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
