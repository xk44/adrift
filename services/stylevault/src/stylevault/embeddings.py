from __future__ import annotations

from array import array
import csv
from dataclasses import dataclass
import json
import importlib.util
import logging
import math
import os
from pathlib import Path
import sqlite3

from PIL import Image

from stylevault import db
from stylevault.model_cache import get_hf_load_kwargs


@dataclass(frozen=True)
class EmbeddingModel:
    name: str
    version: str
    description: str

    def encode(self, image: Image.Image) -> list[float]:
        raise NotImplementedError

    def encode_batch(self, images: list[Image.Image]) -> list[list[float]]:
        return [self.encode(image) for image in images]


@dataclass
class ResumeTracker:
    pipeline: str
    model_name: str
    model_version: str
    caption_type: str | None
    shard_key: str
    last_asset_id: int | None = None

    def update(self, asset_id: int) -> None:
        self.last_asset_id = int(asset_id)

    def flush(self, connection: sqlite3.Connection) -> None:
        if self.last_asset_id is None:
            return
        db.update_resume_token(
            connection,
            pipeline=self.pipeline,
            model_name=self.model_name,
            model_version=self.model_version,
            caption_type=self.caption_type,
            shard_key=self.shard_key,
            last_asset_id=self.last_asset_id,
        )


