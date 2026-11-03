"""Kokoro-82M TTS worker (runs in its own Python 3.10-3.12 venv).

kokoro/misaki do not support the Python that ComfyUI may run on (3.13+), so
the ComfyUI node (__init__.py) starts this script once under KOKORO_PYTHON
and talks to it over stdin/stdout, one JSON object per line:

  request  {"text": str, "voice": str, "speed": float, "out": "/abs/path.f32"}
  reply    {"ok": true, "samples": int, "sample_rate": 24000}
           {"ok": false, "error": str}

Audio goes to `out` as raw little-endian float32 mono (not over the pipe).
Fully offline: weights, config and voice tensors are read from --model-dir;
nothing is fetched from the network. espeak-ng (the fallback G2P for English
and the G2P for es/fr/hi/it/pt) uses the system library when one is found
(KOKORO_ESPEAK_LIB / KOKORO_ESPEAK_DATA override), else espeakng-loader's.
"""

import argparse
import json
import os
import sys

# Protocol replies use the real stdout; everything libraries print goes to stderr.
_proto = sys.stdout
sys.stdout = sys.stderr

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

SAMPLE_RATE = 24000
# Voice id prefix letter = Kokoro lang_code. ja (j) / zh (z) need misaki extras.
SUPPORTED_LANGS = set("abefhip")

_SYSTEM_ESPEAK = [
    "/usr/lib/libespeak-ng.so.1",
    "/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1",
    "/usr/lib/aarch64-linux-gnu/libespeak-ng.so.1",
    "/opt/homebrew/lib/libespeak-ng.dylib",
    "/usr/local/lib/libespeak-ng.dylib",
]
_SYSTEM_ESPEAK_DATA = [
    "/usr/share/espeak-ng-data",
    "/usr/lib/x86_64-linux-gnu/espeak-ng-data",
    "/opt/homebrew/share/espeak-ng-data",
    "/usr/local/share/espeak-ng-data",
]


def _first_existing(paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None


def _setup_espeak():
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    import misaki.espeak  # noqa: F401  (sets espeakng-loader's lib at import)

    lib = os.environ.get("KOKORO_ESPEAK_LIB") or _first_existing(_SYSTEM_ESPEAK)
    data = os.environ.get("KOKORO_ESPEAK_DATA") or _first_existing(_SYSTEM_ESPEAK_DATA)
    if lib and data:
        EspeakWrapper.set_library(lib)
        EspeakWrapper.set_data_path(data)
    return lib if (lib and data) else "espeakng-loader"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    import numpy as np
    import torch

    espeak = _setup_espeak()
    from kokoro import KModel, KPipeline

    mdir = args.model_dir
    weights = os.path.join(mdir, "kokoro-v1_0.pth")
    model = KModel(
        repo_id="hexgrad/Kokoro-82M",
        config=os.path.join(mdir, "config.json"),
        model=weights,
    )
    model = model.to(args.device).eval()
    pipelines = {}
    voices = {}
    print(f"[kokoro_worker] ready device={args.device} espeak={espeak}", flush=True)
    _proto.write(json.dumps({"ok": True, "ready": True}) + "\n")
    _proto.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = str(req.get("text") or "").strip()
            voice = str(req.get("voice") or "")
            speed = float(req.get("speed") or 1.0)
            out = str(req["out"])
            if not text:
                raise ValueError("empty text")
            if not voice or "/" in voice or "\\" in voice or voice.startswith("."):
                raise ValueError(f"bad voice id {voice!r}")
            lang = voice[0]
            if lang not in SUPPORTED_LANGS:
                raise ValueError(f"voice {voice!r}: language '{lang}' not installed")
            vpath = os.path.join(mdir, "voices", voice + ".pt")
            if not os.path.isfile(vpath):
                raise ValueError(f"voice {voice!r} not found in {mdir}/voices")
            if voice not in voices:
                voices[voice] = torch.load(vpath, weights_only=True)
            if lang not in pipelines:
                pipelines[lang] = KPipeline(
                    lang_code=lang, repo_id="hexgrad/Kokoro-82M", model=model
                )
            chunks = []
            for result in pipelines[lang](
                text, voice=voices[voice], speed=max(0.5, min(2.0, speed))
            ):
                audio = result.audio if hasattr(result, "audio") else result[2]
                if audio is not None:
                    chunks.append(audio.detach().cpu().numpy().astype(np.float32))
            if not chunks:
                raise ValueError("no audio produced (text had nothing speakable?)")
            pcm = np.concatenate(chunks).astype("<f4")
            with open(out, "wb") as f:
                f.write(pcm.tobytes())
            reply = {"ok": True, "samples": int(pcm.shape[0]), "sample_rate": SAMPLE_RATE}
        except Exception as e:  # report and keep serving
            reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        _proto.write(json.dumps(reply) + "\n")
        _proto.flush()


if __name__ == "__main__":
    main()
