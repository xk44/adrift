/**
 * SREF Workflow Injector
 * Injects style reference (SREF) and LoRA nodes into ComfyUI workflows.
 *
 * Workflow modification strategy:
 * 1. Parse SREF params from prompt or store
 * 2. Add required nodes (style encoding, mixing, application)
 * 3. Rewire node connections to integrate style conditioning
 * 4. Handle LoRA auto-triggers by modifying prompt text
 *
 * Acronyms:
 * - SREF = Style Reference
 * - SW = Style Weight (0-1000)
 * - SC = Style Code (numeric identifier)
 * - SVEC = Style Vector (embedding)
 * - SADP = Style Adapter (application mechanism)
 */

import { v4 as uuidv4 } from "uuid";
import type { Workflow, WorkflowSlots, WorkflowNode } from "@/types";
import type { SREFParams, SREFItem, LoRAParams, LoRAItem } from "./srefParser";
import { getSREFValue } from "./srefParser";
import {
  resolveAdapter,
  isLoraModelOnly,
  resolveSrefApplyClass,
  type InjectableType,
} from "@/lib/oj/adapters";

// Types

interface SREFInjectionResult {
  workflow: Workflow;
  modifiedPrompt: string;
  addedNodes: string[];
  errors: string[];
}

interface NodeConnection {
  sourceNodeId: string;
  sourceOutput: number;
  targetNodeId: string;
  targetInput: string;
}

// Node ID Generation

let nodeIdCounter = 1000;

function generateNodeId(): string {
  return String(nodeIdCounter++);
}

function seedNodeIdCounter(workflow: Workflow): void {
  const maxId = Math.max(
    0,
    ...Object.keys(workflow).map((id) => {
      const parsed = Number.parseInt(id, 10);
      return Number.isFinite(parsed) && String(parsed) === id ? parsed : 0;
    }),
  );
  nodeIdCounter = Math.max(nodeIdCounter, maxId + 1);
}

// Node Templates

/**
 * Create a style encode node (our custom node)
 */
function createStyleEncodeNode(
  imageSource: string,
  encoderType: string = "CLIP-ViT-L",
  contentSuppression: number = 0.5,
): { nodeId: string; node: WorkflowNode } {
  const nodeId = generateNodeId();
  return {
    nodeId,
    node: {
      class_type: "SREFStyleEncode",
      inputs: {
        image_url: imageSource,
        encoder_type: encoderType,
        content_suppression: contentSuppression,
        use_cache: true,
      },
    },
  };
}

function createStyleCodeLookupNode(styleCode: string): {
  nodeId: string;
  node: WorkflowNode;
} {
  const nodeId = generateNodeId();
  return {
    nodeId,
    node: {
      class_type: "StyleCodeLookup",
      inputs: {
        style_code: styleCode,
        fallback_to_random: true,
      },
    },
  };
}

/**
 * Create a style mixer node for combining multiple style vectors
 */
function createStyleMixerNode(
  styleVectorInputs: Array<{
    nodeId: string;
    outputIndex: number;
    weight: number;
  }>,
  normalizationMode: string = "sum_to_1",
): { nodeId: string; node: WorkflowNode } {
  const nodeId = generateNodeId();

  // Build inputs dynamically based on number of vectors
  const inputs: Record<string, unknown> = {
    normalization: normalizationMode,
  };

  styleVectorInputs.forEach((input, index) => {
    inputs[`style_vector_${index + 1}`] = [input.nodeId, input.outputIndex];
    inputs[`weight_${index + 1}`] = input.weight;
  });

  return {
    nodeId,
    node: {
      class_type: "SREFMixerMulti",
      inputs,
    },
  };
}

/**
 * Create a style application node (IP-Adapter style)
 * @param styleVectorNodeId - Source style vector node
 * @param modelNodeId - Source model node
 * @param strength - Application strength
 * @param applyClass - The class_type to use (default: StyleApplyIPAdapter)
 */
function createStyleApplyIPAdapterNode(
  styleVectorNodeId: string,
  modelNodeId: string,
  strength: number = 1.0,
  applyClass: string = "StyleApplyIPAdapter",
): { nodeId: string; node: WorkflowNode } {
  const nodeId = generateNodeId();
  return {
    nodeId,
    node: {
      class_type: applyClass,
      inputs: {
        style_vector: [styleVectorNodeId, 0],
        model: [modelNodeId, 0],
        strength: strength,
        weight_type: "linear",
        start_at: 0.0,
        end_at: 1.0,
      },
    },
  };
}

