/**
 * Motion Designer scene spec + its strict validator.
 *
 * A MotionSpec is plain JSON: a theme, a background and 1-12 scenes, each a
 * list of animated elements positioned in normalized frame coordinates
 * (0..1, origin top-left). The same validator runs in two modes:
 *
 *   strict   (raw JSON editor) — any wrong type, unknown key, unknown enum or
 *            out-of-range number is an error and the edit is not applied.
 *   lenient  (LLM output, templates) — numbers are clamped, unknown keys and
 *            invalid elements are dropped with a warning, defaults fill gaps.
 *
 * Either way the returned spec is fully populated and safe to render.
 */

import { EASE_NAMES } from "./easing";

export const ASPECTS = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 864, height: 1080 },
} as const;
export type Aspect = keyof typeof ASPECTS;

export const FONTS = ["sans", "display", "serif", "mono", "hand"] as const;
export type FontId = (typeof FONTS)[number];

export const BACKGROUNDS = [
  "solid",
  "gradient",
  "aurora",
  "grid",
  "paper",
  "dots",
  "video",
] as const;
export type BackgroundKind = (typeof BACKGROUNDS)[number];

export const TRANSITIONS = [
  "cut",
  "fade",
  "slide-left",
  "slide-up",
  "push",
  "wipe",
  "zoom",
  "circle",
] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

export const TEXT_ANIMS = [
  "fade",
  "rise",
  "pop",
  "slide",
  "words",
  "letters",
  "typewriter",
  "mask",
  "write",
] as const;
export const SHAPE_KINDS = [
  "circle",
  "ring",
  "rect",
  "pill",
  "triangle",
  "line",
  "blob",
] as const;
export const SHAPE_ANIMS = [
  "pop",
  "draw",
  "fade",
  "spin",
  "float",
  "pulse",
] as const;
export const ICON_ANIMS = ["pop", "draw", "fade", "float"] as const;
export const OUT_ANIMS = ["none", "fade", "sink", "shrink", "slide"] as const;
export const POSES = [
  "stand",
  "wave",
  "point",
  "walk",
  "cheer",
  "think",
  "present",
] as const;
export const CHART_KINDS = ["bar", "line", "donut", "progress"] as const;
export const LIST_STYLES = ["check", "number", "dot"] as const;

