/**
 * Cinema Studio: camera / lens / look / lighting / movement knobs compiled
 * into a short prompt suffix for the video tools. Pure data + compiler; all
 * phrasing is our own. Each knob is optional ("" = leave it to the model).
 */

export type CinemaKey =
  | "shot"
  | "movement"
  | "speed"
  | "camera"
  | "lens"
  | "aperture"
  | "look"
  | "lighting"
  | "era"
  | "genre"
  | "palette"
  | "emotion"
  | "pacing";

export interface CinemaOption {
  id: string;
  label: string;
  /** Phrase appended to the prompt. */
  text: string;
  /** Picker group (optgroup); options of a group are kept contiguous. */
  group?: string;
}

export interface CinemaKnob {
  key: CinemaKey;
  label: string;
  options: CinemaOption[];
}

export type CinemaSettings = Partial<Record<CinemaKey, string>>;

/**
 * Knobs in compile order: framing → motion → capture → look → light, then
 * the story knobs (era → genre → palette → emotion → pacing).
 */
export const CINEMA_KNOBS: CinemaKnob[] = [
  {
    key: "shot",
    label: "Shot size",
    options: [
      {
        id: "extreme_wide",
        label: "Extreme wide",
        text: "extreme wide establishing shot",
      },
      { id: "wide", label: "Wide", text: "wide shot showing the full scene" },
      {
        id: "medium",
        label: "Medium",
        text: "medium shot framed from the waist up",
      },
      {
        id: "medium_close",
        label: "Medium close-up",
        text: "medium close-up from the chest up",
      },
      { id: "close", label: "Close-up", text: "close-up on the face" },
      {
        id: "extreme_close",
        label: "Extreme close-up",
        text: "extreme close-up on a single detail",
      },
      {
        id: "over_shoulder",
        label: "Over the shoulder",
        text: "over-the-shoulder framing",
      },
      {
        id: "low_angle",
        label: "Low angle",
        text: "low-angle shot looking up",
      },
      {
        id: "high_angle",
        label: "High angle",
        text: "high-angle shot looking down",
      },
      {
        id: "top_down",
        label: "Top-down",
        text: "straight-down overhead view",
      },
      {
        id: "dutch_angle",
        label: "Dutch angle",
        text: "dutch angle, the camera rolled off level so the horizon tilts",
      },
    ],
  },
  {
    key: "movement",
    label: "Camera movement",
    options: [
      {
        id: "static",
        label: "Locked off",
        text: "camera locked on a tripod, no movement",
      },
      {
        id: "dolly_in",
        label: "Dolly in",
        text: "smooth dolly move toward the subject",
      },
      {
        id: "dolly_out",
        label: "Dolly out",
        text: "smooth dolly move away from the subject",
      },
      {
        id: "truck",
        label: "Tracking",
        text: "camera tracks sideways alongside the subject",
      },
      {
        id: "crane_up",
        label: "Crane up",
        text: "camera rises on a crane to reveal the scene",
      },
      {
        id: "crane_down",
        label: "Crane down",
        text: "camera descends on a crane toward the subject",
      },
      {
        id: "orbit",
        label: "Orbit",
        text: "camera circles around the subject",
      },
      {
        id: "whip_pan",
        label: "Whip pan",
        text: "fast whip pan with motion blur",
      },
      {
        id: "handheld",
        label: "Handheld",
        text: "handheld camera with natural sway",
      },
      {
        id: "fpv",
        label: "FPV drone",
        text: "fast FPV drone flight weaving through the scene",
      },
      {
        id: "aerial",
        label: "Aerial",
        text: "high aerial drone view gliding over the scene",
      },
      {
        id: "crash_zoom",
        label: "Crash zoom",
        text: "sudden crash zoom into the subject",
      },
      {
        id: "dolly_zoom",
        label: "Dolly zoom",
        text: "dolly zoom, background stretches while the subject holds size",
      },
      {
        id: "rack_focus",
        label: "Rack focus",
        text: "focus racks from foreground to background",
      },
      { id: "tilt_up", label: "Tilt up", text: "camera tilts upward" },
      {
        id: "pan",
        label: "Slow pan",
        text: "slow horizontal pan across the scene",
      },
      {
        id: "snorricam",
        label: "Body-mount (snorricam)",
        text: "body-mounted snorricam, the subject stays locked in frame while the world sways behind them",
      },
      {
        id: "robo_arm",
        label: "Robo arm",
        text: "fast robotic camera arm whips around the subject in a precise sweeping arc and stops sharply",
      },
      {
        id: "through_object",
        label: "Through object",
        text: "camera pushes forward through a gap in a foreground object into the scene",
      },
      {
        id: "hyperlapse",
        label: "Hyperlapse",
        text: "hyperlapse, the camera travels steadily forward while time races",
      },
      {
        id: "wiggle",
        label: "Wiggle",
        text: "wiggle shot, orbit left then orbit right, the camera arcs back and forth around the subject, rocking motion",
      },
    ],
  },
  {
    key: "speed",
    label: "Speed ramp",
    options: [
      { id: "slowmo", label: "Slow motion", text: "smooth slow motion" },
      {
        id: "ramp_down",
        label: "Ramp to slow-mo",
        text: "speed ramps from real time down into slow motion",
      },
      {
        id: "ramp_up",
        label: "Ramp to fast",
        text: "speed ramps from slow motion up to real time",
      },
      {
        id: "timelapse",
        label: "Time-lapse",
        text: "time-lapse, time visibly accelerated",
      },
    ],
  },
  {
    key: "camera",
    label: "Camera body",
    options: [
      {
        id: "digital_cinema",
        label: "Digital cinema",
        text: "captured on a high-end digital cinema camera",
      },
      {
        id: "large_format",
        label: "Large format",
        text: "captured on a large-format sensor with shallow depth",
      },
      {
        id: "film_35",
        label: "35mm film",
        text: "captured on a 35mm film camera",
      },
      {
        id: "film_16",
        label: "16mm film",
        text: "captured on a 16mm film camera",
      },
      {
        id: "film_65",
        label: "65mm film",
        text: "captured on 65mm large-format film",
      },
      {
        id: "vhs",
        label: "VHS camcorder",
        text: "captured on an old VHS camcorder",
      },
      { id: "phone", label: "Phone", text: "captured on a smartphone camera" },
      {
        id: "security",
        label: "Security cam",
        text: "captured on a fixed security camera",
      },
    ],
  },
  {
    key: "lens",
    label: "Lens",
    options: [
      {
        id: "ultra_wide",
        label: "14mm ultra-wide",
        text: "14mm ultra-wide lens",
      },
      { id: "wide", label: "24mm wide", text: "24mm wide lens" },
      { id: "normal", label: "35mm", text: "35mm lens" },
      { id: "standard", label: "50mm", text: "50mm standard lens" },
      { id: "portrait", label: "85mm portrait", text: "85mm portrait lens" },
      {
        id: "tele",
        label: "135mm telephoto",
        text: "135mm telephoto lens with compressed depth",
      },
      {
        id: "anamorphic",
        label: "Anamorphic",
        text: "anamorphic lens with oval bokeh and horizontal flares",
      },
      {
        id: "fisheye",
        label: "Fisheye",
        text: "fisheye lens with curved edges",
      },
      { id: "macro", label: "Macro", text: "macro lens" },
    ],
  },
  {
    key: "aperture",
    label: "Aperture / depth of field",
    options: [
      {
        id: "f1_4",
        label: "f/1.4 very shallow",
        text: "very shallow depth of field, creamy background blur",
      },
      { id: "f2_8", label: "f/2.8 shallow", text: "shallow depth of field" },
      { id: "f5_6", label: "f/5.6 moderate", text: "moderate depth of field" },
      { id: "f11", label: "f/11 deep", text: "deep focus, everything sharp" },
      {
        id: "tilt_shift",
        label: "Tilt-shift",
        text: "tilt-shift miniature focus band",
      },
    ],
  },
  {
    key: "look",
    label: "Film stock / look",
    options: [
      {
        id: "clean",
        label: "Clean digital",
        text: "clean modern digital image",
      },
      {
        id: "warm_negative",
        label: "Warm negative",
        text: "warm color-negative film look with soft grain",
      },
      {
        id: "tungsten",
        label: "Tungsten stock",
        text: "tungsten-balanced film look with cool shadows",
      },
      {
        id: "bleach_bypass",
        label: "Bleach bypass",
        text: "bleach-bypass look, desaturated with harsh contrast",
      },
      {
        id: "technicolor",
        label: "Three-strip color",
        text: "saturated vintage three-strip color",
      },
      {
        id: "bw",
        label: "Black and white",
        text: "black-and-white film with rich grain",
      },
      {
        id: "teal_orange",
        label: "Teal and orange",
        text: "teal-and-orange blockbuster grade",
      },
      {
        id: "faded",
        label: "Faded print",
        text: "faded 1970s print, lifted blacks",
      },
      {
        id: "neon",
        label: "Neon noir",
        text: "neon noir palette of magenta and cyan",
      },
    ],
  },
  {
    key: "lighting",
    label: "Lighting",
    options: [
      {
        id: "golden_hour",
        label: "Golden hour",
        text: "low golden-hour sunlight",
      },
      { id: "blue_hour", label: "Blue hour", text: "soft blue-hour twilight" },
      { id: "overcast", label: "Overcast", text: "soft overcast daylight" },
      {
        id: "three_point",
        label: "Three-point",
        text: "classic three-point studio lighting",
      },
      {
        id: "rembrandt",
        label: "Rembrandt",
        text: "Rembrandt lighting with a triangle of light on the cheek",
      },
      {
        id: "low_key",
        label: "Low key",
        text: "low-key lighting with deep shadows",
      },
      {
        id: "high_key",
        label: "High key",
        text: "bright high-key lighting, few shadows",
      },
      {
        id: "backlit",
        label: "Backlit",
        text: "strong backlight with a glowing rim",
      },
      {
        id: "practical",
        label: "Practicals",
        text: "lit only by practical lamps in the scene",
      },
      {
        id: "neon",
        label: "Neon signs",
        text: "colored light spilling from neon signs",
      },
      {
        id: "volumetric",
        label: "Volumetric",
        text: "volumetric light beams through haze",
      },
      { id: "candle", label: "Candlelight", text: "flickering candlelight" },
    ],
  },
  {
    key: "era",
    label: "Era",
    options: [
      {
        id: "1920s",
        label: "1920s",
        text: "set in the 1920s, period costumes and props",
      },
      {
        id: "1950s",
        label: "1950s",
        text: "set in the 1950s, period costumes and props",
      },
      {
        id: "1960s",
        label: "1960s",
        text: "set in the 1960s, period costumes and props",
      },
      {
        id: "1970s",
        label: "1970s",
        text: "set in the 1970s, period costumes and props",
      },
      {
        id: "1980s",
        label: "1980s",
        text: "set in the 1980s, period costumes and props",
      },
      {
        id: "1990s",
        label: "1990s",
        text: "set in the 1990s, period costumes and props",
      },
      {
        id: "2000s",
        label: "2000s",
        text: "set in the 2000s, period costumes and props",
      },
      { id: "present", label: "Present day", text: "set in the present day" },
      {
        id: "near_future",
        label: "Near future",
        text: "set in the near future, sleek understated technology",
      },
    ],
  },
  {
    key: "genre",
    label: "Genre",
    options: [
      {
        id: "epic",
        label: "Epic",
        text: "epic film, grand scale and sweeping scope",
      },
      {
        id: "drama",
        label: "Drama",
        text: "grounded character drama, naturalistic performances",
      },
      {
        id: "noir",
        label: "Noir",
        text: "film noir mood, hard shadows and moral tension",
      },
      {
        id: "comedy",
        label: "Comedy",
        text: "light comedy tone, bright and playful staging",
      },
      {
        id: "horror",
        label: "Horror",
        text: "horror film dread, unsettling framing and darkness",
      },
      {
        id: "action",
        label: "Action",
        text: "high-energy action film, kinetic and intense",
      },
      {
        id: "sci_fi",
        label: "Sci-fi",
        text: "science-fiction film, otherworldly technology and scale",
      },
      {
        id: "romance",
        label: "Romance",
        text: "romantic film, warm intimate staging",
      },
      {
        id: "documentary",
        label: "Documentary",
        text: "observational documentary feel, unposed and real",
      },
      {
        id: "western",
        label: "Western",
        text: "western film, dusty open frontier",
      },
    ],
  },
  {
    key: "palette",
    label: "Color palette",
    options: [
      {
        id: "teal_orange_blockbuster",
        label: "Teal-orange blockbuster",
        group: "Blockbuster grades",
        text: "color palette of teal shadows against warm orange skin tones, a polished blockbuster grade",
      },
      {
        id: "desert_war",
        label: "Desert war",
        group: "Blockbuster grades",
        text: "color palette of sun-scorched khaki, dust brown and a washed-out sky, a gritty war-film grade",
      },
      {
        id: "steel_rust",
        label: "Steel and rust",
        group: "Blockbuster grades",
        text: "color palette of cold steel grey, rust and diffuse fog",
      },
      {
        id: "crimson_gold",
        label: "Crimson and gold",
        group: "Blockbuster grades",
        text: "color palette of crimson reds, gold and velvet black",
      },
      {
        id: "chrome_blue_thriller",
        label: "Chrome blue thriller",
        group: "Blockbuster grades",
        text: "color palette of cold chrome blues and gunmetal with sharp white highlights",
      },
      {
        id: "hero_primaries",
        label: "Hero primaries",
        group: "Blockbuster grades",
        text: "color palette of bold primary red, blue and yellow with glossy highlights",
      },
      {
        id: "code_green",
        label: "Code green",
        group: "Blockbuster grades",
        text: "color palette tinted a sickly green with dark teal shadows, a digital-dystopia grade",
      },
      {
        id: "silver_retention",
        label: "Silver retention",
        group: "Film processes",
        text: "desaturated silver-retained palette with crushed blacks and metallic skin tones",
      },
      {
        id: "two_strip",
        label: "Two-strip",
        group: "Film processes",
        text: "two-color palette of coral red and cyan-green like early two-strip color film",
      },
      {
        id: "jewel_three_strip",
        label: "Jewel-box three-strip",
        group: "Film processes",
        text: "rich jewel-tone palette of ruby, emerald and sapphire like vintage three-strip color",
      },
      {
        id: "cross_processed",
        label: "Cross-processed",
        group: "Film processes",
        text: "cross-processed palette with yellow-green highlights, magenta shadows and punchy contrast",
      },
      {
        id: "seventies_print",
        label: "Seventies print",
        group: "Film processes",
        text: "faded 1970s print palette of mustard, brown and avocado green with lifted blacks",
      },
      {
        id: "sepia",
        label: "Sepia",
        group: "Film processes",
        text: "warm sepia monochrome palette of browns and cream",
      },
      {
        id: "day_for_night",
        label: "Day for night",
        group: "Film processes",
        text: "day-for-night palette, underexposed deep blue with silvery moonlit highlights",
      },
      {
        id: "neon_wet_street",
        label: "Neon wet street",
        group: "Night and neon",
        text: "color palette of wet black streets with magenta and cyan reflections",
      },
      {
        id: "sodium_night",
        label: "Sodium vapor night",
        group: "Night and neon",
        text: "color palette of sodium-orange lamps against a green-black night",
      },
      {
        id: "glowing_teal",
        label: "Glowing teal",
        group: "Night and neon",
        text: "color palette of glowing teal and electric blue in darkness",
      },
      {
        id: "synth_sunset",
        label: "Synth sunset",
        group: "Night and neon",
        text: "color palette of hot pink, purple and electric orange like a retro synth sunset",
      },
      {
        id: "red_darkroom",
        label: "Red darkroom",
        group: "Night and neon",
        text: "color palette dominated by deep red safelight and black shadows",
      },
      {
        id: "fluorescent_night",
        label: "Fluorescent night shift",
        group: "Night and neon",
        text: "color palette of flat fluorescent green-white light and pallid skin",
      },
      {
        id: "moonlit_blue",
        label: "Moonlit blue",
        group: "Night and neon",
        text: "color palette of cold moonlit blues and silver with inky shadows",
      },
      {
        id: "acid_rain",
        label: "Acid rain",
        group: "Night and neon",
        text: "color palette of acid green and violet neon cutting through rain and haze",
      },
      {
        id: "earthy_ochre",
        label: "Earthy ochre",
        group: "Warm",
        text: "color palette of earthy ochre, umber and burnt sienna",
      },
      {
        id: "dusty_amber",
        label: "Dusty amber",
        group: "Warm",
        text: "color palette of dusty amber, orange haze and bleached bone",
      },
      {
        id: "mustard_yellow",
        label: "Mustard yellow",
        group: "Warm",
        text: "color palette dominated by mustard and lemon yellows",
      },
      {
        id: "chalky_terracotta",
        label: "Chalky terracotta",
        group: "Warm",
        text: "color palette of chalky faded terracotta, sage and cream",
      },
      {
        id: "golden_harvest",
        label: "Golden harvest",
        group: "Warm",
        text: "color palette of honeyed golds, wheat and soft amber sunlight",
      },
      {
        id: "candlelit_umber",
        label: "Candlelit umber",
        group: "Warm",
        text: "color palette of candle-warm umber, brass and deep brown shadows",
      },
      {
        id: "copper_sunset",
        label: "Copper sunset",
        group: "Warm",
        text: "color palette of copper, burnt orange and a dusky magenta sky",
      },
      {
        id: "nordic_frost",
        label: "Nordic frost",
        group: "Cool",
        text: "color palette of icy pale blue, slate and snow white",
      },
      {
        id: "rainy_slate",
        label: "Rainy slate",
        group: "Cool",
        text: "color palette of rain-soaked slate blue, wet asphalt and pale grey sky",
      },
      {
        id: "clinical_white",
        label: "Clinical white",
        group: "Cool",
        text: "color palette of sterile white, pale cyan and stainless steel",
      },
      {
        id: "deep_ocean",
        label: "Deep ocean",
        group: "Cool",
        text: "color palette of deep ocean blues fading to black with faint bioluminescent cyan",
      },
      {
        id: "violet_dusk",
        label: "Violet dusk",
        group: "Cool",
        text: "color palette of dusky violet, rose and deep indigo",
      },
      {
        id: "deep_emerald",
        label: "Deep emerald",
        group: "Nature",
        text: "color palette of deep emerald greens and near-black shadows",
      },
      {
        id: "turquoise_sand",
        label: "Turquoise and sand",
        group: "Nature",
        text: "color palette of turquoise water and sun-baked sand",
      },
      {
        id: "bleached_noon",
        label: "Bleached noon",
        group: "Nature",
        text: "color palette of bleached whites and pale sky blue under hard noon sun",
      },
      {
        id: "autumn_forest",
        label: "Autumn forest",
        group: "Nature",
        text: "color palette of russet, amber and moss-green autumn leaves",
      },
      {
        id: "misty_pine",
        label: "Misty pine",
        group: "Nature",
        text: "color palette of foggy pine green, grey mist and wet bark brown",
      },
      {
        id: "spring_meadow",
        label: "Spring meadow",
        group: "Nature",
        text: "color palette of fresh leaf green, wildflower yellow and soft sky blue",
      },
      {
        id: "volcanic",
        label: "Volcanic",
        group: "Nature",
        text: "color palette of charcoal-black rock and glowing molten orange",
      },
      {
        id: "tropical_jungle",
        label: "Tropical jungle",
        group: "Nature",
        text: "color palette of saturated jungle greens, humid haze and flashes of parrot red",
      },
      {
        id: "plush_pink",
        label: "Plush pink",
        group: "Pastel and pop",
        text: "color palette of plush pinks, magenta and soft cream",
      },
      {
        id: "candy_pastel",
        label: "Candy pastel",
        group: "Pastel and pop",
        text: "color palette of candy pastels, bubblegum pink and mint",
      },
      {
        id: "dollhouse_pastel",
        label: "Dollhouse pastel",
        group: "Pastel and pop",
        text: "color palette of dollhouse pastels, dusty pink, powder blue and pale mustard",
      },
      {
        id: "pop_art",
        label: "Pop art",
        group: "Pastel and pop",
        text: "flat pop-art palette of saturated red, yellow and cyan with hard black contrast",
      },
      {
        id: "retro_diner",
        label: "Retro diner",
        group: "Pastel and pop",
        text: "color palette of cherry red, mint green and chrome like a 1950s diner",
      },
      {
        id: "lavender_haze",
        label: "Lavender haze",
        group: "Pastel and pop",
        text: "dreamy palette of lavender, peach and soft haze",
      },
      {
        id: "cool_grey",
        label: "Cool grey",
        group: "Muted and mono",
        text: "nearly monochrome palette of cool greys with muted skin tones",
      },
      {
        id: "noir_bw",
        label: "Noir black and white",
        group: "Muted and mono",
        text: "high-contrast black-and-white palette with inky blacks and bright whites",
      },
      {
        id: "soft_mono",
        label: "Soft monochrome",
        group: "Muted and mono",
        text: "soft low-contrast monochrome palette of warm greys",
      },
      {
        id: "red_accent",
        label: "Single red accent",
        group: "Muted and mono",
        text: "desaturated black-and-white palette with one vivid red accent",
      },
      {
        id: "muted_olive",
        label: "Muted olive",
        group: "Muted and mono",
        text: "muted palette of olive drab, khaki and dull brown",
      },
      {
        id: "bone_beige",
        label: "Bone and beige",
        group: "Muted and mono",
        text: "minimal palette of bone white, beige and warm stone",
      },
      {
        id: "washed_indie",
        label: "Washed indie",
        group: "Muted and mono",
        text: "washed-out indie palette of pale greens, faded yellow and soft skin tones",
      },
    ],
  },
  {
    key: "emotion",
    label: "Emotion",
    options: [
      {
        id: "joy",
        label: "Joy",
        text: "joyful, uplifting emotional tone",
      },
      {
        id: "tension",
        label: "Tension",
        text: "tense, suspenseful emotional tone",
      },
      {
        id: "melancholy",
        label: "Melancholy",
        text: "melancholic, wistful emotional tone",
      },
      { id: "fear", label: "Fear", text: "fearful, menacing emotional tone" },
      {
        id: "anger",
        label: "Anger",
        text: "angry, confrontational emotional tone",
      },
      {
        id: "wonder",
        label: "Wonder",
        text: "awe and wonder, a sense of discovery",
      },
      {
        id: "tenderness",
        label: "Tenderness",
        text: "tender, intimate emotional tone",
      },
      {
        id: "serenity",
        label: "Serenity",
        text: "serene, peaceful emotional tone",
      },
    ],
  },
  {
    key: "pacing",
    label: "Pacing",
    options: [
      {
        id: "calm",
        label: "Calm",
        text: "calm unhurried pacing, gentle motion",
      },
      {
        id: "dynamic",
        label: "Dynamic",
        text: "dynamic pacing with purposeful energetic motion",
      },
      {
        id: "chaotic",
        label: "Chaotic",
        text: "chaotic frantic pacing, erratic motion",
      },
      {
        id: "single_take",
        label: "Single take",
        text: "one continuous unbroken take",
      },
    ],
  },
];

