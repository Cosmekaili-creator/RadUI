# SPDX-License-Identifier: AGPL-3.0-or-later
"""In-process scenarios, run under the Radicale interpreter.

``python inproc.py <scenario> <work dir>`` loads the plugin through
Radicale's own plugin loader (``radicale.rights.load``), exercises it and
prints one JSON object on the last line of stdout. The unittest modules
assert on that object. Everything happens inside <work dir> (a throwaway
directory); no server is started and nothing outside it is touched.

PYTHONPATH must contain the plugin directory.
"""
import json
import logging
import os
import sys
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import radicale  # noqa: E402
from radicale import config, rights  # noqa: E402
from radicale.log import logger  # noqa: E402

import support  # noqa: E402

GRANT_AA = [("bob", "alice", "cal-aa", "rw")]
GRANT_BB = [("bob", "alice", "cal-bb", "rw")]


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append((record.levelname, record.getMessage()))

    def count(self, level, needle):
        return sum(1 for lv, msg in self.records
                   if lv == level and needle in msg)


def setup_logging():
    cap = Capture()
    logger.setLevel(logging.DEBUG)
    logger.addHandler(cap)
    logger.propagate = False
    return cap


def make_config(path):
    cfg = config.load()
    cfg.update({"rights": {"type": "radui_rights", "file": path}}, "test")
    return cfg


def load_rights(cfg):
    """Radicale's loader path, exactly as Application and sharing do it."""
    return rights.load(cfg)


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def bob(rt, coll):
    return rt.authorization("bob", set(), "/alice/" + coll)


def pair(gen):
    a, _ = support.good_rights(gen, GRANT_AA)
    b, _ = support.good_rights(gen + 1, GRANT_BB)
    assert len(a) == len(b)
    return a, b


def scenario_two_instances(work):
    cap = setup_logging()
    path = os.path.join(work, "rights")
    a_txt, b_txt = pair(100)
    write_atomic(path, a_txt)
    cfg = make_config(path)
    import radui_rights
    first = load_rights(cfg)      # "application"
    second = load_rights(cfg)     # "sharing"
    out = {"module_file": radui_rights.__file__,
           "class_module": type(first).__module__,
           "same_shared": first._shared is second._shared,
           "registry_size": len(radui_rights._shared_by_path),
           "startup_lines": cap.count("WARNING", "active, hot-reload enabled"),
           "before_first": bob(first, "cal-aa"),
           "before_second": bob(second, "cal-aa")}
    write_atomic(path, b_txt)
    out["after_via_first"] = bob(first, "cal-bb")
    out["after_first_old"] = bob(first, "cal-aa")
    # the second instance never saw the file change itself: it must see the
    # state the first one installed, without another reload
    state_first = first._shared.state
    out["second_sees_same_state_object"] = second._shared.state is state_first
    out["after_via_second"] = bob(second, "cal-bb")
    out["after_second_old"] = bob(second, "cal-aa")
    out["reload_lines"] = cap.count("WARNING", "reloaded")
    # a rights object for another file gets its own state
    other = os.path.join(work, "rights-other")
    write_atomic(other, a_txt)
    third = load_rights(make_config(other))
    out["other_path_separate"] = third._shared is not first._shared
    # concurrent use of both instances during rewrites: no exception, and
    # every answer is one of the two possible
    errors, answers = [], set()

    def worker(rt):
        try:
            for _ in range(300):
                bob(rt, "cal-aa")            # public path: reloads if needed
                engine = rt._shared.state.engine   # one snapshot, two paths
                answers.add((engine.authorization("bob", set(), "/alice/cal-aa"),
                             engine.authorization("bob", set(), "/alice/cal-bb")))
        except Exception as exc:  # noqa: BLE001
            errors.append(repr(exc))

    threads = [threading.Thread(target=worker, args=(rt,))
               for rt in (first, second) * 4]
    for t in threads:
        t.start()
    for i in range(60):
        write_atomic(path, pair(200 + 2 * i)[i % 2])
        time.sleep(0.003)
    for t in threads:
        t.join()
    out["thread_errors"] = errors
    out["answers"] = sorted(map(list, answers))
    out["error_lines"] = cap.count("ERROR", "")
    return out


