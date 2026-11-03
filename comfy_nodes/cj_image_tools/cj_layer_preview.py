"""job thumbnail for Layer Split (see-through).

The see-through PostProcess `preview` drops alpha and blends parts in dict order, so every part shows as
an opaque box on black. This node takes the same SEETHROUGH_PARTS and renders:
  left  - the parts recomposited per pixel by their depth maps (nearest opaque part wins, alpha-blended
          back to front), cropped to the content box, on a checkerboard
  right - a labelled contact sheet of every part, nearest first
Depth convention (checked on real output): larger value = farther.

Parts format (ComfyUI-See-through 98d754b): {"tag2pinfo": {tag: {"img": uint8 RGBA (h,w,4) crop,
"depth": uint8 (h,w) crop or None, "xyxy": [x1,y1,x2,y2], "depth_median": float}}, "frame_size": (H, W)}."""
import logging

import cv2
import numpy as np

try:
    from .cj_cutouts import _checker, contact_sheet
except ImportError:  # loaded standalone (CPU tests)
    from cj_cutouts import _checker, contact_sheet

_log = logging.getLogger("cj_image_tools")


def _place(pinfo, H, W):
    """-> (rgba HxWx4 uint8, depth HxW float32 with inf where transparent) on the full canvas, or None."""
    img = pinfo.get("img")
    if img is None:
        return None
    img = np.asarray(img)
    if img.ndim != 3 or img.shape[2] < 3:
        return None
    if img.shape[2] == 3:
        img = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
    h, w = img.shape[:2]
    x1, y1 = (int(v) for v in (pinfo.get("xyxy") or [0, 0, w, h])[:2])
    # clip the crop to the canvas
    sx0, sy0 = max(0, -x1), max(0, -y1)
    dx0, dy0 = max(0, x1), max(0, y1)
    cw, ch = min(w - sx0, W - dx0), min(h - sy0, H - dy0)
    if cw <= 0 or ch <= 0:
        return None
    rgba = np.zeros((H, W, 4), np.uint8)
    rgba[dy0:dy0 + ch, dx0:dx0 + cw] = img[sy0:sy0 + ch, sx0:sx0 + cw, :4]
    depth = np.full((H, W), np.inf, np.float32)
    d = pinfo.get("depth")
    if d is not None:
        d = np.asarray(d, np.float32)
        if d.ndim == 3:
            d = d[..., 0]
        if d.shape != (h, w):
            d = cv2.resize(d, (w, h), interpolation=cv2.INTER_NEAREST)
        dsub = d[sy0:sy0 + ch, sx0:sx0 + cw]
    else:
        dsub = np.full((ch, cw), float(pinfo.get("depth_median", 1.0)) * 255.0, np.float32)
    region = depth[dy0:dy0 + ch, dx0:dx0 + cw]
    vis = rgba[dy0:dy0 + ch, dx0:dx0 + cw, 3] > 0
    region[vis] = dsub[vis]
    return rgba, depth


def z_composite(parts):
    """-> (RGBA uint8 HxWx4 composite, list of (tag, rgba crop) sorted nearest first)."""
    tag2 = parts.get("tag2pinfo") or {}
    H, W = (int(v) for v in parts.get("frame_size") or (0, 0))
    placed, crops = [], []
    for tag, pinfo in tag2.items():
        p = _place(pinfo, H, W) if H and W else None
        if p is None:
            continue
        placed.append(p)
        crops.append((float(pinfo.get("depth_median", 1.0)), str(tag), np.asarray(pinfo["img"])))
    crops.sort(key=lambda c: c[0])
    out = np.zeros((max(H, 1), max(W, 1), 4), np.float32)
    if not placed:
        return out.astype(np.uint8), []
    D = np.stack([d for _, d in placed])                      # (L,H,W)
    order = np.argsort(-D, axis=0, kind="stable")              # farthest first; transparent (inf) first of all
    C = np.stack([r for r, _ in placed])                       # (L,H,W,4) uint8
    for k in range(len(placed)):
        idx = order[k][None, :, :, None]
        src = np.take_along_axis(C, np.broadcast_to(idx, (1, H, W, 4)), axis=0)[0].astype(np.float32) / 255.0
        a = src[..., 3:4]
        out[..., :3] = src[..., :3] * a + out[..., :3] * (1 - a)
        out[..., 3:4] = a + out[..., 3:4] * (1 - a)
    rgba = np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return rgba, [(tag, img) for _, tag, img in crops]


def _flatten(rgba):
    h, w = rgba.shape[:2]
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    return (rgba[..., :3] * a + _checker(h, w).astype(np.float32) * (1 - a)).astype(np.uint8)


def layer_preview(parts, height=1024, cell=192):
    """-> uint8 RGB: composite (cropped to content) | contact sheet of parts, both `height` tall."""
    comp, crops = z_composite(parts)
    ys, xs = np.nonzero(comp[..., 3] > 8)
    if len(xs):
        pad = 16
        y0, y1 = max(0, ys.min() - pad), min(comp.shape[0], ys.max() + 1 + pad)
        x0, x1 = max(0, xs.min() - pad), min(comp.shape[1], xs.max() + 1 + pad)
        comp = comp[y0:y1, x0:x1]
    left = _flatten(comp)
    s = height / left.shape[0]
    left = cv2.resize(left, (max(1, int(left.shape[1] * s)), height),
                      interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    n = len(crops)
    if not n:
        return left
    # pick columns so the sheet is about as tall as the composite
    best = None
    for cols in range(1, n + 1):
        rows = (n + cols - 1) // cols
        h = rows * (cell + 36) + 8
        if best is None or abs(h - height) < abs(best[1] - height):
            best = (cols, h)
        if h <= height:
            break
    sheet = contact_sheet([c for _, c in crops], [t for t, _ in crops], cell=cell, cols=best[0])
    s = height / sheet.shape[0]
    sheet = cv2.resize(sheet, (max(1, int(sheet.shape[1] * s)), height),
                       interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    gap = np.full((height, 12, 3), 24, np.uint8)
    return np.concatenate([left, gap, sheet], axis=1)


class CJLayerPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "parts": ("SEETHROUGH_PARTS", {"tooltip": "parts from SeeThrough_PostProcess"}),
                "height": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 64}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("preview", "composite")
    FUNCTION = "run"
    CATEGORY = "image/layers"

    def run(self, parts, height=1024):
        import torch

        prev = layer_preview(parts, height)
        comp, _ = z_composite(parts)
        _log.info("CJLayerPreview: %d parts", len((parts or {}).get("tag2pinfo") or {}))
        to_t = lambda a: torch.from_numpy(a.astype(np.float32) / 255.0)[None]  # noqa: E731
        return (to_t(prev), to_t(_flatten(comp)))


NODE_CLASS_MAPPINGS = {"CJLayerPreview": CJLayerPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"CJLayerPreview": "Layer Split Preview"}
