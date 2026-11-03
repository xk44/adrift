"""CPU unit test for cj_removal_gate scoring.  usage: python test_removal_gate.py path/to/cj_removal_gate.py

Synthetic 22-frame window with a green-filled mask box: a green-copy output, a clean output, a
regrown-person mask, plus index sampling and the pass/score rule."""
import importlib.util
import sys

import torch

spec = importlib.util.spec_from_file_location("rg", sys.argv[1])
rg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rg)

T, H, W = 22, 64, 48
masked = torch.rand(T, H, W, 3) * 0.5 + 0.25          # textured source, never pure green
masked[:, 20:40, 10:30] = torch.tensor([0., 1., 0.])  # H3RelayGreenMask fill
area = 20 * 20

copy = masked.clone()
copy[..., 1] = copy[..., 1].clamp(max=0.95) * 0.98 + 0.01   # codec-ish: green ~0.97, not exact
g = rg.green_copy_scores(copy, masked)
assert g.shape == (T,) and float(g.min()) > 0.99, g

clean = masked.clone()
clean[:, 20:40, 10:30] = torch.tensor([0.2, 0.25, 0.3])     # background reconstructed
assert float(rg.green_copy_scores(clean, masked).max()) == 0.0

partial = clean.clone()
partial[5, 20:30, 10:30] = torch.tensor([0.05, 0.9, 0.1])   # half the box still green on one frame
s = rg.green_copy_scores(partial, masked)
assert abs(float(s[5]) - 0.5) < 1e-6 and float(s[4]) == 0.0, s

nomask = torch.rand(T, H, W, 3) * 0.5
assert float(rg.green_copy_scores(nomask, nomask).max()) == 0.0

# person overlap: detector mask at a different resolution covering the left half of the box
idx = rg.sample_indices(T)
assert idx[0] >= 1 and idx[-1] == T - 1 and len(idx) == 4 and idx == sorted(set(idx)), idx
det = torch.zeros(len(idx), H * 2, W * 2)
det[:, 40:80, 20:40] = 1.0
o = rg.overlap_scores(det, masked, idx)
assert all(abs(v - 0.5) < 0.06 for v in o), o
assert rg.overlap_scores(torch.zeros(H, W), masked, [3]) == [0.0]
assert rg.sample_indices(1) == [0]

# haze: translucent green blend in the box interior; the box edge band never counts.
# Grey-textured scene (real footage: outside-mask excess green p99.5 ~0.02-0.08).
masked = (torch.rand(T, H, W, 1) * 0.5 + 0.25) + torch.randn(T, H, W, 3) * 0.01
masked[:, 20:40, 10:30] = torch.tensor([0., 1., 0.])
clean = masked.clone()
clean[:, 20:40, 10:30] = torch.tensor([0.2, 0.25, 0.3])
haze = clean.clone()
haze[7, 20:40, 10:30] = haze[7, 20:40, 10:30] * 0.6 + torch.tensor([0., 1., 0.]) * 0.4
hz = rg.haze_scores(haze, masked)
assert float(hz[7]) > 0.9 and float(hz[6]) == 0.0, hz
assert float(rg.haze_scores(clean, masked).max()) == 0.0
assert float(rg.green_copy_scores(haze, masked)[7]) == 0.0   # strict green test misses it
rim = clean.clone()
rim[8, 20:24, 10:30] = torch.tensor([0.1, 0.8, 0.1])          # seam pixels within the erode band
assert float(rg.haze_scores(rim, masked)[8]) == 0.0
leafy = masked.clone(); leafy[:, :10] = torch.tensor([0.1, 0.6, 0.1])   # green scene outside the mask
lf = clean.clone(); lf[:, :10] = leafy[:, :10]
lf[9, 20:40, 10:30] = torch.tensor([0.15, 0.55, 0.15])         # same foliage green inside: not haze
assert float(rg.haze_scores(lf, leafy)[9]) == 0.0
assert float(rg.haze_scores(nomask, nomask).max()) == 0.0
assert rg.every_frame(T) == list(range(1, T)) and rg.every_frame(1) == [0]

ok, sc = rg.judge(0.0, 0.0, 0.02, 0.08)
assert ok and sc == 0.0
ok, sc_g = rg.judge(0.9, 0.0, 0.02, 0.08)
assert not ok
ok, sc_p = rg.judge(0.0, 0.5, 0.02, 0.08)
assert not ok and sc_p < sc_g        # a mostly-green window ranks worse than a regrowth
assert rg.judge(0.0, 0.26, 0.1, 0.4, 0.0, 0.03, 0.0, 0.05)[0]          # seat false-positive alone passes
ok, sc_part = rg.judge(0.0, 0.26, 0.1, 0.4, 0.0, 0.03, 0.17, 0.05)
assert not ok and sc_part > 3                                           # forearm remnant fails
ok, sc_h = rg.judge(0.0, 0.0, 0.1, 0.4, 0.08, 0.03, 0.0, 0.05)
assert not ok and 2 < sc_h < 3
# attempt ranking, real v3 w0 numbers: a forearm remnant (part 0.194) must lose to a
# remnant-free attempt whose few green/hazy frames plate_fill can repair.
L = (0.1, 0.4, 0.03, 0.05)
arm = rg.attempt_rank([0.0] * 22, [0.0] * 22, 0.263, 0.194, *L)
hazy = rg.attempt_rank([0.0] * 18 + [0.149] * 4, [0.0] * 18 + [0.166] * 4, 0.007, 0.005, *L)
copy_all = rg.attempt_rank([0.998] * 22, [1.0] * 22, 0.987, 0.209, *L)
assert hazy < arm < copy_all, (hazy, arm, copy_all)
assert rg.attempt_rank([0.0] * 18 + [0.149] * 4, [0.0] * 18 + [0.166] * 4, 0.007, 0.005, *L,
                       can_patch=False) > arm          # no plate fallback: haze counts in full
