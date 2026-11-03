from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import json
from pathlib import Path

from stylevault import db
from stylevault.fusion import build_fused_embeddings, build_fused_embeddings_from_versions


@dataclass(frozen=True)
class ClusteringStats:
    run_id: int
    assets: int
    clusters: int
    noise: int


@dataclass(frozen=True)
class RecursiveClusteringStats:
    root_run_id: int
    assets: int
    clusters: int
    runs: int
    max_depth: int
    noise: int


@dataclass(frozen=True)
class ClusterAssignmentStats:
    run_id: int
    candidates: int
    assigned: int
    skipped: int
    clusters: int


def _cosine_similarity(lhs: list[float], rhs: list[float]) -> float:
    dot = sum(a * b for a, b in zip(lhs, rhs))
    lhs_norm = sum(a * a for a in lhs) ** 0.5
    rhs_norm = sum(b * b for b in rhs) ** 0.5
    if lhs_norm == 0.0 or rhs_norm == 0.0:
        return 0.0
    return dot / (lhs_norm * rhs_norm)


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def run_hdbscan_clustering(
    db_path: Path,
    models: list[str],
    weights: dict[str, float],
    min_cluster_size: int = 10,
    min_samples: int | None = None,
    cluster_selection_epsilon: float = 0.0,
    cache_dir: Path | None = None,
) -> ClusteringStats:
    if not _module_available("hdbscan") or not _module_available("numpy"):
        raise RuntimeError(
            "HDBSCAN clustering requires numpy and hdbscan. "
            "Install the dependencies to enable clustering."
        )
    import numpy as np
    from hdbscan import HDBSCAN

    if min_cluster_size <= 1:
        raise ValueError("min_cluster_size must be greater than 1.")

    fused = build_fused_embeddings(db_path, models, weights, cache_dir=cache_dir)
    embedding_matrix = np.asarray(fused.embeddings, dtype=np.float32)
    clusterer = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        metric="euclidean",
    )
    clusterer.fit(embedding_matrix)

    labels = clusterer.labels_.tolist()
    probabilities = clusterer.probabilities_.tolist()
    cluster_ids = {label for label in labels if label >= 0}
    noise_count = sum(1 for label in labels if label < 0)

    with db.connect(db_path) as connection:
        db.ensure_cluster_schema(connection)
        run_id = db.insert_cluster_run(
            connection,
            models=[
                {"name": name, "version": fused.model_versions[name]} for name in models
            ],
            weights=fused.weights,
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_selection_epsilon=cluster_selection_epsilon,
        )
        for asset_id, label, probability in zip(
            fused.asset_ids,
            labels,
            probabilities,
            strict=False,
        ):
            db.insert_cluster_label(
                connection,
                run_id=run_id,
                asset_id=asset_id,
                cluster_label=int(label),
                probability=float(probability),
            )
        connection.commit()

    return ClusteringStats(
        run_id=run_id,
        assets=len(fused.asset_ids),
        clusters=len(cluster_ids),
        noise=noise_count,
    )


def run_recursive_hdbscan_clustering(
    db_path: Path,
    models: list[str],
    weights: dict[str, float],
    min_cluster_size: int = 10,
    min_samples: int | None = None,
    cluster_selection_epsilon: float = 0.0,
    max_depth: int = 2,
    min_subcluster_size: int | None = None,
    cache_dir: Path | None = None,
) -> RecursiveClusteringStats:
    if max_depth < 1:
        raise ValueError("max_depth must be at least 1.")
    if min_cluster_size <= 1:
        raise ValueError("min_cluster_size must be greater than 1.")
    if min_subcluster_size is not None and min_subcluster_size <= 1:
        raise ValueError("min_subcluster_size must be greater than 1.")
    if not _module_available("hdbscan") or not _module_available("numpy"):
        raise RuntimeError(
            "Recursive clustering requires numpy and hdbscan. "
            "Install the dependencies to enable clustering."
        )

    import numpy as np
    from hdbscan import HDBSCAN

    fused = build_fused_embeddings(db_path, models, weights, cache_dir=cache_dir)
    embedding_matrix = np.asarray(fused.embeddings, dtype=np.float32)

    min_subcluster_threshold = min_subcluster_size or (min_cluster_size * 2)
    if min_subcluster_threshold < min_cluster_size:
        min_subcluster_threshold = min_cluster_size

    stats = {
        "clusters": 0,
        "runs": 0,
        "max_depth": 0,
        "noise": 0,
    }

    def cluster_subset(
        connection,
        subset_indices: list[int],
        depth: int,
        parent_cluster_id: int | None,
    ) -> int:
        subset_embeddings = embedding_matrix[subset_indices]
        clusterer = HDBSCAN(
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_selection_epsilon=cluster_selection_epsilon,
            metric="euclidean",
        )
        clusterer.fit(subset_embeddings)
        labels = clusterer.labels_.tolist()
        probabilities = clusterer.probabilities_.tolist()
        stats["noise"] += sum(1 for label in labels if label < 0)

        run_id = db.insert_cluster_run(
            connection,
            models=[
                {"name": name, "version": fused.model_versions[name]} for name in models
            ],
            weights=fused.weights,
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_selection_epsilon=cluster_selection_epsilon,
        )
        stats["runs"] += 1
        stats["max_depth"] = max(stats["max_depth"], depth)

        for subset_idx, label, probability in zip(
            subset_indices,
            labels,
            probabilities,
            strict=False,
        ):
            asset_id = fused.asset_ids[subset_idx]
            db.insert_cluster_label(
                connection,
                run_id=run_id,
                asset_id=asset_id,
                cluster_label=int(label),
                probability=float(probability),
            )

        label_to_indices: dict[int, list[int]] = {}
        for subset_idx, label in zip(subset_indices, labels, strict=False):
            if label < 0:
                continue
            label_to_indices.setdefault(int(label), []).append(subset_idx)

        for label, indices in label_to_indices.items():
            cluster_name = f"run{run_id}/d{depth}/c{label}"
            cluster_id = db.insert_cluster(
                connection,
                name=cluster_name,
                parent_id=parent_cluster_id,
                run_id=run_id,
                cluster_label=label,
                depth=depth,
            )
            stats["clusters"] += 1
            for subset_idx in indices:
                asset_id = fused.asset_ids[subset_idx]
                db.insert_cluster_member(connection, cluster_id, asset_id)

            if depth < max_depth and len(indices) >= min_subcluster_threshold:
                cluster_subset(connection, indices, depth + 1, cluster_id)

        return run_id

    with db.connect(db_path) as connection:
        db.ensure_cluster_schema(connection)
        root_run_id = cluster_subset(
            connection,
            list(range(len(fused.asset_ids))),
            depth=1,
            parent_cluster_id=None,
        )
        connection.commit()

    return RecursiveClusteringStats(
        root_run_id=root_run_id,
        assets=len(fused.asset_ids),
        clusters=stats["clusters"],
        runs=stats["runs"],
        max_depth=stats["max_depth"],
        noise=stats["noise"],
    )


