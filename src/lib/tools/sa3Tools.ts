/**
 * Tools → Audio cards for Stable Audio 3 Medium (src/lib/oj/sa3Audio.ts):
 * Music & sound, Restyle audio, Fix a section, Extend audio.
 *
 * Speed (Fast / Quality), the optional audio LoRA and the section picker are
 * rendered by components/tools/Sa3AudioControls.tsx and live in
 * ToolSettings.picks under SA3_PICK. Only type imports from toolsPage (it
 * spreads SA3_TOOL_SPECS into ACTION_TOOLS at load time).
 */
import type {
  ActionRequest,
  ActionSlider,
  ActionTextKnob,
  ActionToolSpec,
  ToolSettings,
} from "./toolsPage";
import {
  SA3_A2A_ACTION,
  SA3_DURATION,
  SA3_EXTEND_ACTION,
  SA3_EXTEND_TOTAL,
  SA3_INPAINT_ACTION,
  SA3_LORA_STRENGTH,
  SA3_STRENGTH,
  SA3_T2A_ACTION,
  isAudioLora,
  parseAudioRegions,
  formatAudioRegions,
} from "@/lib/oj/sa3Params";

export const SA3_TOOL_IDS = [
  SA3_T2A_ACTION,
  SA3_A2A_ACTION,
  SA3_INPAINT_ACTION,
  SA3_EXTEND_ACTION,
] as const;
export type Sa3ToolId = (typeof SA3_TOOL_IDS)[number];

export function isSa3Tool(id: string | undefined | null): id is Sa3ToolId {
  return (SA3_TOOL_IDS as readonly string[]).includes(id ?? "");
}

/** ToolSettings.picks keys owned by Sa3AudioControls. */
export const SA3_PICK = {
  speed: "sa3Speed",
  lora: "sa3Lora",
  loraStrength: "sa3LoraStrength",
  regions: "regions",
} as const;

/**
 * Saved picks that would fail at run time once the server says what is
 * actually installed: a "quality" speed without its checkpoint, or a LoRA that
 * was deleted (or restored from a "Made with" recipe on another machine).
 * Returns the [key, value] resets to apply; empty while options are unknown.
 */
export function staleSa3PickResets(
  picks: Record<string, string>,
  opts: { loras: string[]; quality: boolean; reachable: boolean },
): Array<[string, string]> {
  if (!opts.reachable) return [];
  const out: Array<[string, string]> = [];
  if (picks[SA3_PICK.speed] === "quality" && !opts.quality)
    out.push([SA3_PICK.speed, "fast"]);
  const lora = picks[SA3_PICK.lora];
  if (lora && !opts.loras.includes(lora)) out.push([SA3_PICK.lora, ""]);
  return out;
}

const AVOID: ActionTextKnob = {
  label: "Avoid",
  placeholder: "vocals, distortion, crowd noise",
  required: false,
  compact: true,
};

const AUDIO_NOTE =
  "wav, mp3, m4a or flac, up to about 6 minutes. Pick an audio item in the gallery and choose Tools to bring it here.";

const durationSlider: ActionSlider = {
  key: "duration",
  title: "Length",
  min: SA3_DURATION.min,
  max: SA3_DURATION.max,
  step: 1,
  default: SA3_DURATION.default,
  unit: " s",
};

const strengthSlider: ActionSlider = {
  key: "strength",
  title: "How much to change",
  min: SA3_STRENGTH.min,
  max: SA3_STRENGTH.max,
  step: 0.05,
  default: SA3_STRENGTH.default,
};

const totalSlider: ActionSlider = {
  key: "total",
  title: "New total length",
  min: SA3_EXTEND_TOTAL.min,
  max: SA3_EXTEND_TOTAL.max,
  step: 1,
  default: SA3_EXTEND_TOTAL.default,
  unit: " s",
};

