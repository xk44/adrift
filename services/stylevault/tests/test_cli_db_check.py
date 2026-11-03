from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from typer.testing import CliRunner

from stylevault import db
from stylevault.cli import app


class CliDbCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()

    def _write_config(self, root: Path, db_path: Path) -> Path:
        config_path = root / "config.toml"
        config_path.write_text(
            "\n".join(
                [
                    "[paths]",
                    f'db_path = "{db_path}"',
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        return config_path

    def test_db_check_reports_and_repairs_missing_indexes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "vault.sqlite"
            db.init_db(db_path)
            with db.connect(db_path) as connection:
                connection.execute("DROP INDEX IF EXISTS idx_tags_source_tag")
                connection.commit()

            config_path = self._write_config(root, db_path)
            result = self.runner.invoke(
                app,
                ["db", "check", "--config", str(config_path)],
            )
            self.assertEqual(result.exit_code, 0)
            self.assertIn("Database checks found issues", result.stdout)
            self.assertIn("idx_tags_source_tag", result.stdout)

            fix_result = self.runner.invoke(
                app,
                ["db", "check", "--fix", "--config", str(config_path)],
            )
            self.assertEqual(fix_result.exit_code, 0)
            self.assertIn("Repairs applied.", fix_result.stdout)

            verify_result = self.runner.invoke(
                app,
                ["db", "check", "--config", str(config_path)],
            )
            self.assertEqual(verify_result.exit_code, 0)
            self.assertIn("Database checks passed.", verify_result.stdout)


if __name__ == "__main__":
    unittest.main()
