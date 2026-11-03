/**
 * Train audio LoRA (Stable Audio 3): pure rules shared by the runner, the
 * /api/tools/audio-lora route and tests. The ComfyUI node is
 * CJSA3TrainAudioLoRA (comfy_nodes/cj_sa3_audio/train_node.py); its limits
 * are mirrored here so bad input fails before anything is uploaded.
 */

export const AUDIO_LORA_NODE = "CJSA3TrainAudioLoRA";
/** Clips go to ComfyUI input/<this>/<name>/ (allowlisted in uploadName.ts). */
export const AUDIO_LORA_INPUT_ROOT = "sa3_train";
/** Trained files land in models/loras/<this>/ (what the SA3 audio tools list). */
export const AUDIO_LORA_FOLDER = "audio";

export const AUDIO_LORA_MIN_CLIPS = 5;
export const AUDIO_LORA_MAX_CLIPS = 50;
/** Same cap as POST /api/comfy/upload. */
export const AUDIO_LORA_MAX_CLIP_BYTES = 32 * 1024 * 1024;
/** Formats both the upload route and the SA3 dataset loader accept. */
export const AUDIO_LORA_EXTS = ["wav", "mp3", "flac"] as const;
export const AUDIO_LORA_ACCEPT =
  ".wav,.mp3,.flac,audio/wav,audio/x-wav,audio/wave,audio/mpeg,audio/flac,audio/x-flac";
export const AUDIO_LORA_MAX_CAPTION = 300;

export type AudioLoraBase =
  "medium-base" | "small-music-base" | "small-sfx-base";
export type AudioLoraAdapter = "lora" | "dora-rows";
export type AudioLoraPreset = "quick" | "balanced" | "detailed";

export const AUDIO_LORA_BASES: { id: AudioLoraBase; label: string }[] = [
  { id: "medium-base", label: "Medium" },
  { id: "small-music-base", label: "Small music" },
  { id: "small-sfx-base", label: "Small SFX" },
];

export const AUDIO_LORA_ADAPTERS: { id: AudioLoraAdapter; label: string }[] = [
  { id: "lora", label: "LoRA" },
  { id: "dora-rows", label: "DoRA" },
];

export interface AudioLoraSettings {
  steps: number;
  rank: number;
  lr: number;
}

/** Sized for one 24 GB card at batch 1, 30 s crops. */
export const AUDIO_LORA_PRESETS: {
  id: AudioLoraPreset;
  label: string;
  hint: string;
  settings: AudioLoraSettings;
}[] = [
  {
    id: "quick",
    label: "Quick",
    hint: "500 steps, rank 16. A fast first try to hear if your clips work.",
    settings: { steps: 500, rank: 16, lr: 2e-4 },
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "1500 steps, rank 32. A good default for most sound sets.",
    settings: { steps: 1500, rank: 32, lr: 1e-4 },
  },
  {
    id: "detailed",
    label: "Detailed",
    hint: "3000 steps, rank 64. Learns finer detail; takes about twice as long.",
    settings: { steps: 3000, rank: 64, lr: 7e-5 },
  },
];

export const AUDIO_LORA_DURATION = 30;
export const AUDIO_LORA_BATCH = 1;

export const AUDIO_LORA_LIMITS = {
  rank: { min: 1, max: 256 },
  steps: { min: 10, max: 50000 },
  lr: { min: 1e-7, max: 1e-2 },
} as const;

export function presetSettings(preset: AudioLoraPreset): AudioLoraSettings {
  const p =
    AUDIO_LORA_PRESETS.find((x) => x.id === preset) ?? AUDIO_LORA_PRESETS[1];
  return { ...p.settings };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** "My Drums v2" -> "My_Drums_v2"; same rule as the node's sanitize_name. */
export function sanitizeLoraName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/^[_-]+/, "")
    .slice(0, 64);
}

export function isValidLoraName(name: string): boolean {
  return NAME_RE.test(name);
}

export function audioClipExt(filename: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  const ext = m?.[1]?.toLowerCase() ?? "";
  return (AUDIO_LORA_EXTS as readonly string[]).includes(ext) ? ext : null;
}

/** "03_Warm-Rhodes_loop.wav" -> "warm rhodes loop" (matches the node's fallback). */
export function defaultCaption(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]*$/, "").replace(/^\d{1,3}_/, "");
  const words = stem
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words || "audio clip";
}

/**
 * Upload filename for clip i: "NN_<safe stem>.<ext>". The index keeps names
 * unique; the node strips it again when it derives a caption.
 */
export function clipUploadName(index: number, filename: string): string {
  const ext = audioClipExt(filename) ?? "wav";
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const stem =
    base
      .replace(/\.[^.]*$/, "")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "clip";
  return `${String(index + 1).padStart(2, "0")}_${stem}.${ext}`;
}

export function datasetFolder(name: string): string {
  return `${AUDIO_LORA_INPUT_ROOT}/${name}`;
}

export interface AudioLoraClipInput {
  filename: string;
  size: number;
  caption: string;
}

export interface AudioLoraInput {
  name: string;
  base: AudioLoraBase;
  adapter: AudioLoraAdapter;
  rank: number;
  lr: number;
  steps: number;
  clips: AudioLoraClipInput[];
  seed?: number;
}

