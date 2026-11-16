#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Generate the two large synthetic PHOTO fixtures (stdlib only, deterministic).

  tests/fixtures/vcf/vcard40-photo-100k.vcf   vCard 4.0, PHOTO:data:image/jpeg;base64,... (~100 KiB)
  tests/fixtures/vcf/vcard30-photo-b-20k.vcf  vCard 3.0, PHOTO;ENCODING=b;TYPE=JPEG:...   (~20 KiB)

The image bytes are pseudo-random (SHA-256 counter stream) behind a JPEG-looking
header and trailer: they are not a real picture and carry no personal data.
Lines are folded at 75 octets and use CRLF. The same seed always gives the same files.
"""
import argparse
import base64
import hashlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "fixtures", "vcf")


def synthetic_jpeg(size, seed):
    head = bytes.fromhex("ffd8ffe000104a46494600010100000100010000")
    out = bytearray(head)
    counter = 0
    while len(out) < size - 2:
        out += hashlib.sha256(("%s:%d" % (seed, counter)).encode()).digest()
        counter += 1
    return bytes(out[: size - 2]) + b"\xff\xd9"


def fold(line, width=75):
    """Fold at `width` octets (ASCII only here); continuation lines hold width-1 characters."""
    parts = [line[:width]]
    rest = line[width:]
    while rest:
        parts.append(" " + rest[: width - 1])
        rest = rest[width - 1:]
    return parts


def card(lines):
    out = []
    for ln in lines:
        out.extend(fold(ln))
    return "\r\n".join(out) + "\r\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="radui-photo-1")
    ap.add_argument("--out", default=FIXTURES)
    a = ap.parse_args()
    big = base64.b64encode(synthetic_jpeg(100 * 1024, a.seed + ":big")).decode()
    small = base64.b64encode(synthetic_jpeg(20 * 1024, a.seed + ":small")).decode()
    files = {
        "vcard40-photo-100k.vcf": card([
            "BEGIN:VCARD", "VERSION:4.0", "UID:urn:uuid:aaaaaaaa-bbbb-cccc-dddd-000000000010",
            "FN:Penny Picture", "N:Picture;Penny;;;", "EMAIL;TYPE=work:penny@example.org",
            "PHOTO:data:image/jpeg;base64," + big, "REV:20260101T000000Z", "END:VCARD"]),
        "vcard30-photo-b-20k.vcf": card([
            "BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Example Contacts//Contacts 1.0//EN",
            "UID:urn:uuid:aaaaaaaa-bbbb-cccc-dddd-000000000011", "FN:Piers Portrait", "N:Portrait;Piers;;;",
            "TEL;TYPE=CELL:+1 555 0150", "PHOTO;ENCODING=b;TYPE=JPEG:" + small,
            "REV:2026-01-01T00:00:00Z", "END:VCARD"]),
    }
    for name, text in files.items():
        with open(os.path.join(a.out, name), "w", newline="") as fh:
            fh.write(text)
        print("%s: %d bytes" % (name, len(text)))


if __name__ == "__main__":
    main()
