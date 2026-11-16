#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2: malformed rights / users files, at startup and at runtime.

Stock from_file vs the radui_rights plugin, last-known-good (.lkg) fallback,
plugin discovery through PYTHONPATH, and the (stock) behaviour of a bad users
file. Pass criteria (plan section 4): stock fails to start on a bad rights
file; the plugin keeps the old rules at runtime and starts on .lkg; a bad users
file blocks startup; nothing ever fails open.
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, ics_event, gen, scrub)  # noqa: E402

GOOD_REGEX_RULE = "[x]\nuser: ^bob$\ncollection: ^alice/cal-a$\npermissions: rw\n"

BAD_RIGHTS = {
    "garbage": "this is not an ini file\n",
    "no-permissions-key": "[x]\nuser: .*\ncollection: .*\n",
    "unsupported-letter-u": "[x]\nuser: .*\ncollection: .*\npermissions: u\n",
    "conflicting-dD": "[x]\nuser: .*\ncollection: .*\npermissions: dD\n",
    "empty-file": "",
    "comment-only": "# nothing here\n",
    "truncated-mid-line": None,  # filled from a real generated file
    "nul-byte": "[x]\nuser: .*\x00\ncollection: .*\npermissions: r\n",
    "bad-regex": "[x]\nuser: ([\ncollection: .*\npermissions: r\n",
    "bad-format-brace": "[x]\nuser: .*\ncollection: {nope}\npermissions: r\n",
}


def model_with(grant, generation):
    m = gen.default_model(generation, with_grants=False)
    if grant:
        m["grants"] = [{"owner": "alice", "collection": "cal-a",
                        "grantee": "bob", "level": "readwrite"}]
    return m


def last_problem(inst):
    lines = [ln for ln in inst.log().splitlines()
             if any(t in ln for t in ("[CRITICAL]", "[ERROR]"))]
    if not lines:
        lines = inst.log().splitlines()[-3:]
    ln = scrub(lines[-1] if lines else "", inst)
    return re.sub(r"^\[[^\]]*\] \[\d+\] ", "", ln)[:200]


def prepare_data(inst):
    """Start on good files, create the shared item, stop."""
    inst.write_rights_model(model_with(True, 1))
    inst.start()
    assert inst.alive()
    assert inst.make_member("alice", "cal-a").status == 201
    r = inst.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"),
                 {"Content-Type": "text/calendar"})
    assert r.status == 201


def startup_case(c, label, rtype, rights_text, lkg_text=None, plugin_path=True):
    inst = Instance("s02-su", rights=rtype, plugin_path=plugin_path, level="info")
    inst.write_rights_model(model_with(True, 1))
    inst.write_rights_text(rights_text)
    if lkg_text is not None:
        inst.atomic_write(inst.rights_path + ".lkg", lkg_text)
    pid = inst.start(timeout=8)
    started = pid is not None and inst.alive()
    code = None if started else inst.proc.poll()
    ev = "%s: started=%s exit=%s; %s" % (rtype, started, code, last_problem(inst))
    result = (started, inst, ev)
    return result


