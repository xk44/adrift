"""Timing of cj_repeat_audio. Run: python tests/test_repeat_audio.py"""
import importlib.util
import os

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cj_repeat_audio", os.path.join(HERE, "..", "cj_repeat_audio.py"))
X = importlib.util.module_from_spec(spec)
spec.loader.exec_module(X)
SR = 10

clip = torch.arange(1.0, 31.0).reshape(1, 1, 30)
assert X.repeat_waveform(clip, SR, 1, 1.0, 3.0) is clip, "one copy passes through"

out = X.repeat_waveform(clip, SR, 3, 1.0, 3.0)
assert out.shape[-1] == 110, out.shape           # 3 copies of 3 s + 2 gaps of 1 s
for start in (0, 40, 80):
    assert torch.equal(out[..., start:start + 30], clip), start
assert out[..., 30:40].abs().sum() == 0 and out[..., 70:80].abs().sum() == 0

short = X.repeat_waveform(clip[..., :20], SR, 2, 1.0, 3.0)   # audio shorter than the span: copies stay on the grid
assert short.shape[-1] == 70 and torch.equal(short[..., 40:60], clip[..., :20])
long = X.repeat_waveform(clip, SR, 2, 1.0, 2.0)               # longer: cut
assert long.shape[-1] == 50 and torch.equal(long[..., 30:50], clip[..., :20])

stereo = X.repeat_waveform(torch.ones(2, 2, 30), SR, 3, 0.0, 3.0)
assert stereo.shape == (2, 2, 90)
audio = {"waveform": clip, "sample_rate": SR}
assert X.CJRepeatAudio().run(audio, 2, 1.0, 3.0)[0]["sample_rate"] == SR
print("PASS")
