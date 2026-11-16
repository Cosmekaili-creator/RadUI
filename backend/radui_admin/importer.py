# SPDX-License-Identifier: AGPL-3.0-or-later
"""Import a legacy Radicale ``users`` + ``rights`` pair into a RadUI model.

``import_legacy`` is pure: it takes the two file texts and returns an
:class:`ImportResult` (model plus issues). The named admin(s) become admin
accounts; every other account becomes a ``bot`` account whose grants are
reconstructed from the legacy rules. Grants are derived by EVALUATING the
legacy rules (a pure emulation of Radicale's first-match ``from_file``
semantics, cross-checked against Radicale itself in the unit tests) on the
candidate paths named in the rules, so the legacy rule shapes (literal
principal rules, ``{user}`` templates, ``^owner/(a|b|c)$`` alternations) all
work without a rule-by-rule translation.

``equivalence_report`` compares the effective rights of the OLD and NEW files
over a probe set through a ``matcher`` (Radicale's own engine, see
``expected.RadicaleMatcher``) and explains every difference. Letters are
compared as CAPABILITIES because the new configuration switches collection
delete/overwrite to explicit allow letters (``D``, ``O``) and uses ``l`` to
block PROPPATCH; a literal letter diff would be meaningless.
"""
import configparser
import re
from typing import (Callable, Dict, FrozenSet, Iterable, List, Mapping,
                    NamedTuple, Optional, Sequence, Set, Tuple)

from . import names
from .model import Account, Grant, Model, validate
from .names import ApiError

PROBE_NAME = "radui-import-probe"
OLD_PERMITS = (True, True)   # Radicale defaults: permit_delete/overwrite_collection
NEW_PERMITS = (False, False)  # what the RadUI configuration sets


class Issue(NamedTuple):
    level: str      # "error" | "warning"
    code: str
    message: str
    subject: str


class LegacyRule(NamedTuple):
    section: str
    user: str
    collection: str
    permissions: str
    groups: str


def parse_users(text: str) -> Tuple[Dict[str, str], List[Issue]]:
    """Parse htpasswd lines ``login:hash``; comments and blanks are skipped."""
    out: Dict[str, str] = {}
    issues: List[Issue] = []
    for n, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        login, sep, digest = line.rstrip("\n").partition(":")
        if not sep or not login or not digest:
            issues.append(Issue("error", "bad_users_line",
                                "line %d is not login:hash" % n, "line %d" % n))
            continue
        if login in out:
            issues.append(Issue("error", "duplicate_login",
                                "login appears twice", login))
            continue
        out[login] = digest
    return out, issues


def parse_rights(text: str) -> List[LegacyRule]:
    """Parse a legacy rights file the way Radicale's ``from_file`` does."""
    cp = configparser.ConfigParser()
    rules = []
    try:
        cp.read_string(text)
        for sec in cp.sections():
            rules.append(LegacyRule(
                sec, cp.get(sec, "user", fallback=""),
                cp.get(sec, "collection"),
                cp.get(sec, "permissions"),
                cp.get(sec, "groups", fallback="")))
    except configparser.Error as exc:
        raise ValueError("cannot parse rights file: %s"
                         % str(exc).splitlines()[0]) from None
    return rules


class LegacyRights:
    """Pure emulation of ``radicale.rights.from_file`` (first match wins)."""

    def __init__(self, rules: Sequence[LegacyRule]) -> None:
        self.rules = list(rules)

    def authorization(self, user: str, path: str) -> str:
        sane = path.strip("/")
        escaped = re.escape(user)
        for rule in self.rules:
            if rule.user == "":
                continue
            um = re.fullmatch(rule.user.format(), user)
            if um and re.fullmatch(rule.collection.format(
                    *(re.escape(s) for s in um.groups()), user=escaped), sane):
                return rule.permissions
        return ""


_LIT = r"(?:\\.|[A-Za-z0-9_@~.+-])+"
_ALT_RE = re.compile(r"\((?:\?:)?(%s(?:\|%s)*)\)" % (_LIT, _LIT))
_LIT_RE = re.compile(_LIT)


def _unescape(s: str) -> str:
    return re.sub(r"\\(.)", r"\1", s)


