"""CPU test for cj_extend_nodes (torch only, no ComfyUI).

usage: python tests/test_extend_nodes.py [path/to/cj_extend_nodes.py]
"""
import importlib.util
import os
import sys

import torch

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "cj_extend_nodes.py")
spec = importlib.util.spec_from_file_location("cj_extend_nodes", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

torch.manual_seed(0)

# -- LAB round trip and known values
rgb = torch.rand(4, 9, 11, 3)
assert torch.allclose(m.lab_to_srgb(m.srgb_to_lab(rgb)), rgb, atol=2e-4), "LAB round trip"
white = m.srgb_to_lab(torch.ones(1, 3))[0]
assert abs(white[0] - 100) < 0.05 and abs(white[1]) < 0.05 and abs(white[2]) < 0.05, white
black = m.srgb_to_lab(torch.zeros(1, 3))[0]
assert abs(black[0]) < 0.05, black

# -- colour match: a tinted, darker copy of the reference is pulled back onto it
H, W = 24, 32
yy, xx = torch.meshgrid(torch.linspace(0, 1, H), torch.linspace(0, 1, W), indexing="ij")
base = torch.stack([0.2 + 0.6 * xx, 0.3 + 0.4 * yy, 0.5 + 0.2 * torch.sin(6 * xx)], -1)
ref = torch.stack([(base + 0.005 * i).clamp(0, 1) for i in range(12)])
drift = (ref * torch.tensor([0.85, 0.95, 1.1]) - 0.03).clamp(0, 1)

err_before = (drift - ref).abs().mean().item()
out = m.color_match(drift, ref, 1.0)
assert out.shape == drift.shape and out.dtype == drift.dtype
assert out.min() >= 0 and out.max() <= 1
err_after = (out - ref).abs().mean().item()
assert err_after < 0.5 * err_before, (err_before, err_after)
mu_o, sd_o = m.lab_stats(out)
mu_r, sd_r = m.lab_stats(ref)
assert (mu_o - mu_r).abs().max() < 1.5, (mu_o, mu_r)

# strength 0 is identity, 0.5 sits between
assert torch.equal(m.color_match(drift, ref, 0.0), drift)
half = m.color_match(drift, ref, 0.5)
err_half = (half - ref).abs().mean().item()
assert err_after < err_half < err_before, (err_after, err_half, err_before)

# one transform per clip: identical input frames stay identical (no per-frame flicker)
same = drift[:1].repeat(5, 1, 1, 1)
o = m.color_match(same, ref, 1.0)
assert all(torch.equal(o[0], o[i]) for i in range(5))

# a flat reference does not blow the contrast up (std ratio clamped)
flat = torch.full((3, H, W, 3), 0.5)
o = m.color_match(drift, flat, 1.0)
assert torch.isfinite(o).all() and o.std() > 0.01

# alpha channel passes through; reference of another size is fine
rgba = torch.cat([drift, torch.rand(12, H, W, 1)], -1)
o = m.color_match(rgba, torch.rand(2, 8, 8, 3), 1.0)
assert o.shape == rgba.shape and torch.equal(o[..., 3:], rgba[..., 3:])

# -- retime
assert m.retime_count(48, 16, 30) == 90
assert m.retime_count(48, 16, 24) == 72
assert m.retime_count(48, 16, 29.97) == 90
assert m.retime_count(48, 16, 12) == 36
idx = m.retime_indices(48, 16, 30)
assert idx[0] == 0 and idx[-1] == 47 and idx == sorted(idx)
assert set(idx) == set(range(48)), "upsampling keeps every source frame"
assert max(b - a for a, b in zip(idx, idx[1:])) == 1
idx = m.retime_indices(48, 16, 8)
assert len(idx) == 24 and idx[0] == 0 and idx[-1] >= 46
assert m.retime_indices(16, 16, 16) == list(range(16))

frames = torch.arange(48, dtype=torch.float32).view(48, 1, 1, 1).expand(48, 2, 2, 3).contiguous()
r = m.retime(frames, 16, 30)
assert r.shape == (90, 2, 2, 3) and r[0, 0, 0, 0] == 0 and r[-1, 0, 0, 0] == 47
assert torch.equal(m.retime(frames, 16, 16), frames)
b = m.retime(frames, 16, 30, "blend")
assert b.shape == (90, 2, 2, 3)
vals = b[:, 0, 0, 0]
assert torch.all(vals[1:] >= vals[:-1]) and vals[0] == 0 and vals[-1] <= 47
assert abs(vals[15].item() - 15 * 16 / 30) < 1e-4  # linear in time

# -- node wrappers
(o,) = m.CJColorMatchToReference().apply(drift, ref, 1.0, "mean_std_lab")
assert o.shape == drift.shape
(o,) = m.CJRetimeFrames().apply(frames, 16.0, 24.0, "nearest")
assert o.shape[0] == 72
assert set(m.NODE_CLASS_MAPPINGS) == {"CJColorMatchToReference", "CJRetimeFrames"}

print("ok: cj_extend_nodes")
