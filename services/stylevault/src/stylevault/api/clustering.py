from __future__ import annotations

import importlib.util
from pathlib import Path

from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

from stylevault.embeddings import get_embedding_model


class ClusterImagesRequest(BaseModel):
    paths: list[str]
    min_cluster_size: int = Field(default=4, ge=2)
    model: str = "color-histogram"


class ClusterGroup(BaseModel):
    label: int
    members: list[str]


class ClusterImagesResponse(BaseModel):
    clusters: list[ClusterGroup]
    noise: list[str]
    skipped: list[str]
    model: str


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _cluster_embeddings(embeddings: list[list[float]], min_cluster_size: int) -> list[int]:
    if len(embeddings) < min_cluster_size:
        return [0 for _ in embeddings]
    if not _module_available("hdbscan") or not _module_available("numpy"):
        return [0 for _ in embeddings]

    import numpy as np
    from hdbscan import HDBSCAN

    matrix = np.asarray(embeddings, dtype=np.float32)
    clusterer = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=None,
        cluster_selection_epsilon=0.0,
        metric="euclidean",
    )
    clusterer.fit(matrix)
    return [int(label) for label in clusterer.labels_.tolist()]


def build_cluster_router() -> APIRouter:
    router = APIRouter(prefix="/cluster", tags=["cluster"])

    @router.post("/images", response_model=ClusterImagesResponse)
    async def cluster_images(payload: ClusterImagesRequest) -> ClusterImagesResponse:
        try:
            model = get_embedding_model(payload.model)
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        readable_paths: list[str] = []
        images: list[Image.Image] = []
        skipped: list[str] = []

        for raw_path in payload.paths:
            path = Path(raw_path).expanduser()
            try:
                with Image.open(path) as image:
                    images.append(image.convert("RGB"))
                readable_paths.append(str(path))
            except Exception:
                skipped.append(raw_path)

        if not images:
            return ClusterImagesResponse(
                clusters=[],
                noise=[],
                skipped=skipped,
                model=model.name,
            )

        try:
            embeddings = model.encode_batch(images)
            labels = _cluster_embeddings(embeddings, payload.min_cluster_size)
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        grouped: dict[int, list[str]] = {}
        noise: list[str] = []
        for image_path, label in zip(readable_paths, labels, strict=False):
            if label < 0:
                noise.append(image_path)
            else:
                grouped.setdefault(label, []).append(image_path)

        return ClusterImagesResponse(
            clusters=[
                ClusterGroup(label=label, members=members)
                for label, members in sorted(grouped.items())
            ],
            noise=noise,
            skipped=skipped,
            model=model.name,
        )

    return router
