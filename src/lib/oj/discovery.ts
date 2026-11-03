/**
 * Automatically finds injection points in ComfyUI workflows without hardcoded node IDs.
 * Traces from KSampler upstream to find text encoders and latent dimension nodes.
 */

import type { Workflow, WorkflowSlots, WorkflowNode } from "@/types";
import type {
  ControlNetSlot,
  IPAdapterSlot,
  UpscaleSlot,
  VideoSlot,
  WorkflowCapabilities,
} from "@/types";
import {
  WORKFLOW_VIDEO_OUTPUT_CLASSES,
  WORKFLOW_MESH_OUTPUT_CLASSES,
  WORKFLOW_AUDIO_OUTPUT_CLASSES,
  detectWorkflowType as _detectWorkflowType,
} from "./workflow-analysis";
import type { WorkflowType } from "./workflow-analysis";
export type { WorkflowType };

// Node classes that handle text encoding
const CLIP_TEXT_CLASSES = new Set([
  "CLIPTextEncode",
  "CLIPTextEncodeSDXL",
  "CLIPTextEncodeSDXLRefiner",
  "CLIPTextEncodeFlux",
  "BNK_CLIPTextEncodeAdvanced",
  "ConditioningCombine",
  "CLIPLoader", // Z-Image-Turbo: CLIP loader that feeds into CLIPTextEncode
]);

// Krea 2 edit encoders — instruction-edit nodes that carry the prompt on a
// `prompt` input (not `text`) and ground it on the source image.
const EDIT_PROMPT_CLASSES = new Set([
  "Krea2EditGroundedEncode",
  "TextEncodeKrea2OstrisEdit",
  "TextEncodeQwenImageEditPlus",
  // Qwen-Image-2.1: one node emits positive, negative AND the latent; the
  // negative text rides on its `negative_prompt` input.
  "TextEncodeQwenImage21",
  // MiniMax H3: prompt lives on the conditioning+latent node, not a CLIPTextEncode.
  "MiniMaxH3ImageToVideo",
  "MiniMaxH3ReferenceToVideo",
]);

// Node classes that are CLIP loaders (intermediate nodes)
const CLIP_LOADER_CLASSES = new Set([
  "CLIPLoader",
  "CLIPLoaderSDXL",
  "CLIPLoaderFlux",
]);

// Node classes that handle sampling
const KSAMPLER_CLASSES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "KSamplerSelect",
  "FluxSampler",
]);

// Node classes that create empty latent images
const LATENT_CLASSES = new Set([
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "EmptyLatentImageFlux",
  "EmptySDXLLatentImage",
  "EmptyFlux2LatentImage",
  "EmptyLTXVLatentVideo",
  "LTXVImgToVideo",
  "WanImageToVideo",
  "Wan22ImageToVideoLatent",
  "EmptyHunyuanLatentVideo",
  "EmptyHunyuanVideo15Latent",
  "EmptyMiniMaxH3LatentAV",
  "MiniMaxH3ImageToVideo",
  "MiniMaxH3ReferenceToVideo",
]);

// Remote API partner nodes that own prompt/aspect/seed in a single node
const API_PROMPT_NODE_CLASSES = new Set(["Krea2ImageNode", "SeFiGenerate"]);

// Guider nodes used by SamplerCustomAdvanced graphs
const GUIDER_CLASSES = new Set(["DualModelGuider", "CFGGuider", "BasicGuider"]);

// Node classes for image loading (used in img2img workflows)
const IMAGE_LOADER_CLASSES = new Set([
  "LoadImage",
  "LoadImageMask",
  "LoadImageFromUrl",
]);

// Node classes for VAE encoding (used in img2img)
const VAE_ENCODE_CLASSES = new Set(["VAEEncode", "VAEEncodeForInpaint"]);

// Core ComfyUI node that creates padded pixels plus an outpaint mask
const OUTPAINT_PAD_CLASSES = new Set(["ImagePadForOutpaint"]);

// Node classes for checkpoint/model loading
const CHECKPOINT_LOADER_CLASSES = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "unCLIPCheckpointLoader",
  "UNETLoader",
  "UNETLoaderSDXL",
  "UNETLoaderFlux",
  "ModelSamplingAuraFlow", // Z-Image-Turbo: model sampling wrapper
  "ModelSamplingLTXV",
  "ModelSamplingSD3",
]);

// Node classes for LoRA loading
const LORA_LOADER_CLASSES = new Set(["LoraLoader", "LoraLoaderModelOnly"]);

// Node classes for VAE loading (separate from checkpoint)
const VAE_LOADER_CLASSES = new Set(["VAELoader"]);

