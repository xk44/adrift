/**
 * Submit-time upscaler resolver: points each UpscaleModelLoader of a graph at
 * the user's upscaler for that content type (see upscalerPref.ts).
 *
 * Which loaders change
 *   _meta.upscaler "fixed"    never (tool-declared model, or a per-run pick)
 *   _meta.upscaler "default"  always (Adrift's Upscale actions)
 *   unmarked                  only while the preference is locked (default),
 *                             and only full upscalers: 1× cleanup and face
 *                             models are deliberate graph choices
 *
 * Content type: _meta.upscaleContent, else video when the graph has video
 * nodes, else illustration when its checkpoint / LoRA names say so, else
 * photo.
 *
 * Size is preserved: a 4× model replacing a 2× one gets its output scaled by
 * 0.5 (an ImageScaleBy that already follows the upscale is adjusted instead
 * of adding one; a batched upscale's downscale_ratio is adjusted first), so
 * downstream nodes see the size the graph was built for.
 * `_meta.upscaleScale: "pref"` (Faithful) targets the preferred scale
 * instead (absent = the model's own factor). A swap whose size can't be
 * kept (unknown factor, unknown consumer) is skipped, as is a bigger model
 * on a clip's unbatched ImageUpscaleWithModel (every frame would sit at the
 * bigger size). Models missing from the live list are never used; the
 * graph's own model stays. Pure: returns a copy when anything changed.
 */
import type { UpscaleContent } from "./upscalerCatalog";
import { canBeDefault, describeUpscaler } from "./upscalerCatalog";
import {
  contentFromModelNames,
  isLocked,
  isUpscaleContent,
  knownScale,
  resolveDefaultModel,
  type UpscalerPref,
} from "./upscalerPref";
import { upscaleModelScale } from "./upscaleModels";

type PromptNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};
type Graph = Record<string, PromptNode>;

export const LOADER_CLASS = "UpscaleModelLoader";
/** Consumers that upscale pixels by the model's own factor. */
const PIXEL_UPSCALERS = new Set([
  "ImageUpscaleWithModel",
  "ImageUpscaleWithModelBatched",
]);
/** Consumers that resize to their own target whatever the model's factor. */
const SELF_RESIZING = new Set([
  "UltimateSDUpscale",
  "UltimateSDUpscaleCustomSample",
  "UltimateSDUpscaleGGUF",
]);
const VIDEO_CLASS_RE =
  /video|VHS_|LTXV|ToVideo|SeedVR2|AnimateDiff|SaveAnimated|SaveWEBM/i;
const MODEL_NAME_INPUTS = new Set(["ckpt_name", "unet_name", "lora_name"]);

export interface UpscalerSwap {
  nodeId: string;
  from: string;
  to: string;
  content: UpscaleContent;
  source: "choice" | "table" | "scale";
  /** Extra ImageScaleBy factor applied after the upscale (1 = none). */
  rescale: number;
}

export interface ResolveUpscalersResult<T> {
  prompt: T;
  swaps: UpscalerSwap[];
  warnings: string[];
}

export function hasUpscaleLoader(prompt: object): boolean {
  return Object.values(prompt as Graph).some(
    (n) => n && typeof n === "object" && n.class_type === LOADER_CLASS,
  );
}

/** Content type of a whole graph (video > illustration > photo). */
export function graphUpscaleContent(prompt: object): UpscaleContent {
  const nodes = Object.values(prompt as Graph).filter(
    (n) => n && typeof n === "object",
  );
  if (nodes.some((n) => VIDEO_CLASS_RE.test(String(n.class_type ?? ""))))
    return "video";
  const names: string[] = [];
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (MODEL_NAME_INPUTS.has(k) && typeof v === "string") names.push(v);
    }
  }
  return contentFromModelNames(names);
}

function consumersOf(graph: Graph, id: string, output = 0) {
  const out: { id: string; input: string }[] = [];
  for (const [nid, n] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(n?.inputs ?? {})) {
      if (Array.isArray(v) && String(v[0]) === id && Number(v[1]) === output)
        out.push({ id: nid, input: k });
    }
  }
  return out;
}

