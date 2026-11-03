/**
 * Extra LTX LoRA: an optional community LoRA chained after the model of the
 * LTX-2.5 image-in tools (Animate / Transition LTX-2.5, Cinemagraph, Slow
 * Motion), so community LoRAs can be tried without code changes.
 *
 * - Picker: installed LoRA files whose name contains "ltx", minus the files
 *   the tool already loads and the built-in IC-LoRAs (they need a reference
 *   video, which these tools do not feed).
 * - Graph: one core LoraLoaderModelOnly after the end of the model chain
 *   (UNETLoader -> LoraLoaderModelOnly...), every consumer rewired to it.
 *   No pick, strength 0 or a file the graph already loads: no-op.
 * - Registry: known files get a label and, when the LoRA has one, a trigger
 *   word put in front of the positive prompt.
 *
 * Client-safe: no Node or engine imports.
 */
import type { Workflow } from "@/types";
import {
  extractInputList,
  type ObjectInfoResponse,
} from "./localInventory";

export interface LtxCommunityLora {
  /** Path as ComfyUI lists it under models/loras ("ltx25/foo.safetensors"). */
  file: string;
  /** Picker label. */
  label: string;
  /** "lora" = style/motion LoRA; "ic-lora" = needs a reference video. */
  kind: "lora" | "ic-lora";
  /** Trigger word(s) the LoRA was trained with; prepended to the prompt. */
  trigger?: string;
  /** Strength the picker starts at (0..2). */
  defaultStrength: number;
  /** License name as on the model card. */
  license: string;
  /** Model card. */
  url: string;
}

/**
 * Known community LTX LoRAs. The IC-LoRAs are listed for labels and
 * licenses only (the picker skips them); each has its own LTX VFX tool
 * (src/lib/oj/ltxVfx.ts). XPLDV is a plain LoRA, so it is also offered as
 * an Extra LTX LoRA on the image-in cards.
 */
export const LTX_COMMUNITY_LORAS: LtxCommunityLora[] = [
  {
    file: "ltx25/ltx-2.5-xpldv_v5-lora.safetensors",
    label: "Exploded View (XPLDV v5)",
    kind: "lora",
    defaultStrength: 0.5,
    license: "LTX-2.x Community License",
    url: "https://huggingface.co/DigitalByte/LTX-2.5-Exploded-View-XPLDV",
  },
  {
    file: "ltx25/LTX25_Ripple_v11.safetensors",
    label: "Ripple (first-frame edit, IC-LoRA)",
    kind: "ic-lora",
    defaultStrength: 1.35,
    license: "LTX-2.x Community License",
    url: "https://huggingface.co/WepeNerd/LTX-Ripple",
  },
  {
    file: "ltx25/ainvfx-fluid.safetensors",
    label: "Fluid: smoke, steam, fire (IC-LoRA)",
    kind: "ic-lora",
    trigger: "ainvfxfluid",
    defaultStrength: 1,
    license: "LTX-2.x Community License",
    url: "https://huggingface.co/AInVFX/ainvfx-fluid",
  },
  {
    file: "ltx25/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
    label: "Union Control: canny / depth / pose (IC-LoRA, LTX-2.3)",
    kind: "ic-lora",
    defaultStrength: 1,
    license: "LTX-2 Community License",
    url: "https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control",
  },
];

/** ToolSettings.picks keys (also the /api/jobs/action param names). */
export const LTX_EXTRA_LORA_PICK = {
  lora: "ltxLora",
  strength: "ltxLoraStrength",
} as const;

export const LTX_EXTRA_LORA_STRENGTH = {
  min: 0,
  max: 2,
  step: 0.05,
  default: 1,
} as const;

/** Tool / action ids that offer the Extra LTX LoRA control. */
export const LTX_EXTRA_LORA_TOOLS: ReadonlySet<string> = new Set([
  "ltx25_animate",
  "ltx25_transition",
  "ltx_cinemagraph",
  "ltx_slow_motion",
]);

/** LoRA files each tool's pack graph already loads. */
export const LTX_TOOL_LORA_FILES: Record<string, string[]> = {
  ltx25_animate: [],
  ltx25_transition: [],
  ltx_cinemagraph: ["ltx25/ltx-2.5-22b-lora-cinemagraph-0.9.safetensors"],
  ltx_slow_motion: [
    "ltx25/ltx-2.5-22b-lora-slow-motion-control-1.0.safetensors",
  ],
};