def scenario_version(work):
    cap = setup_logging()
    import radui_rights
    out = {}
    out["in_range_3_9_0"] = radui_rights._check_radicale_version("3.9.0")
    out["in_range_3_9_17"] = radui_rights._check_radicale_version("3.9.17")
    out["warnings_after_in_range"] = cap.count("WARNING", "outside the tested range")
    out["in_range_3_10_0"] = radui_rights._check_radicale_version("3.10.0")
    out["warnings_after_3_10"] = cap.count("WARNING", "outside the tested range")
    out["message"] = [m for lv, m in cap.records if "outside" in m][:1]
    radui_rights._check_radicale_version("4.0.0")
    out["warnings_after_second_out_of_range"] = cap.count(
        "WARNING", "outside the tested range")   # once only
    radui_rights._reset_for_tests()
    out["in_range_3_8_9"] = radui_rights._check_radicale_version("3.8.9")
    out["in_range_garbage"] = radui_rights._check_radicale_version("garbage")
    out["warnings_after_reset"] = cap.count("WARNING", "outside the tested range")
    # through the real constructor path with a simulated installed version
    radui_rights._reset_for_tests()
    cap.records.clear()
    path = os.path.join(work, "rights")
    write_atomic(path, pair(100)[0])
    real = radicale.VERSION
    radicale.VERSION = "3.10.2"
    try:
        load_rights(make_config(path))
        out["constructor_warnings_simulated"] = cap.count(
            "WARNING", "outside the tested range")
    finally:
        radicale.VERSION = real
    radui_rights._reset_for_tests()
    cap.records.clear()
    load_rights(make_config(path))
    out["real_version"] = real
    out["constructor_warnings_real"] = cap.count("WARNING",
                                                 "outside the tested range")
    return out


def scenario_sha_path(work):
    """Force a fully identical stat signature to exercise the hash path, and
    show the ctime path with the real stat."""
    cap = setup_logging()
    import radui_rights
    path = os.path.join(work, "rights")
    a_txt, b_txt = pair(100)
    write_atomic(path, a_txt)
    rt = load_rights(make_config(path))
    out = {"before": bob(rt, "cal-aa")}
    shared = rt._shared
    state = shared.state
    out["unsettled_after_fresh_write"] = not state.settled
    recorded = state.watch_sig
    real_stat = radui_rights._stat

    def frozen(_path):
        return types.SimpleNamespace(
            st_ino=recorded[0], st_mtime_ns=recorded[1],
            st_ctime_ns=recorded[2], st_size=recorded[3])

    # (1) unsettled + identical signature (forged) + equal-length in-place
    # rewrite with the old mtime restored: only the hash can notice
    st0 = os.stat(path)
    with open(path, "r+b") as fh:
        fh.write(b_txt)
    os.utime(path, ns=(st0.st_atime_ns, st0.st_mtime_ns))
    st1 = os.stat(path)
    out["same_size_ino_mtime"] = (st0.st_size, st0.st_ino, st0.st_mtime_ns) == (
        st1.st_size, st1.st_ino, st1.st_mtime_ns)
    out["ctime_changed_really"] = st0.st_ctime_ns != st1.st_ctime_ns
    radui_rights._stat = frozen
    try:
        out["forged_sig_equals_recorded"] = radui_rights._signature(
            frozen(path)) == recorded
        out["sha_path_unsettled"] = [bob(rt, "cal-aa"), bob(rt, "cal-bb")]
        # (2) settle, then forge again: a settled state trusts the stat
        time.sleep(2.3)
        radui_rights._stat = real_stat
        bob(rt, "cal-bb")                       # re-read, now settled
        state = shared.state
        out["settled_now"] = state.settled
        recorded = state.watch_sig
        radui_rights._stat = frozen
        st0 = os.stat(path)
        with open(path, "r+b") as fh:
            fh.write(a_txt)
        os.utime(path, ns=(st0.st_atime_ns, st0.st_mtime_ns))
        out["settled_forged_not_detected"] = [bob(rt, "cal-aa"),
                                              bob(rt, "cal-bb")]
    finally:
        radui_rights._stat = real_stat
    # (3) real stat: ctime differs although ino, mtime and size are equal
    st_now = os.stat(path)
    out["real_sig_differs_only_in_ctime"] = (
        (st_now.st_ino, st_now.st_mtime_ns, st_now.st_size) ==
        (recorded[0], recorded[1], recorded[3])
        and st_now.st_ctime_ns != recorded[2])
    out["ctime_path"] = [bob(rt, "cal-aa"), bob(rt, "cal-bb")]
    return out


