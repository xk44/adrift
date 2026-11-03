/**
 * LLM side of the Motion Designer. The model never writes the full scene
 * spec (too many coordinates for an 8B model to get right); it writes a short
 * "outline" — one layout + a few words per scene — which compileOutline turns
 * into a deterministic, schema-valid MotionSpec.
 *
 * motionPrompt is compiled on the server by the motion_script action builder
 * from structured, length-capped params, so the client can't send a free-form
 * prompt.
 */

import { ICON_NAMES } from "./spec";
import { LAYOUTS, normalizeOutline, type Outline } from "./templates";

export const MOTION_SCENES = { min: 3, max: 10, default: 6 } as const;
export const MOTION_BRIEF_MAX = 600;
export const MOTION_TONES = [
  "clear",
  "playful",
  "bold",
  "calm",
  "techy",
] as const;
export type MotionTone = (typeof MOTION_TONES)[number];

export function clampMotionScenes(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n))
    return MOTION_SCENES.default;
  return Math.min(
    MOTION_SCENES.max,
    Math.max(MOTION_SCENES.min, Math.round(n)),
  );
}

export function cleanBrief(raw: unknown): string {
  return typeof raw === "string"
    ? raw
        .replace(/\s+/g, " ")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, MOTION_BRIEF_MAX)
    : "";
}

export interface MotionPromptParams {
  brief: string;
  scenes: number;
  tone?: string;
  /** Whiteboard / stick-figure flavour: prefer figure + steps layouts. */
  whiteboard?: boolean;
}

const LAYOUT_HELP: Record<(typeof LAYOUTS)[number], string> = {
  title: "opening title: heading (<=6 words), body = short subtitle",
  statement:
    "one bold sentence: heading (<=10 words), wrap 1 key word in *stars*",
  bullets: "heading + items (2-4 short points, <=7 words each)",
  steps: "heading + items (2-4 numbered steps, <=7 words each)",
  stat: "big number: value (number only), unit (e.g. % or x), heading = what it means",
  chart: "heading + data: [{label, value}] (2-5 bars, numbers only)",
  quote:
    "heading = the quote (<=18 words), body = who/where (generic, no real names)",
  callouts: "heading + items (2-3 features), each gets an icon",
  figure:
    "a stick figure says heading (<=10 words); items[0] = speech bubble (<=4 words)",
  lowerthird: "name strip: heading = name, body = role",
  outro: "closing line: heading (<=6 words), body = call to action",
};

export function motionPrompt(p: MotionPromptParams): string {
  const tone = (MOTION_TONES as readonly string[]).includes(p.tone ?? "")
    ? p.tone
    : "clear";
  const layouts = LAYOUTS.filter((l) => l !== "lowerthird")
    .map((l) => `- ${l}: ${LAYOUT_HELP[l]}`)
    .join("\n");
  return [
    "You are a motion designer writing a short animated explainer video.",
    `Brief: ${cleanBrief(p.brief) || "a short explainer"}`,
    `Tone: ${tone}. Exactly ${p.scenes} scenes.`,
    p.whiteboard
      ? "Style: hand-drawn whiteboard. Prefer figure, steps and bullets layouts."
      : "Mix layouts so consecutive scenes look different. Start with title, end with outro.",
    "",
    "Layouts:",
    layouts,
    "",
    `Icons (optional, per scene): ${ICON_NAMES.join(", ")}.`,
    "Every scene also gets narration: one spoken sentence (<=22 words).",
    "Keep on-screen text much shorter than narration. Use only facts from the brief;",
    "do not invent statistics unless the brief gives them. No real people, brands or",
    "copyrighted characters.",
    "",
    "Reply with JSON only, no prose, in this shape:",
    '{"title":"...","scenes":[{"layout":"title","heading":"...","body":"...","items":[],"value":null,"unit":"","icon":"","data":[],"narration":"..."}]}',
  ].join("\n");
}

/** Pull the first JSON object out of an LLM reply (fences, <think>, trailing commas). */
export function jsonFromReply(raw: string): unknown {
  const text = (raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const body = text.slice(start, end + 1);
  for (const attempt of [
    body,
    body.replace(/,\s*([}\]])/g, "$1"),
    body.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"'),
  ]) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* next repair */
    }
  }
  return null;
}

/**
 * Parse the model's reply into an outline. Falls back to turning plain lines
 * into statement scenes so a non-JSON reply still yields a usable video.
 */
export function parseMotionReply(raw: string, fallbackTitle = ""): Outline {
  const parsed = jsonFromReply(raw);
  if (parsed && typeof parsed === "object") {
    const o = normalizeOutline(parsed, fallbackTitle);
    if (o.scenes.length) return o;
  }
  const lines = (raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.):-]|[-*])\s*/, "").trim())
    .filter((l) => l.length >= 6 && !/^[{}[\]"]/.test(l))
    .slice(0, MOTION_SCENES.max);
  return normalizeOutline(
    {
      title: fallbackTitle,
      scenes: [
        { layout: "title", heading: fallbackTitle || "Explainer" },
        ...lines.map((l) => ({
          layout: "statement",
          heading: l,
          narration: l,
        })),
      ],
    },
    fallbackTitle,
  );
}
