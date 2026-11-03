# Model weights and licenses

This repository ships **no model weights**. The workflow packs under
`public/workflows/` load models that you download yourself. Each model is
covered by its own license, not by this repository's MIT license.

The **Commercial use** column summarizes the license for the weights. "No"
means a non-commercial or research license. "Restricted" means a revenue cap, a
territory exclusion or another condition. Some licenses treat generated
outputs differently from the weights, as the notes say. This table is not
legal advice: read the linked license before you use a model or its outputs
commercially.

Licenses were checked on 2026-10-23 against each model card's Hugging Face
license metadata, its LICENSE file, or the GitHub license API. Two rows are
marked **partly verified**, where the full license text could not be read or
the repack does not name its upstream.

| Model family | Weights | License | Commercial use |
|---|---|---|---|
| Wan2.2 I2V A14B | [Wan-AI/Wan2.2-I2V-A14B](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B) (repack [Comfy-Org/Wan-2.2](https://huggingface.co/Comfy-Org/Wan-2.2), same) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Wan2.2 TI2V-5B | [Wan-AI/Wan2.2-TI2V-5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Wan2.2 Fun Camera | [alibaba-pai/Wan2.2-Fun-A14B-Control-Camera](https://huggingface.co/alibaba-pai/Wan2.2-Fun-A14B-Control-Camera) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Wan2.2 Fun VACE | [alibaba-pai/Wan2.2-VACE-Fun-A14B](https://huggingface.co/alibaba-pai/Wan2.2-VACE-Fun-A14B) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Wan2.2 Animate | [Wan-AI/Wan2.2-Animate-14B](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B) (repack [Comfy-Org/Wan-Animate-2](https://huggingface.co/Comfy-Org/Wan-Animate-2), same) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Wan2.2-S2V | [Wan-AI/Wan2.2-S2V-14B](https://huggingface.co/Wan-AI/Wan2.2-S2V-14B) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Wan2.1 I2V 480p / T2V 1.3B | [Wan-AI/Wan2.1-I2V-14B-480P](https://huggingface.co/Wan-AI/Wan2.1-I2V-14B-480P), [Wan-AI/Wan2.1-T2V-1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) (repack Comfy-Org/Wan-2.1, same) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| umt5-xxl text encoder | [google/umt5-xxl](https://huggingface.co/google/umt5-xxl) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| clip_vision_h (OpenCLIP ViT-H/14 LAION-2B) | [laion/CLIP-ViT-H-14-laion2B-s32B-b79K](https://huggingface.co/laion/CLIP-ViT-H-14-laion2B-s32B-b79K) | [MIT](https://github.com/mlfoundations/open_clip/blob/main/LICENSE) | yes |
| Wan-Move | [Ruihang/Wan-Move-14B-480P](https://huggingface.co/Ruihang/Wan-Move-14B-480P); code [ali-vilab/Wan-Move](https://github.com/ali-vilab/Wan-Move) | [Apache-2.0](https://github.com/ali-vilab/Wan-Move/blob/main/LICENSE.txt) | yes |
| InfiniteTalk | [MeiGen-AI/InfiniteTalk](https://huggingface.co/MeiGen-AI/InfiniteTalk) | [Apache-2.0](https://github.com/MeiGen-AI/InfiniteTalk) | yes |
| chinese-wav2vec2-base | [TencentGameMate/chinese-wav2vec2-base](https://huggingface.co/TencentGameMate/chinese-wav2vec2-base) (repack [Kijai/wav2vec2_safetensors](https://huggingface.co/Kijai/wav2vec2_safetensors), same) | [MIT](https://opensource.org/license/mit) | yes |
| wav2vec2 large (English) audio encoder (`wav2vec2_large_english`) | repack [Comfy-Org/Wan-2.2](https://huggingface.co/Comfy-Org/Wan-2.2); upstream not named by the repack, likely [jonatasgrosman/wav2vec2-large-english](https://huggingface.co/jonatasgrosman/wav2vec2-large-english) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata of both) | yes (**partly verified**: upstream inferred) |
| SeedVR2 | [ByteDance-Seed/SeedVR2-3B](https://huggingface.co/ByteDance-Seed/SeedVR2-3B) / [-7B](https://huggingface.co/ByteDance-Seed/SeedVR2-7B) (repack [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2), same) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| RIFE | [hzwer/Practical-RIFE](https://github.com/hzwer/Practical-RIFE) (also [ECCV2022-RIFE](https://github.com/hzwer/ECCV2022-RIFE)); repack [Comfy-Org/Frame-Interpolation](https://huggingface.co/Comfy-Org/Frame-Interpolation) | [MIT](https://github.com/hzwer/Practical-RIFE/blob/main/LICENSE) | yes |
| FILM | [google-research/frame-interpolation](https://github.com/google-research/frame-interpolation); same repack | [Apache-2.0](https://github.com/google-research/frame-interpolation/blob/main/LICENSE) | yes |
| Qwen-Image / Edit-2509 / Edit-2511 / 2512 / Layered | [Qwen/Qwen-Image](https://huggingface.co/Qwen/Qwen-Image), [Qwen/Qwen-Image-Edit-2509](https://huggingface.co/Qwen/Qwen-Image-Edit-2509), [Qwen/Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511), [Qwen/Qwen-Image-2512](https://huggingface.co/Qwen/Qwen-Image-2512), [Qwen/Qwen-Image-Layered](https://huggingface.co/Qwen/Qwen-Image-Layered) (repacks Comfy-Org/Qwen-Image, -Edit, -Layered: same) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Qwen-Image 2.1 (+ 2.1-Turbo) | [Qwen/Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) (repack [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1), same) | [Qwen RESEARCH LICENSE AGREEMENT](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) | no (non-commercial / research only; separate commercial license from Qwen) |
| Qwen2.5-VL-7B text encoder | [Qwen/Qwen2.5-VL-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| dx8152 Relight LoRA | [dx8152/Qwen-Image-Edit-2509-Relight](https://huggingface.co/dx8152/Qwen-Image-Edit-2509-Relight) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| dx8152 Light Migration LoRA | [dx8152/Qwen-Edit-2509-Light-Migration](https://huggingface.co/dx8152/Qwen-Edit-2509-Light-Migration) (repack [Comfy-Org/Qwen-Image-Edit](https://huggingface.co/Comfy-Org/Qwen-Image-Edit), same) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| dx8152 Multiple-angles LoRA (2509) | [dx8152/Qwen-Edit-2509-Multiple-angles](https://huggingface.co/dx8152/Qwen-Edit-2509-Multiple-angles) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| Multiple-angles LoRA (2511) | [fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA](https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA) (by fal / Lovis Odin, not dx8152) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| Lightning / distill LoRAs | [lightx2v/Qwen-Image-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Lightning), [lightx2v/Wan2.2-Distill-Loras](https://huggingface.co/lightx2v/Wan2.2-Distill-Loras), [lightx2v/Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v](https://huggingface.co/lightx2v/Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Qwen-Image 2.1 edit-tool LoRAs (Apache-2.0 cards) | [akhaliq/Qwen-Image-2.1-Next-Scene-LoRA](https://huggingface.co/akhaliq/Qwen-Image-2.1-Next-Scene-LoRA), [gribbliest/qwen-image-2.1-qma-camera-angles](https://huggingface.co/gribbliest/qwen-image-2.1-qma-camera-angles), [WarmBloodAban/Qwen-Image-2.1-LoRAs](https://huggingface.co/WarmBloodAban/Qwen-Image-2.1-LoRAs) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata); the base model is Qwen-Image 2.1, so its research license applies at inference | no (Qwen-Image 2.1 base is non-commercial) |
| Qwen-Image 2.1 edit-tool LoRAs (research-license cards) | [ausboss/Qwen-Image-2.1-Consistency-LoRA](https://huggingface.co/ausboss/Qwen-Image-2.1-Consistency-LoRA), [ausboss/Qwen-Image-2.1-Outfit-Swap-Consistency-LoRA](https://huggingface.co/ausboss/Qwen-Image-2.1-Outfit-Swap-Consistency-LoRA), [ausboss/Qwen-Image-2.1-Outpaint-LoRA](https://huggingface.co/ausboss/Qwen-Image-2.1-Outpaint-LoRA), [ausboss/Qwen-Image-2.1-Restore-LoRA](https://huggingface.co/ausboss/Qwen-Image-2.1-Restore-LoRA), [houseofboern/character-sheet-qwen-image-2.1-edit-lora](https://huggingface.co/houseofboern/character-sheet-qwen-image-2.1-edit-lora), [houseofboern/realism-qwen-image-2.1-edit-lora](https://huggingface.co/houseofboern/realism-qwen-image-2.1-edit-lora), [houseofboern/unblur-background-qwen-image-2.1-edit-lora](https://huggingface.co/houseofboern/unblur-background-qwen-image-2.1-edit-lora), [ML-Intern-lab/Qwen-Image-2.1-doodle-in-LoRA](https://huggingface.co/ML-Intern-lab/Qwen-Image-2.1-doodle-in-LoRA), [prithivMLmods/Qwen-Image-2.1-Object-Remover-Bbox-turbo](https://huggingface.co/prithivMLmods/Qwen-Image-2.1-Object-Remover-Bbox-turbo) | [Qwen RESEARCH LICENSE AGREEMENT](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) | no (non-commercial / research only) |
| Qwen-Image 2.1 LoRAs with no license on the card | [lightx2v/Qwen-Image-2.1-Lightning](https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning), [Gogodr/qwen-image-2.1-edit-pano360-lora](https://huggingface.co/Gogodr/qwen-image-2.1-edit-pano360-lora) | none stated; Qwen-Image 2.1 derivative, so [Qwen RESEARCH LICENSE AGREEMENT](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) applies | no (non-commercial / research only) |
| Qwen-Image-Edit-2511 edit-tool LoRAs | [prithivMLmods/Qwen-Image-Edit-2511-Object-Remover](https://huggingface.co/prithivMLmods/Qwen-Image-Edit-2511-Object-Remover), [prithivMLmods/Qwen-Image-Edit-2511-Unblur-Upscale](https://huggingface.co/prithivMLmods/Qwen-Image-Edit-2511-Unblur-Upscale) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| FLUX.3 Klein edit-tool LoRAs | [ausboss/FLUX-3-Image-Klein-Consistency-LoRA](https://huggingface.co/ausboss/FLUX-3-Image-Klein-Consistency-LoRA), [ausboss/FLUX-3-Image-Klein-Outpaint-LoRA](https://huggingface.co/ausboss/FLUX-3-Image-Klein-Outpaint-LoRA), [ausboss/FLUX-3-Image-Klein-Restore-LoRA](https://huggingface.co/ausboss/FLUX-3-Image-Klein-Restore-LoRA), [akhaliq/flux-3-image-klein-angles-lora](https://huggingface.co/akhaliq/flux-3-image-klein-angles-lora) (the angles LoRA needs a key rename, see the download list) | [FLUX Kommunity License v1.0](https://huggingface.co/black-forest-labs/flux-3-image-klein-base/blob/main/LICENSE.md) | restricted (same as FLUX.3 Klein) |
| MOSS-Image color/depth control LoRA | [darask0/MOSS-Image-color-depth-control](https://huggingface.co/darask0/MOSS-Image-color-depth-control) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| Krea 2 Turbo 4-step distill LoRA | [lvladikov/Krea2-Turbo-Distill-4step-LoRA](https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA) | [Krea 2 Community License](https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA/blob/main/LICENSE.pdf) | restricted (Krea US$1M cap) |
| TRELLIS.2 | [microsoft/TRELLIS.2-4B](https://huggingface.co/microsoft/TRELLIS.2-4B); code [microsoft/TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (repack [Comfy-Org/TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2), same) | [MIT](https://github.com/microsoft/TRELLIS.2/blob/main/LICENSE) | yes |
| Pixal3D | [TencentARC/Pixal3D](https://huggingface.co/TencentARC/Pixal3D); code [TencentARC/Pixal3D](https://github.com/TencentARC/Pixal3D) (repack [Comfy-Org/Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D), same) | [MIT](https://github.com/TencentARC/Pixal3D/blob/master/LICENSE) | yes |
| TripoSplat (image to 3D Gaussian splat) | [VAST-AI/TripoSplat](https://huggingface.co/VAST-AI/TripoSplat) (also ships the DINOv3 ViT-H image encoder, FLUX.2 VAE and BiRefNet it uses) | [MIT](https://opensource.org/license/mit) (HF metadata) | yes (the bundled `dino_v3_vit_h` encoder stays under the DINOv3 License, see DINOv3) |
| MoGe-2 | [Ruicheng/moge-2-vitl-normal](https://huggingface.co/Ruicheng/moge-2-vitl-normal) | [MIT](https://opensource.org/license/mit) (HF metadata) | yes |
| MoGe-3 ViT-G (Depth & Normals, model option) | [Ruicheng/moge-3-vitg](https://huggingface.co/Ruicheng/moge-3-vitg) (repack [Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe), same) | [MIT](https://opensource.org/license/mit) (HF metadata) | yes |
| Marigold V2 depth / normals / albedo (Material Maps; LoRAs, VAEs and conditionings on Qwen-Image-Edit-2509) | [huawei-bayerlab/marigold-v2-0](https://huggingface.co/huawei-bayerlab/marigold-v2-0) (repack [Comfy-Org/marigold-v2-0](https://huggingface.co/Comfy-Org/marigold-v2-0), same) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| TripoSR | [stabilityai/TripoSR](https://huggingface.co/stabilityai/TripoSR) | [MIT](https://opensource.org/license/mit) | yes |
| ACE-Step 1.5 | [ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5); code [ace-step/ACE-Step-1.5](https://github.com/ace-step/ACE-Step-1.5) | [MIT](https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE) | yes |
| Stable Audio Open 1.0 | [stabilityai/stable-audio-open-1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0) | [Stability AI Community License](https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE.md) | restricted (free under US$1M annual revenue; registration required for commercial use) |
| Stable Audio 3 (medium / small-music / small-sfx) | [stabilityai/stable-audio-3-small-sfx](https://huggingface.co/stabilityai/stable-audio-3-small-sfx), [-small-music](https://huggingface.co/stabilityai/stable-audio-3-small-music), [-medium](https://huggingface.co/stabilityai/stable-audio-3-medium) (repack [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3), same) | [Stability AI Community License](https://huggingface.co/stabilityai/stable-audio-3-small-sfx/blob/main/LICENSE.md) (+ LICENSE_GEMMA.md for the Gemma text encoder) | restricted (US$1M revenue cap; registration) |
| LTX-Video 2B 0.9.5 | [Lightricks/LTX-Video](https://huggingface.co/Lightricks/LTX-Video) | [LTXV 2B 0.9.5 Open RAIL-M](https://huggingface.co/Lightricks/LTX-Video/blob/main/ltx-video-2b-v0.9.5.license.txt) | yes (with RAIL use-based restrictions) |
| LTX-Video 0.9.8 distilled (2B/13B) | [Lightricks/LTX-Video](https://huggingface.co/Lightricks/LTX-Video) | [LTXV Open Weights License 0.X](https://huggingface.co/Lightricks/LTX-Video/blob/main/LTX-Video-Open-Weights-License-0.X.txt) | restricted (entities with annual revenue >= US$10M need a paid commercial license) |
| LTX-2.5 22B distilled, video/audio VAE, x2 latent upscaler | [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) (gated) | [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) | restricted (entities with annual revenue >= US$10M need a paid commercial license) |
| LTX-2.5 VFX LoRAs (IC-LoRA / effect LoRAs: alpha matte, clean plate, day to night, add water, cinemagraph, slow motion) | [Lightricks on Hugging Face](https://huggingface.co/Lightricks) (gated) | [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) | restricted (same as LTX-2.5) |
| LTX-2.3 22B IC-LoRA Outpaint (Video Expand) | [oumoumad on Hugging Face](https://huggingface.co/oumoumad/LTX-2.3-22b-IC-LoRA-Outpaint) | [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) | restricted (same as LTX-2.5) |
| MiniMax-Remover (video object removal; no shipped tool loads it yet) | [zibojia/minimax-remover](https://huggingface.co/zibojia/minimax-remover) (repack [Kijai/WanVideo_comfy](https://huggingface.co/Kijai/WanVideo_comfy) `Wan2_1-MiniMaxRemover_1_3B_fp16`) | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | no (non-commercial only) |
| MatAnyone2 (named-subject engine of Remove video background; optional) | [PeiqingYang/MatAnyone2](https://huggingface.co/PeiqingYang/MatAnyone2), code [pq-yang/MatAnyone2](https://github.com/pq-yang/MatAnyone2) | [S-Lab License 1.0](https://github.com/pq-yang/MatAnyone2/blob/main/LICENSE.txt) | no (non-commercial only) |
| FLUX.1-dev | [black-forest-labs/FLUX.1-dev](https://huggingface.co/black-forest-labs/FLUX.1-dev) | [FLUX.1 [dev] Non-Commercial License v1.1.1](https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md) | no (weights non-commercial; outputs may be used commercially) |
| FLUX.1-schnell | [black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| FLUX.2-dev / FLUX.2-klein-9B | [black-forest-labs/FLUX.2-dev](https://huggingface.co/black-forest-labs/FLUX.2-dev), [FLUX.2-klein-9B](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B) | [FLUX Non-Commercial License v2.1](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md) | no (weights non-commercial; outputs may be used commercially) |
| FLUX.2-klein-4B | [black-forest-labs/FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) | [Apache-2.0](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/LICENSE.md) | yes |
| FLUX.3 Image Klein (flux3_image_klein) | [black-forest-labs/flux-3-image-klein](https://huggingface.co/black-forest-labs/flux-3-image-klein) (+ -base; Comfy pack [flux-3-image-klein-comfy](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy), same) | [FLUX Kommunity License v1.0](https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md) | restricted (commercial use of outputs only for "Qualifying Users" with gross annualized revenue < US$5M; otherwise non-commercial) |
| FLUX.3 Klein "pup" text encoder | [black-forest-labs/flux-3-image-klein-pup](https://huggingface.co/black-forest-labs/flux-3-image-klein-pup) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| Krea 2 (Raw / Turbo) | [krea/Krea-2-Raw](https://huggingface.co/krea/Krea-2-Raw), [krea/Krea-2-Turbo](https://huggingface.co/krea/Krea-2-Turbo) (repack [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2), same) | [Krea 2 Community License Agreement v.1](https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf) | restricted (commercial use only if company-wide annual revenue < US$1M; content filters required) |
| fal Krea-2 Style LoRAs | [ilkerzgi/fal-Krea-2-Style-LoRAs](https://huggingface.co/ilkerzgi/fal-Krea-2-Style-LoRAs) | [Krea 2 Community License](https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf) (Krea 2 derivative) | restricted (same US$1M cap) |
| Krea 2 AnyPaint LoRA (node contract) | LoRA [yijunwang2/krea2-anypaint](https://huggingface.co/yijunwang2/krea2-anypaint); ComfyUI nodes [alexw5702-afk/krea2-anypaint](https://github.com/alexw5702-afk/krea2-anypaint) | LoRA: [Krea 2 Community License](https://krea.ai/krea-2-licensing); HF pipeline code: Apache-2.0 (PIPELINE_LICENSE); ComfyUI node code: [MIT](https://github.com/alexw5702-afk/krea2-anypaint) | node code: yes; LoRA: restricted (Krea US$1M cap) |
| Krea 2 Identity / General Edit V2 LoRAs | [conradlocke/krea2-identity-edit](https://huggingface.co/conradlocke/krea2-identity-edit) (`*_edit_v2*` files) | [Krea 2 Identity Edit V2 License](https://huggingface.co/conradlocke/krea2-identity-edit/blob/main/LICENSE_V2.md) | no (non-commercial; commercial use needs a paid license) |
| MiniMax H3 | [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) (repack [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3), same) | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) | restricted (territory exclusion: no use in EU, UK, Republic of Korea, USA; >US$20M yearly revenue needs authorization; "MiniMax H3" must be shown in commercial UI) |
| MiniMax H3 Turbo LoRAs (8/4-step speed-up; face/character swap use fl2v 8-step v1.1) | [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) | none stated on the card; H3 derivative, so the [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) applies | restricted (same as MiniMax H3) |
| H3 FaceSwap LoRA | [UntMods/FaceSwap_MiniMaxH3_REF2VA](https://huggingface.co/UntMods/FaceSwap_MiniMaxH3_REF2VA) | Apache-2.0 per HF metadata (base model is H3, so H3 terms still apply at inference) | restricted (H3 base) |
| H3 Character Swap LoRA | [akatz-ai/MiniMax-H3-Character-Swap-LoRA](https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA) | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) | restricted (same as MiniMax H3) |
| H3 Person Remover LoRA | [akatz-ai/MiniMax-H3-Person-Remover-LoRA](https://huggingface.co/akatz-ai/MiniMax-H3-Person-Remover-LoRA) | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) (per HF metadata) | restricted (same as MiniMax H3) |
| H3 Fun ControlNet Union 2.0 (Character swap Motion guide: pose) | [alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union-2.0) (repack [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) `model_patches/`, same) | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) (HF metadata) | restricted (same as MiniMax H3) |
| Open-H3-Regenerate 2K LoRA + Sharp curve branches (Character swap Finish: 2K) | [Efficient-Large-Model/Open-H3-Regenerate-2K](https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K) `lora/`; nodes [rdh9616/ComfyUI-Open-H3-Regenerate](https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate) (Apache-2.0) | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) (HF metadata `minimax-h3-community`) | restricted (same as MiniMax H3) |
| MiniMax H3 latent upscaler 3D-conv v1 (Character swap Finish: 2K) | [Efficient-Large-Model/Open-H3-Regenerate-2K](https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K) `latent_upsampler/` (same file: [LBH-123-AI/Minimax_h3_latent_Upscaler](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler), tagged Apache-2.0) | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) (repo we pin; works only on H3 latents, treated as H3-derived) | restricted (same as MiniMax H3) |
| VibeVoice 1.5B | [microsoft/VibeVoice-1.5B](https://huggingface.co/microsoft/VibeVoice-1.5B); code [microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) | [MIT](https://github.com/microsoft/VibeVoice/blob/main/LICENSE) | yes (MIT; card itself recommends research use) |
| VibeVoice Realtime 0.5B (default voiceover voices) | [microsoft/VibeVoice-Realtime-0.5B](https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B); voice prompts from [microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) `demo/voices/streaming_model` → `models/tts/VibeVoice/voices/` | [MIT](https://github.com/microsoft/VibeVoice/blob/main/LICENSE) | yes |
| Kokoro-82M (Kokoro voiceover engine, CPU) | [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M); node `comfy_nodes/cj_kokoro_tts` (own Python 3.12 venv, see its README) | [Apache-2.0](https://huggingface.co/hexgrad/Kokoro-82M) | yes |
| MMAudio | [hkchengrex/MMAudio](https://huggingface.co/hkchengrex/MMAudio); code [hkchengrex/MMAudio](https://github.com/hkchengrex/MMAudio) | weights [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/); code [MIT](https://github.com/hkchengrex/MMAudio/blob/main/LICENSE) | no (checkpoints non-commercial) |
| Lucy Edit Dev | [decart-ai/Lucy-Edit-Dev](https://huggingface.co/decart-ai/Lucy-Edit-Dev) | Lucy Edit Dev Model Non-Commercial License ([link from card, Google Drive](https://drive.google.com/file/d/1pX34A-UOEl9CErMUZKdKzhoWhtSI1TJK/view)) | no (non-commercial, per license name; partly verified: full text not read) |
| Whisper large-v3 | [openai/whisper-large-v3](https://huggingface.co/openai/whisper-large-v3) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Whisper large-v3-turbo | [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) | [MIT](https://opensource.org/license/mit) | yes |
| Chatterbox | [ResembleAI/chatterbox](https://huggingface.co/ResembleAI/chatterbox) | [MIT](https://opensource.org/license/mit) | yes |
| Z-Image Turbo | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Ideogram 4 (open weights) | [ideogram-ai/ideogram-4-fp8](https://huggingface.co/ideogram-ai/ideogram-4-fp8), [ideogram-4-nf4](https://huggingface.co/ideogram-ai/ideogram-4-nf4) (repack [Comfy-Org/Ideogram-4](https://huggingface.co/Comfy-Org/Ideogram-4), same) | [Ideogram Non-Commercial Model Agreement](https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md) | no (non-commercial only) |
| SDXL base 1.0 | [stabilityai/stable-diffusion-xl-base-1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) | [CreativeML Open RAIL++-M](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | yes (with RAIL use-based restrictions) |
| MOSS-Image (Base / SFT) | [OpenMOSS-Team/MOSS-Image-Base](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base), [-SFT](https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT) (repack [Comfy-Org/MOSS-Image](https://huggingface.co/Comfy-Org/MOSS-Image), same) | [Apache-2.0](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/blob/main/LICENSE) | yes |
| Qwen3.5-9B text encoder (MOSS-Image) | [Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B) (repack [Comfy-Org/MOSS-Image](https://huggingface.co/Comfy-Org/MOSS-Image), same) | [Apache-2.0](https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE) | yes |
| MOSS-Image edit-tool LoRAs (Character Reference, Colorize) | [7err4/MOSS-Image-CharRef](https://huggingface.co/7err4/MOSS-Image-CharRef), [sorryhyun/moss-image-colorize](https://huggingface.co/sorryhyun/moss-image-colorize) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata) | yes |
| SeFi-Image | [SeFi-Image/SeFi-Image-5B-turbo](https://huggingface.co/SeFi-Image/SeFi-Image-5B-turbo) (all SeFi-Image/* checkpoints); code [jmliu206/SeFi-Image](https://github.com/jmliu206/SeFi-Image) | weights [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/); code MIT | no (non-commercial; gated) |
| BiRefNet | [ZhengPeng7/BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet) | [MIT](https://opensource.org/license/mit) | yes |
| SAM 3.1 (sam3.1_multiplex; Breakdown, FIBO paste-back masks, video object/person removal) | [Comfy-Org/sam3.1](https://huggingface.co/Comfy-Org/sam3.1) (repack of Meta's SAM 3.1) | [SAM License](https://huggingface.co/Comfy-Org/sam3.1/blob/main/LICENSE) (Meta, 2025-11-19; HF metadata `sam-license`) | yes (royalty-free; trade-control and prohibited-use terms, like DINOv3) |
| SAM 3D Body (3D human body mesh / pose from a photo or clip) | [Comfy-Org/sam-3d-body](https://huggingface.co/Comfy-Org/sam-3d-body) (repack of Meta's [facebook/sam-3d-body-dinov3](https://huggingface.co/facebook/sam-3d-body-dinov3), gated there) | [SAM License](https://huggingface.co/facebook/sam-3d-body-dinov3/blob/main/LICENSE) (Meta, 2025-11-19; HF metadata `sam-license`) | yes (royalty-free; trade-control and prohibited-use terms, like SAM 3.1) |
| Bria FIBO 2.0 (Edit Turbo / Dev; FIBO 2.0 Edit tool) | [Bria AI on Hugging Face](https://huggingface.co/briaai) | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) (commercial use needs a license from Bria) | no (non-commercial only) |
| Real-ESRGAN | [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | [BSD-3-Clause](https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE) | yes |
| YOLOv8 face/hand detectors | [Bingsu/adetailer](https://huggingface.co/Bingsu/adetailer); runtime [ultralytics/ultralytics](https://github.com/ultralytics/ultralytics) | weights repo: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (HF metadata); Ultralytics: [AGPL-3.0](https://github.com/ultralytics/ultralytics/blob/main/LICENSE) | restricted (AGPL-3.0 copyleft via ultralytics; Ultralytics sells an enterprise license) |
| Depth Anything 3 (DA3-BASE) | [depth-anything/DA3-BASE](https://huggingface.co/depth-anything/DA3-BASE) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| SDPose whole-body (Character swap Motion guide: pose keypoints) | [Comfy-Org/SDPose](https://huggingface.co/Comfy-Org/SDPose) (repack of [teemosliang/SDPose-Wholebody](https://huggingface.co/teemosliang/SDPose-Wholebody)) | [MIT](https://opensource.org/license/mit) (HF metadata, both repos) | yes |
| RT-DETRv4 person detector (rt_detr_v4-x-hgnet; Motion guide, Body 3D) | [Comfy-Org/SDPose](https://huggingface.co/Comfy-Org/SDPose) (repo tagged MIT); code [RT-DETRs/RT-DETRv4](https://github.com/RT-DETRs/RT-DETRv4) | [Apache-2.0](https://github.com/RT-DETRs/RT-DETRv4/blob/main/LICENSE) | yes |
| DINOv3 | [facebook/dinov3-vitl16-pretrain-lvd1689m](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m) | [DINOv3 License](https://ai.meta.com/resources/models-and-libraries/dinov3-license/) | yes (custom Meta license; trade-control / military-use prohibitions; gated, manual approval) |
| Remade-AI effect LoRAs | [Remade-AI/360-Orbit](https://huggingface.co/Remade-AI/360-Orbit), [Crash-zoom-in](https://huggingface.co/Remade-AI/Crash-zoom-in), [Squish](https://huggingface.co/Remade-AI/Squish) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (all 3 identical) | yes |
| ostris Wan2.2 orbit-shot LoRA | [ostris/wan22_i2v_14b_orbit_shot_lora](https://huggingface.co/ostris/wan22_i2v_14b_orbit_shot_lora) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| BulletTime LoRA | [joyfox/Wan2.1-BulletTime-LoRA](https://huggingface.co/joyfox/Wan2.1-BulletTime-LoRA) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| Camera Push-In LoRA | [lovis93/Motion-Lora-Camera-Push-In-Wan-14B-720p-I2V](https://huggingface.co/lovis93/Motion-Lora-Camera-Push-In-Wan-14B-720p-I2V) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| SigLIP2 (style library embedder, optional service, downloaded at first index) | [google/siglip2-base-patch16-256](https://huggingface.co/google/siglip2-base-patch16-256) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| BLIP base (style library captions, optional, downloaded on first use) | [Salesforce/blip-image-captioning-base](https://huggingface.co/Salesforce/blip-image-captioning-base) | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) | yes |
| Qwen3-VL-4B-Instruct (style library tagging, optional, downloaded on first use) | [Qwen/Qwen3-VL-4B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | yes |
| CLIP ViT-L/14 (style library text detection, optional extra, not installed by setup) | [openai/CLIP](https://github.com/openai/CLIP) through [open_clip](https://github.com/mlfoundations/open_clip) | [MIT](https://github.com/openai/CLIP/blob/main/LICENSE) | yes |

## Notes

- **MiniMax H3 is optional and region-restricted.** Its community license
  excludes the European Union, the United Kingdom, South Korea and the
  United States, for both the weights and the outputs. In those regions,
  apply to MiniMax for a license first:
  [platform.minimax.io/h3-license](https://platform.minimax.io/h3-license).
  Above US$20M yearly revenue the license requires written authorization, and
  a commercial product must show "MiniMax H3" in its UI. H3 is not part of
  the default model set; see the README.
- **H3 swap speed LoRA.** The face swap and character swap graphs load the
  lightx2v fl2v Turbo 8-step v1.1 LoRA with `MiniMaxH3SigmaShift` 6/3. Do not
  swap in the RunningHub `MiniMax-H3-Ref2VA-Acc-8Step_comfy` conversion: it
  stores the final-layer head bias bank as `set_bias` keys, which stock
  ComfyUI skips, so sampling fails in `_pdd_head` with a tensor size
  mismatch. On the pruned H3 bases its full `adaln_proj` diffs also do not
  fit.
- **Revenue caps.** Each of these allows free commercial use only below a
  revenue threshold, with conditions:

  | License | Threshold | Conditions |
  |---|---|---|
  | Stability AI Community | US$1M | registration required |
  | Krea 2 Community | US$1M, company-wide | content filters required |
  | FLUX Kommunity (FLUX.3 Klein) | US$5M | covers outputs |
  | LTXV Open Weights 0.X | US$10M | |
  | LTX-2 Community (LTX-2.5 and its LoRAs) | US$10M | |
  | MiniMax H3 | US$20M | |
- **Non-commercial weights.** These weights are non-commercial:
  - FLUX.1-dev, FLUX.2-dev and FLUX.2-klein-9B
  - Ideogram 4
  - Krea 2 Identity / General Edit V2 LoRAs
  - MMAudio checkpoints
  - SeFi-Image
  - Lucy Edit Dev
  - Bria FIBO 2.0
  - Qwen-Image **2.1** (Qwen Research License)
  - MiniMax-Remover (CC BY-NC 4.0)
  - MatAnyone2 (S-Lab License 1.0)

  Qwen-Image, Edit-2509, Edit-2511, 2512 and Layered are Apache-2.0.
- **LTX-Video** uses a different license per checkpoint. 2B 0.9.5 is Open RAIL-M.
  0.9.6 and later use the LTXV Open Weights License. LTX-2.5 and its VFX LoRAs
  use the LTX-2 Community License (same US$10M threshold).
- **YOLOv8 detectors.** `Bingsu/adetailer` is tagged Apache-2.0, but the models load
  through ultralytics, which is AGPL-3.0.
- **ACE-Step 1.5.** The Comfy-Org repack is labelled Apache-2.0, but upstream is MIT.
- **Krea 2 AnyPaint.** `comfy_nodes/comfyui-krea2-anypaint` follows the node
  contract of [alexw5702-afk/krea2-anypaint](https://github.com/alexw5702-afk/krea2-anypaint)
  (MIT). The LoRA it loads ([yijunwang2/krea2-anypaint](https://huggingface.co/yijunwang2/krea2-anypaint))
  is under the Krea 2 Community License.
- **Krea 2 style LoRA catalog.** `src/lib/krea2/styleLoraCatalog.json` holds only
  metadata (names, trigger words, Hugging Face paths) for
  [ilkerzgi/fal-Krea-2-Style-LoRAs](https://huggingface.co/ilkerzgi/fal-Krea-2-Style-LoRAs).
  The weights download on demand under the Krea 2 Community License.
- **Gated models.** These require you to accept the terms on Hugging Face before
  downloading:
  - FLUX
  - FLUX.3 Klein
  - Krea 2
  - Stable Audio
  - Ideogram 4
  - SeFi-Image
  - DINOv3 (manual approval)
  - LTX-2.5 and its VFX LoRAs
- **Motion-effect LoRAs.** The `wan_motion` presets use community Remade-AI
  LoRAs. The ones checked are Apache-2.0. Effects that imitate third-party
  characters or franchises are not in the download list.
- **Your own models.** Some packs reference LoRAs that you train yourself
  (identity, selfie or character LoRAs). Those packs stay disabled until you
  provide such a file.
- **Third-party custom nodes.** The custom nodes that some packs need are
  separate projects under their own licenses. `comfy_nodes/` contains only the
  nodes written for Adrift.
