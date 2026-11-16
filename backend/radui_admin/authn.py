# SPDX-License-Identifier: AGPL-3.0-or-later
"""Authentication by forwarding the caller's Basic credentials to Radicale.

The backend keeps no credential store. For every request it parses the
``Authorization: Basic`` header strictly and sends the same header to Radicale
as ``PROPFIND / Depth: 0``:

* ``207``: Radicale authenticated that login (every login may read the root);
* ``401``: unauthenticated;
* anything else, or no answer: ``502 radicale_unexpected``.

There is no cache: a disabled account or a changed password stops working on
the next request. The backend never sends ``WWW-Authenticate`` (the browser
must not open its own password dialog).

Parsing rules: header at most 1 KiB, scheme ``Basic``, strict base64, UTF-8,
the login must pass the login whitelist (lower case), the password at most 72
bytes (Radicale silently truncates longer ones, so anything longer is
refused instead). ``X-Forwarded-For`` sent to Radicale (it appears in
Radicale's failed-login log line used by fail2ban) is the validated address
from the trusted proxy header, else the peer address.

The same client also does the two follow-up reads that need the caller's own
rights: counting the collections of a principal and checking that a path is a
calendar or address book.
"""
import base64
import binascii
import http.client
import ipaddress
import re
import xml.etree.ElementTree as ET
from typing import Any, Mapping, Optional, Sequence, Tuple
from urllib.parse import quote

from . import names
from .config import Config
from .names import ApiError

MAX_AUTH_HEADER = 1024
MAX_PASSWORD_BYTES = 72
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_DAV = "{DAV:}"
_CALENDAR = "{urn:ietf:params:xml:ns:caldav}calendar"
_ADDRESSBOOK = "{urn:ietf:params:xml:ns:carddav}addressbook"
_RESOURCETYPE_BODY = (b'<?xml version="1.0" encoding="utf-8"?>'
                      b'<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/>'
                      b'</D:prop></D:propfind>')


def _unauth(message: str = "missing or invalid credentials") -> ApiError:
    return ApiError("unauthenticated", message, reason="unauthenticated")


def parse_basic(header: Optional[str]) -> Tuple[str, str]:
    """Return ``(login, password)`` from a Basic header or raise
    ``unauthenticated`` (nothing is sent to Radicale in that case)."""
    if not header or len(header) > MAX_AUTH_HEADER:
        raise _unauth()
    scheme, sep, token = header.partition(" ")
    if not sep or scheme.lower() != "basic":
        raise _unauth()
    token = token.strip()
    if not token or not token.isascii():
        raise _unauth()
    try:
        raw = base64.b64decode(token, validate=True)
        text = raw.decode("utf-8")
    except (binascii.Error, ValueError):
        raise _unauth() from None
    login, colon, password = text.partition(":")
    if not colon or not names.is_valid_login(login):
        raise _unauth()
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise _unauth()
    return login, password


_ADDR_CHARS_RE = re.compile(r"[0-9A-Fa-f:.]{2,45}")
#: Address used when not even the TCP peer is a usable address.
UNKNOWN_ADDRESS = "0.0.0.0"
DEFAULT_TRUSTED = tuple(ipaddress.ip_network(n) for n in
                        ("127.0.0.1/32", "::1/128"))


def validated_address(value: str) -> Optional[str]:
    """Canonical text of a plain IPv4/IPv6 address, or ``None``. Scoped
    addresses (``%``), names, lists, spaces and control characters are all
    refused: the result may safely be forwarded and logged."""
    if not isinstance(value, str) or _ADDR_CHARS_RE.fullmatch(value) is None:
        return None
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


def _in_networks(address: str, networks: Sequence[Any]) -> bool:
    ip = ipaddress.ip_address(address)
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return any(ip.version == n.version and ip in n for n in networks)


