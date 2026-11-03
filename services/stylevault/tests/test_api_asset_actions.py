import importlib
from pathlib import Path

from fastapi.testclient import TestClient

from stylevault import db

api_module = importlib.import_module("stylevault.api.app")


def _make_config(tmp_path: Path, db_path: Path) -> Path:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        "\n".join(
            [
                "[paths]",
                f'db_path = "{db_path.as_posix()}"',
                f'thumbs_dir = "{(tmp_path / "thumbs").as_posix()}"',
            ]
        )
    )
    return config_path


def _seed_asset(db_path: Path, file_path: Path) -> int:
    with db.connect(db_path) as connection:
        asset_id = db.insert_asset(
            connection,
            source_path=str(file_path),
            sha256="abc123",
            media_type="image",
            width=8,
            height=8,
        )
        connection.commit()
    return asset_id


def test_open_and_reveal_routes_are_gone(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    asset_file = tmp_path / "asset.png"
    asset_file.write_bytes(b"test")
    asset_id = _seed_asset(db_path, asset_file)
    client = TestClient(api_module.create_app(_make_config(tmp_path, db_path)))
    assert client.post(f"/assets/{asset_id}/open").status_code == 404
    assert client.post(f"/assets/{asset_id}/reveal").status_code == 404
