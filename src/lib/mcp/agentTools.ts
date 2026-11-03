/**
 * Agent (MCP) view of the Tools page: one descriptor per runnable tool with a
 * JSON Schema for its inputs, generated from the registries the UI uses
 * (ACTION_TOOLS in toolsPage.ts, editToolRegistry.json) plus the VRAM /
 * license badges of docs/TOOLS.md (toolsDoc.ts). Served by GET /api/tools/agent;
 * POST /api/tools/agent/compile turns agent inputs into the /api/jobs/action
 * body the web runner would send (buildActionRequest). See docs/MCP.md.
 *
 * Tool ids are the Tools page card keys: "action:<id>" and "catalog:<id>".
 */
import {
  ACTION_TOOLS,
  buildActionRequest,
  defaultPick,
  defaultSettings,
  getActionTool,
  type ActionPicker,
  type ActionToolSpec,
  type EditLoraListResponse,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import {
  getEditTool,
  getEditTools,
  getOutpaintPresets,
  toolLicense,
  type EditToolDef,
} from "@/lib/tools/editTools";
import type { ToolDocRow } from "@/lib/tools/toolsDoc";
import { REGION_MASK_TOOLS, withRegionMasks } from "@/lib/tools/maskWiring";
import { focusPoint, type FocusPoint } from "@/lib/oj/refocus";

export type JsonSchema = Record<string, unknown>;

export type AgentToolKind = "action" | "catalog";

/** What the run starts from: a photo, a clip, or nothing (text-only tools). */
export type AgentToolSource = "image" | "video" | "none";

export interface AgentTool {
  id: string;
  kind: AgentToolKind;
  name: string;
  category: string;
  summary: string;
  /** One-line inputs summary (same text as docs/TOOLS.md). */
  inputs: string;
  source: AgentToolSource;
  vram: string | null;
  /** yes | restricted | no | unverified (docs/TOOLS.md "Commercial"). */
  commercial: string | null;
  license?: { name: string; commercial: boolean | null; note: string };
  inputSchema: JsonSchema;
  available?: boolean | null;
  unavailableReason?: string | null;
}

const INPUT_FILE =
  'Local file path, http(s) URL, or an Adrift/ComfyUI ref ("name.png [input]", ' +
  "or an output ref from get_outputs).";

/** Joins sentence parts without doubled periods. */
function tidy(text: string): string {
  return text.replace(/([.!?])\./g, "$1");
}

function file(description: string): JsonSchema {
  return { type: "string", description: `${description}. ${INPUT_FILE}` };
}

/** Agent tools exclude hidden cards and Describe (not a queued job). */
export function agentActionSpecs(): ActionToolSpec[] {
  return ACTION_TOOLS.filter((s) => !s.hidden && s.special !== "describe");
}

function whenText(
  spec: ActionToolSpec,
  cond?: { key: string; value?: string; oneOf?: string[] },
): string {
  if (!cond) return "";
  const picker = spec.pickers?.find((p) => p.key === cond.key);
  const vals = cond.oneOf ?? (cond.value !== undefined ? [cond.value] : []);
  return ` Only used when options.${cond.key}${picker ? ` (${picker.title})` : ""} is ${vals.join(" or ")}.`;
}

function pickerSchema(spec: ActionToolSpec, p: ActionPicker): JsonSchema {
  const labels = p.options
    .map((o) => (o.label && o.label !== o.id ? `${o.id} = ${o.label}` : o.id))
    .join("; ");
  return {
    type: "string",
    enum: p.options.map((o) => o.id),
    default: defaultPick(p),
    description: `${p.title}. ${labels}.${whenText(spec, p.showWhen)}`,
  };
}

function focusSchema(description: string, timed: boolean): JsonSchema {
  const unit = { type: "number", minimum: 0, maximum: 1 };
  return {
    type: "object",
    properties: {
      x: unit,
      y: unit,
      ...(timed
        ? { t: { type: "number", minimum: 0, description: "Seconds into the clip." } }
        : {}),
    },
    required: ["x", "y"],
    additionalProperties: false,
    description,
  };
}

export function actionInputSchema(spec: ActionToolSpec): JsonSchema {
  const props: Record<string, JsonSchema> = {};
  const required: string[] = [];
  if (spec.videoInput) {
    props.video = file(`${spec.videoInput} (mp4/mov/m4v/webm, max 32 MB)`);
    required.push("video");
  } else if (!spec.noSourceInput) {
    props.image = file(spec.firstImage ?? "Photo");
    required.push("image");
  }
  if (spec.secondImage) {
    const optional =
      !!spec.secondImageOptional || /\(optional\)/i.test(spec.secondImage);
    props.second_image = file(spec.secondImage);
    if (!optional) required.push("second_image");
  }
  const region = REGION_MASK_TOOLS[spec.id];
  if (region && !spec.videoInput && !spec.noSourceInput) {
    props.masks = {
      type: "array",
      maxItems: region.subjects,
      items: { type: "string" },
      description: `Optional subject masks (white = area), each refined on its own pass. ${region.hint} ${INPUT_FILE}`,
    };
  }
  if (spec.extraImages?.length) {
    props.extra_images = {
      type: "array",
      maxItems: spec.extraImages.length,
      items: { type: "string" },
      description: `Optional further references, in order: ${spec.extraImages.join(", ")}. ${INPUT_FILE}`,
    };
  }
  if (spec.audioInput) {
    props.audio = file(
      `${spec.audioInput} (wav/mp3/m4a/flac)${spec.audioNote ? `. ${spec.audioNote}` : ""}`,
    );
    if (spec.audioWhen)
      (props.audio as { description: string }).description += whenText(
        spec,
        spec.audioWhen,
      ).replace(" Only used", " Required and only used");
    else required.push("audio");
  }
  if (spec.text) {
    props.text = {
      type: "string",
      maxLength: 2000,
      description: tidy(
        `${spec.text.label}${spec.text.hint ? `. ${spec.text.hint}` : ""}` +
          `${spec.text.placeholder ? `. Example: ${spec.text.placeholder}` : ""}.` +
          whenText(spec, spec.text.showWhen),
      ),
    };
    if (spec.text.required && !spec.text.showWhen) required.push("text");
  }
  if (spec.secondText) {
    props.second_text = {
      type: "string",
      maxLength: 4000,
      description: tidy(
        `${spec.secondText.label}${spec.secondText.hint ? `. ${spec.secondText.hint}` : ""}.` +
          whenText(spec, spec.secondText.showWhen),
      ),
    };
    if (spec.secondText.required && !spec.secondText.showWhen)
      required.push("second_text");
  }
  const options: Record<string, JsonSchema> = {};
  for (const p of spec.pickers ?? []) {
    if (p.options.length > 0) options[p.key] = pickerSchema(spec, p);
  }
  for (const s of spec.sliders ?? []) {
    const integer = [s.min, s.step].every(Number.isInteger);
    options[s.key] = {
      type: integer ? "integer" : "number",
      minimum: s.min,
      maximum: s.max,
      ...(integer && s.step > 1 && s.min % s.step === 0 ? { multipleOf: s.step } : {}),
      default: s.default,
      description: tidy(
        `${s.title}${s.unit ? ` (${s.unit})` : ""}${s.hint ? `. ${s.hint}` : ""}.` +
          whenText(spec, s.showWhen),
      ),
    };
  }
  if (spec.id === "refocus") {
    props.focus = focusSchema(
      "Where the photo should be sharp, normalized 0-1 from the top-left; default: centre.",
      false,
    );
  } else if (spec.id === "rack_focus") {
    props.focus_a = focusSchema(
      "Focus point A (sharp at time t seconds), normalized 0-1 from the top-left.",
      true,
    );
    props.focus_b = focusSchema(
      "Focus point B; the pull eases from A to B. Default t: A's t + 2 s.",
      true,
    );
    required.push("focus_a", "focus_b");
  }
  if (Object.keys(options).length) {
    props.options = {
      type: "object",
      properties: options,
      additionalProperties: false,
      description: "Tool settings; omitted keys use the default.",
    };
  }
  if (spec.usesEditLora) {
    props.edit_lora = {
      type: "string",
      description:
        "Edit LoRA id (GET /api/krea2-edit-loras); default: the server's preferred installed one.",
    };
    if (spec.picksEditFamily)
      props.edit_family = {
        type: "string",
        description:
          "Edit LoRA family id; default: the first installed family.",
      };
  }
  return {
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
  };
}

export function catalogInputSchema(tool: EditToolDef): JsonSchema {
  const props: Record<string, JsonSchema> = {};
  const required = ["images"];
  const labels = tool.refLabels.length ? tool.refLabels : ["Image"];
  props.images = {
    type: "array",
    minItems: tool.refCount,
    maxItems: tool.refCount,
    items: { type: "string" },
    description: `Exactly ${tool.refCount}, in order: ${labels.join(", ")}. ${INPUT_FILE}`,
  };
  if (tool.needsMask) {
    props.mask = file(
      `Mask image, white = area to change${tool.maskHint ? `. ${tool.maskHint}` : ""}`,
    );
    if (tool.prep !== "anypaint") required.push("mask");
  }
  if (tool.promptMode !== "none") {
    props.prompt = {
      type: "string",
      maxLength: 2000,
      description: tool.promptHint || "Prompt",
    };
    if (tool.promptMode === "required") required.push("prompt");
  }
  const options: Record<string, JsonSchema> = {};
  for (const o of tool.options) {
    options[o.id] = {
      type: "string",
      enum: o.values.map((v) => v.id),
      default: o.default,
      description: `${o.label}. ${o.values.map((v) => `${v.id} = ${v.label}`).join("; ")}.`,
    };
  }
  if (tool.speed.supported)
    options.fast = {
      type: "boolean",
      default: tool.speed.default,
      description: "Speed LoRA (fewer steps).",
    };
  if (tool.extras.keepFraming)
    options.keepFraming = {
      type: "boolean",
      default: tool.extras.keepFraming.default,
      description: "Consistency LoRA: keep the original framing.",
    };
  options.steps = {
    type: "integer",
    minimum: 1,
    maximum: 100,
    default: tool.defaults.steps,
  };
  options.cfg = {
    type: "number",
    minimum: 0,
    maximum: 20,
    default: tool.defaults.cfg,
  };
  options.seed = { type: "integer", minimum: 0, maximum: 2147483647 };
  if (tool.outpaint) {
    const presets = getOutpaintPresets();
    options.outpaint = {
      description: `Canvas growth: a preset id (default ${tool.outpaint.default}), { left, right, top, bottom } fractions (0..${tool.outpaint.maxSide}), or { aspect: "16:9", anchor }.`,
      anyOf: [
        { type: "string", enum: presets.map((p) => p.id) },
        {
          type: "object",
          properties: Object.fromEntries(
            ["left", "right", "top", "bottom"].map((k) => [
              k,
              { type: "number", minimum: 0, maximum: tool.outpaint!.maxSide },
            ]),
          ),
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            aspect: {
              type: "string",
              pattern: "^\\d+(\\.\\d+)?:\\d+(\\.\\d+)?$",
            },
            anchor: {
              type: "string",
              enum: ["center", "left", "right", "top", "bottom"],
            },
          },
          required: ["aspect"],
          additionalProperties: false,
        },
      ],
    };
  }
  props.options = {
    type: "object",
    properties: options,
    additionalProperties: false,
    description: "Tool settings; omitted keys use the default.",
  };
  return {
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
  };
}

