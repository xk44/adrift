/**
 * "Made with" chip → Tools page: which card made a run, and which of its
 * settings can be put back.
 *
 * Card keys are the Tools page's ("action:<id>", "catalog:<id>"). The
 * lightbox-only operations (Vary, Remix, Realism) have no card, so their
 * chip stays a plain label. Pure (no React, no store).
 */

import editToolRegistry from "./editToolRegistry.json";
import { ACTION_TOOLS, type ToolSettings } from "./toolsPage";
import { catalogNameKey, EXPAND_KEY } from "./toolNames";
import { PROVENANCE_PARAM_KEY, type RunProvenance } from "@/lib/runProvenance";

/** Settings a "Made with" link restores when the card opens. */
export type ToolPrefillSettings = Partial<
  Pick<
    ToolSettings,
    "text" | "picks" | "fast" | "keepFraming" | "steps" | "cfg"
  >
>;

interface RegistryOption {
  id: string;
  type?: string;
  values?: Array<{ id: string }>;
}
interface RegistryTool {
  id: string;
  label: string;
  promptMode?: string;
  promptTemplate?: string;
  speed?: { supported?: boolean };
  extras?: { keepFraming?: unknown };
  options?: RegistryOption[];
}

const CATALOG: ReadonlyMap<string, RegistryTool> = new Map(
  (editToolRegistry as { tools: RegistryTool[] }).tools.map((t) => [t.id, t]),
);

const ACTION_CARD_IDS: ReadonlySet<string> = new Set(
  ACTION_TOOLS.map((s) => s.id as string),
);

/** Action id → card id, for actions a card queues under another id. */
const CHECKED_ACTION_CARD: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const spec of ACTION_TOOLS) {
    const checked = spec.modelCheck?.action;
    if (checked && !map.has(checked)) map.set(checked, spec.id);
  }
  return map;
})();

/** Lightbox action variants that belong to a Tools page card. */
function variantCard(id: string): string | null {
  if (/^(pan|zoom)_/.test(id)) return EXPAND_KEY;
  if (id.startsWith("upscale_")) return "action:upscale";
  if (id.startsWith("animate_")) return "action:animate";
  if (id === "adetailer" || id.startsWith("adetailer_"))
    return "action:enhance_faces";
  return null;
}

function actionCard(id: string): string | null {
  if (ACTION_CARD_IDS.has(id)) return `action:${id}`;
  const checked = CHECKED_ACTION_CARD.get(id);
  if (checked) return `action:${checked}`;
  return variantCard(id);
}

function stampVia(params: Record<string, unknown> | null | undefined) {
  const stamp = params?.[PROVENANCE_PARAM_KEY];
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return;
  const via = (stamp as Record<string, unknown>).via;
  return typeof via === "string" && via ? via : undefined;
}

/**
 * Tools page card key for the tool that made a run, or null when no card
 * made it (lightbox-only actions, legacy "Edited" rows).
 */
export function provenanceToolKey(
  provenance: RunProvenance | null | undefined,
  params?: Record<string, unknown> | null,
): string | null {
  if (!provenance?.id) return null;
  if (provenance.kind === "tool") {
    return CATALOG.has(provenance.id) ? catalogNameKey(provenance.id) : null;
  }
  const via = stampVia(params);
  if (via && ACTION_CARD_IDS.has(via)) return `action:${via}`;
  const direct = actionCard(provenance.id);
  if (direct) return direct;
  if (provenance.id.endsWith("_fast")) {
    return actionCard(provenance.id.slice(0, -"_fast".length));
  }
  return null;
}

/** Tools page URL that opens `key` (the page's `?tool=` deep link). */
export function toolPageHref(key: string): string {
  return `/tools?tool=${encodeURIComponent(key)}`;
}

/**
 * Settings to restore for a catalog tool run: enum choices, speed, framing,
 * steps / cfg from `tool_options`, and the prompt when the tool sends it
 * as typed (template "{prompt}"). Values the tool no longer offers are
 * dropped. Empty object when there is nothing to restore; action runs
 * store their inputs in action-specific params, so they open with defaults.
 */
export function provenancePrefill(
  provenance: RunProvenance | null | undefined,
  params: Record<string, unknown> | null | undefined,
  prompt?: string,
): ToolPrefillSettings {
  if (provenance?.kind !== "tool" || !params) return {};
  const tool = CATALOG.get(provenance.id);
  // Outpaint backends fold into the Expand card, whose settings differ.
  if (!tool || catalogNameKey(tool.id) === EXPAND_KEY) return {};
  const out: ToolPrefillSettings = {};
  const raw = params.tool_options;
  const opts =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const picks: Record<string, string> = {};
  for (const opt of tool.options ?? []) {
    const v = opts[opt.id];
    if (typeof v !== "string") continue;
    if (opt.values && !opt.values.some((x) => x.id === v)) continue;
    picks[opt.id] = v;
  }
  if (Object.keys(picks).length) out.picks = picks;
  if (tool.speed?.supported && typeof opts.fast === "boolean")
    out.fast = opts.fast;
  if (tool.extras?.keepFraming && typeof opts.keepFraming === "boolean")
    out.keepFraming = opts.keepFraming;
  if (typeof opts.steps === "number" && Number.isFinite(opts.steps))
    out.steps = opts.steps;
  if (typeof opts.cfg === "number" && Number.isFinite(opts.cfg))
    out.cfg = opts.cfg;
  const text = prompt?.trim();
  if (
    text &&
    tool.promptMode !== "none" &&
    tool.promptTemplate === "{prompt}" &&
    text !== tool.label
  ) {
    out.text = text;
  }
  return out;
}
