"""CPU test for cj_followcam (track smoothing, crop, paste-back).  usage: python test_followcam.py path/to/cj_followcam.py"""
import importlib.util
import sys

import torch

spec = importlib.util.spec_from_file_location("fc", sys.argv[1])
fc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fc)

# --- boxes + gap filling
m = torch.zeros(5, 48, 64)
m[0, 10:20, 8:16] = 1
m[4, 20:30, 40:48] = 1
b, valid = fc.mask_boxes(m)
assert valid.tolist() == [True, False, False, False, True]
assert torch.allclose(b[0], torch.tensor([8 / 64, 10 / 48, 16 / 64, 20 / 48]))
filled = fc.fill_missing(b, valid)
assert torch.allclose(filled[2], (b[0] + b[4]) / 2), "midpoint interpolated"
one = torch.tensor([False, False, True, False])
assert torch.allclose(fc.fill_missing(torch.arange(8.).view(4, 2), one), torch.tensor([[4., 5.]] * 4)), "held"

# --- smoothing: zero-phase, constant preserved
x = torch.full((30,), 0.3)
assert torch.allclose(fc.gaussian_1d(x, 4), x)
step = torch.cat([torch.zeros(15), torch.ones(15)])
g = fc.gaussian_1d(step, 3)
assert abs(float(g[14] + g[15]) - 1.0) < 1e-5, "symmetric around the step (no lag)"
assert float(fc.running_max(torch.tensor([0., 0, 1, 0, 0, 0]), 1)[3]) == 1.0

# --- track: small jittery subject on a 16:9 frame, model 832x480
T, H, W = 48, 90, 160
mask = torch.zeros(T, H, W)
gen = torch.Generator().manual_seed(0)
for t in range(T):
    cx = 40 + t + int(torch.randint(-3, 4, (1,), generator=gen))  # walking right with +-3 px jitter
    mask[t, 50:74, cx - 5:cx + 5] = 1
mask[20] = 0                                                       # tracker dropout
win, zoom, active = fc.track_windows(mask, 832, 480, padding=0.15, smooth=4, max_zoom=4, mode="auto")
assert active and zoom > 2.0, zoom
x0, y0, w, h = win.unbind(1)
assert torch.all(x0 >= -1e-6) and torch.all(y0 >= -1e-6) and torch.all(x0 + w <= 1 + 1e-6) and torch.all(y0 + h <= 1 + 1e-6)
ar = (w * W) / (h * H)
assert torch.allclose(ar, torch.full_like(ar, 832 / 480), atol=1e-4), "fixed model aspect"
# every subject pixel inside its window (subject never cut by the crop)
bx, bv = fc.mask_boxes(mask)
for t in range(T):
    if bv[t]:
        assert bx[t, 0] >= x0[t] - 1e-6 and bx[t, 2] <= x0[t] + w[t] + 1e-6, t
        assert bx[t, 1] >= y0[t] - 1e-6 and bx[t, 3] <= y0[t] + h[t] + 1e-6, t
# smoother than the raw centre: second differences shrink
raw_cx = (bx[:, 0] + bx[:, 2]) / 2
acc = lambda v: (v[2:] - 2 * v[1:-1] + v[:-2]).abs().mean()
keep = bv.clone(); keep[19:22] = False
cx_win = x0 + w / 2
assert acc(cx_win[25:]) < 0.25 * acc(raw_cx[25:]), (acc(cx_win), acc(raw_cx))
# max zoom clamp
tiny = torch.zeros(4, H, W); tiny[:, 40:42, 80:82] = 1
win_t, z_t, _ = fc.track_windows(tiny, 832, 480, max_zoom=3)
assert abs(z_t - 3) < 1e-4, z_t
# auto: a big subject keeps the full frame; on forces the crop; empty mask -> full frame
big = torch.zeros(4, H, W); big[:, 5:85, 40:120] = 1
wb, zb, ab = fc.track_windows(big, 832, 480, mode="auto")
assert not ab and zb == 1.0
full_h = min(1.0, (W / H) / (832 / 480))
assert torch.allclose(wb[:, 3], torch.full((4,), full_h))
_, _, a_on = fc.track_windows(big, 832, 480, mode="on", padding=0.0, max_zoom=1.05)
assert a_on
w0, z0, a0 = fc.track_windows(torch.zeros(3, H, W), 832, 480, mode="on")
assert not a0 and z0 == 1.0
_, _, a_off = fc.track_windows(mask, 832, 480, mode="off")
assert not a_off

