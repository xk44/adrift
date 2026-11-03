/**
 * Scene: aspect, size, seed, length and style shared by every Tools card,
 * so chaining tools doesn't mean re-entering the same settings. Cards fill
 * matching fields from it (sceneFill) unless the user changed that field on
 * the card; the store lives in src/store/sceneStore.ts.
 *
 * Pure: no React, no storage.
 */

import {
  OUTPAINT_ASPECTS,
  type ActionChoice,
  type ActionToolSpec,
  type CatalogTool,
  type ToolSettings,
} from "./toolsPage";

export interface Scene {
  /** Off: cards keep their own defaults. */
  apply: boolean;
  /** "16:9" etc.; null = no preference. */
  aspect: string | null;
  /** Target long edge in px; null = no preference. */
  longEdge: number | null;
  seed: number | null;
  /** Only a locked seed is shared; unlocked, tools keep a random seed. */
  seedLocked: boolean;
  /** Video length in seconds; null = no preference. */
  duration: number | null;
  /** Fills style / look prompts that are still empty. */
  style: string;
}

export const DEFAULT_SCENE: Scene = {
  apply: true,
  aspect: null,
  longEdge: null,
  seed: null,
  seedLocked: false,
  duration: null,
  style: "",
};

export const SCENE_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5"];
export const SCENE_LONG_EDGES = [640, 768, 1024, 1280, 1536, 1920];
export const SCENE_DURATIONS = [2, 3, 5, 8, 10];
export const SCENE_SEED_MAX = 2147483647;
const STYLE_MAX = 500;

/** A stored scene with every field validated (bad fields fall back). */
export function sanitizeScene(raw: unknown): Scene {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const num = (x: unknown, min: number, max: number): number | null =>
    typeof x === "number" && Number.isFinite(x) && x >= min && x <= max
      ? x
      : null;
  const seed = num(v.seed, 0, SCENE_SEED_MAX);
  return {
    apply: typeof v.apply === "boolean" ? v.apply : DEFAULT_SCENE.apply,
    aspect:
      typeof v.aspect === "string" && SCENE_ASPECTS.includes(v.aspect)
        ? v.aspect
        : null,
    longEdge: num(v.longEdge, 64, 8192),
    seed: seed === null ? null : Math.trunc(seed),
    seedLocked: v.seedLocked === true,
    duration: num(v.duration, 1, 600),
    style: typeof v.style === "string" ? v.style.slice(0, STYLE_MAX) : "",
  };
}

/** Whether any field would fill a card. */
export function sceneIsSet(s: Scene): boolean {
  return (
    s.aspect !== null ||
    s.longEdge !== null ||
    (s.seedLocked && s.seed !== null) ||
    s.duration !== null ||
    s.style.trim() !== ""
  );
}

/** Short summary for the header chip ("16:9 · 1024 px · 5 s"). */
export function sceneSummary(s: Scene): string {
  const parts: string[] = [];
  if (s.aspect) parts.push(s.aspect);
  if (s.longEdge) parts.push(`${s.longEdge} px`);
  if (s.duration) parts.push(`${s.duration} s`);
  if (s.seedLocked && s.seed !== null) parts.push(`seed ${s.seed}`);
  if (s.style.trim()) parts.push("style");
  return parts.join(" · ");
}

/**
 * Card field id → value. Ids: "picks.<key>" for pickers, else a
 * ToolSettings key ("seed", "text", "outpaintAspect").
 */
export type SceneFill = Record<string, string | number>;

/** Text knobs that take a style or look (filled while empty). */
const STYLE_TEXT_LABELS = new Set(["style", "new look", "final look"]);

/** Long edge in px an option stands for: "720p" (16:9) or "1024 px". */
export function optionLongEdge(o: ActionChoice): number | null {
  const p = /^(\d+)p\b/.exec(o.label);
  if (p) return Math.round((Number(p[1]) * 16) / 9);
  const px = /^(\d+)\s*px\b/.exec(o.label);
  return px ? Number(px[1]) : null;
}

/** Seconds an option stands for: "5 s", "1 min"; null for "Long clip". */
export function optionSeconds(o: ActionChoice): number | null {
  const s = /^(\d+(?:\.\d+)?)\s*s\b/.exec(o.label);
  if (s) return Number(s[1]);
  const m = /^(\d+(?:\.\d+)?)\s*min\b/.exec(o.label);
  return m ? Number(m[1]) * 60 : null;
}