def scenario_failed_signature(work):
    """A rejected file is not re-read on every request."""
    cap = setup_logging()
    import radui_rights
    path = os.path.join(work, "rights")
    a_txt, b_txt = pair(100)
    write_atomic(path, a_txt)
    rt = load_rights(make_config(path))
    out = {"before": bob(rt, "cal-aa")}
    calls = {"n": 0}
    real = radui_rights._read_consistent

    def counting(p):
        calls["n"] += 1
        return real(p)

    radui_rights._read_consistent = counting
    bad = bytearray(b_txt)
    bad[bad.index(b"cal-bb")] = ord("x")       # tampered byte, trailer stale
    write_atomic(path, bytes(bad))
    time.sleep(2.3)
    first = bob(rt, "cal-aa")                   # one read, rejected
    reads_first = calls["n"]
    for _ in range(100):
        bob(rt, "cal-aa")
    out["old_rules_kept"] = first == out["before"] and bob(rt, "cal-aa") == out["before"]
    out["reads_for_first_request"] = reads_first
    out["reads_for_100_more"] = calls["n"] - reads_first
    out["error_lines"] = cap.count("ERROR", "rejected")
    # same content, new timestamps (touch): still not rebuilt, no new error
    os.utime(path)
    for _ in range(3):
        bob(rt, "cal-aa")
    out["error_lines_after_touch"] = cap.count("ERROR", "rejected")
    # a repaired file loads
    write_atomic(path, b_txt)
    out["after_repair"] = bob(rt, "cal-bb")
    return out


def scenario_validator(work):
    import radui_rights
    res = {}
    for name, data in support.bad_variants().items():
        try:
            gen, sections = radui_rights.validate_rights_bytes(data)
            res[name] = {"ok": True, "generation": gen, "sections": len(sections)}
        except radui_rights.RightsFileError as exc:
            res[name] = {"ok": False, "error": str(exc)}
    return res


def scenario_parity(work):
    """Verdicts of the plugin validator on the cases in ``cases.json`` (a list
    of hex strings written by the test into the work directory)."""
    import radui_rights
    with open(os.path.join(work, "cases.json")) as fh:
        cases = json.load(fh)
    out = []
    for hexdata in cases:
        try:
            radui_rights.validate_rights_bytes(bytes.fromhex(hexdata))
            out.append({"ok": True})
        except radui_rights.RightsFileError as exc:
            out.append({"ok": False, "error": str(exc)})
    return out


def scenario_stat_error(work):
    """Missing file at runtime: one ERROR, old rules kept, recovery logged."""
    cap = setup_logging()
    path = os.path.join(work, "rights")
    a_txt, b_txt = pair(100)
    write_atomic(path, a_txt)
    rt = load_rights(make_config(path))
    out = {"before": bob(rt, "cal-aa")}
    os.rename(path, path + ".away")
    answers = [bob(rt, "cal-aa") for _ in range(20)]
    out["kept"] = all(a == out["before"] for a in answers)
    out["errors_while_missing"] = cap.count("ERROR", "cannot use rights file")
    os.rename(path + ".away", path)
    out["after_return"] = bob(rt, "cal-aa")
    out["recovery_lines"] = cap.count("WARNING", "usable again")
    write_atomic(path, b_txt)
    out["after_new"] = bob(rt, "cal-bb")
    return out


SCENARIOS = {k[len("scenario_"):].replace("_", "-"): v
             for k, v in dict(globals()).items() if k.startswith("scenario_")}


def main():
    name, work = sys.argv[1], sys.argv[2]
    result = SCENARIOS[name](work)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