def extract_candidates(rules: Sequence[LegacyRule]
                       ) -> Tuple[Set[Tuple[str, str]], Set[str]]:
    """``({(owner, collection)}, {owners with a wildcard rule})`` from the
    collection patterns of ``^owner/name$`` and ``^owner/(a|b|c)$`` shapes."""
    found: Set[Tuple[str, str]] = set()
    wildcard: Set[str] = set()
    for rule in rules:
        pat = rule.collection
        if pat.startswith("^"):
            pat = pat[1:]
        if pat.endswith("$") and not pat.endswith("\\$"):
            pat = pat[:-1]
        owner, sep, rest = pat.partition("/")
        if not sep or _LIT_RE.fullmatch(owner) is None:
            continue
        owner = _unescape(owner)
        alt = _ALT_RE.fullmatch(rest)
        if alt:
            for part in alt.group(1).split("|"):
                found.add((owner, _unescape(part)))
        elif _LIT_RE.fullmatch(rest):
            found.add((owner, _unescape(rest)))
        else:
            wildcard.add(owner)
    return found, wildcard


class ImportResult(NamedTuple):
    model: Model
    issues: List[Issue]
    dropped: FrozenSet[Tuple[str, str, str]]   # (grantee, owner, name or "*")
    skipped: FrozenSet[str]                     # legacy logins not imported
    legacy_users: Tuple[str, ...]
    candidates: FrozenSet[Tuple[str, str]]      # (owner, collection) examined

    @property
    def errors(self) -> List[Issue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def ok(self) -> bool:
        return not self.errors and bool(self.model.admins())


def import_legacy(users_text: str, rights_text: str, *, admins: Iterable[str],
                  now: str, token: Optional[str] = None,
                  by: str = "import",
                  known_collections: Optional[Mapping[str, Sequence[str]]] = None,
                  extra_reserved: Iterable[str] = ()) -> ImportResult:
    """Build generation 1 of a model from legacy files (never raises on
    content problems: they are returned as issues; ``result.ok`` tells)."""
    from . import model as model_mod
    admins = list(admins)
    hashes, issues = parse_users(users_text)
    try:
        rules = parse_rights(rights_text)
    except ValueError as exc:
        return ImportResult(
            model_mod.empty_model(token), issues + [
                Issue("error", "bad_rights_file", str(exc), "rights")],
            frozenset(), frozenset(hashes), tuple(sorted(hashes)), frozenset())
    for r in rules:
        if r.groups.strip():
            issues.append(Issue("warning", "groups_ignored",
                                "group rules are not imported", r.section))
    legacy = LegacyRights(rules)

    accounts: Dict[str, Account] = {}
    skipped: Set[str] = set()
    costs: List[int] = []
    for login in sorted(hashes):
        digest = hashes[login]
        if not names.is_valid_login(login) or names.is_reserved_login(
                login, extra_reserved):
            issues.append(Issue("error", "unusable_login",
                                "login not allowed in the new model", login))
            skipped.add(login)
            continue
        if names.BCRYPT_HASH_RE.fullmatch(digest) is None:
            issues.append(Issue("error", "unsupported_hash",
                                "only bcrypt hashes can be imported", login))
            skipped.add(login)
            continue
        costs.append(int(digest[4:6]))
        is_admin = login in admins
        # own space: does the legacy file let this login write below itself?
        own = True if is_admin else "w" in legacy.authorization(
            login, "%s/%s" % (login, PROBE_NAME))
        accounts[login] = Account(
            login, "person" if is_admin else "bot", is_admin, False, own,
            now, now, digest)
    for a in admins:
        if a not in accounts:
            issues.append(Issue("error", "admin_not_importable",
                                "named admin missing or unusable", a))

    found, _wild = extract_candidates(rules)
    for owner, listed in (known_collections or {}).items():
        for c in listed:
            found.add((owner, c))
    candidates: Set[Tuple[str, str]] = set()
    dropped: Set[Tuple[str, str, str]] = set()
    grants: List[Grant] = []
    for owner, coll in sorted(found):
        if owner not in accounts:
            issues.append(Issue("warning", "unknown_owner",
                                "collection of a login that is not imported",
                                "%s/%s" % (owner, coll)))
            continue
        candidates.add((owner, coll))
    for grantee in sorted(a for a, v in accounts.items() if not v.admin):
        for owner, coll in sorted(candidates):
            if owner == grantee:
                continue
            letters = legacy.authorization(grantee, "%s/%s" % (owner, coll))
            if "r" not in letters:
                if "w" in letters:
                    issues.append(Issue(
                        "warning", "write_without_read",
                        "write-only access cannot be represented",
                        "%s -> %s/%s" % (grantee, owner, coll)))
                    dropped.add((grantee, owner, coll))
                continue
            if not names.is_valid_collection_name(coll):
                issues.append(Issue(
                    "warning", "unsupported_collection_name",
                    "grant dropped: name not supported",
                    "%s -> %s/%s" % (grantee, owner, coll)))
                dropped.add((grantee, owner, coll))
                continue
            level = "readwrite" if "w" in letters else "read"
            grants.append(Grant(owner, coll, grantee, level, now, by))
        for owner in sorted(accounts):
            if owner == grantee:
                continue
            if "r" in legacy.authorization(
                    grantee, "%s/%s" % (owner, PROBE_NAME)):
                issues.append(Issue(
                    "warning", "wildcard_access_not_imported",
                    "legacy rules give access to every collection of the "
                    "owner; list the collections to import grants",
                    "%s -> %s" % (grantee, owner)))
                dropped.add((grantee, owner, "*"))
    bcrypt_cost = max(4, min(16, max(costs))) if costs else 12
    model = Model(1, token or model_mod.new_gen_token(), bcrypt_cost,
                  accounts, tuple(grants), {})
    try:
        validate(model)
    except ApiError as exc:
        issues.append(Issue("error", "model_invalid", exc.message, "model"))
        model = model_mod.empty_model(token)
    return ImportResult(model, issues, frozenset(dropped), frozenset(skipped),
                        tuple(sorted(hashes)), frozenset(candidates))


# ---------------------------------------------------------------------------
# equivalence report
# ---------------------------------------------------------------------------

CAPS = ("read", "write", "delete_collection", "overwrite_collection",
        "proppatch", "probe")


def capabilities(letters: str, depth: int,
                 permits: Tuple[bool, bool]) -> FrozenSet[str]:
    """Operations a letter set allows on a path of ``depth`` segments
    (0 root, 1 plain collection/principal, 2 calendar or address book), under
    ``permit_delete_collection`` / ``permit_overwrite_collection``."""
    permit_delete, permit_overwrite = permits
    tagged = depth >= 2
    caps: Set[str] = set()
    if ("r" if tagged else "R") in letters:
        caps.add("read")
    if ("w" if tagged else "W") in letters:
        caps.add("write")
        deny_letter = "d" if tagged else "D"
        if (deny_letter not in letters) if permit_delete else ("D" in letters):
            caps.add("delete_collection")
        if ("o" not in letters) if permit_overwrite else ("O" in letters):
            caps.add("overwrite_collection")
        if "l" not in letters:
            caps.add("proppatch")
    if "i" in letters:
        caps.add("probe")
    return frozenset(caps)


class Difference(NamedTuple):
    user: str
    path: str
    direction: str            # "lost" | "gained"
    caps: Tuple[str, ...]
    old_letters: str
    new_letters: str
    category: str             # expected_tightening | expected_loosening | unexplained
    reason: str


class Report(NamedTuple):
    differences: List[Difference]
    probes: int

    def by_category(self, category: str) -> List[Difference]:
        return [d for d in self.differences if d.category == category]

    @property
    def unexplained(self) -> List[Difference]:
        return self.by_category("unexplained")

    def summary(self) -> Dict[str, int]:
        out = {"probes": self.probes, "expected_tightening": 0,
               "expected_loosening": 0, "unexplained": 0}
        for d in self.differences:
            out[d.category] += 1
        return out

    def to_text(self) -> str:
        lines = ["probes: %d" % self.probes]
        lines += ["%s: %d" % (k, v) for k, v in self.summary().items()
                  if k != "probes"]
        for d in self.differences:
            lines.append("%s %s %s [%s] %s -> %s (%s)" % (
                d.category, d.user or "<anonymous>", d.path or "<root>",
                ",".join(d.caps), d.old_letters or "-", d.new_letters or "-",
                d.reason))
        return "\n".join(lines) + "\n"


Matcher = Callable[[str, Sequence[Tuple[str, str]]], List[str]]


def _probe_set(old_rules: Sequence[LegacyRule], model: Model,
               result: Optional[ImportResult],
               known: Optional[Mapping[str, Sequence[str]]]
               ) -> Tuple[List[str], List[str]]:
    users = set(model.accounts)
    if result is not None:
        users |= set(result.legacy_users)
    paths = {"", "radui-probe-top", names.GENERATION_PREFIX + model.gen_token}
    principals = set(users)
    for p in sorted(principals):
        paths |= {p, "%s/%s" % (p, PROBE_NAME)}
    found, _ = extract_candidates(old_rules)
    for o, c in found:
        paths.add("%s/%s" % (o, c))
    for g in model.grants:
        paths.add("%s/%s" % (g.owner, g.collection))
    for o, listed in (known or {}).items():
        paths |= {"%s/%s" % (o, c) for c in listed}
    if result is not None:
        paths |= {"%s/%s" % (o, c) for o, c in result.candidates}
    return [""] + sorted(users), sorted(paths)


def equivalence_report(old_rights_text: str, new_rights_text: str,
                       model: Model, *, matcher: Matcher,
                       result: Optional[ImportResult] = None,
                       known_collections: Optional[Mapping[str, Sequence[str]]] = None,
                       old_permits: Tuple[bool, bool] = OLD_PERMITS,
                       new_permits: Tuple[bool, bool] = NEW_PERMITS) -> Report:
    """Compare OLD and NEW effective rights through ``matcher`` (Radicale's
    engine) over every (account, path) probe and explain each difference."""
    old_rules = parse_rights(old_rights_text)
    users, paths = _probe_set(old_rules, model, result, known_collections)
    pairs = [(u, p) for u in users for p in paths]
    old_l = matcher(old_rights_text, pairs)
    new_l = matcher(new_rights_text, pairs)
    skipped = result.skipped if result else frozenset()
    dropped = result.dropped if result else frozenset()
    gen_path = names.GENERATION_PREFIX + model.gen_token
    diffs: List[Difference] = []
    for (user, path), ol, nl in zip(pairs, old_l, new_l):
        depth = 0 if path == "" else path.count("/") + 1
        if depth > 2:
            continue
        oc = capabilities(ol, depth, old_permits)
        nc = capabilities(nl, depth, new_permits)
        lost, gained = oc - nc, nc - oc
        acc = model.accounts.get(user)
        if lost:
            diffs.append(_explain_lost(user, path, depth, lost, ol, nl,
                                       dropped, skipped, acc))
        if gained:
            diffs.append(_explain_gained(user, path, gained, ol, nl, acc,
                                         gen_path))
    return Report(diffs, len(pairs))


def _explain_lost(user: str, path: str, depth: int, lost: FrozenSet[str],
                  ol: str, nl: str, dropped, skipped,
                  acc: Optional[Account] = None) -> Difference:
    explicit = {"delete_collection", "overwrite_collection", "proppatch"}
    owner, _, name = path.partition("/")
    if acc is not None and acc.admin and depth <= 1 and "read" not in lost \
            and lost <= explicit | {"write"} and (lost - explicit):
        # A legacy admin rule such as ``.+`` also granted write on the root,
        # on arbitrary top-level names and on the generation path. The
        # layout never gives an admin RW there: it would let an admin
        # create top-level names nobody can delete (decision D1).
        reason, cat = "admin_toplevel_write_removed", "expected_tightening"
    elif lost <= explicit:
        reason = ("principal_explicit_letters" if depth == 1
                  else "explicit_collection_letters")
        cat = "expected_tightening"
    elif user in skipped:
        reason, cat = "account_not_imported", "expected_tightening"
    elif (user, owner, name) in dropped or (user, owner, "*") in dropped:
        reason, cat = "grant_not_imported", "expected_tightening"
    else:
        reason, cat = "lost_access", "unexplained"
    return Difference(user, path, "lost", tuple(sorted(lost)), ol, nl, cat,
                      reason)


def _explain_gained(user: str, path: str, gained: FrozenSet[str], ol: str,
                    nl: str, acc: Optional[Account], gen_path: str
                    ) -> Difference:
    if user == "" and path == gen_path and gained == {"probe"}:
        reason, cat = "generation_probe", "expected_loosening"
    elif acc is not None and acc.admin:
        reason, cat = "admin_full_access", "expected_loosening"
    elif path == user and gained <= {"read", "write", "proppatch"}:
        reason, cat = "own_principal", "expected_loosening"
    elif path == "" and gained == {"read"}:
        reason, cat = "root_discovery", "expected_loosening"
    else:
        reason, cat = "gained_access", "unexplained"
    return Difference(user, path, "gained", tuple(sorted(gained)), ol, nl,
                      cat, reason)