export const CINEMA_KNOB_KEYS: CinemaKey[] = CINEMA_KNOBS.map((k) => k.key);

export function cinemaKnob(key: CinemaKey): CinemaKnob {
  return CINEMA_KNOBS.find((k) => k.key === key) as CinemaKnob;
}

export function cinemaOption(
  key: CinemaKey,
  id: string | undefined,
): CinemaOption | undefined {
  if (!id) return undefined;
  return cinemaKnob(key).options.find((o) => o.id === id);
}

/**
 * Knobs a tool should hide because the tool already fixes them:
 * camera_move has its own trained-move picker, orbit_360 is a fixed
 * frozen-time orbit (movement + speed would fight the card prompt).
 */
export const CINEMA_TOOL_OMIT: Record<string, CinemaKey[]> = {
  camera_move: ["movement"],
  orbit_360: ["movement", "speed"],
  transition: [],
  animate: [],
};

/** Action tools that get the Cinema Studio panel. */
export function cinemaSupported(toolId: string | undefined): boolean {
  return Boolean(toolId && toolId in CINEMA_TOOL_OMIT);
}

/** Visible knobs for a tool (unknown/undefined tool = all knobs). */
export function cinemaKnobsFor(toolId?: string): CinemaKnob[] {
  const omit = (toolId && CINEMA_TOOL_OMIT[toolId]) || [];
  return CINEMA_KNOBS.filter((k) => !omit.includes(k.key));
}

