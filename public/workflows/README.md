# Workflow Templates

This directory contains ComfyUI workflow templates used by Adrift for various image operations.

## Required Templates

The registry (`src/lib/oj/registry.json`) references these workflow templates. Create them by exporting workflows from ComfyUI:

### Basic Templates
- `t2i.json` - Text to Image (basic generation)
- `i2i.json` - Image to Image (transform existing image)
- `inpaint.json` - Inpainting (edit masked regions)
- `upscale.json` - Simple upscale
- `controlnet.json` - ControlNet guided generation

### Action Templates
- `vary_subtle.json` - Subtle variation (denoise ~0.25)
- `vary_strong.json` - Strong variation (denoise ~0.65)
- `upscale_subtle.json` - Subtle upscale (1.5x-2x)
- `upscale_creative.json` - Creative upscale with detail generation
- `remix_subtle.json` - Subtle remix (denoise ~0.35)
- `remix_strong.json` - Strong remix (denoise ~0.75)
- `outpaint.json` - Outpainting (pan/zoom operations)

## How to Create Templates

1. **Build in ComfyUI**: Create the workflow in ComfyUI's interface
2. **Export**: Save the workflow as JSON (API format preferred)
3. **Place here**: Copy the file to `public/workflows/<name>.json`

## Workflow Requirements

Each workflow should include these common nodes:

### Text to Image (t2i.json)
- `CheckpointLoaderSimple` or `UNETLoader` - Model loading
- `CLIPTextEncode` (positive) - Prompt encoder
- `CLIPTextEncode` (negative) - Negative prompt
- `EmptyLatentImage` - Latent size
- `KSampler` - Main sampler
- `VAEDecode` - Latent to pixels
- `SaveImage` or `PreviewImage` - Output

### Image to Image (i2i.json, vary_*.json)
- Same as t2i, plus:
- `LoadImage` - Source image input
- `VAEEncode` - Pixels to latent
- KSampler `denoise` < 1.0

### Inpaint (inpaint.json)
- `LoadImage` - Source image
- `LoadImage` - Mask (white = inpaint area)
- `VAEEncodeForInpaint` - Inpaint latent
- Inpaint-capable KSampler setup

### Upscale (upscale_*.json)
- `LoadImage` - Source image
- `UpscaleModelLoader` + `ImageUpscaleWithModel`, OR
- `ImageScale` + model for creative upscale

### Outpaint (outpaint.json)
- `LoadImage` - Source image
- `ImagePadForOutpaint` or similar
- Parameters for direction/zoom

## Node Discovery

The engine uses `discoverRequiredInputs` and `discoverInpaintSlots` to automatically find nodes by type. 
Your workflows should use standard node types for automatic parameter injection.

## Missing custom nodes

Before submit, the graph is checked against ComfyUI's live `/object_info`.
Missing node classes fail the job loudly, except:

- **Optional nodes**: set `"_meta": { "optional": true }` on a node that only
  refines its inputs (e.g. `ApplyKrea2NegPiP` in `krea2_draft.json`). When its
  class is missing, consumers of its outputs are rewired to its matching
  pass-through inputs (by `_meta.passthrough` `{ "<outputIndex>": "<input>" }`,
  else by type, else by input name, else by position; chains resolve) and the
  node is dropped. `_meta.optional_warning` is shown to the user as a toast.
- **Graph fallback**: a top-level `"_fallback": { "file": "<path under
  public/workflows>", "warning": "..." }` swaps the whole graph when its
  required nodes are missing (e.g. `packs/krea2/outpaintv2.json` falls back to
  the core `ImagePadForOutpaint` graph `packs/krea2/outpaint.json`). One level
  only; both checks fail open when ComfyUI is unreachable.

## Testing Templates

After creating a template:
1. Restart Adrift app
2. Test via the corresponding action button in the UI
3. Check ComfyUI console for workflow errors

## Template Parameters

The engine injects these parameters automatically:
- Prompt text → positive/negative CLIPTextEncode
- Seed → KSampler.seed
- Steps → KSampler.steps
- CFG → KSampler.cfg
- Width/Height → EmptyLatentImage
- Model → CheckpointLoaderSimple/UNETLoader
- VAE → VAELoader
- LoRA → LoraLoader chain

For action workflows:
- `source_image` → LoadImage nodes (first found)
- `source_images` → Multiple LoadImage nodes
- `mask` → Inpaint mask LoadImage
- `denoise` → KSampler.denoise (for i2i actions)