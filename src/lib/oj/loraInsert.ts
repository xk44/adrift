/**
 * Generic "insert LoraLoaderModelOnly nodes into an API-format graph" helper.
 * Used for the optional H3 extra LoRAs (motion repair / handheld) and the
 * MOSS-Image speed / deband options, so one implementation owns the rewiring.
 */
import type { Workflow } from "@/types";

export interface LoraSpec {
  /** File under models/loras. */
  file: string;
  strength: number;
  /** Node title shown in ComfyUI. */
  title?: string;
}

/** Next free numeric node id (max existing numeric id + 1). */
export function nextNodeId(workflow: Workflow): string {
  let max = 0;
  for (const id of Object.keys(workflow)) {
    const n = Number.parseInt(id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

function isLink(value: unknown, id: string): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    String(value[0]) === id &&
    Number(value[1]) === 0
  );
}

/** True when some LoraLoader* node in the graph already loads `file`. */
export function hasLora(workflow: Workflow, file: string): boolean {
  const want = file.toLowerCase();
  return Object.values(workflow).some(
    (n) =>
      (n.class_type === "LoraLoaderModelOnly" ||
        n.class_type === "LoraLoader") &&
      String(n.inputs?.lora_name ?? "").toLowerCase() === want,
  );
}

/**
 * Chain `loras` (in order) after the MODEL output of `afterId`: every other
 * node input that consumed [afterId, 0] is repointed at the chain tail, so
 * samplers / schedulers / guiders downstream pick the LoRAs up. Returns the new
 * node ids (empty when `loras` is empty or `afterId` is missing).
 */
export function insertModelLoras(
  workflow: Workflow,
  afterId: string,
  loras: LoraSpec[],
): string[] {
  if (!loras.length || !workflow[afterId]) return [];

  // Collect consumers before adding the new nodes.
  const consumers: Array<{ id: string; input: string }> = [];
  for (const [id, node] of Object.entries(workflow)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (isLink(value, afterId)) consumers.push({ id, input });
    }
  }

  const ids: string[] = [];
  let prev = afterId;
  for (const lora of loras) {
    const id = nextNodeId(workflow);
    workflow[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [prev, 0],
        lora_name: lora.file,
        strength_model: lora.strength,
      },
      ...(lora.title ? { _meta: { title: lora.title } } : {}),
    } as Workflow[string];
    ids.push(id);
    prev = id;
  }
  for (const c of consumers) {
    (workflow[c.id].inputs as Record<string, unknown>)[c.input] = [prev, 0];
  }
  return ids;
}