/** Icon names drawn by icons.ts (kept here so the schema has no canvas deps). */
export const ICON_NAMES = [
  "check",
  "star",
  "heart",
  "bolt",
  "arrow",
  "bulb",
  "gear",
  "chart",
  "user",
  "clock",
  "globe",
  "rocket",
  "play",
  "lock",
  "chat",
  "leaf",
  "cloud",
  "target",
  "spark",
  "cube",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export interface MotionTheme {
  bg: string;
  bg2: string;
  fg: string;
  muted: string;
  accent: string;
  accent2: string;
  font: FontId;
}

interface ElementBase {
  /** Seconds from the scene start. */
  start: number;
  /** Seconds from the scene start; 0 = until the scene ends. */
  end: number;
  /** Anchor in normalized frame coords. */
  x: number;
  y: number;
  /** Entrance length (s). */
  inDur: number;
  ease: string;
  out: (typeof OUT_ANIMS)[number];
  /** Optional color override ("" = theme). */
  color: string;
}

export interface TextElement extends ElementBase {
  type: "text";
  /** `*word*` renders in the accent color. Newlines break lines. */
  text: string;
  /** Font size as a fraction of the frame height. */
  size: number;
  weight: number;
  align: "left" | "center" | "right";
  anim: (typeof TEXT_ANIMS)[number];
  /** Wrap width as a fraction of the frame width. */
  maxWidth: number;
  font: FontId | "";
}

export interface LowerThirdElement extends ElementBase {
  type: "lowerThird";
  title: string;
  subtitle: string;
  side: "left" | "right";
}

export interface ShapeElement extends ElementBase {
  type: "shape";
  shape: (typeof SHAPE_KINDS)[number];
  /** Fractions of the frame width / height. */
  w: number;
  h: number;
  fill: boolean;
  anim: (typeof SHAPE_ANIMS)[number];
  rotation: number;
  opacity: number;
}

export interface IconElement extends ElementBase {
  type: "icon";
  icon: IconName;
  size: number;
  anim: (typeof ICON_ANIMS)[number];
  badge: boolean;
}

export interface FigureElement extends ElementBase {
  type: "figure";
  pose: (typeof POSES)[number];
  /** Height as a fraction of the frame height. */
  size: number;
  facing: "left" | "right";
  say: string;
}

export interface ChartDatum {
  label: string;
  value: number;
}

export interface ChartElement extends ElementBase {
  type: "chart";
  chart: (typeof CHART_KINDS)[number];
  data: ChartDatum[];
  w: number;
  h: number;
  unit: string;
}

export interface CounterElement extends ElementBase {
  type: "counter";
  from: number;
  to: number;
  decimals: number;
  prefix: string;
  suffix: string;
  label: string;
  size: number;
}

export interface ListElement extends ElementBase {
  type: "list";
  items: string[];
  style: (typeof LIST_STYLES)[number];
  size: number;
  /** Seconds between items. */
  gap: number;
  maxWidth: number;
}

export interface ArrowElement extends ElementBase {
  type: "arrow";
  x2: number;
  y2: number;
  /** Bend as a fraction of the arrow length (-0.5..0.5). */
  curve: number;
}

export type MotionElement =
  | TextElement
  | LowerThirdElement
  | ShapeElement
  | IconElement
  | FigureElement
  | ChartElement
  | CounterElement
  | ListElement
  | ArrowElement;

export type ElementType = MotionElement["type"];

export interface MotionScene {
  duration: number;
  background: BackgroundKind | "";
  transition: TransitionType;
  transitionDur: number;
  /** Spoken line for the optional voiceover. */
  narration: string;
  elements: MotionElement[];
}

export interface MotionSpec {
  version: 1;
  title: string;
  aspect: Aspect;
  fps: 24 | 30 | 60;
  theme: MotionTheme;
  background: BackgroundKind;
  scenes: MotionScene[];
}

export const LIMITS = {
  scenes: 12,
  elements: 16,
  sceneSeconds: { min: 0.5, max: 20 },
  totalSeconds: 120,
  text: 240,
  listItems: 6,
  chartData: 8,
} as const;

// Mini schema DSL

export type Field =
  | { t: "num"; min: number; max: number; def?: number; int?: boolean }
  | { t: "str"; max: number; def?: string }
  | { t: "enum"; values: readonly (string | number)[]; def?: string | number }
  | { t: "color"; def?: string; allowEmpty?: boolean }
  | { t: "bool"; def?: boolean }
  | { t: "strs"; max: number; min: number; itemMax: number }
  | { t: "obj"; schema: Schema; def?: Record<string, unknown> }
  | { t: "list"; schema: Schema; min: number; max: number };

export type Schema = Record<string, Field>;

export interface SpecIssue {
  path: string;
  message: string;
}

export type ValidateMode = "strict" | "lenient";

interface Ctx {
  mode: ValidateMode;
  errors: SpecIssue[];
  warnings: SpecIssue[];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Lenient fix-up or strict error, depending on the mode. */
function issue(ctx: Ctx, path: string, message: string, fixable: boolean) {
  if (ctx.mode === "strict" || !fixable) ctx.errors.push({ path, message });
  else ctx.warnings.push({ path, message });
}

const MISSING = Symbol("missing");

function checkField(
  f: Field,
  v: unknown,
  path: string,
  ctx: Ctx,
): unknown | typeof MISSING {
  const hasDef = "def" in f && f.def !== undefined;
  if (v === undefined || v === null) {
    if (hasDef) return structuredDefault(f);
    if (f.t === "obj") return checkObject(f.schema, {}, path, ctx);
    if (f.t === "strs") return [];
    if (f.t === "color" && f.allowEmpty) return "";
    issue(ctx, path, "is required", false);
    return MISSING;
  }
  switch (f.t) {
    case "num": {
      const nv: unknown =
        typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof nv !== "number" || !Number.isFinite(nv)) {
        issue(ctx, path, "must be a number", hasDef);
        return hasDef ? f.def : MISSING;
      }
      let n: number = nv;
      if (typeof v === "string")
        issue(ctx, path, "must be a number, not a string", true);
      if (f.int && !Number.isInteger(n)) {
        issue(ctx, path, "must be a whole number", true);
        n = Math.round(n);
      }
      if (n < f.min || n > f.max) {
        issue(ctx, path, `must be between ${f.min} and ${f.max}`, true);
        n = Math.min(f.max, Math.max(f.min, n));
      }
      return n;
    }
    case "str": {
      if (typeof v !== "string") {
        if (typeof v === "number") {
          issue(ctx, path, "must be text", true);
          return String(v);
        }
        issue(ctx, path, "must be text", hasDef);
        return hasDef ? f.def : MISSING;
      }
      // Control characters never reach the canvas (newlines are kept).
      const s = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
      if (s.length > f.max) {
        issue(ctx, path, `is longer than ${f.max} characters`, true);
        return s.slice(0, f.max);
      }
      return s;
    }
    case "enum": {
      if (f.values.includes(v as string | number)) return v;
      const lower =
        typeof v === "string"
          ? f.values.find(
              (x) =>
                typeof x === "string" && x.toLowerCase() === v.toLowerCase(),
            )
          : undefined;
      if (lower !== undefined) {
        issue(ctx, path, `must be one of ${f.values.join(", ")}`, true);
        return lower;
      }
      issue(ctx, path, `must be one of ${f.values.join(", ")}`, hasDef);
      return hasDef ? f.def : MISSING;
    }
    case "color": {
      if (typeof v === "string" && (HEX.test(v) || (f.allowEmpty && v === "")))
        return v.toLowerCase();
      issue(
        ctx,
        path,
        "must be a hex color like #ff8800",
        hasDef || !!f.allowEmpty,
      );
      return hasDef ? f.def : f.allowEmpty ? "" : MISSING;
    }
    case "bool": {
      if (typeof v === "boolean") return v;
      issue(ctx, path, "must be true or false", hasDef);
      return hasDef ? f.def : MISSING;
    }
    case "strs": {
      const arr = Array.isArray(v) ? v : null;
      if (!arr) {
        issue(ctx, path, "must be a list of text", false);
        return MISSING;
      }
      const out = arr
        .map((x, i) =>
          checkField({ t: "str", max: f.itemMax }, x, `${path}[${i}]`, ctx),
        )
        .filter((x): x is string => typeof x === "string" && x.trim() !== "");
      if (out.length > f.max) {
        issue(ctx, path, `has more than ${f.max} items`, true);
        out.length = f.max;
      }
      if (out.length < f.min) {
        issue(ctx, path, `needs at least ${f.min} item(s)`, false);
        return MISSING;
      }
      return out;
    }
    case "obj":
      if (typeof v !== "object" || Array.isArray(v)) {
        issue(ctx, path, "must be an object", false);
        return MISSING;
      }
      return checkObject(f.schema, v as Record<string, unknown>, path, ctx);
    case "list": {
      if (!Array.isArray(v)) {
        issue(ctx, path, "must be a list", false);
        return MISSING;
      }
      const out: Record<string, unknown>[] = [];
      v.forEach((item, i) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          issue(ctx, `${path}[${i}]`, "must be an object", false);
          return;
        }
        const r = checkObject(
          f.schema,
          item as Record<string, unknown>,
          `${path}[${i}]`,
          ctx,
        );
        if (r) out.push(r);
      });
      if (out.length > f.max) {
        issue(ctx, path, `has more than ${f.max} items`, true);
        out.length = f.max;
      }
      if (out.length < f.min) {
        issue(ctx, path, `needs at least ${f.min} item(s)`, false);
        return MISSING;
      }
      return out;
    }
  }
}

