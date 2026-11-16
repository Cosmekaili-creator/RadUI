# SPDX-License-Identifier: AGPL-3.0-or-later
"""The RadUI account/grant model, schema version 1 (pure, no file I/O).

The model is the single source of truth: the Radicale ``users`` and ``rights``
files are generated from it. Functions here take and return strings or
immutable :class:`Model` objects; every operation returns a NEW model (or the
same object when nothing changed) and bumps ``generation`` / ``genToken``.

JSON layout (strict: unknown or missing keys are rejected)::

    {"schema": 1, "generation": N, "genToken": "<32 hex>", "bcryptCost": 12,
     "accounts": {"<login>": {"displayName", "type", "admin", "disabled",
                              "ownSpace", "created", "passwordChanged", "hash"}},
     "grants": [{"owner", "collection", "grantee", "level", "created", "by"}],
     "tombstones": {"<login>": {"deleted", "by"}}}

Lockout rules (last admin, acting admin) are NOT enforced here; see
``lockout.py``. The structural invariant "a bot is never an admin" is.
"""
import dataclasses
import datetime
import json
import secrets
from types import MappingProxyType
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from . import names
from .names import ApiError, validation_error

SCHEMA = 1
MAX_ACCOUNTS = 200
MAX_GRANTS = 2000
MAX_TOMBSTONES = 5000
MAX_MODEL_BYTES = 4 * 1024 * 1024
MAX_JSON_DEPTH = 4
MAX_STRING = 128
BCRYPT_COST_RANGE = (4, 16)
ACCOUNT_TYPES = ("person", "bot")
LEVELS = ("read", "readwrite")
#: Accepted by ``put_grant``; "none" removes the grant.
PUT_LEVELS = ("none",) + LEVELS

UNSET: Any = object()  # sentinel: "argument not given" for patch operations


@dataclasses.dataclass(frozen=True)
class Account:
    display_name: str
    type: str
    admin: bool
    disabled: bool
    own_space: bool
    created: str
    password_changed: str
    hash: str


@dataclasses.dataclass(frozen=True)
class Grant:
    owner: str
    collection: str
    grantee: str
    level: str
    created: str
    by: str

    @property
    def key(self) -> Tuple[str, str, str]:
        return (self.owner, self.collection, self.grantee)


@dataclasses.dataclass(frozen=True)
class Tombstone:
    deleted: str
    by: str


@dataclasses.dataclass(frozen=True)
class Model:
    generation: int
    gen_token: str
    bcrypt_cost: int
    accounts: Mapping[str, Account]
    grants: Tuple[Grant, ...]
    tombstones: Mapping[str, Tombstone]

    def __post_init__(self) -> None:
        object.__setattr__(self, "accounts", MappingProxyType(
            {k: self.accounts[k] for k in sorted(self.accounts)}))
        object.__setattr__(self, "tombstones", MappingProxyType(
            {k: self.tombstones[k] for k in sorted(self.tombstones)}))
        object.__setattr__(self, "grants", tuple(sorted(
            self.grants, key=lambda g: (g.grantee, g.owner, g.collection))))

    # -- read helpers ----------------------------------------------------
    def enabled(self) -> List[str]:
        return [k for k, a in self.accounts.items() if not a.disabled]

    def admins(self) -> List[str]:
        """Enabled admins, sorted."""
        return [k for k, a in self.accounts.items()
                if a.admin and not a.disabled]

    def find_grant(self, owner: str, collection: str, grantee: str
                   ) -> Optional[Grant]:
        for g in self.grants:
            if g.key == (owner, collection, grantee):
                return g
        return None


# ---------------------------------------------------------------------------
# tokens, construction
# ---------------------------------------------------------------------------

def new_gen_token() -> str:
    return secrets.token_hex(16)


def empty_model(token: Optional[str] = None, bcrypt_cost: int = 12) -> Model:
    """Generation 0, no accounts (not usable until an admin is added)."""
    return _checked(Model(0, token or new_gen_token(), bcrypt_cost, {}, (), {}))


