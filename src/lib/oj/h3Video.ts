/**
 * MiniMax H3 image-to-video LoRA tools (native ComfyUI nodes only):
 *
 *  - 360 orbit (packs/minimax/orbit_360.json): FL2VA with the SAME image as
 *    first and last frame + pablodawson's orbit LoRA (strength 1, 28 steps, no
 *    CFG, 768 px, 73 frames) and the card's instance prompt, used verbatim.
 *  - Camera move (packs/minimax/camera_move.json): Jojocodex's Camera Motion
 *    LoRA (3000-step pruned, strength 0.9); prompt "camera motion, <user text>,
 *    <preset>" (the trigger must open the prompt; move phrase after the scene).
 *  - Optional extra LoRAs any H3 graph can take (`motionRepair`, `handheld`,
 *    and the family-matched Pika H3 Flex LoRA via `h3Flex`), chained in front
 *    of the sampler-side model inputs (and in front of a MiniMaxH3SigmaShift
 *    tail, see h3Speed.ts).
 */
import type { Workflow } from "@/types";
import { hasLora, insertModelLoras, type LoraSpec } from "./loraInsert";

export const H3_PACK = "minimax";
export const ORBIT_360_ACTION = "orbit_360";
export const CAMERA_MOVE_ACTION = "camera_move";

export const ORBIT_LORA = "minimax_h3_flf2v_lora_v1.safetensors";
export const ORBIT_STRENGTH = 1.0;
export const ORBIT_STEPS = 28;
/** 73 = 17*4 + 5, ~3 s at 24 fps (card). */
export const ORBIT_LENGTH = 73;
export const ORBIT_SHORT_EDGE = 768;

export const CAMERA_LORA = "camera_motion_h3_lora_v1_3000_pruned.safetensors";
export const CAMERA_STRENGTH = 0.9;
export const CAMERA_LENGTH = 73;
/** Default: native 768 (1344x768 at 16:9); `resolution: "480"` is the fast draft. */
export const CAMERA_SHORT_EDGE = 768;
export const CAMERA_DRAFT_SHORT_EDGE = 480;

/** The card's instance prompt: "Use this prompt verbatim." */
export const ORBIT_PROMPT =
  "One frozen instant. Only the camera moves. In a continuous 360 orbit. " +
  "Preserve every person and object in exactly the same world position, orientation, shape and pose throughout the shot. " +
  "Airborne objects remain suspended at the captured height and angle: no wobbling, shaking, spinning, drifting, falling or continued action. " +
  "Keep faces, hands, clothing, liquids and the background motionless while retaining their natural appearance. " +
  "Camera parallax is the only source of apparent movement. No cuts, zoom, morphing or added objects.";

export interface OrbitPreset {
  id: string;
  label: string;
  /** Sentence appended after the card prompt ("" = card prompt only). */
  text: string;
  hint?: string;
}

/**
 * Orbit looks (Tools card "Look" picker). The card prompt stays first and
 * verbatim; a preset only adds one sentence about what is frozen, so the
 * LoRA's trigger wording keeps the lead. The first entry is the default.
 */
export const ORBIT_PRESETS: OrbitPreset[] = [
  {
    id: "frozen",
    label: "Frozen moment",
    text: "",
    hint: "The card prompt alone: everything frozen, only the camera moves",
  },
  {
    id: "mid_action",
    label: "Mid-action freeze",
    text: "The subject is caught mid-action, mid-jump or mid-stride, and stays suspended at exactly that instant.",
  },
  {
    id: "splash",
    label: "Frozen splash",
    text: "Every droplet, splash and spray hangs frozen in mid-air, crisp and sharp, catching the light as the camera passes.",
  },
  {
    id: "wind",
    label: "Wind-swept freeze",
    text: "Hair, fabric and loose strands are frozen mid-flutter, as if caught by a gust at the captured instant.",
  },
  {
    id: "product",
    label: "Product spin",
    text: "The product stays centred and razor-sharp; studio highlights and reflections glide across its surfaces as the camera circles.",
    hint: "3D rotation of a product or figurine",
  },
  {
    id: "turnaround",
    label: "Character turnaround",
    text: "The camera circles at eye level and reveals the subject's front, side and back in turn, the pose unchanged.",
  },
  {
    id: "neon_night",
    label: "Neon night",
    text: "Neon signs, street lights and screens keep their glow; reflections on wet surfaces shift only with the parallax.",
  },
];

