from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import logging
from pathlib import Path
import sqlite3

from PIL import Image

from stylevault import db
from stylevault.model_cache import get_hf_load_kwargs
from stylevault.tags import extract_tags, parse_tags_caption


@dataclass(frozen=True)
class CaptionModel:
    name: str
    version: str
    description: str

    def generate(
        self,
        image: Image.Image,
        source_path: Path,
        prompt: str | None = None,
    ) -> str:
        raise NotImplementedError

    def generate_batch(
        self,
        images: list[Image.Image],
        source_paths: list[Path],
        prompt: str | None = None,
    ) -> list[str]:
        return [
            self.generate(image, source_path, prompt=prompt)
            for image, source_path in zip(images, source_paths, strict=False)
        ]


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


class FilenameCaptionModel(CaptionModel):
    def __init__(self) -> None:
        super().__init__(
            name="filename",
            version="v1",
            description="Fast captioning based on cleaned filenames.",
        )

    def generate(
        self,
        image: Image.Image,
        source_path: Path,
        prompt: str | None = None,
    ) -> str:
        stem = source_path.stem.replace("_", " ").replace("-", " ")
        return " ".join(part for part in stem.split() if part.strip()) or "untitled image"

    def generate_batch(
        self,
        images: list[Image.Image],
        source_paths: list[Path],
        prompt: str | None = None,
    ) -> list[str]:
        return [self.generate(image, path, prompt=prompt) for image, path in zip(images, source_paths, strict=False)]


