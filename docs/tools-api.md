# LoRA edit tools API

Server-side catalog of edit LoRAs ("tools") plus a job endpoint. Web, iOS and
Mac clients all use the same two routes. Auth, rate limit (30/min on POST) and
CORS match `/api/jobs/action`.

Source of truth: `src/lib/tools/editToolRegistry.json` (typed by
`src/lib/tools/editTools.ts`). Add a tool by adding an entry there.

## Tools

| id | base | refs | prompt | notes |
|---|---|---|---|---|
| `qwen21-outpaint` | Qwen-Image 2.1 | 1 | none | server pads canvas with #808080 |
| `qwen21-restore` | Qwen-Image 2.1 | 1 | optional | keepFraming, fast |
| `qwen21-camera` | Qwen-Image 2.1 | 1 | optional | options azimuth / elevation / distance |
| `qwen21-outfit-swap` | Qwen-Image 2.1 | 2 (person, outfit) | optional | keepFraming, fast |
| `qwen21-unblur-background` | Qwen-Image 2.1 | 1 | none | keepFraming (default on), fast |
| `krea2-general-edit` | Krea 2 (krea2edit) | 1 | required | |
| `krea2-inpaint` | Krea 2 (ostris) | 1 + mask | required | mask region black-filled server-side |
| `flux3-outpaint` | FLUX.3 Klein | 1 | none | server pads canvas with #808080 |
| `krea2-outpaint` | Krea 2 Turbo (8 steps) | 1 | none | no padding: registered bbox LoRA, ~1 MP canvas, 2 chained passes when the source spans neither axis |
| `krea2-anypaint` | Krea 2 Turbo (8 steps) | 1 + mask | required (describe the whole finished picture) | category Inpaint; prep `anypaint`, arbitrary-mask inpaint + optional canvas growth (`expand`), one pass, no fast mode |
| `qwen21-head-swap` | Qwen-Image 2.1 | 2 (target, face) | optional | fixed `head_swap:` prompt, user text appended, fast |
| `qwen21-body-swap` | Qwen-Image 2.1 | 2 (scene, person) | optional | fixed `body_swap:` prompt, fast |
| `krea2-head-swap` | Krea 2 Turbo (krea2edit) | 2 (base, reference head) | none | BFS head swap v1.1 for Krea 2; graph `packs/krea2-edit/swap_head.json` (action `swap_head`): both refs pre-scaled to 1 MP, wired to `Krea2EditModelPatch` (`source_*`/`source_*_b`) and both `Krea2EditGroundedEncode`s (`image`/`image_b`); grounding 512/768, 8 steps cfg 1; option `likeness` |
| `krea2-body-swap` | Krea 2 Turbo (krea2edit) | 2 (base, reference person) | optional | BFS body swap v1 (experimental), LoRA 0.5; graph `swap_body.json` (action `swap_body`), native grounding, 10 steps; user text appended to the `body_swap:` prompt (e.g. `BG: …`); option `likeness` |
| `qwen21-next-scene` | Qwen-Image 2.1 | 1 | required | category Story, LoRA strength 0.7, template `Next Scene: {prompt}`, 28 steps, fast |
| `qwen21-remove-box` | Qwen-Image 2.1 | 1 + mask | none | prep `redbox`, turbo LoRA, fast default on |
| `qwen21-doodle` | Qwen-Image 2.1 | 1 + mask | required | prep `scribble`, 40 steps, fast |
| `qwen21-anything2real` | Qwen-Image 2.1 | 1 | optional | category Restyle |
| `qwen21-pano360` | Qwen-Image 2.1 | 1 | required | equirectangular 360° pano; encoder `resolution` 1088 + empty 2:1 latent (option `size`: `1536` = 1536x768, `2048` = 2048x1024); no Turbo |
| `qwen21-character-sheet` | Qwen-Image 2.1 | 1 | none | server letterboxes the photo into a 1344x768 gray frame (`prep: letterbox`, uploaded); encoder `resolution` 0; option `sheet`: `angle-neck`/`pose-neck`/`angle-full`/`pose-full` (exact trained prompts); no Turbo |
| `qwen21-realism` | Qwen-Image 2.1 | 1 | none | fixed trained caption "convert this into a real phone photo", encoder `resolution` 768; subtle tone/color shift; no Turbo |
| `qwen2511-remove` | Qwen-Image-Edit 2511 | 1 | required | `Remove {prompt} from the image ...`, 30 steps cfg 4, fast |
| `qwen2511-unblur-upscale` | Qwen-Image-Edit 2511 | 1 | none | fixed prompt `unblur and upscale`, fast |
| `flux3-restore` | FLUX.3 Klein | 1 | optional | distilled graph, 8 steps, keepFraming (default off) |
| `flux3-camera` | FLUX.3 Klein | 1 | none | `<mva>` options azimuth / elevation / distance, base (undistilled) graph at 50 steps |
| `moss-restyle-depth` | MOSS-Image | 1 | required | category Restyle; Depth Anything 3 depth map → `MOSSImageControl` (control LoRA `moss-control`) + DeBand LoRA; options `structure`, `depth`; fast (8-step DMD) default on |
| `krea2-restyle-depth` | Krea 2 Turbo | 1 | required | category Restyle; DA3 depth map → `Krea2DualControlApply` (darask0 color-depth adapter `krea2-control.safetensors`, CJ node `comfy_nodes/cj_krea2_dual_control`); options `structure`, `depth`; 8 steps cfg 1 |
| `krea2-layout-regions` | Krea 2 Turbo | 1 | required | category Compose; flat-color region map (colors = region IDs, black = unspecified) → nearest resize → `Krea2DualControlApply` color slot, no depth; option `layout`; 8 steps cfg 1 |