function nextNodeId(graph: Graph, hint: string): string {
  const nums = Object.keys(graph)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (nums.length === Object.keys(graph).length && nums.length > 0)
    return String(Math.max(...nums) + 1);
  let id = `${hint}_rescale`;
  for (let i = 2; graph[id]; i++) id = `${hint}_rescale${i}`;
  return id;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Scale the output of pixel upscale node `upId` by `factor`. */
function rescaleAfter(graph: Graph, upId: string, factor: number): void {
  const users = consumersOf(graph, upId);
  if (users.length === 1) {
    const u = graph[users[0].id];
    const cur = u.inputs?.scale_by;
    if (u.class_type === "ImageScaleBy" && typeof cur === "number") {
      const next = round4(cur * factor);
      if (next >= 0.01 && next <= 8) {
        u.inputs!.scale_by = next;
        return;
      }
    }
  }
  const id = nextNodeId(graph, upId);
  graph[id] = {
    class_type: "ImageScaleBy",
    inputs: {
      image: [upId, 0],
      upscale_method: "lanczos",
      scale_by: round4(factor),
    },
    _meta: { title: "Keep upscale size" },
  };
  for (const { id: uid, input } of users) {
    graph[uid].inputs![input] = [id, 0];
  }
}

/**
 * Rescale a pixel upscale by `factor`. ImageUpscaleWithModelBatched shrinks
 * each batch itself (downscale_ratio ≤ 1): change that first so a clip never
 * holds frames at the bigger size, and resize after only for the remainder.
 */
function rescaleUpscale(graph: Graph, upId: string, factor: number): void {
  const node = graph[upId];
  const ratio = node.inputs?.downscale_ratio;
  if (node.class_type === "ImageUpscaleWithModelBatched") {
    const cur = typeof ratio === "number" ? ratio : 1;
    const next = round4(cur * factor);
    if (next >= 0.01 && next <= 1) {
      node.inputs!.downscale_ratio = next;
      return;
    }
    if (next > 1) {
      node.inputs!.downscale_ratio = 1;
      rescaleAfter(graph, upId, round4(next));
      return;
    }
  }
  rescaleAfter(graph, upId, factor);
}

export function resolveGraphUpscalers<T extends object>(
  prompt: T,
  opts: {
    pref: UpscalerPref | null | undefined;
    /** Live UpscaleModelLoader.model_name options; null = unknown (no-op). */
    live: readonly string[] | null;
  },
): ResolveUpscalersResult<T> {
  const none = { prompt, swaps: [], warnings: [] };
  if (!opts.live || !hasUpscaleLoader(prompt)) return none;
  const live = opts.live;
  const pref = opts.pref ?? null;
  const graph = JSON.parse(JSON.stringify(prompt)) as Graph;
  const graphContent = graphUpscaleContent(graph);
  const swaps: UpscalerSwap[] = [];
  const warnings = new Set<string>();

  for (const [id, node] of Object.entries(graph)) {
    if (node?.class_type !== LOADER_CLASS) continue;
    const orig = node.inputs?.model_name;
    if (typeof orig !== "string" || !orig) continue;
    const meta = node._meta ?? {};
    const mode = meta.upscaler;
    const wantsPrefScale = meta.upscaleScale === "pref";
    const content = isUpscaleContent(meta.upscaleContent)
      ? meta.upscaleContent
      : graphContent;

    let target = orig;
    let source: UpscalerSwap["source"] = "scale";
    let missingChoice: string | undefined;
    const follows =
      mode === "default" ||
      (mode !== "fixed" &&
        isLocked(pref) &&
        canBeDefault(describeUpscaler(orig, upscaleModelScale(orig))));
    if (follows) {
      const resolved = resolveDefaultModel(content, pref, live);
      const chosen = pref?.[content];
      if (chosen && resolved?.source !== "choice") missingChoice = chosen;
      if (resolved) {
        target = resolved.file;
        source = resolved.source;
      }
    }

    const origScale = knownScale(orig);
    const newScale = knownScale(target);
    const desired = wantsPrefScale ? (pref?.scale ?? newScale) : origScale;
    const factor =
      desired != null && newScale != null ? round4(desired / newScale) : null;

    const users = consumersOf(graph, id);
    const pixelUsers = users.filter((u) =>
      PIXEL_UPSCALERS.has(String(graph[u.id].class_type)),
    );
    const unknownUsers = users.filter(
      (u) =>
        !PIXEL_UPSCALERS.has(String(graph[u.id].class_type)) &&
        !SELF_RESIZING.has(String(graph[u.id].class_type)),
    );
    // Size can't be reasoned about (unknown factor or consumer), or a bigger
    // model would hold a whole clip at its size before the downscale (only
    // the batched node shrinks per batch): keep the graph's model.
    if (
      target !== orig &&
      (factor === null ||
        (factor !== 1 && unknownUsers.length > 0) ||
        (factor < 1 &&
          content === "video" &&
          pixelUsers.some(
            (u) => graph[u.id].class_type === "ImageUpscaleWithModel",
          )))
    ) {
      target = orig;
    }
    if (missingChoice) {
      warnings.add(
        `Upscaler ${missingChoice} is not installed; using ${target}.`,
      );
    }
    if (factor === null) continue;
    const finalNew = knownScale(target);
    const finalFactor =
      desired != null && finalNew != null ? round4(desired / finalNew) : 1;
    if (target === orig && finalFactor === 1) continue;

    node.inputs!.model_name = target;
    if (finalFactor !== 1) {
      for (const u of pixelUsers) rescaleUpscale(graph, u.id, finalFactor);
    }
    swaps.push({
      nodeId: id,
      from: orig,
      to: target,
      content,
      source: target === orig ? "scale" : source,
      rescale: finalFactor,
    });
  }

  if (swaps.length === 0) return { prompt, swaps, warnings: [...warnings] };
  return { prompt: graph as T, swaps, warnings: [...warnings] };
}
