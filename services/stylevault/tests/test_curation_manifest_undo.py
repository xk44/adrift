from __future__ import annotations

import json
from pathlib import Path

from stylevault import db
from stylevault.curation import apply_file_actions, undo_manifest


def test_move_manifest_contains_restore_paths_and_undo_restores_asset_path(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)

    source = tmp_path / "source.jpg"
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
        mode="move",
        dry_run=False,
        log_dir=logs,
    )

    assert stats.manifest_path is not None
    manifest = json.loads(stats.manifest_path.read_text(encoding="utf-8"))

    restore_paths = manifest["undo"]["restore_paths"]
    assert len(restore_paths) == 1
    assert restore_paths[0]["asset_id"] == str(asset_id)

    moved_path = Path(manifest["items"][0]["target_path"])
    assert moved_path.exists()
    assert not source.exists()

    undo_stats = undo_manifest(db_path, stats.manifest_path, dry_run=False)
    assert undo_stats["restored"] == 1
    assert source.exists()
    assert not moved_path.exists()

    with db.connect(db_path) as connection:
        asset = db.fetch_asset_by_id(connection, asset_id)
    assert asset is not None
    assert Path(asset["source_path"]) == source


def test_copy_manifest_contains_remove_targets(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)

    source = tmp_path / "source.jpg"
    source.write_bytes(b"asset")

    with db.connect(db_path) as connection:
        asset_id = db.insert_asset(
            connection,
            source_path=str(source),
            sha256="asset-sha-copy",
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
        dry_run=False,
        log_dir=logs,
    )

    assert stats.manifest_path is not None
    manifest = json.loads(stats.manifest_path.read_text(encoding="utf-8"))

    remove_targets = manifest["undo"]["remove_targets"]
    assert len(remove_targets) == 1
    assert Path(remove_targets[0]).exists()
    assert source.exists()
