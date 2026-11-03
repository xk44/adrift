/**
 * Curated "setup templates" for the Manager tab. Each bundles a small set of
 * known-clean node packs behind a one-click install so users don't have to hunt
 * the 7k-entry catalog. Pack IDs here are CNR ids / GitHub URLs; all still pass
 * through the supply-chain blocklist at install time (belt and suspenders).
 *
 * Keep these to widely-used, sweep-clean packs. Do NOT add anything on the
 * blocklist — the choke point would refuse it anyway, but curation should be clean.
 */
export interface ManagerTemplate {
  id: string;
  name: string;
  description: string;
  /** Manager pack IDs (CNR id or GitHub URL) to install. */
  packs: string[];
  /** What the user unlocks after installing. */
  unlocks: string;
}

export const MANAGER_TEMPLATES: ManagerTemplate[] = [
  {
    id: "essentials",
    name: "Workflow Essentials",
    description:
      "The near-universal quality-of-life packs most ComfyUI workflows expect: custom scripts, extra nodes, and the rgthree control suite.",
    packs: ["comfyui-custom-scripts", "comfyui_essentials", "rgthree-comfy"],
    unlocks: "Cleaner graphs, node previews, and reroute/muting controls.",
  },
  {
    id: "controlnet",
    name: "ControlNet & Preprocessors",
    description:
      "Structure-guided generation: the ControlNet aux preprocessors (pose, depth, canny, lineart) plus the Advanced-ControlNet apply nodes.",
    packs: ["comfyui_controlnet_aux", "comfyui-advanced-controlnet"],
    unlocks: "Pose/depth/edge conditioning for precise composition control.",
  },
  {
    id: "upscaling",
    name: "Upscaling Suite",
    description:
      "High-res detail: Ultimate SD Upscale for tiled diffusion upscaling plus the Impact Pack for detailer/face-fix passes.",
    packs: ["comfyui_ultimatesdupscale", "comfyui-impact-pack"],
    unlocks: "Tiled upscales and automatic face/hand detailing.",
  },
  {
    id: "video",
    name: "Video & Animation",
    description:
      "Motion pipelines: VideoHelperSuite for frame IO/encoding and AnimateDiff-Evolved for text-to-video.",
    packs: ["comfyui-videohelpersuite", "comfyui-animatediff-evolved"],
    unlocks: "Load/save video and generate animated clips.",
  },
];
