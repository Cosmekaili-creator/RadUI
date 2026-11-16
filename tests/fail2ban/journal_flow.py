#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run the fail2ban filter on journal entries the way fail2ban's systemd backend presents them.

fail2ban-regex cannot be fed synthetic journal entries, and the systemd backend needs the
python-systemd module and a real journal. This script uses fail2ban's own code instead: it builds
journal entries (hostname, SYSLOG_IDENTIFIER and PID as Radicale sends them), formats each one with
FilterSystemd.formatJournalEntry (the exact function the backend uses, which yields
"<host> radicale[<pid>]: <message>" with the timestamp split off) and tests the line with the
fail2ban-regex engine (Fail2banRegex.process, output token "ip").

usage: journal_flow.py CASES.tsv FILTER.conf   (exit 0 when every case behaves as expected)
Runs as a normal user; needs the system fail2ban Python package.
"""
import contextlib
import datetime
import io
import sys
import types

# The module only needs python-systemd to be importable; no journal is opened here.
_systemd = types.ModuleType("systemd")
_journal = types.ModuleType("systemd.journal")
_journal.__version__ = "235"
_systemd.journal = _journal
sys.modules.setdefault("systemd", _systemd)
sys.modules.setdefault("systemd.journal", _journal)

from fail2ban.client.fail2banregex import Fail2banRegex, get_opt_parser  # noqa: E402
from fail2ban.server.filtersystemd import FilterSystemd  # noqa: E402


class _Host:
    jailName = "radui-radicale-auth"
    getJrnEntTime = FilterSystemd.getJrnEntTime

    def getLogEncoding(self):
        return "UTF-8"


def entry_line(message, n):
    entry = {"_HOSTNAME": "testhost", "SYSLOG_IDENTIFIER": "radicale", "SYSLOG_PID": 4242,
             "MESSAGE": message,
             "__REALTIME_TIMESTAMP": datetime.datetime(2026, 11, 12, 10, 0, n % 60)}
    return FilterSystemd.formatJournalEntry(_Host(), entry)


def main():
    cases_path, filter_path = sys.argv[1:3]
    opts, _ = get_opt_parser().parse_args(["-o", "ip", "unused", "unused"])
    engine = Fail2banRegex(opts)
    if not engine.readRegex(filter_path, "fail"):
        print("cannot load the filter", file=sys.stderr)
        return 2
    bad = 0
    total = 0
    for n, raw in enumerate(open(cases_path, encoding="utf-8")):
        if raw.startswith("#") or not raw.strip():
            continue
        expected, desc, message = raw.rstrip("\n").split("\t", 2)
        formatted = entry_line(message, n)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            engine.process([formatted])
        got = out.getvalue().split() or ["-"]
        ok = got == [expected]
        total += 1
        bad += 0 if ok else 1
        print("%s  expected %-15s got %-15s  %s" % ("PASS" if ok else "FAIL", expected, " ".join(got), desc))
        if "203.0.113.9" in out.getvalue():
            print("FAIL  the attacker-chosen address was returned")
            bad += 1
    print("journal flow: %d cases, %d failures" % (total, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
