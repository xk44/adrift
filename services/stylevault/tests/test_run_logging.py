from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

from stylevault.run_logging import build_run_log_payload


class RunLoggingTests(unittest.TestCase):
    def test_run_log_payload_includes_timing_and_stats(self) -> None:
        started_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        ended_at = started_at + timedelta(seconds=12)
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.toml"
            config_path.write_text("foo = 1\n", encoding="utf-8")
            payload = build_run_log_payload(
                command="scan",
                config_path=config_path,
                config_fallback=None,
                started_at=started_at,
                ended_at=ended_at,
                stats={"scanned": 5},
                runtime={"device": "cpu", "batch_size": None, "libraries": {}},
            )

        self.assertIn("run", payload)
        self.assertIn("stats", payload)
        self.assertEqual(payload["stats"]["scanned"], 5)
        self.assertIn("elapsed_seconds", payload["run"])
        self.assertEqual(payload["run"]["elapsed_seconds"], 12.0)
        self.assertIn("config", payload)
        self.assertEqual(payload["config"]["path"], str(config_path))

    def test_run_log_payload_defaults_stats_when_missing(self) -> None:
        started_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        ended_at = started_at + timedelta(seconds=1)
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.toml"
            config_path.write_text("foo = 1\n", encoding="utf-8")
            payload = build_run_log_payload(
                command="embed",
                config_path=config_path,
                config_fallback=None,
                started_at=started_at,
                ended_at=ended_at,
                stats=None,
            )

        self.assertEqual(payload["stats"], {})
        self.assertIn("run", payload)


if __name__ == "__main__":
    unittest.main()