Consistency (`keepFraming`) and lightning (`fast`) are options, not tools.
`fast` = the speed LoRA of the tool's base (Qwen 2.1 / Qwen 2511 Lightning: 4 steps, cfg 1 / cfg 2; MOSS DMD: 14 steps;
Krea 2: lvladikov `krea2_turbo_4step_rank_64_lora_comfyui` @1.0, 4 steps cfg 1, loras root). Krea 2 keeps 8-step as the
default and offers 4-step on every Turbo tool (`krea2-general-edit`, `-outpaint`, `-head-swap`, `-body-swap`,
`-restyle-depth`, `-layout-regions`); the LoRA is appended after the tool LoRA, so outpaint's two passes both run 4 steps.
`krea2-inpaint` runs on Krea 2 Raw and has no fast mode. The 4-step LoRA was trained for t2i; stacked on the edit/outpaint
LoRAs it is unverified, which is why it is opt-in.
`keepFraming` is per base: Qwen 2.1 uses its consistency LoRA, FLUX.3 uses
`flux-3-image-klein-consistency` (only offered on `flux3-restore`, default off: it can fight hair-colour/pose edits).

Bases: `qwen21`, `krea2`, `flux3`, and `qwen2511` (Qwen-Image-Edit 2511, pack `qwen-image-edit`,
workflow `packs/qwen-image-edit/edit.json`, Apache-2.0). The 2511 graph encodes with
`TextEncodeQwenImageEditPlus`; its fixed latent is resized to the source aspect like Krea 2. The 2511 lightning
LoRA lives at the loras root (not `edit_tools/`). Several Qwen 2.1 tools carry a per-tool `license` override with
`commercial: false` because the base model's Qwen Research License governs.

