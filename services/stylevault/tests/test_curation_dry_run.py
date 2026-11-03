from __future__ import annotations

import json
from pathlib import Path

from stylevault import db
from stylevault.curation import apply_file_actions


def test_curation_file_actions_dry_run_writes_manifest_without_changes(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)

    source = tmp_path / "asset.jpg"
    source.write_bytes(b"asset")

    with db.connect(db_path) as connection:
        asset_id = db.insert_asset(
            connection,
            source_path=str(source),
            sha256="asset-sha",
            media_type="image",
            width=8,
            height=8,
        )
        connection.commit()

    target = tmp_path / "curated"
    logs = tmp_path / "logs"
    stats = apply_file_actions(
        db_path,
        [asset_id],
        target,
        mode="copy",
        dry_run=True,
        log_dir=logs,
    )

    assert stats.planned == 1
    assert stats.completed == 0
    assert stats.manifest_path is not None
    assert not target.exists()
    assert source.exists()

    manifest = json.loads(stats.manifest_path.read_text(encoding="utf-8"))
    assert manifest["dry_run"] is True
    assert len(manifest["items"]) == 1
    assert Path(manifest["items"][0]["source_path"]) == source

    with db.connect(db_path) as connection:
        asset = db.fetch_asset_by_id(connection, asset_id)
    assert asset is not None
    assert Path(asset["source_path"]) == source
