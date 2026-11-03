from __future__ import annotations

from pathlib import Path

from stylevault.captions import CAPTION_TYPES, caption_assets, get_caption_model
from stylevault.embeddings import embed_assets, get_embedding_model
from stylevault.scores import get_score_model, score_assets


def run_incremental_update(
    db_path: Path,
    embed_models: list[str],
    caption_models: list[str],
    caption_types: list[str],
    caption_prompts: dict[str, str | None],
    score_models: list[str],
    score_prompt: str | None,
    *,
    settings: dict | None = None,
    config_path: Path | None = None,
    limit: int | None = None,
) -> dict[str, dict[str, dict[str, int]]]:
    stats: dict[str, dict[str, dict[str, int]]] = {
        "embeddings": {},
        "captions": {},
        "scores": {},
    }

    for model_name in embed_models:
        model = get_embedding_model(model_name)
        stats["embeddings"][model_name] = embed_assets(db_path, model, limit=limit)

    for model_name in caption_models:
        model = get_caption_model(model_name)
        for caption_type in caption_types:
            if model_name == "filename" and caption_type == "tags":
                continue
            if caption_type not in CAPTION_TYPES:
                raise ValueError(f"Unknown caption type: {caption_type}")
            prompt = caption_prompts.get(caption_type)
            key = f"{model_name}:{caption_type}"
            stats["captions"][key] = caption_assets(
                db_path,
                model,
                caption_type=caption_type,
                prompt=prompt,
                limit=limit,
                extract_caption_tags=True,
            )

    for model_name in score_models:
        model = get_score_model(
            model_name,
            prompt=score_prompt,
            settings=settings,
            config_path=config_path,
        )
        stats["scores"][model_name] = score_assets(db_path, model, limit=limit)

    return stats