/**
 * Create a style application node (conditioning style)
 */
function createStyleApplyConditioningNode(
  styleVectorNodeId: string,
  conditioningNodeId: string,
  strength: number = 1.0,
): { nodeId: string; node: WorkflowNode } {
  const nodeId = generateNodeId();
  return {
    nodeId,
    node: {
      class_type: "StyleApplyConditioning",
      inputs: {
        style_vector: [styleVectorNodeId, 0],
        conditioning: [conditioningNodeId, 0],
        strength: strength,
        blend_mode: "add",
      },
    },
  };
}

/**
 * Create a LoRA loader node — model-aware.
 *
 * For SDXL-style workflows (modelFamily defaults to "sdxl"), creates LoraLoader
 * with model + clip inputs (standard dual-output LoRA).
 *
 * For Flux-style workflows (modelFamily = "flux"), creates LoraLoaderModelOnly
 * with model input only (no CLIP path).
 */
function createLoRALoaderNode(
  loraName: string,
  modelNodeId: string,
  clipNodeId: string | null,
  strengthModel: number = 1.0,
  strengthClip: number = 1.0,
  modelFamily: string = "sdxl",
): { nodeId: string; node: WorkflowNode } {
  const nodeId = generateNodeId();
  const adapter = resolveAdapter("lora", modelFamily);
  const loaderClass = adapter.loaderClass;
  const modelOnly = isLoraModelOnly(loaderClass);

  if (!modelOnly) {
    // SDXL / SD 1.5 style: LoraLoader with model + clip
    return {
      nodeId,
      node: {
        class_type: loaderClass,
        inputs: {
          lora_name: loraName,
          strength_model: strengthModel,
          strength_clip: strengthClip,
          model: [modelNodeId, 0],
          clip: [clipNodeId ?? modelNodeId, 1],
        },
      },
    };
  } else {
    // Flux style: LoraLoaderModelOnly — no clip, single model output
    return {
      nodeId,
      node: {
        class_type: loaderClass,
        inputs: {
          lora_name: loraName,
          strength_model: strengthModel,
          model: [modelNodeId, 0],
        },
      },
    };
  }
}

/**
 * Create a LoRA shortcode lookup node (our custom node)
 */
function createLoRAShortcodeLookupNode(shortcode: string): {
  nodeId: string;
  node: WorkflowNode;
} {
  const nodeId = generateNodeId();
  return {
    nodeId,
    node: {
      class_type: "LoRAShortcodeLookup",
      inputs: {
        shortcode: shortcode,
      },
    },
  };
}

// Workflow Analysis

function findModelLoaderNode(workflow: Workflow): string | null {
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (
      node.class_type === "CheckpointLoaderSimple" ||
      node.class_type === "CheckpointLoader" ||
      node.class_type === "UNETLoader"
    ) {
      return nodeId;
    }
  }
  return null;
}

/**
 * Find a separate CLIPLoader node (split-loader workflows like zimageturbo)
 */
function findClipLoaderNode(workflow: Workflow): string | null {
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type === "CLIPLoader") {
      return nodeId;
    }
  }
  return null;
}

function findPositiveClipNode(workflow: Workflow): string | null {
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type === "CLIPTextEncode") {
      // Check if it's connected to sampler's positive input
      // or has "positive" in metadata
      if (node._meta?.title?.toLowerCase().includes("positive")) {
        return nodeId;
      }
    }
  }

  // Fallback: find first CLIPTextEncode
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type === "CLIPTextEncode") {
      return nodeId;
    }
  }

  return null;
}

function findKSamplerNode(workflow: Workflow): string | null {
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (
      node.class_type === "KSampler" ||
      node.class_type === "KSamplerAdvanced" ||
      node.class_type === "SamplerCustom"
    ) {
      return nodeId;
    }
  }
  return null;
}

function findInputSource(
  workflow: Workflow,
  targetNodeId: string,
  inputName: string,
): { nodeId: string; outputIndex: number } | null {
  const targetNode = workflow[targetNodeId];
  if (!targetNode?.inputs?.[inputName]) return null;

  const input = targetNode.inputs[inputName];
  if (Array.isArray(input) && input.length === 2) {
    return { nodeId: String(input[0]), outputIndex: input[1] as number };
  }

  return null;
}

