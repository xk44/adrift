"""Pure helpers for CJSA3TrainAudioLoRA (no torch / comfy imports) so they
unit-test with plain python3: name + path safety, caption files, subprocess
argument lists, trainer output parsing and the loss summary."""
import json
import math
import os
import re
import shutil

AUDIO_EXTS = (".wav", ".mp3", ".flac", ".ogg", ".aif", ".opus")  # SA3 dataset loader
BASES = ("medium-base", "small-music-base", "small-sfx-base")
ADAPTERS = ("lora", "dora-rows")
# SA3 autoencoder that matches each base (stable_audio_3/model_configs.py ae_models).
AE_FOR_BASE = {"medium-base": "same-l", "small-music-base": "same-s", "small-sfx-base": "same-s"}
MIN_CLIPS = 5  # train_lora.py pre-fetches a demo batch of 4 (drop_last)
MAX_CLIPS = 200
LORA_SUBDIR = "audio"

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
STEP_RE = re.compile(r"^CJ_STEP (\d+) (\d+) (\S+)\s*$")
FINAL_RE = re.compile(r"^CJ_FINAL (.+?)\s*$")
ENCODE_RE = re.compile(r"^Processing batch (\d+)\s*$")


def sanitize_name(name):
    """LoRA name -> file-safe stem. Spaces become '_'; anything else odd is rejected."""
    n = re.sub(r"\s+", "_", (name or "").strip())
    if not _NAME.match(n):
        raise ValueError(
            f"bad LoRA name {name!r}: use 1-64 letters, digits, '_' or '-', starting with a letter or digit"
        )
    return n


def safe_join(root, rel):
    """root/rel, refusing absolute paths, '..' and symlinks that escape root."""
    rel = (rel or "").strip().replace("\\", "/").rstrip("/")
    if not rel or rel.startswith("/") or re.match(r"^[A-Za-z]:", rel) or any(p in ("", ".", "..") for p in rel.split("/")):
        raise ValueError(f"bad dataset folder {rel!r}: give a subfolder of the ComfyUI input folder")
    root_real = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_real, rel))
    if os.path.commonpath([root_real, full]) != root_real or full == root_real:
        raise ValueError(f"dataset folder {rel!r} is outside the input folder")
    return full


def parse_captions(text):
    """JSON {filename: caption} -> dict (empty text -> {})."""
    if not (text or "").strip():
        return {}
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ValueError(f"captions must be JSON {{filename: caption}}: {e}") from None
    if not isinstance(data, dict):
        raise ValueError("captions must be a JSON object {filename: caption}")
    return {str(k): ("" if v is None else str(v)) for k, v in data.items()}


def caption_from_filename(filename):
    """'03_Warm-Rhodes_loop.wav' -> 'warm rhodes loop' (upload index prefix dropped)."""
    stem = os.path.splitext(os.path.basename(filename))[0]
    stem = re.sub(r"^\d{1,3}_", "", stem)
    words = re.sub(r"[_\-.]+", " ", stem)
    words = re.sub(r"([a-z])([A-Z])", r"\1 \2", words)
    return re.sub(r"\s+", " ", words).strip().lower() or "audio clip"


def caption_for(filename, captions):
    c = (captions.get(filename) or "").strip()
    c = re.sub(r"\s+", " ", c)
    return c[:1000] if c else caption_from_filename(filename)


def list_clips(folder, captions=None):
    """Audio files in folder (not recursive). With captions, only the files it names."""
    names = sorted(
        f for f in os.listdir(folder)
        if f.lower().endswith(AUDIO_EXTS) and os.path.isfile(os.path.join(folder, f))
    )
    if captions:
        wanted = set(captions)
        named = [f for f in names if f in wanted]
        if named:
            return named
    return names


def write_dataset(src_dir, files, captions, data_dir):
    """Copy clips into data_dir as clip_NNN.<ext> + clip_NNN.txt. Returns [(src, caption)]."""
    os.makedirs(data_dir, exist_ok=True)
    out = []
    for i, f in enumerate(files):
        ext = os.path.splitext(f)[1].lower()
        stem = f"clip_{i:03d}"
        shutil.copyfile(os.path.join(src_dir, f), os.path.join(data_dir, stem + ext))
        cap = caption_for(f, captions)
        with open(os.path.join(data_dir, stem + ".txt"), "w", encoding="utf-8") as fh:
            fh.write(cap + "\n")
        out.append((f, cap))
    return out


def validate_params(base, adapter_type, rank, alpha, steps, lr, batch_size, duration, n_clips):
    if base not in BASES:
        raise ValueError(f"unknown base {base!r}; use one of {', '.join(BASES)}")
    if adapter_type not in ADAPTERS:
        raise ValueError(f"unknown adapter {adapter_type!r}; use one of {', '.join(ADAPTERS)}")
    if not 1 <= int(rank) <= 256:
        raise ValueError("rank must be 1-256")
    if alpha < 0:
        raise ValueError("alpha must be >= 0 (0 = same as rank)")
    if not 10 <= int(steps) <= 50000:
        raise ValueError("steps must be 10-50000")
    if not (0 < lr <= 1e-2) or math.isnan(lr):
        raise ValueError("learning rate must be > 0 and <= 0.01")
    if not 1 <= int(batch_size) <= 16:
        raise ValueError("batch size must be 1-16")
    if not 1.0 <= duration <= 380.0:
        raise ValueError("duration must be 1-380 seconds")
    if n_clips < MIN_CLIPS:
        raise ValueError(f"need at least {MIN_CLIPS} audio clips, found {n_clips}")
    if n_clips > MAX_CLIPS:
        raise ValueError(f"at most {MAX_CLIPS} clips, found {n_clips}")
    if batch_size > n_clips:
        raise ValueError(f"batch size {batch_size} is larger than the {n_clips} clips")


