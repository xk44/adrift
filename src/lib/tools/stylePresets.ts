/**
 * Style presets ("Soul"-style named style menu)
 * A curated menu of named looks for text-to-image: each preset is a prompt
 * fragment (our own wording) plus an optional style LoRA from the public
 * Krea 2 style-LoRA catalog (./../krea2/styleLoraCatalog.json). Picking a
 * preset compiles `<subject>, <fragment>` and, when the LoRA is switched on,
 * appends `--lora <id>.safetensors` (its trigger phrase auto-appends at
 * generation time through getTriggersForLora).
 *
 * Pure data + compilers: no React, no fetch. The runner lives in
 * src/components/tools/StylePresets.tsx.
 */

import { findStyleLora, styleLoraFilename } from "@/lib/krea2/styleLoras";

export const STYLE_CATEGORIES = [
  "Photo",
  "Fashion",
  "Cinematic",
  "Painting",
  "Illustration",
  "Animation",
  "3D & Craft",
  "Digital",
  "Fantasy",
] as const;

export type StyleCategory = (typeof STYLE_CATEGORIES)[number];

export interface StylePreset {
  id: string;
  name: string;
  category: StyleCategory;
  /** Style fragment appended after the subject. */
  prompt: string;
  /** Optional Krea 2 style-LoRA catalog id (Krea 2 packs only). */
  lora?: string;
}

/** Used when the subject field is empty. */
export const DEFAULT_STYLE_SUBJECT = "a portrait of a stylish person";

const P = (
  category: StyleCategory,
  id: string,
  name: string,
  prompt: string,
  lora?: string,
): StylePreset => ({ id, name, category, prompt, ...(lora ? { lora } : {}) });

