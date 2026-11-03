from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from typer.testing import CliRunner

from stylevault.cli import app


class CliLogsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()

    def _write_config(self, root: Path, logs_dir: Path) -> Path:
        config_path = root / "config.toml"
        config_path.write_text(
            "\n".join(
                [
                    "[paths]",
                    f"logs_dir = \"{logs_dir}\"",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        return config_path

    def test_logs_list_and_show_latest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            logs_dir = root / "logs"
            logs_dir.mkdir(parents=True)
            payload = {
                "command": "scan",
                "run": {
                    "started_at": "2024-01-01T00:00:00Z",
                    "ended_at": "2024-01-01T00:00:10Z",
                    "elapsed_seconds": 10.0,
                },
            }
            log_path = logs_dir / "scan-20240101T000000Z.json"
            log_path.write_text(json.dumps(payload), encoding="utf-8")
            config_path = self._write_config(root, logs_dir)

            result = self.runner.invoke(
                app,
                ["logs", "list", "--config", str(config_path)],
            )
            self.assertEqual(result.exit_code, 0)
            self.assertIn("scan", result.stdout)
            self.assertIn(str(log_path), result.stdout)

            show_result = self.runner.invoke(
                app,
                ["logs", "show", "latest", "--config", str(config_path)],
            )
            self.assertEqual(show_result.exit_code, 0)
            self.assertIn("\"command\": \"scan\"", show_result.stdout)


if __name__ == "__main__":
    unittest.main()
