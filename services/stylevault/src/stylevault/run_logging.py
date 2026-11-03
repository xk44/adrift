from __future__ import annotations

from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
import hashlib
import platform
import sys
from importlib import metadata, util
from pathlib import Path
from typing import Any

DEFAULT_LOG_LIBRARIES = [
    "pillow",
    "numpy",
    "torch",
    "torchvision",
    "transformers",
    "open-clip-torch",
    "hdbscan",
    "umap-learn",
]


def _ensure_timezone(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_config_snapshot(config_path: Path, fallback_text: str | None = None) -> dict[str, Any]:
    if config_path.exists():
        snapshot = config_path.read_text(encoding="utf-8")
        source = "file"
    elif fallback_text is not None:
        snapshot = fallback_text
        source = "default"
    else:
        snapshot = None
        source = "missing"
    return {
        "path": str(config_path),
        "exists": config_path.exists(),
        "source": source,
        "sha256": _sha256_text(snapshot) if snapshot is not None else None,
        "snapshot": snapshot,
    }


def build_library_versions(packages: list[str]) -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for package in packages:
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            versions[package] = None
    return versions


def detect_device() -> dict[str, Any]:
    device_info = {"device": "cpu", "cuda_available": False}
    if util.find_spec("torch") is None:
        return device_info
    import torch

    cuda_available = torch.cuda.is_available()
    device_info["cuda_available"] = cuda_available
    device_info["device"] = "cuda" if cuda_available else "cpu"
    return device_info


def build_runtime_environment(
    libraries: list[str],
    batch_size: int | None = None,
) -> dict[str, Any]:
    runtime = {
        "python": sys.version,
        "platform": platform.platform(),
        "batch_size": batch_size,
        "libraries": build_library_versions(libraries),
    }
    runtime.update(detect_device())
    return runtime


def embedding_model_metadata(names: list[str]) -> list[dict[str, Any]]:
    from stylevault.embeddings import get_embedding_model

    entries: list[dict[str, Any]] = []
    for name in names:
        try:
            model = get_embedding_model(name)
            entries.append(
                {
                    "name": model.name,
                    "version": model.version,
                    "description": model.description,
                }
            )
        except Exception as error:
            entries.append({"name": name, "error": str(error)})
    return entries


def caption_model_metadata(names: list[str]) -> list[dict[str, Any]]:
    from stylevault.captions import get_caption_model

    entries: list[dict[str, Any]] = []
    for name in names:
        try:
            model = get_caption_model(name)
            entries.append(
                {
                    "name": model.name,
                    "version": model.version,
                    "description": model.description,
                }
            )
        except Exception as error:
            entries.append({"name": name, "error": str(error)})
    return entries


def score_model_metadata(
    names: list[str],
    prompt: str | None = None,
    *,
    settings: dict | None = None,
    config_path: Path | None = None,
) -> list[dict[str, Any]]:
    from stylevault.scores import get_score_model

    entries: list[dict[str, Any]] = []
    for name in names:
        try:
            model = get_score_model(name, prompt=prompt, settings=settings, config_path=config_path)
            entries.append(
                {
                    "name": model.name,
                    "version": model.version,
                    "description": model.description,
                }
            )
        except Exception as error:
            entries.append({"name": name, "error": str(error)})
    return entries


def normalize_stats(stats: Any | None) -> dict[str, Any]:
    if stats is None:
        return {}
    if is_dataclass(stats):
        return asdict(stats)
    if isinstance(stats, dict):
        return stats
    return {"value": stats}


def build_run_log_payload(
    *,
    command: str,
    config_path: Path,
    config_fallback: str | None,
    started_at: datetime,
    ended_at: datetime,
    stats: Any | None,
    runtime: dict[str, Any] | None = None,
    models: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    started = _ensure_timezone(started_at)
    ended = _ensure_timezone(ended_at)
    payload: dict[str, Any] = {
        "command": command,
        "run": {
            "started_at": started.isoformat(),
            "ended_at": ended.isoformat(),
            "elapsed_seconds": max(0.0, (ended - started).total_seconds()),
        },
        "config": read_config_snapshot(config_path, fallback_text=config_fallback),
        "stats": normalize_stats(stats),
    }
    if runtime is not None:
        payload["runtime"] = runtime
    if models is not None:
        payload["models"] = models
    if extra:
        payload.update(extra)
    return payload
