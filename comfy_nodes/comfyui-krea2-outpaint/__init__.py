"""comfyui-krea2-outpaint: spatial (bbox-placed) reference conditioning for the
krea2-outpaint LoRA (yijunwang2/krea2-outpaint). Part of Adrift (MIT).

The stock Krea 2 Ostris edit node gives each reference token grid RoPE ids at the
grid ORIGIN on frame i+1 ("Kontext index" placement). The outpaint LoRA was
trained with the reference registered at an arbitrary CANVAS BBOX: its pipeline
stretches the reference's token grid across the bbox region of the target grid.
Without that, the source lands top-left and the model invents a new scene.

This pack does not copy the Ostris forward. It calls the installed
ComfyUI-Krea2-Ostris-Edit `_forward_with_refs` unchanged and only rewrites the
reference POSITION ids its `_pack_refs` returns, for references that carry a
placement:
    ys = y0*Th + (arange(rh)+0.5)*((y1-y0)*Th/rh) - 0.5
    xs = x0*Tw + (arange(rw)+0.5)*((x1-x0)*Tw/rw) - 0.5
    frame axis stays i+1
Pair the generated canvas with Krea2OutpaintComposite (multiband blend of the
original source, seam_blend.py) for a seamless result.

Requires ComfyUI-Krea2-Ostris-Edit in custom_nodes (install it from upstream).
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import threading

import numpy as np
import torch
import comfy.conds
import node_helpers


def _find_ostris():
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(os.path.dirname(__file__), "..", "ComfyUI-Krea2-Ostris-Edit", "nodes.py")]
    try:
        import folder_paths

        for d in folder_paths.get_folder_paths("custom_nodes"):
            candidates.append(os.path.join(d, "ComfyUI-Krea2-Ostris-Edit", "nodes.py"))
    except Exception:
        pass
    candidates.append(os.path.join(here, "..", "ComfyUI-Krea2-Ostris-Edit", "nodes.py"))
    for c in candidates:
        if os.path.isfile(c):
            return c
    raise ImportError("comfyui-krea2-outpaint needs ComfyUI-Krea2-Ostris-Edit installed in custom_nodes")


# A private instance of the Ostris module: patching its _pack_refs below never
# affects the Ostris nodes ComfyUI itself loaded.
_spec = importlib.util.spec_from_file_location("krea2_ostris_edit_outpaint", _find_ostris())
ost = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ost)

_ORIG_PACK = ost._pack_refs
_PACK_LOCK = threading.Lock()


def _ref_grid(ref, patch):
    """Token grid (rh, rw) of one reference latent after padding to the patch size."""
    return -(-ref.shape[-2] // patch), -(-ref.shape[-1] // patch)


def _place_refs_bbox(refpos, ref_latents, placements, target_hw, patch):
    """Rewrite y/x RoPE ids of each placed reference so its grid spans its canvas
    bbox (placements[i] = normalized (x0, y0, x1, y1)); None keeps index placement.
    refpos: (B, Lr, 3) as returned by the Ostris _pack_refs, refs in order."""
    if not placements:
        return refpos
    th, tw = target_hw
    refpos = refpos.clone()
    start = 0
    for i, ref in enumerate(ref_latents):
        rh, rw = _ref_grid(ref, patch)
        n = rh * rw
        pl = placements[i] if i < len(placements) else None
        if pl is not None:
            x0, y0, x1, y1 = (float(v) for v in pl)
            dev = refpos.device
            ys = y0 * th + (torch.arange(rh, device=dev, dtype=torch.float32) + 0.5) * ((y1 - y0) * th / rh) - 0.5
            xs = x0 * tw + (torch.arange(rw, device=dev, dtype=torch.float32) + 0.5) * ((x1 - x0) * tw / rw) - 0.5
            # tokens are row-major (h w): y varies slowest
            refpos[:, start:start + n, 1] = ys.repeat_interleave(rw).to(refpos.dtype)
            refpos[:, start:start + n, 2] = xs.repeat(rh).to(refpos.dtype)
        start += n
    if start != refpos.shape[1]:
        raise RuntimeError(f"krea2-outpaint: reference token count mismatch ({start} != {refpos.shape[1]})")
    return refpos


@contextlib.contextmanager
def _bbox_packing(placements, target_hw):
    """Swap the private Ostris module's _pack_refs for one whose positions are
    bbox-placed, for the duration of one forward."""
    def pack(d, refs, bs, device, dtype):
        tok, pos = _ORIG_PACK(d, refs, bs, device, dtype)
        return tok, _place_refs_bbox(pos, refs, placements, target_hw, d.patch)

    with _PACK_LOCK:
        ost._pack_refs = pack
        try:
            yield
        finally:
            ost._pack_refs = _ORIG_PACK


def _target_grid(x, patch):
    return -(-x.shape[-2] // patch), -(-x.shape[-1] // patch)


def _forward_with_refs_bbox(dit, x, timesteps, context, ref_latents, placements, transformer_options):
    """Ostris `_forward_with_refs`, with bbox-placed reference RoPE ids."""
    with _bbox_packing(placements, _target_grid(x, dit.patch)):
        return ost._forward_with_refs(dit, x, timesteps, context, ref_latents, transformer_options)


class TextEncodeKrea2Outpaint:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "image": ("IMAGE",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "canvas_width": ("INT", {"default": 768, "min": 16, "max": 4096, "step": 16}),
                "canvas_height": ("INT", {"default": 768, "min": 16, "max": 4096, "step": 16}),
                "bbox_x0": ("INT", {"default": 128, "min": 0, "max": 4096, "step": 8}),
                "bbox_y0": ("INT", {"default": 128, "min": 0, "max": 4096, "step": 8}),
                "bbox_x1": ("INT", {"default": 640, "min": 0, "max": 4096, "step": 8}),
                "bbox_y1": ("INT", {"default": 640, "min": 0, "max": 4096, "step": 8}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "ostris/krea2"
    DESCRIPTION = "Encode prompt + a source image registered at a canvas bbox for the krea2-outpaint LoRA."

    def encode(self, clip, vae, image, prompt, canvas_width, canvas_height, bbox_x0, bbox_y0, bbox_x1, bbox_y1):
        # reuse the Ostris encode to get conditioning + reference_latents
        (cond,) = ost.TextEncodeKrea2OstrisEdit().encode(clip, prompt, vae=vae, image1=image)
        placement = (bbox_x0 / canvas_width, bbox_y0 / canvas_height, bbox_x1 / canvas_width, bbox_y1 / canvas_height)
        cond = node_helpers.conditioning_set_values(cond, {"reference_placements": [placement]}, append=True)
        return (cond,)


class Krea2OutpaintModelPatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "ostris/krea2"
    DESCRIPTION = "Enable bbox-placed reference conditioning for the krea2-outpaint LoRA. Chain conditioning from TextEncodeKrea2Outpaint."

    def patch(self, model):
        # The installed Ostris patch (joint pass, no K/V cache) does the
        # ref_latents wiring; we add placements and bbox RoPE ids on top.
        dit = model.get_model_object("diffusion_model")
        (m,) = ost.Krea2OstrisEditModelPatch().patch(model, kv_cache=False)
        ost_extra_conds = m.get_model_object("extra_conds")
        ost_forward = m.get_model_object("diffusion_model.forward")

        def extra_conds(**kwargs):
            out = ost_extra_conds(**kwargs)
            placements = kwargs.get("reference_placements", None)
            if placements is not None:
                out["reference_placements"] = comfy.conds.CONDConstant(placements)
            return out

        def forward(x, timesteps, context, attention_mask=None, transformer_options={}, ref_latents=None,
                    reference_placements=None, **kwargs):
            if ref_latents is None or len(ref_latents) == 0:
                return ost_forward(x, timesteps, context, attention_mask=attention_mask,
                                   transformer_options=transformer_options, **kwargs)
            with _bbox_packing(reference_placements, _target_grid(x, dit.patch)):
                return ost_forward(x, timesteps, context, attention_mask=attention_mask,
                                   transformer_options=transformer_options, ref_latents=ref_latents, **kwargs)

        m.add_object_patch("extra_conds", extra_conds)
        m.add_object_patch("diffusion_model.forward", forward)
        return (m,)


class Krea2OutpaintComposite:
    """Composite the ORIGINAL source back into the generated canvas at its bbox,
    using multiband (Laplacian-pyramid) blending so the tone seam vanishes while
    the source interior stays verbatim. Pure-numpy (see seam_blend.py)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "generated": ("IMAGE",),
                "source": ("IMAGE",),
                "canvas_width": ("INT", {"default": 768, "min": 16, "max": 4096, "step": 16}),
                "canvas_height": ("INT", {"default": 768, "min": 16, "max": 4096, "step": 16}),
                "bbox_x0": ("INT", {"default": 128, "min": 0, "max": 4096, "step": 8}),
                "bbox_y0": ("INT", {"default": 128, "min": 0, "max": 4096, "step": 8}),
                "bbox_x1": ("INT", {"default": 640, "min": 0, "max": 4096, "step": 8}),
                "bbox_y1": ("INT", {"default": 640, "min": 0, "max": 4096, "step": 8}),
                "interior_verbatim": ("INT", {"default": 24, "min": 0, "max": 256, "step": 4}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "composite"
    CATEGORY = "ostris/krea2"
    DESCRIPTION = "Multiband-blend the original source back into the outpainted canvas at its bbox (seamless)."

    def composite(self, generated, source, canvas_width, canvas_height, bbox_x0, bbox_y0, bbox_x1, bbox_y1, interior_verbatim):
        from PIL import Image
        from . import seam_blend

        def to_pil(t):
            arr = (t[0].clamp(0, 1).cpu().numpy() * 255).astype("uint8")
            return Image.fromarray(arr)

        gen_pil = to_pil(generated)
        src_pil = to_pil(source)
        # the generated canvas may be padded to a patch multiple; use its real size
        cw, ch = gen_pil.size
        bx0 = min(bbox_x0, cw); by0 = min(bbox_y0, ch)
        bx1 = min(bbox_x1, cw); by1 = min(bbox_y1, ch)
        out_pil = seam_blend.multiband_composite(gen_pil, src_pil, (bx0, by0, bx1, by1), interior_verbatim=interior_verbatim)
        out = torch.from_numpy(np.asarray(out_pil).astype("float32") / 255.0).unsqueeze(0)
        return (out,)


NODE_CLASS_MAPPINGS = {
    "TextEncodeKrea2Outpaint": TextEncodeKrea2Outpaint,
    "Krea2OutpaintModelPatch": Krea2OutpaintModelPatch,
    "Krea2OutpaintComposite": Krea2OutpaintComposite,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "TextEncodeKrea2Outpaint": "Text Encode Krea 2 Outpaint (bbox)",
    "Krea2OutpaintModelPatch": "Krea 2 Outpaint Model Patch (bbox)",
    "Krea2OutpaintComposite": "Krea 2 Outpaint Composite (seamless)",
}
