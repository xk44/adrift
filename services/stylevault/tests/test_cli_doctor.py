from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from typer.testing import CliRunner

from stylevault.cli import app


class CliDoctorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()

    def test_doctor_reports_missing_database(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "vault.sqlite"
            config_path = root / "config.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[paths]",
                        f"db_path = \"{db_path}\"",
                        "",
                        "[vector_store]",
                        "backend = \"sqlite\"",
                        "",
                        "[trainers]",
                        "default_device = \"cpu\"",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = self.runner.invoke(app, ["doctor", "--config", str(config_path)])
            self.assertEqual(result.exit_code, 0)
            self.assertIn("StyleVault doctor report:", result.stdout)
            self.assertIn("Database not found", result.stdout)
            self.assertIn("stylevault init", result.stdout)


if __name__ == "__main__":
    unittest.main()