def checkpoint_every(steps):
    """Four LoRA-only checkpoints over the run (cheap; used if a run is stopped)."""
    return max(50, int(steps) // 4)


def sa3_python(sa3_dir):
    return os.path.join(sa3_dir, ".venv", "bin", "python")


def child_env(base_env, shims_dir, sa3_dir):
    env = dict(base_env)
    parts = [shims_dir, sa3_dir] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p]
    env["PYTHONPATH"] = os.pathsep.join(parts)
    env["PYTHONUNBUFFERED"] = "1"
    env["WANDB_MODE"] = "disabled"
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    env.pop("VIRTUAL_ENV", None)  # never leak ComfyUI's venv into the SA3 one
    # SA3 resolves its weights from the HF cache; when ComfyUI runs with its own
    # HF_HOME (and offline), point the trainer at the cache that holds SA3.
    sa3_hf_home = env.pop("CJ_SA3_HF_HOME", "")
    if sa3_hf_home:
        env["HF_HOME"] = os.path.expanduser(sa3_hf_home)
    return env


def preencode_args(python, sa3_dir, base, data_dir, enc_dir):
    return [
        python, os.path.join(sa3_dir, "scripts", "pre_encode_dataset.py"),
        "--model", AE_FOR_BASE[base],
        "--data_dir", data_dir,
        "--output_path", enc_dir,
        "--batch_size", "1",
    ]


def train_args(python, entry, sa3_dir, *, base, enc_dir, save_dir, final_path, name,
               adapter_type, rank, alpha, steps, lr, batch_size, duration, seed, num_workers=2):
    args = [
        python, entry,
        "--sa3_dir", sa3_dir,
        "--final_out", final_path,
        "--",
        "--model", base,
        "--encoded_dir", enc_dir,
        "--save_dir", save_dir,
        "--name", name,
        "--logger", "csv",
        "--adapter_type", adapter_type,
        "--rank", str(int(rank)),
        "--lr", repr(float(lr)),
        "--steps", str(int(steps)),
        "--batch_size", str(int(batch_size)),
        "--duration", repr(float(duration)),
        "--seed", str(int(seed)),
        "--checkpoint_every", str(checkpoint_every(steps)),
        "--log_every", "10",
        "--demo_every", str(int(steps) + 1),
        "--num_workers", str(int(num_workers)),
    ]
    if alpha and alpha > 0:
        args += ["--lora_alpha", repr(float(alpha))]
    return args


def convert_args(python, converter, base, src, dst):
    return [python, converter, src, dst, "--model", base]


def parse_line(line):
    """Trainer/pre-encode stdout line -> event tuple or None.
    ("step", step, max, loss|None) | ("final", path) | ("encode", batch_index)"""
    line = line.rstrip("\r\n")
    m = STEP_RE.match(line)
    if m:
        try:
            loss = float(m.group(3))
        except ValueError:
            loss = None
        if loss is not None and not math.isfinite(loss):
            loss = None
        return ("step", int(m.group(1)), int(m.group(2)), loss)
    m = FINAL_RE.match(line)
    if m:
        return ("final", m.group(1))
    m = ENCODE_RE.match(line)
    if m:
        return ("encode", int(m.group(1)))
    return None


def summarize_losses(losses):
    """[(step, loss)] -> {first, last, min, steps}; 'first'/'last' average the
    first/last 10% so one noisy batch does not decide the story."""
    vals = [l for _, l in losses if l is not None]
    if not vals:
        return {}
    k = max(1, len(vals) // 10)
    return {
        "first": sum(vals[:k]) / k,
        "last": sum(vals[-k:]) / k,
        "min": min(vals),
        "steps": losses[-1][0],
    }


def summary_text(path_rel, info, clips, base, adapter_type, rank, steps):
    loss = ""
    if info:
        loss = f"; loss {info['first']:.4f} -> {info['last']:.4f} (min {info['min']:.4f})"
    return (f"Saved loras/{path_rel}: {clips} clips, {base}, {adapter_type} rank {rank}, "
            f"{info.get('steps', steps) if info else steps} steps{loss}")


def unique_lora_path(loras_root, name):
    """loras/audio/<name>.safetensors, or <name>_2 ... when taken. Returns (abs, rel)."""
    folder = os.path.join(loras_root, LORA_SUBDIR)
    os.makedirs(folder, exist_ok=True)
    stem, i = name, 1
    while os.path.exists(os.path.join(folder, stem + ".safetensors")):
        i += 1
        stem = f"{name}_{i}"
    rel = f"{LORA_SUBDIR}/{stem}.safetensors"
    return os.path.join(folder, stem + ".safetensors"), rel
