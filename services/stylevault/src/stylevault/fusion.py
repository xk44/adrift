from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import logging
from pathlib import Path

from stylevault import db
from stylevault.embeddings import deserialize_embedding


@dataclass(frozen=True)
class FusedEmbeddings:
    asset_ids: list[int]
    embeddings: list[list[float]]
    model_versions: dict[str, str]
    weights: dict[str, float]


def _normalize_weights(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("Fusion weights must sum to a positive value.")
    return {key: value / total for key, value in weights.items()}


def build_fused_embeddings(
    db_path: Path,
    models: list[str],
    weights: dict[str, float],
    cache_dir: Path | None = None,
) -> FusedEmbeddings:
    if not models:
        raise ValueError("At least one embedding model is required.")
    missing_weights = [model for model in models if model not in weights]
    if missing_weights:
        raise ValueError(f"Missing fusion weights for models: {', '.join(missing_weights)}")

    normalized_weights = _normalize_weights({model: weights[model] for model in models})
    model_specs = [{"name": model, "version": None} for model in models]
    return _build_fused_embeddings_from_specs(
        db_path, model_specs, normalized_weights, cache_dir=cache_dir
    )


def build_fused_embeddings_from_versions(
    db_path: Path,
    models: list[dict[str, str]],
    weights: dict[str, float],
    cache_dir: Path | None = None,
) -> FusedEmbeddings:
    normalized_weights = _normalize_weights(
        {model["name"]: weights[model["name"]] for model in models}
    )
    return _build_fused_embeddings_from_specs(
        db_path, models, normalized_weights, cache_dir=cache_dir
    )


def _build_fused_embeddings_from_specs(
    db_path: Path,
    models: list[dict[str, str | None]],
    weights: dict[str, float],
    cache_dir: Path | None = None,
) -> FusedEmbeddings:
    logger = logging.getLogger(__name__)
    model_names = [model["name"] for model in models]
    missing_weights = [model for model in model_names if model not in weights]
    if missing_weights:
        raise ValueError(f"Missing fusion weights for models: {', '.join(missing_weights)}")

    with db.connect(db_path) as connection:
        model_versions: dict[str, str] = {}
        model_filters: list[tuple[str, str]] = []
        for model in models:
            model_name = str(model["name"])
            model_version = model.get("version") or db.fetch_model_version(connection, model_name)
            model_versions[model_name] = str(model_version)
            model_filters.append((model_name, str(model_version)))

        cached = _load_fused_cache(cache_dir, model_versions, weights)
        if cached is not None:
            logger.info(
                "Loaded fused embeddings cache for %s assets.", len(cached.asset_ids)
            )
            return cached

        if not model_filters:
            raise ValueError("No embeddings found for the requested models.")

        aliases = [f"e{idx}" for idx in range(len(model_filters))]
        select_cols = ["e0.asset_id"] + [
            f"{alias}.embedding AS emb_{idx}" for idx, alias in enumerate(aliases)
        ]
        sql = f"SELECT {', '.join(select_cols)} FROM embeddings e0"
        params: list[object] = []
        for idx, (model_name, model_version) in enumerate(model_filters[1:], start=1):
            alias = aliases[idx]
            sql += (
                f" JOIN embeddings {alias} ON {alias}.asset_id = e0.asset_id"
                f" AND {alias}.model_name = ? AND {alias}.model_version = ?"
            )
            params.extend([model_name, model_version])
        sql += " WHERE e0.model_name = ? AND e0.model_version = ?"
        params.extend([model_filters[0][0], model_filters[0][1]])
        sql += " ORDER BY e0.asset_id"

        cursor = connection.execute(sql, params)
        asset_ids: list[int] = []
        fused_embeddings: list[list[float]] = []
        while True:
            rows = cursor.fetchmany(500)
            if not rows:
                break
            for row in rows:
                asset_id = int(row["asset_id"])
                fused: list[float] = []
                for idx, model_name in enumerate(model_names):
                    embedding = deserialize_embedding(row[f"emb_{idx}"])
                    weight = weights[model_name]
                    fused.extend([value * weight for value in embedding])
                asset_ids.append(asset_id)
                fused_embeddings.append(fused)

        if not asset_ids:
            raise ValueError("No assets have embeddings for all requested models.")

    fused = FusedEmbeddings(
        asset_ids=asset_ids,
        embeddings=fused_embeddings,
        model_versions=model_versions,
        weights=weights,
    )
    _write_fused_cache(cache_dir, fused)
    logger.info(
        "Prepared fused embeddings for %s assets using models: %s",
        len(asset_ids),
        ", ".join(model_names),
    )
    return fused


def _cache_key(model_versions: dict[str, str], weights: dict[str, float]) -> str:
    payload = json.dumps(
        {"model_versions": model_versions, "weights": weights},
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _load_fused_cache(
    cache_dir: Path | None,
    model_versions: dict[str, str],
    weights: dict[str, float],
) -> FusedEmbeddings | None:
    if cache_dir is None:
        return None
    try:
        import numpy as np
    except ImportError:
        return None
    cache_path = cache_dir / f"fused_{_cache_key(model_versions, weights)}.npz"
    if not cache_path.exists():
        return None
    try:
        data = np.load(cache_path, allow_pickle=False)
    except OSError:
        return None
    metadata = json.loads(str(data["metadata"][0]))
    if metadata.get("model_versions") != model_versions or metadata.get("weights") != weights:
        return None
    asset_ids = data["asset_ids"].astype(int).tolist()
    embeddings = data["embeddings"].tolist()
    return FusedEmbeddings(
        asset_ids=asset_ids,
        embeddings=embeddings,
        model_versions=model_versions,
        weights=weights,
    )


def _write_fused_cache(cache_dir: Path | None, fused: FusedEmbeddings) -> None:
    if cache_dir is None:
        return
    try:
        import numpy as np
    except ImportError:
        return
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"fused_{_cache_key(fused.model_versions, fused.weights)}.npz"
    metadata = json.dumps(
        {"model_versions": fused.model_versions, "weights": fused.weights},
        sort_keys=True,
    )
    np.savez_compressed(
        cache_path,
        asset_ids=np.array(fused.asset_ids, dtype="int64"),
        embeddings=np.array(fused.embeddings, dtype="float32"),
        metadata=np.array([metadata]),
    )
