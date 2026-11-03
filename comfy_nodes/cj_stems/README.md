# cj_stems

`CJAudioStems` splits a song into four stems (drums, bass, other, vocals) with Hybrid Demucs, using torchaudio's `HDEMUCS_HIGH_MUSDB_PLUS` model. The Adrift "Music video" tool runs it as an optional first step: it detects beats on the drum stem, and it can use the vocal stem as the H3 audio guide for lip-sync segments.

It needs no new dependencies, because torch and torchaudio already ship with ComfyUI.

## Setup

Put the state dict at `ComfyUI/models/demucs/hdemucs_high_trained.pt`. It is torchaudio's `HDEMUCS_HIGH_MUSDB_PLUS` checkpoint (about 335 MB). The node registers `models/demucs` as the `demucs` folder. If your models live somewhere else, add a `demucs:` entry to `extra_model_paths.yaml`, for example:

```yaml
aidata:
  base_path: /mnt/models/
  demucs: demucs/
```

The node never downloads anything. It builds the network with `torchaudio.models.hdemucs_high()` and loads the file with `torch.load(..., weights_only=True)`. It does not call `bundle.get_model()`. If the file is missing, the node raises an error.

Then copy or symlink this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.

## Inputs

| input             | default                   | notes                                                                                  |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `audio`           | (required)                | ComfyUI AUDIO, at any sample rate, mono or stereo. It is resampled to 44.1 kHz stereo. |
| `weights`         | `hdemucs_high_trained.pt` | A file in the `demucs` folder.                                                         |
| `segment_seconds` | `10.0`                    | Chunk length. Peak VRAM depends on this value, not on the song length.                 |
| `overlap`         | `0.25`                    | The fraction of each chunk that is cross-faded with the next chunk.                    |
| `keep_loaded`     | `false`                   | When off, the model is dropped after each run and the CUDA cache is emptied.           |

## Outputs

There are four AUDIO outputs: `drums`, `bass`, `other` and `vocals`. Each is 44.1 kHz stereo and matches the input's batch size and length.

## Tests

`tests/test_audio_stems.py` builds a tiny HDemucs with random weights and covers chunking, blending, resampling and weight resolution. Run it with ComfyUI's venv Python:

```bash
CUDA_VISIBLE_DEVICES= python -I comfy_nodes/cj_stems/tests/test_audio_stems.py comfy_nodes/cj_stems/cj_audio_stems.py
```