export function orbitPreset(id?: unknown): OrbitPreset {
  return ORBIT_PRESETS.find((p) => p.id === id) ?? ORBIT_PRESETS[0];
}

/**
 * Orbit prompt: the card prompt verbatim, then the preset's sentence (if
 * any), then the optional user text.
 */
export function orbitPrompt(userText?: string, presetId?: unknown): string {
  return [ORBIT_PROMPT, orbitPreset(presetId).text, cleanText(userText)]
    .filter(Boolean)
    .join(" ");
}

export interface TransitionStyle {
  id: string;
  label: string;
  /** How the shot gets from the first frame to the last ("" = plain). */
  text: string;
  hint?: string;
}

/**
 * Transition styles (Tools card "Style" picker), prompt templates on the same
 * H3 FL2VA graph: the style sentence leads, the user's text follows, then the
 * continuity tail (h3ImageVideo.ts TRANSITION_PROMPT). First = default.
 */
export const TRANSITION_STYLES: TransitionStyle[] = [
  {
    id: "seamless",
    label: "Seamless",
    text: "",
    hint: "Plain continuous move from the first frame to the last",
  },
  {
    id: "morph",
    label: "Morph",
    text: "The opening scene melts and morphs fluidly into the closing scene; shapes, colours and figures flow and reshape into one another.",
  },
  {
    id: "whip_pan",
    label: "Whip pan",
    text: "The camera whips sideways in a fast motion-blurred pan and lands sharply on the closing scene.",
  },
  {
    id: "flying_cam",
    label: "Flying camera",
    text: "The camera lifts off and flies over the opening scene in one continuous aerial move, then swoops down into the closing scene.",
  },
  {
    id: "smoke",
    label: "Smoke",
    text: "Thick swirling smoke billows across the frame and engulfs the opening scene, then thins away to reveal the closing scene.",
  },
  {
    id: "flame",
    label: "Flame",
    text: "A sheet of flame sweeps across the frame; the opening scene burns away and the closing scene is revealed behind the fire.",
  },
  {
    id: "splash",
    label: "Liquid splash",
    text: "A wave of water splashes across the lens and washes the opening scene away; as it drains, the closing scene is revealed.",
  },
  {
    id: "portal",
    label: "Portal",
    text: "A glowing circular portal opens in the middle of the opening scene and the camera pushes through it into the closing scene.",
  },
];

export function transitionStyle(id?: unknown): TransitionStyle {
  return TRANSITION_STYLES.find((s) => s.id === id) ?? TRANSITION_STYLES[0];
}

export interface CameraPreset {
  id: string;
  label: string;
  /** Movement phrase from the card's trained vocabulary. */
  text: string;
}

/**
 * Moves the card lists as trained first (the first entry is the default),
 * then prompt-steered extras.
 */
