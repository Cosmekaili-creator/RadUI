#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Browser end-to-end run: the rendered nginx stack (deploy/ templates, the same
renderer and nginx harness helpers as tests/deploy/nginx_check.py) in front of a
throwaway Radicale (production rights plugin) and the real backend, serving
the app from src/ at its configured base path, then ONE Chromium driven by
tests/e2e/e2e.mjs, then everything torn down.

Run one suite per capped run (``make test-e2e E2E_SUITE=<name>`` does):

    sudo -n systemd-run --scope --quiet --uid=<uid> --gid=<gid> \
        -p MemoryMax=2G -p MemorySwapMax=0 -- timeout 600 python3 tests/e2e/run.py --suite <name>

Suites (tests/e2e/scenarios/<name>.mjs): shell, contacts, groups, collections, import-export, conflict, pwa,
security, perf, agent (tests/e2e/agent/flows.mjs), shots, users (Run 3a), calendar (Run 3b; seeds a Work and a Home
calendar and a book with three birthdays), tasks (Run 3c; seeds two task lists: nine tasks relative to today in Europe/Paris). Without --suite the shell suite runs. Anything after
the suite name is handed to the runner (scenario names to run alone, --fast).

The run copies src/ (or dist/ with --www-from dist or RADUI_E2E_WWW=dist, after `make dist`) into its own run directory, generates the service-worker file list there (never into src/)
and serves that copy through the rendered nginx stack with the strict headers.

Ports: Radicale 15450 to 15454, backend 15455 to 15459, nginx 18120 to 18129 (first free one). Environment:
    RADUI_PW_DIR               directory holding node_modules/playwright (outside the repo)
    PLAYWRIGHT_BROWSERS_PATH   where the Chromium build lives
    RADICALE_BIN, NGINX_BIN    as for the other harnesses
    RADUI_E2E_KEEP=1           keep the run directory (debugging)
