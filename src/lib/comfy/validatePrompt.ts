/**
 * Pre-submit validation of an API-format ComfyUI prompt against an
 * /object_info snapshot. Catches the failures ComfyUI would reject with
 * node_errors (missing custom node, missing input, uninstalled model, bad
 * link, out-of-range number) before a round trip, with node titles attached.
 *
 * Pure: no network. See objectInfoCache.ts for the fetch.
 */

export type PromptProblemKind =
  | "unknown_class_type"
  | "missing_required_input"
  | "invalid_combo_value"
  | "invalid_link"
  | "out_of_range";

export interface PromptProblem {
  kind: PromptProblemKind;
  nodeId: string;
  /** _meta.title when present, else class_type, else the node id. */
  nodeTitle: string;
  classType: string | null;
  /** Input name, when the problem is about one input. */
  input?: string;
  message: string;
}

type ObjectInfoLike = Record<string, unknown>;

interface ApiNode {
  class_type?: unknown;
  inputs?: unknown;
  _meta?: { title?: unknown } | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A link is [sourceNodeId, outputIndex]. */
function isLink(v: unknown): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number"
  );
}

function nodeTitle(id: string, node: ApiNode | undefined): string {
  const t = node?._meta?.title;
  if (typeof t === "string" && t.trim()) return t;
  if (typeof node?.class_type === "string") return node.class_type;
  return id;
}

/** Combo options from either legacy `[[...], {}]` or new `["COMBO", {options}]`. */
export function comboOptions(spec: unknown[]): unknown[] | null {
  const first = spec[0];
  if (Array.isArray(first)) return first;
  if (first === "COMBO") {
    const cfg = spec[1];
    if (isRecord(cfg)) {
      // Remote-populated combos cannot be checked against a static list.
      if (cfg.remote) return null;
      if (Array.isArray(cfg.options)) return cfg.options;
    }
  }
  return null;
}

/** Upload combos (LoadImage & co.) list files present when object_info was
 * fetched; a just-uploaded file is legitimately absent. ComfyUI checks the
 * file itself, so these are never judged here. */
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

/** ComfyUI annotated file path ("clip.mp4 [input]", "video/x.mp4 [output]",
 * "preview.png [temp]"). File combos without an upload flag (VHS_LoadVideo)
 * list bare input names only, but the node resolves annotated paths itself
 * (folder_paths.annotated_filepath strips exactly " [input]" / " [output]" /
 * " [temp]"), so ComfyUI judges the file. Empty names, absolute paths and
 * ".." segments are not treated as annotated, so they still face the combo
 * check instead of being waved through. */
const ANNOTATED_FILE_RE = /^(\S.*) \[(input|output|temp)\]$/;

export function parseAnnotatedFilePath(
  value: unknown,
): { name: string; type: "input" | "output" | "temp" } | null {
  if (typeof value !== "string") return null;
  const m = ANNOTATED_FILE_RE.exec(value);
  if (!m) return null;
  const name = m[1];
  if (/^[\\/]|^[A-Za-z]:/.test(name)) return null;
  if (name.split(/[\\/]/).some((seg) => seg === "..")) return null;
  return { name, type: m[2] as "input" | "output" | "temp" };
}

function annotatedFilePath(value: unknown): boolean {
  return parseAnnotatedFilePath(value) !== null;
}

function numericType(spec: unknown[]): "INT" | "FLOAT" | null {
  return spec[0] === "INT" || spec[0] === "FLOAT" ? spec[0] : null;
}

