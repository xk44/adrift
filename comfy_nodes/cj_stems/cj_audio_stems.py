"""CJAudioStems: split a song into drums / bass / other / vocals with Hybrid Demucs.

Weights are torchaudio's HDEMUCS_HIGH_MUSDB_PLUS state dict (hdemucs_high_trained.pt), read
from the `demucs` model folder (models/demucs, plus a `demucs:` entry in extra_model_paths.yaml).
The model is built with torchaudio.models.hdemucs_high and loaded with weights_only=True. Nothing
is ever downloaded: a missing file is an error.

The song is resampled to 44.1 kHz stereo, normalised by the mono mix's mean/std, then separated
in fixed-length chunks that overlap; overlapping chunk outputs are blended with linear ramps, so
VRAM stays bounded by one chunk whatever the song length. Stems come back at 44.1 kHz stereo,
batch-aligned with the input.
"""
import gc
import logging
import os
import threading

import torch

_log = logging.getLogger("cj_stems")

MODEL_SR = 44100
SOURCES = ("drums", "bass", "other", "vocals")
DEMUCS_FOLDER = "demucs"
DEFAULT_WEIGHTS = "hdemucs_high_trained.pt"

_lock = threading.Lock()
_cache = {}


# model folder

def _folder_paths():
    try:
        import folder_paths  # ComfyUI module; absent when the helpers run standalone

        return folder_paths
    except Exception:
        return None


def register_demucs_folder(fp=None):
    """Make sure ComfyUI knows a `demucs` folder (models/demucs, keeping yaml entries)."""
    fp = _folder_paths() if fp is None else fp
    if fp is None:
        return
    try:
        default = os.path.join(fp.models_dir, DEMUCS_FOLDER)
        exts = {".pt", ".pth", ".th", ".ckpt"}
        if DEMUCS_FOLDER not in fp.folder_names_and_paths:
            fp.folder_names_and_paths[DEMUCS_FOLDER] = ([default], exts)
        else:
            paths, have = fp.folder_names_and_paths[DEMUCS_FOLDER]
            if default not in paths:
                paths.append(default)
            if not have:
                fp.folder_names_and_paths[DEMUCS_FOLDER] = (paths, exts)
    except Exception:
        _log.exception("could not register the demucs model folder")


def weight_choices(fp=None):
    fp = _folder_paths() if fp is None else fp
    names = []
    if fp is not None:
        try:
            names = list(fp.get_filename_list(DEMUCS_FOLDER))
        except Exception:
            names = []
    if DEFAULT_WEIGHTS in names:
        names.remove(DEFAULT_WEIGHTS)
    return [DEFAULT_WEIGHTS] + sorted(names)


def resolve_weights(name, fp=None):
    fp = _folder_paths() if fp is None else fp
    if os.path.isabs(name):
        if os.path.isfile(name):
            return name
        raise FileNotFoundError(f"Audio Stems: weights not found: {name}")
    if fp is not None:
        try:
            p = fp.get_full_path(DEMUCS_FOLDER, name)
            if p and os.path.isfile(p):
                return p
        except Exception:
            pass
    raise FileNotFoundError(
        f"Audio Stems: {name} is not in the demucs model folder (models/demucs or a "
        "`demucs:` entry in extra_model_paths.yaml). Nothing is downloaded automatically."
    )


def build_hdemucs_high():
    from torchaudio.models import hdemucs_high

    return hdemucs_high(sources=list(SOURCES))


