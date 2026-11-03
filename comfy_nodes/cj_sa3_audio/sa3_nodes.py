"""Stable Audio 3 inpaint / continuation for ComfyUI core's StableAudio3 model.

SA3 medium carries native inpaint conditioning (local_add_cond = [mask, masked latent]).
ComfyUI core's StableAudio3.concat_cond reads `concat_latent_image` + `concat_mask`
from the conditioning (mask 1 = regenerate; core inverts it to SA3's 1 = keep),
but core ships no node that sets them for audio. This does, mirroring
stable_audio_3/model.py: masked input = source latent * keep_mask, sampled from
full noise (no latent blending), so the model itself stitches the seams.
"""
import math

import torch

import comfy.audio
import node_helpers

from .regions import frame_span, keep_spans, parse_regions

HOP = 4096  # SA3 pretransform temporal downscale (latent_formats.StableAudio3)


def _vae_rate(vae):
    return int(getattr(vae, "audio_sample_rate", 44100))


class CJSA3InpaintConditioning:
    CATEGORY = "adrift/audio"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "build"
    DESCRIPTION = (
        "Stable Audio 3 inpaint/continuation. Regions are start-end seconds to regenerate "
        "('4-8; 14-18'). Set total_seconds past the source length to continue it; the tail "
        "is generated. Feed latent to KSampler at denoise 1.0."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE",),
                "audio": ("AUDIO",),
                "regions": ("STRING", {"default": "", "multiline": False}),
                "total_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 384.0, "step": 0.1,
                                             "tooltip": "0 = source length. Longer = continuation."}),
            }
        }

    def build(self, positive, negative, vae, audio, regions, total_seconds):
        if audio is None:
            raise ValueError("SA3 inpaint: no input audio")
        sr = _vae_rate(vae)
        wav = audio["waveform"]
        if audio["sample_rate"] != sr:
            wav = comfy.audio.resample(wav, audio["sample_rate"], sr)
        src_seconds = wav.shape[-1] / sr
        latent = vae.encode(wav.movedim(1, -1))[:1]  # [1, C, T_src]
        rate = sr / HOP
        total = max(float(total_seconds), src_seconds)
        n = max(latent.shape[-1], int(math.ceil(total * rate)))
        if n > latent.shape[-1]:
            latent = torch.nn.functional.pad(latent, (0, n - latent.shape[-1]))
        keep = torch.zeros((1, 1, n), dtype=latent.dtype)
        keep[..., : min(n, int(math.floor(src_seconds * rate)))] = 1.0
        spans = parse_regions(regions)
        for a, b in spans:
            lo, hi = frame_span(a, b, rate, n)
            keep[..., lo:hi] = 0.0
        if not spans and total <= src_seconds + 1e-6:
            raise ValueError("SA3 inpaint: give regions to regenerate or a total_seconds longer than the source")
        masked = latent * keep.to(latent.device)
        values = {"concat_latent_image": masked.cpu(), "concat_mask": (1.0 - keep).cpu()}
        positive = node_helpers.conditioning_set_values(positive, values)
        negative = node_helpers.conditioning_set_values(negative, values)
        empty = torch.zeros((1, latent.shape[1], n), dtype=torch.float32)
        return (positive, negative, {"samples": empty, "type": "audio"})


class CJAudioPasteback:
    """Keep the source audio bit-exact outside the regenerated regions (equal-power crossfades)."""

    CATEGORY = "adrift/audio"
    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "paste"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source": ("AUDIO",),
                "generated": ("AUDIO",),
                "regions": ("STRING", {"default": ""}),
                "crossfade_ms": ("INT", {"default": 60, "min": 0, "max": 2000}),
            }
        }

    def paste(self, source, generated, regions, crossfade_ms):
        sr = int(generated["sample_rate"])
        gen = generated["waveform"][:1].clone()
        src = source["waveform"][:1]
        if int(source["sample_rate"]) != sr:
            src = comfy.audio.resample(src, int(source["sample_rate"]), sr)
        if src.shape[1] != gen.shape[1]:
            src = src.mean(1, keepdim=True).expand(-1, gen.shape[1], -1)
        n_src = min(src.shape[-1], gen.shape[-1])
        src_s, total_s = n_src / sr, gen.shape[-1] / sr
        fade = int(sr * crossfade_ms / 1000)
        w = torch.zeros(gen.shape[-1])  # 1 = source
        for a, b in keep_spans(parse_regions(regions), src_s, total_s):
            lo, hi = int(round(a * sr)), min(n_src, int(round(b * sr)))
            w[lo:hi] = 1.0
            if fade:
                f = min(fade, (hi - lo) // 2)
                if f > 0:
                    ramp = torch.linspace(0, 1, f)
                    if lo > 0:
                        w[lo:lo + f] = ramp
                    if hi < gen.shape[-1]:
                        w[hi - f:hi] = ramp.flip(0)
        a = torch.sqrt(w)  # equal-power
        g = torch.sqrt(1.0 - w)
        out = gen.clone()
        out[..., :n_src] = src[..., :n_src] * a[:n_src] + gen[..., :n_src] * g[:n_src]
        return ({"waveform": out, "sample_rate": sr},)


NODE_CLASS_MAPPINGS = {
    "CJSA3InpaintConditioning": CJSA3InpaintConditioning,
    "CJAudioPasteback": CJAudioPasteback,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CJSA3InpaintConditioning": "SA3 Inpaint / Continue (Adrift)",
    "CJAudioPasteback": "Audio Pasteback (Adrift)",
}
