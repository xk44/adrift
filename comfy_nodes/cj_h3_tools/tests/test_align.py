"""CPU unit test for cj_image_pasteback drift alignment (Qwen-Image 2.1 style re-framing).
usage: python test_align.py path/to/cj_image_pasteback.py

A textured photo; the 'edit' recolours a box AND re-frames the shot (2 % zoom, 0.5 deg, 9 px shift).
Unaligned, the drift is a diff everywhere and the seam doubles edges; aligned, the pixels next to the
region match the original and an already-aligned edit is left on the exact warp."""
import importlib.util
import sys

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location("ipb", sys.argv[1])
ipb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ipb)

rng = np.random.default_rng(1)
H, W = 768, 1024
base = rng.integers(0, 255, (H // 8, W // 8, 3), dtype=np.uint8)
src = cv2.resize(base, (W, H), interpolation=cv2.INTER_CUBIC)
src = cv2.GaussianBlur(src, (0, 0), 1.2)
for _ in range(60):                                    # corners for ORB
    x, y = int(rng.integers(0, W - 40)), int(rng.integers(0, H - 40))
    cv2.rectangle(src, (x, y), (x + 30, y + 20), tuple(int(v) for v in rng.integers(0, 255, 3)), -1)
region = np.zeros((H, W), bool)
region[300:460, 420:620] = True

edit = src.copy()
edit[region] = (220, 30, 30)
D = cv2.getRotationMatrix2D((W / 2, H / 2), 0.5, 1.02)
D[:, 2] += (9, -5)
drifted = cv2.warpAffine(edit, D, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

ring = ipb._dilate(region, 9) & ~ipb._dilate(region, 3)   # the grow band: pixels taken from the edit
errs = {}
for al in (False, True):
    out, _ = ipb.paste_back(src, drifted, region=region, fit="stretch", reach_frac=0.0, align=al)
    errs[al] = float(np.abs(out.astype(np.float32) - src.astype(np.float32))[ring].mean())
    inside = out[region].astype(np.float32).mean(0)
print(f"ring error unaligned {errs[False]:.2f}  aligned {errs[True]:.2f}  inside {inside.round(0)}")
assert errs[True] < 3.0 and errs[False] > 3 * errs[True], errs
assert inside[0] > 180 and inside[1] < 80, inside             # the edit still lands in the region

A = ipb.align_affine(src, src.copy(), np.ones((H, W), bool))
assert A is None, A                                          # aligned edit: keep the exact warp
print("ALL OK")