// Node classes for ControlNet loading and application
const CONTROLNET_LOADER_CLASSES = new Set([
  "ControlNetLoader",
  "ControlNetLoadFromDiffusers",
]);

const CONTROLNET_APPLY_CLASSES = new Set([
  "ControlNetApply",
  "ControlNetApplyAdvanced",
  "SetUnionControlNetType",
  "SETUNIONCONTROLNETTYPE",
]);

const CONTROLNET_PREPROCESSOR_CLASSES = new Set([
  "CannyEdgePreprocessor",
  "DepthAnythingPreprocessor",
  "MiDaS-DepthMapPreprocessor",
  "MiDaSDepthMapPreprocessor",
  "DepthPreprocessor",
  "OpenposePreprocessor",
  "DWPosePreprocessor",
  "MediaPipe-HandPosePreprocessor",
  "LineArtPreprocessor",
  "LineartPreprocessor",
  "HEDPreprocessor",
  "ScribblePreprocessor",
  "InpaintPreprocessor",
  "MangaLinePreprocessor",
  "MLSDPreprocessor",
  "BAE-NormalMapPreprocessor",
  "BinaryPreprocessor",
  "ColorPreprocessor",
  "TilePreprocessor",
]);

// Node classes for IPAdapter
const IPADAPTER_APPLY_CLASSES = new Set([
  "IPAdapterAdvanced",
  "IPAdapter",
  "IPAdapterXXL",
  "IPAdapterPlus",
  "IPAdapterFull",
  "IPAdapterStyle",
  "IPAdapterPrompt",
  "StyleApplyIPAdapter",
]);

const IPADAPTER_LOADER_CLASSES = new Set([
  "IPAdapterModelLoader",
  "IPAdapterInsightFaceLoader",
  "IPAdapterLoad",
]);

// Node classes for upscaling
const UPSCALE_MODEL_CLASSES = new Set([
  "ImageUpscaleWithModel",
  "UpscaleModelLoader",
  "LoadUpscaleModel",
  "UpscaleNode",
]);

// Node classes for video motion/input
const VIDEO_MOTION_CLASSES = new Set([
  "FrameInterpolation",
  "SVD_Sampler",
  "AnimateDiffLoader_Deprecated",
  "AnimateDiffLoaderWithContext",
  "AnimateDiffCombine",
  "AnimateDiffSampling",
  "VHS_VideoCombine",
  "CreateVideo",
  "SaveVideo",
  "SaveWEBM",
  "EmptyLTXVLatentVideo",
  "LTXVImgToVideo",
  "LTXVImgToVideoInplace",
  "LTXVConditioning",
  "WanImageToVideo",
  "Wan22ImageToVideoLatent",
  "EmptyHunyuanLatentVideo",
  "EmptyHunyuanVideo15Latent",
  "EmptyMiniMaxH3LatentAV",
  "MiniMaxH3ImageToVideo",
  "MiniMaxH3ReferenceToVideo",
]);

/**
 * Check if a value is a node reference in ComfyUI format [nodeId, outputIndex]
 */
function isNodeIdRef(v: unknown): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number"
  );
}

function nodeIdToKey(id: string | number): string {
  return String(id);
}

export function findFirstNodeId(
  workflow: Workflow,
  predicate: (node: WorkflowNode) => boolean,
): string | null {
  for (const [id, node] of Object.entries(workflow)) {
    if (node && predicate(node)) return id;
  }
  return null;
}

export function findAllNodeIds(
  workflow: Workflow,
  predicate: (node: WorkflowNode) => boolean,
): string[] {
  const results: string[] = [];
  for (const [id, node] of Object.entries(workflow)) {
    if (node && predicate(node)) results.push(id);
  }
  return results;
}

export function getConnectedNodeId(
  node: WorkflowNode | undefined,
  inputName: string,
): string | null {
  const v = node?.inputs?.[inputName];
  if (!isNodeIdRef(v)) return null;
  return nodeIdToKey(v[0]);
}

/**
 * Get all upstream node IDs connected to any input of a node
 */
export function getUpstreamNodeIds(node: WorkflowNode | undefined): string[] {
  if (!node?.inputs) return [];
  const upstream: string[] = [];
  for (const val of Object.values(node.inputs)) {
    if (isNodeIdRef(val)) {
      upstream.push(nodeIdToKey(val[0]));
    }
  }
  return upstream;
}

/**
 * Follow a conditioning branch ("positive"/"negative") through pass-through
 * nodes that expose that input name, stopping at the first text encoder (or
 * the first node without the branch input). Returns the node to BFS from.
 */
