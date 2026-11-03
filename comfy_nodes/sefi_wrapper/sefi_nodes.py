"""Minimal ComfyUI nodes for SeFi-Image inference."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_MODEL_DIR = os.environ.get("SEFI_MODEL_DIR", "~/models/sefi/SeFi-Image-1B-turbo")
DEFAULT_SEFI_PATH = os.environ.get("SEFI_REPO_PATH", "~/SeFi-Image")
_PIPE_CACHE: dict[tuple[str, str, str], "SeFiPipe"] = {}


@dataclass(frozen=True)
class SeFiPipe:
    pipeline: Any
    model_dir: str
    device: str
    dtype: str


def _default_device() -> str:
    """mps on macOS (unchanged default); cuda elsewhere when available, else cpu."""
    if sys.platform == "darwin":
        return "mps"
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001 - node listing must never fail on probe errors
        pass
    return "cpu"


def _sefi_repo_path() -> str:
    return str(Path(os.environ.get("SEFI_PATH", DEFAULT_SEFI_PATH)).expanduser())


def _load_pipeline(model_dir: str, device: str, dtype: str) -> SeFiPipe:
    model_path = str(Path(model_dir).expanduser())
    sefi_path = _sefi_repo_path()
    cache_key = (model_path, str(device), str(dtype))
    cached = _PIPE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    if not Path(sefi_path).is_dir():
        raise FileNotFoundError(
            f"SeFi-Image repo not found: {sefi_path}. Set SEFI_PATH to the local repo."
        )
    if sefi_path not in sys.path:
        sys.path.insert(0, sefi_path)

    from sefi import SEFIInferencePipeline

    pipe = SEFIInferencePipeline.from_pretrained(
        model_path,
        device=str(device),
        dtype=str(dtype),
    )
    wrapped = SeFiPipe(pipe, model_path, str(device), str(dtype))
    _PIPE_CACHE[cache_key] = wrapped
    return wrapped


def _make_generator(device: str, seed: int):
    import torch

    seed = int(seed)
    # SeFi's runner randn()s directly on the pipeline device and requires a
    # matching generator (mps generators work on torch>=2.12).
    return torch.Generator(device=str(device)).manual_seed(seed)


def _image_to_bhwc(image):
    import numpy as np
    import torch
    from PIL import Image

    if isinstance(image, Image.Image):
        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)

    if isinstance(image, np.ndarray):
        tensor = torch.from_numpy(image)
    elif torch.is_tensor(image):
        tensor = image.detach().cpu()
    else:
        raise TypeError(f"Unsupported SeFi image output type: {type(image)!r}")

    if tensor.ndim == 2:  # (H, W) grayscale
        tensor = tensor.unsqueeze(-1)
    if tensor.ndim == 3:
        if tensor.shape[0] in (1, 3, 4) and tensor.shape[-1] not in (1, 3, 4):
            tensor = tensor.permute(1, 2, 0)
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim == 4:
        if tensor.shape[1] in (1, 3, 4) and tensor.shape[-1] not in (1, 3, 4):
            tensor = tensor.permute(0, 2, 3, 1)
    else:
        raise ValueError(f"Unsupported SeFi image tensor shape: {tuple(tensor.shape)}")

    is_integer = not (tensor.dtype.is_floating_point or tensor.dtype.is_complex or tensor.dtype == torch.bool)
    tensor = tensor[..., :3].to(dtype=torch.float32)
    if tensor.shape[-1] in (1, 2):
        # Grayscale (+alpha): ComfyUI IMAGE is RGB, so replicate luminance;
        # a 1-channel tensor would break torch.cat/preview nodes downstream.
        tensor = tensor[..., :1].expand(*tensor.shape[:-1], 3).contiguous()
    # Integer images are always 0..255 — a near-black uint8 frame (max <= 1)
    # must still be scaled. Floats keep the range heuristic.
    if is_integer or (tensor.numel() and float(tensor.max()) > 1.0):
        tensor = tensor / 255.0
    return tensor.clamp(0.0, 1.0)


def _images_to_bhwc(images):
    import torch

    if hasattr(images, "images"):
        images = images.images
    if not isinstance(images, (list, tuple)):
        images = [images]
    tensors = [_image_to_bhwc(image) for image in images]
    return torch.cat(tensors, dim=0) if tensors else torch.empty((0, 0, 0, 3))


class SeFiPipelineLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_dir": ("STRING", {"default": DEFAULT_MODEL_DIR}),
                "device": (["cuda", "mps", "cpu"], {"default": _default_device()}),
                "dtype": (["bf16", "fp32"], {"default": "bf16"}),  # sefi runner rejects fp16
            }
        }

    RETURN_TYPES = ("SEFI_PIPE",)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "load"
    CATEGORY = "Adrift/sefi"

    def load(self, model_dir: str, device: str, dtype: str):
        return (_load_pipeline(model_dir, device, dtype),)


class SeFiGenerate:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipe": ("SEFI_PIPE",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "steps": ("INT", {"default": 4, "min": 1, "max": 100, "step": 1}),
                "guidance": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1},
                ),
                "width": ("INT", {"default": 1024, "min": 16, "max": 4096, "step": 16}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 4096, "step": 16}),
                "seed": (
                    "INT",
                    {
                        "default": 20260616,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "generate"
    CATEGORY = "Adrift/sefi"

    def generate(
        self,
        pipe: SeFiPipe,
        prompt: str,
        steps: int,
        guidance: float,
        width: int,
        height: int,
        seed: int,
    ):
        pipeline = pipe.pipeline if isinstance(pipe, SeFiPipe) else pipe
        device = pipe.device if isinstance(pipe, SeFiPipe) else "cpu"
        generator = _make_generator(device, seed)
        # SeFi turbo checkpoints only accept 4/8/10 inference steps — snap
        # rather than let the runner raise mid-queue (e.g. --steps 6 -> 8).
        allowed = (4, 8, 10)
        snapped = min(allowed, key=lambda a: abs(a - int(steps)))
        # dims must be multiples of 16 for the SeFi patchifier
        w16 = max(256, round(int(width) / 16) * 16)
        h16 = max(256, round(int(height) / 16) * 16)
        images = pipeline(
            prompt,
            num_inference_steps=snapped,
            guidance_scale=float(guidance),
            height=h16,
            width=w16,
            generator=generator,
        )
        return (_images_to_bhwc(images),)


NODE_CLASS_MAPPINGS = {
    "SeFiPipelineLoader": SeFiPipelineLoader,
    "SeFiGenerate": SeFiGenerate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SeFiPipelineLoader": "SeFi Pipeline Loader",
    "SeFiGenerate": "SeFi Generate",
}
