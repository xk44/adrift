"""CPU unit test for cj_image_pasteback.  usage: python test_image_pasteback.py path/to/cj_image_pasteback.py

Synthetic photo 600x900 (portrait). The 'edit' is rendered at a different size with a centre crop (FIBO-style):
  - the umbrella (region) is gone, replaced by background
  - an 'arm' appears below the region, outside it but within reach (must be kept)
  - global drift: +6 brightness, slight blur everywhere (must be discarded outside the edit)
  - the face (protect) is altered by the model (must stay original)
  - a far-away change (lamp post) the user didn't ask for (must be discarded)."""
import importlib.util
import sys

import cv2
import numpy as np
import torch

spec = importlib.util.spec_from_file_location("ipb", sys.argv[1])
ipb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ipb)

rng = np.random.default_rng(0)
H, W = 900, 600
yy, xx = np.mgrid[0:H, 0:W]
src = np.stack([(xx * 0.3 + 40), (yy * 0.2 + 60), np.full((H, W), 120.0)], -1)
src += rng.normal(0, 6, src.shape)                                 # texture
src = np.clip(src, 0, 255).astype(np.uint8)
face = (slice(150, 260), slice(250, 350))
src[face] = (200, 160, 140)
umb = (slice(300, 420), slice(330, 480))
src[umb] = (10, 10, 10)
region = np.zeros((H, W), bool); region[umb] = True
protect = np.zeros((H, W), bool); protect[face] = True

# 'edited' in the original frame, then cover-scaled + centre-cropped to 672x896 (w,h) like FIBO
ed_full = src.copy()
bg = np.stack([(xx * 0.3 + 40), (yy * 0.2 + 60), np.full((H, W), 120.0)], -1).astype(np.uint8)
ed_full[umb] = bg[umb]                                             # umbrella removed
arm = (slice(430, 560), slice(360, 400))
ed_full[arm] = (230, 180, 150)                                     # new arm, outside the region
ed_full[face] = (215, 150, 150)                                    # model drifted the face
lamp = (slice(700, 800), slice(40, 90))
ed_full[lamp] = (250, 250, 0)                                      # unrequested far change
ed_full = np.clip(cv2.GaussianBlur(ed_full, (0, 0), 1.2).astype(np.int16) + 6, 0, 255).astype(np.uint8)
gw, gh = 672, 896
M = ipb.warp_matrix(W, H, gw, gh, "crop")                          # gen -> src
Minv = cv2.invertAffineTransform(M)
gen = cv2.warpAffine(ed_full, Minv, (gw, gh), flags=cv2.INTER_AREA)
assert gen.shape == (gh, gw, 3)

out, alpha = ipb.paste_back(src, gen, region=region, protect=protect, fit="crop")
assert out.shape == src.shape and alpha.shape == (H, W)
diff = np.abs(out.astype(int) - src.astype(int)).max(-1)

outside = alpha < 1e-3
print(f"exact-original {outside.mean()*100:.1f}%  edited {(alpha > 0.5).mean()*100:.1f}%")
assert diff[outside].max() == 0, "pixels outside alpha changed"
assert outside.mean() > 0.80, "too much of the frame replaced"
assert (out[umb][10:-10, 10:-10].astype(int) - bg[umb][10:-10, 10:-10]).__abs__().mean() < 18, "umbrella not removed"
assert alpha[arm].mean() > 0.95, "new arm (outside region, within reach) dropped"
assert np.abs(out[arm].astype(int) - (236, 186, 156)).mean() < 20, "arm content wrong"
assert diff[face][10:-10, 10:-10].max() == 0, "protected face changed"
assert alpha[lamp].max() < 1e-3 and diff[lamp].max() == 0, "far unrequested change leaked in"

# a big far re-render CONNECTED to the region by a band (krea2 redrew the lantern rows + crowd):
# only the part within reach may be kept, never the whole connected blob
ed_band = ed_full.copy()
band = (slice(340, 380), slice(0, W))
ed_band[band] = (250, 120, 30)
ed_band[40:340, 0:200] = (240, 200, 60)                            # the big far re-render it connects to
gen_b = cv2.warpAffine(ed_band, Minv, (gw, gh), flags=cv2.INTER_AREA)
_, alpha_b = ipb.paste_back(src, gen_b, region=region, protect=protect, fit="crop")
reach_px = int(0.18 * min(H, W))
far_x = 330 - reach_px - 40                                        # well left of region minus reach
assert alpha_b[40:380, :far_x].max() < 1e-3, "connected far blob leaked past reach"
assert alpha_b[340:380, 260:330].min() > 0.95, "band part within reach dropped"
assert alpha_b[arm].mean() > 0.95, "arm dropped with band present"

# colour match: the +6 drift must be removed inside the pasted area (background where umbrella was)
inner = out[umb][20:-20, 20:-20].astype(float).mean((0, 1)) - bg[umb][20:-20, 20:-20].astype(float).mean((0, 1))
print("bg offset after colour match", inner.round(2))
assert np.abs(inner).max() < 3.0, "colour drift not corrected"