`moss` (MOSS-Image, pack `moss-image`, workflow `packs/moss-image/restyle_depth.json`, graph family `moss`):
t2i graph whose conditioning goes through `MOSSImageControl` with a depth map rendered from the source image
(`LoadDA3Model` → `DA3Inference` mono → `DA3Render` depth v2_style → `ImageScale`). The latent and the depth map are
both resized to the source aspect (~1 MP) since the node VAE-encodes the map into the concat latent. `fast` adds
`moss_image_sft_8step_dmd` @0.4 (14 steps, cfg 3) plus the MOSS speed recipe (er_sde/simple, TSR, SLG). Availability
also requires the DA3 weights every `depth` option can pick, in `models/geometry_estimation/`.

`krea2control` (Krea 2 Turbo, pack `krea2`, workflow `packs/krea2/control_depth.json`, graph family `krea2control`):
the Krea 2 t2i graph with the same DA3 depth chain feeding the CJ node `Krea2DualControlApply`. darask0's adapter
widens the DiT input projection to [noisy | color | depth] packed latents and adds a rank-64 LoRA; the node swaps the
projection per forward call (zero latent = no control) and loads the LoRA through core ComfyUI. `krea2-restyle-depth`
wires only the depth slot; `krea2-layout-regions` (workflow `packs/krea2/control_regions.json`, action
`control_regions`) wires only the color slot from the uploaded map, resized nearest-exact so region edges stay flat.
The adapter reads map colors as region IDs (trained on COCO panoptic maps), never as a palette. Latent + depth map follow the source aspect. Availability requires the adapter file in
`models/loras/` plus the DA3 weights; the node ships in this repo and is symlinked into `custom_nodes/`.

## Mask preps

Tools with `needsMask` set `prep`; the mask is required and the server turns image + mask into the model input.
`maskHint` (string or null in `GET /api/tools`) is the one-line instruction clients show above the painter.

| prep | tools | server behaviour |
|---|---|---|
| `maskfill` | `krea2-inpaint` | masked area filled solid black |
| `redbox` | `qwen21-remove-box` | bounding box of each mask connected component (8-connected, specks under 4 px dropped, max 12 largest) outlined in RGB(239,68,68), stroke max(3, 0.006 x short side) px, drawn just outside the box, clamped to the frame |
| `scribble` | `qwen21-doodle` | mask white pixels painted opaque RGB(255,0,255); the mask is the scribble (a thin outline works best) |
| `anypaint` | `krea2-anypaint` | source left untouched; the mask is binarized to a source-sized RGB 0/255 PNG and uploaded as `cj_tool_<id>_anypaint_mask.png` (white = generate). The mask may be omitted, or empty, only when `expand` grows the canvas |

Mask threshold is 128 after flattening transparency to black; empty mask gives `invalid_geometry`.
The prepped image is uploaded as `cj_tool_<id>_<prep>.png`.

## GET /api/tools

```json
{ "ok": true, "tools": [ {
  "id": "qwen21-camera", "label": "...", "category": "...",
  "base": "qwen21", "baseLabel": "...", "description": "...",
  "loras": [{ "file": "edit_tools/....safetensors", "strength": 1 }],
  "extras": { "keepFraming": null },
  "speed": { "supported": false },
  "defaults": { "steps": 30, "cfg": 3 },
  "refCount": 1, "refLabels": ["Image"],
  "needsMask": false,
  "maskHint": null,
  "outpaint": null,
  "promptMode": "optional",
  "promptTemplate": "<qma> {azimuth} {elevation} {distance} {prompt}",
  "promptHint": "...",
  "options": [ { "id": "azimuth", "label": "Azimuth", "type": "enum", "default": "front-right",
                 "values": [ { "id": "front-right", "label": "Front right", "text": "front-right quarter view" } ] } ],
  "requiresNodes": null,
  "license": { "name": "...", "commercial": false, "note": "..." },
  "sourceUrl": "https://...",
  "installed": true, "packAvailable": true, "available": true
} ] }
```

- `installed`: every LoRA file the tool needs exists under
  `COMFY_ROOT/models/loras` (recursive, case-insensitive, subfolders ok).
