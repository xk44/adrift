/**
 * GPU smoke manifest: every tool / action that docs/HIGGSFIELD.md
 * still lists as not GPU-checked (cross-referenced with docs/TOOLS.md), with
 * the smallest inputs that still exercise the real graph: 480p / 3 s video,
 * fast (fewest-step) modes, 1-2 s procedural source media from ./assets.ts.
 *
 * Entries run in array order, lightest first; `heavy` marks MiniMax H3 /
 * 14B+ video jobs (`--skip-heavy` drops them). `blockedBy` marks entries
 * whose weights are known to be missing on the GPU host: dry-run still
 * builds them, --run skips them unless `--include-blocked`.
 *
 * Params may hold "@asset:<id>" strings; the builder swaps them for the
 * uploaded asset's ComfyUI ref ("adrift_smoke/<file> [input]").
 */
import { composeAsmrPrompt } from "@/lib/tools/asmrPresets";
import type { SmokeAssetId } from "./assets";

export type SmokeExpect = "image" | "video" | "audio" | "text";

interface SmokeEntryBase {
  /** Unique id, also the report key. */
  id: string;
  /** Where the "not GPU-checked" status comes from (parity row / section). */
  parity: string;
  /** Card label in docs/TOOLS.md, when the tool has one. */
  toolsDoc?: string;
  /** Output media the run must produce. */
  expect: SmokeExpect;
  heavy?: boolean;
  blockedBy?: string;
  /** --run: give up on /history after this long (default 900 s). */
  timeoutSec?: number;
  note?: string;
}

/** A /api/jobs/action job against a seeded source run. */
export interface SmokeActionEntry extends SmokeEntryBase {
  kind: "action";
  action: string;
  /** Seed-run source: an image/clip asset, or "text" (text-only seed run). */
  source: SmokeAssetId | "text";
  /** Seed-run prompt (text sources). */
  sourcePrompt?: string;
  params: Record<string, unknown>;
}

/** A /api/jobs/tool edit-tool job. */
export interface SmokeToolEntry extends SmokeEntryBase {
  kind: "tool";
  toolId: string;
  images: SmokeAssetId[];
  prompt?: string;
  options?: Record<string, unknown>;
}

export type SmokeEntry = SmokeActionEntry | SmokeToolEntry;

export const ASSET_PLACEHOLDER = "@asset:";

const asset = (id: SmokeAssetId) => `${ASSET_PLACEHOLDER}${id}`;

const SEED = 4242;

/** ASMR sound preset the add_sound entry uses (asmrPresets id). */
export const SMOKE_ASMR_PRESET = "tapping";

