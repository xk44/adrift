/**
 * Stable Audio 3 tool parameters with no graph code: action ids, checkpoint
 * names, slider ranges, the regions grammar and LoRA / UI helpers. Safe for
 * client bundles (toolsPage, Sa3AudioControls); sa3Audio.ts re-exports it
 * and adds the graph builders.
 */
export { SA3_DURATION } from "./audioDuration";

export const SA3_T2A_ACTION = "sa3_t2a";
export const SA3_A2A_ACTION = "sa3_a2a";
export const SA3_INPAINT_ACTION = "sa3_inpaint";
export const SA3_EXTEND_ACTION = "sa3_extend";
export const SA3_ACTIONS: readonly string[] = [
  SA3_T2A_ACTION,
  SA3_A2A_ACTION,
  SA3_INPAINT_ACTION,
  SA3_EXTEND_ACTION,
];

export const SA3_MEDIUM_CKPT = "stable_audio_3_medium.safetensors";
export const SA3_MEDIUM_BASE_CKPT = "stable_audio_3_medium_base.safetensors";
export const SA3_SMALL_SFX_CKPT = "stable_audio_3_small_sfx.safetensors";

/** Pack graphs (relative to public/workflows). */
export const SA3_T2A_GRAPH = "packs/audio/sa3_t2a.json";
export const SFX_GRAPH = "packs/audio/sfx.json";

/** Restyle strength = KSampler denoise. */
export const SA3_STRENGTH = { min: 0.3, max: 0.95, default: 0.6 };
/** Extend: target total length of the result. */
export const SA3_EXTEND_TOTAL = { min: 2, max: 380, default: 60 };
export const SA3_LORA_STRENGTH = { min: 0, max: 1.5, default: 1 };
export const SA3_CROSSFADE_MS = 60;
/** Folder under models/loras that holds Stable Audio LoRAs. */
export const AUDIO_LORA_PREFIX = "audio/";

export type Sa3Speed = "fast" | "quality";
export const SA3_SPEEDS: Record<
  Sa3Speed,
  { ckpt: string; steps: number; cfg: number }
> = {
  fast: { ckpt: SA3_MEDIUM_CKPT, steps: 8, cfg: 1 },
  quality: { ckpt: SA3_MEDIUM_BASE_CKPT, steps: 50, cfg: 7 },
};

// Regions ("4-8; 14.5-18"), the same grammar as cj_sa3_audio/regions.py
export interface AudioRegion {
  start: number;
  end: number;
}

const PAIR = /^\s*(\d+(?:\.\d+)?)\s*(?:-|to|\.\.)\s*(\d+(?:\.\d+)?)\s*$/;

/** Parse "4-8; 14.5-18" (commas, semicolons or new lines) → sorted ranges. */
export function parseAudioRegions(input: string): AudioRegion[] {
  const out: AudioRegion[] = [];
  for (const part of (input ?? "").split(/[;,\n]+/)) {
    if (!part.trim()) continue;
    const m = PAIR.exec(part);
    if (!m)
      throw new Error(
        `"${part.trim()}" is not a range; use start-end in seconds, e.g. 4-8`,
      );
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (end <= start) throw new Error(`"${part.trim()}" ends before it starts`);
    out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function fmtSeconds(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** Ranges → canonical "4-8; 14.5-18" (the string the nodes receive). */
export function formatAudioRegions(regions: AudioRegion[]): string {
  return regions
    .map((r) => `${fmtSeconds(r.start)}-${fmtSeconds(r.end)}`)
    .join("; ");
}

/** Add a range, merging any it overlaps or touches. */
export function addAudioRegion(
  regions: AudioRegion[],
  next: AudioRegion,
): AudioRegion[] {
  const all = [...regions, next].sort((a, b) => a.start - b.start);
  const out: AudioRegion[] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** "audio/x.safetensors" (either slash) → true; anything outside audio/ → false. */
export function isAudioLora(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const n = name.replace(/\\/g, "/");
  return (
    n.startsWith(AUDIO_LORA_PREFIX) &&
    !n.includes("..") &&
    /\.safetensors$/i.test(n)
  );
}

/**
 * Graph for `--audio` with no explicit workflow: SA3 medium when its
 * checkpoint is on the backend, else the small SFX pack (always shipped).
 * `checkpoints` = the backend's CheckpointLoaderSimple list (null = unknown).
 */
export function pickAudioWorkflow(
  checkpoints: readonly string[] | null | undefined,
): string {
  const have = (checkpoints ?? []).some(
    (c) =>
      c.replace(/\\/g, "/").split("/").pop()?.toLowerCase() === SA3_MEDIUM_CKPT,
  );
  return have ? SA3_T2A_GRAPH : SFX_GRAPH;
}

/** Plain words for the Restyle strength (denoise) slider. */
export function sa3StrengthLabel(v: number): string {
  if (v < 0.45) return "Light touch: keeps the original, changes the texture";
  if (v < 0.65) return "Balanced: same bones, new sound";
  if (v < 0.8) return "Strong: follows your prompt more than the original";
  return "Almost new: only the rough shape of the original survives";
}

/** Audio LoRAs from LoraLoaderModelOnly's lora_name list (object_info). */
export function audioLorasFromObjectInfo(objectInfo: unknown): string[] {
  const info = objectInfo as
    | Record<string, { input?: { required?: Record<string, unknown> } }>
    | null
    | undefined;
  const spec = info?.LoraLoaderModelOnly?.input?.required?.lora_name;
  const list = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : [];
  return (list as unknown[])
    .filter(isAudioLora)
    .map((n) => n.replace(/\\/g, "/"))
    .sort((a, b) => a.localeCompare(b));
}

/** CheckpointLoaderSimple's ckpt_name list (object_info), or null. */
export function checkpointsFromObjectInfo(
  objectInfo: unknown,
): string[] | null {
  const info = objectInfo as
    | Record<string, { input?: { required?: Record<string, unknown> } }>
    | null
    | undefined;
  const spec = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  if (!Array.isArray(spec) || !Array.isArray(spec[0])) return null;
  return (spec[0] as unknown[]).filter(
    (s): s is string => typeof s === "string",
  );
}
