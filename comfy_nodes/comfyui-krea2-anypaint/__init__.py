"""ComfyUI-Krea2-AnyPaint: arbitrary-mask inpaint/outpaint for the krea2-anypaint
LoRA (yijunwang2/krea2-anypaint, rank 32, Krea 2 Turbo, 8 steps, cfg 1).

Reimplements the model card's contract (anypaint.py + pipeline.py, Apache-2.0,
read as reference only; see NOTICE) on ComfyUI's native Krea 2 model. The
model patch is the installed ComfyUI-Krea2-Ostris-Edit patch (kv_cache=True)
with bbox-registered reference RoPE ids; no Ostris code is copied.

  Krea2AnyPaintPrepare      source + mask + canvas/bbox -> condition (<=384 edge,
                            /16), known image, keep mask, generated mask
                            (= anypaint.prepare_anypaint, pure torch/PIL).
  TextEncodeKrea2AnyPaint   prompt + condition through Qwen3-VL ("Picture 1:"
                            vision tokens, encode_reference_in_prompt=True) and
                            the condition as a VAE reference latent registered at
                            bbox_normalized [0, 0, 1, 1] (the full canvas).
  Krea2AnyPaintModelPatch   isolated reference attention (kv_cache=True): the ref
                            tokens run alone through the blocks once at t=0 with
                            bbox-registered RoPE ids, every denoising step appends
                            their cached post-RoPE K/V as extra keys.
  Krea2AnyPaintKnownLatent  VAE-encoded known image + a token-level noise_mask
                            (keep mask NEAREST to latent res, a 2x2 patch is known
                            only if all of it is kept).

Known-token restoration: the pipeline replaces known tokens after every Euler
step with known + next_sigma * (initial_noise - known). ComfyUI's native
noise_mask inpainting (KSamplerX0Inpaint + CONST noise_scaling) writes
sigma * noise + (1 - sigma) * known into the known region before each model
call and the known latent into the denoised output, which for Euler is the same
trajectory (and exact known tokens at sigma 0). So a stock KSampler with this
latent (euler / simple, 8 steps, cfg 1, denoise 1) is the pipeline's loop. The
pipeline does not composite pixels afterwards; neither does this pack.
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import threading

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import comfy.conds
import node_helpers

REFERENCE_MAX_EDGE = 384
SEAM_PX = 32
FULL_CANVAS = (0.0, 0.0, 1.0, 1.0)


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
    raise ImportError("comfyui-krea2-anypaint needs ComfyUI-Krea2-Ostris-Edit installed in custom_nodes")


# Private instance of the Ostris edit module: we reuse its Qwen3-VL encode and
# model patch, and patching its _pack_refs never touches the nodes ComfyUI loaded.
_spec = importlib.util.spec_from_file_location("krea2_ostris_edit_anypaint", _find_ostris())
ost = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ost)


# Preparation (anypaint.prepare_anypaint)


def _to_u8(image_hwc: torch.Tensor) -> np.ndarray:
    return (image_hwc[..., :3].detach().float().clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)


def _mask_to_l(mask_hw: torch.Tensor) -> Image.Image:
    arr = (mask_hw.detach().float().clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
    return Image.fromarray(arr, mode="L")


def _median_color(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return np.array([127, 127, 127], dtype=np.uint8)
    return np.median(values.reshape(-1, 3), axis=0).round().astype(np.uint8)


def _resize_max_edge(image: Image.Image, max_edge: int) -> Image.Image:
    scale = min(1.0, max_edge / max(image.size))
    size = (
        max(16, int(round(image.width * scale)) // 16 * 16),
        max(16, int(round(image.height * scale)) // 16 * 16),
    )
    return image.resize(size, Image.Resampling.LANCZOS)


def _dilate_rect(binary: np.ndarray, seam_px: int) -> np.ndarray:
    """cv2.dilate with a (2*seam+1)^2 MORPH_RECT kernel, default border (outside
    pixels never contribute), as a separable max filter."""
    if seam_px <= 0:
        return binary
    k = 2 * seam_px + 1
    t = torch.from_numpy(binary.astype(np.float32))[None, None]
    t = F.max_pool2d(t, kernel_size=(1, k), stride=1, padding=(0, seam_px))
    t = F.max_pool2d(t, kernel_size=(k, 1), stride=1, padding=(seam_px, 0))
    return t[0, 0].numpy() > 0


def prepare_anypaint(source: Image.Image, generated_mask: Image.Image | None, canvas_size, source_bbox=None,
                     reference_max_edge: int = REFERENCE_MAX_EDGE, seam_px: int = SEAM_PX):
    """Returns (condition, known_image, keep_mask, generated_mask) PIL images.
    White mask pixels are generated, black are preserved; everything outside
    source_bbox is generated. generated_mask=None means "nothing inside the bbox"
    (pure outpaint)."""
    width, height = canvas_size
    if width < 16 or height < 16 or width % 16 or height % 16:
        raise ValueError("Canvas dimensions must be positive multiples of 16")
    source = source.convert("RGB")
    if source_bbox is None:
        source_bbox = (0, 0, width, height)
    x0, y0, x1, y1 = source_bbox
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError(f"Source bbox is outside the canvas: {source_bbox}")

    box_width, box_height = x1 - x0, y1 - y0
    source_ratio = source.width / source.height
    box_ratio = box_width / box_height
    tolerance = max(0.025, 2.0 / min(box_width, box_height))
    if abs(box_ratio / source_ratio - 1.0) > tolerance:
        raise ValueError("Source bbox must preserve the source image aspect ratio")

    placed = source.resize((box_width, box_height), Image.Resampling.LANCZOS)
    placed_values = np.asarray(placed, dtype=np.uint8)
    fill = _median_color(placed_values)
    known_values = np.empty((height, width, 3), dtype=np.uint8)
    known_values[:] = fill
    known_values[y0:y1, x0:x1] = placed_values
    known_image = Image.fromarray(known_values, mode="RGB")

    if generated_mask is None:
        generated_mask = Image.new("L", source.size, 0)
    mask = generated_mask.convert("L")
    if mask.size == source.size:
        mask = mask.resize((box_width, box_height), Image.Resampling.NEAREST)
        canvas_mask = Image.new("L", (width, height), 255)
        canvas_mask.paste(mask, (x0, y0))
        mask = canvas_mask
    elif mask.size != (width, height):
        raise ValueError("Mask must match either the source image or the output canvas")
    mask = mask.point(lambda value: 255 if value > 127 else 0)

    outside = Image.new("L", (width, height), 255)
    outside.paste(0, tuple(source_bbox))
    generated_values = np.maximum(np.asarray(mask, dtype=np.uint8), np.asarray(outside, dtype=np.uint8)) > 0
    if not generated_values.any():
        raise ValueError("The generated mask has no white pixels")

    condition_values = known_values.copy()
    condition_values[generated_values] = _median_color(condition_values[~generated_values])
    condition = _resize_max_edge(Image.fromarray(condition_values, mode="RGB"), reference_max_edge)

    keep = ~_dilate_rect(generated_values, seam_px)
    keep_mask = Image.fromarray(np.where(keep, 255, 0).astype(np.uint8), mode="L")
    generated = Image.fromarray(np.where(generated_values, 255, 0).astype(np.uint8), mode="L")
    return condition, known_image, keep_mask, generated


def _img_t(img: Image.Image) -> torch.Tensor:
    return torch.from_numpy(np.asarray(img.convert("RGB")).astype(np.float32) / 255.0)


def _mask_t(img: Image.Image) -> torch.Tensor:
    return torch.from_numpy((np.asarray(img, dtype=np.uint8) > 127).astype(np.float32))


class Krea2AnyPaintPrepare:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source": ("IMAGE",),
                "canvas_width": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 16}),
                "canvas_height": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 16}),
                "bbox_x0": ("INT", {"default": 0, "min": 0, "max": 8192}),
                "bbox_y0": ("INT", {"default": 0, "min": 0, "max": 8192}),
                "bbox_x1": ("INT", {"default": 0, "min": 0, "max": 8192, "tooltip": "x1 = y1 = 0: source fills the canvas"}),
                "bbox_y1": ("INT", {"default": 0, "min": 0, "max": 8192}),
                "seam_px": ("INT", {"default": SEAM_PX, "min": 0, "max": 256}),
                "reference_max_edge": ("INT", {"default": REFERENCE_MAX_EDGE, "min": 16, "max": 2048, "step": 16}),
            },
            "optional": {
                "mask": ("MASK", {"tooltip": "White = generate. Source-sized (placed into the bbox) or canvas-sized."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "MASK")
    RETURN_NAMES = ("condition", "known", "keep_mask", "generated_mask")
    FUNCTION = "prepare"
    CATEGORY = "ostris/krea2"
    DESCRIPTION = "AnyPaint canvas prep: condition image, known image, keep mask (32 px redraw band) and generated mask."

    def prepare(self, source, canvas_width, canvas_height, bbox_x0, bbox_y0, bbox_x1, bbox_y1,
                seam_px=SEAM_PX, reference_max_edge=REFERENCE_MAX_EDGE, mask=None):
        bbox = None if (bbox_x1 == 0 and bbox_y1 == 0) else (bbox_x0, bbox_y0, bbox_x1, bbox_y1)
        outs = [[], [], [], []]
        for i in range(source.shape[0]):
            src = Image.fromarray(_to_u8(source[i]), mode="RGB")
            m = None
            if mask is not None:
                mm = mask if mask.ndim == 3 else mask.unsqueeze(0)
                m = _mask_to_l(mm[min(i, mm.shape[0] - 1)])
            cond, known, keep, gen = prepare_anypaint(src, m, (canvas_width, canvas_height), bbox,
                                                      reference_max_edge=reference_max_edge, seam_px=seam_px)
            outs[0].append(_img_t(cond))
            outs[1].append(_img_t(known))
            outs[2].append(_mask_t(keep))
            outs[3].append(_mask_t(gen))
        return tuple(torch.stack(o) for o in outs)


# Text encode


class TextEncodeKrea2AnyPaint:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "condition": ("IMAGE",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "ostris/krea2"
    DESCRIPTION = "Prompt + AnyPaint condition image (VL tokens + reference latent at the full-canvas placement)."

    def encode(self, clip, vae, condition, prompt):
        (cond,) = ost.TextEncodeKrea2OstrisEdit().encode(clip, prompt, vae=vae, image1=condition)
        cond = node_helpers.conditioning_set_values(cond, {"reference_placements": [FULL_CANVAS]}, append=True)
        return (cond,)


# Model patch: bbox-registered refs + isolated (cached) reference attention
# No Ostris code is copied here. The patch is the installed Ostris
# Krea2OstrisEditModelPatch with kv_cache=True (one t=0 ref-only pass, cached
# post-RoPE K/V appended every step = isolated reference attention). The only
# change is the reference RoPE ids: while our forward runs, the private Ostris
# module's `_pack_refs` is swapped for a wrapper that rewrites the y/x ids it
# returns so each reference grid spans its canvas bbox.

_ORIG_PACK = ost._pack_refs
_PACK_LOCK = threading.Lock()


def _target_grid(x, patch):
    return -(-x.shape[-2] // patch), -(-x.shape[-1] // patch)


def _place_refs_bbox(refpos, ref_latents, placements, target_hw, patch):
    """Rewrite the y/x RoPE ids of an Ostris (B, Lr, 3) refpos so reference i's
    token grid is stretched across its normalized canvas bbox on the target grid
    (missing placement = FULL_CANVAS); the frame axis (i+1) is untouched:
        ys = y0*Th + (arange(rh)+0.5)*((y1-y0)*Th/rh) - 0.5   (xs likewise)."""
    th, tw = target_hw
    refpos = refpos.clone()
    dev = refpos.device
    start = 0
    for i, ref in enumerate(ref_latents):
        rh, rw = -(-ref.shape[-2] // patch), -(-ref.shape[-1] // patch)
        n = rh * rw
        pl = placements[i] if (placements is not None and i < len(placements) and placements[i] is not None) else FULL_CANVAS
        x0, y0, x1, y1 = (float(v) for v in pl)
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            raise ValueError(f"Invalid normalized reference bbox: {pl}")
        ys = y0 * th + (torch.arange(rh, device=dev, dtype=torch.float32) + 0.5) * ((y1 - y0) * th / rh) - 0.5
        xs = x0 * tw + (torch.arange(rw, device=dev, dtype=torch.float32) + 0.5) * ((x1 - x0) * tw / rw) - 0.5
        # tokens are row-major (h w): y varies slowest
        refpos[:, start:start + n, 1] = ys.repeat_interleave(rw).to(refpos.dtype)
        refpos[:, start:start + n, 2] = xs.repeat(rh).to(refpos.dtype)
        start += n
    if start != refpos.shape[1]:
        raise RuntimeError(f"krea2-anypaint: reference token count mismatch ({start} != {refpos.shape[1]})")
    return refpos


def _pack_refs_bbox(dit, ref_latents, placements, target_hw, bs, device, dtype):
    """Ostris `_pack_refs` tokens, bbox-registered positions."""
    tok, pos = _ORIG_PACK(dit, ref_latents, bs, device, dtype)
    return tok, _place_refs_bbox(pos, ref_latents, placements, target_hw, dit.patch)


@contextlib.contextmanager
def _bbox_packing(placements, target_hw):
    def pack(dit, refs, bs, device, dtype):
        return _pack_refs_bbox(dit, refs, placements, target_hw, bs, device, dtype)

    with _PACK_LOCK:
        ost._pack_refs = pack
        try:
            yield
        finally:
            ost._pack_refs = _ORIG_PACK


class Krea2AnyPaintModelPatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "ostris/krea2"
    DESCRIPTION = ("AnyPaint reference conditioning: full-canvas registered ref RoPE + isolated reference "
                   "attention via a per-run K/V cache. Chain conditioning from TextEncodeKrea2AnyPaint.")

    def patch(self, model):
        dit = model.get_model_object("diffusion_model")
        (m,) = ost.Krea2OstrisEditModelPatch().patch(model, kv_cache=True)
        ost_extra_conds = m.get_model_object("extra_conds")
        ost_forward = m.get_model_object("diffusion_model.forward")

        def extra_conds(**kwargs):
            out = ost_extra_conds(**kwargs)
            placements = kwargs.get("reference_placements", None)
            if placements is not None:
                out["reference_placements"] = comfy.conds.CONDConstant(placements)
            return out

        # The Ostris K/V cache is keyed on ref content + batch and cleared at
        # every new sampling run; placements and the target grid are fixed
        # within a run (TextEncodeKrea2AnyPaint always registers FULL_CANVAS).
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


# Known latent + token-level noise mask


def known_token_noise_mask(keep_mask: torch.Tensor, latent_hw, patch: int = 2) -> torch.Tensor:
    """(B,H,W) keep mask (1 = keep) -> (B,1,h,w) noise mask (1 = generate) at
    latent res. Nearest downsample, then a patch x patch token is known only if
    every latent pixel in it is kept (pipeline: amin > 0.5)."""
    km = keep_mask if keep_mask.ndim == 3 else keep_mask.unsqueeze(0)
    lh, lw = latent_hw
    if lh % patch or lw % patch:
        raise ValueError(f"latent {lh}x{lw} is not a multiple of the patch size {patch}")
    km = F.interpolate(km[:, None].float(), size=(lh, lw), mode="nearest")
    b = km.shape[0]
    tok = km.view(b, 1, lh // patch, patch, lw // patch, patch).amin(dim=(3, 5)) > 0.5
    known = tok.repeat_interleave(patch, dim=2).repeat_interleave(patch, dim=3)
    return 1.0 - known.float()


class Krea2AnyPaintKnownLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"vae": ("VAE",), "known": ("IMAGE",), "keep_mask": ("MASK",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "encode"
    CATEGORY = "ostris/krea2"
    DESCRIPTION = "VAE-encode the AnyPaint known image and attach the token-level noise mask (denoise 1.0)."

    def encode(self, vae, known, keep_mask):
        samples = vae.encode(known[:, :, :, :3])
        H, W = known.shape[1], known.shape[2]
        lh, lw = samples.shape[-2], samples.shape[-1]
        if lh * 8 != H or lw * 8 != W:
            raise ValueError(f"expected an f8 VAE latent for {W}x{H}, got {lw}x{lh}")
        noise = known_token_noise_mask(keep_mask, (lh, lw))
        if samples.ndim == 5:
            noise = noise.unsqueeze(2)
        return ({"samples": samples, "noise_mask": noise},)


NODE_CLASS_MAPPINGS = {
    "Krea2AnyPaintPrepare": Krea2AnyPaintPrepare,
    "TextEncodeKrea2AnyPaint": TextEncodeKrea2AnyPaint,
    "Krea2AnyPaintModelPatch": Krea2AnyPaintModelPatch,
    "Krea2AnyPaintKnownLatent": Krea2AnyPaintKnownLatent,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "Krea2AnyPaintPrepare": "Krea 2 AnyPaint Prepare",
    "TextEncodeKrea2AnyPaint": "Text Encode Krea 2 AnyPaint",
    "Krea2AnyPaintModelPatch": "Krea 2 AnyPaint Model Patch",
    "Krea2AnyPaintKnownLatent": "Krea 2 AnyPaint Known Latent",
}
