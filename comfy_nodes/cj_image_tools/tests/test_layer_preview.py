"""CPU unit test for cj_layer_preview.  usage: python -I test_layer_preview.py

Synthetic see-through parts: a far opaque background, a red disc, and a blue square that overlaps the disc
with a split depth map (left half nearer than the disc, right half farther), plus a part hanging off the
canvas edge and one without a depth map. Checks per-pixel depth ordering, transparency, edge clipping, the
depth_median fallback, nearest-first sheet order, preview height and the node's tensors."""
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))  # standalone fallback import of cj_cutouts
import _fake_comfy  # noqa: E402

lp = _fake_comfy.load("cj_layer_preview.py")

H, W = 200, 300


def part(rgb, mask, x0, y0, depth):
    h, w = mask.shape
    img = np.zeros((h, w, 4), np.uint8)
    img[..., :3] = rgb
    img[..., 3] = mask * 255
    d = None if depth is None else np.broadcast_to(np.asarray(depth, np.uint8), (h, w)).copy()
    med = 0.5 if depth is None else float(np.median(d)) / 255.0
    return {"img": img, "depth": d, "xyxy": [x0, y0, x0 + w, y0 + h], "depth_median": med}


bg = np.zeros((H, W), np.uint8)
bg[20:180, 20:280] = 1                                     # background card, leaves a transparent border
disc = np.zeros((100, 100), np.uint8)
cv2.circle(disc, (50, 50), 45, 1, -1)
sq = np.ones((60, 60), np.uint8)
sq_depth = np.full((60, 60), 150, np.uint8)
sq_depth[:, :30] = 50                                      # left half in front of the disc (100), right half behind
edge = np.ones((40, 40), np.uint8)                         # hangs 20px off the left edge
nodepth = np.ones((20, 20), np.uint8)

parts = {
    "frame_size": (H, W),
    "tag2pinfo": {
        "background": part((30, 160, 30), bg, 0, 0, 220),
        "disc": part((220, 30, 30), disc, 60, 50, 100),
        "square": part((30, 30, 220), sq, 110, 70, sq_depth),
        "edge": part((240, 240, 0), edge, -20, 150, 80),
        "flat": part((250, 250, 250), nodepth, 250, 30, None),   # depth_median 0.5 -> 127.5, nearer than bg
    },
}

comp, crops = lp.z_composite(parts)
assert comp.shape == (H, W, 4) and comp.dtype == np.uint8, comp.shape
px = lambda x, y: tuple(int(v) for v in comp[y, x])  # noqa: E731
assert px(125, 100)[:3] == (30, 30, 220), px(125, 100)     # square-left over disc: square wins
assert px(150, 100)[:3] == (220, 30, 30), px(150, 100)     # square-right behind disc: disc wins
assert px(165, 125)[:3] == (30, 30, 220), px(165, 125)     # square-right outside the disc: square over bg
assert px(40, 40)[:3] == (30, 160, 30), px(40, 40)         # background only
assert px(5, 5)[3] == 0, px(5, 5)                          # nothing anywhere -> transparent
assert px(5, 170)[:3] == (240, 240, 0) and px(5, 170)[3] == 255, px(5, 170)   # clipped edge part landed
assert px(19, 185)[:3] == (240, 240, 0) and px(20, 185)[3] == 0, (px(19, 185), px(20, 185))  # crop x 20..39 -> canvas 0..19
assert px(260, 40)[:3] == (250, 250, 250), px(260, 40)     # no depth map: depth_median fallback beats bg
# depth_median: edge .31, disc .39 = square .39 (stable: insertion order), flat .5, background .86
assert [t for t, _ in crops] == ["edge", "disc", "square", "flat", "background"], [t for t, _ in crops]

prev = lp.layer_preview(parts, height=256, cell=64)
assert prev.ndim == 3 and prev.shape[0] == 256 and prev.shape[2] == 3, prev.shape
assert prev.shape[1] > 256, prev.shape                     # composite + gap + sheet side by side

empty = lp.layer_preview({"frame_size": (H, W), "tag2pinfo": {}}, height=128)
assert empty.shape[0] == 128, empty.shape

import torch  # noqa: E402

p_t, c_t = lp.CJLayerPreview().run(parts, height=256)
assert isinstance(p_t, torch.Tensor) and p_t.shape == (1, 256, lp.layer_preview(parts, 256).shape[1], 3), p_t.shape
assert c_t.shape == (1, H, W, 3) and float(c_t.max()) <= 1.0, c_t.shape
print("OK test_layer_preview")