function structuredDefault(f: Field): unknown {
  const d = (f as { def?: unknown }).def;
  return d && typeof d === "object" ? JSON.parse(JSON.stringify(d)) : d;
}

/** Validate one object against a schema; null when a required field failed. */
function checkObject(
  schema: Schema,
  obj: Record<string, unknown>,
  path: string,
  ctx: Ctx,
  ignoreKeys: string[] = [],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let ok = true;
  for (const key of Object.keys(obj)) {
    if (!(key in schema) && !ignoreKeys.includes(key))
      issue(
        ctx,
        `${path}.${key}`.replace(/^\./, ""),
        "is not a known field",
        true,
      );
  }
  for (const [key, f] of Object.entries(schema)) {
    const r = checkField(f, obj[key], `${path}.${key}`.replace(/^\./, ""), ctx);
    if (r === MISSING) ok = false;
    else out[key] = r;
  }
  return ok ? out : null;
}

// Schemas

const BASE: Schema = {
  start: { t: "num", min: 0, max: 20, def: 0 },
  end: { t: "num", min: 0, max: 20, def: 0 },
  x: { t: "num", min: -0.5, max: 1.5, def: 0.5 },
  y: { t: "num", min: -0.5, max: 1.5, def: 0.5 },
  inDur: { t: "num", min: 0, max: 5, def: 0.7 },
  ease: { t: "enum", values: EASE_NAMES, def: "smooth" },
  out: { t: "enum", values: OUT_ANIMS, def: "none" },
  color: { t: "color", allowEmpty: true },
};

