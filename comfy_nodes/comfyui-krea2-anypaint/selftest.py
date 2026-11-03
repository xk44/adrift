"""CPU self-test for comfyui-krea2-anypaint (tiny tensors, tiny Krea 2 DiT; no GPU,
no ComfyUI server, no model weights).

Run from the ComfyUI checkout:  venv/bin/python <path>/selftest.py
"""

import importlib.util
import os
import sys
import unittest

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, os.getcwd())  # ComfyUI root

import comfy.ops  # noqa: E402
import comfy.utils  # noqa: E402
from comfy.ldm.krea2.model import SingleStreamDiT  # noqa: E402

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("krea2_anypaint_under_test", os.path.join(_here, "__init__.py"))
node = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(node)

try:
    import cv2
except ImportError:  # parity check is skipped without OpenCV
    cv2 = None


def tiny_dit():
    torch.manual_seed(0)
    dm = SingleStreamDiT(features=32, tdim=16, txtdim=8, heads=2, kvheads=1, multiplier=2, layers=2,
                         patch=2, channels=16, txtlayers=1, txtheads=2, txtkvheads=2,
                         default_ref_method="index", operations=comfy.ops.disable_weight_init).eval()
    with torch.no_grad():
        for p in dm.parameters():
            p.normal_(0, 0.3)
    return dm


def rgb(w, h, seed=0):
    rng = np.random.default_rng(seed)
    return Image.fromarray(rng.integers(0, 256, (h, w, 3), dtype=np.uint8), mode="RGB")


def L(arr):
    return Image.fromarray(np.asarray(arr, dtype=np.uint8), mode="L")


class PrepareTest(unittest.TestCase):
    def test_inpaint_full_canvas(self):
        src = rgb(64, 48)
        m = np.zeros((48, 64), np.uint8)
        m[16:24, 32:48] = 200  # > 127 -> generated
        m[0:4, 0:4] = 100      # <= 127 -> preserved
        cond, known, keep, gen = node.prepare_anypaint(src, L(m), (64, 48), seam_px=4, reference_max_edge=32)
        # known == source (bbox spans the canvas, LANCZOS to the same size is identity)
        np.testing.assert_array_equal(np.asarray(known), np.asarray(src))
        g = np.asarray(gen) > 0
        self.assertEqual(g.sum(), 8 * 16)
        self.assertTrue(g[16:24, 32:48].all())
        # keep = NOT(dilate(generated, 9x9 rect))
        k = np.asarray(keep) > 0
        self.assertFalse(k[12:28, 28:52].any())
        self.assertTrue(k[11, 30] and k[28, 30] and k[20, 27] and k[20, 52])
        # condition: generated pixels -> median of known pixels, then max edge 32 (/16)
        self.assertEqual(cond.size, (32, 16))  # 64x48 * 0.5 = 32x24 -> //16*16 = 32x16
        cv = np.asarray(src).copy()
        cv[g] = np.median(cv[~g].reshape(-1, 3), axis=0).round().astype(np.uint8)
        want = Image.fromarray(cv).resize((32, 16), Image.Resampling.LANCZOS)
        np.testing.assert_array_equal(np.asarray(cond), np.asarray(want))

    def test_outpaint_bbox_and_source_sized_mask(self):
        src = rgb(32, 32, seed=3)
        m = np.zeros((32, 32), np.uint8)
        m[0:8, 0:8] = 255
        cond, known, keep, gen = node.prepare_anypaint(src, L(m), (64, 32), (16, 0, 48, 32), seam_px=0)
        kv = np.asarray(known)
        np.testing.assert_array_equal(kv[:, 16:48], np.asarray(src))
        fill = np.median(np.asarray(src).reshape(-1, 3), axis=0).round().astype(np.uint8)
        self.assertTrue((kv[:, :16] == fill).all() and (kv[:, 48:] == fill).all())
        g = np.asarray(gen) > 0
        self.assertTrue(g[:, :16].all() and g[:, 48:].all())  # outside bbox always generated
        self.assertTrue(g[0:8, 16:24].all())                   # mask placed into the bbox
        self.assertEqual(int(g[:, 16:48].sum()), 64)
        np.testing.assert_array_equal(np.asarray(keep) > 0, ~g)  # seam 0

    def test_no_mask_is_pure_outpaint(self):
        src = rgb(32, 32, seed=4)
        _, _, _, gen = node.prepare_anypaint(src, None, (32, 64), (0, 16, 32, 48), seam_px=0)
        g = np.asarray(gen) > 0
        self.assertTrue(g[:16].all() and g[48:].all() and not g[16:48].any())

    def test_contract_errors(self):
        src = rgb(32, 32)
        with self.assertRaisesRegex(ValueError, "multiples of 16"):
            node.prepare_anypaint(src, L(np.full((32, 32), 255)), (40, 32))
        with self.assertRaisesRegex(ValueError, "aspect"):
            node.prepare_anypaint(src, None, (64, 32))
        with self.assertRaisesRegex(ValueError, "match either"):
            node.prepare_anypaint(src, L(np.full((16, 16), 255)), (32, 32))
        with self.assertRaisesRegex(ValueError, "no white"):
            node.prepare_anypaint(src, L(np.zeros((32, 32))), (32, 32))
        with self.assertRaisesRegex(ValueError, "outside"):
            node.prepare_anypaint(src, None, (32, 32), (0, 0, 48, 48))

    @unittest.skipIf(cv2 is None, "OpenCV not installed")
    def test_dilation_matches_cv2(self):
        rng = np.random.default_rng(7)
        b = rng.random((40, 56)) > 0.97
        for seam in (1, 3, 8):
            k = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * seam + 1, 2 * seam + 1))
            want = cv2.dilate(np.where(b, 255, 0).astype(np.uint8), k) > 0
            np.testing.assert_array_equal(node._dilate_rect(b, seam), want)

    def test_node_tensors(self):
        src = torch.from_numpy(np.asarray(rgb(32, 32)).astype(np.float32) / 255.0)[None]
        mask = torch.zeros(1, 32, 32)
        mask[0, 8:16, 8:16] = 1.0
        cond, known, keep, gen = node.Krea2AnyPaintPrepare().prepare(src, 32, 32, 0, 0, 0, 0, 2, 16, mask=mask)
        self.assertEqual(tuple(cond.shape), (1, 16, 16, 3))
        torch.testing.assert_close(known, src)  # exact uint8 round trip
        self.assertEqual(float(gen.sum()), 64.0)
        self.assertEqual(float((1 - keep).sum()), 12.0 * 12.0)


