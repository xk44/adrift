"""CPU unit test for cj_lens_blur.  usage: python -I test_lens_blur.py

CoC math, disc kernel, ease/rack schedule, focal sampling, and halo checks on a synthetic two-plane scene:
a flat red square (near) over a grey/white striped background (far).
- focus on the square: the square stays pixel-exact, the background blurs, and red must not bleed into the
  background ring around the square (a naive "blur the image, paste the sharp subject" leaks it).
- focus on the background: the far plane away from the square stays sharp, the square's edge spreads softly
  over it, and the transition has no dark/bright ring.
Also runs both ComfyUI nodes (CPU fallback) on a small batch."""
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _fake_comfy  # noqa: E402

lb = _fake_comfy.load("cj_lens_blur.py")
fails = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(name)


# --- CoC math
d = torch.tensor([0.0, 0.25, 0.5, 0.52, 0.75, 1.0])
c = lb.coc_map(d, 0.5, 40.0, focus_range=0.03)
exp = torch.tensor([-(0.5 - 0.03) * 40, -(0.25 - 0.03) * 40, 0.0, 0.0, (0.25 - 0.03) * 40, (0.5 - 0.03) * 40])
check("coc signed + focus band", torch.allclose(c, exp, atol=1e-5), str(c.tolist()))
check("coc max clamp", float(lb.coc_map(d, 0.0, 100.0, max_radius=10).max()) == 10.0)
check("aperture % of long side", abs(lb.aperture_px(2.5, 400, 800) - 20.0) < 1e-6)

for r in (0.3, 1.0, 2.7, 6.0):
    k = lb.disc_kernel(r)
    check(f"disc kernel r={r} sums to 1", abs(float(k.sum()) - 1) < 1e-5)
k = lb.disc_kernel(5.0)
check("disc kernel is round", float(k[5, 0]) > 0 and float(k[0, 0]) == 0.0)
flat = torch.full((1, 3, 40, 50), 0.37)
for r in (3.0, 20.0):
    check(f"disc blur keeps flat field r={r}", float((lb.disc_blur(flat, r) - 0.37).abs().max()) < 1e-4)

# --- ease + rack schedule
check("ease endpoints", all(abs(lb.ease(0, e)) < 1e-9 and abs(lb.ease(1, e) - 1) < 1e-9 for e in lb.EASES))
check("ease monotone", all(lb.ease(i / 20, e) <= lb.ease((i + 1) / 20, e) + 1e-12 for e in lb.EASES for i in range(20)))
check("smooth ease midpoint", abs(lb.ease(0.5, "smooth") - 0.5) < 1e-9)
check("rack holds before A / after B",
      lb.rack_progress(0.5, 1.0, 3.0) == 0.0 and lb.rack_progress(3.5, 1.0, 3.0) == 1.0)
check("rack mid", abs(lb.rack_progress(2.0, 1.0, 3.0, "linear") - 0.5) < 1e-9)
check("rack cut when B<=A", lb.rack_progress(0.9, 1.0, 1.0) == 0.0 and lb.rack_progress(1.0, 1.0, 1.0) == 1.0)
check("smooth_track drops spike", lb.smooth_track([0.5, 0.5, 0.9, 0.5, 0.5])[2] == 0.5)