def _commit(old: Model, *, accounts: Optional[Mapping[str, Account]] = None,
            grants: Optional[Iterable[Grant]] = None,
            tombstones: Optional[Mapping[str, Tombstone]] = None,
            token: Optional[str] = None) -> Model:
    """Build the successor of ``old``: generation + 1, fresh token, validated."""
    new = Model(
        old.generation + 1, token or new_gen_token(), old.bcrypt_cost,
        old.accounts if accounts is None else accounts,
        tuple(old.grants if grants is None else grants),
        old.tombstones if tombstones is None else tombstones)
    return _checked(new)


def _checked(model: Model) -> Model:
    validate(model)
    return model


# ---------------------------------------------------------------------------
# validation of a whole model
# ---------------------------------------------------------------------------

def _corrupt(path: str, why: str) -> ApiError:
    return ApiError("model_corrupt", "model invalid at %s: %s" % (path, why),
                    field=path, reason=why)


def _check_timestamp(value: str, path: str) -> None:
    if not isinstance(value, str) or names.TIMESTAMP_RE.fullmatch(value) is None:
        raise _corrupt(path, "bad_timestamp")
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise _corrupt(path, "bad_timestamp") from None


def validate(model: Model) -> None:
    """Raise ``ApiError('model_corrupt')`` if any invariant is violated."""
    if not (isinstance(model.generation, int)
            and not isinstance(model.generation, bool)
            and 0 <= model.generation < 2 ** 31):
        raise _corrupt("generation", "out_of_range")
    if (not isinstance(model.gen_token, str)
            or names.GEN_TOKEN_RE.fullmatch(model.gen_token) is None):
        raise _corrupt("genToken", "bad_token")
    lo, hi = BCRYPT_COST_RANGE
    if (not isinstance(model.bcrypt_cost, int)
            or isinstance(model.bcrypt_cost, bool)
            or not lo <= model.bcrypt_cost <= hi):
        raise _corrupt("bcryptCost", "out_of_range")
    if len(model.accounts) > MAX_ACCOUNTS:
        raise _corrupt("accounts", "too_many")
    if len(model.grants) > MAX_GRANTS:
        raise _corrupt("grants", "too_many")
    if len(model.tombstones) > MAX_TOMBSTONES:
        raise _corrupt("tombstones", "too_many")
    for login, acc in model.accounts.items():
        where = "accounts.%s" % login
        if not names.is_valid_login(login):
            raise _corrupt(where, "bad_login")
        if login in model.tombstones:
            raise _corrupt(where, "tombstoned_and_present")
        try:
            names.validate_display_name(acc.display_name)
        except ApiError:
            raise _corrupt(where + ".displayName", "bad_display_name") from None
        if acc.type not in ACCOUNT_TYPES:
            raise _corrupt(where + ".type", "bad_type")
        for attr in ("admin", "disabled", "own_space"):
            if not isinstance(getattr(acc, attr), bool):
                raise _corrupt("%s.%s" % (where, attr), "not_a_bool")
        if acc.type == "bot" and acc.admin:
            raise _corrupt(where + ".admin", "bot_cannot_be_admin")
        _check_timestamp(acc.created, where + ".created")
        _check_timestamp(acc.password_changed, where + ".passwordChanged")
        if (not isinstance(acc.hash, str)
                or names.BCRYPT_HASH_RE.fullmatch(acc.hash) is None):
            raise _corrupt(where + ".hash", "bad_hash")
    for login, tomb in model.tombstones.items():
        where = "tombstones.%s" % login
        if not names.is_valid_login(login):
            raise _corrupt(where, "bad_login")
        _check_timestamp(tomb.deleted, where + ".deleted")
        if not names.is_valid_login(tomb.by):
            raise _corrupt(where + ".by", "bad_actor")
    seen = set()
    for i, g in enumerate(model.grants):
        where = "grants[%d]" % i
        if g.key in seen:
            raise _corrupt(where, "duplicate_grant")
        seen.add(g.key)
        for attr in ("owner", "grantee"):
            val = getattr(g, attr)
            if val not in model.accounts:
                raise _corrupt("%s.%s" % (where, attr), "unknown_account")
        if g.owner == g.grantee:
            raise _corrupt(where, "self_grant")
        if not names.is_valid_collection_name(g.collection):
            raise _corrupt(where + ".collection", "bad_collection_name")
        if g.level not in LEVELS:
            raise _corrupt(where + ".level", "bad_level")
        _check_timestamp(g.created, where + ".created")
        if not names.is_valid_login(g.by):
            raise _corrupt(where + ".by", "bad_actor")


