/**
 * Static linter for API-format ComfyUI graphs against an /object_info map,
 * so a broken graph is caught before it costs GPU time. Pure: no network.
 *
 * Errors (ComfyUI would reject or crash on these):
 *  - missing_node / bad_output_index: a link points at a node that does not
 *    exist, or past the source node's outputs
 *  - type_mismatch: source output type vs target input type ("*" and
 *    comma unions match like ComfyUI's validate_node_input; list specs are
 *    COMBO)
 *  - missing_required_input
 *  - unknown_input: an input name the class does not declare (ComfyUI drops
 *    it silently, so the intended setting never applies)
 *  - unknown_class_type: class not in object_info (node not installed)
 *  - invalid_combo_value: a non-file combo value not in the option list
 *  - out_of_range: number below min / above max
 * Warnings:
 *  - model_file_not_listed: a model-file combo value the snapshot does not
 *    list (files differ per install; model-status checks those)
 */
import {
  comboOptions,
  parseAnnotatedFilePath,
} from "@/lib/comfy/validatePrompt";

export type GraphLintKind =
  | "unknown_class_type"
  | "missing_node"
  | "bad_output_index"
  | "type_mismatch"
  | "missing_required_input"
  | "unknown_input"
  | "invalid_combo_value"
  | "out_of_range"
  | "model_file_not_listed";

export interface GraphLintIssue {
  severity: "error" | "warn";
  kind: GraphLintKind;
  nodeId: string;
  classType: string | null;
  input?: string;
  message: string;
}

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** ComfyUI treats any [nodeId, outputIndex] pair as a link. */
export function isGraphLink(v: unknown): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    Number.isInteger(v[1])
  );
}

const MODEL_FILE_RE =
  /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx|pkl|engine)$/i;

/** Type name of an input/output spec entry: list specs are COMBO. */
function typeName(t: unknown): string | null {
  if (Array.isArray(t)) return "COMBO";
  return typeof t === "string" ? t : null;
}

/**
 * V3 container/template types (COMFY_AUTOGROW_V3, COMFY_MATCHTYPE_V3, ...)
 * resolve per connection, so they match anything here.
 */
function isWildcard(t: string): boolean {
  return t === "*" || /^COMFY_\w+_V3$/.test(t);
}

/** Same rules as ComfyUI's validate_node_input (non-strict). */
export function typesCompatible(received: string, expected: string): boolean {
  if (received === expected) return true;
  if (isWildcard(received) || isWildcard(expected)) return true;
  const r = new Set(received.split(",").map((s) => s.trim()));
  const e = new Set(expected.split(",").map((s) => s.trim()));
  if (r.has("*") || e.has("*")) return true;
  for (const t of r) if (e.has(t)) return true;
  return false;
}

function uploadCombo(spec: unknown[]): boolean {
  const cfg = spec[1];
  if (!isRecord(cfg)) return false;
  return Boolean(
    cfg.image_upload ||
    cfg.video_upload ||
    cfg.audio_upload ||
    cfg.mesh_upload ||
    cfg.upload ||
    cfg.image_folder,
  );
}

function isModelFileCombo(value: unknown, options: unknown[]): boolean {
  if (typeof value === "string" && MODEL_FILE_RE.test(value)) return true;
  return options.some((o) => typeof o === "string" && MODEL_FILE_RE.test(o));
}

export interface GraphLintOptions {
  /** Classes known absent: skipped, not reported. */
  skipClasses?: Iterable<string>;
  /**
   * Template graphs: an empty-string combo value is a slot the builder fills
   * at queue time (VHS_LoadVideo.video: ""), not a bad value.
   */
  templateSlots?: boolean;
}

