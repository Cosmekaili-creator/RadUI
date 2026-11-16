# SPDX-License-Identifier: AGPL-3.0-or-later
"""Request handling: routing, per-request checks, endpoints (see docs/api.md).

:meth:`Api.dispatch` takes a parsed request and returns a :class:`Response`;
it never raises and never touches a socket, so the whole API is testable
without HTTP. ``server.py`` adds the socket-level rules (body size, chunked
encoding, timeouts).

Order of checks for every request: ``Host`` / ``Origin`` / ``Sec-Fetch-Site``,
route, abuse limits (per-IP block and request rate), for mutations the
``X-RadUI`` and ``Content-Type`` headers, authentication (credentials
forwarded to Radicale), the account record (exists, not disabled), admin
rights, the JSON body, then the endpoint.
"""
import json
import re
import traceback
from typing import (Any, Callable, Dict, List, Mapping, NamedTuple, Optional,
                    Sequence, Tuple)
from urllib.parse import parse_qs, urlsplit

from . import authn, names, passwords, plan
from . import expected as exp
from . import model as model_mod
from .audit import Audit
from .authn import RadicaleClient
from .config import Config
from . import filewrite
from .filewrite import Store
from .model import Account, Model
from .names import ApiError
from .ratelimit import FailureLimiter, RequestRate

MUTATING = frozenset(("POST", "PUT", "PATCH", "DELETE"))
MAX_STRING = 128
MAX_DEPTH = 4
#: Placeholder written into a dry-run candidate (never stored, never real).
DRY_HASH = "$2b$12$" + "." * 53


class Response(NamedTuple):
    status: int
    body: Any
    headers: Dict[str, str] = {}


class Request(NamedTuple):
    method: str
    target: str                    # raw request target (path and query)
    headers: Mapping[str, str]     # lower-case names
    body: bytes
    peer: str


class Ctx:
    """Per-request state shared by the handlers."""

    def __init__(self, ip: str) -> None:
        self.ip = ip
        self.actor: Optional[str] = None
        self.auth = ""
        self.event: Optional[str] = None
        self.target: Optional[str] = None
        self.generation: Optional[int] = None
        self.query: Dict[str, List[str]] = {}


def error_response(err: ApiError) -> Response:
    headers: Dict[str, str] = {}
    retry = getattr(err, "retry_after", None)
    if retry:
        headers["Retry-After"] = str(retry)
    return Response(err.status, err.as_dict(), headers)


def _err(status: int, code: str, message: str) -> Response:
    return Response(status, {"error": {"code": code, "message": message}})


# -- request body ---------------------------------------------------------------

def _no_duplicates(pairs: List[Tuple[str, Any]]) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out


def _reject(_: str) -> Any:
    raise ValueError("number or constant not allowed")


def _check_shape(value: Any, depth: int) -> None:
    if depth > MAX_DEPTH:
        raise ValueError("nested too deep")
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            raise ValueError("string too long")
        value.encode("utf-8")  # lone surrogates raise UnicodeEncodeError
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_shape(k, depth + 1)
            _check_shape(v, depth + 1)
    elif isinstance(value, list):
        for v in value:
            _check_shape(v, depth + 1)
    elif isinstance(value, float):
        raise ValueError("floats not allowed")


def parse_json_object(raw: bytes) -> Dict[str, Any]:
    """Body of a mutating request: a JSON object (empty body = ``{}``).
    Depth <= 4, strings <= 128 characters, no duplicate keys, no floats."""
    if not raw.strip():
        return {}
    try:
        obj = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicates,
                         parse_constant=_reject, parse_float=_reject)
        _check_shape(obj, 1)
    except (ValueError, RecursionError):
        raise ApiError("bad_request", "request body is not acceptable JSON",
                       reason="bad_json") from None
    if not isinstance(obj, dict):
        raise ApiError("bad_request", "request body must be a JSON object",
                       reason="not_an_object")
    return obj