def assign_assets_to_cluster_run(
    db_path: Path,
    run_id: int,
    similarity_threshold: float | None = None,
    limit: int | None = None,
    cache_dir: Path | None = None,
) -> ClusterAssignmentStats:
    with db.connect(db_path) as connection:
        db.ensure_cluster_schema(connection)
        run = db.fetch_cluster_run(connection, run_id)
        if run is None:
            raise ValueError(f"Cluster run {run_id} was not found.")
        models = [
            {"name": model["name"], "version": model["version"]}
            for model in json.loads(run["models_json"])
        ]
        weights = json.loads(run["weights_json"])

    fused = build_fused_embeddings_from_versions(
        db_path, models, weights, cache_dir=cache_dir
    )
    embeddings_by_asset = dict(zip(fused.asset_ids, fused.embeddings, strict=False))

    with db.connect(db_path) as connection:
        labels = db.fetch_cluster_labels(connection, run_id)

    labeled_assets = {int(row["asset_id"]) for row in labels}
    centroids: dict[int, list[float]] = {}
    counts: dict[int, int] = {}
    for row in labels:
        cluster_label = int(row["cluster_label"])
        if cluster_label < 0:
            continue
        asset_id = int(row["asset_id"])
        embedding = embeddings_by_asset.get(asset_id)
        if embedding is None:
            continue
        if cluster_label not in centroids:
            centroids[cluster_label] = [0.0 for _ in embedding]
            counts[cluster_label] = 0
        for idx, value in enumerate(embedding):
            centroids[cluster_label][idx] += value
        counts[cluster_label] += 1

    for label, count in counts.items():
        if count <= 0:
            continue
        centroids[label] = [value / count for value in centroids[label]]

    candidate_assets = [asset_id for asset_id in fused.asset_ids if asset_id not in labeled_assets]
    if limit is not None:
        candidate_assets = candidate_assets[:limit]

    assigned = 0
    skipped = 0
    if not centroids:
        return ClusterAssignmentStats(
            run_id=run_id,
            candidates=len(candidate_assets),
            assigned=0,
            skipped=len(candidate_assets),
            clusters=0,
        )

    with db.connect(db_path) as connection:
        for asset_id in candidate_assets:
            embedding = embeddings_by_asset.get(asset_id)
            if embedding is None:
                skipped += 1
                continue
            best_label = None
            best_score = -1.0
            for label, centroid in centroids.items():
                score = _cosine_similarity(embedding, centroid)
                if score > best_score:
                    best_score = score
                    best_label = label
            if best_label is None or (
                similarity_threshold is not None and best_score < similarity_threshold
            ):
                skipped += 1
                continue
            db.insert_cluster_label(
                connection,
                run_id=run_id,
                asset_id=asset_id,
                cluster_label=int(best_label),
                probability=float(best_score),
            )
            assigned += 1
        connection.commit()

    return ClusterAssignmentStats(
        run_id=run_id,
        candidates=len(candidate_assets),
        assigned=assigned,
        skipped=skipped,
        clusters=len(centroids),
    )
