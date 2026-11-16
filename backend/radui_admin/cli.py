# SPDX-License-Identifier: AGPL-3.0-or-later
"""``radui-admin-cli``: local administration from a shell (see docs/admin-cli.md).

Every command that changes anything goes through ``filewrite.Store`` and
therefore shares the ``flock`` of the running server, runs the same lockout
rules and the same candidate validation. Passwords and hashes are never
printed except the one new password that ``reset-password`` is asked to
create.

Exit codes: 0 success; 1 a check or smoke test failed; 2 usage or
configuration error; 3 refused (unknown login or generation, a model already
exists, lockout rule); 4 import has errors or unexplained differences;
5 another change holds the lock (busy); 6 model missing or corrupt;
7 the generated files failed validation.
"""
import argparse
import base64
import dataclasses
import http.client
import json
import os
import secrets
import sys
from typing import List, Optional, Sequence

from . import config as config_mod
from . import expected, generator, importer, passwords
from . import model as model_mod
from . import validate_candidate as vc
from .audit import Audit
from . import filewrite
from .filewrite import USERS_UNCHECKED_MESSAGE, Store
from .names import ApiError

EX_OK, EX_FAIL, EX_USAGE, EX_REFUSED, EX_IMPORT, EX_BUSY, EX_MODEL, \
    EX_VALIDATION = 0, 1, 2, 3, 4, 5, 6, 7
LEGACY_USERS = "/etc/radicale/users"
LEGACY_RIGHTS = "/etc/radicale/rights"
ENV_SMOKE_PASSWORD = "RADUI_SMOKE_ADMIN_PASSWORD"


def _exit_for(exc: ApiError) -> int:
    if exc.code == "busy":
        return EX_BUSY
    if exc.code == "model_corrupt":
        return EX_MODEL
    if exc.code == "internal" and exc.reason == "candidate_rejected":
        return EX_VALIDATION
    if exc.code in ("not_found", "exists", "tombstoned", "lockout_last_admin",
                    "lockout_self", "validation", "collection_not_found"):
        return EX_REFUSED
    return EX_FAIL


def _fail(exc: ApiError) -> int:
    print("error: %s (%s)" % (exc.message, exc.code), file=sys.stderr)
    for line in getattr(exc, "detail", []):
        print("  - " + line, file=sys.stderr)
    return _exit_for(exc)


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# -- commands ---------------------------------------------------------------------

def cmd_import(store: Store, cfg: config_mod.Config, args) -> int:
    try:
        users_text, rights_text = _read(args.users), _read(args.rights)
        known = None
        if args.collections:
            known = json.loads(_read(args.collections))
    except (OSError, ValueError) as exc:
        print("error: cannot read input: %s" % exc, file=sys.stderr)
        return EX_USAGE
    result = importer.import_legacy(
        users_text, rights_text, admins=args.admin, now=store.now(),
        known_collections=known, extra_reserved=cfg.extra_reserved_logins)
    for issue in result.issues:
        print("%s %s: %s (%s)" % (issue.level, issue.code, issue.message,
                                  issue.subject))
    if not result.ok:
        print("import refused: fix the errors above", file=sys.stderr)
        return EX_IMPORT
    model = result.model
    new_rights, _users, _ = generator.generate(model)
    try:
        matcher = expected.RadicaleMatcher(cfg.radicale_python,
                                           int(cfg.validate_timeout_s) * 3)
        report = importer.equivalence_report(
            rights_text, new_rights, model, matcher=matcher, result=result,
            known_collections=known)
    except (RuntimeError, OSError) as exc:
        print("error: equivalence check failed: %s" % exc, file=sys.stderr)
        return EX_VALIDATION
    print("accounts: %d (admins: %s)" % (len(model.accounts),
                                         ", ".join(model.admins())))
    print("grants: %d" % len(model.grants))
    print("equivalence: " + ", ".join(
        "%s=%d" % kv for kv in report.summary().items()))
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write(report.to_text())
        print("full report written to %s" % args.report)
    for d in report.unexplained:
        print("UNEXPLAINED %s %s %s %s -> %s" % (
            d.direction, d.user or "<anonymous>", d.path or "<root>",
            d.old_letters or "-", d.new_letters or "-"))
    if report.unexplained:
        print("import refused: unexplained differences", file=sys.stderr)
        return EX_IMPORT
    applied = store.install_initial(model, probe=False, dry_run=args.dry_run)
    if args.dry_run:
        print("dry run: nothing written")
    else:
        print("generation %d written (baseline kept)" % applied.new.generation)
    return EX_OK