/**
 * Compile the chosen knobs into one comma-separated phrase in knob order.
 * Unknown ids and omitted keys are ignored; nothing chosen → "".
 */
export function compileCinema(
  settings: CinemaSettings,
  omit: CinemaKey[] = [],
): string {
  return CINEMA_KNOBS.filter((k) => !omit.includes(k.key))
    .map((k) => cinemaOption(k.key, settings[k.key])?.text)
    .filter((t): t is string => Boolean(t))
    .join(", ");
}

/** Append a compiled suffix to the user's prompt as its own sentence. */
export function appendCinema(prompt: string, suffix: string): string {
  const p = prompt.replace(/\s+/g, " ").trim();
  const s = suffix.trim();
  if (!s) return p;
  if (!p) return `${s}.`;
  return `${/[.!?]$/.test(p) ? p : `${p}.`} ${s}.`;
}

/** Number of knobs set to a known option (for the collapsed summary). */
export function cinemaCount(
  settings: CinemaSettings,
  omit: CinemaKey[] = [],
): number {
  return CINEMA_KNOBS.filter(
    (k) => !omit.includes(k.key) && cinemaOption(k.key, settings[k.key]),
  ).length;
}

export interface CinemaOptionGroup {
  /** "" for ungrouped options. */
  group: string;
  options: CinemaOption[];
}

