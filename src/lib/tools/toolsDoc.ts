/**
 * docs/TOOLS.md generator
 * Renders the Tools-page reference (every action card + every catalog LoRA
 * tool) from the same data the app runs on:
 *
 *   ACTION_TOOLS (toolsPage.ts)        title, subtitle, inputs, pickers, packs
 *   editToolRegistry.json              catalog tools, base model, license
 *   registry.json + STATIC_WORKFLOWS   action -> workflow graph
 *   public/workflows/**.json           loader nodes -> weight files
 *   MODEL_FAMILIES (below)             weight file -> model family + license
 *
 * Pure: the caller passes a `loadWorkflow` function, so this module never
 * touches the filesystem. src/__tests__/toolsDoc.test.ts keeps the committed
 * docs/TOOLS.md in sync (regenerate with `npm run docs:tools`).
 */

import registryJson from "@/lib/oj/registry.json";
import { ACTION_TOOLS, CATEGORY_ORDER, type ActionToolSpec } from "./toolsPage";
import {
  STATIC_WORKFLOWS,
  getEditTools,
  toolLicense,
  type EditToolDef,
} from "./editTools";
import {
  DUB_VIDEO_KEY,
  DUB_VIDEO_MODEL_LINE,
  VOICE_CHANGER_MODEL_LINE,
} from "./pipelineCards";
import { toolTitle } from "./toolNames";
import { hairdeckDocLines } from "@/lib/hairdeck/card";
import type { Workflow } from "@/types";

// Model families

/** yes = commercial use allowed; restricted = revenue cap / territory / AGPL
 *  or similar condition; no = non-commercial weights; unverified = the author
 *  states no license (checked; shown to users as "Check license"). */
export type Commercial = "yes" | "restricted" | "no" | "unverified";

export interface ModelFamily {
  id: string;
  label: string;
  /** Tested against the lower-cased weight path (folder prefix included). */
  match: RegExp;
  license: string;
  commercial: Commercial;
  /**
   * Size in GB (HF-reported) of the family's largest diffusion / main model
   * file as the shipped graphs load it. Drives the VRAM ballpark; encoders,
   * VAEs and LoRAs leave it unset (ComfyUI offloads them between stages).
   */
  gb?: number;
  /** Model page to read when no license text can be linked ("unverified"). */
  url?: string;
}

/**
 * Order matters: the first match wins, so specific patterns (LoRAs built on a
 * base, encoders shipped inside another package) come before broad ones.
 * Licenses mirror MODELS.md; keep the two in step.
 */
