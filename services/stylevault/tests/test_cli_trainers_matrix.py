from __future__ import annotations

import unittest

from typer.testing import CliRunner

from stylevault.cli import app


class CliTrainerMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()

    def test_trainers_matrix_lists_entries(self) -> None:
        result = self.runner.invoke(app, ["trainers", "matrix"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn("Known-good trainer compatibility matrix", result.stdout)
        self.assertIn("sd-scripts", result.stdout)


if __name__ == "__main__":
    unittest.main()