function actionSource(spec: ActionToolSpec): AgentToolSource {
  return spec.videoInput ? "video" : spec.noSourceInput ? "none" : "image";
}

/** Every agent tool, badges from `rows` (buildToolDocRows) when given. */
export function buildAgentTools(rows: ToolDocRow[] = []): AgentTool[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: AgentTool[] = [];
  for (const spec of agentActionSpecs()) {
    const id = `action:${spec.id}`;
    const row = byKey.get(id);
    out.push({
      id,
      kind: "action",
      name: spec.title,
      category: spec.category,
      summary: spec.subtitle,
      inputs: row?.inputs ?? "",
      source: actionSource(spec),
      vram: row?.vram ?? null,
      commercial: row?.commercial ?? null,
      inputSchema: actionInputSchema(spec),
    });
  }
  for (const tool of getEditTools()) {
    const id = `catalog:${tool.id}`;
    const row = byKey.get(id);
    const license = toolLicense(tool);
    out.push({
      id,
      kind: "catalog",
      name: tool.label,
      category: tool.category,
      summary: tool.description,
      inputs: row?.inputs ?? "",
      source: "image",
      vram: row?.vram ?? null,
      commercial: row?.commercial ?? null,
      license: {
        name: license.name,
        commercial: license.commercial,
        note: license.note,
      },
      inputSchema: catalogInputSchema(tool),
    });
  }
  return out;
}