class ColorHistogramEmbedding(EmbeddingModel):
    def __init__(self, bins: int = 8) -> None:
        super().__init__(
            name="color-histogram",
            version="v1",
            description=f"RGB histogram with {bins} bins per channel.",
        )
        self._bins = bins

    def encode(self, image: Image.Image) -> list[float]:
        rgb = image.convert("RGB")
        bins = self._bins
        counts = [0] * (bins * 3)
        histogram = rgb.histogram()
        channel_size = 256
        for channel_idx in range(3):
            offset = channel_idx * channel_size
            for value in range(channel_size):
                bucket = min(value * bins // channel_size, bins - 1)
                counts[channel_idx * bins + bucket] += histogram[offset + value]
        total = float(rgb.width * rgb.height) or 1.0
        return [value / total for value in counts]

    def encode_batch(self, images: list[Image.Image]) -> list[list[float]]:
        if not images:
            return []
        return [self.encode(image) for image in images]


class SigLIP2Embedding(EmbeddingModel):
    def __init__(self, model_id: str = "google/siglip2-base-patch16-256") -> None:
        super().__init__(
            name="siglip2",
            version=model_id,
            description="SigLIP2 image embedding via transformers.",
        )
        self._model_id = model_id
        self._model = None
        self._processor = None
        self._device = None

    def _load(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import AutoImageProcessor, AutoModel

        hf_kwargs = get_hf_load_kwargs()
        self._device = _pick_torch_device(torch)
        self._processor = AutoImageProcessor.from_pretrained(self._model_id, **hf_kwargs)
        self._model = AutoModel.from_pretrained(self._model_id, **hf_kwargs)
        self._model.eval()
        self._model.to(self._device)

    def encode(self, image: Image.Image) -> list[float]:
        self._load()
        if self._model is None or self._processor is None or self._device is None:
            raise RuntimeError("SigLIP2 model failed to initialize.")
        import torch

        inputs = self._processor(images=image, return_tensors="pt")
        inputs = {key: value.to(self._device) for key, value in inputs.items()}
        with torch.inference_mode():
            outputs = self._model(**inputs)
        embedding = getattr(outputs, "pooler_output", None)
        if embedding is None:
            embedding = outputs.last_hidden_state.mean(dim=1)
        return embedding.squeeze(0).detach().cpu().float().tolist()

    def encode_batch(self, images: list[Image.Image]) -> list[list[float]]:
        if not images:
            return []
        self._load()
        if self._model is None or self._processor is None or self._device is None:
            raise RuntimeError("SigLIP2 model failed to initialize.")
        import torch

        inputs = self._processor(images=images, return_tensors="pt")
        inputs = {key: value.to(self._device) for key, value in inputs.items()}
        with torch.inference_mode():
            outputs = self._model(**inputs)
        embedding = getattr(outputs, "pooler_output", None)
        if embedding is None:
            embedding = outputs.last_hidden_state.mean(dim=1)
        return embedding.detach().cpu().float().tolist()


class UnavailableEmbedding(EmbeddingModel):
    def __init__(self, name: str, version: str, description: str, detail: str) -> None:
        super().__init__(name=name, version=version, description=description)
        self._detail = detail

    def encode(self, image: Image.Image) -> list[float]:
        raise RuntimeError(self._detail)


@dataclass(frozen=True)
class EmbeddingHead:
    name: str
    base_model: str
    base_version: str
    weights: list[float]
    description: str

    @property
    def version(self) -> str:
        return f"head:{self.base_model}@{self.base_version}:{self.name}"


class HeadEmbeddingModel(EmbeddingModel):
    def __init__(self, head: EmbeddingHead, base_model: EmbeddingModel) -> None:
        super().__init__(
            name=f"head-{head.name}",
            version=head.version,
            description=head.description,
        )
        self._head = head
        self._base_model = base_model

    def encode(self, image: Image.Image) -> list[float]:
        base_embedding = self._base_model.encode(image)
        weights = self._head.weights
        if len(base_embedding) != len(weights):
            raise RuntimeError(
                "Embedding head dimension mismatch: "
                f"base={len(base_embedding)} head={len(weights)}"
            )
        return [value * weight for value, weight in zip(base_embedding, weights, strict=False)]


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _pick_torch_device(torch):  # noqa: ANN001 - torch imported lazily by callers
    """cuda > mps > cpu — CUDA-first for linux boxes, Apple-Silicon MPS on mac."""
    if torch.cuda.is_available():
        return torch.device("cuda")
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _build_siglip2_embedding() -> EmbeddingModel:
    if not _module_available("torch") or not _module_available("transformers"):
        return UnavailableEmbedding(
            name="siglip2",
            version="pending",
            description="SigLIP2 image embedding (pending model integration).",
            detail="SigLIP2 requires torch and transformers. Install the dependencies to enable it.",
        )
    return SigLIP2Embedding()


MODEL_REGISTRY: dict[str, EmbeddingModel] = {
    "color-histogram": ColorHistogramEmbedding(),
    "siglip2": _build_siglip2_embedding(),
}


def get_embedding_model(name: str) -> EmbeddingModel:
    if name not in MODEL_REGISTRY:
        raise KeyError(f"Unknown embedding model: {name}")
    return MODEL_REGISTRY[name]


def register_embedding_head(head: EmbeddingHead) -> EmbeddingModel:
    base_model = get_embedding_model(head.base_model)
    if base_model.version != head.base_version:
        logging.getLogger(__name__).warning(
            "Embedding head '%s' expects base version '%s' but found '%s'.",
            head.name,
            head.base_version,
            base_model.version,
        )
    head_model = HeadEmbeddingModel(head=head, base_model=base_model)
    MODEL_REGISTRY[head_model.name] = head_model
    return head_model


def load_embedding_head(path: Path) -> EmbeddingHead:
    payload = json.loads(path.read_text())
    weights = payload.get("weights")
    if not isinstance(weights, list) or not weights:
        raise ValueError(f"Invalid head file: {path}")
    return EmbeddingHead(
        name=str(payload.get("name", path.stem)),
        base_model=str(payload["base_model"]),
        base_version=str(payload["base_version"]),
        weights=[float(value) for value in weights],
        description=str(payload.get("description", "User-trained embedding head.")),
    )


def write_embedding_head(path: Path, head: EmbeddingHead) -> None:
    payload = {
        "name": head.name,
        "base_model": head.base_model,
        "base_version": head.base_version,
        "description": head.description,
        "weights": head.weights,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def serialize_embedding(values: list[float]) -> bytes:
    return array("f", values).tobytes()


def deserialize_embedding(blob: bytes) -> list[float]:
    vec = array("f")
    vec.frombytes(blob)
    return list(vec)


def cosine_similarity(lhs: list[float], rhs: list[float]) -> float:
    dot = sum(a * b for a, b in zip(lhs, rhs))
    lhs_norm = math.sqrt(sum(a * a for a in lhs))
    rhs_norm = math.sqrt(sum(b * b for b in rhs))
    if lhs_norm == 0.0 or rhs_norm == 0.0:
        return 0.0
    return dot / (lhs_norm * rhs_norm)


def embed_assets(
    db_path: Path,
    model: EmbeddingModel,
    limit: int | None = None,
    batch_size: int = 200,
    commit_every: int = 500,
    shard_index: int = 0,
    shard_total: int = 1,
) -> dict[str, int]:
    stats = {"embedded": 0, "skipped": 0}
    with db.connect(db_path) as connection:
        pending = 0
        processed = 0
        shard_key = f"{shard_index}/{shard_total}"
        resume_token = db.fetch_resume_token(
            connection,
            pipeline="embeddings",
            model_name=model.name,
            model_version=model.version,
            shard_key=shard_key,
        )
        tracker = ResumeTracker(
            pipeline="embeddings",
            model_name=model.name,
            model_version=model.version,
            caption_type=None,
            shard_key=shard_key,
        )
        batch: list[sqlite3.Row] = []
        for asset in db.iter_assets_missing_embeddings(
            connection,
            model_name=model.name,
            model_version=model.version,
            batch_size=batch_size,
            start_after=resume_token or 0,
            shard_total=shard_total,
            shard_index=shard_index,
        ):
            if limit is not None and processed >= limit:
                break
            batch.append(asset)
            if len(batch) >= batch_size:
                processed += _process_embedding_batch(
                    batch,
                    model,
                    connection,
                    stats,
                    commit_every,
                    pending,
                    tracker,
                )
                pending = stats.pop("_pending", pending)
                batch = []
        if batch:
            processed += _process_embedding_batch(
                batch,
                model,
                connection,
                stats,
                commit_every,
                pending,
                tracker,
            )
            pending = stats.pop("_pending", pending)
        if pending:
            connection.commit()
            tracker.flush(connection)
    return stats


def _process_embedding_batch(
    batch: list[sqlite3.Row],
    model: EmbeddingModel,
    connection: sqlite3.Connection,
    stats: dict[str, int],
    commit_every: int,
    pending: int,
    tracker: ResumeTracker,
) -> int:
    logger = logging.getLogger(__name__)
    assets: list[sqlite3.Row] = []
    images: list[Image.Image] = []
    processed = 0
    for asset in batch:
        source_path = Path(asset["source_path"])
        if not source_path.exists():
            logger.warning("Missing asset on disk: %s", source_path)
            stats["skipped"] += 1
            processed += 1
            tracker.update(int(asset["id"]))
            continue
        try:
            with Image.open(source_path) as image:
                images.append(image.copy())
        except (OSError, RuntimeError) as error:
            logger.warning("Failed to open %s: %s", source_path, error)
            stats["skipped"] += 1
            processed += 1
            tracker.update(int(asset["id"]))
            continue
        assets.append(asset)

    if not assets:
        return processed

    try:
        embeddings = model.encode_batch(images)
    except RuntimeError as error:
        logger.warning("Batch embedding failed: %s", error)
        embeddings = []

    if embeddings and len(embeddings) == len(assets):
        for asset, embedding in zip(assets, embeddings, strict=False):
            db.insert_embedding(
                connection,
                asset_id=asset["id"],
                model_name=model.name,
                model_version=model.version,
                embedding=serialize_embedding(embedding),
            )
            stats["embedded"] += 1
            processed += 1
            pending += 1
            tracker.update(int(asset["id"]))
            if pending >= commit_every:
                connection.commit()
                tracker.flush(connection)
                pending = 0
    else:
        for asset, image in zip(assets, images, strict=False):
            try:
                embedding = model.encode(image)
            except RuntimeError as error:
                logger.warning("Failed to embed %s: %s", asset["source_path"], error)
                stats["skipped"] += 1
                processed += 1
                tracker.update(int(asset["id"]))
                continue
            db.insert_embedding(
                connection,
                asset_id=asset["id"],
                model_name=model.name,
                model_version=model.version,
                embedding=serialize_embedding(embedding),
            )
            stats["embedded"] += 1
            processed += 1
            pending += 1
            tracker.update(int(asset["id"]))
            if pending >= commit_every:
                connection.commit()
                tracker.flush(connection)
                pending = 0

    stats["_pending"] = pending
    return processed


def knn_search(
    db_path: Path,
    query_embedding: list[float],
    model: EmbeddingModel,
    limit: int = 5,
) -> list[tuple[int, float]]:
    results: list[tuple[int, float]] = []
    with db.connect(db_path) as connection:
        rows = db.fetch_embeddings_for_model(connection, model.name, model.version)
        for row in rows:
            embedding = deserialize_embedding(row["embedding"])
            score = cosine_similarity(query_embedding, embedding)
            results.append((row["asset_id"], score))
    results.sort(key=lambda item: item[1], reverse=True)
    return results[:limit]


def train_embedding_head(
    db_path: Path,
    base_model_name: str,
    labels_path: Path,
    head_name: str,
    output_path: Path,
    description: str | None = None,
) -> EmbeddingHead:
    import numpy as np

    labels: dict[int, int] = {}
    with labels_path.open("r", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if "asset_id" not in reader.fieldnames or "label" not in reader.fieldnames:
            raise ValueError("Labels CSV must include 'asset_id' and 'label' columns.")
        for row in reader:
            asset_id = int(row["asset_id"])
            label = int(row["label"])
            labels[asset_id] = 1 if label > 0 else 0

    if not labels:
        raise ValueError("No labels found for embedding head training.")

    base_model = get_embedding_model(base_model_name)
    with db.connect(db_path) as connection:
        base_version = db.fetch_model_version(connection, base_model.name)
        rows = db.fetch_embeddings_for_assets(
            connection,
            base_model.name,
            base_version,
            list(labels.keys()),
        )

    if not rows:
        raise ValueError("No embeddings found for the provided labels.")

    positives: list[list[float]] = []
    negatives: list[list[float]] = []
    for row in rows:
        embedding = deserialize_embedding(row["embedding"])
        label = labels.get(int(row["asset_id"]))
        if label == 1:
            positives.append(embedding)
        else:
            negatives.append(embedding)

    if not positives or not negatives:
        raise ValueError("Need at least one positive and one negative label to train.")

    pos_mean = np.mean(np.array(positives, dtype="float32"), axis=0)
    neg_mean = np.mean(np.array(negatives, dtype="float32"), axis=0)
    weights = pos_mean - neg_mean
    norm = float(np.linalg.norm(weights))
    if norm > 0:
        weights = weights / norm

    head = EmbeddingHead(
        name=head_name,
        base_model=base_model.name,
        base_version=base_version,
        weights=[float(value) for value in weights.tolist()],
        description=description
        or "User-trained embedding head based on labeled preferences.",
    )
    write_embedding_head(output_path, head)
    return head
