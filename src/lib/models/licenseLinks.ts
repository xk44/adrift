/**
 * License name -> link to the license text. One table for every place that
 * shows a model license (starter packs, the Tools setup drawer, docs/models.md).
 *
 * Sources: each model card's Hugging Face license metadata / LICENSE file,
 * or the canonical license page for standard licenses (see MODELS.md in the
 * public export). A name with no
 * verified link maps to null on purpose ("unknown"), so the UI shows the
 * name without a link instead of a guessed URL.
 */

export const LICENSE_URLS: Record<string, string | null> = {
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  MIT: "https://opensource.org/license/mit",
  "BSD-3-Clause": "https://opensource.org/license/bsd-3-clause",
  "AGPL-3.0": "https://github.com/ultralytics/ultralytics/blob/main/LICENSE",
  "CC BY-NC 4.0": "https://creativecommons.org/licenses/by-nc/4.0/",
  "Krea 2 Community License":
    "https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf",
  // license_link on conradlocke/krea2-identity-edit:
  // V2 files only, non-commercial; commercial use needs a paid licence.
  "Krea 2 Identity Edit V2 License":
    "https://huggingface.co/conradlocke/krea2-identity-edit/blob/main/LICENSE_V2.md",
  "FLUX Kommunity License v1.0":
    "https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md",
  "Qwen Research License":
    "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE",
  "MiniMax H3 Community License":
    "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
  "Stability AI Community License":
    "https://huggingface.co/stabilityai/stable-audio-3-small-sfx/blob/main/LICENSE.md",
  "Gemma Terms of Use": "https://ai.google.dev/gemma/terms",
  "Ideogram Non-Commercial Model Agreement":
    "https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md",
  "CreativeML Open RAIL++-M":
    "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md",
  "Open RAIL-M":
    "https://huggingface.co/Lightricks/LTX-Video/blob/main/ltx-video-2b-v0.9.5.license.txt",
  "LTXV Open Weights License":
    "https://huggingface.co/Lightricks/LTX-Video/blob/main/LTX-Video-Open-Weights-License-0.X.txt",
  "LTX-2 Community License":
    "https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x",
  // license_link on the card of the repo we download from
  // (decart-ai/Lucy-Edit-Dev-ComfyUI).
  "Lucy Edit Dev Non-Commercial License":
    "https://d2drjpuinn46lb.cloudfront.net/LUCY_EDIT-Non_Commercial_License_17_Sep_2025.pdf",
  "S-Lab License 1.0":
    "https://github.com/pq-yang/MatAnyone2/blob/main/LICENSE.txt",
  "SAM License": "https://huggingface.co/Comfy-Org/sam3.1/blob/main/LICENSE",
  "DINOv3 License":
    "https://ai.meta.com/resources/models-and-libraries/dinov3-license/",
  // license_link on circlestone-labs/Anima; the
  // ElectronGirl Anima Ref Adapter is a derivative under the same license.
  "CircleStone Labs Non-Commercial License":
    "https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md",
  // Not a published license: nothing to link.
  "n/a": null,
  Unstated: null,
  "see source": null,
  // nvidia-vfx (pypi.nvidia.com, LicenseRef-NvidiaProprietary): no public
  // license page verified.
  "NVIDIA proprietary SDK": null,
};

/** "CC BY-NC 4.0 (weights)" -> "CC BY-NC 4.0". */
function bare(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}

/**
 * Link for a license name, or null when none is known. Composite names
 * ("MIT (LoRA); Qwen Research License (base)") link the base model's
 * license, since its terms are the ones that bind the output; otherwise the
 * first part with a known link.
 */
export function licenseUrlFor(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const ordered = [
    ...parts.filter((p) => /\(base\)/i.test(p)),
    ...parts.filter((p) => !/\(base\)/i.test(p)),
  ];
  for (const p of ordered) {
    const url = LICENSE_URLS[p] ?? LICENSE_URLS[bare(p)];
    if (url) return url;
  }
  return null;
}

/** Whether the table knows this name (a link, or an explicit null). */
export function licenseNameKnown(name: string): boolean {
  return name
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .every((p) => p in LICENSE_URLS || bare(p) in LICENSE_URLS);
}