- `packAvailable`: base workflow file exists and its UNET weight is in
  `models/diffusion_models` or `models/unet`.
- `missingNodes`: node classes the tool's graph needs that ComfyUI's live
  `/object_info` lacks (`[]` when all present or ComfyUI is unreachable).
  Non-empty forces `packAvailable: false`; nodes marked `_meta.optional` that
  can be bypassed are not counted.
- `available` = `installed && packAvailable`. Disable the tool in UI when false.
- `extras.keepFraming` (when non-null): `{ label, description, default, available }`.
- `speed` (when supported): `{ supported, default, available, steps, cfg, label }`; `label` names the LoRA for the toggle hint ("Lightning", "DMD", "4-step distill").
- `outpaint` (outpaint tools): `{ default, fill: "#808080", maxSide, presets: [{id,label,sides?|aspect?,anchor?}] }`.
- `license.commercial`: `true` ok, `false` non-commercial (Qwen tools), `null` conditional: `license.badge` says which (`cap` revenue-capped community license, `check` terms not confirmed; read `license.source`). Show it.

## POST /api/jobs/tool

Request:

```json
{
  "toolId": "qwen21-outpaint",
  "images": ["photo.png [input]"],
  "mask": "data:image/png;base64,...",
  "prompt": "optional text",
  "options": { },
  "client_id": "optional"
}
```

