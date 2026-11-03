"""CPU unit test for cj_image_pasteback region_match (inpainted video face tone drift).
usage: python test_region_match.py path/to/cj_image_pasteback.py

Synthetic 720x1280 frame with a textured 'face' ellipse (the region). The 'edit' is the frame at 480x832
(stretch, like InfiniteTalk) where the background went through a lossless round trip but the face was
regenerated: +6 levels on R, +4 on G, -5 on B and a 4 % contrast gain, plus a changed 'mouth' (new content
the match must not chase). Checks:
  - region_match=0 (default) leaves the drift in (and equals the old behaviour)
  - region_match=1 brings the face's tone within ~1.5 levels of the source, mouth stays the edit's
  - outside the paste alpha nothing changes."""
import importlib.util
import sys

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location("ipb", sys.argv[1])
ipb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ipb)

rng = np.random.default_rng(1)
H, W = 720, 1280
yy, xx = np.mgrid[0:H, 0:W]
src = np.stack([xx * 0.05 + 60, yy * 0.08 + 70, np.full((H, W), 110.0)], -1)
src += rng.normal(0, 5, src.shape)
face = ((xx - 640) / 150.0) ** 2 + ((yy - 330) / 200.0) ** 2 <= 1.0
skin = np.stack([170 + 0.06 * (yy - 330), 130 + 0.04 * (xx - 640), np.full((H, W), 115.0)], -1)
skin += cv2.GaussianBlur(rng.normal(0, 10, src.shape), (0, 0), 2)
src[face] = skin[face]
src = np.clip(src, 0, 255).astype(np.uint8)

ed = src.astype(np.float32)
drift = np.float32([6, 4, -5])
mean_face = ed[face].mean(0)
ed[face] = (ed[face] - mean_face) * 1.04 + mean_face + drift
mouth = ((xx - 640) / 55.0) ** 2 + ((yy - 430) / 22.0) ** 2 <= 1.0
ed[mouth] = (70, 30, 35)                      # open mouth: new content inside the region
ed = np.clip(ed, 0, 255).astype(np.uint8)
gen = cv2.resize(ed, (832, 480), interpolation=cv2.INTER_AREA)
region = cv2.dilate(face.astype(np.uint8), ipb._disk(6)).astype(bool)

kw = dict(region=region, fit="stretch", diff_thresh=22.0, reach_frac=0.0, grow_px=14, feather_px=10,
          min_blob_frac=0.5, match_color=True)
o0, a0 = ipb.paste_back(src, gen, **kw)
o0b, _ = ipb.paste_back(src, gen, region_match=0.0, **kw)
assert np.array_equal(o0, o0b), "region_match=0 changed the output"
o1, a1 = ipb.paste_back(src, gen, region_match=1.0, **kw)

cheek = face & ~mouth & ~cv2.dilate(mouth.astype(np.uint8), ipb._disk(12)).astype(bool)
cheek &= ipb._erode(face, 10)
err0 = (o0[cheek].astype(float) - src[cheek]).mean(0)
err1 = (o1[cheek].astype(float) - src[cheek]).mean(0)
print("face tone error  off", np.round(err0, 2), " on", np.round(err1, 2))
assert np.abs(err0).max() > 3.5, f"test setup: drift should be visible without the match ({err0})"
assert np.abs(err1).max() < 1.5, f"region_match left a tone drift ({err1})"
s0 = (o0[cheek].astype(float) - o0[cheek].mean(0)).std(0)
s1 = (o1[cheek].astype(float) - o1[cheek].mean(0)).std(0)
ss = (src[cheek].astype(float) - src[cheek].mean(0)).std(0)
assert np.abs(s1 - ss).max() <= np.abs(s0 - ss).max() + 0.25, "contrast moved away from the source"

core = ipb._erode(mouth, 4)
m1 = o1[core].astype(float).mean(0)
assert np.abs(m1 - np.float32([70, 30, 35])).max() < 12, f"mouth content lost ({m1})"
assert np.abs(o1.astype(int) - src)[a1 < 1e-3].max() == 0, "changed pixels outside the paste alpha"

# A tiny region (rim under 200 px) is left alone instead of fitting noise.
tiny = np.zeros((H, W), bool)
tiny[100:104, 100:104] = True
assert ipb.region_tone_fit(src, src, ipb.rim_band(tiny, 3)) is None
print("ALL OK")
