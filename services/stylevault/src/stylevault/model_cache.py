from __future__ import annotations

import os
from pathlib import Path

from stylevault.config import DEFAULT_CONFIG, resolve_config_paths

_HF_LOAD_KWARGS: dict[str, object] = {}


def resolve_model_cache_dir(settings: dict, config_path: Path) -> Path:
    paths = resolve_config_paths(settings, config_path)
    models_cfg = settings.get("models", {})
    cache_dir_value = models_cfg.get("cache_dir")
    if cache_dir_value:
        if str(cache_dir_value) == str(DEFAULT_CONFIG["models"]["cache_dir"]):
            return paths["models_dir"]
        cache_dir = Path(str(cache_dir_value))
        if not cache_dir.is_absolute():
            cache_dir = config_path.parent / cache_dir
        return cache_dir
    return paths["models_dir"]


def _resolve_hf_settings(settings: dict, config_path: Path) -> dict[str, object]:
    models_cfg = settings.get("models", {})
    hf_cfg = models_cfg.get("huggingface", {})
    offline = bool(models_cfg.get("offline", False))
    cache_dir = resolve_model_cache_dir(settings, config_path)
    local_files_only = bool(hf_cfg.get("local_files_only", False)) or offline
    token = str(hf_cfg.get("token", "")).strip() or None
    revision = str(hf_cfg.get("revision", "")).strip() or None
    allow_patterns = hf_cfg.get("allow_patterns", [])
    ignore_patterns = hf_cfg.get("ignore_patterns", [])
    return {
        "cache_dir": cache_dir,
        "local_files_only": local_files_only,
        "token": token,
        "revision": revision,
        "force_download": bool(hf_cfg.get("force_download", False)),
        "resume_download": bool(hf_cfg.get("resume_download", True)),
        "allow_patterns": allow_patterns if isinstance(allow_patterns, list) else [],
        "ignore_patterns": ignore_patterns if isinstance(ignore_patterns, list) else [],
        "offline": offline,
    }


def configure_model_cache(settings: dict, config_path: Path) -> Path:
    hf_settings = _resolve_hf_settings(settings, config_path)
    models_dir = hf_settings["cache_dir"]
    if isinstance(models_dir, Path):
        models_dir.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("HF_HOME", str(models_dir))
    os.environ.setdefault("HF_HUB_CACHE", str(models_dir))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(models_dir))
    os.environ.setdefault("TORCH_HOME", str(models_dir))

    if hf_settings["offline"]:
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    token = hf_settings.get("token")
    if token:
        os.environ["HF_TOKEN"] = str(token)
        os.environ["HUGGINGFACE_HUB_TOKEN"] = str(token)
    global _HF_LOAD_KWARGS
    _HF_LOAD_KWARGS = {
        "cache_dir": models_dir,
    }
    if hf_settings["local_files_only"]:
        _HF_LOAD_KWARGS["local_files_only"] = True
    if hf_settings["revision"]:
        _HF_LOAD_KWARGS["revision"] = hf_settings["revision"]
    return models_dir


def get_hf_load_kwargs() -> dict[str, object]:
    return dict(_HF_LOAD_KWARGS)


def download_hf_models(
    model_ids: list[str],
    settings: dict,
    config_path: Path,
) -> list[dict[str, str]]:
    try:
        from huggingface_hub import snapshot_download
        from huggingface_hub.utils import LocalEntryNotFoundError
    except ImportError as exc:
        raise RuntimeError(
            "huggingface_hub is required to download Hugging Face models. "
            "Install transformers or huggingface_hub to enable downloads."
        ) from exc

    hf_settings = _resolve_hf_settings(settings, config_path)
    cache_dir = hf_settings["cache_dir"]
    allow_patterns = hf_settings["allow_patterns"]
    ignore_patterns = hf_settings["ignore_patterns"]
    results: list[dict[str, str]] = []

    for model_id in model_ids:
        status = "downloaded"
        cached_path: str | None = None
        try:
            cached_path = snapshot_download(
                model_id,
                cache_dir=cache_dir,
                revision=hf_settings["revision"],
                allow_patterns=allow_patterns,
                ignore_patterns=ignore_patterns,
                local_files_only=True,
                resume_download=False,
                token=hf_settings["token"],
            )
            status = "cached"
        except LocalEntryNotFoundError:
            cached_path = None
        if status == "cached" and not hf_settings["force_download"]:
            results.append({"model_id": model_id, "status": status, "path": cached_path or ""})
            continue
        if hf_settings["local_files_only"]:
            results.append({"model_id": model_id, "status": "missing", "path": ""})
            continue
        status = "downloaded"
        cached_path = snapshot_download(
            model_id,
            cache_dir=cache_dir,
            revision=hf_settings["revision"],
            allow_patterns=allow_patterns,
            ignore_patterns=ignore_patterns,
            local_files_only=False,
            resume_download=hf_settings["resume_download"],
            force_download=hf_settings["force_download"],
            token=hf_settings["token"],
        )
        results.append({"model_id": model_id, "status": status, "path": cached_path or ""})
    return results
