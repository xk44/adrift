"""CJRepeatAudio: play a clip several times in a row before diarizing it.

VibeVoice-ASR sometimes merges two people on a short clip. Given the same speech more than once it
often tells them apart, while a clip it already splits can get worse, so the caller only repeats
after a one-speaker result. Every copy starts a fixed period apart, so timestamps map back.
"""
import torch


def repeat_waveform(waveform, sample_rate, times, gap_seconds, copy_seconds):
    """[B, C, N] waveform -> `times` copies, each padded or cut to copy_seconds, gap_seconds apart."""
    if times <= 1:
        return waveform
    copy_len = round(copy_seconds * sample_rate)
    gap_len = round(gap_seconds * sample_rate)
    copy = waveform[..., :copy_len]
    silence = waveform.new_zeros(*waveform.shape[:-1], copy_len - copy.shape[-1] + gap_len)
    period = torch.cat([copy, silence], dim=-1)
    return torch.cat([period] * (times - 1) + [period[..., :copy_len]], dim=-1)


class CJRepeatAudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "times": ("INT", {"default": 1, "min": 1, "max": 8, "tooltip": "1 passes the audio through."}),
            "gap_seconds": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1}),
            "copy_seconds": ("FLOAT", {"default": 30.0, "min": 0.1, "max": 3600.0, "step": 0.01,
                                       "tooltip": "Each copy is padded or cut to this length."}),
        }}

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "run"
    CATEGORY = "cj_h3_tools/audio"

    def run(self, audio, times, gap_seconds, copy_seconds):
        wave = repeat_waveform(audio["waveform"], audio["sample_rate"], times, gap_seconds, copy_seconds)
        return ({**audio, "waveform": wave},)


NODE_CLASS_MAPPINGS = {"CJRepeatAudio": CJRepeatAudio}
NODE_DISPLAY_NAME_MAPPINGS = {"CJRepeatAudio": "Repeat Audio (CJ)"}