/** Built-in IC-LoRAs (packs/ltx25 vfx_* incl. Restore, and video_expand). */
export const LTX_BUILTIN_IC_LORA_FILES: string[] = [
  "ltx25/ltx-2.3-22b-ic-lora-outpaint.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-sdr-to-hdr-1.0.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-water-simulation-0.9.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-restore-1.0.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-deblur-0.9.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-decompression-0.9.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-colorization-0.9.safetensors",
  "ltx25/ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors",
  "ltx25/ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
  "ltx25/LTX25_Ripple_v11.safetensors",
  "ltx25/ainvfx-fluid.safetensors",
  "ltx25/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
];

const norm = (f: string) => f.replace(/\\/g, "/").toLowerCase();

/** Registry entry for a file (case / slash insensitive). */
export function ltxCommunityLora(
  file: string,
  registry: LtxCommunityLora[] = LTX_COMMUNITY_LORAS,
): LtxCommunityLora | undefined {
  const n = norm(file);
  return registry.find((e) => norm(e.file) === n);
}

/** A LoRA file name the graph patch accepts: LTX-named, relative, no "..". */
export function isLtxLoraFile(file: unknown): file is string {
  if (typeof file !== "string" || !file || file.length > 300) return false;
  const n = norm(file);
  return (
    n.includes("ltx") &&
    !n.startsWith("/") &&
    !/^[a-z]:/.test(n) &&
    !n.split("/").includes("..") &&
    /\.(safetensors|sft|ckpt|pt)$/.test(n)
  );
}

/**
 * Picker options for `toolId` from the installed LoRA list: LTX-named
 * files, minus the tool's own LoRAs and IC-LoRAs; sorted, deduplicated.
 */