/** First problem as a short user-facing sentence, or null when ready. */
export function validateAudioLoraInput(input: AudioLoraInput): string | null {
  if (!input.name) return "Give the LoRA a name.";
  if (!isValidLoraName(input.name))
    return "Name: letters, numbers, _ or - only (up to 64).";
  if (input.clips.length < AUDIO_LORA_MIN_CLIPS)
    return `Add at least ${AUDIO_LORA_MIN_CLIPS} clips (${input.clips.length} so far).`;
  if (input.clips.length > AUDIO_LORA_MAX_CLIPS)
    return `Use at most ${AUDIO_LORA_MAX_CLIPS} clips.`;
  for (const c of input.clips) {
    if (!audioClipExt(c.filename))
      return `${c.filename}: use WAV, MP3 or FLAC.`;
    if (c.size > AUDIO_LORA_MAX_CLIP_BYTES)
      return `${c.filename} is over 32 MB.`;
    if (c.size <= 0) return `${c.filename} is empty.`;
    if (c.caption.length > AUDIO_LORA_MAX_CAPTION)
      return `Captions can be up to ${AUDIO_LORA_MAX_CAPTION} characters.`;
  }
  if (!AUDIO_LORA_BASES.some((b) => b.id === input.base))
    return "Pick a base model.";
  if (!AUDIO_LORA_ADAPTERS.some((a) => a.id === input.adapter))
    return "Pick an adapter type.";
  const L = AUDIO_LORA_LIMITS;
  if (
    !Number.isInteger(input.rank) ||
    input.rank < L.rank.min ||
    input.rank > L.rank.max
  )
    return `Rank must be ${L.rank.min}-${L.rank.max}.`;
  if (
    !Number.isInteger(input.steps) ||
    input.steps < L.steps.min ||
    input.steps > L.steps.max
  )
    return `Steps must be ${L.steps.min}-${L.steps.max}.`;
  if (!Number.isFinite(input.lr) || input.lr < L.lr.min || input.lr > L.lr.max)
    return "Learning rate must be between 0.0000001 and 0.01.";
  return null;
}

export type AudioLoraWorkflow = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title: string };
  }
>;

/**
 * One-node graph. `captions` maps each uploaded filename to its caption
 * (empty -> the node derives one from the filename); the node then trains on
 * exactly those files, so leftovers in a reused folder are ignored.
 */
export function buildAudioLoraGraph(args: {
  name: string;
  base: AudioLoraBase;
  adapter: AudioLoraAdapter;
  rank: number;
  lr: number;
  steps: number;
  captions: Record<string, string>;
  seed?: number;
}): AudioLoraWorkflow {
  return {
    "1": {
      class_type: AUDIO_LORA_NODE,
      inputs: {
        name: args.name,
        dataset: datasetFolder(args.name),
        captions: JSON.stringify(args.captions),
        base: args.base,
        adapter_type: args.adapter,
        rank: args.rank,
        alpha: 0,
        steps: args.steps,
        lr: args.lr,
        batch_size: AUDIO_LORA_BATCH,
        duration: AUDIO_LORA_DURATION,
        seed: args.seed ?? 42,
      },
      _meta: { title: "Train audio LoRA" },
    },
  };
}

export interface AudioLoraResult {
  lora: string;
  summary: string;
}

/** Pull {lora, summary} out of a ComfyUI history entry's outputs, or null. */
export function parseAudioLoraOutputs(
  outputs: unknown,
): AudioLoraResult | null {
  if (!outputs || typeof outputs !== "object") return null;
  for (const out of Object.values(outputs as Record<string, unknown>)) {
    const o = out as { cj_sa3_lora?: unknown; text?: unknown } | null;
    const report = Array.isArray(o?.cj_sa3_lora) ? o.cj_sa3_lora[0] : null;
    const lora = (report as { lora?: unknown } | null)?.lora;
    if (typeof lora === "string" && lora) {
      const text = Array.isArray(o?.text) ? o.text[0] : null;
      return { lora, summary: typeof text === "string" ? text : "" };
    }
  }
  return null;
}

/** ComfyUI's execution_error message from a history entry's status, if any. */
export function historyErrorMessage(status: unknown): string | null {
  const s = status as { status_str?: unknown; messages?: unknown } | null;
  if (!s || s.status_str !== "error") return null;
  if (Array.isArray(s.messages)) {
    for (const m of s.messages) {
      if (Array.isArray(m) && m[0] === "execution_error") {
        const msg = (m[1] as { exception_message?: unknown } | null)
          ?.exception_message;
        if (typeof msg === "string" && msg.trim())
          return msg.trim().slice(0, 1200);
      }
      if (Array.isArray(m) && m[0] === "execution_interrupted")
        return "Training was stopped.";
    }
  }
  return "Training failed. Check the ComfyUI log for details.";
}

export type AudioLoraPhase =
  | "uploading"
  | "queued"
  | "preparing"
  | "training"
  | "saving"
  | "done"
  | "error"
  | "cancelled";

export interface AudioLoraProgress {
  phase: AudioLoraPhase;
  done?: number;
  total?: number;
}

/** One line of status text for the run footer. */
export function audioLoraStageText(p: AudioLoraProgress): string {
  switch (p.phase) {
    case "uploading":
      return `Uploading clips (${p.done ?? 0}/${p.total ?? 0})...`;
    case "queued":
      return "Waiting for the GPU (other jobs are ahead in the queue)...";
    case "preparing":
      return "Preparing clips (encoding audio, loading the model)...";
    case "training": {
      const done = p.done ?? 0;
      const total = p.total ?? 0;
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      return `Training: step ${done}/${total} (${pct}%)`;
    }
    case "saving":
      return "Saving the LoRA...";
    case "done":
      return "Done.";
    case "cancelled":
      return "Stopped.";
    default:
      return "Training failed.";
  }
}