export const MODEL_FAMILIES: ModelFamily[] = [
  // No shipped graph loads it yet; listed (ahead of the H3 and Wan patterns)
  // so a tool built on it is marked nc.
  {
    id: "minimax-remover",
    label: "MiniMax-Remover",
    match: /minimax.?remover/,
    license: "CC BY-NC 4.0",
    commercial: "no",
  },
  // Anima (CircleStone Labs; ref adapter by ElectronGirl, derivative)
  {
    id: "anima",
    label: "Anima base v1.0 + Ref Adapter",
    match: /anima-base|anima_ref_adapter/,
    license: "CircleStone Labs Non-Commercial License",
    commercial: "no",
    gb: 4.2,
  },
  {
    id: "anima-te",
    label: "Qwen3 0.6B encoder (Anima)",
    match: /qwen_3_06b_base/,
    license: "CircleStone Labs Non-Commercial License",
    commercial: "no",
  },
  // MiniMax H3 (optional pack, region-restricted)
  {
    id: "qwen3vl-h3",
    label: "Qwen3-VL 32B encoder (H3 package)",
    match: /qwen3vl_32b_minimax_h3/,
    license: "MiniMax H3 Community License",
    commercial: "restricted",
  },
  {
    // Character swap 2K finish. Efficient-Large-Model/Open-H3-Regenerate-2K
    // card: license "minimax-h3-community"; the merged
    // refiner LoRA + LMS Sharp curve branches are H3 fine-tunes.
    id: "open-h3-regenerate",
    label: "Open-H3-Regenerate 2K LoRA + Sharp curve",
    match: /open_h3_regenerate|sharp_curve_branches/,
    license: "MiniMax H3 Community License",
    commercial: "restricted",
  },
  {
    // H3 latent upscaler (2K finish), shipped in the Open-H3-Regenerate-2K
    // repo (tagged minimax-h3-community). The standalone copy
    // (LBH-123-AI/Minimax_h3_latent_Upscaler) is tagged Apache-2.0, but it is
    // trained on and only runs with H3 latents: treated as H3-derived.
    id: "h3-latent-upscaler",
    label: "MiniMax H3 latent upscaler",
    match: /minimax_h3_latent_upscaler/,
    license: "MiniMax H3 Community License",
    commercial: "restricted",
  },
  {
    // Opt-in h3Flex LoRAs (lib/oj/h3Video.ts). Header: "Model Derivative of
    // MiniMax H3, distributed under the MiniMax H3 Community License
    // Agreement", modified by Mellis, Inc.
    id: "pika-h3-flex",
    label: "Pika H3 Flex LoRA",
    match: /pika_h3_flex/,
    license: "MiniMax H3 Community License",
    commercial: "restricted",
  },
  {
    id: "h3",
    label: "MiniMax H3",
    match:
      /minimax_h3|_h3_|h3_character_swap|faceswap_h3|h3-person-remover|camera_motion_h3/,
    license: "MiniMax H3 Community License",
    commercial: "restricted",
    gb: 21,
  },
  // Wan family
  {
    id: "wan-move",
    label: "Wan-Move 14B",
    match: /wanmove/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 16.4,
  },
  {
    id: "infinitetalk",
    label: "InfiniteTalk",
    match: /infinitetalk/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 5.1,
  },
  {
    id: "wan-animate",
    label: "Wan2.2 Animate 14B",
    match: /wan_animate/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 16.7,
  },
  {
    id: "wan-s2v",
    label: "Wan2.2-S2V 14B",
    match: /wan2\.2_s2v/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 16.4,
  },
  {
    id: "wan-vace",
    label: "Wan2.2 Fun VACE A14B",
    match: /fun_vace/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 17.3,
  },
  {
    id: "wan-camera",
    label: "Wan2.2 Fun Camera A14B",
    match: /fun_camera/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 15.3,
  },
  {
    id: "wan-5b",
    label: "Wan2.2 TI2V-5B",
    match: /wan2\.2_ti2v_5b/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 10,
  },
  {
    id: "wan22-i2v",
    label: "Wan2.2 I2V A14B",
    match: /wan2\.2_i2v_(high|low)_noise_14b/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 14.3,
  },
  {
    // FlashVSR v1.1 on Wan2.1 T2V 1.3B + LQ projection + TCDecoder.
    id: "flashvsr",
    label: "FlashVSR v1.1",
    match: /flashvsr/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 6.4,
  },
  {
    id: "wan21",
    label: "Wan2.1 (I2V 480p / T2V 1.3B)",
    match: /wan2\.1_(i2v_480p_14b|t2v_1\.3b)/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 16.4,
  },
  {
    id: "wan-effects",
    label: "Wan motion-effect LoRAs (Remade-AI, ostris)",
    match: /^wan_motion\//,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "lightx2v",
    label: "Lightning / lightx2v speed LoRAs",
    match: /lightning|lightx2v/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "wan-shared",
    label: "Wan VAE + umT5-XXL encoder",
    match: /wan_?2\.[12]_vae|umt5[_-]xxl/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "clip-vision-h",
    label: "CLIP ViT-H/14 (clip_vision_h)",
    match: /clip_vision_h/,
    license: "MIT",
    commercial: "yes",
  },
  {
    id: "wav2vec2-zh",
    label: "chinese-wav2vec2-base",
    match: /wav2vec2-chinese/,
    license: "MIT",
    commercial: "yes",
  },
  {
    id: "wav2vec2-en",
    label: "wav2vec2 large (English) audio encoder",
    match: /wav2vec2_large_english/,
    // Comfy-Org/Wan-2.2 repack metadata (Apache-2.0); the repack does not name
    // its upstream (likely jonatasgrosman/wav2vec2-large-english, also Apache).
    license: "Apache-2.0",
    commercial: "yes",
  },
  // Qwen-Image family
  {
    id: "qwen21",
    label: "Qwen-Image 2.1",
    match: /qwen.?image.?2\.1/,
    license: "Qwen Research License",
    commercial: "no",
    gb: 14.2,
  },
  {
    id: "qwen-relight",
    label: "Relight LoRA (Qwen-Image-Edit-2509)",
    match: /2509-relight/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "qwen-light-migration",
    label: "Light Migration LoRA (Qwen-Image-Edit-2509)",
    match: /2509-light-migration/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "qwen-angles",
    label: "Multiple-angles LoRA",
    match: /multiple-angles/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "qwen-layered",
    label: "Qwen-Image-Layered",
    match: /qwen_image_layered/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 20.5,
  },
  {
    id: "qwen-edit-2509",
    label: "Qwen-Image-Edit-2509",
    match: /qwen_image_edit_2509/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 20.4,
  },
  {
    id: "qwen-edit-2511",
    label: "Qwen-Image-Edit-2511",
    match: /qwen_image_edit_2511/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 40.9,
  },
  {
    id: "qwen-image-vae",
    label: "Qwen-Image VAE",
    match: /qwen_image_vae/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "qwen25vl",
    label: "Qwen2.5-VL-7B text encoder",
    match: /qwen_2\.5_vl_7b/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "qwen3vl",
    label: "Qwen3-VL text encoder",
    match: /qwen3vl_/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "qwen3-4b",
    label: "Qwen3-4B text encoder",
    match: /qwen_3_4b/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "qwen35-9b",
    label: "Qwen3.5-9B text encoder (MOSS-Image)",
    match: /qwen3\.5_9b/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  // Audio
  {
    id: "ace-step",
    label: "ACE-Step 1.5",
    match: /ace_?1\.5|acestep|_ace15/,
    license: "MIT",
    commercial: "yes",
    gb: 4.8,
  },
  {
    id: "stable-audio-3",
    label: "Stable Audio 3",
    match: /stable_audio_3/,
    license: "Stability AI Community License",
    commercial: "restricted",
    gb: 2.3,
  },
  {
    id: "t5gemma",
    label: "T5Gemma text encoder (Stable Audio 3)",
    match: /t5gemma/,
    license: "Gemma Terms of Use",
    commercial: "restricted",
  },
  {
    id: "mmaudio",
    label: "MMAudio",
    match: /mmaudio|dfn5b-clip/,
    license: "CC BY-NC 4.0 (weights)",
    commercial: "no",
    gb: 2,
  },
  // Krea 2
  // conradlocke V2 identity/general edit LoRAs: non-commercial on top of the
  // Krea 2 Community License (LICENSE_V2.md; commercial use needs a paid,
  // case-by-case licence). v1/v1.1/v1.2 stay under the Krea 2 license alone.
  // darask0's Krea 2 color/depth control LoRA (krea2-control.safetensors):
  // https://huggingface.co/darask0/Krea-2-color-depth-control answers 401
  // and is gone from darask0's public model list, so its
  // own terms cannot be read. The Krea 2 base license applies regardless.
  {
    id: "krea2-control",
    label: "Krea 2 color/depth control LoRA",
    match: /krea2-control/,
    license: "Unstated (LoRA); Krea 2 Community License (base)",
    commercial: "unverified",
    url: "https://huggingface.co/darask0/Krea-2-color-depth-control",
  },
  {
    id: "krea2-edit-v2",
    label: "Krea 2 Identity Edit V2",
    match: /krea2_(identity|general)_edit_v2/,
    license: "Krea 2 Identity Edit V2 License",
    commercial: "no",
  },
  {
    id: "krea2",
    label: "Krea 2",
    match: /krea.?2|bfs_(head|body)_swap/,
    license: "Krea 2 Community License",
    commercial: "restricted",
    gb: 26.3,
  },
  {
    id: "flux1-vae",
    label: "FLUX.1 VAE (ae)",
    match: /^ae\.safetensors$/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  // FLUX / FIBO / MOSS / others
  {
    id: "flux3",
    label: "FLUX.3 Klein",
    match: /flux3_image_klein/,
    license: "FLUX Kommunity License v1.0",
    commercial: "restricted",
    gb: 11.1,
  },
  {
    id: "flux2-vae",
    label: "FLUX.2 VAE",
    match: /flux2-vae/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "fibo2",
    label: "Bria FIBO 2.0",
    match: /fibo2_/,
    license: "CC BY-NC 4.0",
    commercial: "no",
    gb: 16,
  },
  {
    id: "moss",
    label: "MOSS-Image",
    match: /moss_image/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 10.2,
  },
  {
    id: "z-image",
    label: "Z-Image Turbo",
    match: /z_image_turbo/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 12.3,
  },
  {
    id: "ideogram4",
    label: "Ideogram 4",
    match: /ideogram4/,
    license: "Ideogram Non-Commercial Model Agreement",
    commercial: "no",
    gb: 5.5,
  },
  // Layer Split: loaded by HF repo id (models/SeeThrough/), never a weight
  // file, so the tool picks them up through EXTRA_FAMILIES.
  {
    id: "seethrough-layerdiff",
    label: "see-through LayerDiff3D (SDXL)",
    match: /seethrough.*layerdiff/,
    license: "CreativeML Open RAIL++-M",
    commercial: "yes",
  },
  {
    id: "seethrough-marigold",
    label: "see-through Marigold depth",
    match: /seethrough.*marigold/,
    license: "CreativeML Open RAIL++-M",
    commercial: "yes",
  },
  {
    id: "sdxl",
    label: "SDXL base 1.0",
    match: /sd_xl_base/,
    license: "CreativeML Open RAIL++-M",
    commercial: "yes",
    gb: 6.9,
  },
  {
    id: "ltxv-095",
    label: "LTX-Video 2B 0.9.5",
    match: /ltx-video-2b-v0\.9\.5/,
    license: "Open RAIL-M",
    commercial: "yes",
    gb: 6.3,
  },
  {
    id: "ltxv-098",
    label: "LTX-Video 0.9.8 distilled",
    match: /ltxv-2b-0\.9\.8/,
    license: "LTXV Open Weights License",
    commercial: "restricted",
    gb: 6.3,
  },
  {
    // Community outpaint IC-LoRA (packs/ltx25/video_expand), not gated.
    id: "ltx-23-outpaint",
    label: "LTX-2.3 22B IC-LoRA Outpaint (oumoumad)",
    match: /ltx-2\.3-22b-ic-lora-outpaint/,
    license: "LTX-2 Community License",
    commercial: "restricted",
    gb: 1.3,
  },
  {
    // Lightricks union IC-LoRA (packs/ltx25/vfx_union_control), LTX-2.3.
    id: "ltx-23-union-control",
    label: "LTX-2.3 22B IC-LoRA Union Control",
    match: /ltx-2\.3-22b-ic-lora-union-control/,
    license: "LTX-2 Community License",
    commercial: "restricted",
    gb: 0.65,
  },
  {
    // Community LTX-2.5 LoRAs (packs/ltx25/vfx_ripple, vfx_fluid,
    // vfx_exploded_view), LTX-2.x Community License like the base model.
    id: "ltx-25-community",
    label: "LTX-2.5 community LoRAs (Ripple, ainvfx-fluid, XPLDV)",
    match: /ltx25_ripple|ainvfx-fluid|xpldv/i,
    license: "LTX-2 Community License",
    commercial: "restricted",
  },
  {
    // LTX VFX LoRAs (packs/ltx25/vfx_*), gated on HF; before "ltx-25".
    id: "ltx-25-vfx",
    label: "LTX-2.5 VFX LoRAs (IC-LoRA / effect LoRAs)",
    match: /ltx-2\.5-22b-(ic-)?lora/,
    license: "LTX-2 Community License",
    commercial: "restricted",
  },
  {
    id: "ltx-25",
    label: "LTX-2.5 22B distilled",
    match: /ltx-2\.5-22b/,
    license: "LTX-2 Community License",
    commercial: "restricted",
    gb: 21.5,
  },
  {
    id: "ltx-25-vae",
    label: "LTX-2.5 video/audio VAE + x2 latent upscaler",
    match: /ltx-2\.5-(video-vae|audio-vae|latent-spatial)/,
    license: "LTX-2 Community License",
    commercial: "restricted",
  },
  {
    id: "gemma4-ltx",
    label: "Gemma 4 12B text encoder (LTX-2.5)",
    match: /gemma4-12b/,
    license: "Gemma Terms of Use",
    commercial: "restricted",
    gb: 15.4,
  },
  {
    id: "t5xxl",
    label: "T5-XXL text encoder",
    match: /t5xxl/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "lucy-edit",
    label: "Lucy Edit Dev",
    match: /lucy-edit/,
    license: "Lucy Edit Dev Non-Commercial License",
    commercial: "no",
    gb: 10,
  },
  {
    id: "seedvr2",
    label: "SeedVR2",
    match: /seedvr2/,
    license: "Apache-2.0",
    commercial: "yes",
    gb: 3.4,
  },
  {
    // Photo upscale (VOSR2): loaded by bundle folder name (models/vosr2/VOSR2/),
    // never a weight file, so the card picks it up through EXTRA_FAMILIES.
    // The node pack is Apache-2.0; no weights license is documented here, so
    // users are pointed at the CSWRY/VOSR model card.
    id: "vosr2",
    label: "VOSR 2.0",
    match: /vosr2/,
    license: "Unstated (weights)",
    commercial: "unverified",
    gb: 5.6,
    url: "https://huggingface.co/CSWRY/VOSR",
  },
  {
    // Upscale video's NVIDIA RTX engine: no weight files (the models ship
    // inside NVIDIA's proprietary nvidia-vfx SDK), so the card picks it up
    // through EXTRA_FAMILIES. Closed SDK, never open weights: "check".
    id: "nvidia-vfx",
    label: "NVIDIA RTX Video SDK (nvidia-vfx)",
    match: /(?!)/,
    license: "NVIDIA proprietary SDK (nvidia-vfx)",
    commercial: "unverified",
    url: "https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI",
  },
  {
    id: "rife",
    label: "RIFE",
    match: /^rife/,
    license: "MIT",
    commercial: "yes",
  },
  {
    id: "realesrgan",
    label: "Real-ESRGAN",
    match: /realesrgan/,
    license: "BSD-3-Clause",
    commercial: "yes",
  },
  {
    id: "birefnet",
    label: "BiRefNet",
    match: /birefnet/,
    license: "MIT",
    commercial: "yes",
  },
  {
    // Person boxes for SAM 3D Body (Comfy-Org/RT-DETR, Apache-2.0 card).
    id: "rt-detr",
    label: "RT-DETRv4",
    match: /rt_detr/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "yolov8",
    label: "YOLOv8 face/hand detectors (ultralytics)",
    match: /yolov8/,
    license: "AGPL-3.0 (ultralytics runtime)",
    commercial: "restricted",
  },
  {
    id: "sam31",
    label: "SAM 3.1",
    match: /^sam3/,
    // Meta SAM License (2025-11-19): royalty-free incl. commercial use, with
    // trade-control / prohibited-use terms (like DINOv3). Not CC BY-NC.
    license: "SAM License",
    commercial: "yes",
  },
  {
    // Before dinov3: the file name carries "dinov3" (its backbone).
    id: "sam3d-body",
    label: "SAM 3D Body",
    match: /sam_3d_body/,
    // Same Meta SAM License (2025-11-19) as SAM 3.1: commercial use allowed,
    // trade-control / prohibited-use terms.
    license: "SAM License",
    commercial: "yes",
    gb: 2.83,
  },
  {
    // Imagine pack only; SeFiPipelineLoader takes a model directory, not a
    // weight file (licenseConsistency.test.ts scans it as model_dir).
    id: "sefi",
    label: "SeFi-Image",
    match: /sefi-image/,
    license: "CC BY-NC 4.0",
    commercial: "no",
  },
  {
    id: "vibevoice",
    label: "VibeVoice (Realtime 0.5B, 1.5B for cloning)",
    match: /vibevoice/,
    license: "MIT",
    commercial: "yes",
  },
  {
    id: "kokoro",
    label: "Kokoro-82M (CPU)",
    match: /kokoro/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "chatterbox",
    label: "Chatterbox (Resemble AI)",
    match: /chatterbox|^t3_(cfg|mtl)|^s3gen/,
    license: "MIT",
    commercial: "yes",
  },
  {
    // Music Video stems (cj_stems). Demucs code is MIT; torchaudio does not
    // state separate terms for the HDEMUCS_HIGH_MUSDB_PLUS weights (trained
    // on MUSDB-HQ + 150 internal songs; see the url below),
    // so users are told to check the license.
    id: "hdemucs",
    label: "Hybrid Demucs (torchaudio HDEMUCS_HIGH)",
    match: /hdemucs/,
    license: "MIT (code); Unstated (weights)",
    commercial: "unverified",
    url: "https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.html",
  },
  {
    // Remove video background's named-subject engine. The file lives in the
    // node pack's checkpoint folder, so EXTRA_FAMILIES names it for the card.
    id: "matanyone2",
    label: "MatAnyone2",
    match: /matanyone/,
    license: "S-Lab License 1.0",
    commercial: "no",
  },
  {
    id: "triposr",
    label: "TripoSR",
    match: /triposr/,
    license: "MIT",
    commercial: "yes",
    gb: 1.7,
  },
  {
    id: "trellis2",
    label: "TRELLIS.2",
    match: /trellis_2/,
    license: "MIT",
    commercial: "yes",
    gb: 5.3,
  },
  {
    id: "pixal3d",
    label: "Pixal3D",
    match: /pixal3d/,
    license: "MIT",
    commercial: "yes",
    gb: 5.6,
  },
  {
    // VAST-AI/TripoSplat card: MIT (diffusion model + splat VAE decoder).
    id: "triposplat",
    label: "TripoSplat",
    match: /triposplat/,
    license: "MIT",
    commercial: "yes",
    gb: 0.74,
  },
  {
    id: "moge2",
    label: "MoGe-2",
    match: /moge_2/,
    license: "MIT",
    commercial: "yes",
  },
  {
    // Ruicheng/moge-3-vitg card: MIT (Comfy-Org/MoGe repack).
    id: "moge3",
    label: "MoGe-3",
    match: /moge_3/,
    license: "MIT",
    commercial: "yes",
    gb: 2.5,
  },
  {
    // huawei-bayerlab/marigold-v2-0 card: Apache-2.0 (LoRAs, VAEs and
    // conditionings; repacked as Comfy-Org/marigold-v2-0). Runs on
    // Qwen-Image-Edit-2509, which keeps its own family.
    id: "marigold-v2",
    label: "Marigold V2",
    match: /marigold_v2/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "da3",
    label: "Depth Anything 3",
    match: /depth_anything_3/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    // Character swap Motion guide (pose). Comfy-Org/SDPose card: MIT; upstream
    // teemosliang/SDPose-Wholebody: MIT.
    id: "sdpose",
    label: "SDPose whole-body",
    match: /sdpose/,
    license: "MIT",
    commercial: "yes",
  },
  {
    // Person detector shipped in Comfy-Org/SDPose (card: MIT); upstream
    // RT-DETRs/RT-DETRv4 LICENSE: Apache-2.0.
    id: "rtdetr",
    label: "RT-DETRv4 person detector",
    match: /rt_detr/,
    license: "Apache-2.0",
    commercial: "yes",
  },
  {
    id: "dinov3",
    label: "DINOv3",
    match: /dino_?v3/,
    license: "DINOv3 License",
    commercial: "yes",
  },
];

export function familyFor(file: string): ModelFamily | undefined {
  const f = file.replace(/\\/g, "/").toLowerCase();
  return MODEL_FAMILIES.find((m) => m.match.test(f));
}

const COMMERCIAL_RANK: Record<Commercial, number> = {
  yes: 0,
  unverified: 1,
  restricted: 2,
  no: 3,
};

/** The most restrictive status wins (no > restricted > unverified > yes). */
export function worstCommercial(list: Commercial[]): Commercial {
  return list.reduce<Commercial>(
    (acc, c) => (COMMERCIAL_RANK[c] > COMMERCIAL_RANK[acc] ? c : acc),
    "yes",
  );
}

// Workflow -> weight files

const WEIGHT_EXT = /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx|sft)$/i;
const LORA_LOADERS = new Set(["LoraLoaderModelOnly", "LoraLoader"]);

/** A LoRA loaded at strength 0 is inert: the graph runs without it. */
function inertLora(node: Workflow[string]): boolean {
  if (!LORA_LOADERS.has(node.class_type)) return false;
  const sm = node.inputs?.strength_model;
  const sc = node.inputs?.strength_clip;
  return sm === 0 && (sc === undefined || sc === 0);
}

/**
 * Every weight file a graph's nodes reference (any input whose value ends in
 * a weight extension), deduped, in node order. Inert LoRAs and nodes titled
 * as optional local filter add-ons (not tool models) are skipped.
 */
export function workflowWeightFiles(workflow: Workflow): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of workflowWeightRefs(workflow)) {
    const key = ref.file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref.file);
  }
  return out;
}