const FONT_OR_THEME = ["", ...FONTS] as const;

export const ELEMENT_SCHEMAS: Record<ElementType, Schema> = {
  text: {
    ...BASE,
    text: { t: "str", max: LIMITS.text },
    size: { t: "num", min: 0.015, max: 0.35, def: 0.08 },
    weight: {
      t: "enum",
      values: [300, 400, 500, 600, 700, 800, 900],
      def: 700,
    },
    align: { t: "enum", values: ["left", "center", "right"], def: "center" },
    anim: { t: "enum", values: TEXT_ANIMS, def: "rise" },
    maxWidth: { t: "num", min: 0.1, max: 1, def: 0.84 },
    font: { t: "enum", values: FONT_OR_THEME, def: "" },
  },
  lowerThird: {
    ...BASE,
    x: { t: "num", min: -0.5, max: 1.5, def: 0.06 },
    y: { t: "num", min: -0.5, max: 1.5, def: 0.8 },
    title: { t: "str", max: 80 },
    subtitle: { t: "str", max: 100, def: "" },
    side: { t: "enum", values: ["left", "right"], def: "left" },
  },
  shape: {
    ...BASE,
    shape: { t: "enum", values: SHAPE_KINDS, def: "circle" },
    w: { t: "num", min: 0.005, max: 2, def: 0.2 },
    h: { t: "num", min: 0.005, max: 2, def: 0.2 },
    fill: { t: "bool", def: true },
    anim: { t: "enum", values: SHAPE_ANIMS, def: "pop" },
    rotation: { t: "num", min: -360, max: 360, def: 0 },
    opacity: { t: "num", min: 0, max: 1, def: 1 },
  },
  icon: {
    ...BASE,
    icon: { t: "enum", values: ICON_NAMES, def: "spark" },
    size: { t: "num", min: 0.02, max: 0.6, def: 0.14 },
    anim: { t: "enum", values: ICON_ANIMS, def: "pop" },
    badge: { t: "bool", def: true },
  },
  figure: {
    ...BASE,
    y: { t: "num", min: -0.5, max: 1.5, def: 0.62 },
    pose: { t: "enum", values: POSES, def: "stand" },
    size: { t: "num", min: 0.1, max: 0.9, def: 0.42 },
    facing: { t: "enum", values: ["left", "right"], def: "right" },
    say: { t: "str", max: 80, def: "" },
  },
  chart: {
    ...BASE,
    chart: { t: "enum", values: CHART_KINDS, def: "bar" },
    data: {
      t: "list",
      min: 1,
      max: LIMITS.chartData,
      schema: {
        label: { t: "str", max: 24, def: "" },
        value: { t: "num", min: -1e9, max: 1e9 },
      },
    },
    w: { t: "num", min: 0.1, max: 1, def: 0.6 },
    h: { t: "num", min: 0.1, max: 1, def: 0.4 },
    unit: { t: "str", max: 8, def: "" },
  },
  counter: {
    ...BASE,
    from: { t: "num", min: -1e12, max: 1e12, def: 0 },
    to: { t: "num", min: -1e12, max: 1e12 },
    decimals: { t: "num", min: 0, max: 3, def: 0, int: true },
    prefix: { t: "str", max: 6, def: "" },
    suffix: { t: "str", max: 8, def: "" },
    label: { t: "str", max: 80, def: "" },
    size: { t: "num", min: 0.04, max: 0.4, def: 0.2 },
    inDur: { t: "num", min: 0, max: 8, def: 1.8 },
    ease: { t: "enum", values: EASE_NAMES, def: "outExpo" },
  },
  list: {
    ...BASE,
    x: { t: "num", min: -0.5, max: 1.5, def: 0.12 },
    y: { t: "num", min: -0.5, max: 1.5, def: 0.35 },
    items: { t: "strs", min: 1, max: LIMITS.listItems, itemMax: 90 },
    style: { t: "enum", values: LIST_STYLES, def: "check" },
    size: { t: "num", min: 0.02, max: 0.12, def: 0.05 },
    gap: { t: "num", min: 0, max: 4, def: 0.55 },
    maxWidth: { t: "num", min: 0.1, max: 1, def: 0.76 },
  },
  arrow: {
    ...BASE,
    x: { t: "num", min: -0.5, max: 1.5, def: 0.3 },
    x2: { t: "num", min: -0.5, max: 1.5, def: 0.7 },
    y2: { t: "num", min: -0.5, max: 1.5, def: 0.5 },
    curve: { t: "num", min: -0.5, max: 0.5, def: 0.2 },
  },
};

