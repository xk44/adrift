from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import logging
import math
from pathlib import Path

from stylevault import db


@dataclass(frozen=True)
class KnnGraphStats:
    run_id: int
    assets: int
    edges: int


def _cosine_similarity(lhs: list[float], rhs: list[float]) -> float:
    dot = sum(a * b for a, b in zip(lhs, rhs))
    lhs_norm = math.sqrt(sum(a * a for a in lhs))
    rhs_norm = math.sqrt(sum(b * b for b in rhs))
    if lhs_norm == 0.0 or rhs_norm == 0.0:
        return 0.0
    return dot / (lhs_norm * rhs_norm)


def _normalize_weights(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("Fusion weights must sum to a positive value.")
    return {key: value / total for key, value in weights.items()}


def build_fused_knn_graph(
    db_path: Path,
    models: list[str],
    weights: dict[str, float],
    k: int = 15,
    approx: bool = True,
    metric: str = "cosine",
    batch_size: int = 512,
    cache_dir: Path | None = None,
) -> KnnGraphStats:
    logger = logging.getLogger(__name__)
    if k <= 0:
        raise ValueError("k must be positive.")
    if not models:
        raise ValueError("At least one embedding model is required.")
    missing_weights = [model for model in models if model not in weights]
    if missing_weights:
        raise ValueError(f"Missing fusion weights for models: {', '.join(missing_weights)}")

    normalized_weights = _normalize_weights(weights)
    from stylevault.fusion import build_fused_embeddings

    fused = build_fused_embeddings(
        db_path, models, normalized_weights, cache_dir=cache_dir
    )
    if not fused.asset_ids:
        raise ValueError("No assets have embeddings for all requested models.")

    import numpy as np

    vectors = np.array(fused.embeddings, dtype="float32")
    if metric not in {"cosine", "l2"}:
        raise ValueError("metric must be 'cosine' or 'l2'")

    use_faiss = importlib.util.find_spec("faiss") is not None
    if metric == "cosine":
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vectors = vectors / norms

    if use_faiss:
        import faiss

        dim = vectors.shape[1]
        if approx:
            index = faiss.IndexHNSWFlat(dim, 32)
            index.hnsw.efConstruction = 200
        else:
            index = faiss.IndexFlatIP(dim) if metric == "cosine" else faiss.IndexFlatL2(dim)
        index.add(vectors)
        search_k = k + 1
        score_batches = []
        id_batches = []
        for start in range(0, len(vectors), batch_size):
            batch = vectors[start : start + batch_size]
            batch_scores, batch_ids = index.search(batch, search_k)
            score_batches.append(batch_scores)
            id_batches.append(batch_ids)
        scores = np.vstack(score_batches)
        ids = np.vstack(id_batches)
    else:
        logger.warning("faiss not available; falling back to exact brute-force search.")
        search_k = k + 1
        scores = np.zeros((len(vectors), search_k), dtype="float32")
        ids = np.zeros((len(vectors), search_k), dtype="int64")
        for i, vec in enumerate(vectors):
            if metric == "cosine":
                sim = vectors @ vec
            else:
                diff = vectors - vec
                sim = -np.sum(diff * diff, axis=1)
            order = np.argsort(-sim)[:search_k]
            scores[i] = sim[order]
            ids[i] = order

    with db.connect(db_path) as connection:
        db.ensure_knn_graph_schema(connection)
        run_id = db.insert_knn_graph_run(
            connection,
            models=[
                {"name": name, "version": fused.model_versions[name]} for name in models
            ],
            weights=normalized_weights,
            k=k,
        )

        edges_written = 0
        for idx, source_id in enumerate(fused.asset_ids):
            neighbors = []
            for neighbor_idx, score in zip(ids[idx], scores[idx], strict=False):
                if neighbor_idx == idx:
                    continue
                neighbors.append((fused.asset_ids[int(neighbor_idx)], float(score)))
            neighbors = neighbors[:k]
            for rank, (neighbor_id, score) in enumerate(neighbors, start=1):
                db.insert_knn_graph_edge(
                    connection,
                    run_id=run_id,
                    source_asset_id=source_id,
                    neighbor_asset_id=neighbor_id,
                    score=score,
                    rank=rank,
                )
                edges_written += 1
        connection.commit()

    logger.info(
        "Fused kNN graph run %s complete: %s assets, %s edges.",
        run_id,
        len(fused.asset_ids),
        edges_written,
    )
    return KnnGraphStats(run_id=run_id, assets=len(fused.asset_ids), edges=edges_written)
