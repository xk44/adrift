from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from typer.testing import CliRunner

from stylevault.cli import app


class CliRunLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()

    def _write_config(self, root: Path) -> Path:
        data_dir = root / "stylevault"
        config_path = root / "config.toml"
        config_path.write_text(
            "\n".join(
                [
                    "[paths]",
                    f"data_dir = \"{data_dir}\"",
                    f"db_path = \"{data_dir / 'vault.sqlite'}\"",
                    f"thumbs_dir = \"{data_dir / 'thumbs'}\"",
                    f"exports_dir = \"{data_dir / 'exports'}\"",
                    f"logs_dir = \"{data_dir / 'logs'}\"",
                    f"indices_dir = \"{data_dir / 'indices'}\"",
                    f"models_dir = \"{data_dir / 'models'}\"",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        return config_path

    def _create_image(self, root: Path) -> Path:
        image_dir = root / "images"
        image_dir.mkdir(parents=True, exist_ok=True)
        image_path = image_dir / "sample.png"
        image = Image.new("RGB", (16, 16), color=(12, 34, 56))
        image.save(image_path)
        return image_path

    def test_log_run_outputs_for_core_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            config_path = self._write_config(root)
            image_path = self._create_image(root)

            init_result = self.runner.invoke(app, ["init", "--config", str(config_path)])
            self.assertEqual(init_result.exit_code, 0)

            scan_result = self.runner.invoke(
                app,
                [
                    "scan",
                    str(image_path.parent),
                    "--log-run",
                    "--config",
                    str(config_path),
                ],
            )
            self.assertEqual(scan_result.exit_code, 0)

            embed_result = self.runner.invoke(
                app,
                [
                    "embed",
                    "--model",
                    "color-histogram",
                    "--log-run",
                    "--config",
                    str(config_path),
                ],
            )
            self.assertEqual(embed_result.exit_code, 0)

            caption_result = self.runner.invoke(
                app,
                [
                    "caption",
                    "--model",
                    "filename",
                    "--caption-type",
                    "long",
                    "--log-run",
                    "--config",
                    str(config_path),
                ],
            )
            self.assertEqual(caption_result.exit_code, 0)

            score_result = self.runner.invoke(
                app,
                [
                    "score",
                    "--model",
                    "aesthetic-simple",
                    "--log-run",
                    "--config",
                    str(config_path),
                ],
            )
            self.assertEqual(score_result.exit_code, 0)

            logs_dir = root / "stylevault" / "logs"
            log_files = list(logs_dir.glob("*.json"))
            self.assertTrue(log_files)
            commands = {json.loads(path.read_text(encoding="utf-8")).get("command") for path in log_files}
            self.assertTrue({"scan", "embed", "caption", "score"}.issubset(commands))

    def test_status_with_minimal_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            config_path = self._write_config(root)
            init_result = self.runner.invoke(app, ["init", "--config", str(config_path)])
            self.assertEqual(init_result.exit_code, 0)

            status_result = self.runner.invoke(app, ["status", "--config", str(config_path)])
            self.assertEqual(status_result.exit_code, 0)
            self.assertIn("Assets: 0", status_result.stdout)


if __name__ == "__main__":
    unittest.main()
