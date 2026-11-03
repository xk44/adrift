"""CPU test for cj_mask_blob.  usage: python test_mask_blob.py path/to/cj_mask_blob.py"""
import importlib.util
import sys

import torch

spec = importlib.util.spec_from_file_location("mb", sys.argv[1])
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)

T, H, W = 6, 64, 64
m = torch.zeros(T, H, W)
m[:, 20:50, 20:30] = 1          # torso
m[:, 22:26, 30:55] = 1          # arm sticking out sideways: an L/T silhouette
h = mb.hull_mask(m)
assert h.shape == m.shape and torch.all(h >= m), "hull must contain the mask"
assert float(h[0, 30, 38]) == 1.0 and float(m[0, 30, 38]) == 0.0, "concavity under the arm filled"
assert float(h[0, 5, 5]) == 0.0, "hull stays local"
two = torch.zeros(1, H, W); two[0, 5:10, 5:10] = 1; two[0, 50:55, 50:55] = 1
assert float(mb.hull_mask(two)[0, 30, 30]) == 0.0, "separate regions are hulled separately"

pulse = torch.zeros(T, H, W); pulse[3, 10:12, 10:12] = 1
u = mb.temporal_union(pulse, 1)
assert [float(u[t, 10, 10]) for t in range(T)] == [0, 0, 1, 1, 1, 0], u[:, 10, 10]
assert torch.equal(mb.temporal_union(pulse, 0), pulse)

g = mb.grow(pulse, 3)
assert float(g[3, 7, 7]) == 1.0 and float(g[3, 6, 6]) == 0.0
out = mb.blob(m, hull=True, temporal_radius=1, grow_pixels=2)
assert out.shape == m.shape and float(out.max()) == 1.0 and torch.all(out >= m)
assert mb.blob(m[0], hull=False).shape == (1, H, W)
print("mask blob OK")