/** Smallest option at or above `target`, else the largest. */
function atLeast(
  options: readonly ActionChoice[],
  measure: (o: ActionChoice) => number | null,
  target: number,
): string | null {
  let up: { id: string; n: number } | null = null;
  let top: { id: string; n: number } | null = null;
  for (const o of options) {
    if (o.disabled) continue;
    const n = measure(o);
    if (!n) continue;
    if (n >= target && (!up || n < up.n)) up = { id: o.id, n };
    if (!top || n > top.n) top = { id: o.id, n };
  }
  return (up ?? top)?.id ?? null;
}

/** Option closest to `target` (ratio distance); ties keep the earlier one. */
function nearest(
  options: readonly ActionChoice[],
  measure: (o: ActionChoice) => number | null,
  target: number,
): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    if (o.disabled) continue;
    const n = measure(o);
    if (!n || n <= 0) continue;
    const d = Math.abs(Math.log(n / target));
    if (d < bestD - 1e-9) {
      best = o.id;
      bestD = d;
    }
  }
  return best;
}

/** Which of a card's fields the scene fills, and with what. */
export function sceneFill(
  tool: CatalogTool | ActionToolSpec | null | undefined,
  scene: Scene,
): SceneFill {
  const out: SceneFill = {};
  if (!tool || !scene.apply) return out;
  const seed = scene.seedLocked && scene.seed !== null ? scene.seed : null;

  if ("loras" in tool) {
    if (seed !== null) out.seed = seed;
    if (
      tool.outpaint &&
      scene.aspect &&
      OUTPAINT_ASPECTS.includes(scene.aspect)
    )
      out.outpaintAspect = scene.aspect;
    return out;
  }

  if (seed !== null && tool.seedInput) out.seed = seed;
  // Audio cards share "Length" / "Style" names with a different meaning.
  const audio = tool.category === "Audio";
  for (const p of tool.pickers ?? []) {
    let id: string | null = null;
    if (p.key === "aspect" && scene.aspect) {
      id = p.options.some((o) => o.id === scene.aspect && !o.disabled)
        ? scene.aspect
        : null;
    } else if ((p.key === "resolution" || p.key === "res") && scene.longEdge) {
      id = atLeast(p.options, optionLongEdge, scene.longEdge);
    } else if (p.key === "duration" && !audio && scene.duration) {
      id = nearest(p.options, optionSeconds, scene.duration);
    }
    if (id !== null) out[`picks.${p.key}`] = id;
  }
  const label = tool.text?.label
    .replace(/\s*\(optional\)\s*$/i, "")
    .toLowerCase();
  if (!audio && label && STYLE_TEXT_LABELS.has(label) && scene.style.trim())
    out.text = scene.style.trim();
  return out;
}

type FieldValue = string | number | undefined;

export function getField(s: ToolSettings, id: string): FieldValue {
  if (id.startsWith("picks.")) return s.picks[id.slice(6)];
  return (s as unknown as Record<string, FieldValue>)[id];
}

function setField(
  s: ToolSettings,
  id: string,
  value: FieldValue,
): ToolSettings {
  if (id.startsWith("picks.")) {
    const picks = { ...s.picks };
    const key = id.slice(6);
    if (value === undefined) delete picks[key];
    else picks[key] = String(value);
    return { ...s, picks };
  }
  return { ...s, [id]: value };
}

/** Field ids a settings patch writes (for "edited on this card"). */
export function patchedFields(p: Partial<ToolSettings>): string[] {
  return Object.keys(p).filter((k) => k !== "picks");
}

/**
 * Move a card from the `prev` scene fill to `next`. A field changes only
 * while the scene still owns it: not edited on the card and still holding
 * the previous scene value (or the card default). Fields the scene no
 * longer fills go back to the card default.
 */
export function applySceneFill(
  settings: ToolSettings,
  base: ToolSettings,
  prev: SceneFill,
  next: SceneFill,
  touched: ReadonlySet<string>,
): ToolSettings {
  let out = settings;
  const ids = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const id of ids) {
    if (touched.has(id)) continue;
    const owned = id in prev ? prev[id] : getField(base, id);
    const cur = getField(out, id);
    if (cur !== owned && !(id in prev && cur === getField(base, id))) continue;
    const want = id in next ? next[id] : getField(base, id);
    if (cur !== want) out = setField(out, id, want);
  }
  return out;
}

/** Field ids whose current value came from the scene. */
export function sceneSourced(
  settings: ToolSettings,
  fill: SceneFill,
  touched: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const [id, v] of Object.entries(fill))
    if (!touched.has(id) && getField(settings, id) === v) out.add(id);
  return out;
}