export const CAMERA_PRESETS: CameraPreset[] = [
  { id: "push_in", label: "Push in", text: "slow push-in" },
  { id: "pull_back", label: "Pull back", text: "slow pull-back" },
  {
    id: "push_pull",
    label: "Push in, then pull back",
    text: "push-in then pull-back",
  },
  { id: "orbit", label: "Orbit", text: "slow orbit around the subject" },
  {
    id: "handheld_track",
    label: "Handheld tracking",
    text: "dynamic handheld tracking shot",
  },
  { id: "aerial", label: "Aerial flyover", text: "aerial drone shot, flyover" },
  { id: "crane", label: "Crane reveal", text: "crane reveal" },
  { id: "tilt_up", label: "Tilt up", text: "tilt up" },
  { id: "tilt_down", label: "Tilt down", text: "tilt down" },
  { id: "close_up", label: "Close-up", text: "extreme close-up, macro" },
  // The card rates pan as the weakest trained move (few samples).
  { id: "pan_left", label: "Pan left (weak)", text: "pan left" },
  { id: "pan_right", label: "Pan right (weak)", text: "pan right" },
  // Prompt-steered moves (Cinema Studio parity): not in the LoRA's trained
  // list, so the move phrase does the work; trained wording is reused where
  // it helps (dutch angle rides on the push-in).
  {
    id: "dutch_angle",
    label: "Dutch angle",
    text: "dutch angle, tilted horizon, slow push-in",
  },
  {
    id: "snorricam",
    label: "Body-mount (snorricam)",
    text: "snorricam, camera rigidly mounted on the subject, the subject stays centered while the background swings around them",
  },
  {
    id: "robo_arm",
    label: "Robo arm",
    text: "fast robotic arm camera move, sweeping arc around the subject that stops sharply",
  },
  {
    id: "through_object",
    label: "Through object",
    text: "camera flies forward through a gap in a foreground object into the scene",
  },
  {
    id: "hyperlapse",
    label: "Hyperlapse",
    text: "hyperlapse, fast steady forward travel through the scene, time accelerated",
  },
  {
    id: "wiggle",
    label: "Wiggle",
    // "rocks quickly left and right" read as a one-way drift in 3 / 3 proofs;
    // naming both orbit directions makes H3 reverse.
    text: "wiggle shot, orbit left then orbit right, the camera arcs back and forth around the subject, rocking motion",
  },
  {
    id: "fpv",
    label: "FPV drone",
    text: "fast FPV drone flight weaving through the scene",
  },
  // Camera-controls parity (Higgsfield / Wan / Kling / MiniMax camera names,
  // see docs/HIGGSFIELD.md 2.2): more prompt-steered moves, same
  // layout. Trained vocabulary leads where one fits (push-in, pull-back,
  // orbit, tracking shot, crane). Unproven on H3 until the GPU pass.
  {
    id: "truck_left",
    label: "Truck left (dolly left)",
    text: "lateral tracking shot, the camera slides sideways to the left alongside the subject, strong background parallax",
  },
  {
    id: "truck_right",
    label: "Truck right (dolly right)",
    text: "lateral tracking shot, the camera slides sideways to the right alongside the subject, strong background parallax",
  },
  {
    id: "super_dolly_in",
    label: "Super dolly in",
    text: "fast long push-in, the camera rushes forward from a wide shot all the way to a tight close-up of the subject",
  },
  {
    id: "super_dolly_out",
    label: "Super dolly out",
    text: "fast long pull-back, the camera rushes backward from a close-up of the subject to a wide reveal of the whole scene",
  },
  {
    id: "double_dolly",
    label: "Double dolly",
    text: "slow pull-back while the subject glides toward the camera without stepping, as if both stand on moving platforms, the background sliding past",
  },
  {
    id: "whip_pan",
    label: "Whip pan",
    text: "whip pan, the camera swings sharply sideways in a blur of motion and snaps to a stop on the subject",
  },
  {
    id: "focus_change",
    label: "Focus change (rack focus)",
    text: "locked-off camera, rack focus, the focus shifts from a blurred foreground object onto the subject, shallow depth of field",
  },
  {
    id: "timelapse_people",
    label: "Timelapse (people)",
    text: "time-lapse, locked-off camera, the subject holds still while crowds of people stream past in fast motion blur",
  },
  {
    id: "timelapse_landscape",
    label: "Timelapse (landscape)",
    text: "time-lapse, clouds race across the sky and light and shadows sweep over the landscape, slow camera drift",
  },
  {
    id: "timelapse_glam",
    label: "Timelapse (glam)",
    text: "time-lapse glam shot, slow push-in on the subject posing while lights, hair and styling shift rapidly around them",
  },
  {
    id: "incline",
    label: "Incline (world tilt)",
    text: "the camera slowly rolls and the whole world tilts sideways, loose objects slide past while the subject stays calm and upright",
  },
  {
    id: "glam",
    label: "Glam",
    text: "slow orbit around the subject with a gentle push-in, soft beauty lighting, fashion film style",
  },
  {
    id: "low_shutter",
    label: "Low shutter",
    text: "dynamic handheld tracking shot, low shutter speed, long motion-blur streaks trail everything that moves",
  },
  {
    id: "buckle_up",
    label: "Buckle up",
    text: "camera mounted on the front of a speeding vehicle facing the subject, wind and vibration, the road blurring past behind",
  },
  {
    id: "object_pov",
    label: "Object POV",
    text: "point of view of an object right in front of the subject, low wide-angle view looking up as the subject reaches toward the camera",
  },
  {
    id: "hero_cam",
    label: "Hero cam",
    text: "low-angle hero shot, the camera slowly rises and circles the subject, epic framing against the sky",
  },
  {
    id: "behind_scenes",
    label: "Behind the scenes",
    text: "slow pull-back, handheld, revealing the film set around the subject: lights, stands, cables and crew",
  },
  {
    id: "eating_zoom",
    label: "Eating zoom",
    text: "the subject takes a bite of food as the camera snaps into a close-up of the mouth and holds",
  },
  {
    id: "flying_cam",
    label: "Flying cam transition",
    text: "aerial drone shot, the camera launches up and away over the scene, then swoops back down to a new view",
  },
  {
    id: "eyes_in",
    label: "Eyes in",
    text: "slow push-in into the subject's eye, through the pupil into darkness that opens onto a new scene",
  },
  {
    id: "mouth_in",
    label: "Mouth in",
    text: "slow push-in into the subject's open mouth, through the darkness into a new scene",
  },
  {
    id: "car_mount",
    label: "Car mount",
    text: "camera rigidly mounted on the side of a moving car, the subject at the wheel, scenery streaming past the window",
  },
  {
    id: "fisheye",
    label: "Fisheye",
    text: "fisheye lens, extreme barrel distortion, the camera moves in close to the subject",
  },
  {
    id: "dolly_zoom",
    label: "Dolly zoom (vertigo)",
    text: "dolly zoom, vertigo effect, the camera pulls back while the lens zooms in, the subject stays the same size as the background stretches away behind them",
  },
  {
    id: "earth_zoom_out",
    label: "Earth zoom out",
    text: "fast long pull-back straight up from the subject, rising over the rooftops, through the clouds and into orbit until the whole Earth fills the frame",
  },
];