/** Split a knob's options into picker groups, in first-seen order. */
export function groupCinemaOptions(
  options: CinemaOption[],
): CinemaOptionGroup[] {
  const out: CinemaOptionGroup[] = [];
  for (const o of options) {
    const g = o.group ?? "";
    let bucket = out.find((b) => b.group === g);
    if (!bucket) {
      bucket = { group: g, options: [] };
      out.push(bucket);
    }
    bucket.options.push(o);
  }
  return out;
}

// Multi-shot scene: 2-4 shots that share character + location text, each with
// its own framing / movement / lens / action. Compiles to one prompt per shot;
// the runner queues each prompt through the same video action (same source
// image), so the clips cut together as one scene.

export const SCENE_MIN_SHOTS = 2;
export const SCENE_MAX_SHOTS = 4;

/** Knobs a scene shot may override; everything else comes from the panel. */
export type SceneShotKey = "shot" | "movement" | "lens";
export const SCENE_SHOT_KEYS: SceneShotKey[] = ["shot", "movement", "lens"];

export interface SceneShot {
  shot?: string;
  movement?: string;
  lens?: string;
  /** What happens in this shot (optional). */
  action?: string;
}

export interface CinemaScene {
  /** Shared by every shot: who is on screen. */
  character: string;
  /** Shared by every shot: where it happens. */
  location: string;
  shots: SceneShot[];
}

