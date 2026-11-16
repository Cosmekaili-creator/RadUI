# SPDX-License-Identifier: AGPL-3.0-or-later
"""Backend configuration: one TOML file, strict validation, neutral defaults.

The file path comes from ``--config`` or the ``RADUI_CONFIG`` environment
variable (default ``/etc/radui/config.toml``). The file is read with the
standard library ``tomllib``. Unknown keys, wrong types and out-of-range
values are refused (:class:`ConfigError`); the backend does not start on an
invalid configuration. ``allowed_hosts`` has no default: a deployment must say
which ``Host`` header values it serves.

The file holds no secrets. It is refused when group- or world-writable.
See ``backend/config.example.toml`` for every key.
"""
import dataclasses
import ipaddress
import os
import re
import tomllib
from typing import Any, Dict, Mapping, Optional, Tuple
from urllib.parse import urlsplit

DEFAULT_CONFIG_PATH = "/etc/radui/config.toml"
ENV_CONFIG = "RADUI_CONFIG"

_HOST_RE = re.compile(
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}"
    r"[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?")
_ORIGIN_RE = re.compile(
    r"https?://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9]"
    r"(?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?")
_HEADER_NAME_RE = re.compile(r"[A-Za-z0-9-]{1,64}")
_GROUP_RE = re.compile(r"[a-z_][a-z0-9_-]{0,31}")
_BASE_PATH_RE = re.compile(r"/[A-Za-z0-9._~/-]*")


class ConfigError(Exception):
    """The configuration is invalid; the message names the key."""


@dataclasses.dataclass(frozen=True)
class Config:
    radicale_url: str = "http://127.0.0.1:5232"
    listen: str = "127.0.0.1:5233"
    base_path: str = "/ui/api"
    allowed_hosts: Tuple[str, ...] = ()
    allowed_origins: Tuple[str, ...] = ()
    trusted_proxy_header: str = "X-Real-IP"
    trusted_proxies: Tuple[str, ...] = ("127.0.0.1", "::1")
    managed_dir: str = "/etc/radui/managed"
    state_dir: str = "/var/lib/radui"
    radicale_group: str = ""
    radicale_python: str = "/usr/bin/python3"
    plugin_dir: str = ""
    bcrypt_cost: int = 12
    rate_limit_failures: int = 10
    rate_limit_window_s: int = 600
    rate_limit_block_s: int = 900
    requests_per_minute: int = 300
    requests_burst: int = 60
    extra_reserved_logins: Tuple[str, ...] = ()
    max_accounts: int = 200
    max_grants: int = 2000
    max_body_bytes: int = 16384
    socket_timeout_s: float = 15.0
    radicale_timeout_s: float = 10.0
    lock_timeout_s: float = 10.0
    probe_budget_s: float = 3.0
    validate_timeout_s: float = 20.0
    self_heal_interval_s: float = 60.0
    allow_unchecked_users: bool = False

    # -- derived values -------------------------------------------------
    @property
    def listen_host(self) -> str:
        return self.listen.rsplit(":", 1)[0]

    @property
    def listen_port(self) -> int:
        return int(self.listen.rsplit(":", 1)[1])

    @property
    def radicale_parts(self) -> Tuple[bool, str, int]:
        """``(https, host, port)`` of ``radicale_url``."""
        u = urlsplit(self.radicale_url)
        https = u.scheme == "https"
        return https, u.hostname or "", u.port or (443 if https else 80)

    @property
    def effective_origins(self) -> Tuple[str, ...]:
        """``allowed_origins``, or ``https://<host>`` for every allowed host
        when none is configured."""
        if self.allowed_origins:
            return self.allowed_origins
        return tuple("https://" + h for h in self.allowed_hosts)

    @property
    def trusted_networks(self) -> Tuple[Any, ...]:
        """``trusted_proxies`` as ``ipaddress`` network objects."""
        return tuple(ipaddress.ip_network(t, strict=False)
                     for t in self.trusted_proxies)

    @property
    def api_prefix(self) -> str:
        return self.base_path.rstrip("/") + "/"

    @property
    def model_path(self) -> str:
        return os.path.join(self.state_dir, "model.json")

    @property
    def lock_path(self) -> str:
        return os.path.join(self.state_dir, ".lock")

    @property
    def generations_dir(self) -> str:
        return os.path.join(self.state_dir, "generations")

    @property
    def rights_path(self) -> str:
        return os.path.join(self.managed_dir, "rights")

    @property
    def users_path(self) -> str:
        return os.path.join(self.managed_dir, "users")

    @property
    def lkg_path(self) -> str:
        return os.path.join(self.managed_dir, "rights.lkg")


