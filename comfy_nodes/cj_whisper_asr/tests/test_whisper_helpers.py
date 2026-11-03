"""CPU test for cj_whisper_asr.
usage: python -I test_whisper_helpers.py path/to/cj_whisper_asr.py [--model DIR --audio FILE [--language L] [--task T]]

Always: pure helpers (stereo 44.1 kHz [B,C,T] -> mono 16 kHz, segment parsing / clamping, language
normalisation, silent input short-circuit). With --model/--audio: a real CPU transcription through the
node class (set CUDA_VISIBLE_DEVICES= to keep it off the GPU), printing transcript + segments."""
import argparse
import importlib.util
import json
import math
import os
import sys
import time

import numpy as np
import torch

ap = argparse.ArgumentParser()
ap.add_argument("module")
ap.add_argument("--model")
ap.add_argument("--audio")
ap.add_argument("--language", default="auto")
ap.add_argument("--task", default="transcribe")
args = ap.parse_args()

spec = importlib.util.spec_from_file_location("wasr", args.module)
wasr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wasr)

# --- downmix + resample
sr = 44100
t = np.arange(int(sr * 2.0)) / sr
left = np.sin(2 * math.pi * 440 * t).astype(np.float32)
right = -left * 0.5
wave = torch.from_numpy(np.stack([left, right]))[None]          # [1, 2, T]
mono = wasr.to_mono_16k(wave, sr)
assert mono.dtype == np.float32 and mono.ndim == 1, mono.shape
assert abs(mono.shape[0] - 32000) <= 2, mono.shape[0]
# mean of L and -0.5L = 0.25L -> amplitude ~0.25
assert 0.2 < float(np.abs(mono).max()) < 0.3, float(np.abs(mono).max())
same = wasr.to_mono_16k(torch.zeros(1, 1, 16000), 16000)
assert same.shape == (16000,)
try:
    wasr.to_mono_16k(torch.zeros(1, 1, 10), 0)
    raise AssertionError("sample_rate 0 accepted")
except ValueError:
    pass

# --- language
assert wasr.normalize_language("auto") is None
assert wasr.normalize_language("") is None
assert wasr.normalize_language(" French ") == "french"

# --- segments
res = {"text": " Hello there. General remark.", "chunks": [
    {"text": " Hello there.", "timestamp": (0.0, 1.5)},
    {"text": "   ", "timestamp": (1.5, 1.7)},
    {"text": " General remark.", "timestamp": (1.7, None)},
]}
segs = wasr.segments_from_result(res, 4.0)
assert segs == [{"start": 0.0, "end": 1.5, "text": "Hello there."},
                {"start": 1.7, "end": 4.0, "text": "General remark."}], segs
assert wasr.transcript_from(res, segs) == "Hello there. General remark."
clamped = wasr.segments_from_result({"chunks": [{"text": "x", "timestamp": (3.0, 9.0)}]}, 5.0)
assert clamped == [{"start": 3.0, "end": 5.0, "text": "x"}], clamped
nochunks = wasr.segments_from_result({"text": " only text "}, 2.345)
assert nochunks == [{"start": 0.0, "end": 2.35, "text": "only text"}] or \
    nochunks == [{"start": 0.0, "end": 2.34, "text": "only text"}], nochunks
assert wasr.segments_from_result({}, 3.0) == []

# --- silence never loads the model
tr, sg = wasr.run_asr(np.zeros(16000, np.float32), model_path="/nonexistent")
assert tr == "" and sg == []

# --- node surface
it = wasr.CJWhisperASR.INPUT_TYPES()
assert list(it["required"]) == ["audio"]
for k in ("language", "task", "model_path", "return_timestamps", "device", "keep_loaded"):
    assert k in it["optional"], k
assert wasr.CJWhisperASR.RETURN_TYPES == ("STRING", "STRING")
try:
    wasr.run_asr(np.ones(16000, np.float32) * 0.1, model_path="/nonexistent/whisper")
    raise AssertionError("missing model dir accepted")
except FileNotFoundError:
    pass

# --- model path resolution (absolute as-is, relative under ComfyUI's stt folders)
import tempfile
import types