/** "action:x" | "catalog:x" | a bare id (action ids first). */
export function resolveAgentToolId(
  id: unknown,
):
  | { kind: "action"; spec: ActionToolSpec }
  | { kind: "catalog"; tool: EditToolDef }
  | null {
  if (typeof id !== "string" || !id) return null;
  const colon = id.indexOf(":");
  const prefix = colon > 0 ? id.slice(0, colon) : "";
  const bare = colon > 0 ? id.slice(colon + 1) : id;
  if (prefix !== "catalog") {
    const spec = getActionTool(bare);
    if (spec && agentActionSpecs().includes(spec))
      return { kind: "action", spec };
    if (prefix === "action") return null;
  }
  const tool = getEditTool(bare);
  return tool ? { kind: "catalog", tool } : null;
}

export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputError";
  }
}

export interface AgentActionInput {
  text?: unknown;
  second_text?: unknown;
  options?: unknown;
  edit_lora?: unknown;
  edit_family?: unknown;
  /** Uploaded refs ("name [input]") the agent client already resolved. */
  second_ref?: unknown;
  extra_refs?: unknown;
  audio_ref?: unknown;
  audio_seconds?: unknown;
  /** Uploaded subject-mask refs (REGION_MASK_TOOLS only). */
  mask_refs?: unknown;
  /** Refocus: {x,y} normalized; Rack focus: focus_a/focus_b {x,y,t}. */
  focus?: unknown;
  focus_a?: unknown;
  focus_b?: unknown;
}

