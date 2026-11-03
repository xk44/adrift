from __future__ import annotations

from io import BytesIO
from pathlib import Path
import threading
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from PIL import Image
from pydantic import BaseModel

from stylevault.omnitag import FilenameOmniTagCaptionModel, _module_available, get_omnitag_model


class CaptionImageResponse(BaseModel):
    caption: str
    model: str
    model_version: str


def build_caption_router(settings: dict[str, Any]) -> APIRouter:
    router = APIRouter(prefix="/caption", tags=["caption"])
    # One resident VL captioner: loading it is ~10 s and several GB, so reuse it across requests
    # and serialise generation (one model, one device).
    resident: dict[str, Any] = {}
    lock = threading.Lock()

    def resident_model(model_id: str) -> Any:
        model = resident.get(model_id)
        if model is None:
            resident.clear()
            model = resident[model_id] = get_omnitag_model(model_id)
            if hasattr(model, "do_sample"):
                model.do_sample = False  # deterministic, cleaner captions for prompt seeding
        return model

    def run_caption(model_id: str, image: Image.Image, filename: str, prompt: str | None) -> tuple[str, Any]:
        with lock:
            model = resident_model(model_id)
            return model.generate(image, Path(filename), prompt=prompt), model

    @router.post("/image", response_model=CaptionImageResponse)
    async def caption_image(
        request: Request,
        filename: str = Query(default="uploaded-image"),
        prompt: str | None = Query(default=None),
    ) -> CaptionImageResponse:
        image_bytes = await request.body()
        if not image_bytes:
            raise HTTPException(status_code=400, detail="Missing image body.")

        try:
            with Image.open(BytesIO(image_bytes)) as image:
                rgb_image = image.convert("RGB")
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid image body.") from exc

        omnitag_cfg = (
            settings.get("omnitag", {}) if isinstance(settings.get("omnitag", {}), dict) else {}
        )
        resolved_model_id = str(omnitag_cfg.get("model_id", "Qwen/Qwen3-VL-4B-Instruct"))
        try:
            if _module_available("torch") and _module_available("transformers"):
                caption, model = await run_in_threadpool(
                    run_caption, resolved_model_id, rgb_image, filename, prompt
                )
            else:
                model = FilenameOmniTagCaptionModel()
                caption = model.generate(rgb_image, Path(filename), prompt=prompt)
        except (ImportError, RuntimeError) as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        return CaptionImageResponse(
            caption=caption.strip(),
            model=model.name,
            model_version=getattr(model, "_loaded_id", None) or model.version,
        )

    return router
