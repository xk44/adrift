from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from typer.testing import CliRunner

from stylevault.cli import app
from stylevault.config import DEFAULT_CONFIG


class CliOmniTagTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()

    def test_caption_omnitag_mode_validation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "image.png"
            image_path.write_bytes(b"stub")
            result = self.runner.invoke(
                app,
                [
                    "caption-omnitag",
                    "--mode",
                    "invalid",
                    "--input-path",
                    str(image_path),
                ],
            )
            self.assertNotEqual(result.exit_code, 0)
            self.assertIsNotNone(result.exception)

    def test_caption_omnitag_invokes_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "image.png"
            image_path.write_bytes(b"stub")
            output_path = Path(tmpdir) / "out"

            with patch("stylevault.cli.get_omnitag_model", return_value=object()) as model_mock, patch(
                "stylevault.cli.run_omnitag_mode"
            ) as run_mock:
                run_mock.return_value = type(
                    "Stats",
                    (),
                    {
                        "images_captioned": 1,
                        "videos_processed": 0,
                        "clips_exported": 0,
                        "frames_exported": 0,
                        "blurry_frames_skipped": 0,
                    },
                )()
                result = self.runner.invoke(
                    app,
                    [
                        "caption-omnitag",
                        "--mode",
                        "images",
                        "--input-path",
                        str(image_path),
                        "--output-path",
                        str(output_path),
                    ],
                )

            self.assertEqual(result.exit_code, 0)
            model_mock.assert_called_once()
            run_mock.assert_called_once()
            self.assertIn("OmniTag run finished", result.stdout)


class OmniTagConfigTests(unittest.TestCase):
    def test_default_config_includes_omnitag_settings(self) -> None:
        omnitag = DEFAULT_CONFIG.get("omnitag", {})
        self.assertEqual(omnitag.get("mode"), "batch-folder")
        self.assertEqual(omnitag.get("caption_video_targets"), "both")
        self.assertIn("blur_threshold", omnitag)


if __name__ == "__main__":
    unittest.main()
