"""CPU self-test for comfyui-krea2-outpaint (tiny Krea 2 DiT; no GPU, no ComfyUI
server, no weights). Needs ComfyUI-Krea2-Ostris-Edit in ComfyUI/custom_nodes.

Run from the ComfyUI checkout:  venv/bin/python <path>/selftest.py
"""

import importlib.util
import os
import sys
import unittest

import torch

sys.path.insert(0, os.getcwd())  # ComfyUI root

import comfy.ops  # noqa: E402
from comfy.ldm.krea2.model import SingleStreamDiT  # noqa: E402

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("krea2_outpaint_under_test", os.path.join(_here, "__init__.py"))
node = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(node)


def tiny_dit():
    torch.manual_seed(0)
    dm = SingleStreamDiT(features=32, tdim=16, txtdim=8, heads=2, kvheads=1, multiplier=2, layers=2,
                         patch=2, channels=16, txtlayers=1, txtheads=2, txtkvheads=2,
                         default_ref_method="index", operations=comfy.ops.disable_weight_init).eval()
    with torch.no_grad():
        for p in dm.parameters():
            p.normal_(0, 0.3)
    return dm


class OutpaintTest(unittest.TestCase):
    def setUp(self):
        self.dm = tiny_dit()
        torch.manual_seed(1)
        self.x = torch.randn(1, 16, 8, 12)        # target grid 4x6
        self.t = torch.tensor([0.7])
        self.ctx = torch.randn(1, 5, 8)
        self.refs = [torch.randn(1, 16, 4, 6), torch.randn(1, 16, 2, 2)]  # grids 2x3 and 1x1

    def fwd(self, placements):
        with torch.no_grad():
            return node._forward_with_refs_bbox(self.dm, self.x, self.t, self.ctx, self.refs, placements, {})

    def test_bbox_rope_ids(self):
        _, pos = node.ost._pack_refs(self.dm, self.refs, 1, "cpu", torch.float32)
        got = node._place_refs_bbox(pos, self.refs, [(0.0, 0.0, 1.0, 1.0), None], (4, 6), 2)
        a = got[0, :6].reshape(2, 3, 3)
        self.assertTrue(bool((a[..., 0] == 1).all()))
        torch.testing.assert_close(a[:, 0, 1], torch.tensor([0.5, 2.5]))       # (i+.5)*4/2-.5
        torch.testing.assert_close(a[0, :, 2], torch.tensor([0.5, 2.5, 4.5]))  # (j+.5)*6/3-.5
        torch.testing.assert_close(got[0, 6:], pos[0, 6:])                     # None keeps index ids
        self.assertFalse(torch.equal(pos[0, :6], got[0, :6]))                  # input not mutated...
        torch.testing.assert_close(pos[0, :6, 1], torch.tensor([0., 0., 0., 1., 1., 1.]))

    def test_no_placement_is_stock_ostris(self):
        with torch.no_grad():
            want = node.ost._forward_with_refs(self.dm, self.x, self.t, self.ctx, self.refs, {})
        self.assertTrue(torch.equal(self.fwd(None), want))
        self.assertTrue(torch.equal(self.fwd([None, None]), want))

    def test_placement_changes_output_and_restores_pack(self):
        orig = node.ost._pack_refs
        out = self.fwd([(0.25, 0.25, 0.75, 0.75), None])
        self.assertIs(node.ost._pack_refs, orig)
        self.assertEqual(out.shape, self.x.shape)
        self.assertFalse(torch.equal(out, self.fwd(None)))

    def test_model_patch_path(self):
        patches = {}
        dm = self.dm

        class FakeBase:
            def extra_conds(self, **kw):
                return {}

            def extra_conds_shapes(self, **kw):
                return {}

            def process_latent_in(self, x):
                return x

        class FakeModel:
            model = FakeBase()

            def clone(self):
                return self

            def get_model_object(self, name):
                return patches.get(name, dm)

            def add_object_patch(self, name, obj):
                patches[name] = obj

        node.Krea2OutpaintModelPatch().patch(FakeModel())
        ec = patches["extra_conds"](reference_latents=self.refs, reference_placements=[(0.25, 0.25, 0.75, 0.75), None])
        self.assertEqual(set(ec), {"ref_latents", "reference_placements"})
        pl = [(0.25, 0.25, 0.75, 0.75), None]
        with torch.no_grad():
            got = patches["diffusion_model.forward"](self.x, self.t, self.ctx, transformer_options={},
                                                      ref_latents=self.refs, reference_placements=pl)
        self.assertTrue(torch.equal(got, self.fwd(pl)))
        self.assertIs(node.ost._pack_refs, node._ORIG_PACK)

    def test_odd_sizes_pad_like_ostris(self):
        self.refs = [torch.randn(1, 16, 5, 7)]  # padded to 6x8 -> grid 3x4
        _, pos = node.ost._pack_refs(self.dm, self.refs, 1, "cpu", torch.float32)
        self.assertEqual(pos.shape[1], 12)
        node._place_refs_bbox(pos, self.refs, [(0.0, 0.0, 1.0, 1.0)], (4, 6), 2)


if __name__ == "__main__":
    unittest.main()
