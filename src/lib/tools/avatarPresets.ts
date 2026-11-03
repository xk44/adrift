/**
 * Talking Avatar presets: ~20 ORIGINAL generated presenters (text only; the
 * portrait is generated first, then it talks) plus gesture / delivery
 * presets composed into the Wan S2V scene prompt. Every avatar is a
 * fictional person described by role and styling; no real people, no
 * characters, no brands.
 *
 * Data + pure helpers only (toolsPage imports this at module init); the
 * network step lives in avatarGenerate.ts.
 */
import type { ActionChoice } from "./toolsPage";

/** Same rule as pipelineRunner.plainPrompt: no parser --flags / :: weights. */
function plain(text: string): string {
  return text
    .replace(/-{2,}/g, " ")
    .replace(/::/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

export interface AvatarPreset {
  id: string;
  label: string;
  group: string;
  /** Who they are and how they look (no name, fictional). */
  description: string;
  /** Default scene line for the talking step. */
  scene: string;
}

const a = (
  group: string,
  id: string,
  label: string,
  description: string,
  scene: string,
): AvatarPreset => ({ id, label, group, description, scene });

export const AVATAR_PRESETS: AvatarPreset[] = [
  // Presenters
  a(
    "Presenters",
    "news_anchor",
    "News anchor",
    "a poised news anchor in her forties with a sleek bob haircut, navy blazer, seated at a modern glass desk with soft blue studio screens behind",
    "a news anchor reading the evening headlines",
  ),
  a(
    "Presenters",
    "tech_reviewer",
    "Tech reviewer",
    "a friendly tech reviewer in his late twenties with curly dark hair and round glasses, grey crewneck, a tidy desk with a ring light glow behind",
    "a tech reviewer explaining a new gadget",
  ),
  a(
    "Presenters",
    "weather_host",
    "Weather host",
    "a cheerful weather presenter in her thirties with a high ponytail, bright coral dress, standing in front of a softly blurred map wall",
    "a weather presenter giving the forecast",
  ),
  a(
    "Presenters",
    "podcast_host",
    "Podcast host",
    "a relaxed podcast host in his thirties with a short beard and beanie, flannel shirt, a large studio microphone on a boom arm, warm lamp light",
    "a podcast host talking into a studio microphone",
  ),
  a(
    "Presenters",
    "teacher",
    "Teacher",
    "a warm high-school teacher in her fifties with silver-streaked hair and a cardigan, a chalkboard with faint diagrams behind",
    "a teacher explaining a lesson to the class",
  ),
  a(
    "Presenters",
    "coach",
    "Fitness coach",
    "an energetic fitness coach in his twenties with a shaved head and athletic tank top, a bright gym with plants behind",
    "a fitness coach motivating the viewer",
  ),
  // Business
  a(
    "Business",
    "founder",
    "Startup founder",
    "a confident startup founder in her thirties with braided hair tied back, black turtleneck, a bright loft office with whiteboards",
    "a founder pitching the company vision",
  ),
  a(
    "Business",
    "support_agent",
    "Support agent",
    "a helpful customer support agent in his twenties with a neat side part, light blue shirt and a slim headset, a calm modern office",
    "a support agent walking the viewer through a fix",
  ),
  a(
    "Business",
    "doctor",
    "Doctor",
    "a reassuring family doctor in his fifties with grey temples, white coat over a blue shirt, a clean clinic room",
    "a doctor sharing a health tip",
  ),
  a(
    "Business",
    "realtor",
    "Realtor",
    "an upbeat real estate agent in her forties with shoulder-length waves, cream blazer, standing in a sunlit living room",
    "a realtor giving a home tour",
  ),
  // Creators
  a(
    "Creators",
    "beauty_creator",
    "Beauty creator",
    "a bubbly beauty creator in her twenties with glossy dark hair and soft glam makeup, a vanity with round bulb lights",
    "a beauty creator chatting through a makeup routine",
  ),
  a(
    "Creators",
    "chef",
    "Home chef",
    "a jovial home chef in his sixties with a white mustache and a striped apron, a cozy kitchen with copper pans",
    "a chef explaining a family recipe",
  ),
  a(
    "Creators",
    "gamer",
    "Streamer",
    "an animated streamer in their twenties with dyed teal hair and over-ear headphones, a dark room lit by purple and cyan LEDs",
    "a streamer reacting to a game",
  ),
  a(
    "Creators",
    "travel_vlogger",
    "Travel vlogger",
    "a sun-tanned travel vlogger in her late twenties with freckles and a straw hat, linen shirt, a harbor with boats behind",
    "a travel vlogger talking about the trip",
  ),
  a(
    "Creators",
    "storyteller",
    "Storyteller",
    "a gentle grandmotherly storyteller in her seventies with a silver bun and a knitted shawl, an armchair by a fireplace",
    "a storyteller telling a bedtime story",
  ),
  // Stylized
  a(
    "Stylized",
    "clay_mascot",
    "Clay mascot",
    "a friendly claymation-style round character with big eyes and a tiny smile, soft clay texture, pastel studio backdrop",
    "a clay character talking happily",
  ),
  a(
    "Stylized",
    "anime_host",
    "Anime host",
    "an original anime-style host with short silver hair and a sporty jacket, clean cel shading, a bright city backdrop",
    "an anime host introducing the episode",
  ),
  a(
    "Stylized",
    "robot",
    "Robot guide",
    "a sleek white humanoid robot guide with a glowing blue visor face, soft studio light, minimalist backdrop",
    "a robot guide explaining a feature",
  ),
  a(
    "Stylized",
    "painted_portrait",
    "Painted portrait",
    "an oil-painted portrait of a dignified gentleman in a velvet coat, rich classical brushwork, dark museum backdrop",
    "a painted portrait coming to life and speaking",
  ),
  a(
    "Stylized",
    "fox_character",
    "Fox character",
    "a 3D animated fox character in a cozy knit sweater, expressive face, warm woodland cabin backdrop",
    "a fox character chatting cheerfully",
  ),
];

export function getAvatarPreset(id: string): AvatarPreset | undefined {
  return AVATAR_PRESETS.find((p) => p.id === id);
}

/**
 * Text-to-image prompt for the avatar portrait: front-facing medium shot,
 * mouth closed and hands visible so the talking model has something to move.
 */
export function avatarImagePrompt(
  preset: AvatarPreset,
  extra?: string,
): string {
  const more = plain(extra ?? "").slice(0, 160);
  return [
    `Portrait of ${preset.description}`,
    more,
    "an original fictional person, facing the camera, chest-up framing, relaxed mouth closed, natural expression, sharp focus, even soft light --ar 9:16",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Gesture / delivery presets for the talking step (first = none). */
export const AVATAR_GESTURES: (ActionChoice & { phrase: string })[] = [
  { id: "none", label: "Natural", phrase: "" },
  {
    id: "calm",
    label: "Calm presenter",
    group: "Delivery",
    phrase: "calm and steady delivery, small nods, minimal hand movement",
  },
  {
    id: "energetic",
    label: "Energetic",
    group: "Delivery",
    phrase: "energetic delivery, lively head movement, expressive eyebrows",
  },
  {
    id: "warm",
    label: "Warm and friendly",
    group: "Delivery",
    phrase: "warm friendly smile between phrases, soft head tilts",
  },
  {
    id: "serious",
    label: "Serious",
    group: "Delivery",
    phrase: "serious focused expression, still posture, direct eye contact",
  },
  {
    id: "hands",
    label: "Talks with hands",
    group: "Gestures",
    phrase: "gestures with both hands while explaining, open palms",
  },
  {
    id: "point",
    label: "Points to camera",
    group: "Gestures",
    phrase: "points toward the camera on key words",
  },
  {
    id: "count",
    label: "Counts on fingers",
    group: "Gestures",
    phrase: "counts points on their fingers while talking",
  },
  {
    id: "lean",
    label: "Leans in",
    group: "Gestures",
    phrase: "leans in toward the camera as if sharing a secret",
  },
  {
    id: "laugh",
    label: "Laughs",
    group: "Gestures",
    phrase: "laughs lightly between sentences, shoulders relaxed",
  },
  {
    id: "sing",
    label: "Sings",
    group: "Performance",
    phrase: "singing with feeling, eyes closing on long notes, gentle sway",
  },
  {
    id: "rap",
    label: "Raps",
    group: "Performance",
    phrase:
      "rapping with rhythm, head bobbing to the beat, confident hand moves",
  },
  {
    id: "walk",
    label: "Walk and talk",
    group: "Performance",
    phrase: "walking slowly while talking, camera tracking alongside",
  },
];

/** Scene prompt with the gesture phrase appended (empty when neither). */
export function composeAvatarScene(text: string, gestureId: string): string {
  const phrase = AVATAR_GESTURES.find((g) => g.id === gestureId)?.phrase ?? "";
  return [text.trim(), phrase].filter(Boolean).join(", ");
}
