"""Krea 2 color + depth control (darask0/Krea-2-color-depth-control) for ComfyUI.

The adapter replaces the DiT input projection `first` ([6144, 64]) with a wider `img_in`
([6144, 192]) that reads three 64-feature packed latents per token: the noisy latent, the color
region map latent and the depth map latent (zero latent = "no control"). The image columns were
trained too, so the whole new weight + bias is used. The rest of the file is a rank-64 diffusers
LoRA that ComfyUI's core Krea 2 key map already understands; `strength` scales only that LoRA
(img_in is never scaled, as in the reference Hayate implementation).

Per-input end fractions zero a control after that fraction of the sampling steps.

The facok comfyui-krea2-controlnet pack can't load this adapter (it expects a 128-wide single
control projection and only maps `blocks.*` keys), hence this node.
"""

import logging

import torch
import torch.nn as nn
import torch.nn.functional as F

import comfy.ldm.common_dit
import comfy.model_management
import comfy.patcher_extension
import comfy.sd
import comfy.utils
import folder_paths


WRAPPER_KEY = "cj_krea2_dual_control"
IMG_IN_KEYS = ("img_in.weight", "img_in.bias")


def _step_fraction(transformer_options):
    """Fraction of the sampling schedule already done at this model call (0 at the first step).

    None when the sampler didn't expose its schedule (control then stays on for every call).
    """
    sigma = transformer_options.get("sigmas")
    schedule = transformer_options.get("sample_sigmas")
    if not torch.is_tensor(sigma) or sigma.numel() == 0:
        return None
    if not torch.is_tensor(schedule) or schedule.numel() < 2:
        return None
    current = sigma.detach().flatten()[0].to(torch.float32).cpu()
    sched = schedule.detach().flatten().to(torch.float32).cpu()
    steps = int(sched.numel()) - 1
    index = int(torch.argmin((sched[:-1] - current).abs()).item())
    return index / steps


def control_active(end, fraction):
    if end >= 1.0 or fraction is None:
        return True
    return fraction < end - 1e-6


