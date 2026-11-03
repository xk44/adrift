/**
 * Preset data for the vace_restyle video tool (pure data: no engine imports,
 * so the tools page can build its pickers from it).
 *
 * - VACE_LOOK_PRESETS: "Mixed Media" looks; the style prompt is prefixed to
 *   the user's text (or used alone).
 * - VACE_LIGHT_OPTIONS: "Video Relight" lights; the ids are the image relight
 *   tool's RELIGHT_PRESETS keys (relight.ts), whose phrasing vaceVideo.ts uses.
 */

/** Picker id meaning "no preset". */
export const VACE_PRESET_NONE = "none";
/** Look sections, in picker order. */
export const VACE_LOOK_GROUPS = [
  "Hand-made",
  "Graphic",
  "Color & light",
  "Overlay",
] as const;
export type VaceLookGroup = (typeof VACE_LOOK_GROUPS)[number];

export interface VaceLookPreset {
  id: string;
  label: string;
  /** Picker section (dropdown <optgroup>). */
  group: VaceLookGroup;
  /** Style prompt; prefixed to the user's text (or used alone). */
  prompt: string;
}

/** Mixed-media looks for vace_restyle (generic names only). */
export const VACE_LOOK_PRESETS: VaceLookPreset[] = [
  {
    id: "charcoal_sketch",
    label: "Charcoal sketch",
    group: "Hand-made",
    prompt:
      "charcoal sketch animation, rough black charcoal strokes on textured off-white paper, smudged shading, hand-drawn lines",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    group: "Hand-made",
    prompt:
      "watercolor painting animation, soft bleeding washes of color, visible paper grain, loose wet brush strokes, gentle pastel palette",
  },
  {
    id: "claymation",
    label: "Claymation",
    group: "Hand-made",
    prompt:
      "claymation stop-motion, everything sculpted from colorful plasticine clay, visible fingerprints and tool marks, handmade miniature set, soft studio lighting",
  },
  {
    id: "paper_cutout",
    label: "Paper cutout",
    group: "Hand-made",
    prompt:
      "paper cutout stop-motion, layered colored construction paper shapes, torn paper edges, small drop shadows between layers, flat collage look",
  },
  {
    id: "comic_ink",
    label: "Comic ink",
    group: "Graphic",
    prompt:
      "comic book illustration, bold black ink outlines, halftone dot shading, flat vivid colors, graphic novel panel style",
  },
  {
    id: "thermal_camera",
    label: "Thermal camera",
    group: "Color & light",
    prompt:
      "thermal infrared camera footage, heat map false colors, warm subjects glowing yellow orange and white, cold background in deep purple and blue",
  },
  {
    id: "vhs",
    label: "VHS tape",
    group: "Color & light",
    prompt:
      "1980s VHS home video footage, washed-out colors, horizontal scan lines, chroma bleed, tracking noise, soft low-resolution detail",
  },
  {
    id: "blueprint",
    label: "Blueprint",
    group: "Graphic",
    prompt:
      "technical blueprint drawing, crisp white line art on deep blue grid paper, architectural drafting style, measurement lines",
  },
  {
    id: "stained_glass",
    label: "Stained glass",
    group: "Hand-made",
    prompt:
      "stained glass window, vivid jewel-toned glass panels separated by thick black lead lines, light glowing through colored glass",
  },
  {
    id: "pixel_art",
    label: "Pixel art",
    group: "Graphic",
    prompt:
      "16-bit pixel art video game, chunky square pixels, limited color palette, retro sprite and tile style",
  },
  {
    id: "neon_wireframe",
    label: "Neon wireframe",
    group: "Graphic",
    prompt:
      "glowing neon wireframe render, thin cyan and magenta outline lines on a pure black background, retro vector computer graphics",
  },
  {
    id: "oil_painting",
    label: "Oil painting",
    group: "Hand-made",
    prompt:
      "oil painting on canvas, thick impasto brush strokes, rich saturated colors, classical painterly style",
  },
  {
    id: "low_poly",
    label: "Low poly",
    group: "Graphic",
    prompt:
      "low-poly 3D render, flat-shaded faceted polygons, simple geometric shapes, soft gradient lighting, minimal clean look",
  },
  {
    id: "chalkboard",
    label: "Chalkboard",
    group: "Hand-made",
    prompt:
      "chalk drawing on a dark green chalkboard, white and pastel chalk lines, dusty smudges and eraser marks",
  },
  {
    id: "cyanotype",
    label: "Cyanotype",
    group: "Hand-made",
    prompt:
      "cyanotype print, monochrome Prussian blue and white, sun-printed photographic texture, vintage alternative process look",
  },
  // "Overlay" looks keep the footage photographic and add a graphic layer on
  // top; the canny control holds the structure, so the subject and motion
  // survive the restyle.
  {
    id: "acrylic_blocks",
    label: "Acrylic blocks",
    group: "Hand-made",
    prompt:
      "acrylic painting animation, bold flat blocks of opaque acrylic color, visible palette-knife edges, layered paint on canvas",
  },
  {
    id: "painted_canvas",
    label: "Painted canvas",
    group: "Hand-made",
    prompt:
      "loose hand-painted canvas, expressive freehand brushwork, raw canvas weave showing between strokes, artist sketchbook energy",
  },
  {
    id: "marble_statue",
    label: "Marble statue",
    group: "Hand-made",
    prompt:
      "carved white marble sculpture come to life, polished veined stone surfaces, chiseled detail, museum gallery lighting",
  },
  {
    id: "origami",
    label: "Origami",
    group: "Hand-made",
    prompt:
      "origami paper craft world, everything folded from crisp colored paper, sharp creases and geometric facets, soft shadows",
  },
  {
    id: "magazine_print",
    label: "Magazine print",
    group: "Graphic",
    prompt:
      "glossy printed magazine page, CMYK halftone print texture, editorial layout feel, slight paper sheen and ink registration offset",
  },
  {
    id: "two_tone",
    label: "Two-tone",
    group: "Graphic",
    prompt:
      "high-contrast two-color screen print, only deep navy and bright coral, flat graphic shapes, no gradients",
  },
  {
    id: "vintage_ink",
    label: "Vintage ink",
    group: "Graphic",
    prompt:
      "vintage hand-inked illustration, fine crosshatched pen lines, aged cream paper, muted sepia and faded spot colors",
  },
  {
    id: "flash_comic",
    label: "Flash comic",
    group: "Graphic",
    prompt:
      "high-energy comic panel art, speed lines and bold action outlines, punchy saturated primaries, dramatic halftone shadows",
  },
  {
    id: "overexposed",
    label: "Overexposed",
    group: "Color & light",
    prompt:
      "heavily overexposed film footage, blown-out highlights, bright washed whites, soft halation glow around every edge",
  },
  {
    id: "noir",
    label: "Noir",
    group: "Color & light",
    prompt:
      "black and white film noir, hard low-key light, deep shadows, venetian-blind light slats, grainy high-contrast monochrome",
  },
  {
    id: "cold_neon",
    label: "Cold neon",
    group: "Color & light",
    prompt:
      "cold neon shadow lighting, icy cyan and electric blue light, deep black shadows, glossy reflections, night city mood",
  },
  {
    id: "psychedelic",
    label: "Psychedelic waves",
    group: "Color & light",
    prompt:
      "psychedelic color waves, flowing rainbow gradients rippling across every surface, melting saturated hues, trippy poster art",
  },
  {
    id: "toxic_glow",
    label: "Toxic glow",
    group: "Color & light",
    prompt:
      "radioactive toxic glow, acid green and hot yellow light bleeding from every edge, dark murky background, poster-like contrast",
  },
  {
    id: "ultraviolet",
    label: "Ultraviolet",
    group: "Color & light",
    prompt:
      "ultraviolet blacklight scene, fluorescent purple and magenta glow, neon-bright whites, deep violet shadows",
  },
  {
    id: "ocean_tint",
    label: "Ocean tint",
    group: "Color & light",
    prompt:
      "liquid sea-color grade, deep teal and aquamarine tones, rippling caustic light patterns washing over everything",
  },
  {
    id: "molten_lava",
    label: "Molten lava",
    group: "Color & light",
    prompt:
      "molten lava palette, glowing orange and red flowing color, dark cooled-rock blacks, heat shimmer",
  },
  {
    id: "glowing_particles",
    label: "Glowing particles",
    group: "Overlay",
    prompt:
      "photorealistic live-action footage overlaid with luminous floating particles and drifting light specks that follow the motion",
  },
  {
    id: "ui_windows",
    label: "Interface windows",
    group: "Overlay",
    prompt:
      "photorealistic live-action footage with overlapping retro computer interface windows, pop-up panels and cursor graphics layered on top",
  },
  {
    id: "tracking_hud",
    label: "Tracking HUD",
    group: "Overlay",
    prompt:
      "photorealistic live-action footage with motion tracking graphics, thin white target boxes, connecting lines and data labels following the subjects",
  },
  {
    id: "broken_mirror",
    label: "Broken mirror",
    group: "Overlay",
    prompt:
      "the scene seen through a shattered mirror, sharp glass shards each reflecting an offset slice of the footage, bright cracked edges",
  },
  {
    id: "soap_bubbles",
    label: "Soap bubbles",
    group: "Overlay",
    prompt:
      "dreamy photorealistic footage with iridescent soap bubbles floating through the frame, rainbow film reflections, soft focus",
  },
  {
    id: "shattered_layers",
    label: "Shattered layers",
    group: "Overlay",
    prompt:
      "layered abstract collage, the footage split into offset translucent fragments and duplicated layers colliding like overlapping realities",
  },
];
/** Video Relight lights (ids = relight.ts RELIGHT_PRESETS keys). */
export const VACE_LIGHT_OPTIONS: { id: string; label: string }[] = [
  { id: "golden_hour", label: "Golden hour" },
  { id: "neon_night", label: "Neon night" },
  { id: "studio_softbox", label: "Studio softbox" },
  { id: "rim_light", label: "Rim light" },
  { id: "overcast", label: "Overcast" },
  { id: "candlelight", label: "Candlelight" },
  { id: "sunset_backlight", label: "Sunset backlight" },
  { id: "moonlight", label: "Moonlight" },
];