mostly = rg.attempt_rank([0.0] * 6 + [0.149] * 16, [0.0] * 22, 0.0, 0.0, *L)
assert mostly[0] > 1                                    # > half the window bad: not repairable
assert rg.attempt_rank([0.0] * 22, [0.01] * 22, 0.1, 0.0, *L) < rg.attempt_rank([0.0] * 22, [0.02] * 22, 0.1, 0.0, *L)

# prompt splicing
base = "Remove the green-masked person and their shadow, and reconstruct the background. Preserve the rest."
assert rg.compose_prompt(base, "") == base and rg.compose_prompt(base, None) == base
got = rg.compose_prompt(base, " 'a white truck cab,\n trees outside.' ")
assert got == "Remove the green-masked person and their shadow, and reconstruct the background: a white truck cab, trees outside. Preserve the rest.", got
assert rg.compose_prompt("Fill {background} here.", "a beach") == "Fill a beach here."
assert rg.compose_prompt("Remove them.", "a beach") == "Remove them. Background to reconstruct: a beach."
assert len(rg.compose_prompt("x", "y" * 999)) < 340

# plate fallback: static textured scene; first half of the window clean, second half a green copy
try:
    import cv2  # noqa: F401
except ImportError:
    print("removal gate scoring OK (cv2 missing: plate_fill skipped)")
    sys.exit(0)
gen = torch.Generator().manual_seed(0)
H2, W2 = 128, 96
tex = torch.rand(H2 // 8, W2 // 8, 3, generator=gen).repeat_interleave(8, 0).repeat_interleave(8, 1)
src = tex[None].repeat(T, 1, 1, 1) * 0.6 + 0.2
masked2 = src.clone()
masked2[:, 40:80, 30:60] = torch.tensor([0., 1., 0.])
bg = torch.tensor([0.3, 0.35, 0.4])
out = src.clone()
out[:11, 40:80, 30:60] = bg
out[11:, 40:80, 30:60] = torch.tensor([0.02, 0.97, 0.03])
filled, n = rg.plate_fill(out, masked2, 0.1)
assert n == T - 11, n
assert float(rg.green_copy_scores(filled, masked2).max()) == 0.0
centre = filled[11:, 50:70, 38:52]
assert float((centre - bg).abs().max()) < 0.03, float((centre - bg).abs().max())
assert torch.equal(filled[:11], out[:11])            # clean frames untouched
rim = filled[11:, 40:80, 30:60]                          # the whole mask, edge rows/cols included
assert float(rg._excess_green(rim).max()) < 0.05, float(rg._excess_green(rim).max())   # no green contour
same, n0 = rg.plate_fill(src.clone(), masked2, 0.1)   # nothing green -> no-op
assert n0 == 0
grey = tex.mean(-1, keepdim=True).expand(-1, -1, 3)[None].repeat(T, 1, 1, 1) * 0.6 + 0.2
masked3 = grey.clone()
masked3[:, 40:80, 30:60] = torch.tensor([0., 1., 0.])
hz_out = grey.clone()
hz_out[:, 40:80, 30:60] = bg
hz_out[15, 40:80, 30:60] = bg * 0.7 + torch.tensor([0., 1., 0.]) * 0.3   # haze flash on one frame
assert float(rg.green_copy_scores(hz_out, masked3)[15]) == 0.0            # haze only, not green
filled, n = rg.plate_fill(hz_out, masked3, 0.1)
assert n == 1 and float(rg.haze_scores(filled, masked3).max()) == 0.0, n
assert float((filled[15, 50:70, 38:52] - bg).abs().max()) < 0.03
# repair-then-judge: an attempt clean everywhere except a few green frames passes after the fill
gv = [0.0] * 19 + [0.9] * 3
assert rg.repairable(gv, [0.0] * 22, 0.1) and not rg.repairable([0.0] * 22, [0.0] * 22, 0.1)
assert not rg.repairable([0.9] * 12 + [0.0] * 10, [0.0] * 22, 0.1)      # > half bad: nothing to plate from
few = src.clone()
few[:, 40:80, 30:60] = bg
few[19:, 40:80, 30:60] = torch.tensor([0.02, 0.97, 0.03])
gate = rg.CJRemovalWindowGate()
got, aud = gate.gate(few, "aud", masked2, None, None, None, None, None, None, seed=1, attempt=1,
                     max_attempts=4, green_limit=0.1, person_limit=0.4, window_index=0, run_key="t")
assert aud == "aud" and float(rg.green_copy_scores(got, masked2).max()) == 0.0
assert float((got[19:, 50:70, 38:52] - bg).abs().max()) < 0.03
got2, _ = gate.gate(few, "aud", masked2, None, None, None, None, None, None, seed=1, attempt=1,
                    max_attempts=1, green_limit=0.1, person_limit=0.4, window_index=1, run_key="t",
                    plate_fallback=False)
assert float(rg.green_copy_scores(got2, masked2).max()) > 0.5          # fallback off: untouched
print("removal gate scoring + plate fallback OK")
