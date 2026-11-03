/**
 * Voiceover engines + stock voices (dependency-free so the client Tools page
 * can import it). Builder: ./voiceSound.ts.
 *
 *   stock  VibeVoice-Realtime-0.5B + a cached voice prompt
 *          (models/tts/VibeVoice/voices/<id>.pt; microsoft/VibeVoice
 *          demo/voices/streaming_model, MIT). Works with no upload.
 *   clone  VibeVoice-1.5B cloning an uploaded voice sample.
 *   kokoro Kokoro-82M (CJKokoroTTS) + one of its bundled voices; CPU-fast.
 */
export type VoiceoverEngine = "stock" | "clone" | "kokoro";
export const VOICEOVER_STOCK_MODEL = "VibeVoice-Realtime-0.5B";
export const VOICEOVER_CLONE_MODEL = "VibeVoice-1.5B";

/**
 * Stock voices = file stems of microsoft/VibeVoice demo/voices/streaming_model
 * (cached prompts for VibeVoice-Realtime-0.5B), English first. The id is the
 * VibeVoiceTTS voice_preset value.
 */
const STOCK_VOICE_IDS = [
  "en-Emma_woman",
  "en-Grace_woman",
  "en-Carter_man",
  "en-Davis_man",
  "en-Frank_man",
  "en-Mike_man",
  "in-Samuel_man",
  "de-Spk0_man",
  "de-Spk1_woman",
  "fr-Spk0_man",
  "fr-Spk1_woman",
  "it-Spk0_woman",
  "it-Spk1_man",
  "jp-Spk0_man",
  "jp-Spk1_woman",
  "kr-Spk0_woman",
  "kr-Spk1_man",
  "nl-Spk0_man",
  "nl-Spk1_woman",
  "pl-Spk0_man",
  "pl-Spk1_woman",
  "pt-Spk0_woman",
  "pt-Spk1_man",
  "sp-Spk0_woman",
  "sp-Spk1_man",
] as const;

const VOICE_LANGS: Record<string, string> = {
  en: "English",
  in: "English, Indian",
  de: "German",
  fr: "French",
  it: "Italian",
  jp: "Japanese",
  kr: "Korean",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  sp: "Spanish",
};

/** "en-Emma_woman" → "Emma (English, woman)"; "de-Spk1_woman" → "Voice 2 (German, woman)". */
export function stockVoiceLabel(id: string): string {
  const m = /^([a-z]{2})-([A-Za-z0-9]+)_(man|woman)$/.exec(id);
  if (!m) return id;
  const [, lang, who, sex] = m;
  const spk = /^Spk(\d+)$/.exec(who);
  const name = spk ? `Voice ${Number(spk[1]) + 1}` : who;
  return `${name} (${VOICE_LANGS[lang] ?? lang}, ${sex})`;
}

export const VOICEOVER_STOCK_VOICES: ReadonlyArray<{
  id: string;
  label: string;
}> = STOCK_VOICE_IDS.map((id) => ({ id, label: stockVoiceLabel(id) }));
export const VOICEOVER_DEFAULT_VOICE: string = STOCK_VOICE_IDS[0];


/**
 * Kokoro engine: hexgrad/Kokoro-82M (Apache-2.0) via comfy_nodes/cj_kokoro_tts
 * (CJKokoroTTS, own py<=3.12 venv, CPU is enough). Ids = files in
 * models/tts/kokoro/Kokoro-82M/voices; first letter = language, second =
 * f/m. Japanese / Chinese voices are left out (need misaki[ja]/[zh]).
 */
export const VOICEOVER_KOKORO_NODE = "CJKokoroTTS";
const KOKORO_VOICE_IDS = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
  "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
  "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "em_santa", "ff_siwis",
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  "if_sara", "im_nicola", "pf_dora", "pm_alex", "pm_santa",
] as const;

const KOKORO_LANGS: Record<string, string> = {
  a: "US English",
  b: "UK English",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  p: "Portuguese, BR",
};

/** "af_heart" → "Heart (US English, woman)". */
export function kokoroVoiceLabel(id: string): string {
  const m = /^([a-z])([fm])_([a-z]+)$/.exec(id);
  if (!m) return id;
  const [, lang, sex, name] = m;
  return `${name[0].toUpperCase()}${name.slice(1)} (${KOKORO_LANGS[lang] ?? lang}, ${sex === "f" ? "woman" : "man"})`;
}

export const VOICEOVER_KOKORO_VOICES: ReadonlyArray<{
  id: string;
  label: string;
}> = KOKORO_VOICE_IDS.map((id) => ({ id, label: kokoroVoiceLabel(id) }));
export const VOICEOVER_KOKORO_DEFAULT_VOICE: string = KOKORO_VOICE_IDS[0];