function rewireInput(
  workflow: Workflow,
  targetNodeId: string,
  inputName: string,
  newSourceNodeId: string,
  newSourceOutput: number = 0,
): void {
  const targetNode = workflow[targetNodeId];
  if (targetNode) {
    targetNode.inputs[inputName] = [newSourceNodeId, newSourceOutput];
  }
}

// Style Weight Conversion

/**
 * Convert weight (0-1000) to internal strength (0-5)
 */
export function convertStyleWeight(sw: number): number {
  // 0 = off, 100 = default, 1000 = max
  // Internal: 0 = off, 1.0 = default, 5.0 = max
  if (sw === 0) return 0;
  if (sw <= 100) {
    // 0-100 maps to 0-1.0
    return sw / 100;
  } else {
    // 100-1000 maps to 1.0-5.0 (exponential curve)
    const normalized = (sw - 100) / 900; // 0 to 1
    return 1.0 + normalized * 4.0;
  }
}

// Main Injection Functions

/**
 * @param modelFamily - Model family for adapter resolution (default: "sdxl")
 */
export function injectSREFNodes(
  workflow: Workflow,
  sref: SREFParams,
  slots?: WorkflowSlots,
  modelFamily: string = "sdxl",
): SREFInjectionResult {
  const result: SREFInjectionResult = {
    workflow: structuredClone(workflow),
    modifiedPrompt: "",
    addedNodes: [],
    errors: [],
  };

  seedNodeIdCounter(result.workflow);

  if (!sref.items || sref.items.length === 0) {
    return result;
  }

  // Find required existing nodes
  const modelLoaderId = findModelLoaderNode(result.workflow);
  const positiveClipId = findPositiveClipNode(result.workflow);
  const ksamplerNodeId = findKSamplerNode(result.workflow);

  if (!modelLoaderId) {
    result.errors.push("Could not find model loader node in workflow");
    return result;
  }

  if (!ksamplerNodeId) {
    result.errors.push("Could not find KSampler node in workflow");
    return result;
  }

  // Create style encoding nodes for each SREF item
  const styleVectorNodes: Array<{ nodeId: string; weight: number }> = [];

  for (const item of sref.items) {
    const value = getSREFValue(item);

    if (item.type === "url") {
      // Encode from image URL
      const { nodeId, node } = createStyleEncodeNode(value);
      result.workflow[nodeId] = node;
      result.addedNodes.push(nodeId);
      styleVectorNodes.push({ nodeId, weight: item.weight });
    } else {
      // Lookup from style code
      const { nodeId, node } = createStyleCodeLookupNode(value);
      result.workflow[nodeId] = node;
      result.addedNodes.push(nodeId);
      styleVectorNodes.push({ nodeId, weight: item.weight });
    }
  }

  // Mix style vectors if multiple
  let finalStyleVectorNodeId: string;

  if (styleVectorNodes.length === 1) {
    finalStyleVectorNodeId = styleVectorNodes[0].nodeId;
  } else {
    // Create mixer node
    const mixerInputs = styleVectorNodes.map((sv) => ({
      nodeId: sv.nodeId,
      outputIndex: 0,
      weight: sv.weight,
    }));

    const { nodeId: mixerNodeId, node: mixerNode } =
      createStyleMixerNode(mixerInputs);
    result.workflow[mixerNodeId] = mixerNode;
    result.addedNodes.push(mixerNodeId);
    finalStyleVectorNodeId = mixerNodeId;
  }

  const strength = convertStyleWeight(sref.styleWeight);

  const srefApplyClass = resolveSrefApplyClass(modelFamily);

  // Apply style via IP-Adapter mechanism
  // Find what's currently connected to KSampler's model input
  const modelSource = findInputSource(result.workflow, ksamplerNodeId, "model");

  if (modelSource) {
    // Insert style application between model source and KSampler
    const { nodeId: applyNodeId, node: applyNode } =
      createStyleApplyIPAdapterNode(
        finalStyleVectorNodeId,
        modelSource.nodeId,
        strength,
        srefApplyClass,
      );
    result.workflow[applyNodeId] = applyNode;
    result.addedNodes.push(applyNodeId);

    rewireInput(result.workflow, ksamplerNodeId, "model", applyNodeId, 0);
  }

  // Also apply to conditioning if available
  if (positiveClipId) {
    const condSource = findInputSource(
      result.workflow,
      ksamplerNodeId,
      "positive",
    );

    if (condSource) {
      const { nodeId: condApplyNodeId, node: condApplyNode } =
        createStyleApplyConditioningNode(
          finalStyleVectorNodeId,
          condSource.nodeId,
          strength * 0.5, // Reduced strength for conditioning
        );
      result.workflow[condApplyNodeId] = condApplyNode;
      result.addedNodes.push(condApplyNodeId);

      rewireInput(
        result.workflow,
        ksamplerNodeId,
        "positive",
        condApplyNodeId,
        0,
      );
    }
  }

  return result;
}

