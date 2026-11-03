from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
import sqlite3

import numpy as np
from PIL import Image

from stylevault import db



@dataclass(frozen=True)
class ScoreModel:
    name: str
    version: str
    description: str

    def score(self, image: Image.Image) -> float:
        raise NotImplementedError

    def score_batch(self, images: list[Image.Image]) -> list[float]:
        return [self.score(image) for image in images]


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


class SimpleAestheticScore(ScoreModel):
    def __init__(self) -> None:
        super().__init__(
            name="aesthetic-simple",
            version="v1",
            description="Heuristic aesthetic score based on brightness, contrast, and saturation.",
        )

    def score(self, image: Image.Image) -> float:
        rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        if rgb.size == 0:
            return 0.0
        luminance = rgb.mean(axis=2)
        brightness = float(luminance.mean())
        contrast = float(luminance.std())
        channel_max = rgb.max(axis=2)
        channel_min = rgb.min(axis=2)
        saturation = float(np.mean((channel_max - channel_min) / (channel_max + 1e-6)))
        score = 0.5 * brightness + 0.3 * contrast + 0.2 * saturation
        return float(np.clip(score, 0.0, 1.0))

    def score_batch(self, images: list[Image.Image]) -> list[float]:
        return [self.score(image) for image in images]


MODEL_REGISTRY: dict[str, ScoreModel] = {
    "aesthetic-simple": SimpleAestheticScore(),
}


def get_score_model(
    name: str,
    prompt: str | None = None,
    *,
    settings: dict | None = None,
    config_path: Path | None = None,
) -> ScoreModel:
    if name in MODEL_REGISTRY:
        return MODEL_REGISTRY[name]
    raise KeyError(f"Unknown score model: {name}")


def score_assets(
    db_path: Path,
    model: ScoreModel,
    limit: int | None = None,
    overwrite: bool = False,
    batch_size: int = 200,
    commit_every: int = 500,
    shard_index: int = 0,
    shard_total: int = 1,
) -> dict[str, int]:
    stats = {"scored": 0, "skipped": 0}
    with db.connect(db_path) as connection:
        if overwrite:
            db.delete_scores_for_model(connection, model.name, model.version)
        pending = 0
        processed = 0
        shard_key = f"{shard_index}/{shard_total}"
        resume_token = db.fetch_resume_token(
            connection,
            pipeline="scores",
            model_name=model.name,
            model_version=model.version,
            shard_key=shard_key,
        )
        tracker = ResumeTracker(
            pipeline="scores",
            model_name=model.name,
            model_version=model.version,
            caption_type=None,
            shard_key=shard_key,
        )
        batch: list[sqlite3.Row] = []
        for asset in db.iter_assets_missing_scores(
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
                processed += _process_score_batch(
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
            processed += _process_score_batch(
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


def _process_score_batch(
    batch: list[sqlite3.Row],
    model: ScoreModel,
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
            with Image.open(source_path) as img:
                images.append(img.copy())
        except (OSError, RuntimeError) as error:
            logger.warning("Failed to open asset: %s (%s)", source_path, error)
            stats["skipped"] += 1
            processed += 1
            tracker.update(int(asset["id"]))
            continue
        assets.append(asset)

    if not assets:
        return processed

    try:
        scores = model.score_batch(images)
    except RuntimeError as error:
        logger.warning("Batch scoring failed: %s", error)
        scores = []

    if scores and len(scores) == len(assets):
        for asset, score in zip(assets, scores, strict=False):
            db.insert_score(
                connection,
                asset_id=int(asset["id"]),
                model_name=model.name,
                model_version=model.version,
                score=score,
            )
            stats["scored"] += 1
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
                score = model.score(image)
            except RuntimeError as error:
                logger.warning("Failed to score %s: %s", asset["source_path"], error)
                stats["skipped"] += 1
                processed += 1
                tracker.update(int(asset["id"]))
                continue
            db.insert_score(
                connection,
                asset_id=int(asset["id"]),
                model_name=model.name,
                model_version=model.version,
                score=score,
            )
            stats["scored"] += 1
            processed += 1
            pending += 1
            tracker.update(int(asset["id"]))
            if pending >= commit_every:
                connection.commit()
                tracker.flush(connection)
                pending = 0

    stats["_pending"] = pending
    return processed
