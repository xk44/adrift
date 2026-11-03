"""CJKokoroTTS: Kokoro-82M text-to-speech as a ComfyUI AUDIO node.

Kokoro (hexgrad/Kokoro-82M, Apache-2.0) runs in its own venv because kokoro /
misaki need Python <= 3.12 while ComfyUI may run newer. This node keeps one
persistent worker process (kokoro_worker.py) alive under KOKORO_PYTHON and
sends it one JSON request per generation; the model loads once (~2 s) and
speech renders faster than real time on CPU.

Setup (see README.md next to this file):
  models/tts/kokoro/Kokoro-82M/{config.json,kokoro-v1_0.pth,voices/*.pt}
  KOKORO_PYTHON=/path/to/kokoro-venv/bin/python  (kokoro==0.9.4, misaki[en])
  optional KOKORO_DEVICE=cpu|cuda (default cpu: 82M params, GPU not needed)
"""

import json
import os
import subprocess
import sys
import threading
import uuid

import numpy as np
import torch

import folder_paths

_HERE = os.path.dirname(os.path.abspath(__file__))
_WORKER = os.path.join(_HERE, "kokoro_worker.py")
_MODEL_SUBDIR = os.path.join("kokoro", "Kokoro-82M")
SAMPLE_RATE = 24000
SUPPORTED_LANGS = set("abefhip")

# Fallback list (Kokoro-82M v1.0 voices, minus ja/zh) when no voices dir is found.
_DEFAULT_VOICES = [
    "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    "ef_dora", "em_alex", "em_santa", "ff_siwis",
    "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
    "if_sara", "im_nicola", "pf_dora", "pm_alex", "pm_santa",
]


def _model_dir():
    roots = []
    try:
        roots = folder_paths.get_folder_paths("tts")
    except Exception:
        pass
    roots = list(roots) + [os.path.join(folder_paths.models_dir, "tts")]
    for root in roots:
        d = os.path.join(root, _MODEL_SUBDIR)
        if os.path.isfile(os.path.join(d, "kokoro-v1_0.pth")):
            return d
    return None


def _voices():
    d = _model_dir()
    if d and os.path.isdir(os.path.join(d, "voices")):
        found = sorted(
            f[:-3]
            for f in os.listdir(os.path.join(d, "voices"))
            if f.endswith(".pt") and f[:1] in SUPPORTED_LANGS
        )
        if found:
            # af_heart (Kokoro's best-rated voice) first = default.
            return sorted(found, key=lambda v: (v != "af_heart", v))
    return list(_DEFAULT_VOICES)


def _kokoro_python():
    explicit = os.environ.get("KOKORO_PYTHON")
    if explicit:
        return explicit
    for cand in (
        os.path.join(_HERE, "venv", "bin", "python"),
        os.path.join(_HERE, "venv", "Scripts", "python.exe"),
    ):
        if os.path.isfile(cand):
            return cand
    return None


class _Worker:
    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()

    def _start(self):
        py = _kokoro_python()
        if not py:
            raise RuntimeError(
                "Kokoro TTS: set KOKORO_PYTHON to a Python 3.10-3.12 venv with "
                "kokoro==0.9.4 and misaki[en] (see comfy_nodes/cj_kokoro_tts/README.md)"
            )
        mdir = _model_dir()
        if not mdir:
            raise RuntimeError(
                "Kokoro TTS: weights not found; expected models/tts/"
                + _MODEL_SUBDIR.replace(os.sep, "/")
                + "/kokoro-v1_0.pth"
            )
        device = os.environ.get("KOKORO_DEVICE", "cpu")
        self.proc = subprocess.Popen(
            [py, "-I", _WORKER, "--model-dir", mdir, "--device", device],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            bufsize=1,
        )
        hello = self.proc.stdout.readline()
        if not hello:
            code = self.proc.wait()
            self.proc = None
            raise RuntimeError(f"Kokoro TTS: worker exited during startup (code {code})")

    def say(self, text, voice, speed):
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            out = os.path.join(
                folder_paths.get_temp_directory(), f"kokoro_{uuid.uuid4().hex}.f32"
            )
            os.makedirs(os.path.dirname(out), exist_ok=True)
            req = {"text": text, "voice": voice, "speed": speed, "out": out}
            try:
                self.proc.stdin.write(json.dumps(req) + "\n")
                self.proc.stdin.flush()
                line = self.proc.stdout.readline()
            except (BrokenPipeError, OSError) as e:
                self.proc = None
                raise RuntimeError(f"Kokoro TTS: worker died ({e})")
            if not line:
                self.proc = None
                raise RuntimeError("Kokoro TTS: worker exited mid-request")
            reply = json.loads(line)
            try:
                if not reply.get("ok"):
                    raise RuntimeError(f"Kokoro TTS: {reply.get('error')}")
                pcm = np.fromfile(out, dtype="<f4")
            finally:
                if os.path.exists(out):
                    os.remove(out)
            return pcm, int(reply.get("sample_rate") or SAMPLE_RATE)


_worker = _Worker()


class CJKokoroTTS:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
                "voice": (_voices(),),
                "speed": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.05}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "generate"
    CATEGORY = "audio/tts"
    DESCRIPTION = "Kokoro-82M text-to-speech (Apache-2.0), runs in a separate venv."

    def generate(self, text, voice, speed):
        text = (text or "").strip()
        if not text:
            raise ValueError("Kokoro TTS: text is empty")
        pcm, sr = _worker.say(text, voice, float(speed))
        waveform = torch.from_numpy(pcm.copy()).float().view(1, 1, -1)
        return ({"waveform": waveform, "sample_rate": sr},)


NODE_CLASS_MAPPINGS = {"CJKokoroTTS": CJKokoroTTS}
NODE_DISPLAY_NAME_MAPPINGS = {"CJKokoroTTS": "Kokoro TTS (CJ)"}
