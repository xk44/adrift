"""CJWhisperASR: Whisper speech recognition (transcribe or translate-to-English) as a ComfyUI node.

Runs a local Hugging Face-format Whisper checkpoint (default: whisper-large-v3-turbo) through the
transformers ASR pipeline. model_path is either an absolute dir or a name relative to ComfyUI's
`stt` model folder (models/stt/, plus any `stt:` entry in extra_model_paths.yaml); the default is
whisper/whisper-large-v3-turbo, i.e. ComfyUI/models/stt/whisper/whisper-large-v3-turbo. Fully offline: the model is loaded with
local_files_only, so a missing or partial model dir fails loudly instead of downloading.

Outputs
  transcript     plain text of the whole clip
  segments_json  JSON array [{"start": s, "end": s, "text": "..."}] (seconds, clip-relative)

The pipeline is cached per process keyed by (model path, device, dtype). keep_loaded=False drops it
after the run and empties the CUDA cache so the VRAM goes back to the next node in the graph.

Only torch / numpy / transformers are needed (all already ComfyUI dependencies); torchaudio or scipy
are used for resampling when present, with a numpy fallback.
"""

import gc
import json
import math
import os
import threading

import numpy as np
import torch

DEFAULT_MODEL = "whisper/whisper-large-v3-turbo"
STT_FOLDER = "stt"
TARGET_SR = 16000
WINDOW_S = 30.0

# Whisper language names accepted by generate(language=...); "auto" lets the model detect.
LANGUAGES = [
    "auto", "english", "spanish", "french", "german", "italian", "portuguese", "dutch", "polish",
    "russian", "ukrainian", "turkish", "arabic", "hindi", "japanese", "korean", "chinese",
    "indonesian", "vietnamese", "thai", "swedish", "greek", "czech", "romanian", "hungarian",
    "hebrew", "persian", "danish", "finnish", "norwegian", "malay", "tagalog",
]

_cache = {}
_lock = threading.Lock()


# pure helpers (unit-tested on CPU)

def to_mono_16k(waveform, sample_rate):
    """ComfyUI AUDIO waveform [B, C, T] (or [C, T] / [T]) -> float32 mono numpy at 16 kHz.

    Only the first batch item is used: ASR on a batch of different clips would need one transcript each."""
    w = waveform
    if isinstance(w, torch.Tensor):
        w = w.detach().to("cpu", torch.float32)
    else:
        w = torch.as_tensor(np.asarray(w), dtype=torch.float32)
    if w.dim() == 3:
        w = w[0]
    if w.dim() == 2:
        w = w.mean(0)
    w = w.reshape(-1)
    sr = int(sample_rate)
    if sr <= 0:
        raise ValueError(f"Whisper ASR: bad sample_rate {sample_rate}")
    if sr != TARGET_SR and w.numel() > 0:
        w = _resample(w, sr, TARGET_SR)
    return np.ascontiguousarray(w.numpy(), dtype=np.float32)


