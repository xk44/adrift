"""Nodes behind Adrift's Extend video tool (Wan2.2 Fun VACE).

CJColorMatchToReference
    Generated continuations drift in colour (VACE re-renders the whole window, the context frames
    are only conditioning). This node computes per-channel CIELAB mean/std over the WHOLE reference
    batch (the context frames) and over the WHOLE input batch (the continuation), and applies one
    affine transfer per channel to every frame. One transform per clip: it cannot flicker.
    `strength` blends the corrected LAB values with the original (0 = untouched, 1 = full match).
    The std ratio is clamped to [0.5, 2] so a flat reference cannot blow the contrast up.

CJRetimeFrames
    Resamples a batch shot at `src_fps` to `dst_fps`, keeping its duration: n frames become
    round(n * dst / src). "nearest" duplicates / drops whole frames (no ghosting; the default),
    "blend" cross-fades the two neighbouring frames (smoother pans, ghosting on fast motion).
    dst_fps is a FLOAT input so it can be linked to GetVideoComponents' fps output.

Pure torch; the math lives in module-level functions so tests/ can run it without ComfyUI.
"""
import math

import torch

# sRGB <-> CIELAB (D65), batched [..., 3] tensors in 0..1

_RGB2XYZ = torch.tensor(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=torch.float32,
)
_XYZ2RGB = torch.linalg.inv(_RGB2XYZ.double()).float()
_WHITE = torch.tensor([0.95047, 1.0, 1.08883], dtype=torch.float32)
_D = 6.0 / 29.0


def srgb_to_lab(rgb: torch.Tensor) -> torch.Tensor:
    rgb = rgb.float().clamp(0.0, 1.0)
    lin = torch.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _RGB2XYZ.to(rgb.device).T / _WHITE.to(rgb.device)
    f = torch.where(xyz > _D**3, xyz.clamp_min(1e-12) ** (1.0 / 3.0), xyz / (3 * _D * _D) + 4.0 / 29.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return torch.stack([L, a, b], dim=-1)


def lab_to_srgb(lab: torch.Tensor) -> torch.Tensor:
    fy = (lab[..., 0] + 16.0) / 116.0
    fx = fy + lab[..., 1] / 500.0
    fz = fy - lab[..., 2] / 200.0
    f = torch.stack([fx, fy, fz], dim=-1)
    xyz = torch.where(f > _D, f**3, 3 * _D * _D * (f - 4.0 / 29.0)) * _WHITE.to(lab.device)
    lin = (xyz @ _XYZ2RGB.to(lab.device).T).clamp(0.0, 1.0)
    rgb = torch.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin.clamp_min(1e-12) ** (1.0 / 2.4) - 0.055)
    return rgb.clamp(0.0, 1.0)


# Colour match

_CHUNK = 8  # frames converted at once (bounds the float32 LAB copies)
_MAX_STAT_PIXELS = 4_000_000  # pixels sampled per batch for the statistics