export const ELEMENT_TYPES = Object.keys(ELEMENT_SCHEMAS) as ElementType[];

const THEME_SCHEMA: Schema = {
  bg: { t: "color", def: "#0b0d17" },
  bg2: { t: "color", def: "#1c2140" },
  fg: { t: "color", def: "#f5f6fb" },
  muted: { t: "color", def: "#9aa0b8" },
  accent: { t: "color", def: "#7c5cff" },
  accent2: { t: "color", def: "#22d3ee" },
  font: { t: "enum", values: FONTS, def: "sans" },
};

const SCENE_SCHEMA: Schema = {
  duration: {
    t: "num",
    min: LIMITS.sceneSeconds.min,
    max: LIMITS.sceneSeconds.max,
    def: 4,
  },
  background: { t: "enum", values: ["", ...BACKGROUNDS], def: "" },
  transition: { t: "enum", values: TRANSITIONS, def: "fade" },
  transitionDur: { t: "num", min: 0, max: 2, def: 0.6 },
  narration: { t: "str", max: 300, def: "" },
};

const SPEC_SCHEMA: Schema = {
  version: { t: "enum", values: [1], def: 1 },
  title: { t: "str", max: 120, def: "Untitled" },
  aspect: { t: "enum", values: Object.keys(ASPECTS), def: "16:9" },
  fps: { t: "enum", values: [24, 30, 60], def: 30 },
  theme: { t: "obj", schema: THEME_SCHEMA },
  background: { t: "enum", values: BACKGROUNDS, def: "aurora" },
};

