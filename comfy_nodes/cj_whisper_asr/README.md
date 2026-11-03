# cj_whisper_asr

`CJWhisperASR` is a ComfyUI node that runs a local Whisper checkpoint (Hugging Face format) through the `transformers` speech-recognition pipeline. The Adrift "Dub video" tool uses it as its first step.

It needs no new dependencies: torch, numpy and transformers already ship with ComfyUI. For resampling it uses torchaudio, or scipy if torchaudio is missing, and falls back to numpy if neither is installed.

## Setup

Put a Whisper checkpoint in `ComfyUI/models/stt/whisper/whisper-large-v3-turbo`, for example:

```bash
hf download openai/whisper-large-v3-turbo --local-dir ComfyUI/models/stt/whisper/whisper-large-v3-turbo
```

The `model_path` input takes either an absolute directory or a name relative to ComfyUI's `stt` model folder. The default is `whisper/whisper-large-v3-turbo`. The node registers `models/stt` as the `stt` folder, and an `stt:` entry in `extra_model_paths.yaml` adds more places to look; relative names are tried in each of them, then under `ComfyUI/models` itself (so `stt/whisper/whisper-large-v3-turbo` also works). The directory needs `config.json`, `preprocessor_config.json`, the tokenizer files and `model.safetensors`.

The node works offline only. It loads with `local_files_only=True` (no process-wide env changes), so if the directory is missing or incomplete you get an error and nothing is downloaded.

Then copy or symlink this folder into `ComfyUI/custom_nodes/`.

## Inputs

| input               | default      | notes                                                                                              |
| ------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `audio`             | (required)   | ComfyUI AUDIO. Only the first batch item is used. It is downmixed to mono and resampled to 16 kHz. |
| `language`          | `auto`       | Whisper language name. `auto` lets the model detect it.                                            |
| `task`              | `transcribe` | `translate` is Whisper's built-in translation into English. large-v3-turbo was trained for transcription only and mostly ignores it (returns the source language); use large-v3 for it. The Dub tool translates with an LLM instead. |
| `model_path`        | see above    | local checkpoint dir                                                                               |
| `return_timestamps` | `true`       | When off, the segment list holds a single segment covering the whole clip.                         |
| `device`            | `auto`       | Picks CUDA when it is available. Uses fp16 on CUDA and fp32 on CPU.                                |
| `keep_loaded`       | `false`      | When off, the pipeline is dropped after each run and the CUDA cache is emptied.                    |

## Outputs

- `transcript` (STRING): plain text.
- `segments_json` (STRING): `[{"start": 0.0, "end": 2.4, "text": "..."}]`, with times in seconds relative to the clip.

For clips longer than 30 s, the node always requests timestamp tokens, because Whisper's long-form decoding depends on them.

large-v3-turbo puts segment boundaries on a coarse grid (often 0.5 s steps), and a boundary can clip the last word of a line. The node moves each shared boundary to the quietest 30 ms within ±0.35 s, but only when that point is under half the loudness at the original boundary. Lines spoken back to back keep Whisper's estimate.

## Test

`tests/test_whisper_helpers.py` checks the pure helpers (downmix/resample, segment parsing) on CPU and does not need the model:

```bash
python -I tests/test_whisper_helpers.py cj_whisper_asr.py
```

To run a real transcription on CPU, add `--model /path/to/whisper --audio clip.wav`.

## License

MIT, the same as the rest of this repository. Whisper weights are MIT (OpenAI).