/** One weight-file reference: the node class and input that load it. */
export interface WeightRef {
  file: string;
  classType: string;
  input: string;
  node: Workflow[string];
}

/**
 * Every weight-file reference in node order, not deduped (the same file can
 * be loaded by two loader classes). Same filters as workflowWeightFiles;
 * `includeInert` keeps strength-0 LoRAs (off by default, enabled by a flag).
 */
export function workflowWeightRefs(
  workflow: Workflow,
  opts: { includeInert?: boolean } = {},
): WeightRef[] {
  const out: WeightRef[] = [];
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== "object" || !node.class_type) continue;
    if (!opts.includeInert && inertLora(node)) continue;
    if (/filter lora/i.test(node._meta?.title ?? "")) continue;
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (typeof value !== "string") continue;
      const file = value.trim().replace(/\\/g, "/");
      if (!WEIGHT_EXT.test(file)) continue;
      out.push({ file, classType: node.class_type, input, node });
    }
  }
  return out;
}

// Tool -> actions -> workflows

interface Registry {
  actions: Record<string, { template?: string }>;
  templates: Record<string, { file?: string }>;
}
const REGISTRY = registryJson as unknown as Registry;

/**
 * Action tools whose card does not name its backend action directly (edit-LoRA
 * cards resolve through the installed LoRA's family at run time).
 */