export function validatePrompt(
  prompt: unknown,
  objectInfo: ObjectInfoLike,
): PromptProblem[] {
  const problems: PromptProblem[] = [];
  if (!isRecord(prompt)) return problems;
  const nodes = prompt as Record<string, ApiNode>;

  for (const [id, node] of Object.entries(nodes)) {
    if (!isRecord(node)) continue;
    const classType =
      typeof node.class_type === "string" ? node.class_type : null;
    const title = nodeTitle(id, node);
    const push = (kind: PromptProblemKind, message: string, input?: string) =>
      problems.push({
        kind,
        nodeId: id,
        nodeTitle: title,
        classType,
        input,
        message,
      });

    const def = classType ? objectInfo[classType] : undefined;
    if (!classType || !isRecord(def)) {
      push(
        "unknown_class_type",
        `Node class "${classType ?? "(none)"}" is not installed in ComfyUI (missing custom node?)`,
      );
      continue;
    }

    const inputs = isRecord(node.inputs) ? node.inputs : {};
    const spec = isRecord(def.input) ? def.input : {};
    const required = isRecord(spec.required) ? spec.required : {};
    const optional = isRecord(spec.optional) ? spec.optional : {};

    // Missing required inputs. V3 dynamic inputs (COMFY_AUTOGROW_V3, e.g.
    // ConcatenateVideo.videos) are sent as "<name>.<child>" keys instead.
    const inputKeys = Object.keys(inputs);
    for (const name of Object.keys(required)) {
      if (
        (!(name in inputs) ||
          inputs[name] === undefined ||
          inputs[name] === null) &&
        !inputKeys.some((k) => k.startsWith(`${name}.`))
      ) {
        push(
          "missing_required_input",
          `Required input "${name}" is missing`,
          name,
        );
      }
    }

    // Per-input checks (required + optional)
    for (const [name, value] of Object.entries(inputs)) {
      // Links: target node + output index must exist
      if (isLink(value)) {
        const srcId = String(value[0]);
        const src = nodes[srcId];
        if (!isRecord(src)) {
          push(
            "invalid_link",
            `Input "${name}" links to node ${srcId}, which does not exist`,
            name,
          );
          continue;
        }
        const srcDef =
          typeof src.class_type === "string"
            ? objectInfo[src.class_type]
            : undefined;
        // Unknown source class is reported on that node itself.
        if (isRecord(srcDef) && Array.isArray(srcDef.output)) {
          if (value[1] < 0 || value[1] >= srcDef.output.length) {
            push(
              "invalid_link",
              `Input "${name}" links to output ${value[1]} of node ${srcId} (${nodeTitle(srcId, src)}), which has ${srcDef.output.length} output(s)`,
              name,
            );
          }
        }
        continue;
      }

      const inSpec = (required[name] ?? optional[name]) as
        unknown[] | undefined;
      if (!Array.isArray(inSpec)) continue; // extra/hidden input: not ours to judge

      const options =
        uploadCombo(inSpec) || annotatedFilePath(value)
          ? null
          : comboOptions(inSpec);
      if (options) {
        if (!options.includes(value as never)) {
          const shown = options.slice(0, 5).map(String).join(", ");
          const more =
            options.length > 5 ? `, … (${options.length} total)` : "";
          push(
            "invalid_combo_value",
            `Value ${JSON.stringify(value)} is not an available option for "${name}"${options.length ? ` (available: ${shown}${more})` : " (no options available; is the file installed?)"}`,
            name,
          );
        }
        continue;
      }

      const num = numericType(inSpec);
      if (num && typeof value === "number") {
        const cfg = isRecord(inSpec[1]) ? inSpec[1] : {};
        const min = typeof cfg.min === "number" ? cfg.min : undefined;
        const max = typeof cfg.max === "number" ? cfg.max : undefined;
        if (min !== undefined && value < min) {
          push(
            "out_of_range",
            `Value ${value} for "${name}" is below the minimum ${min}`,
            name,
          );
        } else if (max !== undefined && value > max) {
          push(
            "out_of_range",
            `Value ${value} for "${name}" is above the maximum ${max}`,
            name,
          );
        }
      }
    }
  }
  return problems;
}

/** Distinct class_types in a prompt that object_info does not know. */
export function findMissingClassTypes(
  prompt: unknown,
  objectInfo: ObjectInfoLike,
): string[] {
  const out = new Set<string>();
  if (!isRecord(prompt)) return [];
  for (const node of Object.values(prompt)) {
    if (!isRecord(node)) continue;
    const ct = node.class_type;
    if (typeof ct === "string" && !isRecord(objectInfo[ct])) out.add(ct);
  }
  return [...out].sort();
}

export class PromptValidationError extends Error {
  readonly statusCode = 422;
  constructor(public readonly problems: PromptProblem[]) {
    super(formatProblemsSummary(problems));
    this.name = "PromptValidationError";
  }
}

export function formatProblem(p: PromptProblem): string {
  const where = p.input
    ? `${p.nodeTitle} (#${p.nodeId}) / ${p.input}`
    : `${p.nodeTitle} (#${p.nodeId})`;
  return `${where}: ${p.message}`;
}

export function formatProblemsSummary(problems: PromptProblem[]): string {
  const head = problems.slice(0, 3).map(formatProblem).join("; ");
  const more = problems.length > 3 ? ` (+${problems.length - 3} more)` : "";
  return `Workflow failed validation: ${head}${more}`;
}