export const SMOKE_MANIFEST: SmokeEntry[] = [
  // --- edit tools (Qwen-Image 2.1 / 2511), seconds each -------------------
  {
    id: "tool.qwen21-remove-bg",
    kind: "tool",
    toolId: "qwen21-remove-bg",
    images: ["shapes"],
    options: { seed: SEED },
    expect: "image",
    parity: "row 9 (Qwen 2.1 RGBA cut-out): not GPU-checked yet",
    toolsDoc: "Remove background (RGBA)",
  },
  {
    id: "tool.qwen21-next-scene",
    kind: "tool",
    toolId: "qwen21-next-scene",
    images: ["gradient"],
    prompt: "the camera pulls back to reveal the whole room",
    options: { seed: SEED, fast: true },
    expect: "image",
    parity: "row 8 Popcorn: frames chain as qwen21-next-scene edits",
    toolsDoc: "Next scene",
    note: "one link of the Popcorn chain; the full storyboard chain is deferred",
  },
  {
    id: "tool.qwen2511-camera",
    kind: "tool",
    toolId: "qwen2511-camera",
    images: ["shapes"],
    options: { seed: SEED, fast: true },
    expect: "image",
    parity: "row 42 Camera Controls: qwen2511-camera",
    toolsDoc: "Camera angle (Qwen Edit 2511)",
    blockedBy: "Qwen-Image-Edit-2511 UNET not on the GPU host",
  },

  // --- stock-node / light video + audio -----------------------------------
  {
    id: "action.overlay_composite",
    kind: "action",
    action: "overlay_composite",
    source: "clip",
    params: {
      seconds: 1,
      overlays: [
        {
          ref: asset("sticker"),
          kind: "image",
          width: 128,
          height: 128,
          x: 0.75,
          y: 0.25,
          scale: 0.3,
        },
        {
          ref: asset("shapes"),
          kind: "image",
          width: 384,
          height: 256,
          scale: 0.5,
          opacity: 0.6,
          blend: "screen",
          start: 0.25,
          end: 0.75,
        },
      ],
    },
    expect: "video",
    parity: "row 44 Mixed Media: Overlay Composite not GPU-validated yet",
    note: "two layers: alpha sticker + timed screen-blend layer",
  },
  {
    id: "action.dub_mux",
    kind: "action",
    action: "dub_mux",
    source: "clip",
    params: { audioRef: asset("tone"), seconds: 1 },
    expect: "video",
    parity: "row 74 dubbing: dub_mux",
  },
  {
    id: "action.dub_transcribe",
    kind: "action",
    action: "dub_transcribe",
    source: "clip",
    params: { language: "auto", seconds: 1 },
    expect: "text",
    parity: "row 74 dubbing: dub_transcribe (Whisper ASR node)",
    note: "synthetic tone: an empty or nonsense transcript is still a pass",
  },
  {
    id: "action.dub_transcribe_speakers",
    kind: "action",
    action: "dub_transcribe_speakers",
    source: "clip",
    params: { seconds: 1 },
    expect: "text",
    parity: "row 74 dubbing: dub_transcribe_speakers (VibeVoice-ASR)",
    note: "synthetic tone: an empty or nonsense transcript is still a pass",
  },
  {
    id: "action.dub_translate",
    kind: "action",
    action: "dub_translate",
    source: "text",
    params: {
      transcript: "Hello, this is a short test line.",
      source: "auto",
      target: "es",
      seconds: 2,
    },
    expect: "text",
    parity: "row 74 dubbing: dub_translate (LLM translate)",
  },
  {
    id: "action.dub_voice",
    kind: "action",
    action: "dub_voice",
    source: "clip",
    params: { text: "Hola, esta es una prueba.", seconds: 1, seed: SEED },
    expect: "audio",
    parity: "row 74 dubbing: dub_voice (VibeVoice clone)",
  },
  {
    id: "action.dub_voice_chatterbox",
    kind: "action",
    action: "dub_voice_chatterbox",
    source: "clip",
    params: {
      text: "Hola, esta es una prueba.",
      language: "es",
      seconds: 1,
      seed: SEED,
    },
    expect: "audio",
    parity: "row 74 dubbing: dub_voice_chatterbox",
  },
  {
    id: "action.voice_change",
    kind: "action",
    action: "voice_change",
    source: "text",
    params: {
      sourceAudioRef: asset("tone"),
      seconds: 2,
      quality: "fast",
      seed: SEED,
    },
    expect: "audio",
    parity: "row 73 Voice changer: voice_change",
  },
  {
    id: "action.voice_change_video",
    kind: "action",
    action: "voice_change_video",
    source: "clip",
    params: { seconds: 1, audioRef: asset("tone"), seed: SEED },
    expect: "video",
    parity: "row 73 Voice changer: voice_change_video",
  },
  {
    id: "action.music",
    kind: "action",
    action: "music",
    source: "text",
    sourcePrompt: "short instrumental sting",
    params: {
      pack_id: "audio",
      prompt: "instrumental, upbeat electronic, short sting",
      duration: 5,
      bpm: 120,
      seed: SEED,
    },
    expect: "audio",
    parity: "ClipCut / Urban Cuts: music step needs a full GPU run",
    toolsDoc: "Make music",
  },
  {
    id: "action.add_sound",
    kind: "action",
    action: "add_sound",
    source: "clip",
    params: {
      prompt: composeAsmrPrompt(SMOKE_ASMR_PRESET, ""),
      video_seconds: 1,
      seed: SEED,
    },
    expect: "video",
    parity: "ASMR apps: MMAudio add_sound auto-chain (GPU run pending)",
    toolsDoc: "Add sound to clip",
    note: "prompt = composeAsmrPrompt(SMOKE_ASMR_PRESET), as the ASMR apps send it",
  },
  {
    id: "action.video_bg_change",
    kind: "action",
    action: "video_bg_change",
    source: "clip",
    params: { secondRefImage: asset("shapes"), blend: "natural" },
    expect: "video",
    parity: "row 59 Video background changer: GPU run pending",
    toolsDoc: "Change video background",
  },
  {
    id: "action.video_bg_change.blur",
    kind: "action",
    action: "video_bg_change",
    source: "clip",
    params: { background: "blur", blend: "none" },
    expect: "video",
    parity: "row 59 Video background changer: blur branch",
    toolsDoc: "Change video background",
  },

  // --- Wan 2.2 14B video (480p, 3 s, fast 4-step) --------------------------
  {
    id: "action.wan_motion.melt",
    kind: "action",
    action: "wan_motion",
    source: "gradient",
    params: {
      preset: "melt",
      mode: "fast",
      resolution: "480p",
      duration: "3s",
      seed: SEED,
    },
    expect: "video",
    parity:
      "row 43 Effects: wan_motion prompt-only effects not individually checked",
    toolsDoc: "Motion presets",
    timeoutSec: 1200,
  },
  {
    id: "action.wan_motion.cam_brisk_push",
    kind: "action",
    action: "wan_motion",
    source: "shapes",
    params: {
      preset: "cam_brisk_push",
      mode: "fast",
      resolution: "480p",
      duration: "3s",
      seed: SEED,
    },
    expect: "video",
    parity:
      "row 42 Camera Controls: cam_* catalog not individually GPU-checked",
    toolsDoc: "Motion presets",
    timeoutSec: 1200,
  },
  {
    id: "action.wan_camera",
    kind: "action",
    action: "wan_camera",
    source: "gradient",
    params: {
      camera: "zoom_in",
      cameraSpeed: "normal",
      mode: "fast",
      resolution: "480p",
      duration: "3s",
      seed: SEED,
    },
    expect: "video",
    parity: "row 42 Camera Controls: wan_camera",
    toolsDoc: "Camera control",
    timeoutSec: 1200,
  },
  {
    id: "action.video_object_remove",
    kind: "action",
    action: "video_object_remove",
    source: "clip",
    params: { target: "orange disc", speed: "fast", seed: SEED },
    expect: "video",
    parity: "row 60 Remove object from video: GPU validation pending",
    toolsDoc: "Video Object Remover",
    timeoutSec: 1200,
  },
  {
    id: "action.video_remove_text",
    kind: "action",
    action: "video_remove_text",
    source: "clip",
    params: { textPreset: "all", speed: "fast", seed: SEED },
    expect: "video",
    parity: "row 61 Remove text from video: GPU validation pending",
    toolsDoc: "Video Text Remover",
    timeoutSec: 1200,
  },

  // --- LTX-2.5 VFX (weights not on the GPU host yet) -----------------------
  ...(
    [
      ["ltx_alpha_matte", "clip", undefined, "Alpha Matte"],
      ["ltx_clean_plate", "clip", undefined, "Clean Plate"],
      ["ltx_day_to_night", "clip", undefined, "Day to Night"],
      ["ltx_add_water", "clip", "light rain on the ground", "Add Water"],
      ["ltx_cinemagraph", "gradient", "the disc glows softly", "Cinemagraph"],
      ["ltx_slow_motion", "gradient", "the disc drifts slowly", "Slow Motion"],
      ["ltx_sdr_to_hdr", "clip", undefined, "SDR to HDR (video)"],
    ] as const
  ).map(([action, source, prompt, label]): SmokeActionEntry => ({
    id: `action.${action}`,
    kind: "action",
    action,
    source,
    params: {
      ...(prompt ? { prompt } : {}),
      video_seconds: 1,
      seed: SEED,
    },
    expect: "video",
    parity: "LTX VFX group: GPU run pending",
    toolsDoc: label,
    blockedBy: "LTX-2.5 VFX LoRAs / 22B weights not on the GPU host",
    timeoutSec: 1200,
  })),

  // --- Restore (LTX-2.5 restoration IC-LoRAs, one per mode) ---------------
  ...[
    "ltx_restore",
    "ltx_restore_deblur",
    "ltx_restore_decompress",
    "ltx_restore_colorize",
    "ltx_restore_refine",
  ].map(
    (action): SmokeActionEntry => ({
      id: `action.${action}`,
      kind: "action",
      action,
      source: "clip",
      params: { video_seconds: 1, seed: SEED },
      expect: "video",
      parity: "Restore video: GPU run pending",
      toolsDoc: "Restore video",
      timeoutSec: 1200,
    }),
  ),

  // --- MiniMax H3 (heavy: run last, one at a time) -------------------------
  {
    id: "action.camera_move.snorricam",
    kind: "action",
    action: "camera_move",
    source: "gradient",
    params: { cameraMove: "snorricam", seed: SEED },
    expect: "video",
    heavy: true,
    parity: "row 42 Camera Controls: camera_move H3 prompt-steered presets",
    toolsDoc: "Camera move video",
    timeoutSec: 1800,
  },
  {
    id: "action.person_remove",
    kind: "action",
    action: "person_remove",
    source: "clip",
    params: { target: "orange disc", seed: SEED },
    expect: "video",
    heavy: true,
    parity: "row 60 Remove person from video (H3 Person Remover): pending",
    toolsDoc: "Video Person Remover",
    timeoutSec: 1800,
    note: "no person in the synthetic clip: proves the graph runs, not quality",
  },
];