const EXTRA_ACTIONS: Partial<Record<string, string[]>> = {
  edit_photo: ["edit_instruct", "edit_ostris", "edit_qwen", "edit_inpaint"],
  remove_object: ["edit_instruct"],
  restyle_locked: ["edit_structural"],
  replace_person: ["edit_instruct_dual"],
  pose_character: ["edit_pose"],
  // Mode "mannequin" queues the masked graph; "full" is the card's own.
  character_swap: ["character_swap_masked"],
  // Preset "reference" (Match a reference) queues the Light-Migration graph.
  relight: ["light_migration"],
  // Engines Best / FlashVSR / NVIDIA RTX / LTX x2 queue their own graphs; the
  // card's own graph is the per-frame one.
  // Engine "One named subject" queues the MatAnyone2 graph.
  upscale_video: [
    "seedvr2_upscale",
    "flashvsr_upscale",
    "rtx_upscale",
    "ltx_upscale_x2",
  ],
};

/**
 * Registry templates a card can load without a matching action id (engine
 * variants picked by a param): listed as optional graphs of that card.
 */
const EXTRA_TEMPLATES: Partial<Record<string, string[]>> = {
  // params.engine "wan" (experimental) swaps in the VACE graph.
  video_expand: ["video_expand_wan"],
};

