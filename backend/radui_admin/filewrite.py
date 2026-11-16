# SPDX-License-Identifier: AGPL-3.0-or-later
"""The write protocol: the only code that changes the model and managed files.

Every mutation (server or CLI) goes through :meth:`Store.apply`:

1. take the process lock plus ``flock`` on ``<state_dir>/.lock`` (shared with
   the CLI); wait at most ``lock_timeout_s``, then ``busy``;
2. reload the model from disk and apply the operation to a copy;
3. lockout checks (``lockout.check_change``);
4. generate ``users`` and ``rights`` (``generator.generate``);
5. validate the candidate (``validate_candidate``; Radicale's own parsers);
6. write ``model.json`` atomically (temp file in the same directory, fsync,
   rename, fsync of the directory), then ``generations/<N>/`` (model, users,
   rights), pruned to the newest three plus any import baseline;
7. write the managed files atomically, in the safe order: when a login
   disappears (disable, delete) ``users`` first, otherwise ``rights`` first;
8. poll the generation probe; only after it answers "active" copy the rights
   file to ``rights.lkg``.

Fail closed: an error before step 6 changes nothing; an error during steps
6-7 restores the previous model, generation directory and any managed file
already replaced. A real crash (kill) between the steps is repaired by
:meth:`Store.reconcile` on the next start: the managed files are regenerated
from the model after a full validation. Managed files are only ever replaced
by rename, never deleted and recreated.

Before anything is published an intent record (event, actor, target, address)
is written into the generation directory (``intent.json``); a roll-forward by
:meth:`Store.reconcile` writes the audit line of the interrupted change from
it. :meth:`Store.self_heal` (run periodically by the server) repairs managed
files that were damaged or reverted while the backend kept running.

Managed files are written 0640 with group ``radicale_group`` when configured
(the group change is skipped quietly when the process may not do it); the
state files are 0600 in a 0700 directory.
"""
import contextlib
import dataclasses
import fcntl
import grp
import json
import os
import re
import shutil
import tempfile
import threading
import time
from typing import Callable, Dict, Iterator, List, Optional, Tuple

from . import generator, lockout, plan
from . import model as model_mod
from . import validate_candidate as vc
from .audit import Audit
from .config import Config
from .model import Model
from .names import ApiError
from .probe import Prober

KEEP_GENERATIONS = 3
BASELINE_MARKER = "BASELINE"
INTENT_FILE = "intent.json"
INTENT_REPLAYED = "intent.replayed.json"
INTENT_FIELDS = ("event", "actor", "target", "ip")
#: Event of an intent record whose caller gave none: replayed as the generic
#: ``reconcile`` line.
GENERIC_EVENT = "store.change"
HEALTH_CACHE_S = 2.0
_GEN_DIR_RE = re.compile(r"[1-9][0-9]{0,9}")
_HEADER_GEN_RE = re.compile(r"# radui-admin generated; DO NOT EDIT\. "
                            r"generation=([0-9]+)\n")

USERS_UNCHECKED_MESSAGE = (
    "the users file could not be checked with Radicale's own parser (its "
    "internals changed?); upgrade radui-admin or set allow_unchecked_users = "
    "true to accept this knowingly")

Validator = Callable[[Model, str, str], None]
Fault = Callable[[str], None]


class Crash(BaseException):
    """Raised by tests through the fault hook to simulate a process death:
    it bypasses the rollback, like a kill would."""


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclasses.dataclass
class Applied:
    old: Optional[Model]
    new: Model
    rights: str = ""
    users: str = ""
    active: bool = True
    noop: bool = False
    dry_run: bool = False
    plan: Optional[dict] = None


def make_intent(event: Optional[str] = None, actor: Optional[str] = None,
                target: Optional[str] = None, ip: Optional[str] = None
                ) -> Dict[str, Optional[str]]:
    """The record stored before a change is published (strings only)."""
    def clip(v: object) -> Optional[str]:
        return None if v is None else str(v)[:200]
    return {"event": clip(event) or GENERIC_EVENT, "actor": clip(actor),
            "target": clip(target), "ip": clip(ip)}


