"""CPU unit test for CJRegenAlign + paste-back mask scaling.  usage: python test_regen_align.py path/to/cj_pasteback.py

Simulates Open-H3-Regenerate's geometry on a 480x832 draft: Prepare cover-crops to 576p (576x1024 portrait),
the latent upscaler stretches to the computed 1088x1920, Finish trims to 1080x1920. Aligning must land every regen
pixel back on the draft's geometry (scaled by k), with the cropped-away borders filled from the draft."""
import importlib.util
import sys

import cv2
import numpy as np
import torch

spec = importlib.util.spec_from_file_location("xpb", sys.argv[1])
xpb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xpb)

gw, gh, pw, ph = 480, 832, 576, 1024
yy, xx = np.mgrid[0:gh, 0:gw].astype(np.float32)
draft = np.stack([0.3 + 0.4 * np.sin(xx / 23), 0.4 + 0.3 * np.cos(yy / 31), 0.5 + 0.2 * np.sin((xx + yy) / 40)], -1)
cy, cx = 400, 300                                                   # a 'face' blob to locate
draft += 0.3 * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * 6 ** 2))[..., None]
draft = np.clip(draft, 0, 1).astype(np.float32)

# forward: Regenerate's prepare (cover crop) -> latent stretch -> finish trim
scale = max(pw / gw, ph / gh)
sw, sh = max(pw, round(gw * scale)), max(ph, round(gh * scale))
x0, y0 = (sw - pw) // 2, (sh - ph) // 2
prep = cv2.resize(draft, (sw, sh), interpolation=cv2.INTER_LINEAR)[y0:y0 + ph, x0:x0 + pw]
comp = cv2.resize(prep, (1088, 1920), interpolation=cv2.INTER_LINEAR)
regen = comp[:, 4:4 + 1080]
assert regen.shape[:2] == (1920, 1080)

T = 2
out, = xpb.CJRegenAlign().run(torch.from_numpy(np.stack([regen] * T)), torch.from_numpy(np.stack([draft] * T)), pw, ph)
o = out[0].numpy()
oh, ow = o.shape[:2]
k = ow / gw
assert abs(oh / gh - k) < 0.01, (ow, oh)
assert ow % 2 == 0 and oh % 2 == 0
ref = cv2.resize(draft, (ow, oh), interpolation=cv2.INTER_CUBIC)
inner = (slice(20, oh - 20), slice(30, ow - 30))
err = np.abs(o[inner] - ref[inner]).mean()
assert err < 0.01, f"aligned regen drifts from the draft geometry: mean abs {err:.4f}"
# blob centre lands at k * draft centre (sub-pixel)
w8 = o[..., 0] - cv2.GaussianBlur(o[..., 0], (0, 0), 25)
win = w8[int(cy * k) - 40:int(cy * k) + 40, int(cx * k) - 40:int(cx * k) + 40]
my, mx = np.unravel_index(np.argmax(win), win.shape)
assert abs(my - 40) <= 2 and abs(mx - 40) <= 2, (my, mx)
# borders cropped by the cover crop are filled (from the draft), never black
edge = np.abs(o[:, :8] - ref[:, :8]).mean()
assert edge < 0.03, f"uncovered border not filled from draft: {edge:.4f}"
print(f"align ok: {ow}x{oh} k={k:.4f} inner_err={err:.5f} edge_err={edge:.5f}")

# paste-back mask scaling: draft-res masks follow hi-res frames, aspect mismatch refused
raw = np.zeros((T, gh, gw), bool); raw[:, 300:500, 200:400] = True
exp = np.zeros((T, gh, gw), bool); exp[:, 280:520, 180:420] = True
r2, e2, ks = xpb.scale_masks(raw, exp, ow, oh)
assert r2.shape == (T, oh, ow) and abs(ks - k) < 1e-6
assert abs(r2[0].mean() - raw[0].mean()) < 0.003
try:
    xpb.scale_masks(raw, exp, 1080, 1920)
    raise SystemExit("aspect mismatch must raise")
except ValueError:
    pass
print("mask scaling ok")

# output_res: 'frames' upscales a small source to the hi-res frames' detail; 'source' / lower-res frames never move
assert xpb.output_wh(480, 832, ow, oh, "frames") == (ow, oh, True), xpb.output_wh(480, 832, ow, oh, "frames")
assert xpb.output_wh(480, 832, ow, oh, "source") == (480, 832, False)
assert xpb.output_wh(1080, 1920, 480, 832, "frames") == (1080, 1920, False)
print("output_res ok")

# end-to-end through ffmpeg: 96x160 source, frames at 2x, subject square must carry the frames' pixels
import os, subprocess, tempfile
with tempfile.TemporaryDirectory() as td:
    srcp, outp = os.path.join(td, "s.mp4"), os.path.join(td, "o.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x406080:s=96x160:r=24:d=0.5",
                    "-pix_fmt", "yuv420p", srcp], check=True)
    n = 12
    gen = np.zeros((n, 320, 192, 3), np.uint8); gen[:] = (64, 96, 128); gen[:, 100:200, 60:140] = (230, 40, 40)
    rm = np.zeros((n, 160, 96), bool); rm[:, 50:100, 30:70] = True
    em = np.zeros((n, 160, 96), bool); em[:, 40:110, 20:80] = True
    rm2, em2, kk = xpb.scale_masks(rm, em, 192, 320)
    xpb.composite_to_mp4(srcp, list(gen), rm2, em2, outp, t_radius=0, output_res="frames", diff_thresh=6,
                         grow_px=4, feather_px=2, protect_text=False)
    assert xpb.probe_wh(outp) == (192, 320), xpb.probe_wh(outp)
    fr = next(xpb.source_frames_24(outp, 192, 320))
    assert fr[150, 100, 0] > 180 and fr[20, 20, 0] < 120, (fr[150, 100], fr[20, 20])
print("e2e output_res=frames ok")

# source-geometry frames (regen of an already pasted-back draft): masks live in gen geometry (cover crop of a
# 480x832 source to 544x896); a blob at source px (300,400) must land at (300,400)*k on 1108x1920 frames.
sw_, sh_, gw_, gh_ = 480, 832, 544, 896
k_ = 1108 / 480
pbg = xpb.PasteBack(sw_, sh_, gw_, gh_)
gx, gy = 300 * pbg.scale - pbg.x0, 400 * pbg.scale - pbg.y0          # source px -> gen px
rmg = np.zeros((2, gh_, gw_), bool); rmg[:, int(gy) - 10:int(gy) + 10, int(gx) - 10:int(gx) + 10] = True
r3, e3, k3 = xpb.masks_to_source_geometry(rmg, rmg.copy(), sw_, sh_, 1108, 1920)
assert r3.shape == (2, 1920, 1108), r3.shape
ys, xs = np.nonzero(r3[0])
assert abs(xs.mean() - 300 * 1108 / 480) < 3 and abs(ys.mean() - 400 * 1920 / 832) < 3, (xs.mean(), ys.mean())
assert abs(k3 - 1108 / 544 * 544 / (480 * pbg.scale)) < 0.05, k3
try:
    xpb.masks_to_source_geometry(rmg, rmg, sw_, sh_, 1000, 1000); raise SystemExit("aspect guard missing")
except ValueError:
    pass
print("source-geometry masks ok")
