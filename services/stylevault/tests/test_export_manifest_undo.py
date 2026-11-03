from __future__ import annotations

import json
from pathlib import Path

from stylevault import db
from stylevault.curation import undo_manifest
from stylevault.export import export_cluster_run


def test_export_manifest_has_reversible_undo_targets(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)

    source = tmp_path / "asset.jpg"
    source.write_bytes(b"asset")

    with db.connect(db_path) as connection:
        asset_id = db.insert_asset(
            connection,
            source_path=str(source),
            sha256="export-sha",
            media_type="image",
            width=8,
            height=8,
        )
        run_id = db.insert_cluster_run(
            connection,
            models=[{"name": "color-histogram", "version": "v1"}],
            weights={"color-histogram": 1.0},
            min_cluster_size=2,
            min_samples=None,
            cluster_selection_epsilon=0.0,
        )
        db.insert_cluster_label(
            connection,
            run_id=run_id,
            asset_id=asset_id,
            cluster_label=7,
            probability=0.97,
        )
        connection.commit()

    stats = export_cluster_run(
        db_path=db_path,
        exports_root=tmp_path / "exports",
        run_id=run_id,
        mode="copy",
        dry_run=False,
    )

    manifest = json.loads(stats.manifest_path.read_text(encoding="utf-8"))
    remove_targets = manifest["undo"]["remove_targets"]
    assert len(remove_targets) == 1

    exported_target = Path(manifest["export_root"]) / remove_targets[0]
    assert exported_target.exists()

    undo_stats = undo_manifest(db_path, stats.manifest_path, dry_run=False)
    assert undo_stats["removed"] == 1
    assert not exported_target.exists()
    assert source.exists()
