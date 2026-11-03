/**
 * ASMR sound presets for "Add sound to clip" (MMAudio video-to-audio) and
 * the ASMR app templates. Original wording; each phrase is a close-miked
 * foley description the V2A model scores against the picture. Data only
 * (toolsPage imports this at module init).
 */
import type { ActionChoice } from "./toolsPage";

export interface AsmrSound extends ActionChoice {
  /** Foley description sent as the add_sound prompt. */
  phrase: string;
}

/** First entry = no preset (the user's text, or the model infers). */
export const ASMR_SOUNDS: AsmrSound[] = [
  { id: "none", label: "None (describe below)", phrase: "" },
  {
    id: "tapping",
    label: "Fingernail tapping",
    group: "Touch",
    phrase:
      "close-miked ASMR, soft fingernail tapping on a hard surface, crisp gentle taps, quiet room",
  },
  {
    id: "scratching",
    label: "Gentle scratching",
    group: "Touch",
    phrase:
      "close-miked ASMR, light scratching on textured fabric, slow rhythmic strokes",
  },
  {
    id: "brushing",
    label: "Soft brushing",
    group: "Touch",
    phrase:
      "close-miked ASMR, a soft makeup brush sweeping across a microphone, airy whooshes",
  },
  {
    id: "crinkle",
    label: "Crinkling",
    group: "Touch",
    phrase:
      "close-miked ASMR, crinkling cellophane and paper, delicate crackles",
  },
  {
    id: "slicing",
    label: "Slicing",
    group: "Kitchen",
    phrase:
      "close-miked ASMR, a sharp knife slicing through crisp food on a wooden board, clean cuts",
  },
  {
    id: "crunch",
    label: "Crunchy bites",
    group: "Kitchen",
    phrase:
      "close-miked ASMR eating sounds, crunchy bites, no talking, quiet room",
  },
  {
    id: "pouring",
    label: "Pouring",
    group: "Kitchen",
    phrase:
      "close-miked ASMR, liquid pouring into a glass, fizzing and soft clinks",
  },
  {
    id: "sizzle",
    label: "Sizzling",
    group: "Kitchen",
    phrase: "close-miked ASMR, gentle sizzling in a pan, soft bubbling",
  },
  {
    id: "soap",
    label: "Soap cutting",
    group: "Satisfying",
    phrase:
      "close-miked ASMR, cutting dry soap cubes, crumbly scrapes and soft thuds",
  },
  {
    id: "slime",
    label: "Squishy slime",
    group: "Satisfying",
    phrase:
      "close-miked ASMR, squishing and stretching thick slime, wet pops and clicks",
  },
  {
    id: "sand",
    label: "Kinetic sand",
    group: "Satisfying",
    phrase:
      "close-miked ASMR, a spatula pressing and cutting kinetic sand, soft grainy crunches",
  },
  {
    id: "keyboard",
    label: "Keyboard typing",
    group: "Satisfying",
    phrase:
      "close-miked ASMR, slow typing on a mechanical keyboard, thocky clicks",
  },
  {
    id: "pages",
    label: "Page turning",
    group: "Satisfying",
    phrase: "close-miked ASMR, turning thick book pages, papery flutters",
  },
  {
    id: "rain",
    label: "Rain on glass",
    group: "Ambience",
    phrase: "steady rain on a window, soft patter, distant low thunder",
  },
  {
    id: "fire",
    label: "Crackling fire",
    group: "Ambience",
    phrase: "a crackling fireplace, popping embers, warm and calm",
  },
  {
    id: "waves",
    label: "Gentle waves",
    group: "Ambience",
    phrase: "small waves lapping on a pebble shore, calm and slow",
  },
  {
    id: "whisper",
    label: "Soft whispers",
    group: "Voice",
    phrase:
      "close-miked soft unintelligible whispering, breathy and calm, very quiet",
  },
];

/** add_sound prompt: preset phrase first, then the user's own words. */
export function composeAsmrPrompt(presetId: string, text: string): string {
  const phrase = ASMR_SOUNDS.find((s) => s.id === presetId)?.phrase ?? "";
  return [phrase, text.trim()].filter(Boolean).join(", ");
}
