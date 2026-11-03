"""Seamless outpaint compositing (pure numpy — no cv2/scipy).

The krea2-outpaint LoRA generates an extended canvas; we must paste the ORIGINAL
source back so its pixels are verbatim, but a plain feather leaves a visible TONE
step (the model's extension has slightly different color/lighting than the source).

`multiband_composite` uses Laplacian-pyramid (multiband) blending: low spatial
frequencies (tone/color) blend over a WIDE transition so the tone step vanishes,
while high frequencies (edges/detail) blend over a narrow band so the source stays
crisp. The source interior is preserved; only a thin boundary ring is harmonized.
"""

from __future__ import annotations

import numpy as np
from PIL import Image


def _gauss_blur(a: np.ndarray) -> np.ndarray:
    """Separable 5-tap Gaussian (binomial) blur on an (H,W,C) float array."""
    k = np.array([1, 4, 6, 4, 1], dtype=np.float32) / 16.0
    pad = 2
    out = np.pad(a, ((pad, pad), (0, 0), (0, 0)), mode="edge")
    out = np.tensordot(np.stack([out[i:i + a.shape[0]] for i in range(5)]), k, axes=([0], [0]))
    out = np.pad(out, ((0, 0), (pad, pad), (0, 0)), mode="edge")
    out = np.tensordot(np.stack([out[:, i:i + a.shape[1]] for i in range(5)]), k, axes=([0], [0]))
    return out


def _downsample(a: np.ndarray) -> np.ndarray:
    return _gauss_blur(a)[::2, ::2]


def _upsample(a: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    h, w = shape
    up = np.zeros((a.shape[0] * 2, a.shape[1] * 2, a.shape[2]), dtype=np.float32)
    up[::2, ::2] = a
    up = _gauss_blur(up) * 4.0
    return up[:h, :w]


def _pyramids(img: np.ndarray, levels: int):
    gp = [img]
    for _ in range(levels):
        gp.append(_downsample(gp[-1]))
    lp = []
    for i in range(levels):
        lp.append(gp[i] - _upsample(gp[i + 1], gp[i].shape[:2]))
    lp.append(gp[-1])
    return lp


def multiband_composite(
    generated: Image.Image,
    source: Image.Image,
    bbox: tuple[int, int, int, int],
    *,
    levels: int = 6,
    interior_verbatim: int = 24,
) -> Image.Image:
    """Blend the source into the generated canvas at `bbox` seamlessly.

    interior_verbatim: px inside the seam kept 100% source (mask=1) so only a thin
    boundary ring is harmonized; the source interior stays exactly as provided.
    """
    x0, y0, x1, y1 = bbox
    W, H = generated.size
    gen = np.asarray(generated.convert("RGB"), dtype=np.float32) / 255.0

    # place source on a copy of the generated canvas (outside bbox = generated, so
    # the Laplacians are smooth across the border)
    src_placed = gen.copy()
    src_resized = source.convert("RGB").resize((x1 - x0, y1 - y0), Image.Resampling.LANCZOS)
    src_placed[y0:y1, x0:x1] = np.asarray(src_resized, dtype=np.float32) / 255.0

    # mask: 1 inside bbox (minus a feathered ring), 0 outside. Feather = smooth ramp.
    mask = np.zeros((H, W), dtype=np.float32)
    mask[y0:y1, x0:x1] = 1.0
    # erode the hard 1-region inward, then blur to feather across the seam
    ramp = max(8, (min(x1 - x0, y1 - y0) // 8))
    yy, xx = np.mgrid[0:H, 0:W]
    din = np.minimum.reduce((xx - x0, y0 * 0 + yy - y0, x1 - 1 - xx, y1 - 1 - yy)).astype(np.float32)
    din[(xx < x0) | (xx >= x1) | (yy < y0) | (yy >= y1)] = -1.0
    mask = np.clip((din - interior_verbatim) / ramp + 0.5, 0.0, 1.0)
    mask3 = mask[:, :, None]

    lp_gen = _pyramids(gen, levels)
    lp_src = _pyramids(src_placed, levels)
    gm = [mask3]
    for _ in range(levels):
        gm.append(_downsample(gm[-1]))
    blended = [ls * gmi + lg * (1 - gmi) for ls, lg, gmi in zip(lp_src, lp_gen, gm)]

    out = blended[-1]
    for i in range(levels - 1, -1, -1):
        out = blended[i] + _upsample(out, blended[i].shape[:2])
    out = np.clip(out * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(out)