/**
 * Parity items that need more than one queued graph (multi-step UI runs).
 * The runner reports them as `deferred`; their single graphs are above.
 */
export const SMOKE_DEFERRED: Array<{ id: string; reason: string }> = [
  {
    id: "popcorn-chain",
    reason:
      "Popcorn storyboard: t2i + several chained qwen21-next-scene edits; one link is tool.qwen21-next-scene",
  },
  {
    id: "clipcut",
    reason:
      "ClipCut assemble needs prior step outputs (clipCutAssembleParams); music step is action.music",
  },
  {
    id: "urban_cuts",
    reason: "same pipeline as ClipCut with a different look list",
  },
  {
    id: "click-to-ad",
    reason:
      "Click to Ad full UI run (script + assemble already GPU-checked); needs the browser pipeline runner",
  },
  {
    id: "shorts-studio",
    reason:
      "Shorts Studio full UI run (script + assemble already GPU-checked); needs the browser pipeline runner",
  },
];

/**
 * Ids that show up on the parity doc's pending lines but are already
 * GPU-checked (or are context, not a queued graph): not missing entries.
 */
export const SMOKE_CONTEXT_ONLY: string[] = [
  "vace_restyle",
  "video_object_swap",
  "video_lipsync",
  "wan_move",
  "pipeline_script",
  "pipeline_assemble",
  // custom node packs named on the dub / voice rows (run via their actions)
  "cj_whisper_asr",
  "chatterbox_local",
];