/** Families for cards that have no workflow graph in this repo. */
export const EXTRA_FAMILIES: Partial<Record<string, string[]>> = {
  crossview: ["h3"],
  // make_3d runs the TRELLIS.2 graph (registry); its weights come from it.
  // VibeVoiceTTS / Kokoro nodes take a model name, not a weight file.
  voiceover: ["vibevoice", "kokoro"],
  see_through: ["seethrough-layerdiff", "seethrough-marigold"],
  upscale_vosr2: ["vosr2"],
  rtx_upscale: ["nvidia-vfx"],
  subject_matte: ["matanyone2"],
};

/**
 * Describe runs on the optional style-library service, not a ComfyUI graph:
 * its captioner is Qwen3-VL-4B-Instruct (or a finetune of it). Never matched
 * against weight paths.
 */
const DESCRIBE_CAPTIONER: ModelFamily = {
  id: "qwen3vl-4b-caption",
  label: "Qwen3-VL 4B Instruct (style-library captioner)",
  match: /(?!)/,
  license: "Apache-2.0",
  commercial: "yes",
  url: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct",
};

/** Free-text model note for cards that do not run a ComfyUI graph. */
const MODEL_NOTES: Partial<Record<string, string>> = {
  describe: "Vision-language captioner of the optional style-library service",
  vectorize: "none (CPU tracer)",
  sdr_to_hdr: "none (core ImageSDRToHDR curve)",
  rtx_upscale: "none (bundled in NVIDIA's nvidia-vfx SDK)",
};