/**
 * Inject LoRA nodes into a workflow
 * @param modelFamily - Model family for adapter resolution (default: "sdxl")
 */
export function injectLoRANodes(
  workflow: Workflow,
  lora: LoRAParams,
  modelFamily: string = "sdxl",
): SREFInjectionResult {
  const result: SREFInjectionResult = {
    workflow: structuredClone(workflow),
    modifiedPrompt: "",
    addedNodes: [],
    errors: [],
  };

  seedNodeIdCounter(result.workflow);

  if (!lora.items || lora.items.length === 0) {
    return result;
  }

  const modelLoaderId = findModelLoaderNode(result.workflow);
  if (!modelLoaderId) {
    result.errors.push("Could not find model loader node in workflow");
    return result;
  }

  // For split-loader workflows (UNETLoader + CLIPLoader), find the separate CLIP node
  const clipLoaderId = findClipLoaderNode(result.workflow);
  const adapter = resolveAdapter("lora", modelFamily);
  const modelOnly = isLoraModelOnly(adapter.loaderClass);

  // Chain LoRA loaders — model from UNETLoader/Checkpoint, clip from CLIPLoader or Checkpoint output 1
  let currentModelSource = { nodeId: modelLoaderId, outputIndex: 0 };
  let currentClipSource = clipLoaderId
    ? { nodeId: clipLoaderId, outputIndex: 0 }
    : { nodeId: modelLoaderId, outputIndex: 1 };

  for (const item of lora.items) {
    // Create LoRA loader — model-aware (LoraLoader vs LoraLoaderModelOnly)
    const { nodeId, node } = createLoRALoaderNode(
      item.name,
      currentModelSource.nodeId,
      modelOnly ? null : currentClipSource.nodeId,
      item.strength,
      item.clipStrength ?? item.strength,
      modelFamily,
    );

    result.workflow[nodeId] = node;
    result.addedNodes.push(nodeId);

    currentModelSource = { nodeId, outputIndex: 0 };
    if (!modelOnly) {
      // SDXL/SD1.5: LoRA has both model and clip outputs
      currentClipSource = { nodeId, outputIndex: 1 };
    }

    // Collect trigger words for prompt modification
    if (lora.autoTrigger && item.triggers && item.triggers.length > 0) {
      const triggers = item.triggers.join(", ");

      if (lora.triggerPosition === "beginning") {
        result.modifiedPrompt =
          triggers +
          (result.modifiedPrompt ? ", " + result.modifiedPrompt : "");
      } else if (lora.triggerPosition === "end") {
        result.modifiedPrompt =
          (result.modifiedPrompt ? result.modifiedPrompt + ", " : "") +
          triggers;
      } else {
        // Middle - will be handled by caller
        result.modifiedPrompt += (result.modifiedPrompt ? "|" : "") + triggers;
      }
    }
  }

  // Rewire all nodes that consumed the model loader's model output (output 0)
  // This covers both direct KSampler connections and intermediate nodes like ModelSamplingAuraFlow
  for (const [nodeId, node] of Object.entries(result.workflow)) {
    // Skip the LoRA nodes we just added
    if (result.addedNodes.includes(nodeId)) continue;
    for (const [inputName, inputVal] of Object.entries(node.inputs ?? {})) {
      if (
        Array.isArray(inputVal) &&
        inputVal.length === 2 &&
        String(inputVal[0]) === modelLoaderId &&
        inputVal[1] === 0
      ) {
        rewireInput(
          result.workflow,
          nodeId,
          inputName,
          currentModelSource.nodeId,
          0,
        );
      }
    }
  }

  // Rewire CLIP text encoders and other nodes that consumed the clip source
  // Only if this model family has CLIP output (not model-only like Flux)
  if (!modelOnly) {
    const clipSourceId = clipLoaderId ?? modelLoaderId;
    const clipSourceOutput = clipLoaderId ? 0 : 1;
    for (const [nodeId, node] of Object.entries(result.workflow)) {
      if (result.addedNodes.includes(nodeId)) continue;
      for (const [inputName, inputVal] of Object.entries(node.inputs ?? {})) {
        if (
          Array.isArray(inputVal) &&
          inputVal.length === 2 &&
          String(inputVal[0]) === clipSourceId &&
          inputVal[1] === clipSourceOutput
        ) {
          rewireInput(
            result.workflow,
            nodeId,
            inputName,
            currentClipSource.nodeId,
            currentClipSource.outputIndex,
          );
        }
      }
    }
  }

  return result;
}

