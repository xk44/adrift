"""CPU test for the cj_h3_prefetch window helpers (pad_frames, slice_audio, window_reference_inputs).
usage: python test_prefetch_window.py path/to/cj_h3_prefetch.py

Expected values are written out by hand from the h3-relay-window-v2 contract (24 fps timeline)."""
import importlib.util
import sys

import torch

spec = importlib.util.spec_from_file_location("pf", sys.argv[1])
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)


def raises(fn, msg):
    try:
        fn()
    except ValueError as e:
        assert str(e) == msg, e
        return
    raise AssertionError(f"expected ValueError({msg!r})")


# -- pad_frames ------------------------------------------------------------------------------
frames = torch.arange(5 * 2 * 2 * 3, dtype=torch.float32).view(5, 2, 2, 3)
raises(lambda: pf.pad_frames(frames[:0], 4), "Cannot pad an empty window")
raises(lambda: pf.pad_frames(frames[:0], 0), "Cannot pad an empty window")

out = pf.pad_frames(frames, 5)                       # exact length: unchanged
assert torch.equal(out, frames)
out = pf.pad_frames(frames, 3)                       # longer than the window: first frames only
assert out.shape == (3, 2, 2, 3) and torch.equal(out, frames[:3])
assert out.data_ptr() == frames.data_ptr()           # truncation is a view
out = pf.pad_frames(frames, 0)
assert out.shape == (0, 2, 2, 3)
out = pf.pad_frames(frames, 8)                       # shorter: repeat the last frame
assert out.shape == (8, 2, 2, 3) and torch.equal(out[:5], frames)
for i in range(5, 8):
    assert torch.equal(out[i], frames[4])
one = frames[2:3]
out = pf.pad_frames(one, 4)                          # single frame -> 4 copies
assert out.shape == (4, 2, 2, 3) and all(torch.equal(out[i], frames[2]) for i in range(4))
u8 = (frames % 256).to(torch.uint8)
assert pf.pad_frames(u8, 7).dtype == torch.uint8     # dtype kept
flat = torch.tensor([1., 2., 3.])
assert pf.pad_frames(flat, 6).tolist() == [1., 2., 3., 3., 3., 3.]
assert pf.pad_frames(flat, 2).tolist() == [1., 2.]

# -- slice_audio -----------------------------------------------------------------------------
assert pf.slice_audio(None, 0, 10) is None
wave = torch.arange(2 * 48000, dtype=torch.float32).view(1, 2, 48000)   # stereo, 1 s @ 48 kHz
stereo = {"sample_rate": 48000, "waveform": wave}
raises(lambda: pf.slice_audio(stereo, -1, 5), "Invalid source audio interval")
raises(lambda: pf.slice_audio(stereo, 6, 5), "Invalid source audio interval")

a = pf.slice_audio(stereo, 0, 12)                    # 12 frames = 0.5 s = 24000 samples
assert a["sample_rate"] == 48000 and a["waveform"].shape == (1, 2, 24000)
assert torch.equal(a["waveform"], wave[..., :24000])
a = pf.slice_audio(stereo, 6, 6)                     # empty interval
assert a["waveform"].shape == (1, 2, 0)
a = pf.slice_audio(stereo, 12, 36)                   # runs past the end: 24000 real + 24000 zeros
assert a["waveform"].shape == (1, 2, 48000)
assert torch.equal(a["waveform"][..., :24000], wave[..., 24000:])
assert not a["waveform"][..., 24000:].any()
a = pf.slice_audio(stereo, 12, 36, pad=False)        # no pad: whatever is there
assert a["waveform"].shape == (1, 2, 24000)
a = pf.slice_audio(stereo, 30, 40)                   # starts past the end: all zeros
assert a["waveform"].shape == (1, 2, 20000) and not a["waveform"].any()
assert pf.slice_audio(stereo, 30, 40, pad=False)["waveform"].shape == (1, 2, 0)