class KnownLatentTest(unittest.TestCase):
    def test_token_noise_mask(self):
        keep = torch.ones(1, 32, 32)
        keep[0, 0:9, 0:9] = 0  # latent 0..1 (nearest of 0,8) -> tokens (0,0) generated
        nm = node.known_token_noise_mask(keep, (4, 4))
        self.assertEqual(tuple(nm.shape), (1, 1, 4, 4))
        want = torch.zeros(4, 4)
        want[0:2, 0:2] = 1
        torch.testing.assert_close(nm[0, 0], want)
        keep2 = torch.ones(1, 32, 32)
        keep2[0, 8, 0] = 0  # one latent pixel (1,0) unkept -> whole 2x2 token generated
        torch.testing.assert_close(node.known_token_noise_mask(keep2, (4, 4))[0, 0], want)

    def test_known_latent_node_5d(self):
        class FakeVAE:
            def encode(self, img):
                b, h, w, _ = img.shape
                return torch.ones(b, 16, 1, h // 8, w // 8)

        keep = torch.zeros(1, 32, 48)
        (lat,) = node.Krea2AnyPaintKnownLatent().encode(FakeVAE(), torch.zeros(1, 32, 48, 3), keep)
        self.assertEqual(tuple(lat["samples"].shape), (1, 16, 1, 4, 6))
        self.assertEqual(tuple(lat["noise_mask"].shape), (1, 1, 1, 4, 6))
        self.assertTrue(bool((lat["noise_mask"] == 1).all()))
        # comfy's sampler-side reshape is the identity on this mask
        r = comfy.utils.reshape_mask(lat["noise_mask"], lat["samples"].shape)
        torch.testing.assert_close(r[:, :1], lat["noise_mask"])


class ModelTest(unittest.TestCase):
    def setUp(self):
        self.dm = tiny_dit()
        torch.manual_seed(1)
        self.x = torch.randn(1, 16, 8, 12)       # target grid 4x6
        self.t = torch.tensor([0.7])
        self.ctx = torch.randn(1, 5, 8)
        self.ref = torch.randn(1, 16, 4, 6)      # ref grid 2x3 stretched over the canvas

    def test_full_canvas_rope_ids(self):
        _, pos = node._pack_refs_bbox(self.dm, [self.ref], [node.FULL_CANVAS], (4, 6), 1, "cpu", torch.float32)
        pos = pos.reshape(2, 3, 3)
        self.assertTrue(bool((pos[..., 0] == 1).all()))
        torch.testing.assert_close(pos[:, 0, 1], torch.tensor([0.5, 2.5]))   # (i+.5)*4/2-.5
        torch.testing.assert_close(pos[0, :, 2], torch.tensor([0.5, 2.5, 4.5]))  # (j+.5)*6/3-.5

    def _isolated_joint(self, placements, isolate=True):
        """Independent reference: one joint pass with [txt, img, ref], ref tokens at
        t=0 attending ONLY to ref tokens, txt/img attending to everything."""
        dm, x = self.dm, self.x
        ost = node.ost
        from einops import rearrange
        p = dm.patch
        h_, w_ = x.shape[-2] // p, x.shape[-1] // p
        img = rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=p, pw=p)
        reftok, refpos = node._pack_refs_bbox(dm, [self.ref], placements, (h_, w_), 1, "cpu", x.dtype)
        img = dm.first(torch.cat((img, reftok), 1))
        t = dm.tmlp(ost.timestep_embedding(self.t, dm.tdim).unsqueeze(1))
        tvec = dm.tproj(t)
        tvec0 = dm.tproj(dm.tmlp(ost.timestep_embedding(torch.zeros_like(self.t), dm.tdim).unsqueeze(1)))
        ctx = dm.txtmlp(dm.txtfusion(dm._unpack_context(self.ctx), mask=None))
        L_txt, L_ref = ctx.shape[1], reftok.shape[1]
        comb = torch.cat((ctx, img), 1)
        n = comb.shape[1]
        split = n - L_ref
        ids = torch.zeros(h_, w_, 3)
        ids[..., 1] = torch.arange(h_)[:, None].float()
        ids[..., 2] = torch.arange(w_)[None, :].float()
        pos = torch.cat((torch.zeros(1, L_txt, 3), ids.reshape(1, -1, 3), refpos), 1)
        freqs = dm.pe_embedder(pos)
        mask = torch.zeros(1, 1, n, n)
        if isolate:
            mask[:, :, split:, :split] = float("-inf")
        for blk in dm.blocks:
            mo, r = blk.mod(tvec), blk.mod(tvec0)

            def mod(hh, s, sh):
                return torch.cat(((1 + mo[s]) * hh[:, :split] + mo[sh], (1 + r[s]) * hh[:, split:] + r[sh]), 1)

            def gate(hh, g):
                return torch.cat((mo[g] * hh[:, :split], r[g] * hh[:, split:]), 1)

            comb = comb + gate(blk.attn(mod(blk.prenorm(comb), 0, 1), freqs, mask), 2)
            comb = comb + gate(blk.mlp(mod(blk.postnorm(comb), 3, 4)), 5)
        out = dm.last(comb, t)[:, L_txt:split]
        return rearrange(out, "b (h w) (c ph pw) -> b c (h ph) (w pw)", h=h_, w=w_, ph=p, pw=p, c=dm.channels)

    def _patched_forward(self, placements):
        from unittest import mock

        class FakeBase:
            def extra_conds(self, **kw):
                return {}

            def extra_conds_shapes(self, **kw):
                return {}

            def process_latent_in(self, x):
                return x

        patches = {}

        class FakeModel:
            model = FakeBase()

            def clone(self):
                return self

            def get_model_object(_, name):
                return patches.get(name, self.dm)

            def add_object_patch(self, name, obj):
                patches[name] = obj

        node.Krea2AnyPaintModelPatch().patch(FakeModel())
        fwd = patches["diffusion_model.forward"]
        self.assertIs(node.ost._pack_refs, node._ORIG_PACK)
        with torch.no_grad(), mock.patch.object(node.ost, "_precompute_ref_kv", wraps=node.ost._precompute_ref_kv) as pre:
            a = fwd(self.x, self.t, self.ctx, transformer_options={}, ref_latents=[self.ref],
                    reference_placements=placements)
            b = fwd(self.x, self.t * 0.5, self.ctx, transformer_options={}, ref_latents=[self.ref],
                    reference_placements=placements)
            self.assertEqual(pre.call_count, 1)  # same run, lower sigma -> cached K/V reused
            fwd(self.x, self.t, self.ctx, transformer_options={}, ref_latents=[self.ref],
                reference_placements=placements)
            self.assertEqual(pre.call_count, 2)  # sigma went back up -> new run, cache cleared
        return a, b

    def test_cached_forward_equals_isolated_joint_attention(self):
        with torch.no_grad():
            want = self._isolated_joint([node.FULL_CANVAS])
        got, _ = self._patched_forward([node.FULL_CANVAS])
        torch.testing.assert_close(got, want, atol=1e-4, rtol=1e-4)
        with torch.no_grad():
            leaky = self._isolated_joint([node.FULL_CANVAS], isolate=False)
        self.assertGreater(float((leaky - want).abs().max()), 1e-2)  # isolation actually matters
        with torch.no_grad():
            other = self._isolated_joint([(0.0, 0.0, 0.5, 0.5)])
        self.assertGreater(float((other - want).abs().max()), 1e-2)  # placement actually matters

    def test_pack_restored_and_invalid_bbox(self):
        self._patched_forward([node.FULL_CANVAS])
        self.assertIs(node.ost._pack_refs, node._ORIG_PACK)
        with self.assertRaisesRegex(ValueError, "Invalid normalized"):
            node._pack_refs_bbox(self.dm, [self.ref], [(0.5, 0.0, 0.25, 1.0)], (4, 6), 1, "cpu", torch.float32)
        self.assertIs(node.ost._pack_refs, node._ORIG_PACK)

    def test_missing_placement_defaults_to_full_canvas(self):
        got, _ = self._patched_forward(None)
        want, _ = self._patched_forward([node.FULL_CANVAS])
        torch.testing.assert_close(got, want)


class RegistrationTest(unittest.TestCase):
    def test_mappings(self):
        self.assertEqual(set(node.NODE_CLASS_MAPPINGS), {
            "Krea2AnyPaintPrepare", "TextEncodeKrea2AnyPaint", "Krea2AnyPaintModelPatch", "Krea2AnyPaintKnownLatent"})
        self.assertEqual(set(node.NODE_CLASS_MAPPINGS), set(node.NODE_DISPLAY_NAME_MAPPINGS))


if __name__ == "__main__":
    unittest.main()
