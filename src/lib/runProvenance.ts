/**
 * Run provenance: which tool or image action produced a Create-feed run.
 *
 * Runs reach the client with only `params` (GET /api/jobs/recent rows and
 * live `addRun` runs both end up as `GalleryImage.paramsMap = run.params`;
 * the top-level `ImagineRun.action` is not persisted). The job routes write:
 *
 *   /api/jobs/action  → params.action_provenance = { kind: "action", id, via? }
 *                       + action_source_run_id + action_workflow_path
 *   /api/jobs/tool    → params.action_provenance = { kind: "tool", id, label }
 *                       + tool_id + tool_options (+ action_source_run_id)
 *
 * Both routes spread the SOURCE run's params first, so inherited keys
 * (tool_id on an action-of-a-tool run, action_workflow_path on a
 * tool-of-an-action run) are ambiguous. `action_provenance` is always
 * rewritten by the newest step, so it wins; the legacy keys are only a
 * fallback for runs persisted before it existed.
 *
 * Plain prompt runs (no provenance keys) → null. So are legacy rows whose
 * keys neither name a tool nor link a source run: no evidence, no chip.
 */

import registry from "@/lib/oj/registry.json";
import editToolRegistry from "@/lib/tools/editToolRegistry.json";
import { ACTION_TOOLS } from "@/lib/tools/toolsPage";
import {
  catalogToolTitle,
  EXPAND_KEY,
  toolTitle,
} from "@/lib/tools/toolNames";

export type RunProvenanceKind = "action" | "tool";

export interface RunProvenance {
  kind: RunProvenanceKind;
  /** Action id (registry key) or edit-tool id; "" when only a legacy hint exists. */
  id: string;
  /** Short human label for the chip ("Upscale · Creative", "Object Remover"). */
  label: string;
  /** Run this one was made from, when the route recorded it. */
  sourceRunId?: string;
}

/** Params key the job routes write (prefix `action_` keeps it out of chips). */
export const PROVENANCE_PARAM_KEY = "action_provenance";

/**
 * Neutral label for a legacy run that was made from another run (it carries
 * the source-run link) but can't be pinned to one tool.
 */
export const GENERIC_EDIT_LABEL = "Edited";

const VARY = toolTitle("lightbox:vary");
const UPSCALE = toolTitle("action:upscale");
const REMIX = toolTitle("inline:remix");
const EXPAND = toolTitle(EXPAND_KEY);
const ANIMATE = toolTitle("action:animate");
const FACE_ENHANCER = toolTitle("action:enhance_faces");
const REALISM = toolTitle("inline:realism");

/**
 * Tool · variant labels for the feed's own image actions. Tool names come
 * from toolNames.ts (zoom + pan are Expand, ADetailer is Face Enhancer).
 */
const ACTION_VARIANT_LABELS: Readonly<Record<string, string>> = {
  vary_subtle: `${VARY} · Subtle`,
  vary_strong: `${VARY} · Strong`,
  upscale_subtle: `${UPSCALE} · Subtle`,
  upscale_creative: `${UPSCALE} · Creative`,
  upscale_detail: `${UPSCALE} · Detail`,
  remix_subtle: `${REMIX} · Subtle`,
  remix_strong: `${REMIX} · Strong`,
  pan_up: `${EXPAND} · Pan up`,
  pan_down: `${EXPAND} · Pan down`,
  pan_left: `${EXPAND} · Pan left`,
  pan_right: `${EXPAND} · Pan right`,
  zoom_1_5x: `${EXPAND} · Zoom out 1.5×`,
  zoom_2x: `${EXPAND} · Zoom out 2×`,
  zoom_out_1_5x: `${EXPAND} · Zoom out 1.5×`,
  zoom_out_2x: `${EXPAND} · Zoom out 2×`,
  animate_low: `${ANIMATE} · Low motion`,
  animate_high: `${ANIMATE} · High motion`,
  adetailer: FACE_ENHANCER,
  adetailer_auto: `${FACE_ENHANCER} · Auto`,
  realism_lite: `${REALISM} · Lite`,
  realism_pro: `${REALISM} · Pro+`,
};

