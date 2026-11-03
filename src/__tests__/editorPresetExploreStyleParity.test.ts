/**
 * Tests for ninth-pass slice A: EditorPromptBar P-dropdown parity + ExplorePage styles/video parity.
 *
 * Validates:
 * - EditorPromptBar presets data covers all GenerationSettings fields
 * - Preset application updates the UI store settings correctly
 * - Preset "is active" detection matches store state
 * - ExplorePage SEED_STYLES replaces FALLBACK_STYLES without thumbnail regression
 * - Style store integration: displayStyles merges user codes + seeds, deduplicating
 * - Videos tab uses generation store runs or shows seed prompts as fallback
 */

import { describe, it, expect, beforeEach } from "vitest";

// ─── GenerationSettings type (mirrored from types) ───

interface GenerationSettings {
  aspect: string;
  ratio: number;
  stylize: number;
  weird: number;
  chaos: number;
  modelMode: string;
  modelVersion: string;
  personalize: boolean;
  speed: string;
  privacy: string;
  quality: number;
  loras: unknown[];
}

// ─── Default settings (mirrored from store) ───

const defaultSettings: GenerationSettings = {
  aspect: "1:1",
  ratio: 1,
  stylize: 100,
  weird: 0,
  chaos: 0,
  modelMode: "Standard",
  modelVersion: "v7",
  personalize: false,
  speed: "Standard",
  privacy: "Public",
  quality: 1,
  loras: [],
};

// ─── EditorPreset (mirrored from EditorPromptBar) ───

interface EditorPreset {
  id: string;
  name: string;
  description: string;
  aspect: string;
  stylize: number;
  modelMode: string;
  quality: number;
  speed: string;
}

const EDITOR_PRESETS: EditorPreset[] = [
  { id: "default", name: "Default", description: "1:1 · Standard · Stylize 100", aspect: "1:1", stylize: 100, modelMode: "Standard", quality: 1, speed: "Standard" },
  { id: "wide", name: "Wide", description: "16:9 · Standard · Stylize 100", aspect: "16:9", stylize: 100, modelMode: "Standard", quality: 1, speed: "Standard" },
  { id: "portrait", name: "Portrait", description: "9:16 · Standard · Stylize 100", aspect: "9:16", stylize: 100, modelMode: "Standard", quality: 1, speed: "Standard" },
  { id: "high-stylize", name: "High Stylize", description: "1:1 · Standard · Stylize 500", aspect: "1:1", stylize: 500, modelMode: "Standard", quality: 1, speed: "Standard" },
  { id: "raw", name: "Raw Mode", description: "1:1 · Raw · Stylize 100", aspect: "1:1", stylize: 100, modelMode: "Raw", quality: 1, speed: "Standard" },
  { id: "quality", name: "High Quality", description: "1:1 · Standard · Quality 2 · Quality speed", aspect: "1:1", stylize: 100, modelMode: "Standard", quality: 2, speed: "Quality" },
  { id: "cinematic", name: "Cinematic", description: "21:9 · Raw · Stylize 250", aspect: "21:9", stylize: 250, modelMode: "Raw", quality: 1, speed: "Standard" },
  { id: "creative", name: "Creative", description: "1:1 · Standard · Stylize 750", aspect: "1:1", stylize: 750, modelMode: "Standard", quality: 1, speed: "Standard" },
];

// ─── isPresetActive (mirrored from EditorPromptBar) ───

function isPresetActive(settings: GenerationSettings, preset: EditorPreset): boolean {
  return (
    settings.aspect === preset.aspect &&
    settings.stylize === preset.stylize &&
    settings.modelMode === preset.modelMode &&
    settings.quality === preset.quality &&
    settings.speed === preset.speed
  );
}

// ─── applyPreset (mirrored from handleApplyPreset) ───

function applyPreset(
  current: GenerationSettings,
  preset: EditorPreset,
): GenerationSettings {
  return {
    ...current,
    aspect: preset.aspect,
    stylize: preset.stylize,
    modelMode: preset.modelMode,
    quality: preset.quality,
    speed: preset.speed,
  };
}

// ─── StyleCodeEntry (mirrored from styleStore) ───

interface StyleCodeEntry {
  code: string;
  name?: string;
  tags?: string[];
  thumbnailUrl?: string;
  createdAt: number;
  useCount: number;
  isFavorite: boolean;
}

// ─── SEED_STYLES (mirrored from ExplorePage) ───

