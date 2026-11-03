from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import shutil

from stylevault import db
from stylevault.tags import normalize_tag

FILE_ACTIONS = {"move", "copy", "hardlink", "symlink"}


@dataclass
class TagActionStats:
    processed_assets: int
    missing_assets: int
    tags_added: int
    tags_removed: int
    tags_skipped: int


@dataclass
class FileActionStats:
    processed_assets: int
    missing_assets: int
    planned: int
    completed: int
    skipped: int
    manifest_path: Path | None


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
    raise ValueError(f"Unsupported action: {mode}")


def _unique_target_path(
    target_dir: Path,
    source_path: Path,
    asset_id: int,
    used_paths: set[Path],
) -> Path:
    candidate = target_dir / source_path.name
    if candidate not in used_paths and not candidate.exists():
        used_paths.add(candidate)
        return candidate

    stem = source_path.stem
    suffix = source_path.suffix
    counter = 1
    while True:
        candidate = target_dir / f"{stem}-{asset_id}-{counter}{suffix}"
        if candidate not in used_paths and not candidate.exists():
            used_paths.add(candidate)
            return candidate
        counter += 1


def add_tags(
    db_path: Path,
    asset_ids: list[int],
    tags: list[str],
    source: str,
    dry_run: bool = False,
) -> TagActionStats:
    normalized_tags = [normalize_tag(tag) for tag in tags if normalize_tag(tag)]
    tags_added = 0
    tags_skipped = 0
    missing_assets = 0

    with db.connect(db_path) as connection:
        for asset_id in asset_ids:
            asset = db.fetch_asset_by_id(connection, asset_id)
            if asset is None:
                missing_assets += 1
                continue
            for tag in normalized_tags:
                if dry_run:
                    if db.has_tag(connection, asset_id, tag, source):
                        tags_skipped += 1
                    else:
                        tags_added += 1
                    continue
                inserted = db.insert_tag(connection, asset_id, tag, source)
                if inserted is None:
                    tags_skipped += 1
                else:
                    tags_added += 1

    return TagActionStats(
        processed_assets=len(asset_ids),
        missing_assets=missing_assets,
        tags_added=tags_added,
        tags_removed=0,
        tags_skipped=tags_skipped,
    )


def remove_tags(
    db_path: Path,
    asset_ids: list[int],
    tags: list[str],
    source: str | None = None,
    dry_run: bool = False,
) -> TagActionStats:
    normalized_tags = [normalize_tag(tag) for tag in tags if normalize_tag(tag)]
    tags_removed = 0
    tags_skipped = 0
    missing_assets = 0

    with db.connect(db_path) as connection:
        for asset_id in asset_ids:
            asset = db.fetch_asset_by_id(connection, asset_id)
            if asset is None:
                missing_assets += 1
                continue
            for tag in normalized_tags:
                if dry_run:
                    if db.has_tag(connection, asset_id, tag, source):
                        tags_removed += 1
                    else:
                        tags_skipped += 1
                    continue
                removed = db.remove_tag(connection, asset_id, tag, source)
                if removed:
                    tags_removed += removed
                else:
                    tags_skipped += 1

    return TagActionStats(
        processed_assets=len(asset_ids),
        missing_assets=missing_assets,
        tags_added=0,
        tags_removed=tags_removed,
        tags_skipped=tags_skipped,
    )


def apply_file_actions(
    db_path: Path,
    asset_ids: list[int],
    target_dir: Path,
    mode: str,
    dry_run: bool = False,
    log_dir: Path | None = None,
) -> FileActionStats:
    if mode not in FILE_ACTIONS:
        raise ValueError(f"Unsupported action: {mode}")

    used_paths: set[Path] = set()
    plan: list[dict[str, str]] = []
    missing_assets = 0
    skipped = 0

    with db.connect(db_path) as connection:
        for asset_id in asset_ids:
            asset = db.fetch_asset_by_id(connection, asset_id)
            if asset is None:
                missing_assets += 1
                continue
            source_path = Path(asset["source_path"])
            if not source_path.exists():
                skipped += 1
                continue
            target_path = _unique_target_path(target_dir, source_path, asset_id, used_paths)
            plan.append(
                {
                    "asset_id": str(asset_id),
                    "source_path": str(source_path),
                    "target_path": str(target_path),
                }
            )

        if not dry_run:
            target_dir.mkdir(parents=True, exist_ok=True)
            for item in plan:
                source_path = Path(item["source_path"])
                target_path = Path(item["target_path"])
                target_path.parent.mkdir(parents=True, exist_ok=True)
                if mode == "move":
                    shutil.move(source_path, target_path)
                    db.update_asset_path(connection, int(item["asset_id"]), str(target_path))
                else:
                    _link_asset(source_path, target_path, mode)

    manifest_path: Path | None = None
    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        manifest_path = log_dir / f"curation-{timestamp}.json"
        undo: dict[str, object]
        if mode == "move":
            undo = {
                "restore_paths": [
                    {
                        "asset_id": item["asset_id"],
                        "source_path": item["target_path"],
                        "target_path": item["source_path"],
                    }
                    for item in plan
                ]
            }
        else:
            undo = {
                "remove_targets": [item["target_path"] for item in plan],
            }
        manifest = {
            "mode": mode,
            "dry_run": dry_run,
            "created_at": timestamp,
            "items": plan,
            "undo": undo,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2))

    completed = len(plan) if not dry_run else 0
    return FileActionStats(
        processed_assets=len(asset_ids),
        missing_assets=missing_assets,
        planned=len(plan),
        completed=completed,
        skipped=skipped,
        manifest_path=manifest_path,
    )


def undo_manifest(
    db_path: Path,
    manifest_path: Path,
    dry_run: bool = False,
) -> dict[str, int]:
    payload = json.loads(manifest_path.read_text())
    undo = payload.get("undo", {})
    removed = 0
    restored = 0
    skipped = 0

    remove_targets = undo.get("remove_targets", [])
    restore_paths = undo.get("restore_paths", [])

    if remove_targets:
        for target in remove_targets:
            target_path = Path(target)
            if not target_path.exists():
                skipped += 1
                continue
            if not dry_run:
                target_path.unlink()
            removed += 1

    if restore_paths:
        with db.connect(db_path) as connection:
            for entry in restore_paths:
                source_path = Path(entry["source_path"])
                target_path = Path(entry["target_path"])
                if not source_path.exists():
                    skipped += 1
                    continue
                if not dry_run:
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(source_path, target_path)
                    db.update_asset_path(connection, int(entry["asset_id"]), str(target_path))
                restored += 1
            if not dry_run:
                connection.commit()

    return {
        "removed": removed,
        "restored": restored,
        "skipped": skipped,
    }