export function followCondBranch(
  workflow: Workflow,
  startId: string | null,
  branch: "positive" | "negative",
): string | null {
  let id = startId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = workflow[id];
    if (
      !node ||
      CLIP_TEXT_CLASSES.has(node.class_type) ||
      EDIT_PROMPT_CLASSES.has(node.class_type)
    )
      break;
    const next = getConnectedNodeId(node, branch);
    if (!next) break;
    id = next;
  }
  return id;
}

/**
 * Trace upstream from a starting node to find a node matching the predicate
 * Uses BFS to explore the node graph
 */
export function traceUpstream(
  workflow: Workflow,
  startId: string | null,
  predicate: (node: WorkflowNode) => boolean,
  maxDepth = 64,
): string | null {
  if (!startId) return null;

  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [
    { id: startId, depth: 0 },
  ];

  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const node = workflow[id];
    if (!node) continue;
    if (predicate(node)) return id;

    if (depth >= maxDepth) continue;

    const inputs = node.inputs ?? {};
    for (const val of Object.values(inputs)) {
      if (isNodeIdRef(val)) {
        queue.push({ id: nodeIdToKey(val[0]), depth: depth + 1 });
      }
    }
  }

  return null;
}

export function traceUpstreamAll(
  workflow: Workflow,
  startId: string | null,
  predicate: (node: WorkflowNode) => boolean,
  maxDepth = 64,
): string[] {
  if (!startId) return [];

  const visited = new Set<string>();
  const results: string[] = [];
  const queue: Array<{ id: string; depth: number }> = [
    { id: startId, depth: 0 },
  ];

  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const node = workflow[id];
    if (!node) continue;
    if (predicate(node)) results.push(id);

    if (depth >= maxDepth) continue;

    const inputs = node.inputs ?? {};
    for (const val of Object.values(inputs)) {
      if (isNodeIdRef(val)) {
        queue.push({ id: nodeIdToKey(val[0]), depth: depth + 1 });
      }
    }
  }

  return results;
}

/**
 * Discover custom-sampling sub-slots for SamplerCustom / SamplerCustomAdvanced
 * graphs (noise / sampler-select / sigmas / guider nodes). Returns undefined
 * for ordinary KSampler workflows.
 */
function discoverCustomSamplingSlots(
  workflow: Workflow,
  samplerId: string,
): WorkflowSlots["customSampling"] {
  const sampler = workflow[samplerId];
  if (
    !sampler ||
    (sampler.class_type !== "SamplerCustom" &&
      sampler.class_type !== "SamplerCustomAdvanced")
  ) {
    return undefined;
  }

  // SamplerCustom keeps noise_seed/cfg on itself; SamplerCustomAdvanced
  // delegates to RandomNoise and a guider node.
  const isAdvanced = sampler.class_type === "SamplerCustomAdvanced";
  const noiseId = isAdvanced ? getConnectedNodeId(sampler, "noise") : samplerId;
  const samplerSelectId = getConnectedNodeId(sampler, "sampler");
  const sigmasId = getConnectedNodeId(sampler, "sigmas");
  const guiderRoot = isAdvanced
    ? getConnectedNodeId(sampler, "guider")
    : undefined;
  const guiderId = guiderRoot
    ? (traceUpstream(workflow, guiderRoot, (n) =>
        GUIDER_CLASSES.has(n.class_type),
      ) ?? guiderRoot)
    : undefined;

  return {
    noiseId: noiseId ?? undefined,
    samplerSelectId: samplerSelectId ?? undefined,
    sigmasId: sigmasId ?? undefined,
    guiderId: guiderId ?? undefined,
  };
}

/**
 * Discover text-to-image workflow slots
 * Finds the KSampler, traces to positive/negative conditioning, and latent dimensions
 */