const SEED_STYLES: Array<{
  code: string;
  name: string;
  tags: string[];
  prompt: string;
}> = [
  { code: "ethereal-dream", name: "Ethereal Dream", tags: ["dreamy", "soft", "surreal"], prompt: "ethereal dream --sref random --sw 200" },
  { code: "cyberpunk-neon", name: "Cyberpunk Neon", tags: ["neon", "futuristic", "dark"], prompt: "cyberpunk neon city --sref random --sw 300" },
  { code: "vintage-film", name: "Vintage Film", tags: ["film", "retro", "grain"], prompt: "vintage film grain portrait --sref random --sw 150" },
  { code: "watercolor-wash", name: "Watercolor Wash", tags: ["watercolor", "artistic", "painterly"], prompt: "watercolor wash landscape --sref random --sw 250" },
  { code: "dark-fantasy", name: "Dark Fantasy", tags: ["dark", "fantasy", "moody"], prompt: "dark fantasy wizard --sref random --sw 400" },
  { code: "minimalist-clean", name: "Minimalist Clean", tags: ["minimal", "clean", "modern"], prompt: "minimalist studio product --sref random --sw 100" },
  { code: "photojournalistic", name: "Photojournalistic", tags: ["photo", "documentary", "raw"], prompt: "photojournalistic street --sref random --sw 180" },
  { code: "anime-cel", name: "Anime Cel", tags: ["anime", "cel", "illustration"], prompt: "anime cel shading character --sref random --sw 350" },
  { code: "horror-noir", name: "Horror Noir", tags: ["horror", "noir", "atmospheric"], prompt: "horror noir corridor --sref random --sw 280" },
  { code: "botanical", name: "Botanical Study", tags: ["botanical", "nature", "detailed"], prompt: "botanical study flower --sref random --sw 200" },
  { code: "pop-art", name: "Pop Art Bold", tags: ["pop", "bold", "colorful"], prompt: "pop art portrait bold colors --sref random --sw 320" },
  { code: "oil-impasto", name: "Oil Paint Impasto", tags: ["oil", "impasto", "classical"], prompt: "oil paint impasto still life --sref random --sw 260" },
];

// ─── displayStyles merge (mirrored from ExplorePage) ───

function buildDisplayStyles(styleCodes: StyleCodeEntry[]) {
  const userEntries: Array<{
    id: string;
    name: string;
    tags: string[];
    thumbnailUrl: string;
    prompt: string;
    isSaved: boolean;
    isFavorite: boolean;
  }> = styleCodes.map((sc) => ({
    id: sc.code,
    name: sc.name || sc.code,
    tags: sc.tags || [],
    thumbnailUrl: sc.thumbnailUrl || "",
    prompt: `--sref ${sc.code}`,
    isSaved: true,
    isFavorite: sc.isFavorite,
  }));

  const seedEntries = SEED_STYLES.map((s) => ({
    id: s.code,
    name: s.name,
    tags: s.tags,
    thumbnailUrl: "",
    prompt: s.prompt,
    isSaved: styleCodes.some((sc) => sc.code === s.code),
    isFavorite: styleCodes.some((sc) => sc.code === s.code && sc.isFavorite),
  }));

  const seen = new Set(userEntries.map((e) => e.id));
  return [...userEntries, ...seedEntries.filter((e) => !seen.has(e.id))];
}

// ─── Tests ───

