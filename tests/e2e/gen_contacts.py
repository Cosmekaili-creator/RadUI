#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Deterministic fictional contacts for the browser suites.

Everything here is invented: names come from short syllable lists, mail addresses use example.org, phone
numbers use the reserved fictional range +1 555 01xx (and its extension 5550100-5550199 style), cities are
made up. The same arguments always give the same cards.

    cards(n, version="3.0", seed=1)   list of (file name, text) with n generated contacts
    core_cards(version)               the hand-made contacts the suites look for by name
    write_dir(directory, items)       write file name -> text pairs below a directory (file-copy seeding)

Command line (writes into a directory, for file-copy seeding of a throwaway Radicale):

    gen_contacts.py DIRECTORY COUNT [--version 3.0|4.0] [--seed N] [--photos PERCENT]
"""
import argparse
import os
import random
import sys

# a valid 1 x 1 pixel JPEG (used as the photo of a few generated contacts)
TINY_JPEG_B64 = ("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////"
                 "////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=")

GIVEN = ["Ada", "Bruno", "Clara", "Dario", "Elena", "Felix", "Gina", "Hugo", "Iris", "Jonas", "Kira", "Leon",
         "Mira", "Nico", "Olga", "Pablo", "Quinn", "Rita", "Sven", "Tara", "Ugo", "Vera", "Wim", "Xena", "Yuri",
         "Zora", "Anke", "Boris", "Cleo", "Dora", "Emil", "Fiona", "Gabe", "Hana", "Ivo", "Jana", "Karl", "Lena"]
FAMILY = ["Alder", "Birch", "Cedar", "Dunmore", "Elmwood", "Fairley", "Grove", "Hartwell", "Ironside", "Juniper",
          "Kestrel", "Linden", "Marlow", "Nettle", "Oakley", "Pinewood", "Quarry", "Rowan", "Sedge", "Thorne",
          "Underhill", "Vale", "Willow", "Yarrow", "Zephyr", "Ashby", "Brook", "Calder", "Dale", "Ember"]
CITIES = ["Sampletown", "Exampleburg", "Testville", "Mockford", "Placeholder Bay", "Fictionia"]
COUNTRIES = ["Exampleland", "Testonia", "Mockland"]
ORGS = ["Example Org", "Sample Works", "Placeholder Ltd", "Demo Studio", "Mock Labs"]

NS = "e2e00000-0000-4000-8000-"


def uid_of(kind, i):
    """Stable UID: kind 1 generated, 2 core, 3 groups."""
    return "urn:uuid:%s%d%011d" % (NS, kind, i)


def fold(line, limit=75):
    """RFC 6350 folding of one logical line, on character (not byte) boundaries."""
    out, cur, size = [], "", 0
    for ch in line:
        b = len(ch.encode("utf-8"))
        if size + b > limit:
            out.append(cur)
            cur, size = " ", 1
        cur += ch
        size += b
    out.append(cur)
    return "\r\n".join(out)


def esc(value):
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def vcard(lines):
    return "\r\n".join(fold(x) for x in lines) + "\r\n"


def generated(i, version="3.0", seed=1, photo=False):
    rnd = random.Random("%d-%d" % (seed, i))
    given = GIVEN[rnd.randrange(len(GIVEN))]
    family = FAMILY[rnd.randrange(len(FAMILY))]
    # a running number makes every name unique and keeps the order stable across versions
    family = "%s%03d" % (family, i % 1000) if i >= 150 else family
    uid = uid_of(1, i)
    fn = "%s %s" % (given, family)
    mail = "%s.%s%d@example.org" % (given.lower(), family.lower().replace(" ", ""), i)
    lines = ["BEGIN:VCARD", "VERSION:%s" % version, "UID:%s" % uid, "FN:%s" % fn, "N:%s;%s;;;" % (family, given)]
    if rnd.random() < 0.6:
        lines.append("ORG:%s" % ORGS[rnd.randrange(len(ORGS))])
    if rnd.random() < 0.8:
        lines.append("EMAIL;TYPE=%s:%s" % ("INTERNET,WORK" if version == "3.0" else "work", mail))
    if rnd.random() < 0.8:
        lines.append("TEL;TYPE=%s:+1 555 01%02d" % ("CELL" if version == "3.0" else "cell", i % 100))
    if rnd.random() < 0.3:
        lines.append("ADR;TYPE=%s:;;%d Sample Road;%s;;%05d;%s" % ("HOME" if version == "3.0" else "home", 1 + i % 99, CITIES[rnd.randrange(len(CITIES))], i % 99999, COUNTRIES[rnd.randrange(len(COUNTRIES))]))
    if rnd.random() < 0.2:
        lines.append("NOTE:%s" % esc("Generated contact number %d.\nSecond line." % i))
    if photo:
        if version == "3.0":
            lines.append("PHOTO;ENCODING=b;TYPE=JPEG:" + TINY_JPEG_B64)
        else:
            lines.append("PHOTO:data:image/jpeg;base64," + TINY_JPEG_B64)
    lines.append("END:VCARD")
    return "gen-%05d.vcf" % i, vcard(lines)


def cards(n, version="3.0", seed=1, photo_percent=5, start=0):
    out = []
    step = int(100 / photo_percent) if photo_percent else 0
    for i in range(start, start + n):
        out.append(generated(i, version, seed, photo=bool(step) and i % step == 0))
    return out


# ------------------------------------------------------------------------------------------ the core set

# (key, given, family, org, mail, phone). Names that start with different letters, one accented, one with a
# ligature, one with no family name, and a few that share a word, so list, search and A-Z have something to find.
CORE = [
    ("jane", "Jane", "Doe", "Example Org", "jane.doe@example.org", "+1 555 0123"),
    ("rick", "Rick", "Roe", "Sample Works", "rick.roe@example.org", "+1 555 0124"),
    ("zoe", "Zoe", "Zimmer", "", "zoe.zimmer@example.org", "+1 555 0125"),
    ("elodie", "Élodie", "Dubois", "Demo Studio", "elodie.dubois@example.org", "+1 555 0126"),
    ("oeuvre", "Cœur", "Dupont", "", "coeur.dupont@example.org", "+1 555 0127"),
    ("abe", "Abe", "Archer", "Placeholder Ltd", "abe.archer@example.org", "+1 555 0128"),
    ("jane2", "Jane", "Dorsey", "Mock Labs", "jane.dorsey@example.org", "+1 555 0129"),
    ("numeric", "Agent", "007 Example", "", "agent.007@example.org", "+1 555 0130"),
    ("carl", "Carl", "Baker", "", "carl.baker@example.org", "+1 555 0131"),
]


def core_uid(key):
    return "urn:uuid:%s%s" % ("c0de0000-0000-4000-8000-", ("%012x" % (abs(hash_key(key)) % (16 ** 12))))


def hash_key(key):
    h = 0
    for ch in key:
        h = (h * 131 + ord(ch)) % (16 ** 12)
    return h


def core_cards(version="3.0"):
    """The named contacts of the suites, with fixed UIDs. Returns {key: (file name, text, uid)}."""
    out = {}
    for key, given, family, org, mail, phone in CORE:
        uid = core_uid(key)
        lines = ["BEGIN:VCARD", "VERSION:%s" % version, "UID:%s" % uid, "FN:%s %s" % (given, family),
                 "N:%s;%s;;;" % (family, given)]
        if org:
            lines.append("ORG:%s" % org)
        lines.append("EMAIL;TYPE=%s:%s" % ("INTERNET,HOME" if version == "3.0" else "home", mail))
        lines.append("TEL;TYPE=%s:%s" % ("CELL" if version == "3.0" else "cell", phone))
        if key == "jane":
            lines.append("NOTE:Fictional contact used by the browser suites.")
            lines.append("BDAY:1990-04-12")
            lines.append("CATEGORIES:friends")
        lines.append("END:VCARD")
        out[key] = ("core-%s.vcf" % key, vcard(lines), uid)
    return out


def apple_group(name, member_uids, key):
    """An Apple-form group card (vCard 3.0)."""
    uid = "urn:uuid:" + "9a0e0000-0000-4000-8000-%012x" % hash_key(key)
    lines = ["BEGIN:VCARD", "VERSION:3.0", "UID:%s" % uid, "X-ADDRESSBOOKSERVER-KIND:group", "FN:%s" % name,
             "N:%s;;;;" % name]
    lines += ["X-ADDRESSBOOKSERVER-MEMBER:%s" % m for m in member_uids]
    lines.append("END:VCARD")
    return "group-%s.vcf" % key, vcard(lines), uid


def kind_group(name, member_uids, key):
    """An RFC 6350 group card (vCard 4.0)."""
    uid = "urn:uuid:" + "9a0e0000-0000-4000-8000-%012x" % hash_key("k" + key)
    lines = ["BEGIN:VCARD", "VERSION:4.0", "UID:%s" % uid, "KIND:group", "FN:%s" % name]
    lines += ["MEMBER:%s" % m for m in member_uids]
    lines.append("END:VCARD")
    return "group-%s.vcf" % key, vcard(lines), uid


def write_dir(directory, items):
    os.makedirs(directory, exist_ok=True)
    for name, text in items:
        with open(os.path.join(directory, name), "w", encoding="utf-8", newline="") as fh:
            fh.write(text)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("directory")
    ap.add_argument("count", type=int)
    ap.add_argument("--version", default="3.0", choices=["3.0", "4.0"])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--photos", type=int, default=5, help="percent of cards with a photo (0 for none)")
    args = ap.parse_args(argv)
    write_dir(args.directory, cards(args.count, args.version, args.seed, args.photos))
    print("wrote %d cards to %s" % (args.count, args.directory))
    return 0


if __name__ == "__main__":
    sys.exit(main())