export function discoverT2ISlots(workflow: Workflow): WorkflowSlots {
  // Remote API partner nodes (Krea 2, etc.) own prompt/aspect/seed themselves —
  // the graph has no sampler/encoder/latent nodes to discover.
  const apiPromptNodeId = findFirstNodeId(workflow, (n) =>
    API_PROMPT_NODE_CLASSES.has(n.class_type),
  );
  if (apiPromptNodeId) {
    return {
      ksamplerId: apiPromptNodeId,
      posTextId: apiPromptNodeId,
      negTextId: apiPromptNodeId,
      latentDimsId: apiPromptNodeId,
      posTextInputName: "prompt",
      apiPromptNodeId,
    };
  }

  // Find the main sampler node. Prefer real samplers over KSamplerSelect,
  // which is only a SAMPLER provider feeding SamplerCustom(Advanced).
  const ksamplerId =
    findFirstNodeId(
      workflow,
      (n) =>
        KSAMPLER_CLASSES.has(n.class_type) && n.class_type !== "KSamplerSelect",
    ) ?? findFirstNodeId(workflow, (n) => KSAMPLER_CLASSES.has(n.class_type));

  if (!ksamplerId) {
    throw new Error(
      "Slot discovery failed: no KSampler/KSamplerAdvanced found in workflow. " +
        "Ensure your workflow contains a standard sampling node.",
    );
  }

  const ksampler = workflow[ksamplerId];

  // Custom-sampling graphs split seed/steps/cfg/sampler across dedicated nodes.
  const customSampling = discoverCustomSamplingSlots(workflow, ksamplerId);

  // Get direct connections from sampler inputs. For SamplerCustomAdvanced the
  // positive/negative conditioning hangs off the guider node instead.
  const condSource = customSampling?.guiderId
    ? workflow[customSampling.guiderId]
    : ksampler;
  // BasicGuider carries a single `conditioning` input instead of positive/negative.
  const posRoot =
    getConnectedNodeId(condSource, "positive") ??
    getConnectedNodeId(condSource, "conditioning");
  const negRoot = getConnectedNodeId(condSource, "negative");
  const latRoot = getConnectedNodeId(ksampler, "latent_image");

  // Walk through conditioning pass-throughs (ReferenceMultiLatent,
  // ControlNetApplyAdvanced, ...) along the matching branch first: a plain BFS
  // from such a node reaches the positive encoder via its `positive` input and
  // would mis-bind the negative slot to it.
  const posStart = followCondBranch(workflow, posRoot, "positive");
  const negStart = followCondBranch(workflow, negRoot, "negative");

  // For Z-Image-Turbo, CLIPLoader feeds CLIPTextEncode which has the actual text input
  const posTextId =
    traceUpstream(
      workflow,
      posStart,
      (n) =>
        CLIP_TEXT_CLASSES.has(n.class_type) && n.inputs?.text !== undefined,
    ) ??
    // Krea2 instruct-edit nodes carry the prompt on `.prompt`; match them before
    // the CLIPLoader fallback (their clip input reaches a loader).
    traceUpstream(workflow, posStart, (n) =>
      EDIT_PROMPT_CLASSES.has(n.class_type),
    ) ??
    traceUpstream(workflow, posStart, (n) =>
      CLIP_LOADER_CLASSES.has(n.class_type),
    ) ??
    posStart;

  const negTextId =
    traceUpstream(
      workflow,
      negStart,
      (n) =>
        CLIP_TEXT_CLASSES.has(n.class_type) && n.inputs?.text !== undefined,
    ) ??
    traceUpstream(workflow, negStart, (n) =>
      EDIT_PROMPT_CLASSES.has(n.class_type),
    ) ??
    traceUpstream(workflow, negStart, (n) =>
      CLIP_LOADER_CLASSES.has(n.class_type),
    ) ??
    negStart ??
    // Positive-only guider graphs (BasicGuider, e.g. MiniMax H3) have no
    // negative conditioning at all. Alias neg to pos: the engine's
    // `negTextId !== posTextId` guard then skips negative injection cleanly.
    posTextId;

  // Find latent dimensions node (EmptyLatentImage or similar)
  const latentDimsId =
    traceUpstream(
      workflow,
      latRoot,
      (n) =>
        typeof n?.inputs?.width === "number" &&
        typeof n?.inputs?.height === "number",
    ) ?? latRoot;

  const missing: string[] = [];
  if (!posTextId) missing.push("positive text encoder");
  if (!negTextId) missing.push("negative text encoder");
  if (!latentDimsId) missing.push("latent dimensions node");

  if (missing.length > 0) {
    throw new Error(
      `Slot discovery failed: could not find ${missing.join(", ")}. ` +
        `Found: pos=${posTextId}, neg=${negTextId}, latent=${latentDimsId}. ` +
        "Ensure your workflow has standard t2i structure with CLIPTextEncode and EmptyLatentImage nodes.",
    );
  }

  // Krea2 edit encoders carry the instruction on `prompt`, not `text`.
  const posTextInputName = EDIT_PROMPT_CLASSES.has(
    workflow[posTextId!]?.class_type,
  )
    ? "prompt"
    : undefined;

  // Single-node encoders that carry both texts (TextEncodeQwenImage21) take the
  // negative on `negative_prompt`; without this the engine's shared-node guard
  // would drop --no entirely.
  const negTextInputName =
    negTextId === posTextId &&
    workflow[negTextId!]?.inputs?.negative_prompt !== undefined
      ? "negative_prompt"
      : undefined;

  const checkpointLoaderId = findFirstNodeId(workflow, (n) =>
    CHECKPOINT_LOADER_CLASSES.has(n.class_type),
  );

  const loraLoaderIds = findAllNodeIds(workflow, (n) =>
    LORA_LOADER_CLASSES.has(n.class_type),
  );

  const vaeLoaderId = findFirstNodeId(workflow, (n) =>
    VAE_LOADER_CLASSES.has(n.class_type),
  );

  return {
    ksamplerId,
    posTextId: posTextId!,
    negTextId: negTextId!,
    latentDimsId: latentDimsId!,
    posTextInputName,
    negTextInputName,
    customSampling,
    checkpointLoaderId: checkpointLoaderId ?? undefined,
    loraLoaderIds: loraLoaderIds.length > 0 ? loraLoaderIds : undefined,
    vaeLoaderId: vaeLoaderId ?? undefined,
  };
}