function checkElement(
  raw: unknown,
  path: string,
  ctx: Ctx,
): MotionElement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issue(ctx, path, "must be an object", true);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || !(type in ELEMENT_SCHEMAS)) {
    issue(
      ctx,
      `${path}.type`,
      `must be one of ${ELEMENT_TYPES.join(", ")}`,
      true,
    );
    return null;
  }
  // A failing element is dropped in lenient mode; strict keeps the errors.
  const sub: Ctx = { mode: ctx.mode, errors: [], warnings: [] };
  const r = checkObject(ELEMENT_SCHEMAS[type as ElementType], obj, path, sub, [
    "type",
  ]);
  ctx.warnings.push(...sub.warnings);
  if (!r || sub.errors.length) {
    if (ctx.mode === "strict") ctx.errors.push(...sub.errors);
    else
      ctx.warnings.push({
        path,
        message: `dropped: ${sub.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
      });
    return null;
  }
  const el = { type, ...r } as MotionElement;
  if (el.end > 0 && el.end <= el.start) {
    issue(ctx, `${path}.end`, "must be after start (or 0)", true);
    el.end = 0;
  }
  return el;
}

function checkScene(raw: unknown, path: string, ctx: Ctx): MotionScene | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issue(ctx, path, "must be an object", true);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const r = checkObject(SCENE_SCHEMA, obj, path, ctx, ["elements"]);
  if (!r) return null;
  const list = obj.elements;
  if (!Array.isArray(list)) {
    issue(ctx, `${path}.elements`, "must be a list", list === undefined);
  }
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > LIMITS.elements)
    issue(
      ctx,
      `${path}.elements`,
      `has more than ${LIMITS.elements} items`,
      true,
    );
  const elements = arr
    .slice(0, LIMITS.elements)
    .map((e, i) => checkElement(e, `${path}.elements[${i}]`, ctx))
    .filter((e): e is MotionElement => e !== null);
  return { ...(r as Omit<MotionScene, "elements">), elements };
}

export interface ValidateResult {
  ok: boolean;
  spec: MotionSpec | null;
  errors: SpecIssue[];
  warnings: SpecIssue[];
}

/** Validate (strict) or repair (lenient) an unknown value into a MotionSpec. */
export function validateSpec(
  raw: unknown,
  mode: ValidateMode = "strict",
): ValidateResult {
  const ctx: Ctx = { mode, errors: [], warnings: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      spec: null,
      errors: [{ path: "", message: "must be a JSON object" }],
      warnings: [],
    };
  }
  const obj = raw as Record<string, unknown>;
  const head = checkObject(SPEC_SCHEMA, obj, "", ctx, ["scenes"]);
  const rawScenes = obj.scenes;
  let scenes: MotionScene[] = [];
  if (!Array.isArray(rawScenes)) {
    ctx.errors.push({ path: "scenes", message: "must be a list" });
  } else {
    if (rawScenes.length > LIMITS.scenes)
      issue(ctx, "scenes", `has more than ${LIMITS.scenes} scenes`, true);
    scenes = rawScenes
      .slice(0, LIMITS.scenes)
      .map((s, i) => checkScene(s, `scenes[${i}]`, ctx))
      .filter((s): s is MotionScene => s !== null);
    if (!scenes.length)
      ctx.errors.push({ path: "scenes", message: "needs at least 1 scene" });
  }
  // Total length cap: trim trailing scenes.
  let total = 0;
  const kept: MotionScene[] = [];
  for (const s of scenes) {
    if (total + s.duration > LIMITS.totalSeconds + 1e-9) {
      issue(ctx, "scenes", `run longer than ${LIMITS.totalSeconds}s`, true);
      break;
    }
    total += s.duration;
    kept.push(s);
  }
  const ok = ctx.errors.length === 0 && !!head && kept.length > 0;
  return {
    ok,
    spec: ok ? ({ ...(head as object), scenes: kept } as MotionSpec) : null,
    errors: ctx.errors,
    warnings: ctx.warnings,
  };
}

/** Parse JSON text (raw editor). */
export function parseSpecText(
  text: string,
  mode: ValidateMode = "strict",
): ValidateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      spec: null,
      errors: [
        {
          path: "",
          message: `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`,
        },
      ],
      warnings: [],
    };
  }
  return validateSpec(raw, mode);
}

/** Fill every default of one element type (form editor "add element"). */
export function defaultElement<T extends ElementType>(
  type: T,
  overrides: Record<string, unknown> = {},
): Extract<MotionElement, { type: T }> {
  const required: Record<ElementType, Record<string, unknown>> = {
    text: { text: "New *headline*" },
    lowerThird: { title: "Your Name", subtitle: "Title" },
    shape: {},
    icon: {},
    figure: {},
    chart: {
      data: [
        { label: "A", value: 3 },
        { label: "B", value: 5 },
        { label: "C", value: 8 },
      ],
    },
    counter: { to: 100 },
    list: { items: ["First point", "Second point"] },
    arrow: {},
  };
  const ctx: Ctx = { mode: "lenient", errors: [], warnings: [] };
  const el = checkElement(
    { type, ...required[type], ...overrides },
    "element",
    ctx,
  );
  if (!el) throw new Error(`defaultElement(${type}) failed`);
  return el as Extract<MotionElement, { type: T }>;
}
