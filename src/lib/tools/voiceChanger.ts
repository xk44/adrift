/**
 * Voice changer: re-voice recorded speech (an audio file, or a clip's own
 * soundtrack) as a target speaker, keeping the words and timing. Pure plan
 * (limits, knobs); the executor is voiceChangerRunner.ts and the graph
 * builders are src/lib/oj/voiceChange.ts.
 *
 *   voice_change        audio in -> ChatterboxVC -> MP3
 *   voice_change_video  clip in  -> ChatterboxVC on its audio -> MP3 + the
 *                       clip remuxed with the converted speech
 *
 * Engine: Resemble AI Chatterbox (MIT) via wildminder/ComfyUI-Chatterbox.
 */

export type VoiceChangeSource = "audio" | "video";
export type VoiceChangeQuality = "fast" | "best";
export type VoiceChangeMatch = "natural" | "balanced" | "strong";

/** Longest speech converted from an audio file (chunked on silences). */
export const VOICE_CHANGE_MAX_AUDIO_SECONDS = 120;
/** Longest clip span re-voiced (frames are decoded for the remux). */
export const VOICE_CHANGE_MAX_VIDEO_SECONDS = 30;
/** Seconds of the target sample used as the voice reference. */
export const VOICE_CHANGE_TARGET_REF_SECONDS = 15;
/** Frame rate of the video remux. */
export const VOICE_CHANGE_FPS = 25;
export const VOICE_CHANGE_MODEL_PACK = "chatterbox_local";

export const VOICE_CHANGE_QUALITIES: readonly {
  id: VoiceChangeQuality;
  label: string;
  /** ChatterboxVC n_timesteps (flow-matching steps). */
  steps: number;
}[] = [
  { id: "fast", label: "Fast", steps: 10 },
  { id: "best", label: "Best", steps: 25 },
];

export const VOICE_CHANGE_MATCHES: readonly {
  id: VoiceChangeMatch;
  label: string;
  /** ChatterboxVC flow_cfg_scale: how hard it pulls toward the target. */
  cfg: number;
}[] = [
  { id: "natural", label: "Natural", cfg: 0.5 },
  { id: "balanced", label: "Balanced", cfg: 0.7 },
  { id: "strong", label: "Strong", cfg: 1.0 },
];

export const VOICE_CHANGE_DEFAULT_QUALITY: VoiceChangeQuality = "fast";
export const VOICE_CHANGE_DEFAULT_MATCH: VoiceChangeMatch = "balanced";

export function voiceChangeSteps(quality: unknown): number {
  return (
    VOICE_CHANGE_QUALITIES.find((q) => q.id === quality) ??
    VOICE_CHANGE_QUALITIES[0]
  ).steps;
}

export function voiceChangeCfg(match: unknown): number {
  return (
    VOICE_CHANGE_MATCHES.find((m) => m.id === match) ?? VOICE_CHANGE_MATCHES[1]
  ).cfg;
}

export function voiceChangeMaxSeconds(source: VoiceChangeSource): number {
  return source === "video"
    ? VOICE_CHANGE_MAX_VIDEO_SECONDS
    : VOICE_CHANGE_MAX_AUDIO_SECONDS;
}

/** Seconds converted: the input length capped by the source kind. */
export function voiceChangeSpan(
  source: VoiceChangeSource,
  seconds?: number | null,
): number {
  const cap = voiceChangeMaxSeconds(source);
  const s =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.min(cap, seconds)
      : cap;
  return Math.round(Math.max(0.5, s) * 100) / 100;
}