/** Actions that are just "the prompt again" — not tool output. */
const PROMPT_ACTIONS: ReadonlySet<string> = new Set(["rerun"]);

const REGISTRY_ACTIONS = (
  registry as { actions: Record<string, { name?: string; template?: string }> }
).actions;

const EDIT_TOOL_LABELS: ReadonlyMap<string, string> = new Map(
  (
    editToolRegistry as { tools: Array<{ id: string; label: string }> }
  ).tools.map((t) => [t.id, t.label]),
);

/** Canonical Tools-page name of an action card (spec title if unmapped). */
const specTitle = (spec: { id: string; title: string }): string =>
  toolTitle(`action:${spec.id}`, spec.title);

const TOOLS_PAGE_TITLES: ReadonlyMap<string, string> = new Map(
  ACTION_TOOLS.map((spec) => [spec.id as string, specTitle(spec)]),
);

/** Action id → Tools page title (the card id, or the action it model-checks). */
const ACTION_TO_TOOL_TITLE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const spec of ACTION_TOOLS) {
    if (!map.has(spec.id)) map.set(spec.id, specTitle(spec));
    const checked = spec.modelCheck?.action;
    if (checked && !map.has(checked)) map.set(checked, specTitle(spec));
  }
  return map;
})();

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** Human label for an /api/jobs/action action id (null = not tool output). */
export function actionLabel(id: string, via?: string): string | null {
  if (!id || PROMPT_ACTIONS.has(id)) return null;
  const variant = ACTION_VARIANT_LABELS[id];
  if (variant) return variant;
  const viaTitle = via ? TOOLS_PAGE_TITLES.get(via) : undefined;
  if (viaTitle) return viaTitle;
  const direct = ACTION_TO_TOOL_TITLE.get(id);
  if (direct) return direct;
  const fast = id.endsWith("_fast") ? id.slice(0, -"_fast".length) : null;
  if (fast) {
    const base = ACTION_TO_TOOL_TITLE.get(fast) ?? REGISTRY_ACTIONS[fast]?.name;
    if (base) return `${base} · Fast`;
  }
  return REGISTRY_ACTIONS[id]?.name ?? humanize(id);
}

/**
 * Human label for an /api/jobs/tool edit-tool id: the canonical Tools-page
 * name (outpaint backends → "Expand"), so runs stamped with an older label
 * still read and filter under today's name.
 */
export function toolLabel(id: string, stored?: string): string {
  return (
    catalogToolTitle(id) ?? EDIT_TOOL_LABELS.get(id) ?? stored ?? humanize(id)
  );
}

/** Legacy runs: map an absolute/saved workflow path back to an action id. */
function actionIdFromWorkflowPath(workflowPath: string): string | null {
  const base = workflowPath
    .split(/[\\/:]/)
    .pop()
    ?.replace(/(\.video)?\.json$/i, "");
  if (!base) return null;
  if (REGISTRY_ACTIONS[base]) return base;
  const byTemplate = Object.entries(REGISTRY_ACTIONS).filter(
    ([, a]) => a.template === base,
  );
  return byTemplate.length === 1 ? byTemplate[0][0] : null;
}

function compute(params: Record<string, unknown>): RunProvenance | null {
  const sourceRunId = str(params.action_source_run_id);
  const withSource = (p: Omit<RunProvenance, "sourceRunId">): RunProvenance =>
    sourceRunId ? { ...p, sourceRunId } : p;

  const stamp = params[PROVENANCE_PARAM_KEY];
  if (stamp && typeof stamp === "object" && !Array.isArray(stamp)) {
    const s = stamp as Record<string, unknown>;
    const id = str(s.id);
    if (id && s.kind === "tool") {
      return withSource({
        kind: "tool",
        id,
        label: toolLabel(id, str(s.label)),
      });
    }
    if (id && s.kind === "action") {
      const label = actionLabel(id, str(s.via));
      return label ? withSource({ kind: "action", id, label }) : null;
    }
  }

  // Legacy (pre-stamp) rows: name the tool only when the keys pin it down.
  // The neutral "Edited" label needs evidence of an edit (the source-run
  // link both edit routes recorded); stray keys alone show nothing.
  const generic = (kind: RunProvenanceKind): RunProvenance | null =>
    sourceRunId
      ? { kind, id: "", label: GENERIC_EDIT_LABEL, sourceRunId }
      : null;
  const toolId = str(params.tool_id);
  const workflowPath = str(params.action_workflow_path);
  if (toolId && workflowPath) {
    // One of the two keys was inherited from the source run; which one is
    // unknowable from params alone.
    return generic("tool");
  }
  if (toolId) {
    return withSource({ kind: "tool", id: toolId, label: toolLabel(toolId) });
  }
  if (workflowPath) {
    const id = actionIdFromWorkflowPath(workflowPath);
    if (id && PROMPT_ACTIONS.has(id)) return null;
    const label = id ? actionLabel(id) : null;
    return label
      ? withSource({ kind: "action", id: id ?? "", label })
      : generic("action");
  }
  return null;
}