/** CAMERA_PRESETS[0 .. N-1] are the card's trained moves; the rest are prompt-steered. */
export const CAMERA_TRAINED_COUNT = 12;

export function cameraPreset(id?: unknown): CameraPreset {
  return CAMERA_PRESETS.find((p) => p.id === id) ?? CAMERA_PRESETS[0];
}

/**
 * "camera motion[, <user text>], <preset text>": trigger first, then subject /
 * scene, then the move phrase, matching the card's training-caption layout
 * ("camera motion, [subject], [scene], [camera move], [light/style]").
 */
export function cameraMovePrompt(
  presetId?: unknown,
  userText?: string,
): string {
  const parts = ["camera motion"];
  const extra = cleanText(userText);
  if (extra) parts.push(extra);
  parts.push(cameraPreset(presetId).text);
  return parts.join(", ");
}

function cleanText(text?: string): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

// Optional extra LoRAs (motion repair / handheld)

export interface H3ExtraLora {
  /** Param key (also the model-status option key). */
  key: "motionRepair" | "handheld";
  file: string;
  strength: number;
  title: string;
}

export const H3_EXTRA_LORAS: H3ExtraLora[] = [
  {
    key: "motionRepair",
    file: "Motion_Repair_V2.safetensors",
    // Card: ~0.9 recommended when used standalone.
    strength: 0.9,
    title: "Motion Continuity Repair V2",
  },
  {
    key: "handheld",
    file: "handheld_h3_100.safetensors",
    // The card gives no strength; 1.0 is the neutral default.
    strength: 1.0,
    title: "Handheld shaky camera",
  },
];

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string")
    return ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
  return value === 1;
}

/** Extra H3 LoRA files requested by `params` (motionRepair / handheld). */
export function requestedH3ExtraLoras(
  params: Record<string, unknown>,
): H3ExtraLora[] {
  return H3_EXTRA_LORAS.filter((l) => truthy(params[l.key]));
}

export function isH3Graph(workflow: Workflow): boolean {
  return Object.values(workflow).some((n) =>
    String(n.class_type).startsWith("MiniMaxH3"),
  );
}

export type H3Family = "fl2v" | "ref2v";

/**
 * ref2v when the graph samples through MiniMaxH3ReferenceToVideo or loads a
 * Ref2VA DiT (person_remove conditions a ref2va UNET without that node), else
 * fl2v.
 */