/**
 * Discover slots in a detailer graph (Impact FaceDetailer chains).
 * There is no KSampler/EmptyLatentImage: the first FaceDetailer node carries
 * seed/steps/cfg/denoise and the positive/negative conditioning, so it stands
 * in for both the sampler and the (absent) latent-dims node. Extra
 * width/height inputs written to it by dimension injection are ignored by
 * ComfyUI's prompt validation.
 */
export function discoverDetailerSlots(workflow: Workflow): WorkflowSlots & {
  imageInputId: string;
} {
  const ksamplerId = findFirstNodeId(
    workflow,
    (n) => n.class_type === "FaceDetailer",
  );
  if (!ksamplerId) {
    throw new Error(
      "Detailer slot discovery failed: no FaceDetailer node found.",
    );
  }
  const imageInputId = findFirstNodeId(workflow, (n) =>
    IMAGE_LOADER_CLASSES.has(n.class_type),
  );
  if (!imageInputId) {
    throw new Error("Detailer slot discovery failed: no LoadImage node found.");
  }
  const detailer = workflow[ksamplerId];
  const posRoot = getConnectedNodeId(detailer, "positive");
  const negRoot = getConnectedNodeId(detailer, "negative");
  const posTextId =
    traceUpstream(
      workflow,
      posRoot,
      (n) =>
        CLIP_TEXT_CLASSES.has(n.class_type) && n.inputs?.text !== undefined,
    ) ?? posRoot;
  const negTextId =
    traceUpstream(
      workflow,
      negRoot,
      (n) =>
        CLIP_TEXT_CLASSES.has(n.class_type) && n.inputs?.text !== undefined,
    ) ?? negRoot;
  if (!posTextId) {
    throw new Error(
      "Detailer slot discovery failed: no positive text encoder found.",
    );
  }
  return {
    ksamplerId,
    posTextId,
    negTextId: negTextId ?? posTextId,
    latentDimsId: ksamplerId,
    imageInputId,
  };
}

/**
 * Discover image-to-image workflow slots
 * Additionally finds image input and VAE encode nodes
 */
export function discoverI2ISlots(workflow: Workflow): WorkflowSlots & {
  imageInputId: string;
  vaeEncodeId?: string;
  padNodeId?: string;
} {
  const baseSlots = discoverT2ISlots(workflow);

  const imageInputId = findFirstNodeId(workflow, (n) =>
    IMAGE_LOADER_CLASSES.has(n.class_type),
  );

  if (!imageInputId) {
    throw new Error(
      "I2I slot discovery failed: no LoadImage node found. " +
        "Ensure your img2img workflow has an image input node.",
    );
  }

  // Find VAE encode node (optional, may be inline)
  const vaeEncodeId =
    findFirstNodeId(workflow, (n) => VAE_ENCODE_CLASSES.has(n.class_type)) ??
    undefined;

  const padNodeId =
    findFirstNodeId(workflow, (n) => OUTPAINT_PAD_CLASSES.has(n.class_type)) ??
    undefined;

  return {
    ...baseSlots,
    imageInputId,
    vaeEncodeId,
    padNodeId,
  };
}

/**
 * Discover inpainting workflow slots
 * Additionally finds mask input node
 */
export function discoverInpaintSlots(workflow: Workflow): WorkflowSlots & {
  imageInputId: string;
  maskInputId: string;
  vaeEncodeId?: string;
} {
  const i2iSlots = discoverI2ISlots(workflow);

  // Find mask input - could be separate LoadImageMask or part of VAEEncodeForInpaint
  let maskInputId = findFirstNodeId(
    workflow,
    (n) => n.class_type === "LoadImageMask",
  );

  // If no dedicated mask loader, check if inpaint VAE encode has mask input
  if (!maskInputId) {
    const inpaintVae = findFirstNodeId(
      workflow,
      (n) => n.class_type === "VAEEncodeForInpaint",
    );
    if (inpaintVae) {
      maskInputId = inpaintVae; // Mask is input to this node
    }
  }

  if (!maskInputId) {
    throw new Error(
      "Inpaint slot discovery failed: no mask input node found. " +
        "Ensure your inpaint workflow has a LoadImageMask or VAEEncodeForInpaint node.",
    );
  }

  return {
    ...i2iSlots,
    maskInputId,
  };
}

