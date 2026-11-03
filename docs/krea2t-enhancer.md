# Krea2T-Enhancer

The Krea2T-Enhancer is a third-party ComfyUI node that makes Krea 2 follow the
prompt more closely. Adrift's Krea 2 text-to-image graphs run every image
through it, so it is a **required** node pack for the Krea 2 engine.

- Node class: `ComfyUI-Krea2T-Enhancer` (category `conditioning/krea2`)
- Pack: [metalust/ComfyUI-Krea2T-Enhancer](https://github.com/metalust/ComfyUI-Krea2T-Enhancer),
  pinned in [custom-nodes.md](custom-nodes.md#krea2t-enhancer). MIT license.
- Original author: capitan01R. The original repository is offline; the pin is a
  verbatim public snapshot (details in [custom-nodes.md](custom-nodes.md#krea2t-enhancer)).

## What it does

Krea 2 conditions its transformer on text features tapped from 12 layers of
its Qwen3-VL text encoder (12 × 2560 values per token), fused by the model's
`txtfusion` / `txtmlp` layers. The Enhancer wraps the diffusion model and, on
each sampling step, re-weights those 12 taps with a fixed per-layer profile
before they enter the shared stream:

```
layer:   1   2   3   4   5   6   7   8    9    10   11   12
weight: 1.0 1.0 1.0 1.0 1.0 1.0 1.0 2.5  5.0  1.1  4.0  1.0
```

Layers 8, 9 and 11 carry most of the prompt detail (objects, counts,
attributes), so boosting them makes those details show up more reliably. The
node returns a patched `MODEL`; it does not change the prompt text, the
conditioning or the sampler. If the loaded model does not have Krea 2's
text-fusion layout, the patch is skipped and the model runs unchanged.

Inputs:

| Input      | Default in the node | Value in Adrift's graphs | Meaning                                                     |
| ---------- | ------------------- | ------------------------ | ----------------------------------------------------------- |
| `model`    |                     | Krea 2 diffusion model   | Output of `UNETLoader` (or `UnetLoaderGGUF`)                |
| `enabled`  | `true`              | `true`                   | Turns the patch on or off                                   |
| `strength` | `1.0`               | `0.1`                    | Blend from neutral `0.0` to full `2.0`                      |
| `debug`    | `false`             | `false`                  | Prints short diagnostics to the ComfyUI console when `true` |

## Where Adrift uses it

The Enhancer sits between the model loader and the sampler:

```
UNETLoader (Krea 2) -> ComfyUI-Krea2T-Enhancer -> KSampler
CLIPLoader (qwen3vl_4b, type krea2) -> CLIPTextEncode -> ConditioningKrea2Rebalance -> KSampler
```

| Graph                                                                     | Engine / tool                                     | Diffusion model                           |
| ------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| `public/workflows/packs/krea2/t2i.json`                                   | Krea 2 (Turbo), Create page                       | `krea2_turbo_bf16.safetensors`            |
| `public/workflows/packs/krea2-raw/t2i.json`                               | Krea 2 Raw (8 steps with turbo LoRA)              | `krea2_raw_bf16.safetensors`              |
| `public/workflows/krea2_t2i.json`                                         | Krea 2, fp8 variant                               | `krea2_turbo_fp8_scaled.safetensors`      |
| `public/workflows/krea2_t2i_mac.json`                                     | Krea 2 on Apple Silicon (bf16, no fp8)            | `krea2_turbo_bf16.safetensors`            |
| `public/workflows/krea2_draft.json`                                       | Krea 2 draft (low VRAM)                           | `Krea-2-Turbo-Q4_K_M.gguf` (ComfyUI-GGUF) |
| `public/workflows/packs/krea2/control_depth.json`, `control_regions.json` | Krea 2 restyle from depth, layout from region map | `krea2_turbo_bf16.safetensors`            |

The Krea 2 edit tools (Edit photo, Inpaint, Outpaint, Remove object and the
other Krea 2 LoRA tools) do not use the Enhancer.

## Models

The Enhancer has no weights of its own. It needs a Krea 2 model and Krea 2's
text encoder and VAE:

| File                                                                                        | Folder under `ComfyUI/models/` | License                               |
| ------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------- |
| `krea2_turbo_bf16.safetensors` (or the fp8 / GGUF variant, or `krea2_raw_bf16.safetensors`) | `diffusion_models/`            | Krea 2 Community License (restricted) |
| `qwen3vl_4b_bf16.safetensors`                                                               | `text_encoders/`               | Apache-2.0                            |
| `qwen_image_vae.safetensors`                                                                | `vae/`                         | Apache-2.0                            |

Sources and sizes are in [models.md](models.md); license terms are in
[MODELS.md](../MODELS.md).

The same graphs also need two other Krea 2 node packs: `comfyui-krea2-conditioning`
(for `ConditioningKrea2Rebalance`) and `ComfyUI-krea2-negpip`. All three are in
the Quick install block of [custom-nodes.md](custom-nodes.md#quick-install).

## Install

From your ComfyUI `custom_nodes/` folder:

```bash
git clone https://github.com/metalust/ComfyUI-Krea2T-Enhancer ComfyUI-Krea2T-Enhancer
git -C ComfyUI-Krea2T-Enhancer checkout b15ba7f8d4b9eb695e434d605934fe94fb77e3fa
```

Or install every pinned pack at once from the Adrift folder:
`python3 docker/install-comfy-packs.py /path/to/ComfyUI/custom_nodes`.
No extra Python packages are needed. Restart ComfyUI, then check that
`GET /api/health?nodes=1` no longer lists `ComfyUI-Krea2T-Enhancer` as missing.

## How to use it

You do not add the node yourself: pick the Krea 2 engine and prompt as usual.
Two prompt flags change what it does:

| Flag                                        | Range     | Effect                                                                                                                                                                      |
| ------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--stylization <v>` (`--krea-stylization`)  | 0 to 1.5  | Sets the Enhancer `strength` to `v`. Also sets each `ConditioningKrea2Rebalance` layer weight to `1 + v × (profile − 1)`, using the profile above.                          |
| `--s <n>` / `--stylize <n>`                 | 0 to 1000 | Same as `--stylization n/1000` on Krea 2 (`--s 100` = 0.1, `--s 500` = 0.5). On Krea 2 it does not change CFG.                                                              |
| `--krea-mm <t>` (`--minimalism-maximalism`) | −1 to 1   | Tilts the Rebalance weights: positive values weight the later layers more (busier, more detailed), negative values the earlier ones (simpler). Does not touch the Enhancer. |

Without these flags the graph runs as saved: Enhancer strength `0.1`, and the
Rebalance node at the full profile with multiplier 4. Any of the flags replaces
the saved Rebalance weights with the formula above, so `--s 100` gives weights
close to 1.0 (weaker than the saved profile) and `--s 1000` gives the full
profile. `--krea-mm` alone counts as stylization 0: flat weights with only the
tilt applied.

Example:

```
a red bicycle leaning on a blue door, three potted cacti --ar 3:2 --s 300
```

Tips:

- Start at the default and raise `--s` to 300 to 600 when the image drops
  objects, counts or colors from the prompt. Very high values can make the
  image look over-processed.
- To see the effect, run the same prompt with `--seed 42 --s 0` and
  `--seed 42 --s 500`.
- To turn the node off in a graph you open in ComfyUI, set `enabled` to
  `false`; the rest of the graph runs unchanged.

## Troubleshooting

- **Card or engine disabled, "missing node ComfyUI-Krea2T-Enhancer".** The pack
  is not installed or ComfyUI was not restarted. Install it as above.
- **No visible change.** The patch is skipped when the model is not a Krea 2
  model. Set `debug` to `true` in ComfyUI and check the console output.
- **Errors after a ComfyUI update.** Check that the pack is at the pinned
  commit above; other copies are untested.