`images` entries (length must equal the tool's `refCount`):
- annotated ComfyUI ref `"sub/name.png [input|output|temp]"` (e.g. from `/api/comfy/upload`)
- ComfyUI `/view?filename=..&subfolder=..&type=..` URL
- `{ "run_id": "...", "job_index": 0 }` (first image of an active run; the new run inherits its params, size, and `action_source_run_id`)

`mask` (only for `needsMask` tools, required there): `data:image/(png|jpeg|webp);base64,...`
or annotated ref. White = area to regenerate; transparent counts as black. Resized to the image.
Krea 2 inpaint: the masked area is filled solid black before sending to the model; the result is
a whole-frame re-render (not composited back).

`options` (all optional):
- `fast` boolean (supported tools only), `keepFraming` boolean (supported tools only)
- `steps` int 1..100, `cfg` number 0..20, `seed` int 0..2147483647
- flux3-camera enums: `azimuth` (front, front-right, right, back-right, back, back-left, left, front-left),
  `elevation` (low-angle, eye-level, elevated, high-angle, top-down), `distance` (none, close-up)
- tool enums by option id, e.g. camera: `azimuth` (front, front-right, right, back-right, back, back-left, left, front-left),
  `elevation` (low-angle, eye-level, elevated, high-angle), `distance` (close-up, medium, wide)
- moss-restyle-depth enums: `structure` (strict = control to end_percent 1.0, loose = 0.5 so late steps can drift),
  `depth` (base = `depth_anything_3_base`, large = `depth_anything_3_mono_large`)
- krea2-restyle-depth enums: `structure` (strict = depth control on every step, loose = off after 60% of steps), `depth` (as MOSS)
- krea2-layout-regions enums: `layout` (strict = region map on every step, loose = off after 40% of steps, the model card's "early control")
- krea2-head-swap / krea2-body-swap enums: `likeness` (classic = `ref_boost` 1.0, strong = 4.0, the BFS workflow's recommended preset; pulls harder toward the second image. Above ~10 the model over-copies)
- outpaint tools: `outpaint` = preset id string (`all_25`, `all_50`, `widen_50`, `tall_50`, `left_50`, `right_50`,
  `top_50`, `bottom_50`, `aspect_16_9`, `aspect_9_16`, `aspect_4_3`, `aspect_3_4`, `aspect_1_1`; default `all_25`) or
  `{ left, right, top, bottom }` (fractions 0..maxSide of the image width/height; at least one > 0) or
  `{ aspect: "16:9", anchor: "center|left|right|top|bottom" }` (ratio 1:4..4:1). Canvas rounded up to a multiple of 16,
  capped at 2048x2048 px (source downscaled if needed). For the qwen21/flux3 outpaint tools the padding is solid
  #808080, done server-side. `krea2-outpaint` does not pad: it plans a ~1 MP canvas with an 8 px-snapped bbox, runs the
  registered bbox LoRA in 1-2 chained passes and composites the source back (`fill` is unused). It needs
  `comfyui-krea2-outpaint` (which loads `ComfyUI-Krea2-Ostris-Edit`); without it the tool reports `missingNodes` and
  the Outpaint card falls back to the next available backend.
- krea2-anypaint enum: `expand` = `none` (default, same canvas) or one of the outpaint preset ids `all_25`, `widen_50`,
  `tall_50`, `left_50`, `right_50`, `top_50`, `bottom_50`, `aspect_16_9`, `aspect_9_16`, `aspect_1_1`. The new border is
  generated together with the painted mask in one pass. The tool is not part of the Outpaint card (`outpaint: null`).

Prompt: `{prompt}` in `promptTemplate` is the user text; `none` tools ignore it; `required` tools 400 without it.
Max 2000 chars.

Success (200) is identical in shape to `/api/jobs/action`:

```json
{ "ok": true, "request_id": "uuid", "run": {
  "run_id": "uuid", "action": "tool_qwen21-camera", "status": "queued",
  "prompt": "...", "parsedPrompt": "...", "width": 1024, "height": 1024,
  "params": { "tool_id": "qwen21-camera", "tool_options": { "fast": false, "keepFraming": false, "steps": 30, "cfg": 3 }, "seed": 123 },
  "jobs": [ { "seed": 123, "index": 0, "status": "queued", "progress": 0, "images": [], "prompt_id": "..." } ]
} }
```

Track it exactly like an action run (`/api/comfy/progress`, history by `prompt_id`).

## Errors

Envelope: `{ "ok": false, "error": "message", "request_id": "...", "details": { "code": "..." } }`.

| status | `details.code` | meaning |
|---|---|---|
| 400 | `invalid_json` | body not a JSON object |
| 400 | `unknown_tool` | missing / unknown `toolId` |
| 400 | `invalid_image` | `images` not an array, bad ref, bad `{run_id, job_index}` |
| 400 | `wrong_image_count` | `images.length != refCount` |
| 400 | `mask_required` / `mask_unsupported` / `invalid_mask` | mask rules |
| 400 | `invalid_prompt` / `prompt_required` | prompt type, length, or missing |
| 400 | `invalid_options` | unknown option, bad value, unsupported fast/keepFraming/outpaint |
| 400 | `invalid_geometry` | outpaint adds no padding / empty mask (also redbox/scribble) / bad dimensions |
| 400 | `invalid_client_id` | client_id not a string |
| 404 | `run_not_found` / `job_not_found` | `{run_id, job_index}` target missing |
| 409 | `image_not_ready` | source job has no image yet |
| 409 | `lora_missing` | a needed LoRA file is not installed |
| 409 | `nodes_missing` | ComfyUI lacks a custom node class the tool's graph needs (message lists them + `requiresNodes`) |
| 409 | `pack_unavailable` | base workflow or UNET weights missing |
| 413 | (none) | payload > 24 MB |
| 429 | | rate limited |
| 502 | | ComfyUI rejected / unreachable |
| 500 | | other server error |

## Examples

Camera, front-right high-angle close-up:

```json
{ "toolId": "qwen21-camera", "images": ["me.png [input]"],
  "options": { "azimuth": "front-right", "elevation": "high-angle", "distance": "close-up" } }
```

Widen to 16:9, anchored left, fast mode:

```json
{ "toolId": "qwen21-outpaint", "images": ["me.png [input]"],
  "options": { "fast": true, "outpaint": { "aspect": "16:9", "anchor": "left" } } }
```

Outfit swap (2 refs): `{ "toolId": "qwen21-outfit-swap", "images": ["person.png [input]", "outfit.png [input]"] }`

Krea 2 fast outpaint, all sides +25% (two passes in one graph): `{ "toolId": "krea2-outpaint", "images": ["a.png [input]"], "options": { "outpaint": "all_25" } }`

Krea 2 inpaint: `{ "toolId": "krea2-inpaint", "images": ["a.png [input]"], "mask": "data:image/png;base64,...", "prompt": "a brass lamp" }`

Krea 2 AnyPaint, repaint a region and widen right in one pass: `{ "toolId": "krea2-anypaint", "images": ["a.png [input]"], "mask": "data:image/png;base64,...", "prompt": "a whole scene, the sofa now green, a window on the right", "options": { "expand": "right_50" } }`

## Notes

- Workflows are built by loading the pack base graph, removing existing `LoraLoaderModelOnly` nodes, and chaining
  new ones after the `UNETLoader` (tool LoRA, then consistency, then lightning) before the sampler.
- The Qwen 2.1 pack is opt-in (`CJ_QWEN_IMAGE_21=1`); FLUX.3 is on unless `CJ_FLUX3=0`. Either way the tool routes
  load the workflow files directly, and availability is decided by files on disk.
- Registry fields for qwen21 tools: `encoderResolution` overrides every `TextEncodeQwenImage21.resolution` (0 = each reference at its own size); `fixedLatent` swaps the sampler's latent for an `EmptySD3LatentImage` of that size (an option value's `latent` wins), and the run's width/height follow it; `prep: "letterbox"` + `letterbox` fits the image inside that size without cropping and pads gray (#808080) to exactly that size.
- `krea2-outpaint` follows the yijunwang2/krea2-outpaint contract: canvas multiple of 16, source bbox in output px
  that keeps the source aspect, one pass when the box spans the full width or height, otherwise the reference
  `plan_passes` two-pass plan (smaller intermediate strip first). Geometry is planned server-side
  (`planKrea2Outpaint`); the original image is uploaded untouched and `Krea2OutpaintComposite` restores its pixels.
- `krea2-anypaint` follows the yijunwang2/krea2-anypaint contract via the CJ nodes in `comfy_nodes/comfyui-krea2-anypaint`
  (symlink into `ComfyUI/custom_nodes`, restart). `Krea2AnyPaintPrepare`: canvas multiple of 16, source bbox (aspect
  tolerance max(0.025, 2/min(box side))), outside-box area median-filled, condition image <=384 px edge; keep mask =
  NOT(generated dilated by the 32 px seam). `TextEncodeKrea2AnyPaint` adds the condition as a VL image + reference latent at
  full-canvas RoPE placement; `Krea2AnyPaintModelPatch` caches the reference K/V; `Krea2AnyPaintKnownLatent` sets the
  latent `noise_mask` so known tokens are re-noised to each step's sigma (native KSampler inpaint, identical to the
  pipeline for euler). 8 steps, cfg 1, raw decode (no pixel composite). Placement is planned server-side
  (`planAnyPaint`): no expand = ~1 MP canvas with the bbox spanning it; expand = canvas from the outpaint plan, max side 4096.
- Krea 2 `krea2edit` tools need the `comfyui-krea2edit` nodes (`requiresNodes`); restart ComfyUI after installing.
- `qwen21-body-swap` sends both references at their uploaded size. The model card scales the scene ref to ~2 MP and the
  person ref to ~0.59 MP; the qwen21 graph has no per-reference scaling step, so resize them before upload to match.
- `qwen21-next-scene` runs at LoRA strength 0.7 (the card's chaining recipe).

## Agents (MCP)

`scripts/adrift-mcp.mjs` exposes these tools and every Tools page action to MCP clients
(`claude mcp add adrift -- node scripts/adrift-mcp.mjs`). See [MCP.md](MCP.md).