# stretch fit + new_content mask + node wrapper (torch, batch of 2)
gen_s = cv2.resize(ed_full, (512, 768), interpolation=cv2.INTER_AREA)
nc = np.zeros((768, 512), np.float32); nc[int(430 * 768 / H):int(560 * 768 / H), int(360 * 512 / W):int(400 * 512 / W)] = 1
t = lambda a: torch.from_numpy(a.astype(np.float32) / 255.0)[None]
img, a = ipb.CJImagePasteBack().run(t(src), torch.cat([t(gen_s), t(gen_s)]), region=torch.from_numpy(region.astype(np.float32))[None],
                                     new_content=torch.from_numpy(nc)[None], protect=torch.from_numpy(protect.astype(np.float32))[None],
                                     fit="stretch", reach=0.0)
assert img.shape == (2, H, W, 3) and a.shape == (2, H, W)
assert a[0][arm].mean() > 0.95, "new_content mask ignored (reach=0 so only nc can keep the arm)"
o = (img[0].numpy() * 255).round().astype(int)
assert np.abs(o - src)[a[0].numpy() < 1e-3].max() == 0
# no region at all: diff-only mode keeps big blobs, still exact elsewhere
out2, al2 = ipb.paste_back(src, gen, fit="crop", match_color=True)
assert np.abs(out2.astype(int) - src)[al2 < 1e-3].max() == 0

# subject (pose edit): a low-contrast limb change (below diff_thresh) far from the region is dropped by
# diff-only logic but kept when it lies inside the subject mask; protect still wins inside the subject
body = np.zeros((H, W), bool); body[140:880, 200:420] = True        # 'person' on the original
limb = (slice(600, 760), slice(220, 300))
ed_p = src.copy()
ed_p[umb] = bg[umb]
ed_p[limb] = np.clip(src[limb].astype(int) + 14, 0, 255).astype(np.uint8)   # subtle sleeve move, < thresh
ed_p[face] = (215, 150, 150)
gen_p = cv2.warpAffine(ed_p, Minv, (gw, gh), flags=cv2.INTER_AREA)
_, a_no = ipb.paste_back(src, gen_p, region=region, protect=protect, fit="crop", reach_frac=0.0)
assert a_no[limb].mean() < 0.05, "limb kept without subject (test premise broken)"
o_s, a_s = ipb.paste_back(src, gen_p, region=region, protect=protect, fit="crop", reach_frac=0.0, subject=body)
assert a_s[limb][10:-10, 10:-10].min() > 0.99, "subject mask did not bring the moved limb from the edit"
assert np.abs(o_s.astype(int) - src)[face][22:-22, 22:-22].max() == 0, "protect lost inside subject"  # rim feathers into the body on purpose
assert np.abs(o_s.astype(int) - src)[a_s < 1e-3].max() == 0

# relight: the edit brightened the whole scene (umbrella shade gone) incl. the face. The face core keeps the
# original's detail (texture) but takes the edit's brightness; a feature the model redrew stays original.
src_t = src.copy()
src_t[face] = np.clip(src[face].astype(int) + rng.normal(0, 12, src[face].shape), 0, 255).astype(np.uint8)
ed_r = src_t.copy()
ed_r[umb] = bg[umb]
ed_r[face] = np.clip(cv2.GaussianBlur(src_t[face], (0, 0), 2).astype(int) + 40, 0, 255).astype(np.uint8)  # relit + softened
ed_r[195:205, 270:280] = (90, 60, 60)                                           # model redrew a small feature
gen_r = cv2.warpAffine(ed_r, Minv, (gw, gh), flags=cv2.INTER_AREA)
kw = dict(region=region, protect=protect, fit="crop", subject=body, reach_frac=0.0)
o_k, _ = ipb.paste_back(src_t, gen_r, **kw)
o_r, a_r = ipb.paste_back(src_t, gen_r, protect_mode="relight", **kw)
fc = (slice(215, 235), slice(300, 325))                                         # face core, away from the feature
assert np.abs(o_k[fc].astype(int) - src_t[fc]).max() == 0, "keep mode changed the face"
lift = (o_r[fc].astype(float) - src_t[fc]).mean()
assert 25 < lift < 50, f"relight did not take the edit's lighting ({lift:.1f})"
hf = lambda x: x.astype(float) - cv2.GaussianBlur(x.astype(float), (0, 0), 2)
cr = np.corrcoef(hf(o_r[fc]).ravel(), hf(src_t[fc]).ravel())[0, 1]
assert cr > 0.8, f"relight lost the original's detail ({cr:.2f})"
assert np.abs(o_r.astype(int) - src_t)[a_r < 1e-3].max() == 0, "relight leaked outside alpha"
print(f"relight lift {lift:.1f} detail corr {cr:.2f}")
print("ALL OK")