export const SA3_TOOL_SPECS: ActionToolSpec[] = [
  {
    id: SA3_T2A_ACTION,
    title: "Music & sound",
    subtitle:
      "Music, ambience or sound effects from a description, up to 6 min",
    category: "Audio",
    icon: "AudioWaveform",
    noSourceInput: true,
    text: {
      label: "Describe it",
      placeholder: "warm lo-fi hip hop, dusty vinyl, mellow Rhodes, 84 BPM",
      required: true,
      hint: "Genre, instruments, mood and tempo. Works for sound effects and ambience too.",
    },
    secondText: AVOID,
    sliders: [durationSlider],
    modelCheck: { pack: "audio", action: SA3_T2A_ACTION },
    requireStatusEntry: true,
  },
  {
    id: SA3_A2A_ACTION,
    title: "Restyle audio",
    subtitle: "Give a track or sound a new style while keeping its shape",
    category: "Audio",
    icon: "WandSparkles",
    noSourceInput: true,
    audioInput: "Audio to restyle",
    audioNote: AUDIO_NOTE,
    audioHandoff: true,
    text: {
      label: "New style",
      placeholder:
        "the same groove as a jazzy live trio, upright bass, brushed drums",
      required: true,
      hint: "Describe how the result should sound.",
    },
    secondText: AVOID,
    sliders: [strengthSlider],
    modelCheck: { pack: "audio", action: SA3_A2A_ACTION },
    requireStatusEntry: true,
  },
  {
    id: SA3_INPAINT_ACTION,
    title: "Fix a section",
    subtitle: "Redo only the parts you pick; the rest stays exactly as it was",
    category: "Audio",
    icon: "PencilLine",
    noSourceInput: true,
    audioInput: "Audio to fix",
    audioNote: AUDIO_NOTE,
    audioHandoff: true,
    text: {
      label: "What the track sounds like",
      placeholder: "warm lo-fi hip hop, a dreamy saxophone solo enters, 84 BPM",
      required: false,
      hint: "Describe the whole track and what should happen in the picked parts.",
    },
    secondText: AVOID,
    modelCheck: { pack: "audio", action: SA3_INPAINT_ACTION },
    requireStatusEntry: true,
  },
  {
    id: SA3_EXTEND_ACTION,
    title: "Extend audio",
    subtitle: "Keep a track or sound going to a longer length",
    category: "Audio",
    icon: "Expand",
    noSourceInput: true,
    audioInput: "Audio to extend",
    audioNote: AUDIO_NOTE,
    audioHandoff: true,
    text: {
      label: "How it continues",
      placeholder: "the beat keeps going, a soft piano melody joins",
      required: false,
      hint: "Describe the whole track; the new part follows it.",
    },
    secondText: AVOID,
    sliders: [totalSlider],
    modelCheck: { pack: "audio", action: SA3_EXTEND_ACTION },
    requireStatusEntry: true,
  },
];

function sliderNumber(slider: ActionSlider, settings: ToolSettings): number {
  const raw = settings.picks[slider.key];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return slider.default;
  return Math.min(slider.max, Math.max(slider.min, n));
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * /api/jobs/action request for an SA3 card. `fail` builds the error the
 * runner shows inline (toolsPage passes ToolInputError).
 */
export function buildSa3Request(
  spec: ActionToolSpec,
  settings: ToolSettings,
  audio: { ref: string; seconds?: number } | undefined,
  fail: (message: string) => Error,
): ActionRequest {
  const id = spec.id as Sa3ToolId;
  const picks = settings.picks;
  const params: Record<string, unknown> = {
    pack_id: "audio",
    prompt: settings.text.trim(),
    speed: picks[SA3_PICK.speed] === "quality" ? "quality" : "fast",
  };
  const negative = settings.secondText?.trim();
  if (negative) params.negative = negative;
  const lora = picks[SA3_PICK.lora];
  if (lora && isAudioLora(lora)) {
    params.lora = lora;
    const s = Number(picks[SA3_PICK.loraStrength]);
    params.loraStrength = Number.isFinite(s)
      ? Math.min(SA3_LORA_STRENGTH.max, Math.max(SA3_LORA_STRENGTH.min, s))
      : SA3_LORA_STRENGTH.default;
  }
  if (settings.seed !== undefined) params.seed = settings.seed;

  if (id === SA3_T2A_ACTION) {
    params.duration = sliderNumber(durationSlider, settings);
    return { action: id, params, overrides: {} };
  }

  if (!audio?.ref)
    throw fail(`Add the ${spec.audioInput?.toLowerCase() ?? "audio"} first.`);
  params.audioRef = audio.ref;
  const src = audio.seconds && audio.seconds > 0 ? audio.seconds : undefined;
  if (src) params.seconds = src;

  if (id === SA3_A2A_ACTION) {
    params.strength = sliderNumber(strengthSlider, settings);
  } else if (id === SA3_INPAINT_ACTION) {
    let regions;
    try {
      regions = parseAudioRegions(picks[SA3_PICK.regions] ?? "");
    } catch (e) {
      throw fail((e as Error).message);
    }
    if (!regions.length)
      throw fail(
        "Pick at least one section to fix (drag on the waveform, or type 4-8).",
      );
    if (src && regions.some((r) => r.start >= src))
      throw fail(
        `A section starts after the end of the audio (${fmt(src)} s).`,
      );
    params.regions = formatAudioRegions(regions);
  } else if (id === SA3_EXTEND_ACTION) {
    const total = sliderNumber(totalSlider, settings);
    if (src && total <= src)
      throw fail(`Set the new length above the audio's ${fmt(src)} s.`);
    params.total = total;
  }
  return { action: id, params, overrides: {} };
}