// Imported from workflow-analysis — single source of truth
const VIDEO_OUTPUT_CLASSES = WORKFLOW_VIDEO_OUTPUT_CLASSES;
const MESH_OUTPUT_CLASSES = WORKFLOW_MESH_OUTPUT_CLASSES;
const AUDIO_OUTPUT_CLASSES = WORKFLOW_AUDIO_OUTPUT_CLASSES;

export function isVideoWorkflow(workflow: Workflow): boolean {
  return !!findFirstNodeId(workflow, (n) =>
    VIDEO_OUTPUT_CLASSES.has(n.class_type),
  );
}

export function is3DWorkflow(workflow: Workflow): boolean {
  return !!findFirstNodeId(workflow, (n) =>
    MESH_OUTPUT_CLASSES.has(n.class_type),
  );
}

export function isAudioWorkflow(workflow: Workflow): boolean {
  return !!findFirstNodeId(workflow, (n) =>
    AUDIO_OUTPUT_CLASSES.has(n.class_type),
  );
}

/**
 * Discover video workflow slots.
 * Extends T2I/I2I slots with the video output node ID and frame-rate input.
 */
export function discoverVideoSlots(workflow: Workflow): WorkflowSlots & {
  videoOutputId: string;
  imageInputId?: string;
} {
  const hasImageLoader = findFirstNodeId(workflow, (n) =>
    IMAGE_LOADER_CLASSES.has(n.class_type),
  );

  const baseSlots = hasImageLoader
    ? discoverI2ISlots(workflow)
    : discoverT2ISlots(workflow);

  const videoOutputId = findFirstNodeId(workflow, (n) =>
    VIDEO_OUTPUT_CLASSES.has(n.class_type),
  );

  if (!videoOutputId) {
    throw new Error(
      "Video slot discovery failed: no video output node (SaveVideo/CreateVideo/VHS_VideoCombine etc.) found.",
    );
  }

  return {
    ...baseSlots,
    videoOutputId,
    imageInputId: hasImageLoader ?? undefined,
  };
}

/**
 * Auto-detect workflow type based on nodes present.
 * Delegates to the canonical implementation in workflow-analysis.ts.
 */
export function detectWorkflowType(workflow: Workflow): WorkflowType {
  return _detectWorkflowType(workflow);
}

/**
 * Discover ControlNet slots in a workflow.
 * Finds ControlNetLoader, ControlNetApply, preprocessors, and image inputs,
 * tracing their connections to identify the complete ControlNet chain.
 */
