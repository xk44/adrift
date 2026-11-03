/**
 * Plain "needs X" summary of pre-submit validation problems, for the job
 * routes' top-level error string. A default-routed graph whose custom node or
 * model is not installed then reads "This needs the ComfyUI node X ..."
 * instead of "Workflow failed validation: Node class ... (#3) ...". The full
 * problem list still travels in `problems` for clients that classify it.
 *
 * Pure: no imports beyond types.
 */
import type { PromptProblem } from "./validatePrompt";

const MODEL_FILE_RE =
  /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|pkl|th|tar|npz)$/i;

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function comboValue(p: PromptProblem): string | undefined {
  return (
    /^Value "([^"]+)"/.exec(p.message)?.[1] ?? /'([^']+)'/.exec(p.message)?.[1]
  );
}

/** Missing node classes and model files named by `problems` (sorted, distinct). */
export function missingFromProblems(problems: readonly PromptProblem[]): {
  nodes: string[];
  models: string[];
} {
  const nodes = new Set<string>();
  const models = new Set<string>();
  for (const p of problems) {
    if (p.kind === "unknown_class_type" && p.classType) nodes.add(p.classType);
    if (p.kind === "invalid_combo_value") {
      const v = comboValue(p);
      if (v && MODEL_FILE_RE.test(v)) models.add(v);
    }
  }
  return { nodes: [...nodes].sort(), models: [...models].sort() };
}

/**
 * "This needs ..." sentence, or null when nothing is missing (other
 * validation problems keep the route's original message).
 */
export function needsMessage(
  problems: readonly PromptProblem[] | undefined,
): string | null {
  if (!problems?.length) return null;
  const { nodes, models } = missingFromProblems(problems);
  if (!nodes.length && !models.length) return null;
  const parts: string[] = [];
  if (nodes.length) {
    parts.push(
      `the ComfyUI ${nodes.length === 1 ? "node" : "nodes"} ${list(nodes)}`,
    );
  }
  if (models.length) {
    parts.push(
      `the model ${models.length === 1 ? "file" : "files"} ${list(models)}`,
    );
  }
  const what =
    nodes.length && models.length
      ? "aren't"
      : nodes.length + models.length === 1
        ? "isn't"
        : "aren't";
  return `This needs ${parts.join(" and ")}, which ${what} installed on this ComfyUI yet. Install ${
    nodes.length + models.length === 1 ? "it" : "them"
  } (see Set up this tool), then try again.`;
}
