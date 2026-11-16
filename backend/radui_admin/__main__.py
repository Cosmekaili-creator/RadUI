# SPDX-License-Identifier: AGPL-3.0-or-later
"""``python3 -I -m radui_admin serve|<cli command>`` (the launchers in
``backend/bin`` do the same with an explicit ``sys.path``)."""
import sys

from . import cli, server


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "serve":
        return server.main(argv[1:])
    return cli.main(argv)


if __name__ == "__main__":
    sys.exit(main())