/** VRAM cell for cards whose cost is not a GPU model. */
const VRAM_NOTES: Partial<Record<string, string>> = {
  describe: "n/a (external)",
  vectorize: "CPU only",
  h3_charsheet: "24 GB (Large sheet: 32 GB+)",
  sdr_to_hdr: "negligible (no model)",
  see_through: "12 GB+ (Low VRAM: ~10 GB)",
  upscale_seedvr2: "8 GB (7B: 12 GB+)",
  upscale_video: "8 GB (SeedVR2 7B: 12 GB+)",
  moge_geometry: "light (MoGe-3 giant: 2.5 GB model)",
  rtx_upscale: "~150 MB (NVIDIA RTX GPU only)",
  subject_matte: "5 GB (MatAnyone2 at 720p; more at 1080p)",
};

export function workflowRelForAction(action: string): string | undefined {
  if (STATIC_WORKFLOWS[action]) return STATIC_WORKFLOWS[action];
  const template = REGISTRY.actions[action]?.template ?? action;
  return REGISTRY.templates[template]?.file;
}

/** Backend actions a card can queue (its own id, mode pickers, model check). */
export function actionsForTool(spec: ActionToolSpec): string[] {
  const ids = [
    spec.id as string,
    ...(spec.modelCheck ? [spec.modelCheck.action] : []),
    // Mode pickers whose ids are backend actions; paramOnly pickers are
    // plain params even when an id collides with an action (pan_left).
    ...(spec.pickers ?? [])
      .filter((p) => !p.paramOnly)
      .flatMap((p) => p.options.map((o) => o.id)),
    ...(EXTRA_ACTIONS[spec.id] ?? []),
  ];
  const actions = [...new Set(ids)].filter(
    (a) => REGISTRY.actions[a] || STATIC_WORKFLOWS[a],
  );
  const templates = (EXTRA_TEMPLATES[spec.id] ?? []).filter(
    (t) => REGISTRY.templates[t] && !actions.includes(t),
  );
  return [...actions, ...templates];
}

// Inputs

function pickerSummary(spec: ActionToolSpec): string[] {
  return (spec.pickers ?? [])
    .filter((p) => p.options.length > 1)
    .map((p) => `${p.title} (${p.options.length})`);
}

/** "label (optional)" once, whether or not the UI label already says so. */
function opt(label: string, optional: boolean): string {
  const base = label
    .replace(/\s*\(optional\)/gi, "")
    .trim()
    .toLowerCase();
  return optional || /\(optional\)/i.test(label) ? `${base} (optional)` : base;
}

export function actionInputs(spec: ActionToolSpec): string {
  const parts: string[] = [];
  if (spec.special === "describe") parts.push("image");
  else if (spec.videoInput) parts.push(`video: ${opt(spec.videoInput, false)}`);
  else if (spec.noSourceInput) parts.push("text only");
  else parts.push("image");
  if (spec.secondImage)
    parts.push(
      opt(
        `${spec.secondImage.replace(/\s*\(optional\)/gi, "")} image`,
        !!spec.secondImageOptional || /\(optional\)/i.test(spec.secondImage),
      ),
    );
  if (spec.audioInput)
    parts.push(
      `audio: ${opt(spec.audioInput, false)}${spec.audioWhen ? " (some modes)" : ""}`,
    );
  if (spec.text) parts.push(opt(spec.text.label, !spec.text.required));
  if (spec.secondText)
    parts.push(opt(spec.secondText.label, !spec.secondText.required));
  const picks = pickerSummary(spec);
  if (picks.length) parts.push(`options: ${picks.join(", ")}`);
  return parts.join("; ");
}

export function catalogInputs(tool: EditToolDef): string {
  const parts: string[] = [];
  const refs = tool.refLabels.length ? tool.refLabels : ["Image"];
  parts.push(
    refs
      .map((r) => r.toLowerCase())
      .map((r) => (/\b(image|photo)\b/.test(r) ? r : `${r} image`))
      .join(" + "),
  );
  if (tool.needsMask) parts.push("mask");
  if (tool.promptMode === "required") parts.push("prompt");
  else if (tool.promptMode === "optional") parts.push("prompt (optional)");
  if (tool.outpaint) parts.push("expand preset");
  const opts = tool.options.filter((o) => o.values.length > 1);
  if (opts.length)
    parts.push(
      `options: ${opts.map((o) => `${o.label} (${o.values.length})`).join(", ")}`,
    );
  return parts.join("; ");
}