export function h3Family(workflow: Workflow): H3Family {
  return Object.values(workflow).some(
    (n) =>
      n.class_type === "MiniMaxH3ReferenceToVideo" ||
      (n.class_type === "UNETLoader" &&
        /ref2v|omniref/i.test(String(n.inputs?.unet_name ?? ""))),
  )
    ? "ref2v"
    : "fl2v";
}

// Pika H3 Flex (`h3Flex`): Mellis, Inc.'s fine-tunes of the FL2VA and Ref2VA
// DiTs, shipped as rank-128 LoRA deltas (MiniMax H3 Community License
// derivatives). The headers bake the training scale in ("baked_scale 1.0",
// alpha folded into lora_B), so strength 1 reproduces the fine-tune. No
// trigger word. The file follows the graph family, like the Turbo LoRAs.

export const H3_FLEX_LORAS: Record<H3Family, string> = {
  fl2v: "pika_h3_flex_fl2va_v1_bf16.safetensors",
  ref2v: "pika_h3_flex_ref2va_v1_bf16.safetensors",
};
export const H3_FLEX_DEFAULT_STRENGTH = 1;
/** The Tools picker's "Subtle" option. */
export const H3_FLEX_SUBTLE_STRENGTH = 0.6;
export const H3_FLEX_STRENGTH_RANGE = { min: 0, max: 1.5 } as const;

/**
 * Flex strength `params` ask for: `h3FlexStrength` (clamped) when `h3Flex`
 * is on, else the default; null when off or the strength is 0.
 */
export function requestedH3FlexStrength(
  params: Record<string, unknown>,
): number | null {
  if (!truthy(params.h3Flex)) return null;
  const raw = Number(params.h3FlexStrength);
  const strength =
    params.h3FlexStrength == null ||
    params.h3FlexStrength === "" ||
    !Number.isFinite(raw)
      ? H3_FLEX_DEFAULT_STRENGTH
      : Math.min(
          H3_FLEX_STRENGTH_RANGE.max,
          Math.max(H3_FLEX_STRENGTH_RANGE.min, raw),
        );
  return strength > 0 ? strength : null;
}

/** The Flex LoRA `params` would add to `workflow` (null = no-op). */
export function h3FlexLoraFor(
  workflow: Workflow,
  params: Record<string, unknown>,
): LoraSpec | null {
  const strength = requestedH3FlexStrength(params);
  if (strength === null || !isH3Graph(workflow)) return null;
  const family = h3Family(workflow);
  return {
    file: H3_FLEX_LORAS[family],
    strength,
    title: `Pika H3 Flex (${family === "ref2v" ? "Ref2VA" : "FL2VA"})`,
  };
}

/** The MODEL source feeding the sampler-side guider / sampler (null if none). */
export function samplerModelSource(workflow: Workflow): string | null {
  for (const cls of [
    "BasicGuider",
    "CFGGuider",
    "KSampler",
    "KSamplerAdvanced",
  ]) {
    for (const node of Object.values(workflow)) {
      if (node.class_type !== cls) continue;
      const m = (node.inputs as Record<string, unknown>)?.model;
      if (Array.isArray(m) && m.length === 2) return String(m[0]);
    }
  }
  return null;
}

/**
 * Chain the requested extra LoRAs (Flex first) in front of every consumer of
 * the sampler's model (after any LoRA the graph already applies). No-op for
 * non-H3 graphs and for LoRAs the graph already loads. Returns the added node
 * ids.
 */
export function applyH3ExtraLoras(
  workflow: Workflow,
  params: Record<string, unknown>,
): string[] {
  if (!isH3Graph(workflow)) return [];
  const flex = h3FlexLoraFor(workflow, params);
  const wanted: LoraSpec[] = [
    ...(flex ? [flex] : []),
    ...requestedH3ExtraLoras(params),
  ].filter((l) => !hasLora(workflow, l.file));
  if (!wanted.length) return [];
  let source = samplerModelSource(workflow);
  if (!source) return [];
  // h3Speed's MiniMaxH3SigmaShift stays the tail: chain in front of it.
  if (workflow[source]?.class_type === "MiniMaxH3SigmaShift") {
    const m = (workflow[source].inputs as Record<string, unknown>).model;
    if (!Array.isArray(m)) return [];
    source = String(m[0]);
  }
  return insertModelLoras(workflow, source, wanted);
}