export const STYLE_PRESETS: StylePreset[] = [
  // Photo
  P(
    "Photo",
    "general",
    "General",
    "natural photograph, true-to-life color, soft daylight, sharp focus, realistic skin and fabric texture",
  ),
  P(
    "Photo",
    "phone_snap",
    "Phone Snapshot",
    "casual smartphone photo, slightly wide lens, crisp auto exposure, unposed everyday moment, natural imperfections",
  ),
  P(
    "Photo",
    "party_flash",
    "Party Flash",
    "direct on-camera flash at night, hard shadows behind the subject, glossy highlights, candid party snapshot, dark background",
  ),
  P(
    "Photo",
    "disposable",
    "Disposable Camera",
    "disposable film camera snapshot, built-in flash, warm color shift, soft corners, light grain",
    "faded-film-snapshot",
  ),
  P(
    "Photo",
    "mirror_selfie",
    "Mirror Selfie",
    "mirror selfie with the phone held at chest height, stylish apartment, window daylight, relaxed pose",
  ),
  P(
    "Photo",
    "golden_hour",
    "Golden Hour",
    "low warm sun, glowing rim light on hair, long soft shadows, hazy golden atmosphere",
    "amber-haze-golden-hour",
  ),
  P(
    "Photo",
    "neon_night",
    "Neon Night",
    "night street lit by colorful neon signs, wet pavement reflections, soft fog, cinematic color",
    "foggy-neon-night-film",
  ),
  P(
    "Photo",
    "rainy_window",
    "Rainy Window",
    "shot through a rain-streaked window, blurred city lights, quiet moody mood, cool tones",
  ),
  P(
    "Photo",
    "sun_drenched",
    "Sun-Drenched",
    "bright midsummer sunlight, saturated color, crisp shadows, fine film grain",
    "sun-drenched-film-grain",
  ),
  P(
    "Photo",
    "top_down",
    "Top-Down",
    "overhead bird's-eye view, graphic composition, clean shadows, the subject centered on a textured ground",
  ),
  P(
    "Photo",
    "fisheye",
    "Fisheye",
    "ultra-wide fisheye lens, curved horizon, close and playful perspective, skate-video energy",
    "faded-teal-pink-fisheye",
  ),

  // Fashion
  P(
    "Fashion",
    "editorial",
    "Editorial",
    "high-fashion magazine editorial, considered pose, refined styling, soft directional light, muted tonal palette",
    "warm-tonal-editorial",
  ),
  P(
    "Fashion",
    "runway",
    "Runway",
    "fashion-week runway photo, long lens, the model mid-stride, spotlit catwalk, blurred audience",
  ),
  P(
    "Fashion",
    "color_studio",
    "Color Studio",
    "studio fashion shot against a bold seamless color backdrop, crisp strobe lighting, graphic pose",
  ),
  P(
    "Fashion",
    "high_key",
    "High Key",
    "bright white studio, even high-key light, clean minimal styling, catalog crispness",
  ),
  P(
    "Fashion",
    "coastal_summer",
    "Coastal Summer",
    "summer fashion story on a sunlit seaside terrace, lemon trees, whitewashed walls, turquoise sea, linen clothes",
    "sunlit-pastel-riviera",
  ),
  P(
    "Fashion",
    "street_style",
    "Street Style",
    "street-style photo outside a fashion show, layered outfit, candid stride, city sidewalk, long lens",
  ),
  P(
    "Fashion",
    "gorpcore",
    "Gorpcore",
    "technical outdoor wear styled as fashion, shell jacket, trail shoes, mountain trailhead, overcast light",
  ),
  P(
    "Fashion",
    "y2k",
    "Y2K",
    "early-2000s pop fashion, glossy lip, tinted sunglasses, metallic fabrics, bright flash, playful attitude",
  ),
  P(
    "Fashion",
    "grunge",
    "Grunge",
    "90s grunge styling, flannel and worn denim, smudged eyeliner, muted greens, gritty grain",
    "misty-teal-grunge",
  ),
  P(
    "Fashion",
    "transit_fit",
    "Transit Fit",
    "outfit photo on a metro escalator, symmetrical steel lines, low angle, cool fluorescent light",
  ),
  P(
    "Fashion",
    "curbside",
    "Curbside",
    "sitting on a city curb, relaxed street outfit, low camera, afternoon sun, documentary feel",
  ),
  P(
    "Fashion",
    "quiet_luxury",
    "Quiet Luxury",
    "understated luxury styling, cashmere and tailored wool in neutral tones, stately interior, soft window light",
  ),
  P(
    "Fashion",
    "athleisure",
    "Athleisure",
    "sporty athleisure look, sleek fabrics, dynamic pose, modern gym or rooftop court, bright clean light",
  ),
  P(
    "Fashion",
    "couture",
    "Couture",
    "dramatic couture gown or sculptural suit, grand staircase, theatrical lighting, opulent mood",
  ),
  P(
    "Fashion",
    "cozy_knit",
    "Cozy Knit",
    "chunky knitwear, warm cabin interior, soft lamp light, autumn tones, gentle smile",
  ),

  // Cinematic
  P(
    "Cinematic",
    "cinematic",
    "Cinematic",
    "cinematic film still, anamorphic lens, motivated lighting, teal and amber grade, shallow depth of field",
    "teal-amber-film-haze",
  ),
  P(
    "Cinematic",
    "noir",
    "Film Noir",
    "black-and-white film noir, venetian-blind shadows, hard key light, smoke, high contrast",
    "amber-noir-chiaroscuro",
  ),
  P(
    "Cinematic",
    "slide_film",
    "Vintage Slide Film",
    "mid-century color slide film, saturated reds and blues, fine grain, warm daylight",
    "faded-midcentury-kodachrome",
  ),
  P(
    "Cinematic",
    "seventies",
    "70s Film",
    "1970s film look, warm faded palette, soft halation, zoom-lens framing",
    "faded-seventies-kodachrome",
  ),
  P(
    "Cinematic",
    "nineties",
    "90s Film",
    "1990s 35mm film, slightly overexposed, punchy color, visible grain",
    "grainy-nineties-film",
  ),
  P(
    "Cinematic",
    "vhs",
    "VHS Still",
    "frame from a home video tape, soft resolution, color bleeding, scan lines, slight tracking wobble",
  ),
  P(
    "Cinematic",
    "western",
    "Dusty Western",
    "sun-baked frontier western, dust in the air, wide desert vista, warm ochre grade",
  ),
  P(
    "Cinematic",
    "scifi_set",
    "Sci-Fi Set",
    "retro-futurist science-fiction set, glowing panels, teal neon accents, haze, practical lights",
    "teal-neon-retrofuture",
  ),
  P(
    "Cinematic",
    "horror",
    "Horror Still",
    "slow-burn horror film still, cold teal shadows, a single practical light, unsettling negative space",
    "teal-noir-horror",
  ),
  P(
    "Cinematic",
    "neon_melancholy",
    "Neon Melancholy",
    "lonely night city, smeared neon, step-printed motion blur, saturated greens and reds",
    "neon-noir-nightstreet",
  ),
  P(
    "Cinematic",
    "bw_documentary",
    "B&W Documentary",
    "black-and-white documentary photo, natural light, gritty contrast, honest unposed moment",
    "bleak-monochrome-urban-melancholy",
  ),
  P(
    "Cinematic",
    "fifties_color",
    "Fifties Color",
    "lush 1950s three-strip color, candy-bright costumes, glamorous studio lighting",
    "vintage-technicolor-fifties",
  ),
  P(
    "Cinematic",
    "infrared",
    "Infrared",
    "infrared photograph, foliage turned pink and white, dark skies, dreamlike glow",
    "infrared-photo-composite",
  ),
  P(
    "Cinematic",
    "wet_plate",
    "Wet Plate",
    "antique wet-plate collodion portrait, silver tones, swirling edges, long-exposure stillness",
    "aged-wetplate-monochrome",
  ),
  P(
    "Cinematic",
    "tilt_shift",
    "Tilt-Shift",
    "tilt-shift miniature effect, tiny-looking world, narrow focus band, warm late light",
    "warm-tilt-shift-golden",
  ),
  P(
    "Cinematic",
    "cross_process",
    "Cross-Process Night",
    "cross-processed night film, lens flare, crushed blacks, heavy grain, underground energy",
    "grainy-lomography-night",
  ),

  // Painting
  P(
    "Painting",
    "old_master",
    "Old Master Oil",
    "classical oil painting, chiaroscuro lighting, rich glazes, dark background, visible canvas texture",
    "dark-chiaroscuro-oil",
  ),
  P(
    "Painting",
    "impressionist",
    "Impressionist",
    "impressionist oil painting, broken brushstrokes, dappled light, soft pastel color",
    "teal-rose-impressionist-oil",
  ),
  P(
    "Painting",
    "plein_air",
    "Plein Air",
    "plein-air oil sketch, quick confident strokes, bright outdoor light",
    "sunlit-plein-air-oil",
  ),
  P(
    "Painting",
    "watercolor",
    "Watercolor",
    "loose watercolor painting, soft washes, paper texture, gentle color blooms",
    "luminous-watercolor-wash",
  ),
  P(
    "Painting",
    "gouache",
    "Gouache",
    "opaque gouache illustration, matte flat color, crisp shapes, cheerful palette",
    "sunny-gouache-picturebook",
  ),
  P(
    "Painting",
    "ink_wash",
    "Ink Wash",
    "misty ink-wash painting, graded grey tones, empty space, delicate brushwork",
    "misty-ink-wash",
  ),
  P(
    "Painting",
    "sumi",
    "Sumi Brush",
    "bold sumi-e brushstrokes, black ink on rice paper, expressive and minimal",
    "expressive-sumi-brush",
  ),
  P(
    "Painting",
    "charcoal",
    "Charcoal",
    "charcoal drawing, smudged tones, strong gesture, textured paper",
    "monochrome-charcoal-mist",
  ),
  P(
    "Painting",
    "colored_pencil",
    "Colored Pencil",
    "colored-pencil drawing, layered hatching, vivid hues, visible paper tooth",
    "vivid-colored-pencil-sketch",
  ),
  P(
    "Painting",
    "pastel_crayon",
    "Soft Pastel",
    "soft pastel and crayon artwork, chalky texture, gentle blended color",
    "soft-pastel-crayon",
  ),
  P(
    "Painting",
    "baroque",
    "Baroque",
    "opulent baroque painting, gilded details, dramatic drapery, warm candlelight",
    "gilded-baroque-oil",
  ),
  P(
    "Painting",
    "fresco",
    "Fresco",
    "weathered fresco on plaster, faded earth pigments, cracked surface",
    "aged-fresco-decay",
  ),
  P(
    "Painting",
    "palette_knife",
    "Palette Knife",
    "thick palette-knife impasto, sculpted paint ridges, bold color blocks",
    "pastel-palette-knife",
  ),
  P(
    "Painting",
    "pointillism",
    "Pointillism",
    "pointillist painting made of tiny dots of pure color, shimmering light",
    "luminous-pointillist-orbs",
  ),
  P(
    "Painting",
    "fashion_sketch",
    "Fashion Sketch",
    "loose fashion illustration, ink line and marker wash, elongated elegant figure",
    "loose-ink-fashion",
  ),

  // Illustration
  P(
    "Illustration",
    "storybook",
    "Storybook",
    "warm children's storybook illustration, soft gouache textures, cozy details",
    "warm-storybook-gouache",
  ),
  P(
    "Illustration",
    "comic_ink",
    "Comic Ink",
    "inked comic panel, bold outlines, crosshatching, flat color",
    "inked-comic-crosshatch",
  ),
  P(
    "Illustration",
    "pop_art",
    "Pop Art",
    "pop-art print, halftone dots, bold primary colors, thick black outlines",
    "bold-halftone-popart",
  ),
  P(
    "Illustration",
    "risograph",
    "Risograph",
    "two-color risograph print, misregistered layers, grainy ink texture",
    "risograph-duotone-grain",
  ),
  P(
    "Illustration",
    "woodblock",
    "Woodblock Print",
    "traditional woodblock print, flat color areas, carved outlines, washi paper",
    "golden-woodblock-ukiyo",
  ),
  P(
    "Illustration",
    "linocut",
    "Linocut",
    "black linocut print, carved gouge marks, high contrast",
    "black-ink-linocut",
  ),
  P(
    "Illustration",
    "screenprint",
    "Screenprint",
    "vintage two-tone screenprint, limited palette, slight ink offset",
    "vintage-screenprint-duotone",
  ),
  P(
    "Illustration",
    "travel_poster",
    "Travel Poster",
    "retro travel poster, simplified shapes, sunny gradients, graphic composition",
    "retro-travel-poster",
  ),
  P(
    "Illustration",
    "art_nouveau",
    "Art Nouveau",
    "art nouveau illustration, flowing ornamental linework, floral frame, muted gold",
    "ornate-linework-nouveau",
  ),
  P(
    "Illustration",
    "art_deco",
    "Art Deco",
    "art deco illustration, geometric gold ornament, elegant symmetry, jazz-age glamour",
    "golden-deco-fable",
  ),
  P(
    "Illustration",
    "etching",
    "Etching",
    "fine ink etching, delicate crosshatched shading, antique book plate",
    "vintage-ink-etching",
  ),
  P(
    "Illustration",
    "flat_vector",
    "Flat Vector",
    "flat vector illustration, clean geometric shapes, bold color blocks, no gradients",
    "bold-flat-color-block",
  ),
  P(
    "Illustration",
    "blueprint",
    "Blueprint",
    "technical blueprint drawing, white linework on blue, annotations and measurements",
    "blueprint-sketch-annotation",
  ),
  P(
    "Illustration",
    "tattoo_flash",
    "Tattoo Flash",
    "traditional tattoo flash sheet, bold outlines, limited red, green and yellow palette",
    "bold-flash-tattoo",
  ),
  P(
    "Illustration",
    "paper_collage",
    "Paper Collage",
    "vintage paper cut-out collage, torn edges, mixed printed textures",
    "vintage-paper-cutout-collage",
  ),
  P(
    "Illustration",
    "stained_glass",
    "Stained Glass",
    "luminous stained-glass window, leaded outlines, jewel-toned light",
    "luminous-stained-glass-mosaic",
  ),
  P(
    "Illustration",
    "sticker",
    "Sticker",
    "glossy die-cut sticker, thick white border, bright candy colors",
    "bubblegum-pop-sticker",
  ),

  // Animation
  P(
    "Animation",
    "retro_cel",
    "Retro Cel Anime",
    "retro hand-painted cel anime, soft film grain, painted backgrounds, 80s color",
    "retro-cel-anime",
  ),
  P(
    "Animation",
    "bright_anime",
    "Bright Anime",
    "modern cinematic anime, luminous sky, detailed backgrounds, crisp linework",
    "sunlit-cinematic-anime",
  ),
  P(
    "Animation",
    "manga",
    "Manga Ink",
    "black-and-white manga page panel, detailed inking, screentone shading",
    "detailed-manga-inkwork",
  ),
  P(
    "Animation",
    "chibi",
    "Chibi",
    "cute chibi character, oversized head, soft watercolor pastel shading",
    "chibi-watercolor-pastel-anime",
  ),
  P(
    "Animation",
    "classic_cartoon",
    "Classic Cartoon",
    "golden-age hand-drawn cartoon, rubbery shapes, warm painted backgrounds",
    "golden-era-cel-animation",
  ),
  P(
    "Animation",
    "webtoon",
    "Webtoon",
    "clean digital webtoon art, soft cel shading, bright daylight palette",
    "inked-webtoon-daylight",
  ),
  P(
    "Animation",
    "animated_feature",
    "Animated Feature",
    "polished 3D animated-feature render, soft subsurface skin, stylized proportions, warm bounce light",
  ),

  // 3D & Craft
  P(
    "3D & Craft",
    "clay",
    "Claymation",
    "handmade clay diorama, fingerprint texture, stop-motion set lighting",
    "handmade-clay-diorama",
  ),
  P(
    "3D & Craft",
    "felt",
    "Felt Craft",
    "needle-felted wool miniature, fuzzy fibers, cozy tabletop set",
    "felt-craft-miniature",
  ),
  P(
    "3D & Craft",
    "papercut",
    "Papercut Diorama",
    "layered papercut diorama, cast shadows between paper layers, soft backlight",
    "layered-papercut-diorama",
  ),
  P(
    "3D & Craft",
    "vinyl_toy",
    "Vinyl Toy",
    "glossy vinyl designer toy, rounded forms, soft studio light",
    "bold-clay-toy-render",
  ),
  P(
    "3D & Craft",
    "low_poly",
    "Low Poly",
    "low-poly 3D render, faceted geometry, flat shading, pastel gradient sky",
  ),
  P(
    "3D & Craft",
    "isometric",
    "Isometric",
    "isometric 3D miniature scene, candy colors, tidy tiny details",
    "whimsical-isometric-candy",
  ),
  P(
    "3D & Craft",
    "liquid_chrome",
    "Liquid Chrome",
    "liquid chrome sculpture, mirror reflections, studio environment",
    "liquid-chrome-mirror",
  ),
  P(
    "3D & Craft",
    "embroidery",
    "Embroidery",
    "embroidered textile artwork, satin stitches, visible thread texture on linen",
    "rosy-embroidered-thread",
  ),
  P(
    "3D & Craft",
    "plastic_toy",
    "Plastic Toy",
    "vintage plastic toy figure, molded seams, slightly faded paint",
    "vintage-plastic-toy",
  ),
  P(
    "3D & Craft",
    "origami",
    "Origami",
    "folded white paper sculpture, crisp creases, soft directional light",
    "folded-white-paper-sculpture",
  ),

  // Digital
  P(
    "Digital",
    "vaporwave",
    "Vaporwave",
    "vaporwave dreamscape, pastel pink and teal, classical busts, grid horizon",
    "surreal-vaporwave-dreamscape",
  ),
  P(
    "Digital",
    "synthwave",
    "Synthwave",
    "synthwave scene, neon grid, chrome sunset, purple haze",
    "neon-grid-retrowave",
  ),
  P(
    "Digital",
    "pixel_art",
    "Pixel Art",
    "detailed 16-bit pixel art, limited palette, crisp pixels, no anti-aliasing",
  ),
  P(
    "Digital",
    "cyberpunk",
    "Cyberpunk",
    "rain-soaked cyberpunk city at dusk, holographic signs, neon magenta and cyan",
    "neon-dusk-cyberpunk",
  ),
  P(
    "Digital",
    "glitch",
    "Glitch",
    "datamosh glitch art, pixel smearing, RGB channel split",
    "neon-datamosh-glitch",
  ),
  P(
    "Digital",
    "holographic",
    "Holographic",
    "iridescent holographic glass, prismatic refractions, soft glow",
    "iridescent-holographic-glass",
  ),
  P(
    "Digital",
    "early_cgi",
    "Early CGI",
    "late-90s early CGI render, plastic shading, simple textures, surreal void",
    "early-cgi-surreal-render",
  ),

  // Fantasy
  P(
    "Fantasy",
    "dark_fantasy",
    "Dark Fantasy",
    "dark fantasy film still, mist, firelight, weathered armor and stone",
    "dark-fantasy-film",
  ),
  P(
    "Fantasy",
    "fairytale",
    "Fairytale",
    "gilded gothic fairytale, ornate frame, enchanted forest glow",
    "gilded-gothic-fairytale",
  ),
  P(
    "Fantasy",
    "surreal",
    "Surreal",
    "photoreal surreal composite, impossible scale, dreamlike calm",
    "surreal-photorealistic-composite",
  ),
  P(
    "Fantasy",
    "dreamy",
    "Dreamy Haze",
    "soft pastel haze, glowing highlights, ethereal mood",
    "dreamy-pastel-haze",
  ),
  P(
    "Fantasy",
    "gothic",
    "Gothic",
    "moonlit gothic romance, candlelit cathedral, velvet and lace",
    "moonlit-gothic-romance",
  ),
  P(
    "Fantasy",
    "cosmic",
    "Cosmic",
    "swirling inked cosmos, stars and nebulae woven around the subject",
    "swirling-inked-cosmos",
  ),
  P(
    "Fantasy",
    "medieval",
    "Medieval",
    "medieval manuscript scene, castle courtyard, period costume, illuminated detail",
    "dark-medieval-inkline",
  ),
  P(
    "Fantasy",
    "angel_wings",
    "Angel Wings",
    "large white feathered wings on the subject's back, heavenly backlight, drifting feathers",
  ),
  P(
    "Fantasy",
    "misty_peaks",
    "Misty Peaks",
    "flowing robes on misty mountain peaks, golden light through clouds, martial-fantasy epic",
    "golden-misty-xianxia",
  ),
];