# -- field validators -----------------------------------------------------

def _int(key: str, value: Any, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError("%s must be an integer" % key)
    if not lo <= value <= hi:
        raise ConfigError("%s must be between %d and %d" % (key, lo, hi))
    return value


def _num(key: str, value: Any, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError("%s must be a number" % key)
    if not lo <= value <= hi:
        raise ConfigError("%s must be between %s and %s" % (key, lo, hi))
    return float(value)


def _str(key: str, value: Any, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ConfigError("%s must be a string" % key)
    if not allow_empty and not value:
        raise ConfigError("%s must not be empty" % key)
    if any(ord(c) < 32 or ord(c) == 127 for c in value) or len(value) > 1024:
        raise ConfigError("%s contains control characters or is too long" % key)
    return value


def _str_list(key: str, value: Any, maxlen: int = 100) -> Tuple[str, ...]:
    if not isinstance(value, list) or len(value) > maxlen:
        raise ConfigError("%s must be a list of at most %d strings"
                          % (key, maxlen))
    out = []
    for item in value:
        out.append(_str(key, item))
    return tuple(out)


def _abs_path(key: str, value: Any, allow_empty: bool = False) -> str:
    value = _str(key, value, allow_empty)
    if value and not os.path.isabs(value):
        raise ConfigError("%s must be an absolute path" % key)
    return value


def _radicale_url(value: Any) -> str:
    value = _str("radicale_url", value)
    u = urlsplit(value)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ConfigError("radicale_url must look like http://host:port")
    if u.username or u.password or u.query or u.fragment \
            or u.path not in ("", "/"):
        raise ConfigError("radicale_url must have no credentials, path, "
                          "query or fragment")
    try:
        u.port
    except ValueError:
        raise ConfigError("radicale_url has an invalid port") from None
    return "%s://%s%s" % (u.scheme, u.netloc, "")


def _listen(value: Any) -> str:
    value = _str("listen", value)
    host, sep, port = value.rpartition(":")
    if not sep or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ConfigError("listen must be <ip>:<port>")
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        raise ConfigError("listen host must be an IP address") from None
    if not ip.is_loopback:
        raise ConfigError("listen must be a loopback address (the backend "
                          "trusts the reverse proxy header)")
    return value


def _hosts(value: Any) -> Tuple[str, ...]:
    hosts = _str_list("allowed_hosts", value)
    if not hosts:
        raise ConfigError("allowed_hosts must list at least one host")
    out = []
    for h in hosts:
        low = h.lower()
        if _HOST_RE.fullmatch(low) is None:
            raise ConfigError("allowed_hosts entry %r is not a host[:port]"
                              % h)
        out.append(low)
    return tuple(out)


def _origins(value: Any) -> Tuple[str, ...]:
    origins = _str_list("allowed_origins", value)
    out = []
    for o in origins:
        low = o.lower()
        if _ORIGIN_RE.fullmatch(low) is None:
            raise ConfigError("allowed_origins entry %r must look like "
                              "https://host[:port] (no path)" % o)
        out.append(low)
    return tuple(out)


def _group(value: Any) -> str:
    value = _str("radicale_group", value, allow_empty=True)
    if value and _GROUP_RE.fullmatch(value) is None:
        raise ConfigError("radicale_group is not a valid group name")
    return value


def _reserved(value: Any) -> Tuple[str, ...]:
    out = []
    for item in _str_list("extra_reserved_logins", value, 500):
        low = item.lower()
        if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,31}", low) is None:
            raise ConfigError("extra_reserved_logins entry %r is not a "
                              "login-shaped string" % item)
        out.append(low)
    return tuple(out)


def _header(value: Any) -> str:
    value = _str("trusted_proxy_header", value)
    if _HEADER_NAME_RE.fullmatch(value) is None:
        raise ConfigError("trusted_proxy_header is not a header name")
    return value


_PROXY_RE = re.compile(r"[0-9A-Fa-f:.]{2,45}(?:/[0-9]{1,3})?")


def _proxies(value: Any) -> Tuple[str, ...]:
    out = []
    for item in _str_list("trusted_proxies", value, 64):
        # no scope ids ('%'), no names, no spaces: only address characters
        if _PROXY_RE.fullmatch(item) is None:
            raise ConfigError("trusted_proxies entry %r is not an IP address "
                              "or CIDR network" % item)
        try:
            out.append(str(ipaddress.ip_network(item, strict=False)))
        except ValueError:
            raise ConfigError("trusted_proxies entry %r is not an IP address "
                              "or CIDR network" % item) from None
    return tuple(out)


def _bool(key: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise ConfigError("%s must be true or false" % key)
    return value


def _interval(key: str, value: Any) -> float:
    """0 (off) or 1 to 86400 seconds."""
    num = _num(key, value, 0, 86400)
    if 0 < num < 1:
        raise ConfigError("%s must be 0 (off) or at least 1" % key)
    return num


def _base_path(value: Any) -> str:
    value = _str("base_path", value)
    if _BASE_PATH_RE.fullmatch(value) is None or ".." in value \
            or "//" in value:
        raise ConfigError("base_path must be an absolute URL path")
    return value.rstrip("/") or "/"


_SPEC = {
    "radicale_url": _radicale_url,
    "listen": _listen,
    "base_path": _base_path,
    "allowed_hosts": _hosts,
    "allowed_origins": _origins,
    "trusted_proxy_header": _header,
    "trusted_proxies": _proxies,
    "managed_dir": lambda v: _abs_path("managed_dir", v),
    "state_dir": lambda v: _abs_path("state_dir", v),
    "radicale_group": _group,
    "radicale_python": lambda v: _abs_path("radicale_python", v),
    "plugin_dir": lambda v: _abs_path("plugin_dir", v, allow_empty=True),
    "bcrypt_cost": lambda v: _int("bcrypt_cost", v, 4, 16),
    "rate_limit_failures": lambda v: _int("rate_limit_failures", v, 1, 10000),
    "rate_limit_window_s": lambda v: _int("rate_limit_window_s", v, 1, 86400),
    "rate_limit_block_s": lambda v: _int("rate_limit_block_s", v, 1, 86400),
    "requests_per_minute": lambda v: _int("requests_per_minute", v, 0, 100000),
    "requests_burst": lambda v: _int("requests_burst", v, 1, 100000),
    "extra_reserved_logins": _reserved,
    "max_accounts": lambda v: _int("max_accounts", v, 1, 200),
    "max_grants": lambda v: _int("max_grants", v, 1, 2000),
    "max_body_bytes": lambda v: _int("max_body_bytes", v, 256, 65536),
    "socket_timeout_s": lambda v: _num("socket_timeout_s", v, 1, 120),
    "radicale_timeout_s": lambda v: _num("radicale_timeout_s", v, 1, 60),
    "lock_timeout_s": lambda v: _num("lock_timeout_s", v, 0.1, 120),
    "probe_budget_s": lambda v: _num("probe_budget_s", v, 0.3, 30),
    "validate_timeout_s": lambda v: _num("validate_timeout_s", v, 1, 300),
    "self_heal_interval_s": lambda v: _interval("self_heal_interval_s", v),
    "allow_unchecked_users": lambda v: _bool("allow_unchecked_users", v),
}
REQUIRED = ("allowed_hosts",)


def from_dict(data: Mapping[str, Any]) -> Config:
    """Validate a parsed TOML mapping and return a :class:`Config`."""
    if not isinstance(data, Mapping):
        raise ConfigError("configuration must be a table")
    unknown = sorted(set(data) - set(_SPEC))
    if unknown:
        raise ConfigError("unknown configuration key: %s" % unknown[0])
    for key in REQUIRED:
        if key not in data:
            raise ConfigError("%s is required" % key)
    values: Dict[str, Any] = {k: _SPEC[k](v) for k, v in data.items()}
    cfg = Config(**values)
    if cfg.state_dir == cfg.managed_dir:
        raise ConfigError("state_dir and managed_dir must differ")
    return cfg


def check_file_mode(path: str) -> None:
    """Refuse a configuration file that group or others can write."""
    st = os.stat(path)
    if st.st_mode & 0o022:
        raise ConfigError("%s is group- or world-writable" % path)


def resolve_path(explicit: Optional[str] = None,
                 environ: Optional[Mapping[str, str]] = None) -> str:
    env = os.environ if environ is None else environ
    return explicit or env.get(ENV_CONFIG) or DEFAULT_CONFIG_PATH


def load(path: Optional[str] = None,
         environ: Optional[Mapping[str, str]] = None) -> Config:
    """Read, check and validate the configuration file."""
    path = resolve_path(path, environ)
    try:
        check_file_mode(path)
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except OSError as exc:
        raise ConfigError("cannot read %s: %s" % (path, exc.strerror)) from None
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError("%s is not valid TOML: %s" % (path, exc)) from None
    return from_dict(data)
