from __future__ import annotations

import copy
import os
from pathlib import Path
import tomllib

# trainer_templates sits next to src/ in the service folder (editable install).
TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "trainer_templates"

DEFAULT_CONFIG = {
    "paths": {
        "data_dir": ".",
        "db_path": "vault.sqlite",
        "thumbs_dir": "thumbs",
        "exports_dir": "exports",
        "logs_dir": "logs",
        "indices_dir": "indices",
        "models_dir": "models",
    },
    "captions": {
        "prompts": {
            "long": "Describe the image in detail with visual style, context, and notable elements.",
            "short": "Write a short caption describing the main subject and style.",
            "tags": "Return a comma-separated list of concise tags describing the image.",
        }
    },
    "vector_store": {
        "backend": "sqlite",
        "faiss": {
            "index_type": "hnsw",
            "ef_search": 64,
            "ef_construction": 200,
            "m": 32,
        },
        "qdrant": {},
    },
    "scan": {
        "exclude_globs": [],
        "workers": 4,
    },
    "flags": {
        "small_image_min_width": 512,
        "small_image_min_height": 512,
    },
    "text_detection": {
        "methods": ["ocr", "vision"],
        "ocr_backend": "tesseract",
        "ocr_min_chars": 6,
        "caption_min_chars": 30,
        "signature_max_chars": 16,
        "sample_rate": 1.0,
        "sample_seed": 0,
        "vision_model": "ViT-L-14",
        "vision_pretrained": "openai",
        "vision_text_threshold": 0.24,
        "vision_caption_threshold": 0.26,
        "vision_signature_threshold": 0.23,
        "vision_prompt_text": "text overlay, caption, subtitle, handwriting, watermark, signature",
        "vision_prompt_caption": "image contains a caption or subtitle",
        "vision_prompt_signature": "artist signature or signed artwork",
    },
    "embeddings": {
        "primary_model": "siglip2",
        "heads": [],
    },
    "omnitag": {
        "mode": "batch-folder",
        "model_id": "Qwen/Qwen3-VL-4B-Instruct",
        "caption_video_targets": "both",
        "trigger_word": "ohwx",
        "llm_instruction": "Describe the scene with clinical, objective detail.",
        "target_resolution": 768,
        "video_segment_seconds": 5.0,
        "segment_skip": 10,
        "video_max_segments": 3,
        "target_fps": 24,
        "include_audio_in_video": True,
        "blur_threshold": 90.0,
    },
    "models": {
        "cache_dir": "models",
        "offline": False,
        "huggingface": {
            "token": "",
            "revision": "",
            "local_files_only": False,
            "force_download": False,
            "resume_download": True,
            "allow_patterns": [],
            "ignore_patterns": [],
        },
    },
    "api": {
        "cors_enabled": False,
        "cors_origins": [
            "http://localhost",
            "http://localhost:8000",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:3001",
        ],
        "api_key": "",
    },
    "comfyui": {
        "path": "",
        "lora_output_subdir": "stylevault",
        "auto_symlink": True,
        "output_scan_dirs": [],
    },
    "trainers": {
        "default_trainer": "ai-toolkit",
        "default_model_family": "sdxl",
        "default_precision": "fp16",
        "default_device": "cuda",
        "default_output_dir": "trainers",
        "routing": {
            "z-image-turbo": {"trainer": "ai-toolkit", "entrypoint": "run.py"},
            "z-image-base": {"trainer": "ai-toolkit", "entrypoint": "run.py"},
            "krea2": {"trainer": "ai-toolkit", "entrypoint": "run.py"},
            # Untested: needs a moss_image arch in ai-toolkit.
            "moss_image": {"trainer": "ai-toolkit", "entrypoint": "run.py"},
        },
        "adapters": {
            "ai-toolkit": {
                "path_to_repo": "",
                "python_bin": "",
                "extra_env": {},
                "accelerate_config_path": str(TEMPLATES_DIR / "accelerate-single-gpu-bf16.yaml"),
                "template_config_dir": str(TEMPLATES_DIR / "ai-toolkit"),
            },
            "musubi-tuner": {
                "path_to_repo": "",
                "python_bin": "",
                "extra_env": {},
                "accelerate_config_path": str(TEMPLATES_DIR / "accelerate-single-gpu-bf16.yaml"),
                "template_config_dir": str(TEMPLATES_DIR / "musubi-tuner"),
            },
            "sd-scripts": {
                "path_to_repo": "",
                "python_bin": "",
                "extra_env": {},
                "accelerate_config_path": "",
                "template_config_dir": "",
            },
        },
    },
    "fusion": {"weights": {"siglip2": 0.8, "color-histogram": 0.2}},
}