export function getStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}

export function stylesIn(category: StyleCategory): StylePreset[] {
  return STYLE_PRESETS.filter((p) => p.category === category);
}

/** `--lora <file>` flag for a preset's style LoRA, or "" when it has none. */
export function styleLoraFlag(preset: StylePreset): string {
  if (!preset.lora) return "";
  const entry = findStyleLora(preset.lora);
  return entry ? `--lora ${styleLoraFilename(entry.id)}` : "";
}

function tidy(s: string | undefined, max: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Text-to-image prompt for a preset: `<subject>, <fragment>[, notes]`, plus
 * the LoRA flag when `withLora` is set and the preset has one.
 */
export function compileStylePrompt(
  preset: StylePreset,
  opts: { subject?: string; notes?: string; withLora?: boolean } = {},
): string {
  const subject =
    tidy(opts.subject, 300).replace(/[,.\s]+$/, "") || DEFAULT_STYLE_SUBJECT;
  const notes = tidy(opts.notes, 300).replace(/[,.\s]+$/, "");
  const text = [subject, preset.prompt, notes].filter(Boolean).join(", ");
  const flag = opts.withLora ? styleLoraFlag(preset) : "";
  return flag ? `${text} ${flag}` : text;
}

/**
 * Add a preset's style to an existing Create prompt: the fragment goes after
 * the prompt text but before any `--flags` (so it isn't swallowed as a flag
 * value) and the LoRA flag goes last. An empty prompt gets the default
 * subject.
 */
export function addStyleToPrompt(
  current: string,
  preset: StylePreset,
  withLora = false,
): string {
  const trimmed = current.trim();
  const m = /(^|\s)--\w/.exec(trimmed);
  const text = (m ? trimmed.slice(0, m.index) : trimmed)
    .trim()
    .replace(/[,.\s]+$/, "");
  const flags = m ? trimmed.slice(m.index).trim() : "";
  const flag = withLora ? styleLoraFlag(preset) : "";
  return [
    `${text || DEFAULT_STYLE_SUBJECT}, ${preset.prompt}`,
    flags,
    flag && !flags.includes(flag) ? flag : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Returns a list of problems; empty = valid. */
export function validateStylePresets(presets: StylePreset[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  presets.forEach((p, i) => {
    const at = `styles[${i}] (${p.id})`;
    if (!/^[a-z0-9_]+$/.test(p.id)) errors.push(`${at}: id must be snake_case`);
    if (ids.has(p.id)) errors.push(`${at}: duplicate id`);
    ids.add(p.id);
    const n = p.name.trim().toLowerCase();
    if (!n) errors.push(`${at}: name required`);
    if (names.has(n)) errors.push(`${at}: duplicate name`);
    names.add(n);
    if (!STYLE_CATEGORIES.includes(p.category))
      errors.push(`${at}: unknown category ${p.category}`);
    if (p.prompt.trim().length < 30 || p.prompt.length > 220)
      errors.push(`${at}: prompt must be 30-220 chars`);
    if (/--\w/.test(p.prompt)) errors.push(`${at}: prompt must not hold flags`);
    if (p.lora !== undefined && !findStyleLora(p.lora))
      errors.push(`${at}: unknown style LoRA ${p.lora}`);
  });
  for (const c of STYLE_CATEGORIES)
    if (!presets.some((p) => p.category === c))
      errors.push(`category ${c} has no presets`);
  return errors;
}
