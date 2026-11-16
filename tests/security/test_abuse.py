# SPDX-License-Identifier: AGPL-3.0-or-later
"""Abuse resistance: brute force, request floods, over-long passwords,
secrets in logs, simultaneous mutations, a killed backend.

Attacker models
* Password guesser: many wrong passwords from one address, then from many.
  Must be slowed per address (429) without ever locking the legitimate admin
  out (there is no per-login lockout: an attacker must not be able to turn the
  limiter into a denial of service against the administrator).
* Log reader: anyone who can read the journal, Radicale's log or the backend's
  stderr must find no password, no hash and no Authorization value.
* Impatient administrators and a flaky machine: ten simultaneous admin
  mutations and a ``kill -9`` in the middle of them must leave a valid rights
  file and consecutive generations.
"""
import base64
import json
import os
import re
import signal
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secsupport as S  # noqa: E402

from radui_admin import rightsfile  # noqa: E402

GUESSER = "203.0.113.10"
OTHER = "203.0.113.11"
WRONG = []


def code(r):
    return r.json["error"]["code"] if r.json else None


def fit(prefix, nbytes, pad_chars=""):
    """A varied password of exactly ``nbytes`` UTF-8 bytes starting with
    ``prefix`` (padded with ASCII letters and digits)."""
    alphabet = "kT3mQw8pLx5vNb2zRj7hGf4dSc9yHa6"
    out, i = prefix, 0
    while len(out.encode()) < nbytes:
        out += alphabet[i % len(alphabet)]
        i += 1
    assert len(out.encode()) == nbytes, (prefix, nbytes)
    return out


def wrong_pw():
    pw = "wrong-" + os.urandom(6).hex()
    WRONG.append(pw)
    return pw


@S.requires_radicale
class BruteForce(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("brute", cfg={
            "rate_limit_failures": 5, "rate_limit_window_s": 600,
            "rate_limit_block_s": 900}).up()
        cls.addClassCleanup(s.close)

    def attempt(self, ip, login="alice", password=None):
        return self.s.api("GET", "/me", login,
                          password=password if password is not None else wrong_pw(),
                          headers={"X-Real-IP": ip})

    def test_01_per_ip_limiter_and_no_per_login_lockout(self):
        s = self.s
        codes = [self.attempt(GUESSER).status for _ in range(5)]
        self.assertEqual(codes, [401] * 5)
        # the address is now blocked, even for the CORRECT password
        r = self.attempt(GUESSER, password=s.pw["alice"])
        self.assertEqual((r.status, code(r)), (429, "rate_limited"))
        self.assertTrue(int(r.headers["retry-after"]) >= 1)
        self.assertNotIn("www-authenticate", r.headers)
        # 429 comes before the credential check: no validity oracle
        for login in ("alice", "nobody-9"):
            self.assertEqual(self.attempt(GUESSER, login=login).status, 429)
        # the SAME login works from every other address: no per-login lockout
        for ip in (OTHER, "198.51.100.7", "2001:db8::77"):
            self.assertEqual(self.attempt(ip, password=s.pw["alice"]).status, 200,
                             ip)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)
        # the block is for the backend API only: health still answers, and
        # Radicale itself is a different layer (nginx limit_req and fail2ban)
        r = s.api("GET", "/health", headers={"X-Real-IP": GUESSER})
        self.assertEqual(r.status, 200)

    def test_02_failures_from_many_addresses_never_block_the_admin(self):
        s = self.s
        for i in range(20):
            ip = "203.0.113.%d" % (100 + i)
            self.assertEqual(self.attempt(ip).status, 401)
        self.assertEqual(self.attempt(OTHER, password=s.pw["alice"]).status, 200)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)
        S.info("20 distinct addresses each failed once against 'alice': the "
               "admin still logs in (no per-login counter exists)")

    def test_03_a_success_does_not_reset_the_counter(self):
        s = self.s
        ip = "203.0.113.30"
        for _ in range(4):
            self.assertEqual(self.attempt(ip).status, 401)
        self.assertEqual(self.attempt(ip, password=s.pw["alice"]).status, 200)
        self.assertEqual(self.attempt(ip).status, 401)       # fifth failure
        self.assertEqual(self.attempt(ip, password=s.pw["alice"]).status, 429)

    def test_04_unknown_logins_count_malformed_headers_do_not_reach_radicale(self):
        s = self.s
        ip = "203.0.113.40"
        for i in range(5):
            self.assertEqual(self.attempt(ip, login="ghost-%d" % i).status, 401)
        self.assertEqual(self.attempt(ip).status, 429)
        # malformed Authorization headers are refused locally (nothing was
        # guessed against Radicale) and are not counted
        ip2 = "203.0.113.41"
        for _ in range(12):
            r = s.api("GET", "/me", auth="Basic !!!", headers={"X-Real-IP": ip2})
            self.assertEqual(r.status, 401)
        self.assertEqual(self.attempt(ip2, password=s.pw["alice"]).status, 200)

    def test_05_rotating_the_address_header_bypasses_the_limiter_when_unproxied(self):
        # By design the address comes from the trusted proxy header, which
        # nginx OVERWRITES (tests/deploy/nginx_check.py proves that). A client
        # talking to the backend directly can choose it. Recorded, not asserted.
        s = self.s
        blocked = 0
        for i in range(40):
            if self.attempt("203.0.113.%d" % (150 + i)).status == 429:
                blocked += 1
        S.info("direct to the backend, 40 failures with 40 different "
               "X-Real-IP values: %d blocked (the backend must stay on "
               "loopback behind a proxy that overwrites the header)" % blocked)
        self.assertEqual(blocked, 0)