export function lintGraph(
  graph: unknown,
  objectInfo: Record<string, unknown>,
  opts: GraphLintOptions = {},
): GraphLintIssue[] {
  const issues: GraphLintIssue[] = [];
  if (!isRecord(graph)) return issues;
  const skip = new Set(opts.skipClasses ?? []);
  const nodes: Record<string, Rec> = {};
  for (const [id, n] of Object.entries(graph)) {
    if (id.startsWith("_") || !isRecord(n)) continue;
    nodes[id] = n;
  }

  for (const [id, node] of Object.entries(nodes)) {
    const classType =
      typeof node.class_type === "string" ? node.class_type : null;
    const push = (
      kind: GraphLintKind,
      message: string,
      input?: string,
      severity: "error" | "warn" = "error",
    ) => issues.push({ severity, kind, nodeId: id, classType, input, message });

    if (classType && skip.has(classType)) continue;
    const def = classType ? objectInfo[classType] : undefined;
    const inputs = isRecord(node.inputs) ? node.inputs : {};

    // Links are checked even for unknown classes: a dangling edge is a bug
    // whatever the node.
    const linkTargets: [string, [string | number, number]][] = [];
    for (const [name, v] of Object.entries(inputs)) {
      if (!isGraphLink(v)) continue;
      const srcId = String(v[0]);
      const src = nodes[srcId];
      if (!src) {
        push(
          "missing_node",
          `"${name}" links to node ${srcId}, which does not exist`,
          name,
        );
        continue;
      }
      const srcClass =
        typeof src.class_type === "string" ? src.class_type : null;
      const srcDef = srcClass ? objectInfo[srcClass] : undefined;
      if (!isRecord(srcDef) || !Array.isArray(srcDef.output)) continue;
      if (v[1] < 0 || v[1] >= srcDef.output.length) {
        push(
          "bad_output_index",
          `"${name}" links to output ${v[1]} of node ${srcId} (${srcClass}), which has ${srcDef.output.length} output(s)`,
          name,
        );
        continue;
      }
      linkTargets.push([name, v]);
    }

    if (!classType || !isRecord(def)) {
      push(
        "unknown_class_type",
        `class "${classType ?? "(none)"}" is not in object_info (custom node not installed?)`,
      );
      continue;
    }

    const spec = isRecord(def.input) ? def.input : {};
    const required = isRecord(spec.required) ? spec.required : {};
    const optional = isRecord(spec.optional) ? spec.optional : {};
    const hidden = isRecord(spec.hidden) ? spec.hidden : {};
    const specFor = (name: string): unknown[] | undefined => {
      const s = required[name] ?? optional[name] ?? hidden[name];
      return Array.isArray(s) ? s : undefined;
    };
    // Hidden specs are bare type strings ("UNIQUE_ID"), not arrays.
    const declared = (name: string): boolean =>
      name in required || name in optional || name in hidden;
    const keys = Object.keys(inputs);

    // (c) required inputs. V3 dynamic inputs arrive as "<name>.<child>".
    for (const name of Object.keys(required)) {
      const v = inputs[name];
      if (
        (v === undefined || v === null) &&
        !keys.some((k) => k.startsWith(`${name}.`))
      )
        push(
          "missing_required_input",
          `required input "${name}" is missing`,
          name,
        );
    }

    // (d) unknown input names.
    for (const name of keys) {
      if (declared(name) || name === "upload") continue;
      const parent = name.split(".")[0];
      if (parent !== name && declared(parent)) continue;
      push(
        "unknown_input",
        `input "${name}" is not declared by ${classType}`,
        name,
      );
    }

    // (b) link types.
    for (const [name, v] of linkTargets) {
      const inSpec = specFor(name);
      if (!inSpec) continue; // reported as unknown_input (or dynamic child)
      const expected = typeName(inSpec[0]);
      const src = nodes[String(v[0])];
      const srcDef = objectInfo[src.class_type as string] as Rec;
      const received = typeName((srcDef.output as unknown[])[v[1]]);
      if (!expected || !received) continue;
      if (!typesCompatible(received, expected))
        push(
          "type_mismatch",
          `"${name}" expects ${expected} but node ${v[0]} (${src.class_type}) output ${v[1]} is ${received}`,
          name,
        );
    }

    // (e) combos + numeric ranges for literal values.
    for (const [name, value] of Object.entries(inputs)) {
      if (isGraphLink(value)) continue;
      const inSpec = specFor(name);
      if (!inSpec) continue;
      const options =
        uploadCombo(inSpec) || parseAnnotatedFilePath(value)
          ? null
          : comboOptions(inSpec);
      if (options) {
        if (options.includes(value as never)) continue;
        if (opts.templateSlots && value === "") continue;
        const model = isModelFileCombo(value, options);
        push(
          model ? "model_file_not_listed" : "invalid_combo_value",
          `${JSON.stringify(value)} is not an option for "${name}"${options.length ? ` (${options.slice(0, 5).map(String).join(", ")}${options.length > 5 ? ", …" : ""})` : ""}`,
          name,
          model ? "warn" : "error",
        );
        continue;
      }
      if (
        (inSpec[0] === "INT" || inSpec[0] === "FLOAT") &&
        typeof value === "number"
      ) {
        const cfg = isRecord(inSpec[1]) ? inSpec[1] : {};
        if (typeof cfg.min === "number" && value < cfg.min)
          push(
            "out_of_range",
            `${value} for "${name}" is below the minimum ${cfg.min}`,
            name,
          );
        else if (typeof cfg.max === "number" && value > cfg.max)
          push(
            "out_of_range",
            `${value} for "${name}" is above the maximum ${cfg.max}`,
            name,
          );
      }
    }
  }
  return issues;
}

export function lintErrors(issues: GraphLintIssue[]): GraphLintIssue[] {
  return issues.filter((i) => i.severity === "error");
}

export function formatLintIssue(i: GraphLintIssue): string {
  const where = i.input
    ? `#${i.nodeId} ${i.classType}.${i.input}`
    : `#${i.nodeId} ${i.classType}`;
  return `${i.kind}: ${where}: ${i.message}`;
}