/**
 * Insert trigger words into a prompt at the specified position
 */
export function insertTriggers(
  prompt: string,
  triggers: string,
  position: "beginning" | "middle" | "end",
): string {
  if (!triggers) return prompt;

  switch (position) {
    case "beginning":
      return `${triggers}, ${prompt}`;
    case "end":
      return `${prompt}, ${triggers}`;
    case "middle": {
      // Insert after first sentence or comma
      const firstBreak = prompt.search(/[,.]/) + 1;
      if (firstBreak > 0) {
        return `${prompt.slice(0, firstBreak)} ${triggers},${prompt.slice(firstBreak)}`;
      }
      // No break found, insert in middle
      const mid = Math.floor(prompt.length / 2);
      const spaceNearMid = prompt.lastIndexOf(" ", mid);
      if (spaceNearMid > 0) {
        return `${prompt.slice(0, spaceNearMid)} ${triggers},${prompt.slice(spaceNearMid)}`;
      }
      return `${prompt}, ${triggers}`;
    }
    default:
      return prompt;
  }
}

/**
 * Full injection: SREF + LoRA combined
 * @param modelFamily - Model family for adapter resolution (default: "sdxl")
 */
export function injectStyleParams(
  workflow: Workflow,
  sref: SREFParams | null,
  lora: LoRAParams | null,
  prompt: string,
  slots?: WorkflowSlots,
  modelFamily: string = "sdxl",
): SREFInjectionResult {
  let result: SREFInjectionResult = {
    workflow: structuredClone(workflow),
    modifiedPrompt: prompt,
    addedNodes: [],
    errors: [],
  };

  // Inject SREF first
  if (sref && sref.items.length > 0) {
    const srefResult = injectSREFNodes(
      result.workflow,
      sref,
      slots,
      modelFamily,
    );
    result.workflow = srefResult.workflow;
    result.addedNodes.push(...srefResult.addedNodes);
    result.errors.push(...srefResult.errors);
  }

  // Then inject LoRA
  if (lora && lora.items.length > 0) {
    const loraResult = injectLoRANodes(result.workflow, lora, modelFamily);
    result.workflow = loraResult.workflow;
    result.addedNodes.push(...loraResult.addedNodes);
    result.errors.push(...loraResult.errors);

    if (lora.autoTrigger && loraResult.modifiedPrompt) {
      const triggers = loraResult.modifiedPrompt.split("|").join(", ");
      result.modifiedPrompt = insertTriggers(
        prompt,
        triggers,
        lora.triggerPosition,
      );
    }
  }

  return result;
}

/**
 * Serialize SREF metadata for workflow reproducibility
 */
export function serializeSREFMetadata(sref: SREFParams): {
  sref_items: Array<{ value: string; type: string; weight: number }>;
  sref_style_weight: number;
  sref_version: number | undefined;
} {
  return {
    sref_items: sref.items.map((item) => ({
      value: getSREFValue(item),
      type: item.type,
      weight: item.weight,
    })),
    sref_style_weight: sref.styleWeight,
    sref_version: sref.styleVersion,
  };
}

/**
 * Serialize LoRA metadata for workflow reproducibility
 */
export function serializeLoRAMetadata(lora: LoRAParams): {
  lora_items: Array<{
    name: string;
    strength: number;
    clip_strength: number | undefined;
    triggers: string[] | undefined;
  }>;
  lora_auto_trigger: boolean;
  lora_trigger_position: string;
} {
  return {
    lora_items: lora.items.map((item) => ({
      name: item.name,
      strength: item.strength,
      clip_strength: item.clipStrength,
      triggers: item.triggers,
    })),
    lora_auto_trigger: lora.autoTrigger,
    lora_trigger_position: lora.triggerPosition,
  };
}

export default {
  injectSREFNodes,
  injectLoRANodes,
  injectStyleParams,
  insertTriggers,
  convertStyleWeight,
  serializeSREFMetadata,
  serializeLoRAMetadata,
};
