from __future__ import annotations

import importlib
from pathlib import Path

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


def _seed_search_asset(db_path: Path, index: int, caption: str) -> None:
    with db.connect(db_path) as connection:
        asset_id = db.insert_asset(
            connection,
            source_path=str(db_path.parent / f"asset-{index}.png"),
            sha256=f"sha-{index}",
            media_type="image",
            width=8,
            height=8,
        )
        db.insert_caption(
            connection,
            asset_id=asset_id,
            model_name="test-model",
            model_version="1",
            caption_type="short",
            caption=caption,
        )
        connection.commit()


def test_search_response_includes_unpaginated_total_count(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    for index in range(5):
        extra = "rareterm" if index < 2 else "commononly"
        _seed_search_asset(db_path, index, f"sharedterm {extra}")
    config_path = _make_config(tmp_path, db_path)
    app = api_module.create_app(config_path)
    search_endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/search")

    payload = search_endpoint(query="sharedterm", limit=2, offset=0)
    assert payload["count"] == 2
    assert payload["total_count"] == 5
    assert len(payload["results"]) == 2

    filtered_payload = search_endpoint(query="rareterm", limit=1, offset=0)
    assert filtered_payload["count"] == 1
    assert filtered_payload["total_count"] == 2
