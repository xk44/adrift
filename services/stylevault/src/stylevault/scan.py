from __future__ import annotations

import fnmatch
import hashlib
import logging
import os
from datetime import datetime, timezone
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

from stylevault.db import (
    connect,
    fetch_asset_by_path,
    fetch_asset_by_sha,
    insert_asset,
    mark_assets_missing,
    update_asset_metadata,
    update_asset_path,
    update_asset_seen,
)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif"}


def _is_excluded(path: Path, root: Path, patterns: Iterable[str]) -> bool:
    relative = path.relative_to(root)
    rel_posix = relative.as_posix()
    abs_posix = path.as_posix()
    for pattern in patterns:
        if fnmatch.fnmatch(rel_posix, pattern) or fnmatch.fnmatch(abs_posix, pattern):
            return True
    return False


def iter_image_files(root: Path, exclude_globs: Iterable[str] | None = None) -> Iterator[Path]:
    patterns = list(exclude_globs or [])
    real_root = root.resolve()
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        # A symlink must not bring in a file from outside the folder.
        if not path.resolve().is_relative_to(real_root):
            continue
        if patterns and _is_excluded(path, root, patterns):
            continue
        if path.suffix.lower() in IMAGE_EXTENSIONS:
            yield path


def compute_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def scan_directory(
    root: Path,
    db_path: Path,
    thumbs_dir: Path,
    size: tuple[int, int] = (512, 512),
    exclude_globs: Iterable[str] | None = None,
    dry_run: bool = False,
    workers: int = 4,
    commit_every: int = 500,
    small_min_width: int | None = None,
    small_min_height: int | None = None,
) -> dict[str, int]:
    logger = logging.getLogger(__name__)
    stats = {
        "scanned": 0,
        "inserted": 0,
        "deduped": 0,
        "relocated": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "thumbs_created": 0,
        "thumbs_needed": 0,
        "missing_marked": 0,
    }

    if not root.exists():
        raise FileNotFoundError(f"Scan root {root} does not exist.")

    def _is_small_image(width: int | None, height: int | None) -> int:
        if width is None or height is None:
            return 0
        if small_min_width is None or small_min_height is None:
            return 0
        return int(width < small_min_width or height < small_min_height)

    def _prepare_asset(path: Path) -> tuple[str, int | None, int | None, int, float, int]:
        sha256 = compute_sha256(path)
        with Image.open(path) as image:
            width, height = image.size
        is_small = _is_small_image(width, height)
        stat = path.stat()
        return sha256, width, height, int(stat.st_size), float(stat.st_mtime), is_small

    scan_started_at = datetime.now(timezone.utc).isoformat()
    with connect(db_path) as connection:
        if not dry_run:
            thumbs_dir.mkdir(parents=True, exist_ok=True)

        pending_commits = 0

        def record_commit() -> None:
            nonlocal pending_commits
            if dry_run:
                return
            pending_commits += 1
            if pending_commits >= commit_every:
                connection.commit()
                pending_commits = 0

        max_workers = max(1, int(workers))
        use_workers = max_workers > 1
        pending: dict[object, Path] = {}
        max_pending = max_workers * 4
        executor = ThreadPoolExecutor(max_workers=max_workers) if use_workers else None

        def handle_result(
            path: Path,
            payload: tuple[str, int | None, int | None, int, float, int],
        ) -> None:
            sha256, width, height, file_size, mtime, is_small = payload
            source_path = str(path.resolve())
            existing = fetch_asset_by_sha(connection, sha256)
            if existing:
                if existing["source_path"] != source_path:
                    stats["relocated"] += 1
                    if not dry_run:
                        update_asset_path(connection, int(existing["id"]), source_path)
                        update_asset_metadata(
                            connection,
                            int(existing["id"]),
                            sha256,
                            width,
                            height,
                            file_size,
                            mtime,
                            is_small=is_small,
                        )
                        update_asset_seen(connection, int(existing["id"]), scan_started_at)
                        record_commit()
                else:
                    stats["deduped"] += 1
                    if not dry_run:
                        update_asset_seen(connection, int(existing["id"]), scan_started_at)
                        record_commit()
                return
            existing_path = fetch_asset_by_path(connection, source_path)
            if existing_path:
                stats["updated"] += 1
                if not dry_run:
                    update_asset_metadata(
                        connection,
                        int(existing_path["id"]),
                        sha256,
                        width,
                        height,
                        file_size,
                        mtime,
                        is_small=is_small,
                    )
                    update_asset_seen(connection, int(existing_path["id"]), scan_started_at)
                    record_commit()
            else:
                if not dry_run:
                    insert_asset(
                        connection,
                        source_path=source_path,
                        sha256=sha256,
                        media_type=path.suffix.lower().lstrip("."),
                        width=width,
                        height=height,
                        file_size=file_size,
                        mtime=mtime,
                        is_small=is_small,
                        is_missing=0,
                        last_seen_at=scan_started_at,
                    )
                    record_commit()
                stats["inserted"] += 1
            thumb_path = thumbs_dir / f"{sha256}.webp"
            if not thumb_path.exists():
                if dry_run:
                    stats["thumbs_needed"] += 1
                else:
                    try:
                        with Image.open(path) as image:
                            image.thumbnail(size)
                            image.save(thumb_path, "WEBP")
                        stats["thumbs_created"] += 1
                    except OSError:
                        logger.warning("Failed to generate thumbnail for: %s", source_path)

        for path in iter_image_files(root, exclude_globs=exclude_globs):
            stats["scanned"] += 1
            source_path = str(path.resolve())
            stat = path.stat()
            existing_path = fetch_asset_by_path(connection, source_path)
            if existing_path:
                existing_size = existing_path["file_size"]
                existing_mtime = existing_path["mtime"]
                if existing_size is not None and existing_mtime is not None:
                    if int(existing_size) == int(stat.st_size) and float(existing_mtime) == float(stat.st_mtime):
                        stats["unchanged"] += 1
                        if not dry_run:
                            update_asset_seen(connection, int(existing_path["id"]), scan_started_at)
                            record_commit()
                        continue
            if use_workers and executor is not None:
                future = executor.submit(_prepare_asset, path)
                pending[future] = path
                if len(pending) >= max_pending:
                    for finished in as_completed(list(pending.keys()), timeout=None):
                        path_item = pending.pop(finished)
                        try:
                            payload = finished.result()
                        except OSError:
                            logger.warning("Skipping unreadable image: %s", path_item)
                            stats["skipped"] += 1
                            continue
                        handle_result(path_item, payload)
                        break
            else:
                try:
                    payload = _prepare_asset(path)
                except OSError:
                    logger.warning("Skipping unreadable image: %s", source_path)
                    stats["skipped"] += 1
                    continue
                handle_result(path, payload)

        if use_workers and executor is not None:
            for finished in as_completed(list(pending.keys())):
                try:
                    payload = finished.result()
                except OSError:
                    logger.warning("Skipping unreadable image: %s", pending[finished])
                    stats["skipped"] += 1
                    continue
                handle_result(pending[finished], payload)
            executor.shutdown(wait=True)
        if not dry_run:
            root_prefix = str(root.resolve())
            if not root_prefix.endswith(os.sep):
                root_prefix = f"{root_prefix}{os.sep}"
            stats["missing_marked"] = mark_assets_missing(
                connection,
                f"{root_prefix}%",
                scan_started_at,
            )
            connection.commit()
        elif pending_commits:
            connection.commit()
    return stats