/** Lines of docs/HIGGSFIELD.md that still claim a pending GPU check. */
export const PARITY_PENDING_RE =
  /(GPU (run|validation|check)[^|.]*pending|pending GPU|not (yet )?GPU|not individually GPU|GPU-validated yet|full GPU run|not yet GPU-run)/i;

/** Backticked identifiers (`snake_case` / `kebab-case`) on pending lines. */
export function parityPendingIds(doc: string): string[] {
  const ids = new Set<string>();
  for (const line of doc.split("\n")) {
    if (!PARITY_PENDING_RE.test(line)) continue;
    for (const m of line.matchAll(/`([a-z0-9]+(?:[_-][a-z0-9]+)+)`/g)) {
      ids.add(m[1]);
    }
  }
  return [...ids];
}

/** Every id the manifest accounts for (entries, deferred, context-only). */
export function coveredIds(): Set<string> {
  const out = new Set<string>([
    ...SMOKE_DEFERRED.map((d) => d.id),
    ...SMOKE_CONTEXT_ONLY,
  ]);
  for (const e of SMOKE_MANIFEST) {
    out.add(e.kind === "action" ? e.action : e.toolId);
    if (e.kind === "action" && typeof e.params.preset === "string")
      out.add(e.params.preset);
  }
  return out;
}

/**
 * --param <entryId>:<key>=<value>: override one param of an action entry (or
 * one option of a tool entry) for a quality pass, e.g.
 * action.video_object_remove:target=red car. Values that look like numbers
 * or true/false are coerced; everything else stays a string.
 */
export function applySmokeParamOverride(spec: string): void {
  const m = /^([^:=\s]+):([A-Za-z_][\w]*)=(.*)$/.exec(spec);
  if (!m) throw new Error(`--param wants <entryId>:<key>=<value>, got "${spec}"`);
  const [, id, key, raw] = m;
  const entry = SMOKE_MANIFEST.find((e) => e.id === id);
  if (!entry) throw new Error(`--param: no manifest entry "${id}"`);
  const value: unknown =
    raw === "true" ? true
    : raw === "false" ? false
    : raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw)
    : raw;
  if (entry.kind === "action") entry.params = { ...entry.params, [key]: value };
  else entry.options = { ...(entry.options ?? {}), [key]: value };
}
