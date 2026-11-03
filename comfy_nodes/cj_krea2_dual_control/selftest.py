"""CPU self-test for cj_krea2_dual_control with a tiny Krea 2 DiT. No GPU, no ComfyUI server.

Run from the ComfyUI checkout:  venv/bin/python <path>/selftest.py [path/to/krea2-control.safetensors]
"""

import os
import sys
import unittest

import torch

sys.path.insert(0, os.getcwd())  # ComfyUI root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import comfy.ops  # noqa: E402
import comfy.patcher_extension as pe  # noqa: E402
import comfy.utils  # noqa: E402
from comfy.ldm.krea2.model import SingleStreamDiT  # noqa: E402

import cj_krea2_dual_control as node  # noqa: E402

ADAPTER = sys.argv[1] if len(sys.argv) > 1 else None
sys.argv = sys.argv[:1]


def tiny_dit():
    torch.manual_seed(0)
    return SingleStreamDiT(features=32, tdim=16, txtdim=8, heads=2, kvheads=2, multiplier=2, layers=2,
                           patch=2, channels=16, txtlayers=2, txtheads=2, txtkvheads=2,
                           default_ref_method="index", operations=comfy.ops.disable_weight_init).eval()


def opts(state=None, sigma=None, schedule=None):
    o = {}
    if state is not None:
        o["wrappers"] = {pe.WrappersMP.DIFFUSION_MODEL: {node.WRAPPER_KEY: [node.dual_control_wrapper(state)]}}
    if sigma is not None:
        o["sigmas"] = torch.tensor([sigma])
        o["sample_sigmas"] = torch.tensor(schedule)
    return o


