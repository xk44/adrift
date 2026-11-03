# comfyui-krea2-anypaint

These ComfyUI nodes run the [yijunwang2/krea2-anypaint](https://huggingface.co/yijunwang2/krea2-anypaint) LoRA for arbitrary-mask inpaint and outpaint. It is a rank-32 LoRA for Krea 2 Turbo; use 8 steps, euler/simple, cfg 1.

| Node | What it does |
| --- | --- |
| `Krea2AnyPaintPrepare` | Takes the source, the mask and the canvas/bbox. Returns a condition image (edge ≤384, a multiple of 16), the known image, a keep mask and a generated mask. |
| `TextEncodeKrea2AnyPaint` | Encodes the prompt and the condition image through Qwen3-VL. The condition goes in as a reference latent registered over the full canvas. |
| `Krea2AnyPaintModelPatch` | Isolated reference attention. The reference tokens run once at t=0, and their cached K/V are appended on every step, with RoPE ids registered to the bbox. |
| `Krea2AnyPaintKnownLatent` | Produces the VAE-encoded known image and a token-level `noise_mask`. A 2×2 patch counts as known only if all of it is kept. |

For Euler, ComfyUI's native `noise_mask` inpainting follows the same trajectory as the reference pipeline's known-token restoration. That means a stock KSampler with this latent reproduces the pipeline's loop.

## Requirements

- Install [ostris/ComfyUI-Krea2-Ostris-Edit](https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit) as `custom_nodes/ComfyUI-Krea2-Ostris-Edit`.
  - `Krea2AnyPaintModelPatch` is that pack's `Krea2OstrisEditModelPatch` with `kv_cache=True`.
  - The only change is a temporarily wrapped `_pack_refs`, applied to a private module instance under a lock, which returns bbox-registered positions.
  - No Ostris code is copied here.
- Get the LoRA weights from the Hugging Face repo above. They are licensed under the Krea 2 Community License.

## Test

From the ComfyUI checkout, run:

```
venv/bin/python <path>/comfyui-krea2-anypaint/selftest.py
```

This runs on CPU with a tiny DiT and needs no weights. It checks the preparation contract, including parity with cv2 dilation, and the token noise mask. It also checks that the cached forward matches an independently written masked joint pass.

## License

MIT, as part of Adrift. It follows the LoRA repo's Apache-2.0 reference pipeline. See `NOTICE`.