/** Classic coverage: establish, then medium, then close. */
const DEFAULT_SCENE_SHOTS: SceneShot[] = [
  { shot: "wide", movement: "dolly_in" },
  { shot: "medium", movement: "truck" },
  { shot: "close", movement: "static" },
  { shot: "over_shoulder", movement: "handheld" },
];

export function defaultScene(count = 3): CinemaScene {
  const n = Math.min(SCENE_MAX_SHOTS, Math.max(SCENE_MIN_SHOTS, count));
  return {
    character: "",
    location: "",
    shots: DEFAULT_SCENE_SHOTS.slice(0, n).map((s) => ({ ...s })),
  };
}

/** Resize the shot list, keeping existing shots and filling with defaults. */
export function resizeScene(scene: CinemaScene, count: number): CinemaScene {
  const n = Math.min(SCENE_MAX_SHOTS, Math.max(SCENE_MIN_SHOTS, count));
  const shots = scene.shots.slice(0, n);
  for (let i = shots.length; i < n; i++)
    shots.push({ ...DEFAULT_SCENE_SHOTS[i] });
  return { ...scene, shots };
}

/** A scene runs only with 2-4 shots. */
export function sceneActive(scene: CinemaScene | null | undefined): boolean {
  return Boolean(
    scene &&
    scene.shots.length >= SCENE_MIN_SHOTS &&
    scene.shots.length <= SCENE_MAX_SHOTS,
  );
}

/** Panel settings with this shot's framing / movement / lens on top. */
export function sceneShotSettings(
  base: CinemaSettings,
  shot: SceneShot,
): CinemaSettings {
  const out: CinemaSettings = { ...base };
  for (const k of SCENE_SHOT_KEYS) if (shot[k]) out[k] = shot[k];
  return out;
}

function sentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * One prompt per shot: user prompt, shared character, shared location and
 * the shot's action as sentences, then the merged Cinema Studio suffix.
 * Omitted knobs (the tool fixes them) are dropped from every shot.
 */
export function compileSceneShots(
  prompt: string,
  scene: CinemaScene,
  base: CinemaSettings,
  omit: CinemaKey[] = [],
): string[] {
  const shared = [
    prompt,
    scene.character,
    scene.location ? `Location: ${scene.location}` : "",
  ];
  return scene.shots.map((shot) => {
    const lead = [...shared, shot.action ?? ""]
      .map(sentence)
      .filter(Boolean)
      .join(" ");
    return appendCinema(
      lead,
      compileCinema(sceneShotSettings(base, shot), omit),
    );
  });
}