Exit status 0 when every scenario passed, 1 otherwise, 3 when memory is short,
77 when a required program is missing.
"""
import argparse
import configparser
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
INTEG = os.path.join(REPO, "backend", "tests", "integration")
sys.path.insert(0, INTEG)
sys.path.insert(0, os.path.join(REPO, "tests", "deploy"))

import wp10_support as W  # noqa: E402
import nginx_check as NC  # noqa: E402
from plugin import support  # noqa: E402

sys.path.insert(0, HERE)
import gen_contacts as G  # noqa: E402

H = W.H
# throwaway ports of this suite (the WP10 stack classes read these module attributes when they start)
W.WP10_RADICALE_PORTS = range(15450, 15455)
W.WP10_BACKEND_PORTS = range(15455, 15460)
W.WP10_DIR = os.path.join(REPO, ".throwaway", "e2e")
NGINX_PORTS = range(18120, 18130)
WWW_FROM = "src"  # "src" or "dist": which tree of the repository is copied and served (--www-from / RADUI_E2E_WWW)
NGINX_PORT = 18120
HOST = "example.org"
MIN_MB = 2000
SUITES = ("shell", "contacts", "groups", "collections", "import-export", "conflict", "pwa", "security", "perf",
          "agent", "shots", "users", "calendar", "tasks")


def mem_available_mb():
    with open("/proc/meminfo") as fh:
        for line in fh:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 0


MKCOL_BOOK = ('<?xml version="1.0"?><D:mkcol xmlns:D="DAV:" '
              'xmlns:CR="urn:ietf:params:xml:ns:carddav"><D:set><D:prop>'
              '<D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype>'
              '<D:displayname>%s</D:displayname></D:prop></D:set></D:mkcol>')
MKCAL = ('<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" '
         'xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/">'
         '<D:set><D:prop><D:displayname>%s</D:displayname><I:calendar-color>%s</I:calendar-color>'
         '<C:supported-calendar-component-set><C:comp name="VEVENT"/>'
         '</C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>')


MKCAL_TODO = ('<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" '
              'xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/">'
              '<D:set><D:prop><D:displayname>%s</D:displayname><I:calendar-color>%s</I:calendar-color>'
              '<C:supported-calendar-component-set><C:comp name="VTODO"/>'
              '</C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>')

PARIS_TZ = ("BEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\n"
            "TZNAME:CEST\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\n"
            "BEGIN:STANDARD\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nTZNAME:CET\r\nDTSTART:19701025T030000\r\n"
            "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n")
NY_TZ = ("BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\n"
         "TZNAME:EDT\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nEND:DAYLIGHT\r\n"
         "BEGIN:STANDARD\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nTZNAME:EST\r\nDTSTART:19701101T020000\r\n"
         "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n")


def ics(events, tzs=""):
    """A VCALENDAR text. `events` = list of VEVENT bodies (the lines between BEGIN:VEVENT and END:VEVENT)."""
    out = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI e2e//EN\r\n" + tzs
    for body in events:
        out += "BEGIN:VEVENT\r\n" + body.replace("\n", "\r\n") + "\r\nEND:VEVENT\r\n"
    return out + "END:VCALENDAR\r\n"


def vcard(uid, name, mail):
    last, first = name.split(", ")
    return ("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:%s\r\nFN:%s %s\r\nN:%s;%s;;;\r\n"
            "EMAIL;TYPE=INTERNET:%s\r\nEND:VCARD\r\n" % (uid, first, last, last, first, mail))


def vcard_bday(uid, fn, n, bday, mail):
    return ("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:%s\r\nFN:%s\r\nN:%s;;;\r\nBDAY:%s\r\n"
            "EMAIL;TYPE=INTERNET:%s\r\nEND:VCARD\r\n" % (uid, fn, n, bday, mail))


class E2EStack(W.WStack):
    """The WP10 stack whose backend and Radicale configurations are rendered
    from deploy/ and which has an nginx in front."""

    def __init__(self):
        self.nginx_proc_dir = None
        super().__init__("e2e", max_connections=32)

    # -- rendered configuration ------------------------------------------------------
    def _render(self):
        rd, example = NC.read_vars(os.path.join(REPO, "deploy", "vars.example.env"))
        import grp
        values = dict(example)
        self.www = os.path.join(self.dir, "www")
        self.snippets = os.path.join(self.dir, "snippets")
        values.update({
            "SERVER_NAME": HOST, "UI_PATH": "/ui", "UI_DIR": self.www,
            "NGINX_SNIPPETS_DIR": self.snippets, "MANAGED_DIR": self.managed,
            "STATE_DIR": self.state, "CONFIG_DIR": os.path.join(self.dir, "config"),
            "PLUGIN_DIR": support.PLUGIN_DIR,
            "INSTALL_DIR": os.path.join(REPO, "backend"),
            "BACKEND_LISTEN": "127.0.0.1:%d" % self.bport,
            "RADICALE_UPSTREAM": "127.0.0.1:%d" % self.rport,
            "RADICALE_GROUP": grp.getgrgid(os.getgid()).gr_name,
            "RADICALE_PYTHON": support.radicale_python(),
            "API_RATE": "6000r/m", "API_BURST": "200", "RADICALE_MAX_BODY": "2M",
            "RADICALE_MAX_CONNECTIONS": "32",
        })
        self.rendered_dir = os.path.join(self.dir, "rendered")
        NC.render(rd, values, self.rendered_dir)

    def _write_config(self):
        self._render()
        os.makedirs(os.path.join(self.dir, "config"), mode=0o755)
        text = open(os.path.join(self.rendered_dir, "backend", "config.toml")).read()
        # the browser talks plain http to the throwaway nginx on a high port
        text = text.replace('allowed_origins = ["https://%s"]' % HOST,
                            'allowed_origins = ["https://%s", "http://%s:%d"]'
                            % (HOST, HOST, NGINX_PORT))
        assert "http://%s:%d" % (HOST, NGINX_PORT) in text
        # every browser client is 127.0.0.1 for the backend's per-address limiter: raise the limit so
        # the many deliberate wrong passwords of the run do not trip it (the last scenario does, on purpose)
        text += "rate_limit_failures = 40\n"
        with open(self.config_path, "w") as fh:
            fh.write(text)
        os.chmod(self.config_path, 0o600)

    def _write_radicale_conf(self):
        snippet = configparser.ConfigParser(interpolation=None)
        snippet.read(os.path.join(self.rendered_dir, "radicale", "config-snippet.ini"))
        conf = configparser.ConfigParser(interpolation=None)
        conf.read_dict({s: dict(snippet.items(s)) for s in snippet.sections()})
        conf["server"]["hosts"] = "127.0.0.1:%d" % self.rport
        conf["storage"] = {"filesystem_folder": os.path.join(self.dir, "collections")}
        conf["auth"]["delay"] = "0"
        conf["logging"] = {"level": "warning"}
        assert conf["server"].get("max_connections") == "32", dict(conf["server"])
        with open(self.radicale_conf, "w") as fh:
            conf.write(fh)

    # -- nginx -------------------------------------------------------------------------
    def build_www(self):
        """A copy of src/ (or of dist/, --www-from dist) in the run directory with its own service-worker file list
        (never written into the source tree)."""
        ignore = shutil.ignore_patterns("sw-manifest.js", "__pycache__")
        tree = os.path.join(REPO, WWW_FROM)
        if not os.path.isfile(os.path.join(tree, "index.html")):
            raise RuntimeError("%s/ has no index.html (for dist: run `make dist` first)" % WWW_FROM)
        shutil.copytree(tree, self.www, ignore=ignore)
        # The blocking-dialog test button is shown only when config.json has debug=true.
        cfg_path = os.path.join(self.www, "config.json")
        with open(cfg_path) as fh:
            cfg = json.load(fh)
        cfg["debug"] = True
        with open(cfg_path, "w") as fh:
            json.dump(cfg, fh, indent=2)
        self.build_manifest()

    def build_manifest(self):
        r = subprocess.run([sys.executable, os.path.join(REPO, "tools", "build-sw-manifest.py"), "--src", self.www,
                            "--out", os.path.join(self.www, "sw-manifest.js")], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError("build-sw-manifest failed: " + r.stderr)
        return r.stdout.strip()

    def start_nginx(self):
        nginx = NC.find_nginx()
        self.build_www()
        os.makedirs(self.snippets)
        for f in ("radui-http.conf", "radui-security-headers.inc",
                  "radui-proxy-headers.inc", "radui-locations.conf"):
            shutil.copy(os.path.join(self.rendered_dir, "nginx", f), self.snippets)
        os.makedirs(os.path.join(self.dir, "tmp-%d" % NGINX_PORT))
        conf = os.path.join(self.dir, "nginx.conf")
        with open(conf, "w") as fh:
            fh.write(NC.nginx_conf(self.dir, self.rendered_dir, self.snippets, NGINX_PORT))
        self.nginx_conf = conf
        err = os.path.join(self.dir, "nginx-%d.error.log" % NGINX_PORT)
        r = subprocess.run([nginx, "-t", "-c", conf, "-p", self.dir + "/", "-e", err],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError("nginx -t failed: " + r.stderr)
        subprocess.run([nginx, "-c", conf, "-p", self.dir + "/", "-e", err],
                       check=True, timeout=30)
        if not NC.wait_port(NGINX_PORT):
            raise RuntimeError("nginx did not start")

    def stop_nginx(self):
        pid = os.path.join(self.dir, "nginx-%d.pid" % NGINX_PORT)
        try:
            with open(pid) as fh:
                os.kill(int(fh.read().strip()), signal.SIGQUIT)
        except (OSError, ValueError):
            pass
        t0 = time.time()
        while time.time() - t0 < 10 and not NC.port_free(NGINX_PORT):
            time.sleep(0.1)

    def close(self):
        self.stop_nginx()
        super().close()

    # -- data ----------------------------------------------------------------------------
    def put(self, login, path, text, ctype="text/vcard"):
        r = self.dav("PUT", path, login, text.encode("utf-8") if isinstance(text, str) else text,
                     {"Content-Type": ctype + "; charset=utf-8"})
        assert r.status in (201, 204), (path, r.status, r.body[:200])
        return r

    def mkbook(self, login, name, display):
        r = self.dav("MKCOL", "/%s/%s/" % (login, name), login, MKCOL_BOOK % display, support.XML_HDR)
        assert r.status == 201, (name, r.status, r.body[:200])

    def seed_book(self, login, name, display, items):
        self.mkbook(login, name, display)
        for fname, text in items:
            self.put(login, "/%s/%s/%s" % (login, name, fname), text)
        return len(items)

    def seed_by_file_copy(self, login, name, display, items):
        """Cards that reach the storage by file copy, not by PUT (cold item cache on the first read)."""
        self.mkbook(login, name, display)
        folder = os.path.join(self.dir, "collections", "collection-root", login, name)
        assert os.path.isdir(folder), folder
        G.write_dir(folder, items)
        return len(items)

    def seed(self, suite):
        s = self
        s.make_user("bob")
        s.make_user("carol", ownSpace=False)
        for login in ("alice", "bob", "agent-1"):
            assert s.dav("PROPFIND", "/", login, headers={"Depth": "0"}).status == 207
        self.counts = {}
        ics = support.ICS_HDR
        for name, color, uids in (("cal-work", "#1e5e52", ("w1", "w2", "w3")),
                                  ("personal", "#a3321f", ("p1",))):
            assert s.dav("MKCALENDAR", "/alice/%s/" % name, "alice", MKCAL % (name, color),
                         support.XML_HDR).status == 201
            for uid in uids:
                assert s.put_event("alice", "alice", name, uid, "Event %s" % uid).status == 201
            self.counts["/alice/%s/" % name] = len(uids)
        # alice: a vCard 3.0 book with Apple-form groups, and a vCard 4.0 book with an RFC 6350 group
        core3 = G.core_cards("3.0")
        items = [(f, t) for f, t, _u in core3.values()] + [c for c in G.cards(24, "3.0", seed=7, photo_percent=0)]
        fam = G.apple_group("Family", [core3["jane"][2], core3["rick"][2]], "family")
        club = G.apple_group("Book club", [core3["jane"][2], core3["zoe"][2], core3["abe"][2]], "bookclub")
        items += [(fam[0], fam[1]), (club[0], club[1])]
        self.counts["/alice/contacts/"] = s.seed_book("alice", "contacts", "Contacts", items)
        core4 = G.core_cards("4.0")
        items = [(f, t) for f, t, _u in core4.values()] + [c for c in G.cards(6, "4.0", seed=9, photo_percent=0)]
        team = G.kind_group("Example Team", [core4["jane"][2], core4["rick"][2]], "team")
        items.append((team[0], team[1]))
        self.counts["/alice/contacts40/"] = s.seed_book("alice", "contacts40", "Contacts 4.0", items)
        self.core = {"3.0": {k: v[2] for k, v in core3.items()}, "4.0": {k: v[2] for k, v in core4.items()},
                     "groups3": {"family": fam[2], "bookclub": club[2]}, "groups4": {"team": team[2]}}
        # bob: an address book and a calendar
        assert s.dav("MKCALENDAR", "/bob/bob-cal/", "bob", MKCAL % ("bob-cal", "#1f6446"),
                     support.XML_HDR).status == 201
        for uid in ("b1", "b2"):
            assert s.put_event("bob", "bob", "bob-cal", uid, "Bob %s" % uid).status == 201
        self.counts["/bob/bob-cal/"] = 2
        items = [(f, t) for f, t, _u in list(G.core_cards("3.0").values())[:3]]
        self.counts["/bob/bob-book/"] = s.seed_book("bob", "bob-book", "Bob book", items)
        for body in ({"owner": "bob", "collection": "bob-cal", "grantee": "agent-1", "level": "read"},
                     {"owner": "bob", "collection": "bob-book", "grantee": "agent-1", "level": "read"}):
            r = s.api("PUT", "/grants", "bob", body)
            assert r.status == 200, r.json
        r = s.api("PUT", "/grants", "alice", {"owner": "alice", "collection": "contacts40", "grantee": "bob",
                                              "level": "readwrite"})
        assert r.status == 200, r.json
        # bigger books by file copy, only for the suites that need them
        self.big = {}
        if suite in ("contacts", "shots"):
            n = s.seed_by_file_copy("alice", "big-book", "Big book", G.cards(520, "3.0", seed=3, photo_percent=0))
            self.big["/alice/big-book/"] = n
        if suite == "calendar":
            self.seed_calendar()
        if suite == "tasks":
            self.seed_tasks()
        if suite == "perf":
            half = G.cards(1000, "3.0", seed=5, photo_percent=5) + G.cards(1000, "4.0", seed=5, photo_percent=5, start=1000)
            n = s.seed_by_file_copy("alice", "perf-book", "Perf book", half)
            self.big["/alice/perf-book/"] = n


    def seed_calendar(self):
        """Suite `calendar` (Run 3b): two calendars of alice with a weekly series (an override and an EXDATE), a flight
        across two zones, an event in a zone nobody knows, a three-day all-day event, a floating event, 30 single
        events in November 2026, a yearly all-day event that duplicates a birthday; a book with three birthdays;
        agent-1 may only read the second calendar. All names are fictional."""
        s = self
        mk = lambda name, color, disp: s.dav("MKCALENDAR", "/alice/%s/" % name, "alice",
                                              MKCAL % (disp, color), support.XML_HDR)
        assert mk("e2e-work", "#1e5e52", "Work").status == 201
        assert mk("e2e-home", "#a3321f", "Home").status == 201
        work = "/alice/e2e-work/"
        home = "/alice/e2e-home/"
        stamp = "DTSTAMP:20260101T000000Z\n"
        items = {
            "weekly-review": ics([
                "UID:e2e-weekly-review\n" + stamp + "DTSTART;TZID=Europe/Paris:20261102T093000\n"
                "DTEND;TZID=Europe/Paris:20261102T103000\nRRULE:FREQ=WEEKLY;COUNT=12;BYDAY=MO\n"
                "EXDATE;TZID=Europe/Paris:20261123T093000\nSUMMARY:Weekly review\nLOCATION:Room 4",
                "UID:e2e-weekly-review\n" + stamp + "RECURRENCE-ID;TZID=Europe/Paris:20261116T093000\n"
                "DTSTART;TZID=Europe/Paris:20261116T140000\nDTEND;TZID=Europe/Paris:20261116T150000\n"
                "SUMMARY:Weekly review (moved)\nSEQUENCE:1"], PARIS_TZ),
            "flight": ics(["UID:e2e-flight\n" + stamp + "DTSTART;TZID=Europe/Paris:20261118T100000\n"
                           "DTEND;TZID=America/New_York:20261118T123000\nSUMMARY:Flight to the example city\nLOCATION:Gate 12"],
                          PARIS_TZ + NY_TZ),
            "unknown-zone": ics(["UID:e2e-unknown-zone\n" + stamp + "DTSTART;TZID=Mars/Olympus_Mons:20261119T150000\n"
                                 "DTEND;TZID=Mars/Olympus_Mons:20261119T160000\nSUMMARY:Call on the red planet"]),
            "offsite": ics(["UID:e2e-offsite\n" + stamp + "DTSTART;VALUE=DATE:20261124\nDTEND;VALUE=DATE:20261127\n"
                            "SUMMARY:Offsite days"]),
            "floating": ics(["UID:e2e-floating\n" + stamp + "DTSTART:20261120T180000\nDTEND:20261120T200000\n"
                             "SUMMARY:Floating dinner"]),
        }
        for day in range(1, 31):
            items["single-%02d" % day] = ics(["UID:e2e-single-%02d\n" % day + stamp
                                              + "DTSTART;TZID=Europe/Paris:202611%02dT110000\n" % day
                                              + "DTEND;TZID=Europe/Paris:202611%02dT113000\n" % day
                                              + "SUMMARY:Single %02d" % day], PARIS_TZ)
        for name, text in items.items():
            assert s.put(("alice"), "%s%s.ics" % (work, name), text, "text/calendar").status in (201, 204)
        home_items = {
            "dentist": ics(["UID:e2e-dentist\n" + stamp + "DTSTART;TZID=Europe/Paris:20261118T150000\n"
                            "DTEND;TZID=Europe/Paris:20261118T160000\nSUMMARY:Dentist"], PARIS_TZ),
            "cleo-birthday": ics(["UID:e2e-cleo-birthday\n" + stamp + "DTSTART;VALUE=DATE:20201120\n"
                                  "DTEND;VALUE=DATE:20201121\nRRULE:FREQ=YEARLY\nSUMMARY:Cleo Birchwood birthday"]),
        }
        for name, text in home_items.items():
            assert s.put("alice", "%s%s.ics" % (home, name), text, "text/calendar").status in (201, 204)
        self.counts[work] = len(items)
        self.counts[home] = len(home_items)
        bday = [
            ("ada.vcf", vcard_bday("e2e-bday-ada", "Ada Birchwood-Test", "Birchwood-Test;Ada", "1985-11-18", "ada.b@example.org")),
            ("bruno.vcf", vcard_bday("e2e-bday-bruno", "Bruno Larchwood", "Larchwood;Bruno", "--1119", "bruno.l@example.org")),
            ("cleo.vcf", vcard_bday("e2e-bday-cleo", "Cleo Birchwood", "Birchwood;Cleo", "1990-11-20", "cleo.b@example.org")),
        ]
        self.counts["/alice/bday-book/"] = s.seed_book("alice", "bday-book", "Birthdays book", bday)
        r = s.api("PUT", "/grants", "alice", {"owner": "alice", "collection": "e2e-home", "grantee": "agent-1",
                                              "level": "read"})
        assert r.status == 200, r.json
        self.cal = {"work": work, "home": home, "book": "/alice/bday-book/"}

    def seed_tasks(self):
        """Suite `tasks` (Run 3c): alice has the task lists "Tasks" (nine tasks, dates relative to TODAY in Europe/Paris so
        that overdue / today / later hold on any day: an overdue one, one due today, one due later with a time and a zone,
        one with no date, a done one, a parent with two sub-tasks, a repeating one) and "Chores" (one task, shared
        read-only with agent-1). bob has no task list, carol has no space. All names are fictional."""
        import datetime
        from zoneinfo import ZoneInfo
        s = self
        today = datetime.datetime.now(ZoneInfo("Europe/Paris")).date()
        day = lambda n: (today + datetime.timedelta(days=n)).strftime("%Y%m%d")
        stamp = "DTSTAMP:20260101T000000Z\r\n"

        def todo(uid, summary, *lines):
            return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI e2e//EN\r\nBEGIN:VTODO\r\nUID:%s\r\n%sSUMMARY:%s\r\n%s"
                    "END:VTODO\r\nEND:VCALENDAR\r\n" % (uid, stamp, summary, "".join(x + "\r\n" for x in lines)))
        mk = lambda name, color, disp: s.dav("MKCALENDAR", "/alice/%s/" % name, "alice", MKCAL_TODO % (disp, color), support.XML_HDR)
        assert mk("e2e-tasks", "#1e5e52", "Tasks").status == 201
        assert mk("e2e-chores", "#a3321f", "Chores").status == 201
        tasks, chores = "/alice/e2e-tasks/", "/alice/e2e-chores/"
        items = {
            "overdue": todo("e2e-t-overdue", "Pay the example invoice", "DUE;VALUE=DATE:" + day(-3), "PRIORITY:1"),
            "today": todo("e2e-t-today", "Call the example dentist", "DUE;VALUE=DATE:" + day(0), "PRIORITY:5"),
            "soon": todo("e2e-t-soon", "Prepare the quarterly report", "DTSTART;TZID=Europe/Paris:" + day(2) + "T090000",
                         "DUE;TZID=Europe/Paris:" + day(5) + "T170000", "PRIORITY:9", "CATEGORIES:WORK", "DESCRIPTION:Numbers for the example board."),
            "nodue": todo("e2e-t-nodue", "Sort the bookshelf"),
            "done": todo("e2e-t-done", "File the example taxes", "STATUS:COMPLETED", "PERCENT-COMPLETE:100",
                         "COMPLETED:" + day(-9) + "T100000Z", "DUE;VALUE=DATE:" + day(-10)),
            "parent": todo("e2e-t-parent", "Plan the example trip", "DUE;VALUE=DATE:" + day(12), "PRIORITY:2"),
            "child1": todo("e2e-t-child1", "Book the example train", "RELATED-TO:e2e-t-parent", "DUE;VALUE=DATE:" + day(8), "PRIORITY:3"),
            "child2": todo("e2e-t-child2", "Reserve the example hotel", "RELATED-TO:e2e-t-parent", "DUE;VALUE=DATE:" + day(9)),
            "repeat": todo("e2e-t-repeat", "Water the example plants", "DTSTART;VALUE=DATE:" + day(1), "DUE;VALUE=DATE:" + day(2),
                           "RRULE:FREQ=WEEKLY;COUNT=20"),
        }
        for name, text in items.items():
            assert s.put("alice", "%s%s.ics" % (tasks, name), text, "text/calendar").status in (201, 204)
        assert s.put("alice", chores + "recycling.ics", todo("e2e-t-recycling", "Take out the example recycling"), "text/calendar").status in (201, 204)
        r = s.api("PUT", "/grants", "alice", {"owner": "alice", "collection": "e2e-chores", "grantee": "agent-1", "level": "read"})
        assert r.status == 200, r.json
        self.counts[tasks] = len(items)
        self.counts[chores] = 1
        self.tasks = {"list": tasks, "chores": chores, "today": today.isoformat(), "items": {k: v for k, v in
                      (("overdue", "e2e-t-overdue"), ("today", "e2e-t-today"), ("soon", "e2e-t-soon"), ("nodue", "e2e-t-nodue"),
                       ("done", "e2e-t-done"), ("parent", "e2e-t-parent"), ("child1", "e2e-t-child1"), ("child2", "e2e-t-child2"),
                       ("repeat", "e2e-t-repeat"), ("recycling", "e2e-t-recycling"))}}

    def description(self, suite):
        base = "http://%s:%d" % (HOST, NGINX_PORT)
        c = self.counts

        def row(href, kind, source, writable):
            return {"count": c[href], "kind": kind, "source": source, "writable": writable}
        return {
            "suite": suite,
            "base": base, "host": HOST, "port": NGINX_PORT, "uiPath": "/ui/",
            "radicale": "http://127.0.0.1:%d" % self.rport,
            "repo": REPO, "www": self.www, "runDir": self.dir,
            "storage": os.path.join(self.dir, "collections"),
            "users": {k: self.pw[k] for k in ("alice", "bob", "agent-1", "carol")},
            "core": self.core, "big": self.big, "counts": c, "cal": getattr(self, "cal", None),
            "tasks": getattr(self, "tasks", None),
            "expect": {
                "alice": {"admin": True, "collections": {
                    "/alice/cal-work/": row("/alice/cal-work/", "calendar", "own", True),
                    "/alice/personal/": row("/alice/personal/", "calendar", "own", True),
                    "/alice/contacts/": row("/alice/contacts/", "addressbook", "own", True),
                    "/alice/contacts40/": row("/alice/contacts40/", "addressbook", "own", True),
                    **{h: {"count": n, "kind": "addressbook", "source": "own", "writable": True}
                       for h, n in self.big.items()}}},
                "agent-1": {"admin": False, "collections": {
                    "/alice/cal-work/": row("/alice/cal-work/", "calendar", "grant", True),
                    "/alice/contacts/": row("/alice/contacts/", "addressbook", "grant", True),
                    "/bob/bob-cal/": row("/bob/bob-cal/", "calendar", "grant", False),
                    "/bob/bob-book/": row("/bob/bob-book/", "addressbook", "grant", False)}},
                "bob": {"admin": False, "collections": {
                    "/bob/bob-cal/": row("/bob/bob-cal/", "calendar", "own", True),
                    "/bob/bob-book/": row("/bob/bob-book/", "addressbook", "own", True),
                    "/alice/contacts40/": row("/alice/contacts40/", "addressbook", "grant", True)}},
                "carol": {"admin": False, "collections": {}},
            },
            "logs": {"radicale": self.radicale_log, "backend_out": self.out_path,
                     "backend_err": self.err_path,
                     "nginx_error": os.path.join(self.dir, "nginx-%d.error.log" % NGINX_PORT),
                     "nginx_access": os.path.join(self.dir, "nginx-%d.access.log" % NGINX_PORT)},
        }


def parse(argv):
    ap = argparse.ArgumentParser(description="One browser suite behind the rendered nginx stack.")
    ap.add_argument("--suite", default="shell", choices=SUITES)
    ap.add_argument("--www-from", choices=("src", "dist"), default=os.environ.get("RADUI_E2E_WWW", "src"),
                    help="serve a copy of src/ (default) or of the built dist/ (run `make dist` first); also RADUI_E2E_WWW")
    ap.add_argument("rest", nargs="*", help="handed to the runner: scenario names, --fast")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse(sys.argv[1:] if argv is None else argv)
    suite = args.suite
    global WWW_FROM
    if args.www_from not in ("src", "dist"):
        print("--www-from / RADUI_E2E_WWW must be src or dist", file=sys.stderr)
        return 2
    WWW_FROM = args.www_from
    if not (NC.find_nginx() and support.RADICALE_BIN):
        print("nginx or Radicale not found", file=sys.stderr)
        return 77
    pw_dir = os.environ.get("RADUI_PW_DIR", "")
    if not pw_dir or not os.path.isfile(os.path.join(pw_dir, "node_modules", "playwright", "index.mjs")):
        print("set RADUI_PW_DIR to a directory with node_modules/playwright (see docs/testing.md)",
              file=sys.stderr)
        return 77
    avail = mem_available_mb()
    print("memory available: %d MB" % avail, flush=True)
    if avail < MIN_MB:
        print("less than %d MB available: not starting a browser" % MIN_MB, file=sys.stderr)
        return 3
    if not NC.port_free(NGINX_PORT):
        print("port %d in use" % NGINX_PORT, file=sys.stderr)
        return 2
    stack = E2EStack()
    code = 1
    try:
        stack.up()
        t0 = time.time()
        stack.seed(suite)
        print("seeded in %.1f s" % (time.time() - t0), flush=True)
        stack.start_nginx()
        spec = os.path.join(stack.dir, "stack.json")
        with open(spec, "w") as fh:
            json.dump(stack.description(suite), fh)
        os.chmod(spec, 0o600)
        shots = os.path.join(HERE, "shots")
        os.makedirs(shots, exist_ok=True)
        env = dict(os.environ)
        env["RADUI_E2E_SPEC"] = spec
        env["RADUI_E2E_SHOTS"] = shots
        env["RADUI_E2E_SUITE"] = suite
        p = subprocess.Popen(["node", os.path.join(HERE, "e2e.mjs"), "--suite=" + suite] + args.rest, env=env,
                             start_new_session=True)
        try:
            code = p.wait(timeout=560)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            print("e2e.mjs timed out", file=sys.stderr)
            code = 1
    finally:
        keep = os.environ.get("RADUI_E2E_KEEP") == "1"
        if keep:
            print("run directory kept: " + stack.dir)
            stack.stop_nginx()
            stack.stop_backend()
            stack.stop_radicale()
        else:
            stack.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