# ---------------------------------------------------------------------------
# JSON
# ---------------------------------------------------------------------------

_ACCOUNT_KEYS = ("displayName", "type", "admin", "disabled", "ownSpace",
                 "created", "passwordChanged", "hash")
_GRANT_KEYS = ("owner", "collection", "grantee", "level", "created", "by")
_TOMB_KEYS = ("deleted", "by")
_TOP_KEYS = ("schema", "generation", "genToken", "bcryptCost", "accounts",
             "grants", "tombstones")


def to_dict(model: Model) -> dict:
    return {
        "schema": SCHEMA,
        "generation": model.generation,
        "genToken": model.gen_token,
        "bcryptCost": model.bcrypt_cost,
        "accounts": {k: {
            "displayName": a.display_name, "type": a.type, "admin": a.admin,
            "disabled": a.disabled, "ownSpace": a.own_space,
            "created": a.created, "passwordChanged": a.password_changed,
            "hash": a.hash} for k, a in model.accounts.items()},
        "grants": [{"owner": g.owner, "collection": g.collection,
                    "grantee": g.grantee, "level": g.level,
                    "created": g.created, "by": g.by} for g in model.grants],
        "tombstones": {k: {"deleted": t.deleted, "by": t.by}
                       for k, t in model.tombstones.items()},
    }


def dump(model: Model) -> str:
    """Canonical JSON text: sorted keys, ASCII only, trailing newline."""
    return json.dumps(to_dict(model), sort_keys=True, indent=2,
                      ensure_ascii=True) + "\n"


def _no_duplicates(pairs: List[Tuple[str, Any]]) -> dict:
    out: dict = {}
    for k, v in pairs:
        if k in out:
            raise ValueError("duplicate key %r" % k)
        out[k] = v
    return out


def _reject_constant(name: str) -> Any:
    raise ValueError("invalid JSON constant %s" % name)


def _check_shape(value: Any, depth: int, path: str) -> None:
    if depth > MAX_JSON_DEPTH:
        raise _corrupt(path, "too_deep")
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            raise _corrupt(path, "string_too_long")
    elif isinstance(value, dict):
        for k, v in value.items():
            if len(k) > MAX_STRING:
                raise _corrupt(path, "key_too_long")
            _check_shape(v, depth + 1, "%s.%s" % (path, k))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _check_shape(v, depth + 1, "%s[%d]" % (path, i))
    elif isinstance(value, float):
        raise _corrupt(path, "float_not_allowed")


def _keys(obj: Any, expected: Tuple[str, ...], path: str) -> dict:
    if not isinstance(obj, dict):
        raise _corrupt(path, "not_an_object")
    extra = set(obj) - set(expected)
    if extra:
        raise _corrupt(path, "unknown_key:%s" % sorted(extra)[0])
    missing = set(expected) - set(obj)
    if missing:
        raise _corrupt(path, "missing_key:%s" % sorted(missing)[0])
    return obj