def pack_latent(latent, patch):
    """[B, C, H, W] -> [B, (H/p)(W/p), C*p*p], identical to SingleStreamDiT.process_img."""
    latent = comfy.ldm.common_dit.pad_to_patch_size(latent, (patch, patch))
    b, c, h, w = latent.shape
    latent = latent.reshape(b, c, h // patch, patch, w // patch, patch)
    return latent.permute(0, 2, 4, 1, 3, 5).reshape(b, (h // patch) * (w // patch), c * patch * patch)


def _flatten_temporal(x):
    if x.ndim == 5:
        b, c, t, h, w = x.shape
        return x.permute(0, 2, 1, 3, 4).reshape(b * t, c, h, w)
    return x


class DualControlProjection(nn.Module):
    """Stand-in for `diffusion_model.first` during one forward call.

    The first `n_img` tokens are the noisy image tokens and get the 192-wide projection; any extra
    tokens (reference latents of an edit graph) keep the original projection.
    """

    def __init__(self, weight, bias, original_first, control_tokens, n_img):
        super().__init__()
        # Plain attributes, not Parameters/submodules: this object must not join the model's
        # state dict or the patcher's weight bookkeeping while it is swapped in.
        object.__setattr__(self, "_w", weight)
        object.__setattr__(self, "_b", bias)
        object.__setattr__(self, "_orig", original_first)
        object.__setattr__(self, "_ctrl", control_tokens)
        object.__setattr__(self, "_n", n_img)

    def forward(self, tokens):
        n = self._n
        img = tokens[:, :n]
        ctrl = self._ctrl.to(device=img.device, dtype=img.dtype)
        w = comfy.model_management.cast_to_device(self._w, img.device, img.dtype)
        b = comfy.model_management.cast_to_device(self._b, img.device, img.dtype)
        out = F.linear(torch.cat((img, ctrl), dim=-1), w, b)
        if tokens.shape[1] > n:
            out = torch.cat((out, self._orig(tokens[:, n:])), dim=1)
        return out


class DualControlState:
    def __init__(self, weight, bias, color_latent, depth_latent, color_end, depth_end):
        self.weight = weight
        self.bias = bias
        self.color_latent = color_latent  # processed (model-space) latent or None
        self.depth_latent = depth_latent
        self.color_end = float(color_end)
        self.depth_end = float(depth_end)
        self.image_features = weight.shape[1] // 3

    def control_tokens(self, x, patch, fraction):
        x4 = _flatten_temporal(x)
        b, _, h, w = x4.shape
        feats = self.image_features
        n = ((h + patch - 1) // patch) * ((w + patch - 1) // patch)
        parts = []
        for latent, end in ((self.color_latent, self.color_end), (self.depth_latent, self.depth_end)):
            if latent is None or not control_active(end, fraction):
                parts.append(torch.zeros((b, n, feats), device=x4.device, dtype=x4.dtype))
                continue
            lat = _flatten_temporal(latent).to(device=x4.device, dtype=x4.dtype)
            if lat.shape[-2:] != (h, w):
                lat = comfy.utils.common_upscale(lat, w, h, "bilinear", "disabled")
            lat = comfy.utils.repeat_to_batch_size(lat, b)
            tok = pack_latent(lat, patch)
            if tok.shape[-1] != feats:
                raise RuntimeError(
                    f"Krea2 dual control: control latent packs to {tok.shape[-1]} features, adapter expects "
                    f"{feats}. Encode the control images with the Krea 2 (Qwen-Image/Wan 2.1) VAE."
                )
            parts.append(tok)
        return torch.cat(parts, dim=-1), n


def dual_control_wrapper(state):
    def wrapper(executor, x, timesteps, context, attention_mask=None, ref_latents=None, transformer_options={}, **kwargs):
        dm = executor.class_obj
        original = dm.first
        if isinstance(original, DualControlProjection):  # nested call; never stack
            original = original._orig
        ctrl, n = state.control_tokens(x, dm.patch, _step_fraction(transformer_options))
        dm.first = DualControlProjection(state.weight, state.bias, original, ctrl, n)
        try:
            return executor(x, timesteps, context, attention_mask, ref_latents, transformer_options, **kwargs)
        finally:
            dm.first = original
    return wrapper


def split_adapter(state_dict):
    """-> (img_in weight, img_in bias, LoRA-only state dict)."""
    missing = [k for k in IMG_IN_KEYS if k not in state_dict]
    if missing:
        raise RuntimeError(f"Krea2 dual control: adapter file lacks {missing}; not a color-depth control adapter.")
    weight, bias = state_dict["img_in.weight"], state_dict["img_in.bias"]
    if weight.ndim != 2 or weight.shape[1] % 3 != 0:
        raise RuntimeError(f"Krea2 dual control: img_in.weight shape {tuple(weight.shape)} is not [features, 3*k].")
    lora = {k: v for k, v in state_dict.items() if not k.startswith("img_in.")}
    return weight, bias, lora


def encode_control(vae, image, model_patcher):
    """IMAGE [B,H,W,C] in 0-1 -> processed latent in model space ([B, C, H/8, W/8] or 5D)."""
    latent = vae.encode(image[:, :, :, :3])
    model = model_patcher.model
    try:
        dims = model_patcher.get_model_object("latent_format").latent_dimensions
    except Exception:
        dims = 2
    squeeze = False
    if dims == 3 and latent.ndim == 4:
        latent = latent.unsqueeze(2)
        squeeze = True
    latent = model.process_latent_in(latent)
    if squeeze and latent.ndim == 5 and latent.shape[2] == 1:
        latent = latent[:, :, 0]
    return latent


class Krea2DualControlApply:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "adapter_name": (folder_paths.get_filename_list("loras"),),
                "strength": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.01,
                                       "tooltip": "Scales the adapter's LoRA only; img_in is never scaled."}),
                "color_end": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                        "tooltip": "Zero the color map after this fraction of the steps."}),
                "depth_end": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                        "tooltip": "Zero the depth map after this fraction of the steps."}),
            },
            "optional": {
                "color_image": ("IMAGE", {"tooltip": "Flat-color region map at output size; black = unspecified."}),
                "depth_image": ("IMAGE", {"tooltip": "Relative depth at output size, near = white."}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "CJ/krea2"
    DESCRIPTION = "Krea 2 color-region + depth control adapter (darask0). Text-to-image graphs."

    _cache = None

    def apply(self, model, vae, adapter_name, strength, color_end, depth_end, color_image=None, depth_image=None):
        if model.get_attachment(WRAPPER_KEY) is not None:
            raise RuntimeError("Krea2 dual control is already applied to this MODEL.")
        path = folder_paths.get_full_path_or_raise("loras", adapter_name)
        cache = Krea2DualControlApply._cache
        if cache is None or cache[0] != path:
            sd = comfy.utils.load_torch_file(path, safe_load=True)
            Krea2DualControlApply._cache = cache = (path, split_adapter(sd))
        weight, bias, lora = cache[1]

        first = getattr(model.model.diffusion_model, "first", None)
        expected = weight.shape[1] // 3
        if first is None or getattr(first, "in_features", expected) != expected or first.out_features != weight.shape[0]:
            raise RuntimeError("Krea2 dual control needs a Krea 2 model (input projection shape mismatch).")

        if strength != 0 and lora:
            patched, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0)
        else:
            patched = model.clone()

        color = encode_control(vae, color_image, patched) if color_image is not None else None
        depth = encode_control(vae, depth_image, patched) if depth_image is not None else None
        state = DualControlState(weight, bias, color, depth, color_end, depth_end)
        patched.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, WRAPPER_KEY,
                                     dual_control_wrapper(state))
        patched.set_attachments(WRAPPER_KEY, {"adapter": adapter_name, "color": color is not None,
                                              "depth": depth is not None})
        logging.info("Krea2 dual control: %s strength=%s color=%s depth=%s ends=(%s, %s)", adapter_name, strength,
                     color is not None, depth is not None, color_end, depth_end)
        return (patched,)


NODE_CLASS_MAPPINGS = {"Krea2DualControlApply": Krea2DualControlApply}
NODE_DISPLAY_NAME_MAPPINGS = {"Krea2DualControlApply": "Krea 2 Color+Depth Control (CJ)"}