const cache = new WeakMap<object, RunProvenance | null>();

/**
 * Provenance for a run/gallery image's params map. Memoized per params object
 * (store objects are stable), so feed filtering + rendering stay cheap.
 */
export function runProvenance(
  params: Record<string, unknown> | null | undefined,
): RunProvenance | null {
  if (!params || typeof params !== "object") return null;
  if (cache.has(params)) return cache.get(params) ?? null;
  const result = compute(params);
  cache.set(params, result);
  return result;
}

/**
 * Run id the "from ↗" link should open for a run made by `provenance`, or
 * undefined (no source, or a self-reference). The source need not be loaded —
 * the feed fetches it by id on demand.
 */
export function sourceRunLinkTarget(
  provenance: RunProvenance | null | undefined,
  runId: string | undefined,
): string | undefined {
  const source = provenance?.sourceRunId;
  return source && source !== runId ? source : undefined;
}

// "Made with" feed filter

/** "all" | "prompts" | "tools" | "label:<chip label>". */
export type MadeWithFilter = "all" | "prompts" | "tools" | `label:${string}`;

export function madeWithLabelFilter(label: string): MadeWithFilter {
  return `label:${label}`;
}

/** Stored / untrusted value → a valid filter ("all" when unrecognised). */
export function parseMadeWithFilter(value: unknown): MadeWithFilter {
  if (value === "all" || value === "prompts" || value === "tools") return value;
  if (typeof value === "string" && value.startsWith("label:")) {
    const label = value.slice("label:".length).trim();
    if (label && label.length <= 120) return madeWithLabelFilter(label);
  }
  return "all";
}

export function matchesMadeWith(
  params: Record<string, unknown> | null | undefined,
  filter: MadeWithFilter,
): boolean {
  if (filter === "all") return true;
  const provenance = runProvenance(params);
  if (filter === "prompts") return provenance === null;
  if (filter === "tools") return provenance !== null;
  return provenance?.label === filter.slice("label:".length);
}

export interface MadeWithOption {
  label: string;
  /** Distinct runs carrying the label. */
  count: number;
}

/**
 * Tool labels present in the loaded feed, most-used first (ties A→Z).
 * Counts runs, not images: `items` may repeat a run (one entry per image).
 */
export function madeWithOptions(
  items: Iterable<{ runId?: string; paramsMap?: Record<string, unknown> }>,
): MadeWithOption[] {
  const runsByLabel = new Map<string, Set<string>>();
  let anon = 0;
  for (const item of items) {
    const provenance = runProvenance(item.paramsMap);
    if (!provenance) continue;
    let runs = runsByLabel.get(provenance.label);
    if (!runs) runsByLabel.set(provenance.label, (runs = new Set()));
    runs.add(item.runId ?? `#${anon++}`);
  }
  return [...runsByLabel.entries()]
    .map(([label, runs]) => ({ label, count: runs.size }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * `options` plus a zero-count entry for the active label filter when the
 * loaded feed has no run with that label (a remembered filter), so its chip
 * still shows as selected and can be turned off.
 */
export function withActiveMadeWithChoice(
  options: MadeWithOption[],
  active: MadeWithFilter,
): MadeWithOption[] {
  if (!active.startsWith("label:")) return options;
  const label = active.slice("label:".length);
  return options.some((o) => o.label === label)
    ? options
    : [...options, { label, count: 0 }];
}
