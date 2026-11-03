/**
 * Optional-node bypass: graceful degradation when a non-essential custom node
 * is not installed on the connected ComfyUI.
 *
 * A workflow marks a node optional in its API-format `_meta`:
 *
 *   "5": { "class_type": "ApplyKrea2NegPiP", "inputs": {...},
 *          "_meta": { "title": "Krea 2 NegPiP", "optional": true,
 *                     "optional_warning": "NegPiP not installed — ..." } }
 *
 * When the node's class_type is missing from /object_info, every consumer of
 * one of its outputs is rewired to the node's matching pass-through input and
 * the node is dropped. Output k maps to an input by, in order:
 *   1. `_meta.passthrough` (`{ "<outputIndex>": "<inputName>" }`), explicit;
 *   2. type: the link input whose source produces the type the consumers
 *      expect for output k (MODEL -> model, CLIP -> clip);
 *   3. position: the k-th link input (rejected if its type is known and differs).
 * Chains of bypassed nodes resolve transitively. A missing optional node that
 * cannot be bypassed (no matching input) is left in place, so validation still
 * fails loudly. Non-optional missing nodes are never touched.
 *
 * Pure: no network. See objectInfoCache.applyOptionalNodeBypass for the fetch.
 */

type Ref = [string, number];
type ObjectInfoLike = Record<string, unknown>;

interface ApiNodeLike {
  class_type?: unknown;
  inputs?: Record<string, unknown>;
  _meta?: Record<string, unknown> | null;
}

export interface BypassedNode {
  nodeId: string;
  classType: string;
  title: string;
  /** User-facing warning (`_meta.optional_warning`, else a generic one). */
  warning: string;
}

export interface OptionalBypassResult<T> {
  /** Rewired copy (or the input itself when nothing was bypassed). */
  prompt: T;
  bypassed: BypassedNode[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isLink(v: unknown): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number"
  );
}

function toRef(v: [string | number, number]): Ref {
  return [String(v[0]), v[1]];
}

export function isOptionalNode(node: unknown): boolean {
  return isRecord(node) && isRecord(node._meta) && node._meta.optional === true;
}

/** Input type name from an object_info spec (`["MODEL"]`, `["CLIP", {...}]`). */
function specType(spec: unknown): string | null {
  if (!Array.isArray(spec)) return null;
  return typeof spec[0] === "string" ? spec[0] : null;
}

function inputSpec(
  objectInfo: ObjectInfoLike,
  classType: unknown,
  input: string,
): unknown {
  if (typeof classType !== "string") return undefined;
  const def = objectInfo[classType];
  if (!isRecord(def) || !isRecord(def.input)) return undefined;
  const { required, optional } = def.input as Record<string, unknown>;
  if (isRecord(required) && input in required) return required[input];
  if (isRecord(optional) && input in optional) return optional[input];
  return undefined;
}

function outputType(
  objectInfo: ObjectInfoLike,
  classType: unknown,
  index: number,
): string | null {
  if (typeof classType !== "string") return null;
  const def = objectInfo[classType];
  if (!isRecord(def) || !Array.isArray(def.output)) return null;
  const t = def.output[index];
  return typeof t === "string" ? t : null;
}

function defaultWarning(classType: string, title: string): string {
  const name =
    title && title !== classType ? `${title} (${classType})` : classType;
  return `${name} not installed — skipped; the result runs without it`;
}

/**
 * Rewire around missing optional nodes. Returns the input object unchanged
 * when nothing is bypassed; otherwise a deep copy with the nodes removed.
 */