def from_dict(obj: Any) -> Model:
    top = _keys(obj, _TOP_KEYS, "$")
    if top["schema"] != SCHEMA or isinstance(top["schema"], bool):
        raise _corrupt("schema", "unsupported_schema")
    accounts: Dict[str, Account] = {}
    raw_acc = top["accounts"]
    if not isinstance(raw_acc, dict):
        raise _corrupt("accounts", "not_an_object")
    for login, a in raw_acc.items():
        a = _keys(a, _ACCOUNT_KEYS, "accounts.%s" % login)
        accounts[login] = Account(
            a["displayName"], a["type"], a["admin"], a["disabled"],
            a["ownSpace"], a["created"], a["passwordChanged"], a["hash"])
    raw_grants = top["grants"]
    if not isinstance(raw_grants, list):
        raise _corrupt("grants", "not_an_array")
    grants: List[Grant] = []
    for i, g in enumerate(raw_grants):
        g = _keys(g, _GRANT_KEYS, "grants[%d]" % i)
        grants.append(Grant(g["owner"], g["collection"], g["grantee"],
                            g["level"], g["created"], g["by"]))
    raw_tombs = top["tombstones"]
    if not isinstance(raw_tombs, dict):
        raise _corrupt("tombstones", "not_an_object")
    tombs: Dict[str, Tombstone] = {}
    for login, t in raw_tombs.items():
        t = _keys(t, _TOMB_KEYS, "tombstones.%s" % login)
        tombs[login] = Tombstone(t["deleted"], t["by"])
    # Strings of the wrong type must be rejected before they are compared.
    for login, acc in accounts.items():
        for attr in ("display_name", "type", "created", "password_changed",
                     "hash"):
            if not isinstance(getattr(acc, attr), str):
                raise _corrupt("accounts.%s.%s" % (login, attr), "not_a_string")
    for i, g in enumerate(grants):
        for attr in ("owner", "collection", "grantee", "level", "created", "by"):
            if not isinstance(getattr(g, attr), str):
                raise _corrupt("grants[%d].%s" % (i, attr), "not_a_string")
    for login, t in tombs.items():
        for attr in ("deleted", "by"):
            if not isinstance(getattr(t, attr), str):
                raise _corrupt("tombstones.%s.%s" % (login, attr),
                               "not_a_string")
    model = Model(top["generation"], top["genToken"], top["bcryptCost"],
                  accounts, tuple(grants), tombs)
    validate(model)
    return model