export function ltxLoraChoices(
  installed: string[],
  toolId: string,
  registry: LtxCommunityLora[] = LTX_COMMUNITY_LORAS,
): string[] {
  const exclude = new Set(
    [...(LTX_TOOL_LORA_FILES[toolId] ?? []), ...LTX_BUILTIN_IC_LORA_FILES].map(
      norm,
    ),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of installed) {
    if (!isLtxLoraFile(raw)) continue;
    const file = raw.replace(/\\/g, "/");
    const n = norm(file);
    if (exclude.has(n) || seen.has(n)) continue;
    if (/ic[-_]?lora/.test(n)) continue;
    if (ltxCommunityLora(file, registry)?.kind === "ic-lora") continue;
    seen.add(n);
    out.push(file);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Picker label: the registry label, else the file name without folder/ext. */
export function ltxLoraLabel(
  file: string,
  registry: LtxCommunityLora[] = LTX_COMMUNITY_LORAS,
): string {
  const known = ltxCommunityLora(file, registry);
  if (known) return known.label;
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return base.replace(/\.(safetensors|sft|ckpt|pt)$/i, "");
}

/** Strength clamped to 0..2; missing/invalid -> registry default or 1. */
export function ltxLoraStrength(
  value: unknown,
  file?: string,
  registry: LtxCommunityLora[] = LTX_COMMUNITY_LORAS,
): number {
  const v = typeof value === "string" && value !== "" ? Number(value) : value;
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(
      LTX_EXTRA_LORA_STRENGTH.max,
      Math.max(LTX_EXTRA_LORA_STRENGTH.min, v),
    );
  }
  const def = file
    ? ltxCommunityLora(file, registry)?.defaultStrength
    : undefined;
  return typeof def === "number" ? def : LTX_EXTRA_LORA_STRENGTH.default;
}

/** /api/jobs/action params from the card's picks ({} when none picked). */
export function ltxExtraLoraParams(
  picks: Record<string, string | undefined>,
): Record<string, unknown> {
  const file = picks[LTX_EXTRA_LORA_PICK.lora];
  if (!isLtxLoraFile(file)) return {};
  return {
    [LTX_EXTRA_LORA_PICK.lora]: file,
    [LTX_EXTRA_LORA_PICK.strength]: ltxLoraStrength(
      picks[LTX_EXTRA_LORA_PICK.strength],
      file,
    ),
  };
}

/** LTX-named LoRA files in an object_info payload (both loader nodes). */
export function ltxLorasFromObjectInfo(info: unknown): string[] {
  if (!info || typeof info !== "object") return [];
  const data = info as ObjectInfoResponse;
  const all = [
    ...extractInputList(data, "LoraLoaderModelOnly", "lora_name"),
    ...extractInputList(data, "LoraLoader", "lora_name"),
  ];
  return Array.from(
    new Set(all.filter(isLtxLoraFile).map((f) => f.replace(/\\/g, "/"))),
  ).sort((a, b) => a.localeCompare(b));
}

/** Saved picks to clear once the installed list is known (gone files). */
export function staleLtxLoraPick(
  picks: Record<string, string | undefined>,
  choices: string[] | null,
): boolean {
  const file = picks[LTX_EXTRA_LORA_PICK.lora];
  if (!file || choices === null) return false;
  return !choices.some((c) => norm(c) === norm(file));
}

const MODEL_SOURCES = new Set(["UNETLoader", "CheckpointLoaderSimple"]);
const LORA_LOADERS = new Set(["LoraLoaderModelOnly", "LoraLoader"]);

function isLink(v: unknown, id: string, slot: number): boolean {
  return Array.isArray(v) && String(v[0]) === id && v[1] === slot;
}

/** Last node of the MODEL chain: model source, then any LoRA loaders. */
export function ltxModelChainEnd(workflow: Workflow): string | null {
  let end = Object.keys(workflow).find((id) =>
    MODEL_SOURCES.has(workflow[id]?.class_type),
  );
  if (!end) return null;
  for (let guard = 0; guard < 64; guard++) {
    const cur: string = end;
    const next = Object.keys(workflow).find(
      (id) =>
        LORA_LOADERS.has(workflow[id]?.class_type) &&
        isLink(workflow[id].inputs?.model, cur, 0),
    );
    if (!next) break;
    end = next;
  }
  return end;
}

function nextNodeId(workflow: Workflow): string {
  let max = 0;
  for (const id of Object.keys(workflow)) {
    const n = Number(id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return String(max + 1);
}

/**
 * Chain the extra LoRA from `params` (ltxLora / ltxLoraStrength) after the
 * model chain and prepend its registry trigger to `posTextId`'s text.
 * Mutates `workflow`; returns the new node id, or null when nothing was
 * added (no / invalid pick, strength 0, file already in the graph, no
 * model chain).
 */
export function applyLtxExtraLora(
  workflow: Workflow,
  params: Record<string, unknown>,
  posTextId?: string,
  registry: LtxCommunityLora[] = LTX_COMMUNITY_LORAS,
): string | null {
  const file = params[LTX_EXTRA_LORA_PICK.lora];
  if (!isLtxLoraFile(file)) return null;
  const strength = ltxLoraStrength(
    params[LTX_EXTRA_LORA_PICK.strength],
    file,
    registry,
  );
  if (strength === 0) return null;
  const n = norm(file);
  const loaded = Object.values(workflow).some(
    (node) =>
      LORA_LOADERS.has(node?.class_type) &&
      typeof node.inputs?.lora_name === "string" &&
      norm(node.inputs.lora_name as string) === n,
  );
  if (loaded) return null;
  const end = ltxModelChainEnd(workflow);
  if (!end) return null;

  const id = nextNodeId(workflow);
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;
    for (const [k, v] of Object.entries(inputs)) {
      if (isLink(v, end, 0)) inputs[k] = [id, 0];
    }
  }
  workflow[id] = {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      model: [end, 0],
      lora_name: file.replace(/\\/g, "/"),
      strength_model: strength,
    },
    _meta: { title: "Extra LTX LoRA" },
  } as Workflow[string];

  const trigger = ltxCommunityLora(file, registry)?.trigger?.trim();
  const pos = posTextId ? workflow[posTextId] : undefined;
  if (trigger && pos && typeof pos.inputs?.text === "string") {
    const text = pos.inputs.text as string;
    if (!text.toLowerCase().includes(trigger.toLowerCase())) {
      pos.inputs.text = text ? `${trigger}, ${text}` : trigger;
    }
  }
  return id;
}