def _resample(w, sr, target):
    try:
        import torchaudio.functional as AF

        return AF.resample(w, sr, target)
    except Exception:
        pass
    try:
        from scipy.signal import resample_poly

        g = math.gcd(sr, target)
        return torch.from_numpy(resample_poly(w.numpy(), target // g, sr // g).astype(np.float32))
    except Exception:
        pass
    n = max(1, int(round(w.numel() * target / sr)))
    x_old = np.linspace(0.0, 1.0, w.numel(), endpoint=False)
    x_new = np.linspace(0.0, 1.0, n, endpoint=False)
    return torch.from_numpy(np.interp(x_new, x_old, w.numpy()).astype(np.float32))


def normalize_language(language):
    lang = (language or "").strip().lower()
    return None if lang in ("", "auto", "detect", "none") else lang


def segments_from_result(result, duration):
    """transformers ASR pipeline output -> list of {start, end, text}, times clamped to [0, duration]."""
    duration = float(max(0.0, duration))
    chunks = result.get("chunks") if isinstance(result, dict) else None
    segs = []
    for ch in chunks or []:
        text = str(ch.get("text") or "").strip()
        if not text:
            continue
        ts = ch.get("timestamp") or (None, None)
        start, end = (list(ts) + [None, None])[:2]
        start = 0.0 if start is None else float(start)
        if end is None:
            end = duration if duration > start else start
        end = float(end)
        start = min(max(start, 0.0), duration) if duration else max(start, 0.0)
        end = min(max(end, start), duration) if duration else max(end, start)
        segs.append({"start": round(start, 2), "end": round(end, 2), "text": text})
    if not segs:
        text = str((result or {}).get("text") or "").strip() if isinstance(result, dict) else ""
        if text:
            segs.append({"start": 0.0, "end": round(duration, 2), "text": text})
    return segs


def snap_boundaries(audio_np, segments, sr=TARGET_SR, window_s=0.35, hop_s=0.01, quieter=0.5):
    """Move each shared boundary between consecutive segments to the quietest 30 ms frame within
    +-window_s. large-v3-turbo emits timestamps on a coarse grid (often 0.5 s steps) that can cut
    the last word of a line; snapping to the real pause fixes dub timing. A boundary only moves
    when the pause is clearly quieter (< `quieter` x the RMS at the original point), so lines
    spoken back to back keep Whisper's estimate."""
    if len(segments) < 2 or audio_np is None or audio_np.size == 0:
        return segments
    hop = max(1, int(sr * hop_s))
    win = max(hop, int(sr * 0.03))
    x = np.asarray(audio_np, dtype=np.float32)
    n = max(1, (x.size - win) // hop + 1)
    idx = np.arange(n)[:, None] * hop + np.arange(win)[None, :]
    env = np.sqrt(np.mean(x[np.minimum(idx, x.size - 1)] ** 2, axis=1))
    out = [dict(s) for s in segments]
    for i in range(len(out) - 1):
        a, b = out[i], out[i + 1]
        t = b["start"]
        if abs(a["end"] - t) > 0.05:
            continue
        lo = max(t - window_s, a["start"] + 0.1)
        hi = min(t + window_s, b["end"] - 0.1)
        if hi <= lo:
            continue
        f0 = int(lo / hop_s); f1 = int(hi / hop_s) + 1
        f0, f1 = max(0, f0), min(n, f1)
        if f1 <= f0:
            continue
        ft = min(n - 1, max(0, int(t / hop_s)))
        j = f0 + int(np.argmin(env[f0:f1]))
        if env[j] < quieter * max(env[ft], 1e-6):
            nt = round((j * hop + win / 2) / sr, 2)
            a["end"] = nt
            b["start"] = nt
    return out


def transcript_from(result, segments):
    text = str((result or {}).get("text") or "").strip() if isinstance(result, dict) else ""
    return text or " ".join(s["text"] for s in segments).strip()


# model path

def _folder_paths():
    try:
        import folder_paths  # ComfyUI module; absent when the helpers run standalone

        return folder_paths
    except Exception:
        return None


def register_stt_folder():
    """Make sure ComfyUI knows a `stt` model folder (models/stt) so relative names resolve."""
    fp = _folder_paths()
    if fp is None:
        return
    try:
        default = os.path.join(fp.models_dir, STT_FOLDER)
        if STT_FOLDER not in fp.folder_names_and_paths:
            fp.folder_names_and_paths[STT_FOLDER] = ([default], set())
        elif default not in fp.get_folder_paths(STT_FOLDER):
            fp.add_model_folder_path(STT_FOLDER, default)
    except Exception:
        pass


def model_path_candidates(model_path, fp=None):
    """Dirs a model_path may refer to, in lookup order.

    Absolute (or ~) paths are used as-is. A relative name is tried under every `stt` folder
    ComfyUI knows about, then under the models dir itself (so "stt/whisper/..." also works)."""
    p = os.path.expanduser((model_path or "").strip() or DEFAULT_MODEL)
    if os.path.isabs(p):
        return [p]
    fp = _folder_paths() if fp is None else fp
    bases = []
    if fp is not None:
        try:
            bases.extend(fp.get_folder_paths(STT_FOLDER))
        except Exception:
            pass
        models_dir = getattr(fp, "models_dir", None)
        if models_dir:
            bases.extend([os.path.join(models_dir, STT_FOLDER), models_dir])
    else:
        bases.extend([os.path.join("models", STT_FOLDER), "models"])
    out = []
    for b in bases:
        c = os.path.normpath(os.path.join(b, p))
        if c not in out:
            out.append(c)
    return out or [p]


def resolve_model_path(model_path, fp=None):
    """First existing candidate dir, else the first candidate (so the error names the expected dir)."""
    cands = model_path_candidates(model_path, fp)
    for c in cands:
        if os.path.isdir(c):
            return c
    return cands[0]


# model cache

def _resolve_device(device):
    if device == "cpu":
        return "cpu"
    if device == "cuda" or device == "auto":
        if torch.cuda.is_available():
            return "cuda"
        if device == "cuda":
            raise RuntimeError("Whisper ASR: device=cuda but CUDA is not available")
    return "cpu"


def _check_model_dir(path):
    if not os.path.isdir(path):
        raise FileNotFoundError(f"Whisper ASR: model dir not found: {path}")
    need = ("config.json", "preprocessor_config.json")
    missing = [f for f in need if not os.path.isfile(os.path.join(path, f))]
    has_weights = any(
        f.endswith((".safetensors", ".bin")) for f in os.listdir(path)
    )
    if missing or not has_weights:
        raise FileNotFoundError(
            f"Whisper ASR: {path} is not a Hugging Face Whisper checkpoint (missing "
            f"{', '.join(missing + ([] if has_weights else ['weights']))})"
        )


def get_pipeline(model_path, device):
    model_path = resolve_model_path(model_path)
    dev = _resolve_device(device)
    dtype = torch.float16 if dev == "cuda" else torch.float32
    key = (os.path.realpath(model_path), dev, str(dtype))
    with _lock:
        pipe = _cache.get(key)
        if pipe is not None:
            return pipe
        _check_model_dir(model_path)
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_path, dtype=dtype, low_cpu_mem_usage=True, local_files_only=True
        )
        model.to(dev)
        processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
        pipe = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            dtype=dtype,
            device=dev,
        )
        _cache[key] = pipe
        return pipe


def unload_all():
    with _lock:
        _cache.clear()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def run_asr(audio_np, model_path=DEFAULT_MODEL, language="auto", task="transcribe",
            return_timestamps=True, device="auto", keep_loaded=False):
    """Transcribe (or translate to English) 16 kHz mono float32 audio. Returns (transcript, segments)."""
    duration = audio_np.shape[0] / TARGET_SR
    if audio_np.size == 0 or float(np.abs(audio_np).max(initial=0.0)) < 1e-5:
        return "", []
    if task not in ("transcribe", "translate"):
        raise ValueError(f"Whisper ASR: task must be transcribe or translate, got {task!r}")
    pipe = get_pipeline(model_path, device)
    gen = {"task": task}
    lang = normalize_language(language)
    if lang:
        gen["language"] = lang
    # Whisper's long-form (>30 s) decoding needs timestamp tokens, so they are always requested
    # there; return_timestamps=False only coarsens the segment list to one entry.
    want_ts = bool(return_timestamps) or duration > WINDOW_S
    try:
        with torch.inference_mode():
            result = pipe(
                {"raw": audio_np, "sampling_rate": TARGET_SR},
                return_timestamps=want_ts,
                generate_kwargs=gen,
            )
    finally:
        if not keep_loaded:
            unload_all()
    segments = snap_boundaries(audio_np, segments_from_result(result, duration))
    transcript = transcript_from(result, segments)
    if not return_timestamps and transcript:
        segments = [{"start": 0.0, "end": round(duration, 2), "text": transcript}]
    return transcript, segments


# ComfyUI node

class CJWhisperASR:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
            },
            "optional": {
                "language": (LANGUAGES, {"default": "auto",
                                         "tooltip": "Spoken language; auto = detect."}),
                "task": (["transcribe", "translate"], {"default": "transcribe",
                                                       "tooltip": "translate = Whisper's built-in to-English translation (large-v3-turbo mostly ignores it; use large-v3)."}),
                "model_path": ("STRING", {"default": DEFAULT_MODEL,
                                          "tooltip": "Local Hugging Face-format Whisper dir (never downloaded): absolute, or relative to ComfyUI/models/stt."}),
                "return_timestamps": ("BOOLEAN", {"default": True}),
                "device": (["auto", "cuda", "cpu"], {"default": "auto"}),
                "keep_loaded": ("BOOLEAN", {"default": False,
                                            "tooltip": "Keep the model cached between runs (uses ~1.6 GB VRAM)."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("transcript", "segments_json")
    FUNCTION = "transcribe"
    CATEGORY = "audio/asr"
    DESCRIPTION = "Whisper speech-to-text (local model, offline). Outputs the transcript and timed segments as JSON."

    def transcribe(self, audio, language="auto", task="transcribe", model_path=DEFAULT_MODEL,
                   return_timestamps=True, device="auto", keep_loaded=False):
        if not isinstance(audio, dict) or "waveform" not in audio:
            raise ValueError("Whisper ASR: expected an AUDIO input")
        mono = to_mono_16k(audio["waveform"], audio.get("sample_rate", TARGET_SR))
        transcript, segments = run_asr(
            mono,
            model_path=(model_path or "").strip() or DEFAULT_MODEL,
            language=language,
            task=task,
            return_timestamps=return_timestamps,
            device=device,
            keep_loaded=keep_loaded,
        )
        return (transcript, json.dumps(segments, ensure_ascii=False))


register_stt_folder()

NODE_CLASS_MAPPINGS = {"CJWhisperASR": CJWhisperASR}
NODE_DISPLAY_NAME_MAPPINGS = {"CJWhisperASR": "Whisper ASR (CJ)"}
