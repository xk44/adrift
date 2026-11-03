# cj_kokoro_tts

`CJKokoroTTS` is a ComfyUI node for [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text-to-speech (Apache-2.0). Its output is AUDIO at 24 kHz mono.

kokoro/misaki support Python 3.10–3.12, but ComfyUI often runs on something newer. So the node keeps one worker process (`kokoro_worker.py`) running in a separate venv and talks to it over stdin/stdout. The model loads once, in about 2 s, and on CPU it renders roughly 8× faster than real time.

## Setup

1. Weights go in `models/tts/kokoro/Kokoro-82M/`:
   - `config.json`
   - `kokoro-v1_0.pth`
   - `voices/*.pt`

   All three come from `hexgrad/Kokoro-82M`.

2. Create the venv (CPU torch is enough):
   ```bash
   python3.12 -m venv /path/to/kokoro-venv
   /path/to/kokoro-venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
   /path/to/kokoro-venv/bin/pip install "kokoro==0.9.4" "misaki[en]==0.9.4" \
     "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
   ```
   Installing `en_core_web_sm` up front stops misaki from downloading it at runtime.
3. Before starting ComfyUI, `export KOKORO_PYTHON=/path/to/kokoro-venv/bin/python`. If you skip this, the node falls back to a `venv/` folder next to it.
4. Optional:
   - `KOKORO_DEVICE=cuda`
   - `KOKORO_ESPEAK_LIB` and `KOKORO_ESPEAK_DATA`. By default the worker uses the system espeak-ng (`apt install espeak-ng`, `brew install espeak-ng`) when it finds one, and espeakng-loader's bundled copy otherwise.

## Behaviour

The worker runs offline: `HF_HUB_OFFLINE=1`, and every file it needs is read from the model dir.

Voices are listed from `voices/`. Supported languages are American and British English, Spanish, French, Hindi, Italian, and Brazilian Portuguese. Japanese and Chinese voices are hidden because they need the `misaki[ja]` / `misaki[zh]` extras.