function optFocus(v: unknown, field: string): FocusPoint | undefined {
  if (v === undefined || v === null) return undefined;
  const p = focusPoint(v);
  if (!p) throw new AgentInputError(`${field} must be {x, y} numbers from 0 to 1`);
  return p;
}

function optString(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string")
    throw new AgentInputError(`${field} must be a string`);
  if (v.length > max)
    throw new AgentInputError(`${field} is longer than ${max} characters`);
  return v;
}

/** Agent inputs -> ToolSettings, rejecting unknown option keys and values. */
export function agentActionSettings(
  spec: ActionToolSpec,
  input: AgentActionInput,
): ToolSettings {
  const settings = defaultSettings(spec);
  settings.text = optString(input.text, "text", 2000) ?? "";
  const second = optString(input.second_text, "second_text", 4000);
  if (second !== undefined) settings.secondText = second;
  const lora = optString(input.edit_lora, "edit_lora", 200);
  if (lora) settings.editLoraId = lora;
  const family = optString(input.edit_family, "edit_family", 200);
  if (family) settings.editFamily = family;
  const opts = input.options;
  if (opts !== undefined && opts !== null) {
    if (typeof opts !== "object" || Array.isArray(opts))
      throw new AgentInputError("options must be an object");
    for (const [key, value] of Object.entries(
      opts as Record<string, unknown>,
    )) {
      const picker = spec.pickers?.find((p) => p.key === key);
      const slider = spec.sliders?.find((s) => s.key === key);
      if (picker) {
        if (
          typeof value !== "string" ||
          !picker.options.some((o) => o.id === value)
        )
          throw new AgentInputError(
            `options.${key} must be one of: ${picker.options.map((o) => o.id).join(", ")}`,
          );
        settings.picks[key] = value;
      } else if (slider) {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n) || n < slider.min || n > slider.max)
          throw new AgentInputError(
            `options.${key} must be a number from ${slider.min} to ${slider.max}`,
          );
        settings.picks[key] = String(n);
      } else {
        throw new AgentInputError(`Unknown option "${key}" for ${spec.id}`);
      }
    }
  }
  if (spec.id === "refocus") {
    settings.focusPoints = [optFocus(input.focus, "focus") ?? { x: 0.5, y: 0.5 }];
  } else if (spec.id === "rack_focus") {
    const a = optFocus(input.focus_a, "focus_a");
    const b = optFocus(input.focus_b, "focus_b");
    if (!a || !b) throw new AgentInputError("rack_focus needs focus_a and focus_b");
    settings.focusPoints = [a, b];
  }
  return settings;
}

function refList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x))
    throw new AgentInputError(`${field} must be an array of refs`);
  return v as string[];
}

export interface CompiledAction {
  action: string;
  params: Record<string, unknown>;
  overrides: Record<string, unknown>;
  tool_page_id: string;
  source: AgentToolSource;
}

/** The /api/jobs/action fields the Tools page would send for these inputs. */
export function compileAgentAction(
  spec: ActionToolSpec,
  input: AgentActionInput,
  editLoras: EditLoraListResponse | null,
): CompiledAction {
  const settings = agentActionSettings(spec, input);
  const secondRef = optString(input.second_ref, "second_ref", 500) || undefined;
  const audioRef = optString(input.audio_ref, "audio_ref", 500);
  const seconds =
    typeof input.audio_seconds === "number" &&
    Number.isFinite(input.audio_seconds)
      ? input.audio_seconds
      : undefined;
  const req = buildActionRequest(
    spec,
    settings,
    editLoras,
    spec.secondImage ? secondRef : undefined,
    audioRef
      ? { ref: audioRef, ...(seconds !== undefined ? { seconds } : {}) }
      : undefined,
    refList(input.extra_refs, "extra_refs").slice(
      0,
      spec.extraImages?.length ?? 0,
    ),
  );
  const maskRefs = REGION_MASK_TOOLS[spec.id]
    ? refList(input.mask_refs, "mask_refs").slice(0, REGION_MASK_TOOLS[spec.id].subjects)
    : [];
  return {
    action: req.action,
    params: withRegionMasks(req.params, maskRefs),
    overrides: req.overrides,
    tool_page_id: spec.id,
    source: actionSource(spec),
  };
}
