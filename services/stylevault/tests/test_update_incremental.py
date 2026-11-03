from __future__ import annotations

from pathlib import Path

from PIL import Image
from typer.testing import CliRunner

from stylevault.cli import app
from stylevault import db


def _write_config(root: Path) -> Path:
    data_dir = root / "stylevault"
    config_path = root / "config.toml"
    config_path.write_text(
        "\n".join(
            [
                "[paths]",
                f'data_dir = "{data_dir}"',
                f'db_path = "{data_dir / "vault.sqlite"}"',
                f'thumbs_dir = "{data_dir / "thumbs"}"',
                f'exports_dir = "{data_dir / "exports"}"',
                f'logs_dir = "{data_dir / "logs"}"',
                f'indices_dir = "{data_dir / "indices"}"',
                f'models_dir = "{data_dir / "models"}"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return config_path


def _create_image(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color=(120, 30, 90)).save(path)


def test_update_skips_assets_that_already_have_outputs(tmp_path: Path) -> None:
    runner = CliRunner()
    config_path = _write_config(tmp_path)
    image_root = tmp_path / "images"
    _create_image(image_root / "sample.png")

    init_result = runner.invoke(app, ["init", "--config", str(config_path)])
    assert init_result.exit_code == 0

    first_result = runner.invoke(
        app,
        [
            "update",
            "--root",
            str(image_root),
            "--embed-model",
            "color-histogram",
            "--caption-model",
            "filename",
            "--caption-type",
            "long",
            "--score-model",
            "aesthetic-simple",
            "--config",
            str(config_path),
        ],
    )
    assert first_result.exit_code == 0

    second_result = runner.invoke(
        app,
        [
            "update",
            "--root",
            str(image_root),
            "--embed-model",
            "color-histogram",
            "--caption-model",
            "filename",
            "--caption-type",
            "long",
            "--score-model",
            "aesthetic-simple",
            "--config",
            str(config_path),
        ],
    )
    assert second_result.exit_code == 0
    assert "color-histogram: embedded 0 skipped 0" in second_result.stdout
    assert "filename:long: captioned 0 skipped 0" in second_result.stdout
    assert "aesthetic-simple: scored 0 skipped 0" in second_result.stdout

    with db.connect(tmp_path / "stylevault" / "vault.sqlite") as connection:
        embedding_count = connection.execute("SELECT COUNT(*) AS c FROM embeddings").fetchone()["c"]
        caption_count = connection.execute("SELECT COUNT(*) AS c FROM captions").fetchone()["c"]
        score_count = connection.execute("SELECT COUNT(*) AS c FROM scores").fetchone()["c"]

    assert embedding_count == 1
    assert caption_count == 1
    assert score_count == 1