class DualControlTest(unittest.TestCase):
    def setUp(self):
        self.dm = tiny_dit()
        with torch.no_grad():
            for p in self.dm.parameters():
                p.normal_(0, 0.05)
        torch.manual_seed(1)
        self.x = torch.randn(2, 16, 8, 6)
        self.t = torch.tensor([0.5, 0.5])
        self.ctx = torch.randn(2, 5, 2 * 8)
        self.color = torch.randn(1, 16, 8, 6)
        self.depth = torch.randn(1, 16, 8, 6)

    def run_dm(self, o, ref=None):
        with torch.no_grad():
            return self.dm(self.x, self.t, self.ctx, ref_latents=ref, transformer_options=o)

    def adapter(self, control_scale=1.0):
        w0, b0 = self.dm.first.weight.detach(), self.dm.first.bias.detach()
        ctrl = torch.randn(w0.shape[0], 128) * 0.05 * control_scale
        return torch.cat([w0, ctrl], dim=1), b0.clone()

    def test_pack_matches_process_img(self):
        img, _, _, _ = self.dm.process_img(self.x)
        self.assertTrue(torch.equal(node.pack_latent(self.x, 2), img))
        odd = torch.randn(1, 16, 7, 5)  # padding path
        self.assertTrue(torch.equal(node.pack_latent(odd, 2), self.dm.process_img(odd)[0]))

    def test_zero_control_columns_is_identity(self):
        w, b = self.adapter(control_scale=0.0)
        base = self.run_dm(opts())
        st = node.DualControlState(w, b, self.color, self.depth, 1.0, 1.0)
        out = self.run_dm(opts(st))
        torch.testing.assert_close(out, base)
        self.assertIsInstance(self.dm.first, torch.nn.Linear)  # restored

    def test_controls_change_output_and_absent_equals_zero(self):
        w, b = self.adapter()
        none = self.run_dm(opts(node.DualControlState(w, b, None, None, 1.0, 1.0)))
        both = self.run_dm(opts(node.DualControlState(w, b, self.color, self.depth, 1.0, 1.0)))
        zeros = self.run_dm(opts(node.DualControlState(w, b, torch.zeros_like(self.color),
                                                       torch.zeros_like(self.depth), 1.0, 1.0)))
        self.assertGreater((both - none).abs().max().item(), 1e-4)
        torch.testing.assert_close(none, zeros)

    def test_feature_order_color_then_depth(self):
        w, b = self.adapter()
        out = self.run_dm(opts(node.DualControlState(w, b, self.color, None, 1.0, 1.0)))
        # hand-built: put the color latent into the *depth* slot of a column-swapped weight
        ws = torch.cat([w[:, :64], w[:, 128:], w[:, 64:128]], dim=1)
        swapped = self.run_dm(opts(node.DualControlState(ws, b, None, self.color, 1.0, 1.0)))
        torch.testing.assert_close(out, swapped)

    def test_end_fraction(self):
        w, b = self.adapter()
        sched = [1.0, 0.8, 0.6, 0.4, 0.2, 0.0]  # 5 steps
        st = node.DualControlState(w, b, self.color, self.depth, 0.4, 1.0)
        depth_only = node.DualControlState(w, b, None, self.depth, 1.0, 1.0)
        both = node.DualControlState(w, b, self.color, self.depth, 1.0, 1.0)
        # step 1 (fraction 0.2) < 0.4 -> color still on
        torch.testing.assert_close(self.run_dm(opts(st, 0.8, sched)), self.run_dm(opts(both, 0.8, sched)))
        # step 2 (fraction 0.4) -> color off
        torch.testing.assert_close(self.run_dm(opts(st, 0.6, sched)), self.run_dm(opts(depth_only, 0.6, sched)))
        self.assertTrue(node.control_active(0.4, None))
        self.assertTrue(node.control_active(1.0, 0.99))
        self.assertFalse(node.control_active(0.0, 0.0))

    def test_ref_latents_keep_original_projection(self):
        w, b = self.adapter(control_scale=0.0)
        ref = [torch.randn(1, 16, 8, 6)]
        torch.testing.assert_close(self.run_dm(opts(node.DualControlState(w, b, self.color, None, 1, 1)), ref),
                                   self.run_dm(opts(), ref))

    def test_latent_resize_and_batch(self):
        w, b = self.adapter()
        small = torch.randn(1, 16, 4, 3)
        st = node.DualControlState(w, b, small, None, 1.0, 1.0)
        tok, n = st.control_tokens(self.x, 2, None)
        self.assertEqual(tuple(tok.shape), (2, 12, 128))
        self.assertEqual(n, 12)

    def test_restores_first_on_error(self):
        w, b = self.adapter()
        bad = node.DualControlState(w, b, torch.randn(1, 4, 8, 6), None, 1.0, 1.0)  # wrong channels
        with self.assertRaises(RuntimeError):
            self.run_dm(opts(bad))
        self.assertIsInstance(self.dm.first, torch.nn.Linear)

    def test_split_adapter(self):
        sd = {"img_in.weight": torch.zeros(4, 9), "img_in.bias": torch.zeros(4), "x.lora_A.weight": torch.zeros(1)}
        w, b, lora = node.split_adapter(sd)
        self.assertEqual(list(lora), ["x.lora_A.weight"])
        with self.assertRaises(RuntimeError):
            node.split_adapter({"img_in.weight": torch.zeros(4, 64), "img_in.bias": torch.zeros(4)})

    @unittest.skipUnless(ADAPTER, "pass the real adapter path to check its LoRA keys")
    def test_real_adapter_keys_all_map(self):
        from safetensors import safe_open
        with safe_open(ADAPTER, "pt") as f:
            keys = list(f.keys())
            shape = f.get_slice("img_in.weight").get_shape()
        self.assertEqual(shape, [6144, 192])
        km = comfy.utils.krea2_to_diffusers({"layers": 28})
        bases = {k[: -len(".weight")] for k in km}
        lora_bases = {k.rsplit(".lora_", 1)[0] for k in keys if ".lora_" in k}
        unmapped = sorted(lora_bases - bases)
        self.assertEqual(unmapped, [], unmapped[:10])
        self.assertEqual(len(keys), 2 * len(lora_bases) + 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