def cmd_check(store: Store, cfg: config_mod.Config, args) -> int:
    try:
        model: Optional[model_mod.Model] = store.load_model()
    except ApiError as exc:
        model = None
        print("note: no usable model (%s); structural checks only" % exc.reason)
    try:
        res = vc.validate_files(cfg.rights_path, cfg.users_path, model,
                                python=cfg.radicale_python,
                                plugin_dir=cfg.plugin_dir,
                                timeout=cfg.validate_timeout_s)
    except vc.CandidateRejected as exc:
        print("FAIL")
        for p in exc.problems:
            print("  - " + p)
        return EX_FAIL
    if not res.users_checked and not cfg.allow_unchecked_users:
        print("FAIL")
        print("  - " + USERS_UNCHECKED_MESSAGE)
        return EX_FAIL
    print("OK radicale %s, %d probes, users %s" % (
        res.radicale_version, res.probes,
        "compared" if res.users_checked else "parsed only"))
    return EX_OK


def cmd_reset_password(store: Store, cfg: config_mod.Config, args) -> int:
    password = passwords.generate_password()
    pw_hash = passwords.hash_password(password, cfg.bcrypt_cost)
    now = store.now()
    try:
        applied = store.apply(
            lambda old: model_mod.set_password_hash(
                old, args.login, hash=pw_hash, now=now, by="cli"),
            actor=None, probe=not args.no_probe)
    except ApiError as exc:
        return _fail(exc)
    store.audit.log("cli.reset-password", actor="cli", target=args.login,
                    generation=applied.new.generation)
    print("login: %s" % args.login)
    print("new password (shown once): %s" % password)
    return EX_OK


def _print_restore_report(report: dict) -> None:
    if not report.get("currentModel", True):
        print("  no current model: the stored generation is used as it is")
        return
    for login in report["accountsDropped"]:
        print("  dropped (deleted since, stays deleted): %s" % login)
    for login in report["accountsRemoved"]:
        print("  removed (created after that generation): %s" % login)
    for g in report["grantsAdded"]:
        print("  grant added:   %s/%s -> %s (%s)" % (
            g["owner"], g["collection"], g["grantee"], g["level"]))
    for g in report["grantsRemoved"]:
        print("  grant removed: %s/%s -> %s (%s)" % (
            g["owner"], g["collection"], g["grantee"], g["level"]))
    for f in report["flagsChanged"]:
        print("  %s of %s: %s -> %s" % (f["field"], f["login"], f["before"],
                                        f["after"]))
    print("  passwords, disabled accounts and tombstones stay as they are now")


def cmd_restore(store: Store, cfg: config_mod.Config, args) -> int:
    wanted = "restore-%d" % args.generation
    if not args.dry_run and args.confirm != wanted:
        print("error: restoring changes who has access; review with "
              "--dry-run, then repeat with --confirm %s" % wanted,
              file=sys.stderr)
        return EX_USAGE
    try:
        applied = store.restore(args.generation, None, dry_run=args.dry_run,
                                probe=not args.no_probe,
                                intent=filewrite.make_intent(
                                    "cli.restore", "cli",
                                    "generation %d" % args.generation))
    except ApiError as exc:
        return _fail(exc)
    report = (applied.plan or {}).get("restore", {})
    if args.dry_run:
        print("dry run: generation %d would become generation %d"
              % (args.generation, applied.new.generation))
        _print_restore_report(report)
        return EX_OK
    store.audit.log("cli.restore", actor="cli",
                    target="generation %d" % args.generation,
                    generation=applied.new.generation)
    print("generation %d restored as generation %d (%s)" % (
        args.generation, applied.new.generation,
        "active" if applied.active else "activation pending"))
    _print_restore_report(report)
    return EX_OK