mono = {"sample_rate": 44100.0, "waveform": torch.ones(1, 1, 44100)}     # float rate -> int
a = pf.slice_audio(mono, 1, 2)                       # 1837.5 -> 1838 (round half even), 3675
assert a["sample_rate"] == 44100 and isinstance(a["sample_rate"], int)
assert a["waveform"].shape == (1, 1, 3675 - 1838)
a = pf.slice_audio(mono, 3, 5)                       # 5512.5 -> 5512, 9187.5 -> 9188
assert a["waveform"].shape == (1, 1, 9188 - 5512)
odd = {"sample_rate": 16000, "waveform": torch.ones(1, 1, 1001)}       # odd length, 16 kHz
a = pf.slice_audio(odd, 1, 3)                        # 666.67 -> 667, 2000: 334 real + 999 zeros
assert a["waveform"].shape == (1, 1, 1333)
assert a["waveform"][..., :334].eq(1).all() and not a["waveform"][..., 334:].any()
bare = {"sample_rate": 24, "waveform": torch.arange(10.)}              # 1-D waveform
assert pf.slice_audio(bare, 8, 12)["waveform"].tolist() == [8., 9., 0., 0.]

# -- window_reference_inputs -----------------------------------------------------------------
src = torch.rand(20, 32, 64, 3)
win = {"contract": pf.CONTRACT, "index": 1, "source_start": 10, "window_frames": 8,
       "history_frames": 3, "source_frames": 15}
audio = {"sample_rate": 2400, "waveform": torch.randn(1, 2, 1500)}       # 100 samples / frame
info = pf.window_reference_inputs(src, win, audio, True, 24.)
assert info["past"] == 2 and info["conditioning_length"] == 10
assert torch.equal(info["source_window"][:5], src[10:15])               # 5 real + 3 padded
assert torch.equal(info["source_window"][5:], src[14:15].expand(3, -1, -1, -1))
assert info["reference_video"].shape[0] == 10 and torch.equal(info["reference_video"][:7], src[8:15])
assert info["target_audio"]["waveform"].shape == (1, 2, 800)            # frames 10..18
assert torch.equal(info["target_audio"]["waveform"][..., :500], audio["waveform"][..., 1000:])
assert info["reference_audio"]["waveform"].shape == (1, 2, 1000)        # frames 8..18
info = pf.window_reference_inputs(src, win, None, False, 24.)
assert info["past"] == 0 and info["target_audio"] is None and info["reference_video"].shape[0] == 8
raises(lambda: pf.window_reference_inputs(src, win, None, True, 25.),
       "H3 windows require a 24 fps source; resample before masking")
raises(lambda: pf.window_reference_inputs(src, dict(win, source_start=1), None, True, 24.),
       "Reference history precedes the source")
assert pf.window_entry({"windows": [win, win]}, 1) is win
raises(lambda: pf.window_entry(dict(win, contract="v1"), 0), "Unsupported H3 window contract")

# -- sampling_workspace: memory floor while sampling, unload policy, HIGH_VRAM skips unloads -----
class _VS:
    HIGH_VRAM, NORMAL_VRAM = "high", "normal"


def _workspace_events(vram, before, after):
    events = []

    class Mgmt:
        VRAMState, vram_state = _VS, vram

        @staticmethod
        def unload_all_models():
            events.append("unload")

    class Inner:
        def memory_required(self, *a):
            return -1

    class Model:
        def __init__(self):
            self.model, self.wrappers = Inner(), []

        def clone(self):
            events.append("clone")
            return self

        def get_model_object(self, key):
            assert key == "memory_required"
            return lambda shape, conds: 3 * 2**30 if shape == "big" else 10

        def add_wrapper(self, kind, fn):
            self.wrappers.append((kind, fn))

    m = Model()
    original = m.model.memory_required
    out = pf.sampling_workspace(m, 2.0, Mgmt, "outer_sample", before, after)
    (kind, fn), = out.wrappers
    assert kind == "outer_sample"
    seen = fn(lambda: (out.model.memory_required("big"), out.model.memory_required("small", None)))
    assert seen == (3 * 2**30, 2 * 2**30), seen          # max(native estimate, floor)
    assert out.model.memory_required == original          # restored after sampling
    events.append("sampled")
    return events


assert _workspace_events("normal", True, True) == ["unload", "clone", "unload", "sampled"]
assert _workspace_events("normal", True, False) == ["unload", "clone", "sampled"]
assert _workspace_events("normal", False, True) == ["clone", "unload", "sampled"]
assert _workspace_events("normal", False, False) == ["clone", "sampled"]
assert _workspace_events("high", True, True) == ["clone", "sampled"]

print("prefetch window helpers OK")