# --- crop -> paste identity (pixel-aligned window: 1 crop px = 1 plate px)
plate = torch.rand(3, 48, 64, 3, generator=gen)
win_id = torch.tensor([[0.25, 0.25, 0.5, 0.5]] * 3)
crops = fc.crop_frames(plate, win_id, 32, 24)
assert crops.shape == (3, 24, 32, 3)
assert torch.allclose(crops, plate[:, 12:36, 16:48], atol=1e-5), "crop is exact on aligned pixels"
back, alpha = fc.paste_frames(plate, crops, win_id, None)
assert torch.allclose(back, plate, atol=1e-5), "crop -> uncrop is the identity"
assert float(alpha[:, 12:36, 16:48].min()) > 0.9999 and float(alpha[:, :12].max()) == 0.0
# a changed crop only lands inside the window
red = torch.zeros_like(crops); red[..., 0] = 1
out, _ = fc.paste_frames(plate, red, win_id, None)
assert torch.equal(out[:, :12], plate[:, :12]) and torch.equal(out[:, :, :16], plate[:, :, :16]), "outside untouched"
assert torch.allclose(out[:, 13:35, 17:47, 0], torch.ones(3, 22, 30))

# --- non-aligned zoom round trip on a smooth image (subpixel window, 2x upsampled crop)
yy, xx = torch.meshgrid(torch.arange(96.), torch.arange(128.), indexing="ij")
smooth_img = torch.stack([0.5 + 0.4 * torch.sin(xx / 9), 0.5 + 0.4 * torch.cos(yy / 11), 0.5 + 0.3 * torch.sin((xx + yy) / 13)], -1)
smooth_img = smooth_img.unsqueeze(0).repeat(2, 1, 1, 1)
win_z = torch.tensor([[0.2137, 0.3011, 0.4, 0.4]] * 2)
cz = fc.crop_frames(smooth_img, win_z, 104, 78)
bz, az = fc.paste_frames(smooth_img, cz, win_z, None)
inner = (az > 0.999)
err = (bz - smooth_img).abs().amax(-1)[inner]
assert float(err.max()) < 0.01, float(err.max())

# --- feathered subject alpha: limited to the (grown) subject, faded at the border
sub = torch.zeros(1, 24, 32); sub[0, 8:16, 12:20] = 1
a = fc.crop_alpha(sub, 24, 32, grow_px=1, feather_px=1, edge_px=4)
assert float(a[0, 12, 16]) > 0.99 and float(a[0, 0, 0]) == 0.0 and float(a[0, 2, 2]) < 1e-3
assert float(a[0, 12, 25]) < 0.01, "nothing far outside the subject"
edge = fc.crop_alpha(None, 24, 32, edge_px=4)
assert float(edge[0, 0, 16]) < 0.2 and float(edge[0, 12, 16]) == 1.0
outm, am = fc.paste_frames(plate[:1], red[:1], win_id[:1], a)
assert torch.equal(outm[0, 14:16, 16:20], plate[0, 14:16, 16:20]), "crop corner (outside the subject) keeps the base"
assert float(outm[0, 24, 32, 0]) > 0.99, "subject centre pasted"

# --- two subjects, two passes: each pass only touches its own region
left = torch.zeros(1, 24, 32); left[0, 6:18, 6:14] = 1
win_l = torch.tensor([[0.0, 0.25, 0.5, 0.5]]); win_r = torch.tensor([[0.5, 0.25, 0.5, 0.5]])
green = torch.zeros(1, 24, 32, 3); green[..., 1] = 1
p1, a1 = fc.paste_frames(plate[:1], red[:1], win_l, fc.crop_alpha(left, 24, 32, 1, 1, 2))
p2, a2 = fc.paste_frames(p1, green, win_r, fc.crop_alpha(left, 24, 32, 1, 1, 2))
assert float((a1 * a2).max()) == 0.0, "pass alphas are disjoint"
assert torch.equal(p2[0][a1[0] > 0], p1[0][a1[0] > 0]), "pass 2 never touches pass 1's subject"

# --- plate size
assert fc.plate_size(1920, 1080, 832, 480) == (1872, 1080)
assert fc.plate_size(3840, 2160, 832, 480, max_side=1920) == (1920, 1108)
assert fc.plate_size(640, 360, 832, 480) == (832, 480), "never below the generation size"

# --- nodes (no ComfyUI needed for these)
f, z, info = fc.CJFollowCamTrack().run(mask, 832, 480, mode="on", smooth=4)
assert f["active"] and f["windows"].shape == (T, 4) and "on" in info
plate_t = torch.rand(T, 90, 160, 3, generator=gen)
(cr,) = fc.CJFollowCamCrop().run(plate_t, f)
assert cr.shape == (T, 480, 832, 3)
(cm,) = fc.CJFollowCamCropMask().run(mask, f)
assert cm.shape == (T, 480, 832) and float(cm[0].sum()) > 0
fr, al = fc.CJFollowCamPaste().run(plate_t, cr, f, cm)
assert fr.shape == plate_t.shape and al.shape == (T, 90, 160)
far = al.sum(0) == 0
assert torch.equal(fr[:, far], plate_t[:, far]), "pixels no window/subject reached stay bit-identical"
print("followcam OK")