def cmd_show(store: Store, cfg: config_mod.Config, args) -> int:
    try:
        m = store.load_model()
    except ApiError as exc:
        print("model: not usable (%s)" % exc.reason)
        print("generations on disk: %s" % (store.generation_numbers() or "none"))
        return EX_MODEL
    print("generation %d, %d accounts, %d grants, %d tombstones"
          % (m.generation, len(m.accounts), len(m.grants), len(m.tombstones)))
    for k, a in m.accounts.items():
        flags = [a.type] + (["admin"] if a.admin else []) \
            + (["disabled"] if a.disabled else []) \
            + ([] if a.own_space else ["no-own-space"])
        print("  account %-32s %s  (%s)" % (k, ", ".join(flags),
                                            a.display_name))
    for g in m.grants:
        print("  grant   %s/%s -> %s (%s)" % (g.owner, g.collection,
                                               g.grantee, g.level))
    for k in m.tombstones:
        print("  deleted %s" % k)
    print("generations on disk: %s" % ", ".join(
        str(n) for n in store.generation_numbers()))
    return EX_OK


def _dav(cfg: config_mod.Config, method: str, path: str, login: str,
         password: str, body: Optional[str] = None, depth: str = "0") -> int:
    https, host, port = cfg.radicale_parts
    cls = http.client.HTTPSConnection if https else http.client.HTTPConnection
    conn = cls(host, port, timeout=cfg.radicale_timeout_s)
    token = base64.b64encode(("%s:%s" % (login, password)).encode()).decode()
    headers = {"Authorization": "Basic " + token, "Depth": depth}
    if body:
        headers["Content-Type"] = "application/xml; charset=utf-8"
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        resp.read()
        return resp.status
    except (OSError, http.client.HTTPException):
        return 0
    finally:
        conn.close()


_MKCAL = ('<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" '
          'xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>'
          '<D:displayname>smoke</D:displayname></D:prop></D:set>'
          '</C:mkcalendar>')