def load_model(path, builder=build_hdemucs_high):
    """Build the architecture and load a local state dict (weights_only, CPU first)."""
    key = os.path.realpath(path)
    with _lock:
        m = _cache.get(key)
        if m is not None:
            return m
        model = builder()
        state = torch.load(path, map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state and isinstance(state["state_dict"], dict):
            state = state["state_dict"]
        model.load_state_dict(state)
        model.eval()
        _cache[key] = model
        return model


def unload_all():
    with _lock:
        _cache.clear()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


# audio helpers

def to_model_input(waveform, sample_rate):
    """[C, T] at any rate / channel count -> stereo [2, T'] float32 at 44.1 kHz."""
    w = waveform.float()
    if w.ndim == 1:
        w = w.unsqueeze(0)
    if w.shape[0] == 1:
        w = w.repeat(2, 1)
    elif w.shape[0] > 2:
        w = w[:2]
    sr = int(sample_rate)
    if sr != MODEL_SR and w.shape[-1] > 0:
        import torchaudio.functional as AF

        w = AF.resample(w, sr, MODEL_SR)
    return w.contiguous()


def chunk_starts(total, chunk, hop):
    """Start offsets covering [0, total) with fixed-size windows `hop` apart."""
    if total <= chunk:
        return [0]
    starts = list(range(0, total - chunk, hop))
    starts.append(total - chunk)
    out = []
    for s in starts:
        if not out or s != out[-1]:
            out.append(s)
    return out


def blend_window(length, overlap, first, last):
    """Weights for one chunk: linear ramp up / down over the overlap (flat at track ends)."""
    w = torch.ones(length)
    ov = min(overlap, length // 2)
    if ov > 0:
        ramp = torch.arange(1, ov + 1, dtype=torch.float32) / (ov + 1)
        if not first:
            w[:ov] = ramp
        if not last:
            w[-ov:] = ramp.flip(0)
    return w


@torch.inference_mode()
def separate(model, mix, segment_seconds=10.0, overlap=0.25, device="cpu", sr=MODEL_SR):
    """mix [2, T] at the model rate -> [S, 2, T] stems (chunked overlap-add)."""
    total = mix.shape[-1]
    n_src = len(getattr(model, "sources", SOURCES))
    if total == 0:
        return torch.zeros(n_src, mix.shape[0], 0)
    mono = mix.mean(0)
    mean = mono.mean()
    std = mono.std().clamp_min(1e-8) if total > 1 else torch.tensor(1.0)
    x = (mix - mean) / std
    chunk = max(1024, int(round(segment_seconds * sr)))
    ov = int(round(min(max(overlap, 0.0), 0.5) * chunk))
    hop = max(1, chunk - ov)
    out = torch.zeros(n_src, mix.shape[0], total)
    weight = torch.zeros(total)
    starts = chunk_starts(total, chunk, hop)
    for i, s in enumerate(starts):
        piece = x[:, s : s + chunk]
        n = piece.shape[-1]
        if n < chunk:
            piece = torch.nn.functional.pad(piece, (0, chunk - n))
        y = model(piece.unsqueeze(0).to(device)).squeeze(0).float().cpu()[..., :n]
        w = blend_window(n, ov, i == 0, i == len(starts) - 1)
        out[..., s : s + n] += y * w
        weight[s : s + n] += w
    out /= weight.clamp_min(1e-8)
    return out * std + mean


def _device():
    try:
        import comfy.model_management as mm

        return mm.get_torch_device()
    except Exception:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def split_audio(audio, model, segment_seconds=10.0, overlap=0.25, device=None):
    """ComfyUI AUDIO -> tuple of 4 AUDIO dicts (drums, bass, other, vocals)."""
    wav = audio["waveform"]
    if wav.ndim == 2:
        wav = wav.unsqueeze(0)
    sr = int(audio.get("sample_rate", MODEL_SR))
    dev = device if device is not None else _device()
    per_batch = []
    model.to(dev)
    try:
        for b in range(wav.shape[0]):
            mix = to_model_input(wav[b], sr)
            per_batch.append(separate(model, mix, segment_seconds, overlap, dev))
    finally:
        model.to("cpu")
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    stems = torch.stack(per_batch, 0)  # [B, S, 2, T]
    names = list(getattr(model, "sources", SOURCES))
    out = []
    for name in SOURCES:
        k = names.index(name)
        out.append({"waveform": stems[:, k].contiguous(), "sample_rate": MODEL_SR})
    return tuple(out)


# ComfyUI node

class CJAudioStems:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "weights": (weight_choices(), {"default": DEFAULT_WEIGHTS}),
                "segment_seconds": ("FLOAT", {"default": 10.0, "min": 2.0, "max": 30.0, "step": 0.5,
                                              "tooltip": "Chunk length; VRAM scales with it."}),
                "overlap": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 0.5, "step": 0.05,
                                      "tooltip": "Fraction of each chunk blended with its neighbour."}),
                "keep_loaded": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("AUDIO", "AUDIO", "AUDIO", "AUDIO")
    RETURN_NAMES = SOURCES
    FUNCTION = "run"
    CATEGORY = "audio/adrift"
    DESCRIPTION = "Hybrid Demucs (torchaudio HDEMUCS_HIGH_MUSDB_PLUS) stems: drums, bass, other, vocals. Local weights only."

    def run(self, audio, weights, segment_seconds=10.0, overlap=0.25, keep_loaded=False):
        model = load_model(resolve_weights(weights))
        try:
            return split_audio(audio, model, segment_seconds, overlap)
        finally:
            if not keep_loaded:
                unload_all()


register_demucs_folder()

NODE_CLASS_MAPPINGS = {"CJAudioStems": CJAudioStems}
NODE_DISPLAY_NAME_MAPPINGS = {"CJAudioStems": "Audio Stems (Demucs, local)"}