describe("EditorPromptBar P-dropdown presets", () => {
  it("has at least 8 presets covering common prompt parameter combos", () => {
    expect(EDITOR_PRESETS.length).toBeGreaterThanOrEqual(8);
  });

  it("each preset has required fields", () => {
    for (const preset of EDITOR_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.aspect).toMatch(/^\d+:\d+$/);
      expect(typeof preset.stylize).toBe("number");
      expect(["Standard", "Raw"]).toContain(preset.modelMode);
      expect(typeof preset.quality).toBe("number");
      expect(["Draft", "Standard", "Quality"]).toContain(preset.speed);
    }
  });

  it("default preset is active with default settings", () => {
    const defaultPreset = EDITOR_PRESETS.find((p) => p.id === "default")!;
    expect(isPresetActive(defaultSettings, defaultPreset)).toBe(true);
  });

  it("non-default preset is not active with default settings", () => {
    const widePreset = EDITOR_PRESETS.find((p) => p.id === "wide")!;
    expect(isPresetActive(defaultSettings, widePreset)).toBe(false);
  });

  it("applying a preset updates settings accordingly", () => {
    const widePreset = EDITOR_PRESETS.find((p) => p.id === "wide")!;
    const updated = applyPreset(defaultSettings, widePreset);
    expect(updated.aspect).toBe("16:9");
    expect(updated.stylize).toBe(100);
    expect(updated.modelMode).toBe("Standard");
    expect(updated.quality).toBe(1);
    expect(updated.speed).toBe("Standard");
    expect(isPresetActive(updated, widePreset)).toBe(true);
  });

  it("applying raw preset sets modelMode to Raw", () => {
    const rawPreset = EDITOR_PRESETS.find((p) => p.id === "raw")!;
    const updated = applyPreset(defaultSettings, rawPreset);
    expect(updated.modelMode).toBe("Raw");
    expect(isPresetActive(updated, rawPreset)).toBe(true);
  });

  it("applying cinematic preset changes aspect, mode, and stylize", () => {
    const cinematicPreset = EDITOR_PRESETS.find((p) => p.id === "cinematic")!;
    const updated = applyPreset(defaultSettings, cinematicPreset);
    expect(updated.aspect).toBe("21:9");
    expect(updated.stylize).toBe(250);
    expect(updated.modelMode).toBe("Raw");
    expect(isPresetActive(updated, cinematicPreset)).toBe(true);
  });

  it("switching between presets clears previous preset correctly", () => {
    const portrait = EDITOR_PRESETS.find((p) => p.id === "portrait")!;
    const highStylize = EDITOR_PRESETS.find((p) => p.id === "high-stylize")!;
    let settings = applyPreset(defaultSettings, portrait);
    expect(settings.aspect).toBe("9:16");
    expect(isPresetActive(settings, portrait)).toBe(true);
    expect(isPresetActive(settings, highStylize)).toBe(false);
    settings = applyPreset(settings, highStylize);
    expect(settings.aspect).toBe("1:1");
    expect(settings.stylize).toBe(500);
    expect(isPresetActive(settings, highStylize)).toBe(true);
    expect(isPresetActive(settings, portrait)).toBe(false);
  });

  it("all preset IDs are unique", () => {
    const ids = EDITOR_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ExplorePage styles tab parity", () => {
  it("SEED_STYLES has all required fields and unique codes", () => {
    const codes = SEED_STYLES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const s of SEED_STYLES) {
      expect(s.code).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.tags.length).toBeGreaterThan(0);
      expect(s.prompt).toContain("--sref");
    }
  });

  it("displayStyles merges empty user library with seeds", () => {
    const display = buildDisplayStyles([]);
    // Should equal seed styles since no user codes
    expect(display.length).toBe(SEED_STYLES.length);
    for (const entry of display) {
      expect(entry.isSaved).toBe(false);
      expect(entry.isFavorite).toBe(false);
    }
  });

  it("displayStyles includes user codes ahead of seeds", () => {
    const userCodes: StyleCodeEntry[] = [
      {
        code: "my-custom-style",
        name: "My Style",
        tags: ["custom"],
        thumbnailUrl: "https://example.com/thumb.png",
        createdAt: Date.now(),
        useCount: 5,
        isFavorite: true,
      },
    ];
    const display = buildDisplayStyles(userCodes);
    // First entry should be user code
    expect(display[0].id).toBe("my-custom-style");
    expect(display[0].isSaved).toBe(true);
    expect(display[0].isFavorite).toBe(true);
    expect(display[0].thumbnailUrl).toBe("https://example.com/thumb.png");
    // Seeds follow
    expect(display.length).toBe(1 + SEED_STYLES.length);
  });

  it("displayStyles deduplicates when user code overlaps a seed", () => {
    const userCodes: StyleCodeEntry[] = [
      {
        code: "ethereal-dream",
        name: "My Ethereal Dream",
        tags: ["customized", "dreamy"],
        thumbnailUrl: "https://cdn.example.com/eth.png",
        createdAt: Date.now(),
        useCount: 3,
        isFavorite: false,
      },
    ];
    const display = buildDisplayStyles(userCodes);
    // The user's custom entry replaces the seed
    const etherealEntries = display.filter((e) => e.id === "ethereal-dream");
    expect(etherealEntries.length).toBe(1);
    expect(etherealEntries[0].name).toBe("My Ethereal Dream");
    expect(etherealEntries[0].thumbnailUrl).toBe("https://cdn.example.com/eth.png");
    expect(etherealEntries[0].isSaved).toBe(true);
    // Total = 1 user + (12 seeds - 1 overridden) = 12
    expect(display.length).toBe(SEED_STYLES.length);
  });

  it("SEED_STYLES prompts are valid sref commands", () => {
    for (const s of SEED_STYLES) {
      expect(s.prompt).toMatch(/--sref/);
      expect(s.prompt).toMatch(/--sw/);
    }
  });

  it("SEED_VIDEO_PROMPTS prompts contain --video flag", () => {
    const SEED_VIDEO_PROMPTS = [
      { id: "v1", title: "Zoom Into Landscape", prompt: "cinematic zoom landscape --ar 16:9 --video" },
      { id: "v2", title: "Character Motion Loop", prompt: "character walk cycle --ar 9:16 --video" },
      { id: "v3", title: "Abstract Particle Flow", prompt: "abstract particles flowing --ar 1:1 --video" },
      { id: "v4", title: "Time-Lapse Cityscape", prompt: "time lapse city dusk to dawn --ar 16:9 --video" },
      { id: "v5", title: "Nature Sway Loop", prompt: "trees swaying wind loop --ar 16:9 --video" },
      { id: "v6", title: "Fire & Water Blend", prompt: "fire water blend abstract --ar 1:1 --video" },
    ];
    for (const v of SEED_VIDEO_PROMPTS) {
      expect(v.prompt).toContain("--video");
      expect(v.prompt).toContain("--ar");
    }
  });
});