def cmd_smoke(store: Store, cfg: config_mod.Config, args) -> int:
    try:
        cfg = dataclasses.replace(
            cfg, radicale_url=config_mod._radicale_url(args.radicale_url))
    except config_mod.ConfigError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EX_USAGE
    store.cfg = cfg
    store.prober._cfg = cfg
    try:
        model = store.load_model()
    except ApiError as exc:
        return _fail(exc)
    admin = model.accounts.get(args.admin_login)
    if admin is None or not admin.admin or admin.disabled:
        print("error: %s is not an enabled admin" % args.admin_login,
              file=sys.stderr)
        return EX_REFUSED
    admin_pw = os.environ.get(ENV_SMOKE_PASSWORD, "")
    login = "smoke-" + secrets.token_hex(3)
    password = passwords.generate_password()
    pw_hash = passwords.hash_password(password, cfg.bcrypt_cost)
    now = store.now()
    results: List[tuple] = []

    def check(name: str, got: object, want: object) -> None:
        ok = got == want
        results.append((name, ok))
        print("%s %s (got %s, want %s)" % ("PASS" if ok else "FAIL", name, got,
                                           want))

    created = deleted = False
    try:
        applied = store.apply(lambda old: model_mod.create_account(
            old, login=login, display_name="Smoke test", type="bot",
            hash=pw_hash, now=now, by="cli",
            extra_reserved=cfg.extra_reserved_logins), actor=None)
        created = True
        check("temporary account active", applied.active, True)
        check("root readable", _dav(cfg, "PROPFIND", "/", login, password), 207)
        check("own principal", _dav(cfg, "PROPFIND", "/%s/" % login, login,
                                    password), 207)
        check("other principal denied", _dav(
            cfg, "PROPFIND", "/%s/" % args.admin_login, login, password), 403)
        check("MKCALENDAR in own space", _dav(
            cfg, "MKCALENDAR", "/%s/smoke-cal/" % login, login, password,
            _MKCAL), 201)
        check("DELETE own calendar", _dav(
            cfg, "DELETE", "/%s/smoke-cal/" % login, login, password), 200)
        if admin_pw:
            check("admin sees the principal", _dav(
                cfg, "PROPFIND", "/%s/" % login, args.admin_login, admin_pw),
                207)
        else:
            print("SKIP admin check (%s not set)" % ENV_SMOKE_PASSWORD)
        now2 = store.now()
        applied = store.apply(lambda old: model_mod.delete_account(
            old, login, now=now2, by="cli"), actor=None)
        deleted = True
        check("deleted account active", applied.active, True)
        check("deleted login rejected", _dav(cfg, "PROPFIND", "/", login,
                                             password), 401)
    except ApiError as exc:
        results.append(("lifecycle", False))
        print("FAIL lifecycle: %s (%s)" % (exc.message, exc.code))
    finally:
        if created and not deleted:
            try:
                now3 = store.now()
                store.apply(lambda old: model_mod.delete_account(
                    old, login, now=now3, by="cli"), actor=None)
            except ApiError as exc:
                print("WARNING: could not delete %s: %s" % (login, exc.code))
    print("note: the empty principal directory '%s' stays in the storage "
          "(nobody may delete a principal over DAV); remove it from the "
          "collections folder as the Radicale user if wanted. The login is "
          "tombstoned." % login)
    return EX_OK if results and all(ok for _, ok in results) else EX_FAIL


# -- entry point ------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="radui-admin-cli", description="RadUI admin backend, local "
        "administration (exit codes: see docs/admin-cli.md)")
    ap.add_argument("--config", help="configuration file (default: "
                    "$RADUI_CONFIG or %s)" % config_mod.DEFAULT_CONFIG_PATH)
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("import", help="import legacy users + rights files")
    p.add_argument("--admin", action="append", required=True,
                   help="login to import as admin (repeatable)")
    p.add_argument("--users", default=LEGACY_USERS)
    p.add_argument("--rights", default=LEGACY_RIGHTS)
    p.add_argument("--collections", help="JSON file {owner: [collection...]} "
                   "for legacy wildcard rules")
    p.add_argument("--report", help="write the full equivalence report here")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_import)
    p = sub.add_parser("check-radicale", help="validate the managed files "
                       "with Radicale's own parsers")
    p.set_defaults(func=cmd_check)
    p = sub.add_parser("reset-password", help="set a new generated password")
    p.add_argument("login")
    p.add_argument("--no-probe", action="store_true")
    p.set_defaults(func=cmd_reset_password)
    p = sub.add_parser("restore", help="make a stored generation current")
    p.add_argument("--generation", type=int, required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--confirm", help="restore-<N> (required unless --dry-run)")
    p.add_argument("--no-probe", action="store_true")
    p.set_defaults(func=cmd_restore)
    p = sub.add_parser("show", help="accounts and grants (no hashes)")
    p.set_defaults(func=cmd_show)
    p = sub.add_parser("smoke", help="temporary account lifecycle check")
    p.add_argument("--radicale-url", required=True)
    p.add_argument("--admin-login", required=True)
    p.set_defaults(func=cmd_smoke)
    return ap


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        cfg = config_mod.load(args.config)
        store = Store(cfg, audit=Audit(stream=sys.stderr))
    except (config_mod.ConfigError, ValueError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EX_USAGE
    try:
        return args.func(store, cfg, args)
    except ApiError as exc:
        return _fail(exc)