def _fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path: str, data: bytes, mode: int = 0o640,
                 gid: Optional[int] = None) -> None:
    """Write ``data`` to ``path`` by temp file + fsync + rename + dir fsync."""
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path),
                               suffix=".tmp", dir=directory)
    try:
        try:
            os.fchmod(fd, mode)
            if gid is not None:
                try:
                    os.fchown(fd, -1, gid)
                except PermissionError:
                    pass  # not allowed to change group (tests, no setgid dir)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    _fsync_dir(directory)


def _read_bytes(path: str) -> Optional[bytes]:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def header_generation(data: Optional[bytes]) -> Optional[int]:
    """Generation in the first line of a generated file, or ``None``."""
    if not data:
        return None
    first = data.split(b"\n", 1)[0] + b"\n"
    m = _HEADER_GEN_RE.fullmatch(first.decode("ascii", "replace"))
    return int(m.group(1)) if m else None


class Store:
    def __init__(self, cfg: Config, *, audit: Optional[Audit] = None,
                 prober: Optional[Prober] = None,
                 validator: Optional[Validator] = None,
                 fault: Optional[Fault] = None,
                 matcher: Optional[Callable[[str, list], List[str]]] = None,
                 clock: Callable[[], str] = utc_now) -> None:
        self.cfg = cfg
        self.audit = audit or Audit()
        self.prober = prober or Prober(cfg)
        self._validator = validator
        self._fault = fault
        self._matcher = matcher
        self.now = clock
        self._tlock = threading.Lock()
        self._cache_lock = threading.Lock()
        self._cache: Optional[Tuple[tuple, Model]] = None
        self._health: Optional[Tuple[float, dict, object]] = None
        self._gid: Optional[int] = None
        self._healed_token: Optional[str] = None
        self._last_failure: Optional[str] = None
        if cfg.radicale_group:
            try:
                self._gid = grp.getgrnam(cfg.radicale_group).gr_gid
            except KeyError:
                raise ValueError("radicale_group %r does not exist"
                                 % cfg.radicale_group) from None
        os.makedirs(cfg.state_dir, mode=0o700, exist_ok=True)
        os.makedirs(cfg.generations_dir, mode=0o700, exist_ok=True)
        os.makedirs(cfg.managed_dir, mode=0o750, exist_ok=True)

    # -- locking ------------------------------------------------------------
    @contextlib.contextmanager
    def locked(self, timeout: Optional[float] = None) -> Iterator[None]:
        wait = self.cfg.lock_timeout_s if timeout is None else timeout
        deadline = time.monotonic() + wait
        if not self._tlock.acquire(timeout=max(wait, 0)):
            raise ApiError("busy", "another change is in progress, try again",
                           reason="lock_timeout")
        try:
            fd = os.open(self.cfg.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                while True:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise ApiError(
                                "busy", "another change is in progress, "
                                "try again", reason="lock_timeout") from None
                        time.sleep(0.02)
                yield
            finally:
                os.close(fd)  # releases the flock
        finally:
            self._tlock.release()

    def _hit(self, point: str) -> None:
        if self._fault is not None:
            self._fault(point)

    # -- model access -------------------------------------------------------
    def load_model(self) -> Model:
        """Read and validate ``model.json`` (raises ``model_corrupt``)."""
        data = _read_bytes(self.cfg.model_path)
        if data is None:
            raise ApiError("model_corrupt", "no model; run the import",
                           reason="no_model")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError("model_corrupt", "model is not UTF-8",
                           reason="not_utf8") from None
        return model_mod.load(text)

    def current_model(self) -> Model:
        """Model for readers (no lock): re-parsed only when the file changes."""
        for _ in range(5):
            try:
                st = os.stat(self.cfg.model_path)
            except FileNotFoundError:
                raise ApiError("model_corrupt", "no model; run the import",
                               reason="no_model") from None
            sig = (st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)
            with self._cache_lock:
                if self._cache is not None and self._cache[0] == sig:
                    return self._cache[1]
            m = self.load_model()
            st2 = os.stat(self.cfg.model_path)
            if sig == (st2.st_ino, st2.st_mtime_ns, st2.st_ctime_ns,
                       st2.st_size):
                with self._cache_lock:
                    self._cache = (sig, m)
                return m
        return self.load_model()

    # -- generation directories ----------------------------------------------
    def generation_numbers(self) -> List[int]:
        try:
            names_ = os.listdir(self.cfg.generations_dir)
        except FileNotFoundError:
            return []
        return sorted(int(n) for n in names_ if _GEN_DIR_RE.fullmatch(n)
                      and os.path.isdir(os.path.join(
                          self.cfg.generations_dir, n)))

    def load_generation(self, n: int) -> Model:
        path = os.path.join(self.cfg.generations_dir, str(n), "model.json")
        data = _read_bytes(path)
        if data is None:
            raise ApiError("not_found", "no such generation",
                           field="generation", reason="no_such_generation")
        try:
            return model_mod.load(data.decode("utf-8"))
        except UnicodeDecodeError:
            raise ApiError("model_corrupt", "stored generation is unreadable",
                           reason="not_utf8") from None

    def list_generations(self) -> List[dict]:
        out = []
        try:
            current: Optional[int] = self.current_model().generation
        except ApiError:
            current = None
        for n in self.generation_numbers():
            base = os.path.join(self.cfg.generations_dir, str(n))
            entry: dict = {"generation": n, "current": n == current,
                           "baseline": os.path.exists(
                               os.path.join(base, BASELINE_MARKER))}
            try:
                m = self.load_generation(n)
                entry.update({"accounts": len(m.accounts),
                              "grants": len(m.grants)})
            except ApiError:
                entry["unreadable"] = True
            try:
                entry["modified"] = time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(
                        os.stat(os.path.join(base, "model.json")).st_mtime))
            except OSError:
                pass
            out.append(entry)
        return out

    def _intent_path(self, generation: int, name: str = INTENT_FILE) -> str:
        return os.path.join(self.cfg.generations_dir, str(generation), name)

    def _write_intent(self, generation: int, intent: dict) -> None:
        """Write ``intent.json`` into ``generations/<N>/`` (created if needed)
        before the change is published."""
        gdir = os.path.join(self.cfg.generations_dir, str(generation))
        os.makedirs(gdir, mode=0o700, exist_ok=True)
        atomic_write(os.path.join(gdir, INTENT_FILE),
                     json.dumps(intent, ensure_ascii=True,
                                separators=(",", ":")).encode("ascii"), 0o600)

    def _read_intent(self, generation: int) -> Optional[dict]:
        """The stored intent record of a generation if it is well formed and
        was not replayed yet."""
        data = _read_bytes(self._intent_path(generation))
        if data is None or len(data) > 4096:
            return None
        try:
            obj = json.loads(data.decode("ascii"))
        except ValueError:
            return None
        if not isinstance(obj, dict) or set(obj) != set(INTENT_FIELDS) \
                or not isinstance(obj["event"], str) or not obj["event"] \
                or any(obj[k] is not None and not isinstance(obj[k], str)
                       for k in INTENT_FIELDS):
            return None
        return obj

    def _write_generation(self, model: Model, rights: str, users: str,
                          baseline: bool = False,
                          intent: Optional[dict] = None) -> None:
        gdir = self.cfg.generations_dir
        final = os.path.join(gdir, str(model.generation))
        tmp = tempfile.mkdtemp(prefix=".%d." % model.generation, dir=gdir)
        try:
            os.chmod(tmp, 0o700)
            atomic_write(os.path.join(tmp, "model.json"),
                         model_mod.dump(model).encode("ascii"), 0o600)
            atomic_write(os.path.join(tmp, "users"), users.encode("ascii"),
                         0o600)
            atomic_write(os.path.join(tmp, "rights"), rights.encode("ascii"),
                         0o600)
            if baseline:
                atomic_write(os.path.join(tmp, BASELINE_MARKER), b"", 0o600)
            if intent is None:
                intent = self._read_intent(model.generation)
            if intent is not None:
                atomic_write(os.path.join(tmp, INTENT_FILE),
                             json.dumps(intent, ensure_ascii=True,
                                        separators=(",", ":")).encode("ascii"),
                             0o600)
            if os.path.isdir(final):
                shutil.rmtree(final)
            os.replace(tmp, final)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        _fsync_dir(gdir)
        self._prune_generations()

    def _prune_generations(self) -> None:
        gens = self.generation_numbers()
        for n in gens[:-KEEP_GENERATIONS]:
            base = os.path.join(self.cfg.generations_dir, str(n))
            if os.path.exists(os.path.join(base, BASELINE_MARKER)):
                continue
            shutil.rmtree(base, ignore_errors=True)

    # -- validation -----------------------------------------------------------
    def _validate(self, model: Model, rights: str, users: str) -> None:
        try:
            if self._validator is not None:
                self._validator(model, rights, users)
            else:
                res = vc.validate(
                    rights, users, model, python=self.cfg.radicale_python,
                    plugin_dir=self.cfg.plugin_dir,
                    timeout=self.cfg.validate_timeout_s)
                if not res.users_checked and not self.cfg.allow_unchecked_users:
                    raise vc.CandidateRejected([USERS_UNCHECKED_MESSAGE])
        except vc.CandidateRejected as exc:
            err = ApiError("internal", "the generated files failed validation; "
                           "nothing was changed", reason="candidate_rejected")
            err.detail = exc.problems  # type: ignore[attr-defined]
            raise err from None

    # -- writing --------------------------------------------------------------
    def _write_managed(self, path: str, text: str) -> None:
        atomic_write(path, text.encode("ascii"), 0o640, self._gid)

    @staticmethod
    def _users_first(old_logins: set, new_logins: set) -> bool:
        return bool(old_logins - new_logins)

    def _publish(self, old: Optional[Model], new: Model, rights: str,
                 users: str, *, baseline: bool, probe: bool,
                 users_first: bool, intent: Optional[dict] = None) -> bool:
        """Steps 6-8 of the protocol. Returns the activation state."""
        cfg = self.cfg
        old_model_bytes = _read_bytes(cfg.model_path)
        saved = {p: _read_bytes(p) for p in (cfg.rights_path, cfg.users_path)}
        replaced: List[str] = []
        gen_written = False
        intent = intent or make_intent()
        try:
            gen_written = True  # the directory exists from the intent on
            self._write_intent(new.generation, intent)
            self._hit("before_model")
            atomic_write(cfg.model_path, model_mod.dump(new).encode("ascii"),
                         0o600)
            self._hit("after_model")
            self._write_generation(new, rights, users, baseline, intent)
            self._hit("after_generation")
            order = [(cfg.users_path, users), (cfg.rights_path, rights)]
            if not users_first:
                order.reverse()
            for i, (path, text) in enumerate(order):
                self._write_managed(path, text)
                replaced.append(path)
                self._hit("after_first_file" if i == 0 else "after_files")
        except Exception:
            self._rollback(new, old_model_bytes, saved, replaced, gen_written)
            raise
        if not probe:
            return True
        self._hit("before_probe")
        active = self.prober.wait_active(new.gen_token)
        if active:
            self._write_lkg(rights)
        return active

    def _rollback(self, new: Model, old_model_bytes: Optional[bytes],
                  saved: Dict[str, Optional[bytes]], replaced: List[str],
                  gen_written: bool) -> None:
        """Best effort; anything left over is repaired by ``reconcile``."""
        try:
            if gen_written:
                shutil.rmtree(os.path.join(self.cfg.generations_dir,
                                           str(new.generation)),
                              ignore_errors=True)
            if old_model_bytes is not None:
                atomic_write(self.cfg.model_path, old_model_bytes, 0o600)
            for path in reversed(replaced):
                if saved.get(path) is not None:
                    atomic_write(path, saved[path] or b"", 0o640, self._gid)
        except Exception as exc:  # noqa: BLE001
            self.audit.log("store.rollback", result="failed: %s"
                           % type(exc).__name__, generation=new.generation)

    def _write_lkg(self, rights: str) -> bool:
        try:
            self._write_managed(self.cfg.lkg_path, rights)
            return True
        except OSError as exc:
            self.audit.log("store.lkg", result="failed: %s"
                           % type(exc).__name__)
            return False

    # -- the protocol ---------------------------------------------------------
    def _execute(self, old: Optional[Model], new: Model, actor: Optional[str],
                 *, dry_run: bool, probe: bool = True, baseline: bool = False,
                 validate_full: bool = True, intent: Optional[dict] = None,
                 report: Optional[dict] = None) -> Applied:
        lockout.check_change(old if old is not None else new, new, actor)
        rights, users, _meta = generator.generate(new)
        if dry_run:
            if old is None:
                old = new
            described = plan.describe(old, new, None, rights)
            if report is not None:
                described["restore"] = report
            return Applied(old, new, rights, users, True, False, True,
                           described)
        if validate_full:
            self._validate(new, rights, users)
        old_logins = set(old.enabled()) if old is not None else set()
        users_first = self._users_first(old_logins, set(new.enabled()))
        active = self._publish(old, new, rights, users, baseline=baseline,
                               probe=probe, users_first=users_first,
                               intent=intent or make_intent(actor=actor))
        self._health = None
        return Applied(old, new, rights, users, active,
                       plan={"restore": report} if report is not None
                       else None)

    def apply(self, op: Callable[[Model], Model], *, actor: Optional[str],
              dry_run: bool = False, probe: bool = True,
              intent: Optional[dict] = None) -> Applied:
        """Run one mutation under the lock. ``op`` maps the current model to
        the new one (it may raise :class:`ApiError`); returning the same
        object means "nothing to do". ``intent`` (see :func:`make_intent`) is
        stored with the generation for a later roll-forward."""
        with self.locked():
            old = self.load_model()
            new = op(old)
            if new is old:
                active = self.prober.is_active(old.gen_token) if probe \
                    else True
                return Applied(old, old, active=active, noop=True,
                               dry_run=dry_run)
            return self._execute(old, new, actor, dry_run=dry_run,
                                 probe=probe, intent=intent)

    def install_initial(self, model: Model, *, probe: bool = False,
                        dry_run: bool = False) -> Applied:
        """Write generation 1 of an imported model (refuses to overwrite)."""
        with self.locked():
            if os.path.exists(self.cfg.model_path):
                raise ApiError("exists", "a model already exists; "
                               "use restore to go back to a generation",
                               reason="model_exists")
            return self._execute(None, model, None, dry_run=dry_run,
                                 probe=probe, baseline=True,
                                 intent=make_intent("import", "cli"))

    def restore(self, n: int, actor: Optional[str], *, dry_run: bool = False,
                probe: bool = True, intent: Optional[dict] = None) -> Applied:
        """Make generation ``n`` the base of a NEW generation, with the
        semantics of :func:`plan.merge_restore`: tombstones, current password
        hashes and the current ``disabled`` state stay authoritative; the
        stored generation gives the grants, ``ownSpace`` and ``admin`` flags.
        When the current model is lost the stored one is used as it is. The
        lockout rules apply. ``Applied.plan["restore"]`` holds the report of
        what changes (dropped accounts, grants added/removed, flags)."""
        with self.locked():
            src = self.load_generation(n)
            try:
                old: Optional[Model] = self.load_model()
            except ApiError:
                old = None
            merged = plan.merge_restore(old, src)
            if old is not None:
                base_gen, cost = old.generation, old.bcrypt_cost
            else:
                header = max(
                    [g for g in (header_generation(_read_bytes(p)) for p in
                                 (self.cfg.rights_path, self.cfg.users_path))
                     if g is not None] or [0])
                base_gen = max([header] + self.generation_numbers())
                cost = src.bcrypt_cost
            new = model_mod.Model(base_gen + 1, model_mod.new_gen_token(),
                                  cost, merged.accounts, merged.grants,
                                  merged.tombstones)
            model_mod.validate(new)
            return self._execute(old, new, actor, dry_run=dry_run,
                                 probe=probe, intent=intent,
                                 report=merged.report)

    # -- start-up reconcile and health ----------------------------------------
    def reconcile(self, *, probe: bool = True) -> dict:
        """Bring managed files and the generation directory in line with the
        model after a crash. Returns ``{"state", "detail"}``; states:
        ``ok``, ``rolled_forward``, ``model_error`` (no/corrupt model: the
        backend then runs read-only), ``validation_failed``."""
        with self.locked():
            return self._reconcile_locked(probe=probe)

    def _reconcile_locked(self, *, probe: bool = True, force: bool = False,
                          event: str = "reconcile") -> dict:
        """``reconcile`` with the lock held. ``force`` rewrites both managed
        files even when they already equal the generated text (used when the
        generation probe says Radicale does not run the current rights)."""
        try:
            model = self.load_model()
        except ApiError as exc:
            return {"state": "model_error", "detail": exc.reason}
        rights, users, _ = generator.generate(model)
        disk_rights = _read_bytes(self.cfg.rights_path)
        disk_users = _read_bytes(self.cfg.users_path)
        same = disk_rights == rights.encode("ascii") \
            and disk_users == users.encode("ascii")
        if same and not force:
            self._ensure_generation_dir(model, rights, users)
            self._drop_orphan_intents(model)
            if probe:
                self._refresh_lkg_locked(model, rights)
            return {"state": "ok", "detail": ""}
        before = (header_generation(disk_rights), header_generation(disk_users))
        try:
            self._validate(model, rights, users)
        except ApiError as exc:
            problem = "; ".join(getattr(exc, "detail", []))
            if event == "reconcile" or self._last_failure != problem:
                self.audit.log(event, actor="system",
                               result="validation_failed",
                               generation=model.generation)
            self._last_failure = problem
            return {"state": "validation_failed",
                    "detail": problem}
        self._last_failure = None
        self._ensure_generation_dir(model, rights, users)
        self._drop_orphan_intents(model)
        try:
            disk_logins = _logins_of(disk_users)
        except ValueError:
            disk_logins = set()
        users_first = self._users_first(disk_logins, set(model.enabled()))
        order = [(self.cfg.users_path, users), (self.cfg.rights_path, rights)]
        if not users_first:
            order.reverse()
        for path, text in order:
            self._write_managed(path, text)
        self._health = None
        active = probe and self.prober.wait_active(model.gen_token)
        if active:
            self._write_lkg(rights)
        behind = any(g is not None and g < model.generation for g in before)
        intent = self._read_intent(model.generation) if behind else None
        if intent is not None and intent["event"] != GENERIC_EVENT:
            # an interrupted change: log it as what it was
            self.audit.log(intent["event"], actor=intent["actor"],
                           ip=intent["ip"], target=intent["target"],
                           result="rolled_forward",
                           generation=model.generation)
            with contextlib.suppress(OSError):
                os.replace(self._intent_path(model.generation),
                           self._intent_path(model.generation,
                                             INTENT_REPLAYED))
        else:
            self.audit.log(event, actor="system",
                           target="rights=%s users=%s" % before,
                           result="rolled_forward",
                           generation=model.generation)
        return {"state": "rolled_forward",
                "detail": "files were at %s/%s" % before}

    def _drop_orphan_intents(self, model: Model) -> None:
        """Remove generation directories that hold only an intent record
        (a change died before the model was written)."""
        for n in self.generation_numbers():
            if n <= model.generation:
                continue
            base = os.path.join(self.cfg.generations_dir, str(n))
            try:
                if sorted(os.listdir(base)) == [INTENT_FILE]:
                    shutil.rmtree(base, ignore_errors=True)
            except OSError:
                pass

    def self_heal(self) -> dict:
        """One pass of the periodic self-check (see ``server.SelfHealer``).

        Skipped (``{"state": "busy"}``) when a change holds the lock: it never
        runs concurrently with a mutation. Otherwise: when the managed files
        differ from what the model generates, or the generation probe says
        Radicale does not run the current rights, the existing reconcile runs
        (full validation first, audit line ``self-heal``). A probe that stays
        negative with correct files (Radicale down) rewrites the files once per
        model generation, not every pass. Returns ``{"state": ...}`` with
        ``ok``, ``busy``, ``model_error``, ``inactive`` or a reconcile state."""
        try:
            with self.locked(timeout=0):
                return self._self_heal_locked()
        except ApiError as exc:
            if exc.reason == "lock_timeout":
                return {"state": "busy", "detail": ""}
            raise

    def _self_heal_locked(self) -> dict:
        try:
            model = self.load_model()
        except ApiError as exc:
            return {"state": "model_error", "detail": exc.reason}
        rights, users, _ = generator.generate(model)
        same = _read_bytes(self.cfg.rights_path) == rights.encode("ascii") \
            and _read_bytes(self.cfg.users_path) == users.encode("ascii")
        active = self.prober.is_active(model.gen_token)
        if same and active:
            self._healed_token = None
            return {"state": "ok", "detail": ""}
        if same and self._healed_token == model.gen_token:
            return {"state": "inactive", "detail": "already rewritten"}
        self._healed_token = model.gen_token if same else None
        return self._reconcile_locked(force=same, event="self-heal")

    def _ensure_generation_dir(self, model: Model, rights: str,
                               users: str) -> None:
        path = os.path.join(self.cfg.generations_dir, str(model.generation),
                            "model.json")
        if not os.path.exists(path):
            self._write_generation(model, rights, users)

    def _refresh_lkg_locked(self, model: Model, rights: str) -> None:
        current = _read_bytes(self.cfg.lkg_path)
        if current == rights.encode("ascii"):
            return
        if self.prober.is_active(model.gen_token):
            self._write_lkg(rights)

    def _model_signature(self) -> object:
        try:
            st = os.stat(self.cfg.model_path)
            return (st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def match_disk(self, model: Model, pairs: List[Tuple[str, str]]
                   ) -> List[str]:
        """Letters Radicale's own engine gives for ``pairs`` on the managed
        files as they are on disk (used by ``GET effective``). Raises
        ``internal`` when the files are not at the model's generation."""
        rights = _read_bytes(self.cfg.rights_path)
        users = _read_bytes(self.cfg.users_path)
        if rights is None or users is None \
                or header_generation(rights) != model.generation:
            raise ApiError("internal", "managed files are not at the current "
                           "generation", reason="files_stale")
        try:
            if self._matcher is not None:
                return self._matcher(rights.decode("ascii"), pairs)
            answer = vc.run_radicale(
                rights.decode("ascii"), users.decode("ascii"), pairs,
                python=self.cfg.radicale_python, plugin_dir=self.cfg.plugin_dir,
                timeout=self.cfg.validate_timeout_s)
        except (vc.CandidateRejected, UnicodeDecodeError):
            raise ApiError("internal", "cannot evaluate the managed files",
                           reason="matcher_failed") from None
        return ["".join(sorted(x)) for x in answer["letters"]]

    def health(self) -> dict:
        """``{ok, generation, active, modelOk}`` (cached for two seconds). When
        the active generation is confirmed and ``rights.lkg`` is stale, the
        last-known-good copy is refreshed (skipped when the lock is busy)."""
        now = time.monotonic()
        sig = self._model_signature()
        cached = self._health
        if cached is not None and now - cached[0] < HEALTH_CACHE_S \
                and cached[2] == sig:
            return dict(cached[1])
        try:
            model = self.current_model()
        except ApiError:
            result = {"ok": False, "generation": self.prober.generation(),
                      "active": False, "modelOk": False}
        else:
            active = self.prober.is_active(model.gen_token)
            on_disk = self.prober.generation()
            result = {"ok": bool(active and on_disk == model.generation),
                      "generation": model.generation, "active": active,
                      "modelOk": True}
            if active:
                self._try_refresh_lkg(model)
        self._health = (now, result, sig)
        return dict(result)

    def _try_refresh_lkg(self, model: Model) -> None:
        rights_bytes = _read_bytes(self.cfg.rights_path)
        if rights_bytes is None or header_generation(rights_bytes) \
                != model.generation:
            return
        if _read_bytes(self.cfg.lkg_path) == rights_bytes:
            return
        try:
            with self.locked(timeout=0.05):
                self._write_lkg(rights_bytes.decode("ascii"))
        except ApiError:
            pass


def _logins_of(users_bytes: Optional[bytes]) -> set:
    out = set()
    if not users_bytes:
        return out
    for line in users_bytes.decode("ascii", "replace").splitlines():
        if line.strip() and not line.startswith("#"):
            login, sep, _ = line.partition(":")
            if sep:
                out.add(login)
    return out