export function discoverControlNetSlots(workflow: Workflow): ControlNetSlot[] {
  const slots: ControlNetSlot[] = [];

  const loaderNodes = findAllNodeIds(workflow, (n) =>
    CONTROLNET_LOADER_CLASSES.has(n.class_type),
  );

  const applyNodes = findAllNodeIds(workflow, (n) =>
    CONTROLNET_APPLY_CLASSES.has(n.class_type),
  );

  const preprocessorNodes = findAllNodeIds(workflow, (n) =>
    CONTROLNET_PREPROCESSOR_CLASSES.has(n.class_type),
  );

  // Find all image loader nodes (for ControlNet input images)
  const imageLoaderNodes = findAllNodeIds(workflow, (n) =>
    IMAGE_LOADER_CLASSES.has(n.class_type),
  );

  for (const applyId of applyNodes) {
    const applyNode = workflow[applyId];
    if (!applyNode) continue;

    // Determine which conditioning target this CN applies to
    // by tracing which conditioning the apply node outputs to.
    // Default to positive unless we can confirm otherwise.
    let conditioningTarget: "positive" | "negative" = "positive";

    let loaderId = "";
    const cnInput = applyNode.inputs?.["control_net"];
    if (isNodeIdRef(cnInput)) {
      const cnSource = nodeIdToKey(cnInput[0]);
      if (CONTROLNET_LOADER_CLASSES.has(workflow[cnSource]?.class_type ?? "")) {
        loaderId = cnSource;
      }
    }

    let imageInputId = "";
    const imageInput = applyNode.inputs?.["image"];
    if (isNodeIdRef(imageInput)) {
      const imgSource = nodeIdToKey(imageInput[0]);
      imageInputId = imgSource;
    }

    // Try to find preprocessor between image and apply
    let preprocessorId: string | undefined;
    if (imageInputId) {
      const imgNode = workflow[imageInputId];
      if (imgNode && CONTROLNET_PREPROCESSOR_CLASSES.has(imgNode.class_type)) {
        preprocessorId = imageInputId;
        // The actual image source is the preprocessor's input
        const preprocImageInput = imgNode.inputs?.["image"];
        if (isNodeIdRef(preprocImageInput)) {
          imageInputId = nodeIdToKey(preprocImageInput[0]);
        }
      }
    }
    // Also check if a preprocessor is not the direct image source
    // but is upstream of the apply node
    if (!preprocessorId) {
      for (const preprocId of preprocessorNodes) {
        const preprocNode = workflow[preprocId];
        const preprocOutput = getConnectedNodeId(preprocNode, "image");
        // Check if the preprocessor output feeds the apply or its image input
        if (preprocId === imageInputId) {
          preprocessorId = preprocId;
          break;
        }
      }
    }

    const defaultStrength =
      typeof applyNode.inputs?.["strength"] === "number"
        ? (applyNode.inputs.strength as number)
        : undefined;

    if (loaderId) {
      const loaderNode = workflow[loaderId];
      const defaultModel =
        typeof loaderNode?.inputs?.["control_net_name"] === "string"
          ? (loaderNode.inputs.control_net_name as string)
          : undefined;

      slots.push({
        loaderId,
        applyId,
        preprocessorId,
        imageInputId: imageInputId || loaderId, // fallback if no direct image
        conditioningTarget,
        defaultStrength,
        defaultModel,
      });
    } else {
      // ControlNet apply without a dedicated loader — still usable
      // (the control_net input might come from a combined node)
      slots.push({
        loaderId: applyId, // use apply node as reference
        applyId,
        preprocessorId,
        imageInputId: imageInputId || applyId,
        conditioningTarget,
        defaultStrength,
      });
    }
  }

  // Also check standalone ControlNet loaders not connected to apply nodes
  for (const loaderId of loaderNodes) {
    if (!slots.some((s) => s.loaderId === loaderId)) {
      const loaderNode = workflow[loaderId];
      const defaultModel =
        typeof loaderNode?.inputs?.["control_net_name"] === "string"
          ? (loaderNode.inputs.control_net_name as string)
          : undefined;

      slots.push({
        loaderId,
        applyId: "", // no apply node found in graph
        imageInputId: loaderId,
        conditioningTarget: "positive",
        defaultModel,
      });
    }
  }

  return slots;
}

export function discoverIPAdapterSlots(workflow: Workflow): IPAdapterSlot[] {
  const slots: IPAdapterSlot[] = [];

  const applyNodes = findAllNodeIds(workflow, (n) =>
    IPADAPTER_APPLY_CLASSES.has(n.class_type),
  );

  for (const applyId of applyNodes) {
    const node = workflow[applyId];
    if (!node) continue;

    const imageInput = node.inputs?.["image"];
    let imageInputId: string | undefined;
    if (isNodeIdRef(imageInput)) {
      imageInputId = nodeIdToKey(imageInput[0]);
    }

    slots.push({
      applyId,
      applyClass: node.class_type,
      imageInputId,
    });
  }

  return slots;
}

export function discoverUpscaleSlots(workflow: Workflow): UpscaleSlot[] {
  const slots: UpscaleSlot[] = [];

  const upscaleModelNodes = findAllNodeIds(workflow, (n) =>
    UPSCALE_MODEL_CLASSES.has(n.class_type),
  );

  for (const nodeId of upscaleModelNodes) {
    const node = workflow[nodeId];
    if (!node) continue;

    const modelName =
      typeof node.inputs?.["model_name"] === "string"
        ? node.inputs.model_name
        : typeof node.inputs?.["ckpt_name"] === "string"
          ? node.inputs.ckpt_name
          : undefined;

    slots.push({
      upscaleModelId: nodeId,
      upscaleModelClass: node.class_type,
      defaultModel: modelName as string | undefined,
    });
  }

  return slots;
}

/**
 * Discover video capability slots — motion/frame nodes.
 * Distinct from discoverVideoSlots() which returns WorkflowSlots & {videoOutputId}.
 */