def load(text: str) -> Model:
    """Parse and validate model JSON text; raise ``model_corrupt``."""
    if not isinstance(text, str):
        raise _corrupt("$", "not_text")
    if len(text.encode("utf-8", "surrogatepass")) > MAX_MODEL_BYTES:
        raise _corrupt("$", "too_large")
    try:
        obj = json.loads(text, object_pairs_hook=_no_duplicates,
                         parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:
        raise _corrupt("$", "invalid_json: %s" % exc) from None
    _check_shape(obj, 1, "$")
    return from_dict(obj)


# ---------------------------------------------------------------------------
# operations (each returns a NEW model; same object if nothing changed)
# ---------------------------------------------------------------------------

def _need_account(model: Model, login: object, field: str = "login") -> str:
    if not isinstance(login, str) or login not in model.accounts:
        raise ApiError("not_found", "no such account", field=field,
                       reason="no_such_account")
    return login


def _check_bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise validation_error(field, "not_a_bool")
    return value


def _check_type(value: Any) -> str:
    if value not in ACCOUNT_TYPES or not isinstance(value, str):
        raise validation_error("type", "bad_type")
    return value


def _check_bot_admin(acc_type: str, admin: bool) -> None:
    if acc_type == "bot" and admin:
        raise validation_error("admin", "bot_cannot_be_admin",
                               "a bot account cannot be an admin")


def create_account(model: Model, *, login: str, display_name: str,
                   type: str = "person", admin: bool = False,
                   own_space: bool = True, hash: str, now: str, by: str,
                   token: Optional[str] = None,
                   extra_reserved: Iterable[str] = ()) -> Model:
    login = names.validate_login(login, tombstoned=model.tombstones,
                                 extra_reserved=extra_reserved)
    if login in model.accounts:
        raise ApiError("exists", "login already exists", field="login",
                       reason="exists")
    display_name = names.validate_display_name(display_name)
    _check_type(type)
    _check_bool(admin, "admin")
    _check_bool(own_space, "ownSpace")
    _check_bot_admin(type, admin)
    if (not isinstance(hash, str)
            or names.BCRYPT_HASH_RE.fullmatch(hash) is None):
        raise validation_error("password", "bad_hash")
    if len(model.accounts) >= MAX_ACCOUNTS:
        raise validation_error("accounts", "limit_reached",
                               "at most %d accounts" % MAX_ACCOUNTS)
    accounts = dict(model.accounts)
    accounts[login] = Account(display_name, type, admin, False, own_space,
                              now, now, hash)
    return _commit(model, accounts=accounts, token=token)


def patch_account(model: Model, login: str, *, display_name: Any = UNSET,
                  type: Any = UNSET, admin: Any = UNSET, own_space: Any = UNSET,
                  disabled: Any = UNSET, now: str = "", by: str = "",
                  token: Optional[str] = None) -> Model:
    """Change the given attributes; unchanged values yield the same model."""
    _need_account(model, login)
    acc = model.accounts[login]
    changes: Dict[str, Any] = {}
    if display_name is not UNSET:
        changes["display_name"] = names.validate_display_name(display_name)
    if type is not UNSET:
        changes["type"] = _check_type(type)
    if admin is not UNSET:
        changes["admin"] = _check_bool(admin, "admin")
    if own_space is not UNSET:
        changes["own_space"] = _check_bool(own_space, "ownSpace")
    if disabled is not UNSET:
        changes["disabled"] = _check_bool(disabled, "disabled")
    new = dataclasses.replace(acc, **changes)
    _check_bot_admin(new.type, new.admin)
    if new == acc:
        return model
    accounts = dict(model.accounts)
    accounts[login] = new
    return _commit(model, accounts=accounts, token=token)


def disable_account(model: Model, login: str, **kw: Any) -> Model:
    return patch_account(model, login, disabled=True, **kw)


def enable_account(model: Model, login: str, **kw: Any) -> Model:
    return patch_account(model, login, disabled=False, **kw)


def delete_account(model: Model, login: str, *, now: str, by: str,
                   token: Optional[str] = None) -> Model:
    """Remove the account, tombstone the login, drop every grant naming it."""
    _need_account(model, login)
    accounts = dict(model.accounts)
    del accounts[login]
    tombs = dict(model.tombstones)
    tombs[login] = Tombstone(now, by)
    grants = [g for g in model.grants if login not in (g.owner, g.grantee)]
    return _commit(model, accounts=accounts, grants=grants, tombstones=tombs,
                   token=token)


def set_password_hash(model: Model, login: str, *, hash: str, now: str,
                      by: str = "", token: Optional[str] = None) -> Model:
    _need_account(model, login)
    if (not isinstance(hash, str)
            or names.BCRYPT_HASH_RE.fullmatch(hash) is None):
        raise validation_error("password", "bad_hash")
    accounts = dict(model.accounts)
    accounts[login] = dataclasses.replace(
        model.accounts[login], hash=hash, password_changed=now)
    return _commit(model, accounts=accounts, token=token)


def put_grant(model: Model, *, owner: str, collection: str, grantee: str,
              level: str, now: str, by: str,
              token: Optional[str] = None) -> Model:
    """Idempotent grant write; ``level == "none"`` removes the grant."""
    if level not in PUT_LEVELS or not isinstance(level, str):
        raise validation_error("level", "bad_level")
    owner = _need_account(model, owner, "owner")
    grantee = _need_account(model, grantee, "grantee")
    names.validate_collection_name(collection)
    if owner == grantee:
        raise validation_error("grantee", "self_grant",
                               "the owner already has full access")
    existing = model.find_grant(owner, collection, grantee)
    if level == "none":
        if existing is None:
            return model
        return _commit(model, grants=[g for g in model.grants
                                      if g is not existing], token=token)
    if model.accounts[grantee].admin:
        raise validation_error("grantee", "grantee_is_admin",
                               "admins already have full access")
    if existing is not None and existing.level == level:
        return model
    if existing is None and len(model.grants) >= MAX_GRANTS:
        raise validation_error("grants", "limit_reached",
                               "at most %d grants" % MAX_GRANTS)
    kept = [g for g in model.grants if g is not existing]
    kept.append(Grant(owner, collection, grantee, level,
                      existing.created if existing else now, by))
    return _commit(model, grants=kept, token=token)


def own_space_losses(old: Model, new: Model) -> List[str]:
    """Logins whose own space was switched off (typed confirmation needed:
    the UI must warn that the owner loses access to existing collections)."""
    return sorted(k for k, a in new.accounts.items()
                  if k in old.accounts and old.accounts[k].own_space
                  and not a.own_space)