// VRAM ballpark

/** Weights-only heuristic from the largest main model file a tool loads. */
export function vramTier(families: ModelFamily[]): string {
  const gbs = families.map((f) => f.gb).filter((g): g is number => g != null);
  if (!gbs.length) return families.length ? "light" : "n/a";
  const max = Math.max(...gbs);
  if (max <= 7) return "8 GB";
  if (max <= 11) return "12 GB";
  if (max <= 15) return "16 GB";
  if (max <= 22) return "24 GB";
  return "24 GB + offload";
}

// Rendering

export interface ToolDocRow {
  key: string;
  title: string;
  category: string;
  summary: string;
  inputs: string;
  families: ModelFamily[];
  modelNote?: string;
  commercial: Commercial;
  vram: string;
  notes: string[];
  /** Third-party idea/code credit (ActionToolSpec.credit). */
  credit?: string;
}

export interface ToolsDocResult {
  markdown: string;
  rows: ToolDocRow[];
  /** Weight files no MODEL_FAMILIES entry matches (must stay empty). */
  unmapped: string[];
  /** Workflow paths a tool resolves to that could not be loaded. */
  missingWorkflows: string[];
}

export type LoadWorkflow = (rel: string) => Workflow | null;

const FAMILY_BY_ID = new Map(MODEL_FAMILIES.map((f) => [f.id, f]));

export function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export const COMMERCIAL_CELL: Record<Commercial, string> = {
  yes: "yes",
  restricted: "restricted",
  no: "**no (nc)**",
  unverified: "check license",
};

function familiesFromWorkflows(
  rels: string[],
  load: LoadWorkflow,
  unmapped: Set<string>,
  missing: Set<string>,
): ModelFamily[] {
  const out: ModelFamily[] = [];
  for (const rel of rels) {
    const wf = load(rel);
    if (!wf) {
      missing.add(rel);
      continue;
    }
    for (const file of workflowWeightFiles(wf)) {
      const fam = familyFor(file);
      if (!fam) unmapped.add(file);
      else if (!out.includes(fam)) out.push(fam);
    }
  }
  return out;
}

export function buildToolDocRows(
  load: LoadWorkflow,
  actionTools: ActionToolSpec[] = ACTION_TOOLS,
  catalogTools: EditToolDef[] = getEditTools(),
): Omit<ToolsDocResult, "markdown"> {
  const unmapped = new Set<string>();
  const missing = new Set<string>();
  const rows: ToolDocRow[] = [];

  for (const spec of actionTools) {
    const rels = [
      ...new Set(
        actionsForTool(spec)
          .map(workflowRelForAction)
          .filter((r): r is string => !!r),
      ),
    ];
    const families = familiesFromWorkflows(rels, load, unmapped, missing);
    // Engine actions listed in EXTRA_ACTIONS bring their EXTRA_FAMILIES too.
    for (const id of [spec.id, ...(EXTRA_ACTIONS[spec.id] ?? [])].flatMap(
      (a) => EXTRA_FAMILIES[a] ?? [],
    )) {
      const fam = FAMILY_BY_ID.get(id);
      if (fam && !families.includes(fam)) families.push(fam);
    }
    const notes: string[] = [];
    if (spec.requiredPack === "minimax") notes.push("optional MiniMax H3 pack");
    else if (spec.requiredPack) notes.push(`\`${spec.requiredPack}\` pack`);
    if (spec.usesEditLora) notes.push("needs an installed edit LoRA");
    if (spec.requiresNodes)
      notes.push("needs extra custom nodes (card disabled until installed)");
    if (spec.special === "describe") {
      notes.push("needs the optional style-library service");
      families.push(DESCRIBE_CAPTIONER);
    }
    rows.push({
      key: `action:${spec.id}`,
      title: spec.title,
      category: spec.category,
      summary: spec.subtitle,
      inputs: actionInputs(spec),
      families,
      modelNote: MODEL_NOTES[spec.id],
      commercial: worstCommercial(families.map((f) => f.commercial)),
      vram: VRAM_NOTES[spec.id] ?? vramTier(families),
      notes: spec.credit ? [...notes, "see Credits"] : notes,
      ...(spec.credit ? { credit: spec.credit } : {}),
    });
  }

  for (const tool of catalogTools) {
    const rel =
      STATIC_WORKFLOWS[tool.packAction] ??
      workflowRelForAction(tool.packAction);
    const families = familiesFromWorkflows(
      rel ? [rel] : [],
      load,
      unmapped,
      missing,
    );
    if (!rel) missing.add(`${tool.pack}:${tool.packAction}`);
    // The tool's own LoRAs are injected at run time (not in the base graph)
    // and can carry stricter terms than the base (the Krea 2 V2 edit LoRA is
    // non-commercial). Unmapped LoRA names fall back to the registry license.
    for (const l of tool.loras) {
      const fam = familyFor(l.file);
      if (fam && !families.includes(fam)) families.push(fam);
    }
    const license = toolLicense(tool);
    const statuses = families.map((f) => f.commercial);
    // The catalog's own nc flag always counts; an unverified flag only when
    // the graph's families say nothing more specific.
    if (license.commercial === false) statuses.push("no");
    else if (license.commercial === null && !families.length)
      statuses.push("unverified");
    const notes = [`base: ${tool.base}`];
    if (tool.loras.length) notes.push(`LoRA: [source](${tool.sourceUrl})`);
    if (tool.requiresNodes) notes.push(`needs ${tool.requiresNodes}`);
    rows.push({
      key: `catalog:${tool.id}`,
      title: tool.label,
      category: tool.category,
      summary: tool.description,
      inputs: catalogInputs(tool),
      families,
      commercial: worstCommercial(statuses),
      vram: vramTier(families),
      notes,
    });
  }

  return {
    rows,
    unmapped: [...unmapped].sort(),
    missingWorkflows: [...missing].sort(),
  };
}