export function bypassMissingOptionalNodes<T extends object>(
  prompt: T,
  objectInfo: ObjectInfoLike,
): OptionalBypassResult<T> {
  if (!isRecord(prompt)) return { prompt, bypassed: [] };
  const nodes = prompt as Record<string, ApiNodeLike>;

  const candidates = new Set(
    Object.entries(nodes)
      .filter(
        ([, n]) =>
          isOptionalNode(n) &&
          typeof n.class_type === "string" &&
          !isRecord(objectInfo[n.class_type]),
      )
      .map(([id]) => id),
  );
  if (candidates.size === 0) return { prompt, bypassed: [] };

  // Every link into a surviving node: [src, idx] -> consuming inputs.
  const liveLinks: Array<{ nodeId: string; input: string; ref: Ref }> = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRecord(node) || !isRecord(node.inputs)) continue;
    for (const [input, v] of Object.entries(node.inputs)) {
      if (isLink(v)) liveLinks.push({ nodeId: id, input, ref: toRef(v) });
    }
  }

  /** Type a ref carries; null for bypass candidates (not in object_info). */
  const sourceType = (ref: Ref): string | null =>
    candidates.has(ref[0])
      ? null
      : outputType(objectInfo, nodes[ref[0]]?.class_type, ref[1]);

  /**
   * Pass-through input for output `idx` of candidate `id`, given the type the
   * downstream consumer expects (null when unknown).
   */
  const passthroughOf = (
    id: string,
    idx: number,
    wanted: string | null,
  ): Ref | null => {
    const node = nodes[id];
    const inputs = isRecord(node?.inputs) ? node.inputs : {};
    const linkInputs = Object.entries(inputs).filter(
      (e): e is [string, [string | number, number]] => isLink(e[1]),
    );
    const meta = isRecord(node?._meta) ? node._meta : {};
    const explicit = isRecord(meta.passthrough)
      ? meta.passthrough[String(idx)]
      : undefined;
    if (typeof explicit === "string") {
      const v = inputs[explicit];
      return isLink(v) ? toRef(v) : null;
    }
    if (wanted && wanted !== "*") {
      // By type: the one input whose source produces the wanted type.
      const typed = linkInputs.filter(
        ([, v]) => sourceType(toRef(v)) === wanted,
      );
      if (typed.length === 1) return toRef(typed[0][1]);
      // By name (MODEL -> model, CLIP -> clip): also covers chained
      // candidates, whose output types object_info cannot tell.
      const named = linkInputs.find(([name]) => name.toUpperCase() === wanted);
      if (named) return toRef(named[1]);
      if (typed.length > 1) return toRef(typed[0][1]);
    }
    // By position, unless that input is known to carry a different type.
    const positional = linkInputs[idx];
    if (!positional) return null;
    const ref = toRef(positional[1]);
    if (wanted && wanted !== "*") {
      const t = sourceType(ref);
      if (t !== null && t !== wanted) return null;
    }
    return ref;
  };

  /** Follow a ref through bypassed nodes to a surviving source. */
  const resolve = (ref: Ref, wanted: string | null): Ref | null => {
    const seen = new Set<string>();
    let cur = ref;
    while (candidates.has(cur[0])) {
      if (seen.has(cur[0])) return null; // cycle
      seen.add(cur[0]);
      const next = passthroughOf(cur[0], cur[1], wanted);
      if (!next) return null;
      cur = next;
    }
    return cur;
  };

  const wantedType = (nodeId: string, input: string): string | null =>
    specType(inputSpec(objectInfo, nodes[nodeId]?.class_type, input));

  // Drop candidates that cannot be bypassed (a surviving consumer finds no
  // pass-through); repeat, since dropping one changes what survives.
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of liveLinks) {
      if (candidates.has(link.nodeId) || !candidates.has(link.ref[0])) continue;
      if (resolve(link.ref, wantedType(link.nodeId, link.input))) continue;
      // Un-bypass the first candidate in the failing chain.
      candidates.delete(link.ref[0]);
      changed = true;
    }
  }
  if (candidates.size === 0) return { prompt, bypassed: [] };

  const out = structuredClone(prompt) as Record<string, ApiNodeLike>;
  const bypassed: BypassedNode[] = [];
  for (const id of candidates) {
    const node = nodes[id];
    const classType = String(node.class_type);
    const meta = isRecord(node._meta) ? node._meta : {};
    const title =
      typeof meta.title === "string" && meta.title.trim()
        ? meta.title
        : classType;
    const warning =
      typeof meta.optional_warning === "string" && meta.optional_warning.trim()
        ? meta.optional_warning
        : defaultWarning(classType, title);
    bypassed.push({ nodeId: id, classType, title, warning });
  }
  for (const [id, node] of Object.entries(out)) {
    if (candidates.has(id) || !isRecord(node) || !isRecord(node.inputs))
      continue;
    for (const [input, v] of Object.entries(node.inputs)) {
      if (!isLink(v) || !candidates.has(String(v[0]))) continue;
      // Succeeded for every surviving consumer in the pruning pass above.
      const target = resolve(toRef(v), wantedType(id, input));
      if (target) node.inputs[input] = target;
    }
  }
  for (const id of candidates) delete out[id];
  return { prompt: out as T, bypassed };
}
