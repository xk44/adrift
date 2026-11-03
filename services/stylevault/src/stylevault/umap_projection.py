from __future__ import annotations

from dataclasses import dataclass
import importlib.util
from pathlib import Path

from stylevault import db
from stylevault.fusion import build_fused_embeddings


@dataclass(frozen=True)
class UmapStats:
    run_id: int
    assets: int


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def build_umap_projection(
    db_path: Path,
    models: list[str],
    weights: dict[str, float],
    n_neighbors: int = 15,
    min_dist: float = 0.1,
    metric: str = "euclidean",
    cache_dir: Path | None = None,
) -> UmapStats:
    if not _module_available("umap") or not _module_available("numpy"):
        raise RuntimeError(
            "UMAP projection requires numpy and umap-learn. "
            "Install the dependencies to enable UMAP."
        )
    import numpy as np
    import umap

    if n_neighbors <= 1:
        raise ValueError("n_neighbors must be greater than 1.")
    if min_dist < 0:
        raise ValueError("min_dist must be non-negative.")

    fused = build_fused_embeddings(db_path, models, weights, cache_dir=cache_dir)
    embedding_matrix = np.asarray(fused.embeddings, dtype=np.float32)
    reducer = umap.UMAP(
        n_neighbors=n_neighbors,
        min_dist=min_dist,
        metric=metric,
        n_components=2,
        random_state=42,
    )
    projection = reducer.fit_transform(embedding_matrix)

    with db.connect(db_path) as connection:
        db.ensure_umap_schema(connection)
        run_id = db.insert_umap_run(
            connection,
            models=[
                {"name": name, "version": fused.model_versions[name]} for name in models
            ],
            weights=fused.weights,
            n_neighbors=n_neighbors,
            min_dist=min_dist,
            metric=metric,
        )
        for asset_id, coords in zip(fused.asset_ids, projection, strict=False):
            db.insert_umap_point(
                connection,
                run_id=run_id,
                asset_id=asset_id,
                x=float(coords[0]),
                y=float(coords[1]),
            )
        connection.commit()

    return UmapStats(run_id=run_id, assets=len(fused.asset_ids))