export function categoryOrder(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

function rowTable(rows: ToolDocRow[]): string[] {
  const out = [
    "| Tool | What it does | Inputs | Models | Commercial | VRAM | Notes |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const models = r.families.length
      ? r.families.map((f) => f.label).join(", ")
      : (r.modelNote ?? "none");
    out.push(
      `| ${cell(r.title)} | ${cell(r.summary)} | ${cell(r.inputs)} | ${cell(models)} | ${COMMERCIAL_CELL[r.commercial]} | ${r.vram} | ${cell(r.notes.join("; "))} |`,
    );
  }
  return out;
}

/** Tools page card counts (src/lib/tools/hubCounts.json). */
export interface HubToolCounts {
  tools: number;
  graphTools: number;
  chainedTools: number;
}

export function renderToolsDoc(
  load: LoadWorkflow,
  hub?: HubToolCounts,
): ToolsDocResult {
  const built = buildToolDocRows(load);
  const action = built.rows.filter((r) => r.key.startsWith("action:"));
  const catalog = built.rows.filter((r) => r.key.startsWith("catalog:"));
  const intro = hub
    ? [
        `The Tools page has ${hub.tools} tools. ${hub.graphTools} of them are listed here with the models they load,`,
        `one row per engine (a card with an engine picker has several rows): ${built.rows.length} rows,`,
        `${action.length} action tools and ${catalog.length} catalog (LoRA) tools. The other ${hub.chainedTools} are`,
        "multi-step tools and templates (Storyboard, ClipCut, Video Translator, ...) that chain these.",
      ]
    : [
        `This page lists ${action.length} action tools and ${catalog.length} catalog (LoRA) tools.`,
      ];
  const lines: string[] = [
    "# Tools reference",
    "",
    "<!-- Generated by src/lib/tools/toolsDoc.ts. Do not edit by hand: run `npm run docs:tools`. -->",
    "",
    ...intro,
    "Models are read from the ComfyUI graph each tool queues, so this page tracks the shipped workflows.",
    "",
    "- **Commercial** is the most restrictive license among the models a tool loads:",
    "  `yes` (permissive), `restricted` (revenue cap, territory or copyleft condition),",
    "  **no (nc)** (non-commercial weights) or `check license` (the author states no license).",
    "  Details and links: [MODELS.md](../MODELS.md).",
    "- **VRAM** is a weights-only ballpark from the largest main model the tool loads",
    "  (`8 GB` / `12 GB` / `16 GB` / `24 GB`; `24 GB + offload` runs on a 24 GB card with",
    "  ComfyUI's model offloading, slower). `light` = small helper models only. Text encoders",
    "  and VAEs are loaded and released per stage. Run times depend on the GPU and are not listed.",
    "- A card whose models, nodes or pack are missing stays disabled with the reason shown;",
    "  `GET /api/tools/model-status` lists the missing files.",
    "",
    "## Action tools",
    "",
    "Run through `POST /api/jobs/action` (see [tools-api.md](tools-api.md)).",
    "",
  ];
  const cats = [...new Set(action.map((r) => r.category))].sort(
    (a, b) => categoryOrder(a) - categoryOrder(b),
  );
  for (const cat of cats) {
    lines.push(
      `### ${cat}`,
      "",
      ...rowTable(action.filter((r) => r.category === cat)),
      "",
    );
  }
  lines.push(
    "## Catalog tools",
    "",
    "One edit LoRA (or two) on a base edit model, listed by `GET /api/tools` and run through",
    "`POST /api/jobs/tool`. Registry: `src/lib/tools/editToolRegistry.json`.",
    "",
  );
  const ccats = [...new Set(catalog.map((r) => r.category))].sort(
    (a, b) => categoryOrder(a) - categoryOrder(b) || a.localeCompare(b),
  );
  for (const cat of ccats) {
    lines.push(
      `### ${cat}`,
      "",
      ...rowTable(catalog.filter((r) => r.category === cat)),
      "",
    );
  }
  lines.push(
    "## Speech pipelines",
    "",
    "Multi-step audio tools on the `audio` pack. They chain several graphs, so they have no row above.",
    "",
    "| Tool | Steps | Models |",
    "|---|---|---|",
    `| ${cell(toolTitle(DUB_VIDEO_KEY, "Dub Video"))} | transcribe (Whisper ASR), translate, re-voice (TTS), optional lipsync | ${cell(DUB_VIDEO_MODEL_LINE)} |`,
    `| Voice Changer | speech-to-speech voice conversion, keeps timing | ${cell(VOICE_CHANGER_MODEL_LINE)} |`,
    "",
    ...hairdeckDocLines(),
  );
  const credited = built.rows.filter((r) => r.credit);
  if (credited.length)
    lines.push(
      "## Credits",
      "",
      "Tools built on ideas or code from other open-source projects:",
      "",
      ...credited.map((r) => `- **${r.title}**: ${r.credit}`),
      "",
    );
  const used = MODEL_FAMILIES.filter((f) =>
    built.rows.some((r) => r.families.includes(f)),
  );
  lines.push(
    "## Model families used by the tools",
    "",
    "| Family | License | Commercial | Tools |",
    "|---|---|---|---|",
    ...used.map(
      (f) =>
        `| ${cell(f.label)} | ${cell(f.license)} | ${COMMERCIAL_CELL[f.commercial]} | ${built.rows.filter((r) => r.families.includes(f)).length} |`,
    ),
    "",
  );
  return { ...built, markdown: lines.join("\n") };
}
