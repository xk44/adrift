"""CPU unit test for cj_video_matte.  usage: python test_video_matte.py path/to/cj_video_matte.py

Synthetic 12-frame 64x96 clip: a red square subject moving right over a green background; the matte
drops the subject on frame 5 (tracker miss). Checks temporal dilation/median/mean, cover fit, the
composite (subject kept, background replaced, alpha returned), clip backgrounds cycling and the
blur fallback."""
import importlib.util
import sys

import torch

spec = importlib.util.spec_from_file_location("vm", sys.argv[1])
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)

T, H, W = 12, 64, 96
frames = torch.zeros(T, H, W, 3)
frames[..., 1] = 0.8                               # green background
matte = torch.zeros(T, H, W)
for t in range(T):
    x0 = 10 + 4 * t
    frames[t, 20:44, x0:x0 + 20] = torch.tensor([0.9, 0.1, 0.1])
    if t != 5:
        matte[t, 20:44, x0:x0 + 20] = 1.0

# --- temporal
tm = vm.CJMaskTemporal().run(matte, "max", 1)[0]
assert tm.shape == matte.shape
assert tm[5].sum() > 0, "max must fill the dropped frame"
assert (tm >= matte).all(), "max never removes mask"
med = vm.CJMaskTemporal().run(matte, "median", 1)[0]
assert med[4].sum() > 0 and med[6].sum() > 0, "median keeps frames neighbouring the dropout"
mean = vm.CJMaskTemporal().run(matte, "mean", 2)[0]
assert 0 < mean[5].max() < 1, "mean is soft"
st = vm.CJMaskTemporal().run(matte, "stable", 1)[0]
assert torch.equal(st[3], matte[3]), "stable leaves a moving subject untouched (no ghost copies)"
fl = torch.zeros(T, H, W); fl[:, 10:20, 10:20] = 0.8; fl[1::2, 10:20, 10:20] = 0.9   # soft edge flicker
fs = vm.CJMaskTemporal().run(fl, "stable", 1)[0]
assert float((fs[2:-2, 15, 15] - 0.85).abs().max()) < 0.04, "stable smooths small flicker"
assert torch.equal(vm.CJMaskTemporal().run(matte, "max", 0)[0], matte)
assert vm.CJMaskTemporal().run(matte[:, None], "max", 1)[0].shape == matte.shape, "4D mask accepted"

# --- fit
bg = torch.zeros(1, 40, 40, 3)
bg[..., 2] = 1.0                                    # square blue -> cover to 64x96
fit = vm.fit_background(bg, H, W, "cover")
assert fit.shape == (1, H, W, 3) and fit[..., 2].min() > 0.99
assert vm.fit_background(bg, H, W, "contain").shape == (1, H, W, 3)
assert vm.fit_background(bg, H, W, "stretch").shape == (1, H, W, 3)

# --- composite over an image
node = vm.CJVideoBgComposite()
img, alpha = node.run(frames, tm, "cover", 1, 1.0, 0.0, 12.0, 0.0, 24.0, background=bg)
assert img.shape == frames.shape and alpha.shape == (T, H, W)
t = 3
x0 = 10 + 4 * t
assert torch.allclose(img[t, 32, x0 + 10], frames[t, 32, x0 + 10], atol=1e-3), "subject core kept exactly"
assert img[t, 5, 5, 2] > 0.99 and img[t, 5, 5, 1] < 0.01, "background replaced"
assert alpha[t, 32, x0 + 10] > 0.99 and alpha[t, 5, 5] < 0.01

# light wrap + colour match only touch the subject (outside alpha the bg is untouched)
img2, _ = node.run(frames, tm, "cover", 1, 1.0, 0.5, 8.0, 0.6, 24.0, background=bg)
assert torch.allclose(img2[t, 5, 5], img[t, 5, 5], atol=1e-4)
assert not torch.allclose(img2[t, 32, x0 + 10], img[t, 32, x0 + 10]), "colour match moved the subject"
assert torch.isfinite(img2).all() and img2.min() >= 0 and img2.max() <= 1

# --- clip background cycles
bgclip = torch.zeros(3, 32, 48, 3)
for i in range(3):
    bgclip[i, ..., 0] = i / 2
img3, _ = node.run(frames, tm, "cover", 0, 0.0, 0.0, 12.0, 0.0, 24.0, background=bgclip)
for tt in range(T):
    assert abs(img3[tt, 2, 2, 0].item() - (tt % 3) / 2) < 1e-3, tt

# --- no background: blurred original; subject stays sharp
img4, _ = node.run(frames, tm, "cover", 1, 1.0, 0.0, 12.0, 0.0, 6.0)
assert torch.allclose(img4[t, 32, x0 + 10], frames[t, 32, x0 + 10], atol=1e-3)
assert torch.allclose(img4[t, 2, 90], frames[t, 2, 90], atol=0.05), "flat bg stays ~same under blur"

# --- matte at a different res / shorter than frames
small = tm[:10, ::2, ::2]
img5, a5 = node.run(frames, small, "cover", 0, 0.0, 0.0, 12.0, 0.0, 24.0, background=bg)
assert img5.shape == frames.shape and a5.shape == (T, H, W)

# chunking equals single pass
o1, _ = vm.composite(frames, tm, bg, chunk=4, light_wrap=0.3, color_match=0.4)
o2, _ = vm.composite(frames, tm, bg, chunk=64, light_wrap=0.3, color_match=0.4)
assert torch.allclose(o1, o2, atol=1e-5)
# blur mode: a red subject on a grey background must not smear red into its own blurred background (halo)
fr = torch.full((2, 128, 128, 3), 0.5); fr[:, 40:90, 50:80] = torch.tensor([1.0, 0.0, 0.0])
mt = torch.zeros(2, 128, 128); mt[:, 40:90, 50:80] = 1
ob, ab = vm.composite(fr, mt, None, blur_px=16, light_wrap=0.0, color_match=0.0)
ring = (ab[0] < 0.02) & (torch.nn.functional.max_pool2d(mt[:1, None], 25, 1, 12)[0, 0] > 0)
assert ring.any() and (ob[0][ring] - 0.5).abs().max() < 0.02, f"blur halo {(ob[0][ring] - 0.5).abs().max():.3f}"
# matte gate: BiRefNet keeps a plant (no subject there) and a faint far person; the track fixes both
mg = torch.zeros(3, 64, 64)
mg[:, 5:15, 5:15] = 0.9            # salient prop, not a person
mg[:, 30:60, 40:50] = 0.35         # far person, low confidence
mg[:, 30:60, 50:52] = 0.8          # soft edge pixels just outside the track
sub = torch.zeros(2, 32, 32)       # track at half res, one frame short
sub[:, 15:30, 20:25] = 1           # -> rows 30:60, cols 40:50 at full res
gm = vm.gate_matte(mg, sub, grow_px=4, core_px=2)
assert gm.shape == mg.shape
assert float(gm[:, 5:15, 5:15].max()) == 0.0, "prop outside the track removed"
assert float(gm[2, 40, 45]) == 1.0, "track interior solid (and the short track holds its last frame)"
assert abs(float(gm[0, 40, 51]) - 0.8) < 1e-6, "edge alpha kept inside the grow band"
assert float(gm[0, 40, 58]) == 0.0
assert float(vm.CJMatteGate().run(mg, torch.zeros(1, 64, 64), 8, 2)[0].max()) == 0.0, "empty track -> nothing"
print("test_video_matte OK")