DEFAULT_CONFIG_TOML = """[paths]
data_dir = "."
db_path = "vault.sqlite"
thumbs_dir = "thumbs"
exports_dir = "exports"
logs_dir = "logs"
indices_dir = "indices"
models_dir = "models"

[captions.prompts]
long = "Describe the image in detail with visual style, context, and notable elements."
short = "Write a short caption describing the main subject and style."
tags = "Return a comma-separated list of concise tags describing the image."

[vector_store]
backend = "sqlite"

[vector_store.faiss]
index_type = "hnsw"
ef_search = 64
ef_construction = 200
m = 32

[scan]
exclude_globs = []
workers = 4

[flags]
small_image_min_width = 512
small_image_min_height = 512

[text_detection]
methods = ["ocr", "vision"]
ocr_backend = "tesseract"
ocr_min_chars = 6
caption_min_chars = 30
signature_max_chars = 16
sample_rate = 1.0
sample_seed = 0
vision_model = "ViT-L-14"
vision_pretrained = "openai"
vision_text_threshold = 0.24
vision_caption_threshold = 0.26
vision_signature_threshold = 0.23
vision_prompt_text = "text overlay, caption, subtitle, handwriting, watermark, signature"
vision_prompt_caption = "image contains a caption or subtitle"
vision_prompt_signature = "artist signature or signed artwork"

[embeddings]
primary_model = "siglip2"
heads = []

[models]
cache_dir = "models"
offline = false

[omnitag]
mode = "batch-folder"
model_id = "Qwen/Qwen3-VL-4B-Instruct"
caption_video_targets = "both"
trigger_word = "ohwx"
llm_instruction = "Describe the scene with clinical, objective detail."
target_resolution = 768
video_segment_seconds = 5.0
segment_skip = 10
video_max_segments = 3
target_fps = 24
include_audio_in_video = true
blur_threshold = 90.0

[models.huggingface]
token = ""
revision = ""
local_files_only = false
force_download = false
resume_download = true
allow_patterns = []
ignore_patterns = []

[api]
cors_enabled = false
cors_origins = [
    "http://localhost",
    "http://localhost:8000",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
]
api_key = ""

[comfyui]
path = ""
lora_output_subdir = "stylevault"
auto_symlink = true
output_scan_dirs = []

[trainers]
default_trainer = "ai-toolkit"
default_model_family = "sdxl"
default_precision = "fp16"
default_device = "cuda"
default_output_dir = "trainers"

[trainers.routing]
sdxl = { trainer = "sd-scripts", entrypoint = "sdxl_train_network.py" }
z-image-turbo = { trainer = "ai-toolkit", entrypoint = "run.py" }
z-image-base = { trainer = "ai-toolkit", entrypoint = "run.py" }
krea2 = { trainer = "ai-toolkit", entrypoint = "run.py" }
moss_image = { trainer = "ai-toolkit", entrypoint = "run.py" }

[trainers.adapters."ai-toolkit"]
path_to_repo = ""
python_bin = ""
extra_env = {}
accelerate_config_path = ""
template_config_dir = ""

[trainers.adapters."musubi-tuner"]
path_to_repo = ""
python_bin = ""
extra_env = {}
accelerate_config_path = ""
template_config_dir = ""

[trainers.adapters."sd-scripts"]
path_to_repo = ""
python_bin = ""
extra_env = {}
accelerate_config_path = ""
template_config_dir = ""

[fusion]
weights = { siglip2 = 0.8, "color-histogram" = 0.2 }
"""