def lab_stats(images: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Per-channel LAB mean / std over every frame of an IMAGE batch [B,H,W,C]."""
    rgb = images[..., :3]
    b, h, w, _ = rgb.shape
    step = max(1, int(math.ceil(math.sqrt(b * h * w / _MAX_STAT_PIXELS))))
    total = torch.zeros(3, dtype=torch.float64)
    total_sq = torch.zeros(3, dtype=torch.float64)
    count = 0
    for i in range(0, b, _CHUNK):
        lab = srgb_to_lab(rgb[i : i + _CHUNK, ::step, ::step]).reshape(-1, 3).double().cpu()
        total += lab.sum(0)
        total_sq += (lab * lab).sum(0)
        count += lab.shape[0]
    mean = total / max(count, 1)
    var = (total_sq / max(count, 1) - mean * mean).clamp_min(0.0)
    return mean.float(), var.sqrt().float()


def color_match(images: torch.Tensor, reference: torch.Tensor, strength: float = 1.0) -> torch.Tensor:
    """Match `images` to `reference` (both IMAGE batches) with one LAB mean/std transfer."""
    strength = float(min(1.0, max(0.0, strength)))
    if strength == 0.0 or images.shape[0] == 0 or reference.shape[0] == 0:
        return images
    mu_s, sd_s = lab_stats(images)
    mu_r, sd_r = lab_stats(reference)
    scale = (sd_r / sd_s.clamp_min(1e-3)).clamp(0.5, 2.0)
    out = torch.empty_like(images)
    dev = images.device
    mu_s, mu_r, scale = mu_s.to(dev), mu_r.to(dev), scale.to(dev)
    for i in range(0, images.shape[0], _CHUNK):
        chunk = images[i : i + _CHUNK]
        lab = srgb_to_lab(chunk[..., :3])
        matched = (lab - mu_s) * scale + mu_r
        lab = lab + (matched - lab) * strength
        rgb = lab_to_srgb(lab).to(chunk.dtype)
        if chunk.shape[-1] > 3:
            rgb = torch.cat([rgb, chunk[..., 3:]], dim=-1)
        out[i : i + _CHUNK] = rgb
    return out


# Retime


def retime_count(n: int, src_fps: float, dst_fps: float) -> int:
    return max(1, int(round(n * dst_fps / src_fps)))


def retime_indices(n: int, src_fps: float, dst_fps: float) -> list[int]:
    """Nearest source frame for every output frame (output frame j sits at j / dst_fps seconds)."""
    m = retime_count(n, src_fps, dst_fps)
    return [min(n - 1, int(math.floor(j * src_fps / dst_fps + 0.5))) for j in range(m)]


def retime(images: torch.Tensor, src_fps: float, dst_fps: float, method: str = "nearest") -> torch.Tensor:
    n = images.shape[0]
    if n == 0 or src_fps <= 0 or dst_fps <= 0 or abs(src_fps - dst_fps) < 1e-6:
        return images
    if method != "blend":
        idx = torch.tensor(retime_indices(n, src_fps, dst_fps), device=images.device)
        return images.index_select(0, idx)
    m = retime_count(n, src_fps, dst_fps)
    out = torch.empty((m,) + tuple(images.shape[1:]), dtype=images.dtype, device=images.device)
    for j in range(m):
        t = min(n - 1.0, j * src_fps / dst_fps)
        i0 = int(math.floor(t))
        i1 = min(i0 + 1, n - 1)
        w = t - i0
        out[j] = images[i0] if w < 1e-4 else images[i0] * (1.0 - w) + images[i1] * w
    return out


# Nodes


class CJColorMatchToReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "Frames to correct (the generated continuation)."}),
                "reference": ("IMAGE", {"tooltip": "Frames whose colours are the target (the context frames)."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "method": (["mean_std_lab"], {"default": "mean_std_lab"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "Adrift/Video"
    DESCRIPTION = "One clip-wide CIELAB mean/std transfer from the reference batch onto every frame (no flicker)."

    def apply(self, images, reference, strength, method="mean_std_lab"):
        return (color_match(images, reference, strength),)


class CJRetimeFrames:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "src_fps": ("FLOAT", {"default": 16.0, "min": 0.01, "max": 240.0, "step": 0.001}),
                "dst_fps": ("FLOAT", {"default": 30.0, "min": 0.01, "max": 240.0, "step": 0.001}),
                "method": (["nearest", "blend"], {"default": "nearest"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply"
    CATEGORY = "Adrift/Video"
    DESCRIPTION = "Resample a frame batch from src_fps to dst_fps at the same duration (duplicate/drop or blend)."

    def apply(self, images, src_fps, dst_fps, method="nearest"):
        return (retime(images, float(src_fps), float(dst_fps), method),)


NODE_CLASS_MAPPINGS = {
    "CJColorMatchToReference": CJColorMatchToReference,
    "CJRetimeFrames": CJRetimeFrames,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CJColorMatchToReference": "Color Match to Reference (LAB)",
    "CJRetimeFrames": "Retime Frames (fps)",
}