with tempfile.TemporaryDirectory() as tmp:
    models = os.path.join(tmp, "models")
    extra_stt = os.path.join(tmp, "extra", "stt")
    fake = types.SimpleNamespace(models_dir=models,
                                 get_folder_paths=lambda name: [extra_stt] if name == "stt" else [])
    assert wasr.DEFAULT_MODEL == "whisper/whisper-large-v3-turbo" and not os.path.isabs(wasr.DEFAULT_MODEL)
    assert wasr.model_path_candidates("/abs/whisper", fake) == ["/abs/whisper"]
    assert wasr.resolve_model_path("~/w", fake) == os.path.expanduser("~/w")
    cands = wasr.model_path_candidates("", fake)
    assert cands == [os.path.join(extra_stt, "whisper", "whisper-large-v3-turbo"),
                     os.path.join(models, "stt", "whisper", "whisper-large-v3-turbo"),
                     os.path.join(models, "whisper", "whisper-large-v3-turbo")], cands
    # nothing on disk -> first candidate, so the error names the expected dir
    assert wasr.resolve_model_path(None, fake) == cands[0]
    os.makedirs(cands[1])
    assert wasr.resolve_model_path(wasr.DEFAULT_MODEL, fake) == cands[1]
    os.makedirs(cands[0])
    assert wasr.resolve_model_path(wasr.DEFAULT_MODEL, fake) == cands[0]
    # "stt/..." relative to the models dir also works
    assert wasr.resolve_model_path("stt/whisper/whisper-large-v3-turbo", fake) == cands[1]

print("helpers OK")

# --- boundary snapping: tone 0-2.2 s, pause 2.2-2.6 s, tone 2.6-5 s; whisper says 2.0
sr = 16000
tt = np.arange(5 * sr) / sr
sig = (0.3 * np.sin(2 * np.pi * 220 * tt)).astype(np.float32)
sig[int(2.2 * sr):int(2.6 * sr)] = 0.0
segs = [{"start": 0.0, "end": 2.0, "text": "a"}, {"start": 2.0, "end": 5.0, "text": "b"}]
sn = wasr.snap_boundaries(sig, segs)
assert 2.2 <= sn[0]["end"] <= 2.6 and sn[0]["end"] == sn[1]["start"], sn
assert segs[0]["end"] == 2.0, "input not mutated"
cont = (0.3 * np.sin(2 * np.pi * 220 * tt)).astype(np.float32)   # no pause -> keep whisper's boundary
assert wasr.snap_boundaries(cont, segs)[0]["end"] == 2.0
gap = [{"start": 0.0, "end": 1.0, "text": "a"}, {"start": 2.0, "end": 5.0, "text": "b"}]
assert wasr.snap_boundaries(sig, gap) == gap, "non-adjacent segments untouched"
assert wasr.snap_boundaries(sig, segs[:1]) == segs[:1]

if args.model and args.audio:
    import av

    with av.open(args.audio) as c:
        st = c.streams.audio[0]
        rate = st.rate
        chans = st.channels
        frames = []
        for f in c.decode(st):
            a = f.to_ndarray()
            if not f.format.is_planar:        # packed: (1, N*ch) interleaved
                a = a.reshape(-1, chans).T
            frames.append(a)
        is_int = not frames[0].dtype.kind == "f"
    pcm = np.concatenate(frames, axis=1).astype(np.float32)
    if is_int:
        pcm = pcm / 32768.0
    audio = {"waveform": torch.from_numpy(pcm)[None], "sample_rate": rate}
    node = wasr.CJWhisperASR()
    t0 = time.time()
    transcript, seg_json = node.transcribe(audio, language=args.language, task=args.task,
                                           model_path=args.model, device="cpu", keep_loaded=True)
    t1 = time.time()
    print(f"run1 {t1 - t0:.1f}s ({pcm.shape[1] / rate:.1f}s audio, {rate} Hz, {pcm.shape[0]} ch)")
    print("transcript:", transcript)
    segs = json.loads(seg_json)
    print("segments:", json.dumps(segs, ensure_ascii=False, indent=1))
    assert isinstance(segs, list)
    for s in segs:
        assert set(s) == {"start", "end", "text"} and 0 <= s["start"] <= s["end"], s
    assert len(wasr._cache) == 1, "keep_loaded=True should cache"
    # second run, cached, keep_loaded False frees
    transcript2, _ = node.transcribe(audio, language=args.language, task=args.task,
                                     model_path=args.model, device="cpu", keep_loaded=False)
    print(f"run2 (cached) {time.time() - t1:.1f}s")
    assert transcript2 == transcript, (transcript2, transcript)
    assert len(wasr._cache) == 0, "keep_loaded=False should free"
    _, seg_flat = node.transcribe(audio, language=args.language, task=args.task, model_path=args.model,
                                  device="cpu", return_timestamps=False)
    flat = json.loads(seg_flat)
    assert len(flat) <= 1, flat
    print("real ASR OK")