def stylevault_home() -> Path:
    raw = os.environ.get("STYLEVAULT_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".adrift" / "stylevault"


def default_config_path() -> Path:
    raw = os.environ.get("STYLEVAULT_CONFIG", "").strip()
    return Path(raw).expanduser() if raw else stylevault_home() / "config.toml"


def _merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        # A blank setting keeps the default. Fusion weights and routes replace the default set.
        if value == "" and merged.get(key):
            continue
        if key in ("weights", "routing"):
            merged[key] = value
        elif isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _apply_env(settings: dict) -> dict:
    embedder = os.environ.get("STYLEVAULT_EMBEDDER", "").strip()
    if embedder:
        settings.setdefault("embeddings", {})["primary_model"] = embedder
        settings["fusion"] = {"weights": {embedder: 1.0}}
    comfyui = os.environ.get("STYLEVAULT_COMFYUI_PATH", "").strip()
    if comfyui:
        settings.setdefault("comfyui", {})["path"] = comfyui
    return settings


def load_config(config_path: Path) -> dict:
    """Defaults, then the config file if there is one, then env overrides."""
    settings = copy.deepcopy(DEFAULT_CONFIG)
    if config_path.exists():
        with config_path.open("rb") as handle:
            settings = _merge(settings, tomllib.load(handle))
    return _apply_env(settings)


def resolve_config_paths(settings: dict, config_path: Path | None = None) -> dict[str, Path]:
    base_dir = config_path.parent if config_path else Path.cwd()
    configured = settings.get("paths", {})
    resolved: dict[str, Path] = {}
    for key, default_value in DEFAULT_CONFIG["paths"].items():
        raw_value = configured.get(key, default_value)
        path = Path(raw_value).expanduser()
        if not path.is_absolute():
            path = base_dir / path
        resolved[key] = path

    comfyui_cfg = settings.get("comfyui", {})
    comfyui_path = comfyui_cfg.get("path", "")
    if comfyui_path:
        p = Path(comfyui_path).expanduser()
        if not p.is_absolute():
            p = base_dir / p
        resolved["comfyui_path"] = p

    return resolved


def validate_config(
    settings: dict,
    config_path: Path | None = None,
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    base_dir = config_path.parent if config_path else Path.cwd()

    paths = settings.get("paths", {})
    for key in (
        "data_dir",
        "db_path",
        "thumbs_dir",
        "exports_dir",
        "logs_dir",
        "indices_dir",
        "models_dir",
    ):
        if key not in paths:
            warnings.append(f"paths.{key} is not set; default values will be used.")
    for key in ("data_dir", "thumbs_dir", "exports_dir", "logs_dir", "indices_dir", "models_dir"):
        path_value = paths.get(key)
        if not path_value:
            continue
        resolved = Path(path_value).expanduser()
        if not resolved.is_absolute():
            resolved = base_dir / resolved
        if resolved.exists() and not resolved.is_dir():
            errors.append(f"paths.{key} must point to a directory: {resolved}")
        elif not resolved.exists():
            warnings.append(f"paths.{key} does not exist yet: {resolved}")

    db_path = paths.get("db_path")
    if db_path:
        resolved_db = Path(db_path).expanduser()
        if not resolved_db.is_absolute():
            resolved_db = base_dir / resolved_db
        if resolved_db.exists() and resolved_db.is_dir():
            errors.append(f"paths.db_path must point to a file, not a directory: {resolved_db}")

    embeddings_cfg = settings.get("embeddings", {})
    heads = embeddings_cfg.get("heads", [])
    if heads and not isinstance(heads, list):
        errors.append("embeddings.heads must be a list.")

    captions_cfg = settings.get("captions", {})
    prompts = captions_cfg.get("prompts", {})
    for caption_type in ("long", "short", "tags"):
        if caption_type not in prompts:
            warnings.append(f"captions.prompts.{caption_type} is missing.")

    vector_backend = settings.get("vector_store", {}).get("backend", "sqlite")
    if str(vector_backend).lower() not in {"sqlite", "qdrant", "faiss"}:
        errors.append("vector_store.backend must be one of: sqlite, qdrant, faiss.")

    return errors, warnings
