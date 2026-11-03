/**
 * Click to Ad on LTX-2.5: every scene clip is an LTX-2.5 image-to-video
 * render with synced sound (action ltx25_animate, packs/ltx25/i2v.json).
 *
 *  - Shot plan: hook, product hero orbit, lifestyle shot(s), end card.
 *  - Size: 9:16 at ~0.9 MP through ltx25Dims (two-stage: the first pass is
 *    a /32 half size, the x2 upscaler doubles it), i.e. 704x1280.
 *  - Length: the scene's narration (or the shot's default) rounded UP to
 *    LTX's 8n+1 frame grid at 24 fps, clamped to 3-8 s.
 *  - Prompt: one flowing present-tense paragraph per the LTX-2.5 prompt
 *    guide: main action, product lock, camera move, lighting, then the
 *    sound design so the clip's own audio track is worth keeping. The
 *    presenter scene has LTX speak the narration itself (quoted dialogue,
 *    native lip sync) instead of a separate talking-head model.
 *
 * Pure helpers (no fetch) so the runner and the tests share them.
 */
import { ltx25Dims, LTX25_FPS, LTX25_PACK_ID } from "@/lib/oj/ltx25";

export type AdShotRole = "hook" | "hero" | "lifestyle" | "end";

export interface AdShot {
  id: AdShotRole;
  label: string;
  /** What the script model should plan for this scene. */
  brief: string;
  /** Default main action when the script gives no motion. */
  action: string;
  /** Default camera move (skipped when the motion already names one). */
  camera: string;
  /** Light accent; the setting itself comes from the packshot frame. */
  light: string;
  /** Default sound design when the script gives none. */
  sound: string;
  /** Default length when the scene has no narration timing. */
  seconds: number;
}

export const AD_SHOTS: Record<AdShotRole, AdShot> = {
  hook: {
    id: "hook",
    label: "Hook",
    brief:
      "a scroll-stopping hook: the product makes a bold, surprising entrance",
    action:
      "The product snaps into the center of the frame and lands with a small bounce as a flash of light sweeps across it",
    camera:
      "The camera punches in fast from a low angle and settles on the product",
    light: "a bright specular glint racing across its surface",
    sound:
      "a sharp whoosh, a solid tactile thud as it lands and a short sparkling shimmer",
    seconds: 3,
  },
  hero: {
    id: "hero",
    label: "Hero orbit",
    brief:
      "the product hero shot: a slow orbit that shows off its shape, materials and details",
    action:
      "The product stands perfectly still at the center of the frame while soft reflections glide over its surface",
    camera:
      "The camera makes a slow, smooth half orbit around the product at eye level, keeping it centered and in sharp focus",
    light: "soft glossy highlights rolling over its edges",
    sound:
      "a low airy ambient hum, a faint smooth whir and a few soft tactile clicks",
    seconds: 5,
  },
  lifestyle: {
    id: "lifestyle",
    label: "Lifestyle",
    brief:
      "a lifestyle shot: the product in a real, everyday moment where it is used or enjoyed",
    action:
      "The product sits naturally in the scene while small details around it come alive, steam curling, leaves stirring and light shifting",
    camera:
      "The camera glides in slowly on a gentle dolly with a shallow depth of field",
    light: "warm natural light shifting softly across the scene",
    sound:
      "quiet natural ambience of the setting with soft, close detail sounds",
    seconds: 4,
  },
  end: {
    id: "end",
    label: "End card",
    brief:
      "the end card: a clean, calm hero pose with empty space above the product for the title",
    action:
      "The product settles into a clean hero pose at the center of the frame with calm, empty space above it",
    camera:
      "The camera eases back in a slow, steady pull-out and comes to a complete rest",
    light: "a soft glow blooming behind the product",
    sound: "a soft resolving chime and a gentle airy swell that fades to quiet",
    seconds: 3,
  },
};

/** Shot role of scene `index` out of `count` (hook first, end card last). */
export function adShotRole(index: number, count: number): AdShotRole {
  if (index <= 0) return "hook";
  if (count >= 2 && index >= count - 1) return "end";
  if (index === 1) return "hero";
  return "lifestyle";
}

/** The ad is always vertical. */
export const AD_ASPECT = "9:16";
export const AD_ASPECT_RATIO = 9 / 16;

/** LTX-2.5 i2v output size for the ad (two-stage graph). */
export function adClipDims() {
  return ltx25Dims(AD_ASPECT_RATIO, true);
}

export const AD_CLIP_MIN_FRAMES = 73; // 3 s at 24 fps, 8n+1
export const AD_CLIP_MAX_FRAMES = 193; // 8 s at 24 fps, 8n+1
/** Breath after the narration before the cut (matches the assembler). */
const TAIL_SECONDS = 0.35;

/**
 * Frames for a clip that covers `seconds`: rounded UP to the 8n+1 grid at
 * 24 fps so the narration never outlasts the motion, clamped to 3-8 s.
 */
