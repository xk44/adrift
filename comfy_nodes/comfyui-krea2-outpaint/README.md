# comfyui-krea2-outpaint

These ComfyUI nodes run the [yijunwang2/krea2-outpaint](https://huggingface.co/yijunwang2/krea2-outpaint) LoRA, a rank-32 LoRA for Krea 2 Turbo. The reference image is registered at a bbox on the output canvas.

| Node | What it does |
| --- | --- |
| `TextEncodeKrea2Outpaint` | Encodes the prompt and the source image, and records where the source sits on the canvas (`reference_placements`). |
| `Krea2OutpaintModelPatch` | Runs the reference-edit patch with each reference's token grid stretched over its canvas bbox. Without this, the source sits at the grid origin and the model invents a new scene around it. |
| `Krea2OutpaintComposite` | Blends the original source back into the generated canvas at its bbox with a multiband (Laplacian pyramid) blend (`seam_blend.py`, pure numpy). The interior stays verbatim and the seam disappears. |

The placement rule for reference grid `rh x rw`, normalized bbox `(x0, y0, x1, y1)` and target grid `Th x Tw`:

```
ys = y0*Th + (arange(rh)+0.5)*((y1-y0)*Th/rh) - 0.5
xs = x0*Tw + (arange(rw)+0.5)*((x1-x0)*Tw/rw) - 0.5      frame axis stays i+1
```

## Requirements

- Install [ostris/ComfyUI-Krea2-Ostris-Edit](https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit) as `custom_nodes/ComfyUI-Krea2-Ostris-Edit`.
  - This pack loads a private instance of that pack's `nodes.py` and calls its `Krea2OstrisEditModelPatch` and `TextEncodeKrea2OstrisEdit` unchanged.
  - The only change is the reference position ids. While a patched forward runs, `_pack_refs` is temporarily wrapped so it returns bbox positions. The wrap is per-instance and locked, so the Ostris nodes ComfyUI loaded are never affected.
  - No Ostris code is copied here.
- Get the LoRA weights from the Hugging Face repo above. They are licensed under the Krea 2 Community License.

## Test

From the ComfyUI checkout, run:

```
venv/bin/python <path>/comfyui-krea2-outpaint/selftest.py
```

This runs on CPU with a tiny DiT and needs no weights. It checks:
- the bbox RoPE ids;
- that with no placement the output is bitwise the stock Ostris forward;
- that a placement changes the output and leaves `_pack_refs` restored;
- that the model-patch path matches the bare forward;
- odd-size padding.

## License

MIT, as part of Adrift. The placement rule and the composite approach come from the LoRA repo's Apache-2.0 reference pipeline. See `NOTICE`.