# --- two-plane scene
H, W = 160, 200
yy, xx = torch.meshgrid(torch.arange(H), torch.arange(W), indexing="ij")
stripes = ((xx // 3) % 2).float() * 0.6 + 0.3
img = torch.stack([stripes, stripes, stripes])           # (3,H,W) grey/white stripes
sq = (yy >= 50) & (yy < 110) & (xx >= 70) & (xx < 130)
red = torch.tensor([0.9, 0.05, 0.05])
img[:, sq] = red[:, None]
depth = torch.where(sq, 0.9, 0.1).float()                 # near = white

check("sample_depth on square", abs(lb.sample_depth(depth, 0.5, 0.5) - 0.9) < 1e-6)
check("sample_depth on background", abs(lb.sample_depth(depth, 0.05, 0.05) - 0.1) < 1e-6)

R = 10.0
ap = R / 0.8
# focus on the square
coc = lb.coc_map(depth, 0.9, ap)
out = lb.lens_blur(img, coc, highlights=0.0)
check("output finite + in range", bool(torch.isfinite(out).all()) and float(out.min()) >= 0 and float(out.max()) <= 1)
check("in-focus square unchanged", float((out[:, sq] - img[:, sq]).abs().max()) < 2e-3)
far_bg = (yy >= 20) & (yy < H - 20) & (xx >= 15) & (xx < 45)
check("background blurred", float(out[0, far_bg].std()) < 0.25 * float(img[0, far_bg].std()),
      f"std {float(out[0, far_bg].std()):.3f} vs {float(img[0, far_bg].std()):.3f}")
dist_out = torch.zeros(H, W)
dx = torch.maximum(70 - xx, xx - 129).clamp(min=0).float()
dy = torch.maximum(50 - yy, yy - 109).clamp(min=0).float()
dist_out = torch.sqrt(dx ** 2 + dy ** 2)
ring = (dist_out > 0) & (dist_out <= R)
redness = (out[0] - out[1]).abs()                          # background is neutral grey; red square is not
leak = float(redness[ring].max())
check("no subject halo in blurred background", leak < 0.03, f"max red-green in ring {leak:.4f}")

naive = lb.disc_blur(img[None], R)[0]
naive[:, sq] = img[:, sq]
naive_leak = float((naive[0] - naive[1]).abs()[ring].max())
check("naive blur would leak (test is sensitive)", naive_leak > 0.2, f"naive {naive_leak:.3f}")

# focus on the background: blurred square over sharp stripes
coc = lb.coc_map(depth, 0.1, ap)
out = lb.lens_blur(img, coc, highlights=0.0)
far = dist_out > 2 * R + 2
check("background sharp away from square", float((out[:, far] - img[:, far]).abs().max()) < 2e-3)
core = (yy >= 50 + 2 * R) & (yy < 110 - 2 * R) & (xx >= 70 + 2 * R) & (xx < 130 - 2 * R)
check("blurred square core keeps its colour", float((out[:, core] - red[:, None]).abs().max()) < 0.02)
just_out = (dist_out > 1) & (dist_out <= R / 2)
spread = float((out[0] - out[1])[just_out].mean())
check("blurred square spreads past its edge", spread > 0.15, f"mean red-green just outside {spread:.3f}")
# row through the edge: every pixel must be a mix of red, the stripe colours and the hidden background
# (all within the per-channel hull of red and 0.3..0.9 grey); a dark/bright ring would leave that hull
row = out[:, 80, 40:160]
lo = torch.minimum(red, torch.tensor(0.3))[:, None] - 0.02
hi = torch.maximum(red, torch.tensor(0.9))[:, None] + 0.02
check("no dark/bright ring at blurred edge", bool(((row >= lo) & (row <= hi)).all()))

# highlight boost: a tiny bright point behind focus grows into a brighter disc
pt = torch.full((3, 64, 64), 0.2)
pt[:, 30:33, 30:33] = 1.0
dpt = torch.full((64, 64), 0.1)
coc = lb.coc_map(dpt, 0.9, 8.0 / 0.8)
plain = lb.lens_blur(pt, coc, highlights=0.0)
boosted = lb.lens_blur(pt, coc, highlights=1.0)
check("highlight boost brightens bokeh disc", float(boosted[:, 31, 31].mean()) > float(plain[:, 31, 31].mean()) + 0.05,
      f"{float(plain[:, 31, 31].mean()):.3f} -> {float(boosted[:, 31, 31].mean()):.3f}")
check("highlight boost leaves dark areas", abs(float(boosted[:, 5, 5].mean()) - float(plain[:, 5, 5].mean())) < 1e-3)

# --- nodes
batch = img.permute(1, 2, 0)[None].repeat(3, 1, 1, 1)
dimg = depth[None, ..., None].repeat(3, 1, 1, 3)
(res,) = lb.CJRefocus().run(batch[:1], dimg[:1], focus_x=0.5, focus_y=0.5, blur_amount=5.0)
check("CJRefocus shape", tuple(res.shape) == (1, H, W, 3))
check("CJRefocus keeps focused square", float((res[0][sq] - batch[0][sq]).abs().max()) < 2e-3)
(res,) = lb.CJRackFocus().run(batch, dimg, fps=1.0, a_x=0.5, a_y=0.5, a_time=0.0, b_x=0.05, b_y=0.05, b_time=2.0,
                               ease="linear", blur_amount=5.0, depth_smoothing=0.0)
check("CJRackFocus shape", tuple(res.shape) == (3, H, W, 3))
check("rack frame 0 focused on A", float((res[0][sq] - batch[0][sq]).abs().max()) < 2e-3)
check("rack last frame focused on B", float((res[2][far] - batch[2][far]).abs().max()) < 2e-3)
mid_sq = float((res[1][sq] - batch[1][sq]).abs().mean())
check("rack mid frame both partly soft", mid_sq > 1e-3)
(res2,) = lb.CJRackFocus().run(batch, dimg, fps=1.0, a_x=0.05, a_y=0.05, a_time=2.0, b_x=0.5, b_y=0.5, b_time=0.0,
                                ease="linear", blur_amount=5.0, depth_smoothing=0.0)
check("rack swaps reversed times", float((res2 - res).abs().max()) < 1e-5)
four = torch.cat([batch[:1], torch.ones(1, H, W, 1)], -1)
(res,) = lb.CJRefocus().run(four, dimg[:1], blur_amount=3.0)
check("alpha channel passes through", tuple(res.shape) == (1, H, W, 4) and float(res[..., 3].min()) == 1.0)
check("depth temporal smoothing keeps constant", float((lb.smooth_depth(dimg[..., 0], 0.5) - dimg[..., 0]).abs().max()) < 1e-6)

print(f"\n{len(fails)} failed" if fails else "\nall passed")
sys.exit(1 if fails else 0)