export function adClipFrames(seconds: number): number {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 4;
  const frames = Math.ceil((s * LTX25_FPS) / 8) * 8 + 1;
  return Math.min(AD_CLIP_MAX_FRAMES, Math.max(AD_CLIP_MIN_FRAMES, frames));
}

/** Clip length for a scene: its narration (+ tail) or the shot default. */
export function adClipLength(
  role: AdShotRole,
  speechSeconds: number | null | undefined,
): { frames: number; seconds: number } {
  const target =
    typeof speechSeconds === "number" && speechSeconds > 0
      ? speechSeconds + TAIL_SECONDS
      : AD_SHOTS[role].seconds;
  const frames = adClipFrames(target);
  return { frames, seconds: Math.round((frames / LTX25_FPS) * 1000) / 1000 };
}

/** Product sound (LTX audio) level under the narration, dB. */
export const AD_PRODUCT_SOUND_DB = -12;

function plain(text: string | undefined): string {
  return (text ?? "")
    .replace(/-{2,}/g, " ")
    .replace(/::/g, ":")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim, capitalise and end with a full stop (quoted dialogue kept). */
function sentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/[\s,;:]+$/, "");
  if (!t) return "";
  const s = t[0].toUpperCase() + t.slice(1);
  return /[.!?]"?$/.test(s) ? s : `${s}.`;
}

const CAMERA_WORDS =
  /\b(camera|orbit|orbits|push|pushes|pull|pulls|pan|pans|dolly|zoom|zooms|tilt|tilts|track|tracks|crane|glide|glides)\b/i;

export const AD_MOTION_LEVEL = {
  animate_low: "Every movement is subtle, smooth and unhurried.",
  animate_high: "The motion is bold and energetic with a dynamic camera.",
} as const;

export interface AdClipPromptInput {
  role: AdShotRole;
  /** Script motion line (main action and/or camera move). */
  motion?: string;
  /** Script sound line (foley + ambience). */
  sound?: string;
  /** Spoken line; only the presenter scene says it on camera. */
  narration?: string;
  presenter?: boolean;
  level?: keyof typeof AD_MOTION_LEVEL;
}

/** Hard cap; the LTX guide asks for at most ~200 words. */
export const AD_PROMPT_MAX_CHARS = 1100;

/** One flowing LTX-2.5 paragraph for an ad scene. */
export function adClipPrompt(input: AdClipPromptInput): string {
  const shot = AD_SHOTS[input.role];
  const parts: string[] = [];
  if (input.presenter) {
    const line = plain(input.narration);
    parts.push(
      "An original, fictional presenter holds the product up beside their face and looks straight into the camera, smiling and speaking with natural lip movement and small hand gestures",
    );
    if (line) parts.push(`They say: "${sentence(line)}"`);
    parts.push("The product keeps its exact shape, colours and label");
    parts.push(
      "The camera holds a steady eye-level medium close-up with a slight handheld drift",
    );
    parts.push(
      "The lighting and setting stay exactly as in the first frame, soft and flattering",
    );
    parts.push(
      "The audio is the presenter's clear, close-mic voice over a quiet room tone",
    );
  } else {
    const motion = plain(input.motion);
    parts.push(motion || shot.action);
    parts.push(
      "The product keeps its exact shape, colours and label throughout",
    );
    if (!motion || !CAMERA_WORDS.test(motion)) parts.push(shot.camera);
    parts.push(
      `The lighting and setting stay exactly as in the first frame, with ${shot.light}`,
    );
    parts.push(
      `The soundtrack is only natural sound design: ${plain(input.sound) || shot.sound}`,
    );
  }
  if (input.level) parts.push(AD_MOTION_LEVEL[input.level]);
  const text = parts.map(sentence).filter(Boolean).join(" ");
  return text.length > AD_PROMPT_MAX_CHARS
    ? `${text.slice(0, AD_PROMPT_MAX_CHARS - 1).replace(/\s+\S*$/, "")}.`
    : text;
}

/** Action params for one ad clip (POST /api/jobs/action, ltx25_animate). */
export function adClipParams(
  input: AdClipPromptInput & {
    speechSeconds?: number | null;
  },
): {
  pack_id: string;
  prompt: string;
  frames: number;
  ar: string;
} {
  return {
    pack_id: LTX25_PACK_ID,
    prompt: adClipPrompt(input),
    frames: adClipLength(input.role, input.speechSeconds).frames,
    ar: AD_ASPECT,
  };
}

/** Script-prompt lines describing the shot plan for `count` scenes. */
export function adShotPlan(count: number, presenter: boolean): string[] {
  return Array.from({ length: count }, (_, i) => {
    const brief =
      presenter && i === 0
        ? "the presenter introduces the product to camera (this is the hook)"
        : AD_SHOTS[adShotRole(i, count)].brief;
    return `Scene ${i + 1}: ${brief}.`;
  });
}
