/**
 * Motion Designer themes, the scene "outline" an LLM (or a template) writes,
 * and the deterministic layout compiler that turns an outline into a full
 * MotionSpec with good-looking positions for any aspect ratio.
 *
 * Splitting content (outline) from layout (compiler) keeps small local LLMs
 * reliable: they only choose a layout per scene and write the words; every
 * coordinate, size and timing below is hand-tuned.
 */

import {
  ASPECTS,
  ICON_NAMES,
  LIMITS,
  defaultElement,
  validateSpec,
  type Aspect,
  type BackgroundKind,
  type ChartDatum,
  type IconName,
  type MotionElement,
  type MotionScene,
  type MotionSpec,
  type MotionTheme,
  type TransitionType,
} from "./spec";

// Themes

export interface ThemePreset {
  id: string;
  label: string;
  theme: MotionTheme;
  background: BackgroundKind;
}

export const THEMES: ThemePreset[] = [
  {
    id: "midnight",
    label: "Midnight",
    background: "aurora",
    theme: {
      bg: "#0b0d17",
      bg2: "#241d5c",
      fg: "#f5f6fb",
      muted: "#9aa0b8",
      accent: "#8b6cff",
      accent2: "#22d3ee",
      font: "sans",
    },
  },
  {
    id: "sunset",
    label: "Sunset",
    background: "aurora",
    theme: {
      bg: "#1a0f1f",
      bg2: "#5a1f3d",
      fg: "#fff7f0",
      muted: "#d9b8b0",
      accent: "#ff7a45",
      accent2: "#ffd166",
      font: "display",
    },
  },
  {
    id: "mint",
    label: "Mint",
    background: "gradient",
    theme: {
      bg: "#f2fbf7",
      bg2: "#cdeee0",
      fg: "#0f2a22",
      muted: "#4f6f64",
      accent: "#0f9f6e",
      accent2: "#0284c7",
      font: "sans",
    },
  },
  {
    id: "paper",
    label: "Whiteboard",
    background: "paper",
    theme: {
      bg: "#fbfaf6",
      bg2: "#ece8dc",
      fg: "#1f2933",
      muted: "#5f6b7a",
      accent: "#2563eb",
      accent2: "#e11d48",
      font: "hand",
    },
  },
  {
    id: "noir",
    label: "Noir",
    background: "grid",
    theme: {
      bg: "#0a0a0a",
      bg2: "#1c1c1c",
      fg: "#fafafa",
      muted: "#a3a3a3",
      accent: "#facc15",
      accent2: "#f97316",
      font: "display",
    },
  },
  {
    id: "neon",
    label: "Neon",
    background: "dots",
    theme: {
      bg: "#06020f",
      bg2: "#1a0b45",
      fg: "#ffffff",
      muted: "#aaa4cc",
      accent: "#ff2bd6",
      accent2: "#00e5ff",
      font: "display",
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    background: "gradient",
    theme: {
      bg: "#03202f",
      bg2: "#0b5372",
      fg: "#effaff",
      muted: "#9cc3d5",
      accent: "#38bdf8",
      accent2: "#a3e635",
      font: "sans",
    },
  },
];

export function themeById(id: string | undefined): ThemePreset {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// Outline

export const LAYOUTS = [
  "title",
  "statement",
  "bullets",
  "steps",
  "stat",
  "chart",
  "quote",
  "callouts",
  "figure",
  "lowerthird",
  "outro",
] as const;
export type Layout = (typeof LAYOUTS)[number];

export interface OutlineScene {
  layout: Layout;
  heading: string;
  body: string;
  items: string[];
  value: number | null;
  unit: string;
  icon: IconName | "";
  narration: string;
  data: ChartDatum[];
  seconds: number | null;
}

export interface Outline {
  title: string;
  scenes: OutlineScene[];
}

export interface CompileOptions {
  aspect: Aspect;
  theme: string;
  /** Override the theme's background (e.g. "video" for lower thirds). */
  background?: BackgroundKind;
  fps?: 24 | 30 | 60;
  /** Pace multiplier for scene lengths (0.6..1.6). */
  pace?: number;
}

const ICON_WORDS: [RegExp, IconName][] = [
  [/fast|speed|quick|energy|power|instant/i, "bolt"],
  [/idea|learn|tip|insight|think/i, "bulb"],
  [/secur|privacy|safe|protect|lock/i, "lock"],
  [/grow|chart|data|metric|revenue|stat|result/i, "chart"],
  [/time|minute|hour|schedule|clock/i, "clock"],
  [/world|global|everywhere|countr/i, "globe"],
  [/launch|start|ship|rocket|boost/i, "rocket"],
  [/love|care|health|heart/i, "heart"],
  [/team|people|user|customer|you\b/i, "user"],
  [/setting|config|tool|build|engine|process/i, "gear"],
  [/talk|chat|message|support|ask/i, "chat"],
  [/green|nature|eco|plant|sustain/i, "leaf"],
  [/cloud|online|sync/i, "cloud"],
  [/goal|target|focus|aim/i, "target"],
  [/quality|best|star|award|top/i, "star"],
  [/video|play|watch/i, "play"],
  [/done|check|complete|easy|ready/i, "check"],
  [/box|product|package|3d|cube/i, "cube"],
];

/** Pick an icon for a line of text (keyword match, else rotate). */
export function iconFor(text: string, fallbackIndex = 0): IconName {
  for (const [re, icon] of ICON_WORDS) if (re.test(text)) return icon;
  const rot: IconName[] = [
    "spark",
    "bulb",
    "target",
    "rocket",
    "star",
    "check",
  ];
  return rot[Math.abs(fallbackIndex) % rot.length];
}

function clean(v: unknown, max: number): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const LAYOUT_ALIASES: Record<string, Layout> = {
  intro: "title",
  hook: "statement",
  kinetic: "statement",
  headline: "statement",
  list: "bullets",
  points: "bullets",
  features: "callouts",
  feature: "callouts",
  process: "steps",
  howto: "steps",
  whiteboard: "steps",
  number: "stat",
  metric: "stat",
  graph: "chart",
  testimonial: "quote",
  character: "figure",
  stickman: "figure",
  presenter: "figure",
  name: "lowerthird",
  "lower-third": "lowerthird",
  lower_third: "lowerthird",
  cta: "outro",
  end: "outro",
  ending: "outro",
};

/** Coerce anything outline-shaped (LLM output) into a valid Outline. */
export function normalizeOutline(raw: unknown, fallbackTitle = ""): Outline {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const list = Array.isArray(obj.scenes) ? obj.scenes : [];
  const scenes: OutlineScene[] = [];
  for (const item of list.slice(0, LIMITS.scenes)) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const lay = clean(s.layout ?? s.type, 20).toLowerCase();
    const layout: Layout = (LAYOUTS as readonly string[]).includes(lay)
      ? (lay as Layout)
      : (LAYOUT_ALIASES[lay] ?? "statement");
    const items = (
      Array.isArray(s.items) ? s.items : Array.isArray(s.points) ? s.points : []
    )
      .map((x) => clean(x, 90))
      .filter(Boolean)
      .slice(0, LIMITS.listItems);
    const data = (Array.isArray(s.data) ? s.data : [])
      .map((d) => {
        if (!d || typeof d !== "object") return null;
        const r = d as Record<string, unknown>;
        const value = Number(r.value);
        return Number.isFinite(value)
          ? { label: clean(r.label, 24), value }
          : null;
      })
      .filter((d): d is ChartDatum => d !== null)
      .slice(0, LIMITS.chartData);
    const numeric = Number(
      typeof s.value === "string" ? s.value.replace(/[^0-9.\-]/g, "") : s.value,
    );
    const icon = clean(s.icon, 12).toLowerCase();
    const seconds = Number(s.seconds ?? s.duration);
    const heading = clean(s.heading ?? s.title ?? s.text, 120);
    const body = clean(s.body ?? s.subtitle ?? s.caption, 160);
    if (!heading && !body && !items.length && !data.length) continue;
    scenes.push({
      layout,
      heading,
      body,
      items,
      value:
        Number.isFinite(numeric) && s.value !== "" && s.value != null
          ? numeric
          : null,
      unit: clean(s.unit ?? s.suffix, 8),
      icon: (ICON_NAMES as readonly string[]).includes(icon)
        ? (icon as IconName)
        : "",
      narration: clean(s.narration ?? s.voiceover, 300),
      data,
      seconds:
        Number.isFinite(seconds) && seconds > 0
          ? Math.min(LIMITS.sceneSeconds.max, Math.max(1.5, seconds))
          : null,
    });
  }
  return {
    title: clean(obj.title, 120) || clean(fallbackTitle, 120) || "Untitled",
    scenes,
  };
}

// Layout compiler

interface Frame {
  aspect: Aspect;
  portrait: boolean;
  /** Text-size multiplier for the aspect (sizes are fractions of height). */
  u: number;
  hand: boolean;
}

function frameFor(aspect: Aspect, hand: boolean): Frame {
  const { width, height } = ASPECTS[aspect];
  const r = width / height;
  return {
    aspect,
    portrait: r < 0.9,
    u: r >= 1.5 ? 1 : r >= 0.95 ? 0.82 : r >= 0.75 ? 0.74 : 0.56,
    hand,
  };
}

type El = MotionElement;
const text = (o: Record<string, unknown>) => defaultElement("text", o);

/** Rough reading time: ~3 words/s plus entrance time, clamped. */
export function readSeconds(words: string, base = 1.6): number {
  const n = words.split(/\s+/).filter(Boolean).length;
  return Math.min(10, Math.max(2.8, base + n / 3));
}

/** Emphasise the most important word when the writer marked none. */
export function autoEmphasis(line: string): string {
  if (!line || /\*[^*]+\*/.test(line)) return line;
  const words = line.split(" ");
  if (words.length < 3) return line;
  // Longest word wins (ties: the later one), skipping filler.
  let best = -1;
  words.forEach((w, i) => {
    const bare = w.replace(/[^\p{L}\p{N}]/gu, "");
    if (bare.length < 4) return;
    if (
      best < 0 ||
      bare.length >= words[best].replace(/[^\p{L}\p{N}]/gu, "").length
    )
      best = i;
  });
  if (best < 0) return line;
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(words[best]);
  if (!m || !m[2]) return line;
  words[best] = `${m[1]}*${m[2]}*${m[3]}`;
  return words.join(" ");
}

function headingEl(
  f: Frame,
  s: OutlineScene,
  y: number,
  opts: Record<string, unknown> = {},
) {
  return text({
    text: s.heading,
    y,
    size: 0.085 * f.u,
    weight: 800,
    anim: f.hand ? "write" : "words",
    inDur: f.hand ? 1.4 : 0.9,
    ...opts,
  });
}

function compileScene(
  s: OutlineScene,
  i: number,
  f: Frame,
): {
  elements: El[];
  seconds: number;
  background?: BackgroundKind;
} {
  const P = f.portrait;
  const u = f.u;
  const icon = s.icon || iconFor(`${s.heading} ${s.body}`, i);
  switch (s.layout) {
    case "title": {
      const els: El[] = [
        defaultElement("shape", {
          shape: "ring",
          w: P ? 0.95 : 0.5,
          h: P ? 0.95 : 0.5,
          fill: false,
          anim: "draw",
          inDur: 1.6,
          opacity: 0.35,
          y: 0.48,
        }),
        defaultElement("shape", {
          shape: "circle",
          x: P ? 0.82 : 0.86,
          y: P ? 0.18 : 0.2,
          w: 0.04,
          h: 0.04,
          anim: "float",
          start: 0.6,
          color: "",
        }),
        headingEl(f, s, 0.47, { size: 0.12 * u, inDur: 1.1, maxWidth: 0.86 }),
        defaultElement("shape", {
          shape: "line",
          w: 0.12,
          h: 0.006,
          y: 0.57 + (P ? 0.02 : 0.03),
          anim: "draw",
          start: 0.8,
        }),
      ];
      if (s.body)
        els.push(
          text({
            text: s.body,
            y: 0.66,
            size: 0.042 * u,
            weight: 500,
            anim: "rise",
            start: 1.0,
            color: "",
            maxWidth: 0.8,
            font: f.hand ? "hand" : "",
          }),
        );
      return {
        elements: els,
        seconds: readSeconds(`${s.heading} ${s.body}`, 2.2),
      };
    }
    case "statement": {
      const els: El[] = [
        defaultElement("shape", {
          shape: "blob",
          x: P ? 0.2 : 0.14,
          y: P ? 0.2 : 0.24,
          w: 0.18,
          h: 0.18,
          anim: "float",
          opacity: 0.5,
        }),
        defaultElement("shape", {
          shape: "ring",
          x: P ? 0.84 : 0.88,
          y: P ? 0.82 : 0.78,
          w: 0.1,
          h: 0.1,
          fill: false,
          anim: "spin",
          opacity: 0.6,
          start: 0.3,
        }),
        text({
          text: autoEmphasis(s.heading),
          y: s.body ? 0.45 : 0.5,
          size: 0.1 * u,
          weight: 800,
          anim: f.hand ? "write" : "words",
          inDur: Math.min(2.2, 0.35 * s.heading.split(" ").length),
          ease: "outBack",
          maxWidth: 0.82,
        }),
      ];
      if (s.body)
        els.push(
          text({
            text: s.body,
            y: P ? 0.66 : 0.68,
            size: 0.04 * u,
            weight: 500,
            anim: "fade",
            start: 1.2,
            maxWidth: 0.74,
          }),
        );
      return { elements: els, seconds: readSeconds(`${s.heading} ${s.body}`) };
    }
    case "bullets": {
      const items = s.items.length ? s.items : [s.body].filter(Boolean);
      const els: El[] = [
        headingEl(f, s, P ? 0.14 : 0.18, {
          x: 0.08,
          align: "left",
          size: 0.072 * u,
          maxWidth: P ? 0.84 : 0.6,
          anim: f.hand ? "write" : "rise",
        }),
        defaultElement("list", {
          items,
          x: 0.08,
          y: P ? 0.28 : 0.36,
          size: (P ? 0.034 : 0.05) * (P ? 1 : u),
          gap: 0.6,
          start: 0.6,
          maxWidth: P ? 0.84 : 0.56,
          style: f.hand ? "number" : "check",
        }),
      ];
      els.push(
        defaultElement("icon", {
          icon,
          x: P ? 0.5 : 0.8,
          y: P ? 0.8 : 0.56,
          size: P ? 0.16 : 0.28,
          anim: f.hand ? "draw" : "pop",
          start: 0.3,
          inDur: 0.9,
          ease: "outBack",
        }),
      );
      return {
        elements: els,
        seconds: Math.min(
          14,
          1.6 + items.length * 1.4 + readSeconds(s.heading, 0) / 2,
        ),
      };
    }
    case "steps": {
      const items = (s.items.length ? s.items : [s.body])
        .filter(Boolean)
        .slice(0, 4);
      const n = Math.max(1, items.length);
      const els: El[] = [headingEl(f, s, P ? 0.12 : 0.16, { size: 0.07 * u })];
      const per = 1.1;
      items.forEach((it, k) => {
        const t0 = 0.8 + k * per;
        const pos = P
          ? { x: 0.2, y: 0.28 + (k * 0.62) / Math.max(1, n - 1 || 1) }
          : { x: n === 1 ? 0.5 : 0.14 + (k * 0.72) / (n - 1), y: 0.48 };
        if (n === 1) pos.y = P ? 0.45 : 0.48;
        els.push(
          defaultElement("icon", {
            icon: iconFor(it, k + i),
            ...pos,
            size: P ? 0.1 : 0.17,
            anim: "draw",
            start: t0,
            inDur: 0.8,
            badge: true,
          }),
          text({
            text: it,
            x: P ? 0.34 : pos.x,
            y: P ? pos.y : 0.72,
            align: P ? "left" : "center",
            size: P ? 0.032 : 0.042 * u,
            weight: 600,
            anim: f.hand ? "write" : "rise",
            inDur: 0.7,
            start: t0 + 0.35,
            maxWidth: P ? 0.6 : Math.min(0.26, 0.8 / n),
          }),
        );
        if (k < n - 1) {
          const next = P
            ? { x: 0.2, y: 0.28 + ((k + 1) * 0.62) / (n - 1) }
            : { x: 0.14 + ((k + 1) * 0.72) / (n - 1), y: 0.48 };
          els.push(
            defaultElement("arrow", {
              x: P ? pos.x : pos.x + 0.08,
              y: P ? pos.y + 0.06 : pos.y,
              x2: P ? next.x : next.x - 0.08,
              y2: P ? next.y - 0.06 : next.y,
              curve: P ? 0 : -0.25,
              start: t0 + 0.7,
              inDur: 0.5,
            }),
          );
        }
      });
      return { elements: els, seconds: Math.min(14, 1.8 + n * per + 1.6) };
    }
    case "stat": {
      const value = s.value ?? 0;
      const decimals = Number.isInteger(value)
        ? 0
        : Math.min(2, String(value).split(".")[1]?.length ?? 1);
      const els: El[] = [
        defaultElement("shape", {
          shape: "ring",
          w: P ? 0.78 : 0.42,
          h: P ? 0.78 : 0.42,
          y: 0.47,
          fill: false,
          anim: "draw",
          inDur: 1.8,
          ease: "outExpo",
        }),
        defaultElement("counter", {
          to: value,
          decimals,
          suffix: s.unit,
          y: 0.47,
          size: 0.2 * u,
          label: "",
        }),
        text({
          text: s.heading,
          y: P ? 0.74 : 0.8,
          size: 0.045 * u,
          weight: 600,
          anim: "rise",
          start: 1.0,
          maxWidth: 0.8,
        }),
      ];
      if (s.body)
        els.push(
          text({
            text: s.body,
            y: P ? 0.8 : 0.88,
            size: 0.03 * u,
            weight: 400,
            anim: "fade",
            start: 1.5,
            maxWidth: 0.8,
          }),
        );
      return {
        elements: els,
        seconds: Math.max(4, readSeconds(`${s.heading} ${s.body}`, 2.4)),
      };
    }
    case "chart": {
      const data = s.data.length
        ? s.data
        : s.items.map((label, k) => ({ label, value: k + 2 }));
      const els: El[] = [
        headingEl(f, s, P ? 0.14 : 0.14, { size: 0.065 * u, anim: "rise" }),
        defaultElement("chart", {
          chart: data.length === 1 ? "progress" : "bar",
          data: data.length ? data : [{ label: "", value: s.value ?? 75 }],
          y: P ? 0.52 : 0.56,
          w: P ? 0.84 : 0.66,
          h: P ? 0.42 : 0.56,
          unit: s.unit,
          start: 0.5,
          inDur: 1.6,
          ease: "outCubic",
        }),
      ];
      if (s.body)
        els.push(
          text({
            text: s.body,
            y: P ? 0.82 : 0.92,
            size: 0.03 * u,
            weight: 400,
            anim: "fade",
            start: 1.6,
          }),
        );
      return { elements: els, seconds: 5.5 };
    }
    case "quote": {
      const els: El[] = [
        text({
          text: "“",
          x: P ? 0.14 : 0.16,
          y: P ? 0.3 : 0.28,
          size: 0.3 * u,
          weight: 800,
          font: "serif",
          anim: "pop",
          color: "",
          align: "center",
        }),
        text({
          text: autoEmphasis(s.heading),
          y: 0.47,
          size: 0.068 * u,
          weight: 600,
          font: "serif",
          anim: "words",
          inDur: Math.min(2.6, 0.22 * s.heading.split(" ").length),
          start: 0.3,
          maxWidth: 0.74,
        }),
      ];
      if (s.body)
        els.push(
          defaultElement("shape", {
            shape: "line",
            w: 0.05,
            h: 0.004,
            x: 0.5,
            y: P ? 0.66 : 0.71,
            anim: "draw",
            start: 1.4,
          }),
          text({
            text: s.body,
            y: P ? 0.7 : 0.78,
            size: 0.034 * u,
            weight: 500,
            anim: "fade",
            start: 1.6,
          }),
        );
      return { elements: els, seconds: readSeconds(s.heading, 2.6) };
    }
    case "callouts": {
      const items = (s.items.length ? s.items : [s.body])
        .filter(Boolean)
        .slice(0, 4);
      const els: El[] = [
        headingEl(f, s, P ? 0.1 : 0.12, { size: 0.06 * u, anim: "rise" }),
        defaultElement("shape", {
          shape: "circle",
          y: 0.53,
          w: P ? 0.5 : 0.28,
          h: P ? 0.5 : 0.28,
          anim: "pop",
          opacity: 0.16,
          inDur: 0.8,
          ease: "outBack",
        }),
        defaultElement("icon", {
          icon,
          y: 0.53,
          size: P ? 0.2 : 0.26,
          anim: "pop",
          badge: false,
          start: 0.2,
          ease: "outBack",
        }),
      ];
      const spots = P
        ? [
            { x: 0.5, y: 0.25, ax: 0.5, ay: 0.4 },
            { x: 0.5, y: 0.82, ax: 0.5, ay: 0.66 },
            { x: 0.5, y: 0.9, ax: 0.62, ay: 0.64 },
            { x: 0.5, y: 0.18, ax: 0.4, ay: 0.42 },
          ]
        : [
            { x: 0.17, y: 0.36, ax: 0.38, ay: 0.45 },
            { x: 0.83, y: 0.36, ax: 0.62, ay: 0.45 },
            { x: 0.17, y: 0.76, ax: 0.38, ay: 0.62 },
            { x: 0.83, y: 0.76, ax: 0.62, ay: 0.62 },
          ];
      items.forEach((it, k) => {
        const sp = spots[k];
        const t0 = 0.8 + k * 0.7;
        els.push(
          defaultElement("arrow", {
            x: sp.x + (P ? 0 : sp.x < 0.5 ? 0.1 : -0.1),
            y: sp.y + (P ? (sp.y < 0.5 ? 0.04 : -0.04) : 0),
            x2: sp.ax,
            y2: sp.ay,
            curve: sp.x < 0.5 ? 0.2 : -0.2,
            start: t0,
            inDur: 0.5,
          }),
          text({
            text: it,
            x: sp.x,
            y: sp.y,
            size: P ? 0.03 : 0.04 * u,
            weight: 700,
            anim: "pop",
            start: t0 + 0.2,
            inDur: 0.5,
            ease: "outBack",
            maxWidth: P ? 0.8 : 0.26,
          }),
        );
      });
      return { elements: els, seconds: Math.min(12, 2.2 + items.length * 1.1) };
    }
    case "figure": {
      const poses = ["wave", "present", "point", "think", "cheer"] as const;
      const els: El[] = [
        defaultElement("shape", {
          shape: "line",
          x: P ? 0.5 : 0.3,
          y: P ? 0.86 : 0.86,
          w: P ? 0.5 : 0.26,
          h: 0.004,
          anim: "draw",
          opacity: 0.5,
        }),
        defaultElement("figure", {
          pose: poses[i % poses.length],
          x: P ? 0.5 : 0.3,
          y: P ? 0.66 : 0.62,
          size: P ? 0.36 : 0.48,
          say: s.items[0] ?? "",
          start: 0.1,
        }),
        text({
          text: s.heading,
          x: P ? 0.5 : 0.56,
          y: P ? 0.18 : 0.4,
          align: P ? "center" : "left",
          size: 0.07 * u,
          weight: 800,
          anim: f.hand ? "write" : "words",
          inDur: 1,
          start: 0.4,
          maxWidth: P ? 0.84 : 0.4,
        }),
      ];
      if (s.body)
        els.push(
          text({
            text: s.body,
            x: P ? 0.5 : 0.56,
            y: P ? 0.28 : 0.6,
            align: P ? "center" : "left",
            size: 0.036 * u,
            weight: 500,
            anim: "fade",
            start: 1.2,
            maxWidth: P ? 0.84 : 0.38,
          }),
        );
      return {
        elements: els,
        seconds: readSeconds(`${s.heading} ${s.body}`, 2.4),
      };
    }
    case "lowerthird": {
      return {
        elements: [
          defaultElement("lowerThird", {
            title: s.heading,
            subtitle: s.body,
            x: P ? 0.06 : 0.05,
            y: P ? 0.78 : 0.8,
            start: 0.4,
            inDur: 0.9,
            out: "slide",
          }),
        ],
        seconds: Math.max(5, readSeconds(`${s.heading} ${s.body}`, 3)),
        background: "video",
      };
    }
    case "outro":
    default: {
      const els: El[] = [
        defaultElement("icon", {
          icon,
          y: P ? 0.36 : 0.32,
          size: P ? 0.14 : 0.2,
          anim: "pop",
          ease: "outBack",
          inDur: 0.8,
        }),
        headingEl(f, s, P ? 0.52 : 0.58, { size: 0.09 * u, start: 0.4 }),
      ];
      if (s.body)
        els.push(
          text({
            text: s.body,
            y: P ? 0.62 : 0.72,
            size: 0.038 * u,
            weight: 500,
            anim: "rise",
            start: 1.1,
            maxWidth: 0.8,
          }),
        );
      return {
        elements: els,
        seconds: readSeconds(`${s.heading} ${s.body}`, 2.4),
      };
    }
  }
}

const SCENE_TRANSITIONS: TransitionType[] = [
  "fade",
  "slide-left",
  "zoom",
  "wipe",
  "push",
  "circle",
];

/** Outline -> fully validated MotionSpec (deterministic). */
export function compileOutline(
  outline: Outline,
  opts: CompileOptions,
): MotionSpec {
  const preset = themeById(opts.theme);
  const hand = preset.theme.font === "hand";
  const f = frameFor(opts.aspect, hand);
  const pace = Math.min(1.6, Math.max(0.6, opts.pace ?? 1));
  const background = opts.background ?? preset.background;
  const scenes: MotionScene[] = outline.scenes
    .slice(0, LIMITS.scenes)
    .map((s, i) => {
      const c = compileScene(s, i, f);
      const narrationSecs = s.narration
        ? s.narration.split(/\s+/).length / 2.6 + 0.6
        : 0;
      const seconds = s.seconds ?? Math.max(c.seconds * pace, narrationSecs);
      return {
        duration:
          Math.round(
            Math.min(LIMITS.sceneSeconds.max, Math.max(1.5, seconds)) * 10,
          ) / 10,
        background: c.background ?? "",
        transition:
          i === 0
            ? "fade"
            : hand
              ? "wipe"
              : SCENE_TRANSITIONS[(i - 1) % SCENE_TRANSITIONS.length],
        transitionDur: 0.6,
        narration: s.narration,
        elements: c.elements,
      };
    });
  const r = validateSpec(
    {
      version: 1,
      title: outline.title,
      aspect: opts.aspect,
      fps: opts.fps ?? 30,
      theme: preset.theme,
      background,
      scenes: scenes.length
        ? scenes
        : [{ duration: 3, transition: "fade", elements: [] }],
    },
    "lenient",
  );
  if (!r.spec)
    throw new Error(r.errors.map((e) => `${e.path} ${e.message}`).join("; "));
  return r.spec;
}

// Templates

export interface TemplateInput {
  title: string;
  subtitle: string;
  /** Points / steps / features / chart labels, one per line. */
  lines: string[];
  /** Stat value (Stat reveal). */
  value: number;
  unit: string;
}

export interface MotionTemplate {
  id: string;
  label: string;
  description: string;
  aspect: Aspect;
  theme: string;
  background?: BackgroundKind;
  /** Form labels (absent = field hidden). */
  fields: Partial<Record<keyof TemplateInput, string>>;
  sample: TemplateInput;
  build: (input: TemplateInput) => Outline;
  /** Composites over an uploaded video. */
  needsVideo?: boolean;
}

const blank = (o: Partial<OutlineScene>): OutlineScene => ({
  layout: "statement",
  heading: "",
  body: "",
  items: [],
  value: null,
  unit: "",
  icon: "",
  narration: "",
  data: [],
  seconds: null,
  ...o,
});

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export const MOTION_TEMPLATES: MotionTemplate[] = [
  {
    id: "explainer",
    label: "Explainer",
    description: "Title, a hook, key points, a stat and a closing line",
    aspect: "16:9",
    theme: "midnight",
    fields: {
      title: "Topic",
      subtitle: "Tagline",
      lines: "Key points (one per line)",
      value: "Key number",
      unit: "Unit",
    },
    sample: {
      title: "How solar panels work",
      subtitle: "Sunlight in, electricity out",
      lines: [
        "Photons knock electrons loose",
        "Cells guide them into a current",
        "An inverter makes it home-ready",
      ],
      value: 23,
      unit: "%",
    },
    build: (x) => ({
      title: x.title,
      scenes: [
        blank({
          layout: "title",
          heading: x.title,
          body: x.subtitle,
          narration: x.subtitle,
        }),
        blank({
          layout: "statement",
          heading: x.lines[0] ?? x.subtitle,
          narration: x.lines[0] ?? "",
        }),
        blank({
          layout: "steps",
          heading: "How it works",
          items: x.lines.slice(0, 4),
          narration: x.lines.slice(0, 4).join(". "),
        }),
        ...(Number.isFinite(x.value) && x.value !== 0
          ? [
              blank({
                layout: "stat",
                heading:
                  x.unit === "%" ? "Typical efficiency" : "By the numbers",
                value: x.value,
                unit: x.unit,
              }),
            ]
          : []),
        blank({ layout: "outro", heading: "Now you know", body: x.subtitle }),
      ],
    }),
  },
  {
    id: "kinetic_quote",
    label: "Kinetic quote",
    description: "A quote animated word by word with an attribution",
    aspect: "9:16",
    theme: "sunset",
    fields: { title: "Quote", subtitle: "Attribution" },
    sample: {
      title: "Simple things, done *well*, beat clever things done badly.",
      subtitle: "Studio notebook",
      lines: [],
      value: 0,
      unit: "",
    },
    build: (x) => ({
      title: "Quote",
      scenes: [
        blank({
          layout: "quote",
          heading: x.title,
          body: x.subtitle ? `— ${x.subtitle}` : "",
        }),
      ],
    }),
  },
  {
    id: "feature_callouts",
    label: "Product feature callouts",
    description: "A hero icon with animated callout labels and arrows",
    aspect: "16:9",
    theme: "neon",
    fields: {
      title: "Product name",
      subtitle: "One-line pitch",
      lines: "Features (up to 8)",
    },
    sample: {
      title: "Meet Orbit",
      subtitle: "The pocket planner that plans for you",
      lines: [
        "Instant sync",
        "Private by design",
        "Works offline",
        "Smart reminders",
      ],
      value: 0,
      unit: "",
    },
    build: (x) => ({
      title: x.title,
      scenes: [
        blank({ layout: "title", heading: x.title, body: x.subtitle }),
        ...chunk(x.lines, 4).map((group, k) =>
          blank({
            layout: "callouts",
            heading: k === 0 ? "Built for you" : "And more",
            items: group,
            icon: k === 0 ? "cube" : "spark",
          }),
        ),
        blank({
          layout: "outro",
          heading: "Try it today",
          body: x.subtitle,
          icon: "rocket",
        }),
      ],
    }),
  },
  {
    id: "stat_reveal",
    label: "Stat reveal",
    description: "A big counting number with context and a chart",
    aspect: "1:1",
    theme: "ocean",
    fields: {
      title: "What the number means",
      subtitle: "Context line",
      value: "Number",
      unit: "Unit",
      lines: "Chart bars: label=value (optional)",
    },
    sample: {
      title: "of our sample team ships weekly",
      subtitle: "Example numbers - replace with your own",
      lines: ["Weekly=60", "Monthly=25", "Quarterly=15"],
      value: 60,
      unit: "%",
    },
    build: (x) => {
      const data = x.lines
        .map((l) => /^(.*?)\s*[=:]\s*(-?[\d.]+)/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ label: m[1].trim().slice(0, 24), value: Number(m[2]) }));
      return {
        title: x.title,
        scenes: [
          blank({
            layout: "stat",
            heading: x.title,
            body: x.subtitle,
            value: x.value,
            unit: x.unit,
          }),
          ...(data.length
            ? [
                blank({
                  layout: "chart",
                  heading: "Breakdown",
                  data,
                  unit: x.unit,
                }),
              ]
            : []),
        ],
      };
    },
  },
  {
    id: "whiteboard_steps",
    label: "Whiteboard steps",
    description: "Hand-drawn icons, arrows and handwriting on a whiteboard",
    aspect: "16:9",
    theme: "paper",
    fields: {
      title: "Title",
      lines: "Steps (one per line)",
      subtitle: "Closing line",
    },
    sample: {
      title: "Brew better coffee",
      subtitle: "Taste, adjust, repeat",
      lines: [
        "Weigh the beans",
        "Grind just before",
        "Pour in slow circles",
        "Wait four minutes",
      ],
      value: 0,
      unit: "",
    },
    build: (x) => ({
      title: x.title,
      scenes: [
        blank({ layout: "title", heading: x.title }),
        ...chunk(x.lines, 4).map((group) =>
          blank({ layout: "steps", heading: "Step by step", items: group }),
        ),
        blank({
          layout: "outro",
          heading: x.subtitle || "That's it!",
          icon: "check",
        }),
      ],
    }),
  },
  {
    id: "title_intro",
    label: "Title card / intro",
    description: "A punchy opener: drawn ring, title and tagline",
    aspect: "16:9",
    theme: "noir",
    fields: { title: "Title", subtitle: "Tagline" },
    sample: {
      title: "Field Notes",
      subtitle: "Episode 04 · The long way round",
      lines: [],
      value: 0,
      unit: "",
    },
    build: (x) => ({
      title: x.title,
      scenes: [
        blank({
          layout: "title",
          heading: x.title,
          body: x.subtitle,
          seconds: 4.5,
        }),
      ],
    }),
  },
  {
    id: "lower_third",
    label: "Lower third overlay",
    description: "Name and role bar composited over your own video",
    aspect: "16:9",
    theme: "midnight",
    background: "video",
    needsVideo: true,
    fields: { title: "Name", subtitle: "Role / caption" },
    sample: {
      title: "Your Name",
      subtitle: "Role or caption",
      lines: [],
      value: 0,
      unit: "",
    },
    build: (x) => ({
      title: x.title,
      scenes: [
        blank({
          layout: "lowerthird",
          heading: x.title,
          body: x.subtitle,
          seconds: 6,
        }),
      ],
    }),
  },
  {
    id: "stick_explainer",
    label: "Stick-figure explainer",
    description: "A friendly stick figure walks the viewer through your points",
    aspect: "16:9",
    theme: "paper",
    fields: {
      title: "Topic",
      lines: "What the figure explains (one per line)",
    },
    sample: {
      title: "Why sleep matters",
      subtitle: "",
      lines: [
        "Your brain files the day away",
        "Muscles repair overnight",
        "Mood resets by morning",
      ],
      value: 0,
      unit: "",
    },
    build: (x) => ({
      title: x.title,
      scenes: [
        blank({ layout: "figure", heading: x.title, items: ["Hi there!"] }),
        ...x.lines
          .slice(0, 6)
          .map((line) => blank({ layout: "figure", heading: line })),
        blank({ layout: "outro", heading: "Sleep well!", icon: "heart" }),
      ],
    }),
  },
];

export function templateById(id: string): MotionTemplate {
  return MOTION_TEMPLATES.find((t) => t.id === id) ?? MOTION_TEMPLATES[0];
}

/** Build a template into a spec (form inputs merged over the sample). */
export function buildTemplate(
  id: string,
  input: Partial<TemplateInput> = {},
  opts: Partial<CompileOptions> = {},
): MotionSpec {
  const t = templateById(id);
  const x: TemplateInput = { ...t.sample, ...input };
  x.lines = (x.lines ?? []).map((l) => l.trim()).filter(Boolean);
  const outline = normalizeOutline(t.build(x), x.title);
  return compileOutline(outline, {
    aspect: opts.aspect ?? t.aspect,
    theme: opts.theme ?? t.theme,
    background: opts.background ?? t.background,
    fps: opts.fps,
    pace: opts.pace,
  });
}