@S.requires_radicale
class RequestRate(unittest.TestCase):
    def test_token_bucket_answers_429_with_retry_after(self):
        s = S.WStack("rate", cfg={"requests_per_minute": 30,
                                  "requests_burst": 5}).up()
        self.addCleanup(s.close)
        got = [s.api("GET", "/me", "alice", headers={"X-Real-IP": "203.0.113.50"})
               for _ in range(14)]
        statuses = [r.status for r in got]
        self.assertEqual(statuses[:5], [200] * 5)
        self.assertIn(429, statuses)
        first = statuses.index(429)
        self.assertTrue(5 <= first <= 7, statuses)
        limited = got[first]
        self.assertEqual(code(limited), "rate_limited")
        self.assertGreaterEqual(int(limited.headers["retry-after"]), 1)
        # another address has its own bucket
        self.assertEqual(s.api("GET", "/me", "alice", headers={
            "X-Real-IP": "203.0.113.51"}).status, 200)
        # health is not rate limited by the backend
        self.assertTrue(all(s.api("GET", "/health", headers={
            "X-Real-IP": "203.0.113.50"}).status == 200 for _ in range(10)))
        S.info("token bucket 30/min burst 5: first 429 at request %d" % (first + 1))


@S.requires_radicale
class Passwords(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("pw").up()
        cls.addClassCleanup(s.close)
        s.make_user("victim-1")

    def set_pw(self, password):
        return self.s.api("POST", "/accounts/victim-1/password", "alice",
                          {"password": password})

    def test_72_bytes_is_the_ceiling_in_every_encoding(self):
        s = self.s
        ok72 = [fit("Zq9-", 72), fit("\u00e9\u00fc\u00f1Zq9-", 72),
                fit("\u20acZq9-", 72), fit("Zq9-" + "\u00e9" * 10, 72)]
        for pw in ok72:
            self.assertEqual(len(pw.encode()), 72)
            r = self.set_pw(pw)
            self.assertEqual(r.status, 200, (pw[:6], r.json))
            self.assertEqual(s.api("GET", "/me", "victim-1", password=pw).status, 200)
            self.assertEqual(s.dav("PROPFIND", "/", "victim-1", password=pw,
                                   headers={"Depth": "0"}).status, 207)
            s.pw["victim-1"] = pw
        for pw in (fit("Zq9-", 72) + "x", fit("\u00e9Zq9-", 73) + "\u00e9",
                   fit("\u20acZq9-", 72) + "\u20ac", "Zq9-" * 125):
            self.assertGreater(len(pw.encode()), 72)
            r = self.set_pw(pw)
            # 73..128 characters: 422; longer than 128 characters: 400 (the
            # backend's string limit applies first)
            self.assertIn(r.status, (400, 422), pw[:8])
            r = s.api("POST", "/accounts", "alice", {
                "login": "long-1", "displayName": "L", "password": pw})
            self.assertIn(r.status, (400, 422))
        # a password over the ceiling never authenticates, even when its first
        # 72 bytes are right (Radicale itself would accept it, see below)
        good = s.pw["victim-1"]
        before = s.radicale_log_text().count("Failed login")
        for pw in (good + "x", good + "x" * 100):
            self.assertEqual(s.api("GET", "/me", "victim-1", password=pw).status, 401)
        self.assertEqual(s.radicale_log_text().count("Failed login"), before,
                         "the backend must refuse it without asking Radicale")

    def test_radicale_itself_ignores_everything_after_72_bytes(self):
        # Spike deviation 7: Radicale truncates. Why the backend refuses long
        # passwords. Reported, not asserted as a defect: with the 72-byte cap
        # no account has a longer password to begin with.
        s = self.s
        good = fit("Zq9-", 72)
        self.assertEqual(self.set_pw(good).status, 200)
        s.pw["victim-1"] = good
        self.assertEqual(s.dav("PROPFIND", "/", "victim-1", password=good,
                               headers={"Depth": "0"}).status, 207)
        st = s.dav("PROPFIND", "/", "victim-1", password=good + "junk",
                   headers={"Depth": "0"}).status
        S.info("direct to Radicale, password + 'junk' after 72 bytes -> %d "
               "(%s)" % (st, "accepted: the tail is ignored" if st == 207 else "refused"))

    def test_other_weak_passwords_are_refused(self):
        for pw in ("short1A!", "", " " * 12, "a" * 12, "password1234",
                   "victim-1-and-more-1A", "Victim-1 passphrase 1", "A" * 15,
                   "12345678901234", "qwertyuiop12"):
            r = self.set_pw(pw)
            self.assertEqual(r.status, 422, repr(pw))


@S.requires_radicale
class Concurrency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("conc").up()
        cls.addClassCleanup(s.close)
        for login in ("bob", "carol", "vic-1", "vic-2"):
            s.make_user(login)
        assert s.dav("PROPFIND", "/", "bob", headers={"Depth": "0"}).status == 207
        assert s.mkcalendar("bob", "bob", "cal").status == 201

    def generation(self):
        return self.s.api("GET", "/me", "alice").json["generation"]

    def check_valid(self):
        s = self.s
        rc, out, err = s.cli("check-radicale")
        self.assertEqual(rc, 0, out + err)
        with open(os.path.join(s.managed, "rights"), "rb") as fh:
            self.assertEqual(rightsfile.check_text(fh.read().decode("ascii")), [])
        model = s.model()
        with open(os.path.join(s.managed, "users")) as fh:
            logins = {l.split(":")[0] for l in fh if l.strip() and not l.startswith("#")}
        self.assertEqual(logins, set(model.enabled()))
        self.assertEqual(self.s.api("GET", "/health").json["generation"],
                         model.generation)
        stray = [n for n in os.listdir(s.managed) if n.endswith(".tmp")]
        self.assertEqual(stray, [])

    def test_ten_simultaneous_mutations_give_consecutive_generations(self):
        s = self.s
        start = self.generation()
        n = {"i": 0}
        results = {}

        def run(name, method, path, body):
            results[name] = s.api(method, path, "alice", body, timeout=90)

        jobs = []
        for i in range(4):
            jobs.append(("create-%d" % i, "POST", "/accounts", {
                "login": "par-%d" % i, "displayName": "P", "generate": True}))
        jobs += [
            ("patch-1", "PATCH", "/accounts/bob", {"displayName": "Bob One"}),
            ("patch-2", "PATCH", "/accounts/carol", {"displayName": "Carol Two"}),
            ("password", "POST", "/accounts/carol/password", {"generate": True}),
            ("grant", "PUT", "/grants", {"owner": "bob", "collection": "cal",
                                         "grantee": "carol", "level": "read"}),
            ("delete", "DELETE", "/accounts/vic-1", {"confirm": "vic-1"}),
            ("disable", "PATCH", "/accounts/vic-2", {"disabled": True}),
        ]
        self.assertEqual(len(jobs), 10)
        threads = [threading.Thread(target=run, args=j) for j in jobs]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        self.assertEqual(len(results), 10)
        for name, r in results.items():
            self.assertIn(r.status, (200, 201), (name, r.status, r.json))
            self.assertTrue(r.json["active"], name)
        gens = sorted(r.json["generation"] for r in results.values())
        self.assertEqual(gens, list(range(start + 1, start + 11)))
        self.assertEqual(self.generation(), start + 10)
        # the result is what each request asked for
        s.pw["carol"] = results["password"].json["password"]
        self.assertEqual(s.api("GET", "/me", "carol").status, 200)
        self.assertEqual(s.level("carol", "bob", "cal"), "R")
        self.assertEqual(s.api("GET", "/me", "alice").json["generation"], start + 10)
        self.assertEqual(s.dav("PROPFIND", "/", "vic-2", headers={"Depth": "0"}).status, 401)
        self.assertEqual(s.api("GET", "/accounts/bob", "alice").json["displayName"],
                         "Bob One")
        self.check_valid()
        # three more rounds of mixed contention
        for rnd in range(3):
            start = self.generation()
            results.clear()
            jobs = [("c%d" % i, "POST", "/accounts", {
                "login": "rnd-%d-%d" % (rnd, i), "displayName": "R",
                "generate": True}) for i in range(10)]
            threads = [threading.Thread(target=run, args=j) for j in jobs]
            for t in threads:
                t.start()
            for t in threads:
                t.join(120)
            self.assertEqual(sorted(r.json["generation"] for r in results.values()),
                             list(range(start + 1, start + 11)))
        self.check_valid()


@S.requires_radicale
class CrashConsistency(unittest.TestCase):
    def test_kill_9_during_simultaneous_mutations(self):
        s = S.WStack("kill").up()
        self.addCleanup(s.close)
        s.make_user("bob")
        stray_seen = []
        for rnd in range(4):
            stop = threading.Event()

            def run(i, rnd=rnd):
                try:
                    s.api("POST", "/accounts", "alice", {
                        "login": "k-%d-%d" % (rnd, i), "displayName": "K",
                        "generate": True}, timeout=20)
                except OSError:
                    pass
                except Exception:  # noqa: BLE001
                    pass

            threads = [threading.Thread(target=run, args=(i,), daemon=True)
                       for i in range(10)]
            for t in threads:
                t.start()
            time.sleep(0.15 + 0.25 * rnd)
            s.stop_backend(signal.SIGKILL)
            for t in threads:
                t.join(30)
            stray_seen += [n for n in os.listdir(s.managed) if n.endswith(".tmp")]
            s.start_backend()
            deadline = time.time() + 20
            ok = False
            while time.time() < deadline:
                h = s.api("GET", "/health").json
                if h["ok"] and h["active"]:
                    ok = True
                    break
                time.sleep(0.5)
            self.assertTrue(ok, "health did not recover after kill -9: %s" % h)
            rc, out, err = s.cli("check-radicale")
            self.assertEqual(rc, 0, out + err)
            model = s.model()
            with open(os.path.join(s.managed, "rights"), "rb") as fh:
                self.assertEqual(int(fh.readline().rsplit(b"=", 1)[1]),
                                 model.generation)
            with open(os.path.join(s.managed, "users")) as fh:
                logins = {l.split(":")[0] for l in fh
                          if l.strip() and not l.startswith("#")}
            self.assertEqual(logins, set(model.enabled()))
            self.assertEqual(s.api("GET", "/me", "alice").json["generation"],
                             model.generation)
            # generations are consecutive in the stored set
            gens = sorted(g["generation"] for g in
                          s.api("GET", "/generations", "alice").json)
            tail = [g for g in gens if g > gens[0]]
            self.assertTrue(all(b - a == 1 for a, b in zip(tail, tail[1:])) or
                            len(tail) < 2, gens)
        S.info("kill -9 rounds: leftover temp files in the managed directory "
               "after the kills: %s" % (stray_seen or "none"))


@S.requires_radicale
class SecretsInLogs(unittest.TestCase):
    def test_logs_hold_no_passwords_hashes_or_authorization_values(self):
        s = S.WStack("logs").up()
        self.addCleanup(s.close)
        typed = "a long enough passphrase 8!"
        s.make_user("bob", password=typed)
        s.make_user("bot-9", bot=True)
        s.make_user("typed-1", password="Another long typed passphrase 4#")
        wrongs = []
        for i in range(6):
            w = wrong_pw()
            wrongs.append(w)
            s.api("GET", "/me", "alice", password=w)
            s.api("GET", "/me", "nobody-%d" % i, password=w)
            s.dav("PROPFIND", "/", "bob", password=w, headers={"Depth": "0"})
        s.api("POST", "/accounts/bob/password", "alice", {"generate": True})
        s.api("POST", "/accounts/bob/password", "alice",
              {"password": "yet another long passphrase 6$"})
        s.pw["bob"] = "yet another long passphrase 6$"
        s.api("PATCH", "/accounts/bot-9", "alice", {"disabled": True})
        s.api("DELETE", "/accounts/bot-9", "alice", {"confirm": "bot-9"})
        s.api("POST", "/accounts", "alice", {"login": "bad..", "displayName": "x",
                                              "password": "x"})
        s.api("GET", "/me", auth="Basic " + base64.b64encode(b"alice:" + b"p" * 100).decode())
        # every secret that appeared in this run, in plain and as Authorization
        secrets_ = set(wrongs) | set(s.pw.values()) | s.secrets_seen | {
            typed, "Another long typed passphrase 4#",
            "yet another long passphrase 6$"}
        tokens = set()
        for login in list(s.pw) + ["nobody-%d" % i for i in range(6)]:
            for pw in secrets_:
                tokens.add(base64.b64encode(("%s:%s" % (login, pw)).encode()).decode())
        with open(os.path.join(s.state, "model.json")) as fh:
            hashes = set(re.findall(r"\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}", fh.read()))
        with open(os.path.join(s.managed, "users")) as fh:
            hashes |= set(re.findall(r"\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}", fh.read()))
        self.assertGreater(len(hashes), 3)
        self.assertGreater(len(secrets_), 10)
        text = S.log_text(s)
        self.assertGreater(len(text), 200)
        self.assertIn('"event":"auth.failed"', text)
        for pw in secrets_:
            self.assertNotIn(pw, text)
        for tok in tokens:
            self.assertNotIn(tok, text)
        for h in hashes:
            self.assertNotIn(h, text)
        for needle in ("Authorization", "authorization", "Basic ", "$2b$", "$2a$"):
            self.assertNotIn(needle, text)
        # the audit lines: fixed field set, one JSON object per line, no extra
        for line in s.stdout().splitlines():
            self.assertEqual(list(json.loads(line)), [
                "ts", "event", "actor", "ip", "target", "result", "generation"])
        # no WWW-Authenticate was ever sent by the backend
        self.assertNotIn("www-authenticate", s.seen_headers)


if __name__ == "__main__":
    unittest.main()