def _only_keys(body: Mapping[str, Any], allowed: Sequence[str],
               required: Sequence[str] = ()) -> None:
    for key in body:
        if key not in allowed:
            raise names.validation_error(key, "unknown_field",
                                         "unknown field %r" % key)
    for key in required:
        if key not in body:
            raise names.validation_error(key, "required",
                                         "%s is required" % key)


def _account_view(login: str, a: Account) -> Dict[str, Any]:
    return {"login": login, "displayName": a.display_name, "type": a.type,
            "admin": a.admin, "disabled": a.disabled, "ownSpace": a.own_space,
            "created": a.created, "passwordChanged": a.password_changed}


def _grant_view(g: model_mod.Grant) -> Dict[str, Any]:
    return {"owner": g.owner, "collection": g.collection,
            "grantee": g.grantee, "level": g.level, "grantedBy": g.by,
            "created": g.created}


def _confirm(body: Mapping[str, Any], login: str) -> None:
    if body.get("confirm") != login:
        raise names.validation_error(
            "confirm", "confirm_required",
            "type the login %r in confirm to proceed" % login)


Handler = Callable[["Api", Ctx, Model, Mapping[str, str], Mapping[str, Any],
                    bool], Tuple[int, Any]]


class Route(NamedTuple):
    method: str
    pattern: "re.Pattern[str]"
    handler: str
    admin: bool          # admin only
    public: bool = False  # no authentication