class BlipCaptionModel(CaptionModel):
    def __init__(self, model_id: str = "Salesforce/blip-image-captioning-base") -> None:
        super().__init__(
            name="blip",
            version=model_id,
            description="BLIP image captioning via transformers.",
        )
        self._model_id = model_id
        self._processor = None
        self._model = None
        self._device = None

    def _load(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import BlipForConditionalGeneration, BlipProcessor

        hf_kwargs = get_hf_load_kwargs()
        self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self._processor = BlipProcessor.from_pretrained(self._model_id, **hf_kwargs)
        self._model = BlipForConditionalGeneration.from_pretrained(self._model_id, **hf_kwargs)
        self._model.to(self._device)
        self._model.eval()

    def generate(
        self,
        image: Image.Image,
        source_path: Path,
        prompt: str | None = None,
    ) -> str:
        self._load()
        if self._model is None or self._processor is None or self._device is None:
            raise RuntimeError("BLIP model failed to initialize.")
        import torch

        if prompt:
            inputs = self._processor(images=image, text=prompt, return_tensors="pt").to(self._device)
        else:
            inputs = self._processor(images=image, return_tensors="pt").to(self._device)
        with torch.inference_mode():
            output = self._model.generate(**inputs, max_new_tokens=32)
        return self._processor.decode(output[0], skip_special_tokens=True)

    def generate_batch(
        self,
        images: list[Image.Image],
        source_paths: list[Path],
        prompt: str | None = None,
    ) -> list[str]:
        self._load()
        if self._model is None or self._processor is None or self._device is None:
            raise RuntimeError("BLIP model failed to initialize.")
        import torch

        if prompt:
            inputs = self._processor(images=images, text=[prompt] * len(images), return_tensors="pt")
        else:
            inputs = self._processor(images=images, return_tensors="pt")
        inputs = inputs.to(self._device)
        with torch.inference_mode():
            outputs = self._model.generate(**inputs, max_new_tokens=32)
        return [
            self._processor.decode(output, skip_special_tokens=True) for output in outputs
        ]


class UnavailableCaptionModel(CaptionModel):
    def __init__(self, name: str, version: str, description: str, detail: str) -> None:
        super().__init__(name=name, version=version, description=description)
        self._detail = detail

    def generate(
        self,
        image: Image.Image,
        source_path: Path,
        prompt: str | None = None,
    ) -> str:
        raise RuntimeError(self._detail)


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _build_blip_captioner() -> CaptionModel:
    if not _module_available("torch") or not _module_available("transformers"):
        return UnavailableCaptionModel(
            name="blip",
            version="pending",
            description="BLIP captioning (pending model integration).",
            detail="BLIP requires torch and transformers. Install the dependencies to enable it.",
        )
    return BlipCaptionModel()


MODEL_REGISTRY: dict[str, CaptionModel] = {
    "filename": FilenameCaptionModel(),
    "blip": _build_blip_captioner(),
}

CAPTION_TYPES = {"long", "short", "tags"}


def get_caption_model(name: str) -> CaptionModel:
    if name not in MODEL_REGISTRY:
        raise KeyError(f"Unknown caption model: {name}")
    return MODEL_REGISTRY[name]


def caption_assets(
    db_path: Path,
    model: CaptionModel,
    caption_type: str,
    prompt: str | None = None,
    limit: int | None = None,
    extract_caption_tags: bool = True,
    batch_size: int = 200,
    commit_every: int = 500,
    overwrite: bool = False,
    shard_index: int = 0,
    shard_total: int = 1,
) -> dict[str, int]:
    logger = logging.getLogger(__name__)
    if caption_type not in CAPTION_TYPES:
        raise ValueError(f"Unknown caption type: {caption_type}")
    if model.name == "filename" and caption_type == "tags":
        logger.info("Skipping filename tags: filename captions do not support tag extraction.")
        return {"captioned": 0, "skipped": 0, "tags_added": 0}
    stats = {"captioned": 0, "skipped": 0, "tags_added": 0}
    with db.connect(db_path) as connection:
        if overwrite:
            db.delete_captions_for_model(
                connection,
                model_name=model.name,
                model_version=model.version,
                caption_type=caption_type,
            )
            db.rebuild_search_index(connection)
        pending = 0
        processed = 0
        shard_key = f"{shard_index}/{shard_total}"
        resume_token = db.fetch_resume_token(
            connection,
            pipeline="captions",
            model_name=model.name,
            model_version=model.version,
            caption_type=caption_type,
            shard_key=shard_key,
        )
        tracker = ResumeTracker(
            pipeline="captions",
            model_name=model.name,
            model_version=model.version,
            caption_type=caption_type,
            shard_key=shard_key,
        )
        batch: list[sqlite3.Row] = []
        for asset in db.iter_assets_missing_captions(
            connection,
            model_name=model.name,
            model_version=model.version,
            caption_type=caption_type,
            batch_size=batch_size,
            start_after=resume_token or 0,
            shard_total=shard_total,
            shard_index=shard_index,
        ):
            if limit is not None and processed >= limit:
                break
            batch.append(asset)
            if len(batch) >= batch_size:
                processed += _process_caption_batch(
                    batch,
                    model,
                    caption_type,
                    prompt,
                    extract_caption_tags,
                    connection,
                    stats,
                    commit_every,
                    pending,
                    tracker,
                )
                pending = stats.pop("_pending", pending)
                batch = []
        if batch:
            processed += _process_caption_batch(
                batch,
                model,
                caption_type,
                prompt,
                extract_caption_tags,
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


def _process_caption_batch(
    batch: list[sqlite3.Row],
    model: CaptionModel,
    caption_type: str,
    prompt: str | None,
    extract_caption_tags: bool,
    connection: sqlite3.Connection,
    stats: dict[str, int],
    commit_every: int,
    pending: int,
    tracker: ResumeTracker,
) -> int:
    logger = logging.getLogger(__name__)
    assets: list[sqlite3.Row] = []
    images: list[Image.Image] = []
    source_paths: list[Path] = []
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
        source_paths.append(source_path)

    if not assets:
        return processed

    try:
        captions = model.generate_batch(images, source_paths, prompt=prompt)
    except RuntimeError as error:
        logger.warning("Batch caption failed: %s", error)
        captions = []

    if captions and len(captions) == len(assets):
        for asset, caption in zip(assets, captions, strict=False):
            pending, processed = _insert_caption(
                asset,
                model,
                caption,
                caption_type,
                extract_caption_tags,
                connection,
                stats,
                commit_every,
                pending,
                processed,
                tracker,
            )
    else:
        for asset, image, path in zip(assets, images, source_paths, strict=False):
            try:
                caption = model.generate(image, path, prompt=prompt)
            except RuntimeError as error:
                logger.warning("Failed to caption %s: %s", path, error)
                stats["skipped"] += 1
                processed += 1
                tracker.update(int(asset["id"]))
                continue
            pending, processed = _insert_caption(
                asset,
                model,
                caption,
                caption_type,
                extract_caption_tags,
                connection,
                stats,
                commit_every,
                pending,
                processed,
                tracker,
            )

    stats["_pending"] = pending
    return processed


def _insert_caption(
    asset: sqlite3.Row,
    model: CaptionModel,
    caption: str,
    caption_type: str,
    extract_caption_tags: bool,
    connection: sqlite3.Connection,
    stats: dict[str, int],
    commit_every: int,
    pending: int,
    processed: int,
    tracker: ResumeTracker,
) -> tuple[int, int]:
    db.insert_caption(
        connection,
        asset_id=asset["id"],
        model_name=model.name,
        model_version=model.version,
        caption_type=caption_type,
        caption=caption,
    )
    if caption_type == "tags":
        tags = parse_tags_caption(caption)
        for tag in tags:
            inserted = db.insert_tag(
                connection,
                asset_id=asset["id"],
                tag=tag,
                source="caption-tags",
            )
            if inserted is not None:
                stats["tags_added"] += 1
    elif extract_caption_tags:
        tags = extract_tags(caption)
        for tag in tags:
            inserted = db.insert_tag(connection, asset_id=asset["id"], tag=tag, source="caption")
            if inserted is not None:
                stats["tags_added"] += 1
    stats["captioned"] += 1
    processed += 1
    pending += 1
    tracker.update(int(asset["id"]))
    if pending >= commit_every:
        connection.commit()
        tracker.flush(connection)
        pending = 0
    return pending, processed
