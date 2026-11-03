"""One pipeline for indexing a folder: scan, embed, score, cluster, map."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import os
from pathlib import Path

from stylevault import db
from stylevault.clustering import run_recursive_hdbscan_clustering
from stylevault.embeddings import embed_assets, get_embedding_model
from stylevault.model_cache import configure_model_cache
from stylevault.scan import scan_directory
from stylevault.scores import get_score_model, score_assets
from stylevault.umap_projection import build_umap_projection

# Below this, clusters and a map tell the user nothing and UMAP can fail.
MIN_ASSETS_FOR_MAP = 5


@dataclass
class IndexProgress:
    step: str = ""
    done: int = 0
    total: int = 0


class FolderRefused(ValueError):
    pass


def allowed_roots() -> list[Path]:
    raw = os.environ.get("STYLEVAULT_ALLOWED_ROOTS", "")
    parts = [p.strip() for chunk in raw.split(",") for p in chunk.split(os.pathsep)]
    return [Path(p).expanduser().resolve() for p in parts if p]


def check_folder(folder: str) -> Path:
    """Raise FolderRefused unless folder is a real directory under an allowed root."""
    path = Path(folder).expanduser()
    if not path.is_absolute():
        raise FolderRefused(f"Folder must be an absolute path: {folder}")
    resolved = path.resolve()
    roots = allowed_roots()
    if not roots:
        raise FolderRefused(
            "No folders are allowed yet. Set STYLEVAULT_ALLOWED_ROOTS to the folders "
            "StyleVault may read, then restart it."
        )
    if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
        raise FolderRefused(
            f"{resolved} is not under STYLEVAULT_ALLOWED_ROOTS. "
            "Add its parent folder to that setting and restart StyleVault."
        )
    if not resolved.is_dir():
        raise FolderRefused(f"Folder not found: {resolved}")
    return resolved


def count_assets(db_path: Path) -> int:
    with db.connect(db_path) as connection:
        row = connection.execute(
            "SELECT COUNT(*) AS n FROM assets WHERE is_missing = 0"
        ).fetchone()
    return int(row["n"])


def _fusion(settings: dict) -> tuple[list[str], dict[str, float]]:
    weights = settings.get("fusion", {}).get("weights", {})
    if not weights:
        primary = str(settings.get("embeddings", {}).get("primary_model", "siglip2"))
        weights = {primary: 1.0}
    weights = {str(name): float(value) for name, value in weights.items()}
    return list(weights), weights


def _drop_old_clusters(db_path: Path, new_root_run_id: int) -> None:
    """Keep /clusters/tree to the newest run, except clusters a saved style points at."""
    with db.connect(db_path) as connection:
        connection.execute(
            """
            DELETE FROM clusters
            WHERE run_id < ?
              AND id NOT IN (
                SELECT source_cluster_id FROM style_nodes WHERE source_cluster_id IS NOT NULL
              )
            """,
            (new_root_run_id,),
        )
        connection.commit()


def run_index(
    folder: Path,
    settings: dict,
    config_path: Path,
    paths: dict[str, Path],
    report: Callable[[IndexProgress], None],
) -> int:
    """Index folder into the library. Returns the library's asset count."""
    db_path = paths["db_path"]
    progress = IndexProgress()

    def update(step: str, done: int, total: int) -> None:
        progress.step, progress.done, progress.total = step, done, total
        report(progress)

    scan_settings = settings.get("scan", {})
    update("scan", 0, 0)
    flags = settings.get("flags", {})
    scan_directory(
        folder,
        db_path,
        paths["thumbs_dir"],
        exclude_globs=scan_settings.get("exclude_globs", []),
        workers=int(scan_settings.get("workers", 4)),
        small_min_width=flags.get("small_image_min_width"),
        small_min_height=flags.get("small_image_min_height"),
    )
    with db.connect(db_path) as connection:
        db.rebuild_search_index(connection)
        connection.commit()
    assets = count_assets(db_path)
    update("scan", assets, assets)
    if assets == 0:
        raise ValueError(f"No images found in {folder}.")

    configure_model_cache(settings, config_path)
    models, weights = _fusion(settings)
    for name in models:
        step = f"embed:{name}"
        update(step, 0, assets)
        embed_assets(db_path, get_embedding_model(name), batch_size=32, commit_every=32)
        update(step, assets, assets)

    update("score", 0, assets)
    score_assets(db_path, get_score_model("aesthetic-simple"))
    update("score", assets, assets)

    if assets < MIN_ASSETS_FOR_MAP:
        update("done", assets, assets)
        return assets

    # The fused cache is keyed on models only, so new assets would miss it: no cache here.
    update("cluster", 0, assets)
    stats = run_recursive_hdbscan_clustering(
        db_path,
        models,
        weights,
        min_cluster_size=max(3, min(10, assets // 10)),
    )
    _drop_old_clusters(db_path, stats.root_run_id)
    update("cluster", assets, assets)

    update("umap", 0, assets)
    build_umap_projection(db_path, models, weights, n_neighbors=min(15, assets - 1))
    update("umap", assets, assets)
    update("done", assets, assets)
    return assets