class Api:
    def __init__(self, cfg: Config, store: Store, dav: RadicaleClient,
                 limiter: FailureLimiter, rate: RequestRate, audit: Audit,
                 diag: Optional[Callable[[str], None]] = None) -> None:
        self.cfg = cfg
        self.store = store
        self.dav = dav
        self.limiter = limiter
        self.rate = rate
        self.audit = audit
        self._diag = diag or (lambda msg: None)
        self._hosts = frozenset(cfg.allowed_hosts)
        self._origins = frozenset(cfg.effective_origins)
        self._trusted = cfg.trusted_networks
        r = re.compile
        L = r"(?P<login>[^/]+)"
        self.routes: List[Route] = [
            Route("GET", r("health"), "h_health", False, True),
            Route("GET", r("me"), "h_me", False),
            Route("GET", r("me/access"), "h_me_access", False),
            Route("GET", r("directory"), "h_directory", True),
            Route("GET", r("accounts"), "h_accounts", True),
            Route("POST", r("accounts"), "h_account_create", True),
            Route("GET", r("accounts/" + L), "h_account", True),
            Route("PATCH", r("accounts/" + L), "h_account_patch", True),
            Route("DELETE", r("accounts/" + L), "h_account_delete", True),
            Route("POST", r("accounts/" + L + "/password"), "h_password",
                  True),
            Route("GET", r("grants"), "h_grants", False),
            Route("PUT", r("grants"), "h_grant_put", False),
            Route("GET", r("effective/" + L), "h_effective", True),
            Route("GET", r("generations"), "h_generations", True),
            Route("POST", r("generations/(?P<n>[0-9]{1,10})/restore"),
                  "h_restore", True),
        ]

    # -- dispatch -------------------------------------------------------------
    def dispatch(self, req: Request) -> Response:
        ip = authn.client_ip(req.headers, req.peer,
                             self.cfg.trusted_proxy_header, self._trusted)
        ctx = Ctx(ip)
        try:
            resp = self._dispatch(req, ctx)
            result = "ok" if resp.status < 400 else "error:%s" % (
                resp.body.get("error", {}).get("code", resp.status)
                if isinstance(resp.body, dict) else resp.status)
        except ApiError as exc:
            resp = error_response(exc)
            result = "error:%s" % exc.code
            detail = getattr(exc, "detail", None)
            if detail:
                self._diag("%s: %s" % (exc.reason, "; ".join(detail)))
        except Exception:  # noqa: BLE001 - last line of defence
            self._diag(traceback.format_exc())
            resp = _err(500, "internal", "internal error")
            result = "error:internal"
        if ctx.event:
            self.audit.log(ctx.event, actor=ctx.actor, ip=ip,
                           target=ctx.target, result=result,
                           generation=ctx.generation)
        return resp

    def _reject(self, ctx: Ctx, status: int, code: str, message: str,
                reason: str) -> Response:
        self.audit.log("request.rejected", ip=ctx.ip, result=reason)
        return _err(status, code, message)

    def _dispatch(self, req: Request, ctx: Ctx) -> Response:
        h = req.headers
        host = h.get("host", "").lower()
        if host not in self._hosts:
            return self._reject(ctx, 403, "forbidden", "host not allowed",
                                "bad_host")
        origin = h.get("origin")
        if origin is not None and origin.lower() not in self._origins:
            return self._reject(ctx, 403, "forbidden", "origin not allowed",
                                "bad_origin")
        fetch_site = h.get("sec-fetch-site")
        if fetch_site is not None and fetch_site.lower() not in (
                "same-origin", "none"):
            return self._reject(ctx, 403, "forbidden",
                                "cross-site request refused",
                                "bad_fetch_site")
        parts = urlsplit(req.target)
        if parts.scheme or parts.netloc or not parts.path.startswith("/") \
                or parts.fragment:
            return _err(400, "bad_request", "bad request target")
        if not parts.path.startswith(self.cfg.api_prefix):
            return _err(404, "not_found", "no such endpoint")
        rest = parts.path[len(self.cfg.api_prefix):]
        route, groups, allowed = self._match(req.method, rest)
        if route is None:
            if allowed:
                resp = _err(405, "bad_request", "method not allowed")
                return Response(405, resp.body,
                                {"Allow": ", ".join(sorted(allowed))})
            return _err(404, "not_found", "no such endpoint")
        try:
            query = parse_qs(parts.query, keep_blank_values=True,
                             strict_parsing=bool(parts.query),
                             max_num_fields=8)
        except ValueError:
            return _err(400, "bad_request", "bad query string")
        ctx.query = query
        mutating = req.method in MUTATING
        dry_run = False
        if "dryRun" in query:
            if not mutating or query["dryRun"] != ["1"]:
                return _err(400, "bad_request", "dryRun must be 1 and is "
                            "only for mutating requests")
            dry_run = True
        if route.public:
            return Response(200, self.store.health())
        self.rate.check(ctx.ip)
        self.limiter.check(ctx.ip)
        if mutating:
            if h.get("x-radui") != "1":
                raise ApiError("missing_header", "X-RadUI: 1 is required",
                               reason="x_radui")
            ctype = h.get("content-type", "")
            media, _, params = ctype.partition(";")
            if media.strip().lower() != "application/json" or (
                    params.strip() and params.replace(" ", "").lower()
                    not in ("charset=utf-8", 'charset="utf-8"')):
                raise ApiError("unsupported_media_type",
                               "Content-Type must be application/json",
                               reason="content_type")
        login, auth_header = self._authenticate(h, ctx)
        ctx.actor = login
        ctx.auth = auth_header
        model = self.store.current_model()
        acct = model.accounts.get(login)
        if acct is None or acct.disabled:
            ctx.event = "auth.denied"
            raise ApiError("forbidden", "this account may not use RadUI",
                           reason="no_account")
        if route.admin and not acct.admin:
            ctx.event = "auth.denied"
            ctx.target = req.method + " " + rest.split("/")[0]
            raise ApiError("forbidden", "administrator access required",
                           reason="not_admin")
        body: Dict[str, Any] = parse_json_object(req.body) if mutating else {}
        handler: Handler = getattr(Api, route.handler)
        status, payload = handler(self, ctx, model, groups, body, dry_run)
        return Response(status, payload)

    def _match(self, method: str, rest: str
               ) -> Tuple[Optional[Route], Mapping[str, str], List[str]]:
        allowed: List[str] = []
        for route in self.routes:
            m = route.pattern.fullmatch(rest)
            if m is None:
                continue
            if route.method == method:
                return route, m.groupdict(), []
            allowed.append(route.method)
        return None, {}, allowed

    def _authenticate(self, headers: Mapping[str, str], ctx: Ctx
                      ) -> Tuple[str, str]:
        header = headers.get("authorization")
        login, _password = authn.parse_basic(header)
        assert header is not None
        if not self.dav.authenticate(header, ctx.ip):
            blocked = self.limiter.record_failure(ctx.ip)
            self.audit.log("auth.failed", actor=login, ip=ctx.ip,
                           result="blocked" if blocked else "unauthenticated")
            raise ApiError("unauthenticated", "invalid credentials",
                           reason="bad_credentials")
        return login, header

    # -- helpers --------------------------------------------------------------
    def _mutate(self, ctx: Ctx, event: str, target: str,
                op: Callable[[Model], Model], *, dry_run: bool, summary: str,
                extra: Optional[Callable[[Model], Dict[str, Any]]] = None,
                ok_status: int = 200, extra_dry: Optional[Dict[str, Any]] = None
                ) -> Tuple[int, Any]:
        ctx.event = event + (".dryrun" if dry_run else "")
        ctx.target = target
        applied = self.store.apply(op, actor=ctx.actor, dry_run=dry_run,
                                   intent=self._intent(ctx))
        ctx.generation = (applied.old.generation if dry_run and applied.old
                          else applied.new.generation)
        if dry_run:
            body = {"dryRun": True, "summary": summary, "noop": applied.noop,
                    "generation": applied.old.generation if applied.old
                    else None}
            body.update(applied.plan or {
                "rights": {"added": [], "removed": []}, "effective": [],
                "effectiveTruncated": False})
            body.update(extra_dry or {})
            return 200, body
        body = {"generation": applied.new.generation, "active": applied.active}
        if extra is not None:
            body.update(extra(applied.new))
        if not applied.active:
            body["warning"] = "activation_pending"
            return 202, body
        return ok_status, body

    @staticmethod
    def _intent(ctx: Ctx) -> dict:
        return filewrite.make_intent(ctx.event, ctx.actor, ctx.target, ctx.ip)

    def _password(self, body: Mapping[str, Any], login: str, dry_run: bool
                  ) -> Tuple[str, Optional[str]]:
        """``(hash, generated_plaintext_or_None)`` for a body with either
        ``password`` or ``generate: true``."""
        has_pw, has_gen = "password" in body, "generate" in body
        if has_pw and has_gen:
            raise names.validation_error(
                "password", "ambiguous",
                "give either password or generate, not both")
        generated: Optional[str] = None
        if has_pw:
            password = passwords.validate_password(body["password"], login)
        elif has_gen:
            if body["generate"] is not True:
                raise names.validation_error("generate", "must_be_true")
            password = passwords.generate_password()
            generated = password
        else:
            raise names.validation_error("password", "required",
                                         "give password or generate: true")
        if dry_run:
            return DRY_HASH, None
        return passwords.hash_password(password, self.cfg.bcrypt_cost), \
            generated

    def _login_arg(self, groups: Mapping[str, str], model: Model) -> str:
        login = groups["login"]
        if not names.is_valid_login(login) or login not in model.accounts:
            raise ApiError("not_found", "no such account", field="login",
                           reason="no_such_account")
        return login

    # -- endpoints --------------------------------------------------------------
    def h_health(self, ctx, model, groups, body, dry_run):  # pragma: no cover
        return 200, self.store.health()

    def h_me(self, ctx, model, groups, body, dry_run):
        a = model.accounts[ctx.actor]
        health = self.store.health()      # same data as GET health
        return 200, {"login": ctx.actor, "displayName": a.display_name,
                     "type": a.type, "admin": a.admin, "ownSpace": a.own_space,
                     "generation": model.generation,
                     "rightsActive": bool(health["active"]),
                     "ok": bool(health["ok"])}

    def h_me_access(self, ctx, model, groups, body, dry_run):
        a = model.accounts[ctx.actor]
        out: Dict[str, Any] = {
            "login": ctx.actor, "admin": a.admin, "ownSpace": a.own_space,
            "grants": [{"href": "/%s/%s/" % (g.owner, g.collection),
                        "owner": g.owner, "collection": g.collection,
                        "level": g.level, "grantedBy": g.by,
                        "created": g.created}
                       for g in model.grants if g.grantee == ctx.actor]}
        if a.admin:
            out["principals"] = model.enabled()
        return 200, out

    def h_directory(self, ctx, model, groups, body, dry_run):
        return 200, [{"login": k, "displayName": a.display_name,
                      "type": a.type}
                     for k, a in model.accounts.items() if not a.disabled]

    def h_accounts(self, ctx, model, groups, body, dry_run):
        return 200, [_account_view(k, a) for k, a in model.accounts.items()]

    def h_account(self, ctx, model, groups, body, dry_run):
        login = self._login_arg(groups, model)
        return 200, _account_view(login, model.accounts[login])

    def h_account_create(self, ctx, model, groups, body, dry_run):
        _only_keys(body, ("login", "displayName", "type", "admin", "ownSpace",
                          "password", "generate"), ("login", "displayName"))
        login = names.validate_login(
            body["login"], tombstoned=model.tombstones,
            extra_reserved=self.cfg.extra_reserved_logins)
        if login in model.accounts:
            raise ApiError("exists", "login already exists", field="login",
                           reason="exists")
        pw_hash, generated = self._password(body, login, dry_run)
        now = self.store.now()
        actor = ctx.actor
        limit = self.cfg.max_accounts

        def op(old: Model) -> Model:
            if len(old.accounts) >= limit:
                raise names.validation_error(
                    "accounts", "limit_reached",
                    "at most %d accounts" % limit)
            return model_mod.create_account(
                old, login=login, display_name=body["displayName"],
                type=body.get("type", "person"),
                admin=body.get("admin", False),
                own_space=body.get("ownSpace", True), hash=pw_hash, now=now,
                by=actor, extra_reserved=self.cfg.extra_reserved_logins)

        def extra(new: Model) -> Dict[str, Any]:
            out: Dict[str, Any] = {
                "account": _account_view(login, new.accounts[login])}
            if generated is not None:
                out["password"] = generated
            return out

        return self._mutate(
            ctx, "account.create", login, op, dry_run=dry_run,
            summary="Create account %s (%s%s)" % (
                login, body.get("type", "person"),
                ", admin" if body.get("admin") is True else ""),
            extra=extra, ok_status=201)

    def h_account_patch(self, ctx, model, groups, body, dry_run):
        login = self._login_arg(groups, model)
        fields = ("displayName", "type", "admin", "ownSpace", "disabled")
        _only_keys(body, fields + ("confirm",))
        if not any(k in body for k in fields):
            raise names.validation_error("body", "no_changes",
                                         "no field to change")
        confirm_needed = False
        acct = model.accounts[login]
        if body.get("ownSpace") is False and acct.own_space:
            owned = self.dav.count_collections(ctx.auth, ctx.ip, login)
            if owned > 0:
                confirm_needed = True
                if not dry_run:
                    _confirm(body, login)
        kwargs: Dict[str, Any] = {}
        for key, arg in (("displayName", "display_name"), ("type", "type"),
                         ("admin", "admin"), ("ownSpace", "own_space"),
                         ("disabled", "disabled")):
            if key in body:
                kwargs[arg] = body[key]
        now, actor = self.store.now(), ctx.actor

        def op(old: Model) -> Model:
            return model_mod.patch_account(old, login, now=now, by=actor,
                                           **kwargs)

        def extra(new: Model) -> Dict[str, Any]:
            return {"account": _account_view(login, new.accounts[login])}

        changed = ", ".join(sorted(k for k in fields if k in body))
        return self._mutate(
            ctx, "account.update", login, op, dry_run=dry_run,
            summary="Change %s of account %s" % (changed, login),
            extra=extra, extra_dry={"confirmRequired": confirm_needed})

    def h_password(self, ctx, model, groups, body, dry_run):
        login = self._login_arg(groups, model)
        _only_keys(body, ("password", "generate"))
        pw_hash, generated = self._password(body, login, dry_run)
        now, actor = self.store.now(), ctx.actor

        def op(old: Model) -> Model:
            return model_mod.set_password_hash(old, login, hash=pw_hash,
                                               now=now, by=actor)

        def extra(new: Model) -> Dict[str, Any]:
            return {"password": generated} if generated is not None else {}

        return self._mutate(ctx, "account.password", login, op,
                            dry_run=dry_run,
                            summary="Reset the password of %s" % login,
                            extra=extra)

    def h_account_delete(self, ctx, model, groups, body, dry_run):
        login = self._login_arg(groups, model)
        _only_keys(body, ("confirm",), ("confirm",))
        _confirm(body, login)
        now, actor = self.store.now(), ctx.actor

        def op(old: Model) -> Model:
            return model_mod.delete_account(old, login, now=now, by=actor)

        return self._mutate(
            ctx, "account.delete", login, op, dry_run=dry_run,
            summary="Delete account %s (login reserved for good, data left "
                    "in place)" % login,
            extra=lambda new: {"deleted": login})

    def h_grants(self, ctx, model, groups, body, dry_run):
        for key in ctx.query:
            if key not in ("owner", "grantee"):
                raise ApiError("bad_request", "unknown query parameter",
                               field=key, reason="unknown_param")
        vals = {}
        for key in ("owner", "grantee"):
            got = ctx.query.get(key)
            if got is not None:
                if len(got) != 1 or not names.is_valid_login(got[0]):
                    raise names.validation_error(key, "pattern")
                vals[key] = got[0]
        if not model.accounts[ctx.actor].admin:
            owner = vals.get("owner", ctx.actor)
            if owner != ctx.actor:
                ctx.event = "auth.denied"
                ctx.target = "grants of " + owner
                raise ApiError("forbidden", "you may list only your own "
                               "collections", reason="not_owner")
            vals["owner"] = owner
        return 200, [_grant_view(g) for g in model.grants
                     if all(getattr(g, k) == v for k, v in vals.items())]

    def h_grant_put(self, ctx, model, groups, body, dry_run):
        _only_keys(body, ("owner", "collection", "grantee", "level"),
                   ("owner", "collection", "grantee", "level"))
        owner, collection = body["owner"], body["collection"]
        grantee, level = body["grantee"], body["level"]
        for field, value in (("owner", owner), ("grantee", grantee)):
            if not names.is_valid_login(value):
                raise names.validation_error(field, "pattern")
        names.validate_collection_name(collection)
        if level not in model_mod.PUT_LEVELS:
            raise names.validation_error("level", "bad_level")
        a = model.accounts[ctx.actor]
        if ctx.actor != owner and not a.admin:
            ctx.event = "auth.denied"
            ctx.target = "grant %s/%s" % (owner, collection)
            raise ApiError("forbidden", "only the owner or an administrator "
                           "may change who has access", reason="not_owner")
        if owner not in model.accounts:
            raise ApiError("not_found", "no such account", field="owner",
                           reason="no_such_account")
        if not a.admin:
            # No account directory for owners: an unknown, a disabled and an
            # admin grantee (and, for "none", a grantee without a grant) all
            # give the same answer, so nothing can be probed through this call.
            grantee_acct = model.accounts.get(grantee)
            usable = grantee_acct is not None and not grantee_acct.disabled \
                and not grantee_acct.admin
            if level == "none":
                usable = model.find_grant(owner, collection, grantee) \
                    is not None
            if not usable:
                raise names.validation_error(
                    "grantee", "grantee_unavailable",
                    "the grantee is not available")
        elif grantee not in model.accounts:
            raise ApiError("not_found", "no such account", field="grantee",
                           reason="no_such_account")
        if level != "none":
            if model.accounts[grantee].disabled:
                raise names.validation_error("grantee", "grantee_disabled",
                                             "the grantee is disabled")
            kind = self.dav.collection_kind(ctx.auth, ctx.ip, owner,
                                            collection)
            if kind is None:
                raise ApiError("collection_not_found",
                               "no such collection", field="collection",
                               reason="no_such_collection")
            if kind not in ("calendar", "addressbook"):
                raise names.validation_error(
                    "collection", "not_calendar_or_addressbook",
                    "only calendars and address books can be shared")
        now, actor = self.store.now(), ctx.actor
        limit = self.cfg.max_grants

        def op(old: Model) -> Model:
            if level != "none" and old.find_grant(owner, collection,
                                                  grantee) is None \
                    and len(old.grants) >= limit:
                raise names.validation_error(
                    "grants", "limit_reached", "at most %d grants" % limit)
            return model_mod.put_grant(old, owner=owner, collection=collection,
                                       grantee=grantee, level=level, now=now,
                                       by=actor)

        def extra(new: Model) -> Dict[str, Any]:
            g = new.find_grant(owner, collection, grantee)
            return {"grant": _grant_view(g) if g else None}

        verb = {"none": "Remove access of %s to" % grantee,
                "read": "Give %s read access to" % grantee,
                "readwrite": "Give %s read and write access to" % grantee}
        return self._mutate(
            ctx, "grant.put", "%s/%s -> %s (%s)" % (owner, collection,
                                                    grantee, level),
            op, dry_run=dry_run,
            summary="%s %s/%s" % (verb[level], owner, collection),
            extra=extra)

    def h_effective(self, ctx, model, groups, body, dry_run):
        login = self._login_arg(groups, model)
        acct = model.accounts[login]
        paths = ["", login, login + "/*"]
        if acct.admin:
            paths += [k for k in model.accounts if k != login]
            paths += [k + "/*" for k in model.accounts if k != login]
            paths += ["radui-probe-top"]
        paths += ["%s/%s" % (g.owner, g.collection) for g in model.grants
                  if g.grantee == login]
        seen: set = set()
        paths = [p for p in paths if not (p in seen or seen.add(p))]
        real = [p[:-1] + plan.SYNTHETIC if p.endswith("/*") else p
                for p in paths]
        pairs = [(login, p) for p in real]
        got = self.store.match_disk(model, pairs)
        out = []
        for path, rpath, letters in zip(paths, real, got):
            level = exp.expected(model, login, rpath)
            want = exp.letters(level)
            if frozenset(letters) != frozenset(want):
                raise ApiError("internal", "managed files disagree with the "
                               "model", reason="effective_mismatch")
            out.append({"path": "/" + path if path else "/", "level": level,
                        "letters": want})
        return 200, out

    def h_generations(self, ctx, model, groups, body, dry_run):
        return 200, self.store.list_generations()

    def h_restore(self, ctx, model, groups, body, dry_run):
        _only_keys(body, ("confirm",))
        n = int(groups["n"])
        if n not in self.store.generation_numbers():
            raise ApiError("not_found", "no such generation",
                           field="generation", reason="no_such_generation")
        if not dry_run and body.get("confirm") != "restore-%d" % n:
            raise names.validation_error(
                "confirm", "confirm_required",
                "type restore-%d in confirm to proceed" % n)
        ctx.event = "generation.restore" + (".dryrun" if dry_run else "")
        ctx.target = "generation %d" % n
        applied = self.store.restore(n, ctx.actor, dry_run=dry_run,
                                     intent=self._intent(ctx))
        ctx.generation = (applied.old.generation if dry_run and applied.old
                          else applied.new.generation)
        report = (applied.plan or {}).get("restore", {})
        if dry_run:
            return 200, dict({"dryRun": True, "noop": False,
                              "summary": "Restore generation %d as a new "
                                         "generation (tombstones, current "
                                         "passwords and disabled accounts "
                                         "stay as they are)" % n,
                              "generation": model.generation,
                              "confirm": "restore-%d" % n},
                             **(applied.plan or {}))
        out = {"generation": applied.new.generation, "active": applied.active,
               "restoredFrom": n, "restore": report}
        if not applied.active:
            out["warning"] = "activation_pending"
            return 202, out
        return 200, out