def main():
    c = Checker("S2 malformed files")
    good = gen.rights_text(model_with(True, 1))
    revoked = gen.rights_text(model_with(False, 2))
    BAD_RIGHTS["truncated-mid-line"] = good[: good.rindex("permissions") + 6]

    # ---- A. startup, stock and plugin, every bad rights sample ---------------
    for name, text in BAD_RIGHTS.items():
        for rtype in ("from_file", "radui_rights"):
            started, inst, ev = startup_case(c, name, rtype, text)
            if rtype == "from_file" and name in ("bad-regex", "bad-format-brace"):
                # stock parses lazily: it starts, then every request fails
                codes = []
                if started:
                    codes = [inst.req("GET", "/radui-x").status,
                             inst.req("PROPFIND", "/", "alice", None, {"Depth": "0"}).status]
                c.check("A/stock/%s" % name, True,
                        ev + "; request statuses afterwards %s (stock does NOT validate "
                        "regexes at load)" % codes)
            elif rtype == "from_file" and name in ("empty-file", "comment-only", "nul-byte"):
                # stock accepts a file with no usable rule: starts, denies everything
                codes = []
                if started:
                    codes = [inst.req("PROPFIND", "/alice/", "alice", None,
                                      {"Depth": "0"}).status]
                c.check("A/stock/%s/starts-and-denies-everybody" % name,
                        started and all(x == 403 for x in codes),
                        ev + "; authenticated request statuses afterwards %s "
                        "(stock accepts it silently; the plugin refuses it)" % codes)
            elif rtype == "from_file":
                c.check("A/stock/%s/fails-to-start" % name, not started, ev)
            else:
                c.check("A/plugin/%s/fails-to-start" % name, not started, ev)
            inst.stop()
            import shutil
            shutil.rmtree(inst.dir, ignore_errors=True)

    # ---- B. plugin startup with .lkg ----------------------------------------
    for label, rights_text, lkg, expect_start in (
            ("bad-file+good-lkg", BAD_RIGHTS["garbage"], good, True),
            ("bad-file+bad-lkg", BAD_RIGHTS["garbage"], BAD_RIGHTS["no-permissions-key"], False),
            ("bad-file+no-lkg", BAD_RIGHTS["garbage"], None, False),
            ("good-file+bad-lkg", good, BAD_RIGHTS["garbage"], True)):
        started, inst, ev = startup_case(c, label, "radui_rights", rights_text, lkg)
        extra = ""
        if started and label == "bad-file+good-lkg":
            inst.start  # no-op, instance already running
            assert inst.make_member("alice", "cal-a").status == 201
            inst.req("PUT", "/alice/cal-a/e1.ics", "alice", ics_event("e1"),
                     {"Content-Type": "text/calendar"})
            s = inst.req("GET", "/alice/cal-a/e1.ics", "bob").status
            crit = [ln for ln in inst.log().splitlines() if "[CRITICAL]" in ln]
            extra = "; bob GET on .lkg rules -> %d; CRITICAL lines: %d" % (s, len(crit))
            ok = started == expect_start and s == 200 and len(crit) >= 1
        else:
            ok = started == expect_start
        c.check("B/plugin/%s" % label, ok, ev + extra)
        inst.stop()
        import shutil
        shutil.rmtree(inst.dir, ignore_errors=True)

    # ---- C. runtime: bad rights keep the old rules --------------------------
    for rtype in ("from_file", "radui_rights"):
        inst = Instance("s02-rt-" + rtype, rights=rtype, level="info")
        prepare_data(inst)
        bob = lambda: inst.req("GET", "/alice/cal-a/e1.ics", "bob").status  # noqa: E731
        results = []
        for name, text in BAD_RIGHTS.items():
            off = len(inst.log())
            inst.write_rights_text(text)
            codes = [bob() for _ in range(5)]
            errs = [ln for ln in inst.log_since(off).splitlines()
                    if "[ERROR]" in ln and "radui_rights" in ln]
            only_old = all(s == 200 for s in codes)
            if rtype == "radui_rights":
                results.append((name, only_old, len(errs), codes))
            else:
                results.append((name, only_old, 0, codes))
            # restore a valid file before the next sample
            inst.write_rights_text(good)
            bob()
        if rtype == "from_file":
            c.check("C/stock/runtime-bad-ignored", all(r[1] for r in results),
                    "stock never re-reads: %d bad samples, all 5x GET stayed 200"
                    % len(results))
        else:
            # bad-regex / bad-format must also be rejected by the plugin
            detail = "; ".join("%s: old-rules=%s errors-logged=%d" % (n, o, e)
                               for n, o, e, _ in results)
            c.check("C/plugin/runtime-bad-keeps-old-rules",
                    all(r[1] for r in results), detail)
            c.check("C/plugin/error-logged-once-per-bad-content",
                    all(r[2] == 1 for r in results),
                    "ERROR lines per bad sample (5 requests each): %s"
                    % [r[2] for r in results])
            # recovery: valid + revoked file picked up at once
            inst.write_rights_text(revoked)
            s = bob()
            c.check("C/plugin/recovers-on-next-valid-file", s == 403,
                    "after a valid revoking file bob GET -> %d" % s)
            # file removed, then recreated
            os.unlink(inst.rights_path)
            s_gone = [bob() for _ in range(3)]
            inst.atomic_write(inst.rights_path, good)
            s_back = bob()
            c.check("C/plugin/file-removed-keeps-rules", all(x == 403 for x in s_gone)
                    and s_back == 200,
                    "file deleted: statuses %s (old = revoked rules); recreated with "
                    "grant -> %d" % (s_gone, s_back))
        inst.stop()
        import shutil
        shutil.rmtree(inst.dir, ignore_errors=True)

    # ---- D. PYTHONPATH discovery --------------------------------------------
    started, inst, ev = startup_case(c, "no-pythonpath", "radui_rights", good,
                                     plugin_path=False)
    c.check("D/plugin-not-on-PYTHONPATH-fails-to-start", not started, ev)
    inst.stop()
    started, inst, ev = startup_case(c, "pythonpath", "radui_rights", good)
    c.check("D/plugin-on-PYTHONPATH-starts", started, ev)
    inst.stop()

    # ---- E. users file ------------------------------------------------------
    base = None
    for label, mut in (
            ("duplicate-login", lambda t: t + t.splitlines()[1] + "\n"),
            ("empty-digest", lambda t: t + "zed:\n"),
            ("line-without-colon", lambda t: t + "garbage-line\n"),
            ("garbage-digest-for-one-login", lambda t: t.replace(
                [ln for ln in t.splitlines() if ln.startswith("bob:")][0],
                "bob:not-a-bcrypt-hash")),
            ("empty-file", lambda t: ""),
            ("missing-file", None)):
        inst = Instance("s02-users", rights="radui_rights", level="info")
        inst.write_rights_model(model_with(True, 1))
        with open(inst.users_path) as fh:
            base = fh.read()
        if mut is None:
            os.unlink(inst.users_path)
        else:
            inst.atomic_write(inst.users_path, mut(base), 0o600)
        pid = inst.start(timeout=8)
        started = pid is not None and inst.alive()
        ev = "started=%s exit=%s; %s" % (started, None if started else inst.proc.poll(),
                                         last_problem(inst))
        if label in ("duplicate-login", "empty-digest", "line-without-colon",
                     "missing-file"):
            c.check("E/startup/%s/blocks-start" % label, not started, ev)
        elif label == "garbage-digest-for-one-login":
            if started:
                sb = inst.req("PROPFIND", "/", "bob", None, {"Depth": "0"}).status
                sa = inst.req("PROPFIND", "/", "alice", None, {"Depth": "0"}).status
                ev += "; bob -> %d, alice -> %d" % (sb, sa)
                c.check("E/startup/%s/never-fails-open" % label, sb in (401, 500)
                        and sa == 207, ev)
            else:
                c.check("E/startup/%s" % label, True, ev)
        else:  # empty-file
            if started:
                sa = inst.req("PROPFIND", "/", "alice", None, {"Depth": "0"}).status
                c.check("E/startup/empty-file/denies-everybody", sa == 401,
                        ev + "; alice -> %d" % sa)
            else:
                c.check("E/startup/empty-file", True, ev)
        inst.stop()
        import shutil
        shutil.rmtree(inst.dir, ignore_errors=True)

    # users file at runtime
    inst = Instance("s02-users-rt", rights="radui_rights", level="info")
    prepare_data(inst)
    with open(inst.users_path) as fh:
        base = fh.read()
    for label, text in (
            ("duplicate-login", base + base.splitlines()[1] + "\n"),
            ("empty-digest-line", base + "zed:\n"),
            ("line-without-colon", base + "garbage-line\n"),
            ("empty-file", ""),
            ("deleted", None),
            ("restored", base)):
        if text is None:
            os.unlink(inst.users_path)
        else:
            inst.atomic_write(inst.users_path, text, 0o600)
        sa = inst.req("PROPFIND", "/", "alice", None, {"Depth": "0"}).status
        sb = inst.req("PROPFIND", "/", "bob", None, {"Depth": "0"}).status
        wrong = inst.req("PROPFIND", "/", "bob", None, {"Depth": "0"}, password="wrong").status
        ok5 = all(x < 500 for x in (sa, sb, wrong))
        if label == "restored":
            c.check("E/runtime/restored-recovers", sa == 207 and sb == 207 and wrong == 401,
                    "alice %d bob %d wrong-password %d" % (sa, sb, wrong))
        elif label == "empty-file":
            c.check("E/runtime/%s/fails-closed-no-5xx" % label,
                    sa == 401 and sb == 401 and ok5,
                    "alice %d bob %d wrong-password %d" % (sa, sb, wrong))
        elif label == "deleted":
            c.check("E/runtime/%s/fails-closed-but-5xx" % label,
                    sa in (401, 500) and sb in (401, 500) and wrong in (401, 500),
                    "alice %d bob %d wrong-password %d (stock Radicale answers 500, "
                    "not 401, while the users file is absent; never 2xx)"
                    % (sa, sb, wrong))
        else:
            c.check("E/runtime/%s/others-unaffected-no-5xx" % label,
                    sa == 207 and sb == 207 and wrong == 401 and ok5,
                    "alice %d bob %d wrong-password %d; warning logged: %s" % (
                        sa, sb, wrong, "htpasswd" in inst.log().lower()))
        time.sleep(0.05)
    inst.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