def client_ip(headers: Mapping[str, str], peer: str, trusted_header: str,
              trusted_networks: Optional[Sequence[Any]] = None) -> str:
    """The client address used for rate limits and forwarded to Radicale.

    The trusted proxy header is honoured only when the TCP peer is one of
    ``trusted_networks`` (default: loopback) and then only when its whole value
    is one plain address (no scope id, no list, no other characters). In every
    other case the peer address is used, itself reduced to a plain address
    (``UNKNOWN_ADDRESS`` when it is not one). The result is always a validated
    address."""
    nets = DEFAULT_TRUSTED if trusted_networks is None else trusted_networks
    peer_addr = validated_address(peer.split("%", 1)[0]) or UNKNOWN_ADDRESS
    if not _in_networks(peer_addr, nets):
        return peer_addr
    value = headers.get(trusted_header.lower(), "").strip()
    return validated_address(value) or peer_addr


class RadicaleClient:
    """Small HTTP client for the requests the backend makes to Radicale."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg

    def _request(self, method: str, path: str, auth: str, ip: str,
                 depth: str, body: Optional[bytes] = None
                 ) -> Tuple[int, bytes]:
        ip = validated_address(ip) or UNKNOWN_ADDRESS  # never forward raw text
        https, host, port = self._cfg.radicale_parts
        cls = http.client.HTTPSConnection if https \
            else http.client.HTTPConnection
        conn = cls(host, port, timeout=self._cfg.radicale_timeout_s)
        headers = {"Authorization": auth, "Depth": depth,
                   "X-Forwarded-For": ip, "Connection": "close",
                   "User-Agent": "radui-admin"}
        if body is not None:
            headers["Content-Type"] = "application/xml; charset=utf-8"
        try:
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise ApiError("radicale_unexpected",
                               "Radicale answer too large",
                               reason="too_large")
            return resp.status, data
        except (OSError, http.client.HTTPException):
            raise ApiError("radicale_unexpected",
                           "Radicale did not answer as expected",
                           reason="unreachable") from None
        finally:
            conn.close()

    @staticmethod
    def _unexpected(status: int) -> ApiError:
        return ApiError("radicale_unexpected",
                        "Radicale answered HTTP %d" % status,
                        reason="status_%d" % status)

    def authenticate(self, auth: str, ip: str) -> bool:
        """True: Radicale accepted the credentials (207). False: 401."""
        status, _ = self._request("PROPFIND", "/", auth, ip, "0")
        if status == 207:
            return True
        if status == 401:
            return False
        raise self._unexpected(status)

    @staticmethod
    def _parse(data: bytes) -> ET.Element:
        low = data[:4096].lower()
        if b"<!doctype" in low or b"<!entity" in data.lower():
            raise ApiError("radicale_unexpected", "unexpected XML",
                           reason="bad_xml")
        try:
            return ET.fromstring(data)
        except ET.ParseError:
            raise ApiError("radicale_unexpected", "unreadable XML answer",
                           reason="bad_xml") from None

    def count_collections(self, auth: str, ip: str, login: str) -> int:
        """Number of collections inside the principal ``login`` (0 when the
        principal does not exist yet), listed with the caller's rights."""
        path = "/%s/" % quote(login, safe="")
        status, data = self._request("PROPFIND", path, auth, ip, "1",
                                     _RESOURCETYPE_BODY)
        if status == 404:
            return 0
        if status == 401:
            raise _unauth()
        if status != 207:
            raise self._unexpected(status)
        root = self._parse(data)
        own = path.rstrip("/")
        count = 0
        for resp in root.iter(_DAV + "response"):
            href = resp.findtext(_DAV + "href") or ""
            if href.rstrip("/") != own:
                count += 1
        return count

    def collection_kind(self, auth: str, ip: str, owner: str,
                        collection: str) -> Optional[str]:
        """``"calendar"``, ``"addressbook"``, ``"other"`` or ``None`` (404),
        read with the caller's rights (403 raises ``forbidden``)."""
        path = "/%s/%s/" % (quote(owner, safe=""), quote(collection, safe=""))
        status, data = self._request("PROPFIND", path, auth, ip, "0",
                                     _RESOURCETYPE_BODY)
        if status == 404:
            return None
        if status == 403:
            raise ApiError("forbidden", "you may not use this collection",
                           reason="no_access")
        if status == 401:
            raise _unauth()
        if status != 207:
            raise self._unexpected(status)
        root = self._parse(data)
        for rtype in root.iter(_DAV + "resourcetype"):
            tags = {child.tag for child in rtype}
            if _CALENDAR in tags:
                return "calendar"
            if _ADDRESSBOOK in tags:
                return "addressbook"
        return "other"