export function discoverVideoCapabilitySlots(workflow: Workflow): VideoSlot[] {
  const slots: VideoSlot[] = [];

  const videoOutputNodes = findAllNodeIds(workflow, (n) =>
    WORKFLOW_VIDEO_OUTPUT_CLASSES.has(n.class_type),
  );

  for (const nodeId of videoOutputNodes) {
    const node = workflow[nodeId];
    if (!node) continue;

    const hasFrameRate =
      "frame_rate" in (node.inputs ?? {}) || "fps" in (node.inputs ?? {});
    const hasMotionInput =
      "motion_scale" in (node.inputs ?? {}) ||
      "motion_bucket_id" in (node.inputs ?? {});

    const hasImageInput = !!findFirstNodeId(workflow, (n) =>
      IMAGE_LOADER_CLASSES.has(n.class_type),
    );

    slots.push({
      videoOutputId: nodeId,
      videoOutputClass: node.class_type,
      motionInputName: hasMotionInput
        ? "motion_bucket_id" in (node.inputs ?? {})
          ? "motion_bucket_id"
          : "motion_scale"
        : undefined,
      frameRateInputName: hasFrameRate
        ? "frame_rate" in (node.inputs ?? {})
          ? "frame_rate"
          : "fps"
        : undefined,
      hasImageInput: hasImageInput || undefined,
    });
  }

  return slots;
}

/**
 * Derive workflow capabilities from discovered slots and node scan.
 * This is the canonical capability check for UI guards (show/hide
 * ControlNet section, upscale button, video controls, etc.).
 */
export function discoverCapabilities(workflow: Workflow): WorkflowCapabilities {
  const classTypes = new Set(Object.values(workflow).map((n) => n.class_type));

  const hasControlNet =
    classTypes.has("ControlNetLoader") ||
    classTypes.has("ControlNetLoadFromDiffusers") ||
    classTypes.has("ControlNetApply") ||
    classTypes.has("ControlNetApplyAdvanced");

  const hasIPAdapter = [...classTypes].some(
    (ct) => ct.startsWith("IPAdapter") || ct === "StyleApplyIPAdapter",
  );

  const hasUpscaler =
    classTypes.has("ImageUpscaleWithModel") ||
    classTypes.has("UpscaleModelLoader") ||
    classTypes.has("LoadUpscaleModel") ||
    classTypes.has("UpscaleNode");

  const hasVideo = [...classTypes].some((ct) =>
    WORKFLOW_VIDEO_OUTPUT_CLASSES.has(ct),
  );

  const hasVideoMotion = [...classTypes].some((ct) =>
    VIDEO_MOTION_CLASSES.has(ct),
  );

  const hasLoRA =
    classTypes.has("LoraLoader") || classTypes.has("LoraLoaderModelOnly");

  return {
    controlnet: hasControlNet,
    ipadapter: hasIPAdapter,
    upscale: hasUpscaler,
    video: hasVideo,
    videoMotion: hasVideoMotion,
    lora: hasLoRA,
  };
}

/**
 * Enrich discovered WorkflowSlots with ControlNet, IPAdapter, upscale,
 * video, and capability metadata.
 */
export function enrichSlotsWithCapabilities(
  slots: WorkflowSlots,
  workflow: Workflow,
): WorkflowSlots {
  return {
    ...slots,
    controlnetSlots: discoverControlNetSlots(workflow),
    ipadapterSlots: discoverIPAdapterSlots(workflow),
    upscaleSlots: discoverUpscaleSlots(workflow),
    videoSlots: discoverVideoCapabilitySlots(workflow),
    capabilities: discoverCapabilities(workflow),
  };
}

export function validateWorkflow(workflow: Workflow): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!workflow || typeof workflow !== "object") {
    errors.push("Workflow is empty or invalid");
    return { valid: false, errors, warnings };
  }

  const nodeCount = Object.keys(workflow).length;
  if (nodeCount === 0) {
    errors.push("Workflow has no nodes");
    return { valid: false, errors, warnings };
  }

  const hasSampler = findFirstNodeId(workflow, (n) =>
    KSAMPLER_CLASSES.has(n.class_type),
  );
  if (!hasSampler) {
    errors.push("No KSampler or similar sampling node found");
  }

  const hasTextEncoder = findFirstNodeId(workflow, (n) =>
    CLIP_TEXT_CLASSES.has(n.class_type),
  );
  if (!hasTextEncoder) {
    warnings.push(
      "No CLIPTextEncode node found - prompt injection may not work",
    );
  }

  const hasLatentSource = findFirstNodeId(
    workflow,
    (n) =>
      LATENT_CLASSES.has(n.class_type) || VAE_ENCODE_CLASSES.has(n.class_type),
  );
  if (!hasLatentSource) {
    warnings.push(
      "No EmptyLatentImage or VAEEncode found - dimensions may not be adjustable",
    );
  }

  const hasOutput = findFirstNodeId(
    workflow,
    (n) =>
      n.class_type === "SaveImage" ||
      n.class_type === "PreviewImage" ||
      n.class_type === "SaveVideo" ||
      n.class_type === "SaveWEBM" ||
      n.class_type === "CreateVideo" ||
      n.class_type.includes("Output"),
  );
  if (!hasOutput) {
    warnings.push(
      "No SaveImage or PreviewImage node found - results may not be visible",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
