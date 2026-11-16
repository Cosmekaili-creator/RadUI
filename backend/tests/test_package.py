# SPDX-License-Identifier: AGPL-3.0-or-later
"""Smoke test: the backend package is importable from a source checkout."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


class PackageSmoke(unittest.TestCase):
    def test_import(self):
        import radui_admin
        self.assertTrue(radui_admin.__version__)


if __name__ == "__main__":
    unittest.main()
