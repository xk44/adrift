from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil

from stylevault import db

EXPORT_MODES = {"hardlink", "symlink", "copy"}


@dataclass(frozen=True)
class ExportStats:
    run_id: int
    planned: int
    exported: int
    skipped: int
    missing: int
    manifest_path: Path
    export_dir: Path


def _safe_cluster_name(label: int) -> str:
    if label < 0:
        return "noise"
    return f"cluster_{label:04d}"


def _link_asset(source: Path, target: Path, mode: str) -> None:
    if mode == "hardlink":
        os.link(source, target)
        return
    if mode == "symlink":
        target.symlink_to(source)
        return
    if mode == "copy":
        shutil.copy2(source, target)
        return
    raise ValueError(f"Unsupported export mode: {mode}")


def export_cluster_run(
    db_path: Path,
    exports_root: Path,
    run_id: int,
    mode: str = "hardlink",
    include_noise: bool = False,
    dry_run: bool = False,
) -> ExportStats:
    if mode not in EXPORT_MODES:
        raise ValueError(f"Mode must be one of: {', '.join(sorted(EXPORT_MODES))}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    export_run_dir = exports_root / "runs" / timestamp
    export_dir = export_run_dir / "clusters"
    export_dir.mkdir(parents=True, exist_ok=True)

    with db.connect(db_path) as connection:
        cluster_run = db.fetch_cluster_run(connection, run_id)
        rows = db.fetch_cluster_labels_for_run(connection, run_id)

    if cluster_run is None:
        raise ValueError(f"Cluster run {run_id} not found.")

    if not rows:
        raise ValueError(f"No cluster labels found for run {run_id}.")

    manifest_items: list[dict[str, object]] = []
    missing_assets: list[dict[str, object]] = []
    skipped_assets: list[dict[str, object]] = []
    exported = 0
    skipped = 0
    missing = 0

    for row in rows:
        label = int(row["cluster_label"])
        if label < 0 and not include_noise:
            skipped += 1
            skipped_assets.append(
                {
                    "asset_id": int(row["asset_id"]),
                    "cluster_label": label,
                    "source_path": str(row["source_path"]),
                    "reason": "noise_excluded",
                }
            )
            continue
        cluster_dir = export_dir / _safe_cluster_name(label)
        if not dry_run:
            cluster_dir.mkdir(parents=True, exist_ok=True)
        source_path = Path(row["source_path"])
        suffix = source_path.suffix or ""
        target_path = cluster_dir / f"{row['sha256']}{suffix}"
        if not source_path.exists():
            missing += 1
            missing_assets.append(
                {
                    "asset_id": int(row["asset_id"]),
                    "cluster_label": label,
                    "source_path": str(source_path),
                }
            )
            continue
        if target_path.exists():
            skipped += 1
            skipped_assets.append(
                {
                    "asset_id": int(row["asset_id"]),
                    "cluster_label": label,
                    "source_path": str(source_path),
                    "target_path": str(target_path.relative_to(export_run_dir)),
                    "reason": "target_exists",
                }
            )
            continue
        if not dry_run:
            _link_asset(source_path, target_path, mode)
            exported += 1
        manifest_items.append(
            {
                "asset_id": int(row["asset_id"]),
                "cluster_label": label,
                "probability": float(row["probability"]),
                "source_path": str(source_path),
                "target_path": str(target_path.relative_to(export_run_dir)),
                "operation": mode,
            }
        )

    manifest = {
        "run_id": run_id,
        "created_at": timestamp,
        "mode": mode,
        "dry_run": dry_run,
        "include_noise": include_noise,
        "export_root": str(export_run_dir),
        "export_dir": str(export_dir),
        "cluster_run": {
            "id": int(cluster_run["id"]),
            "created_at": str(cluster_run["created_at"]),
            "models": json.loads(cluster_run["models_json"]),
            "weights": json.loads(cluster_run["weights_json"]),
            "min_cluster_size": int(cluster_run["min_cluster_size"]),
            "min_samples": (
                int(cluster_run["min_samples"]) if cluster_run["min_samples"] is not None else None
            ),
            "cluster_selection_epsilon": float(cluster_run["cluster_selection_epsilon"]),
        },
        "exported": exported,
        "skipped": skipped,
        "missing": missing,
        "planned": len(manifest_items),
        "items": manifest_items,
        "missing_assets": missing_assets,
        "skipped_assets": skipped_assets,
        "undo": {
            "remove_targets": [
                str(export_run_dir / str(item["target_path"])) for item in manifest_items
            ],
        },
    }
    manifest_path = export_run_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True))

    return ExportStats(
        run_id=run_id,
        planned=len(manifest_items),
        exported=exported,
        skipped=skipped,
        missing=missing,
        manifest_path=manifest_path,
        export_dir=export_dir,
    )


def export_assets_by_tag(
    db_path: Path,
    tag: str,
    target_dir: Path,
    mode: str = "symlink",
    limit: int | None = None,
) -> int:
    """Put every non-missing asset with this tag into target_dir, with a .txt caption sidecar."""
    target_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    with db.connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT a.id, a.source_path,
                   (SELECT caption FROM captions c
                     WHERE c.asset_id = a.id AND c.caption_type = 'long'
                     ORDER BY c.created_at DESC LIMIT 1) AS prompt
            FROM assets a
            JOIN tags t ON t.asset_id = a.id
            WHERE t.tag = ? AND a.is_missing = 0
            ORDER BY a.id
            """,
            (tag,),
        ).fetchall()
    for row in rows:
        if limit is not None and count >= limit:
            break
        source = Path(str(row["source_path"]))
        if not source.exists():
            continue
        target = target_dir / f"{int(row['id']):08d}{source.suffix.lower()}"
        try:
            if target.exists() or target.is_symlink():
                target.unlink()
            if mode == "copy":
                shutil.copy2(source, target)
            else:
                target.symlink_to(source.resolve())
        except OSError:
            continue
        if row["prompt"]:
            target.with_suffix(".txt").write_text(str(row["prompt"]), encoding="utf-8")
        count += 1
    return count
