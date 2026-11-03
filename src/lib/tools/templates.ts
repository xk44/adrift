/**
 * Tools hub "template" cards: preset prompts over edit engines that already
 * exist (catalog LoRA tools or /api/jobs/action edit actions). No new models.
 *
 * Pure data + prompt compilers so the hub, the runners and the tests share
 * one source of truth. All prompt text is our own wording.
 */

import {
  GROUNDED_FAMILY,
  KREA2_EDIT_PACK,
  editLorasIn,
  type CatalogTool,
  type EditLoraListResponse,
} from "./toolsPage";
import {
  COMMERCIAL_FACE_PRESETS,
  FASHION_SETS,
  WARDROBE_PRESETS,
  WHAT_IF_PRESETS,
} from "./lookCatalogs";
import {
  badgeTooltip,
  sourceFor,
  type BadgeSource,
  type LicenseBadge,
} from "./licenseBadges";

// Edit engines

/**
 * Mirrors toolsDoc MODEL_FAMILIES (licenseConsistency.test.ts).
 * apache = open license (commercial OK); nc = non-commercial; cap = open
 * weights under a revenue-capped community license; check = terms could not
 * be confirmed. `licenseName` names the license for nc / cap / check.
 */
export type EngineLicense = "apache" | "nc" | "cap" | "check";

export type EditEngineId =
  | "krea2"
  | "qwen2511"
  | "qwen21"
  | "flux3"
  | "fibo2"
  | "qwen2511-remove"
  | "qwen21-realism"
  | "qwen21-next-scene"
  | "qwen2511-dual"
  | "krea2-dual";

export type EditEngineRun =
  | { kind: "catalog"; toolId: string }
  | {
      kind: "action";
      action: string;
      pack: string;
      /** Needs an installed grounded Krea 2 edit LoRA (workflow overrides). */
      groundedLora?: boolean;
      /** Fixed graph overrides applied to every run on this engine. */
      overrides?: Record<string, string | number>;
    };

export interface EditEngine {
  id: EditEngineId;
  /** Short picker label. */
  label: string;
  /** Open model it runs on (shown subtly). */
  model: string;
  license: EngineLicense;
  /** License name behind an nc / cap / check engine (tooltip terms + link). */
  licenseName?: string;
  /** 1 = single photo, 2 = photo + reference (dual-image edit). */
  refs: 1 | 2;
  /**
   * Purpose-built for the tool that lists it first (e.g. the next-scene LoRA
   * for Storyboard): stays the default even when its license is narrower.
   */
  specialist?: boolean;
  run: EditEngineRun;
  /**
   * How the compiled prompt is fed. "instruction": a full edit instruction.
   * "fragment": the tool wraps it in its own template (e.g. "Remove {x} …").
   * "none": the tool ignores prompts (fixed effect).
   */
  promptStyle: "instruction" | "fragment" | "none";
}

export const EDIT_ENGINES: Record<EditEngineId, EditEngine> = {
  krea2: {
    id: "krea2",
    label: "Krea 2",
    model: "Krea 2 edit",
    // krea2_general_edit_v2 LoRA: non-commercial (conradlocke/krea2-identity-edit
    // LICENSE_V2.md) on top of the Krea 2 revenue cap.
    license: "nc",
    licenseName: "Krea 2 Identity Edit V2 License",
    refs: 1,
    run: { kind: "catalog", toolId: "krea2-general-edit" },
    promptStyle: "instruction",
  },
  qwen2511: {
    id: "qwen2511",
    label: "Qwen Edit 2511",
    model: "Qwen-Image-Edit 2511",
    license: "apache",
    refs: 1,
    run: {
      kind: "action",
      action: "edit_qwen",
      pack: "qwen-image-edit",
      // Node 2 is the edit-LoRA dropdown slot (Multi-Angle by default); a
      // plain instruction edit must not rotate the camera.
      overrides: { "2.strength_model": 0 },
    },
    promptStyle: "instruction",
  },
  qwen21: {
    id: "qwen21",
    label: "Qwen 2.1",
    model: "Qwen-Image 2.1",
    license: "nc",
    licenseName: "Qwen Research License",
    refs: 1,
    run: { kind: "action", action: "edit_qwen21_fast", pack: "qwen-image-21" },
    promptStyle: "instruction",
  },
  flux3: {
    id: "flux3",
    label: "FLUX.3",
    model: "FLUX.3 Klein",
    license: "cap",
    licenseName: "FLUX Kommunity License v1.0",
    refs: 1,
    run: { kind: "action", action: "edit_flux3_fast", pack: "flux3" },
    promptStyle: "instruction",
  },
  fibo2: {
    id: "fibo2",
    label: "FIBO 2.0",
    model: "Bria FIBO 2.0 (full-res paste-back)",
    license: "nc",
    licenseName: "CC BY-NC 4.0",
    refs: 1,
    run: { kind: "action", action: "edit_fibo", pack: "fibo2" },
    promptStyle: "instruction",
  },
  "qwen2511-remove": {
    id: "qwen2511-remove",
    label: "Qwen remover",
    model: "Qwen-Image-Edit 2511",
    license: "apache",
    refs: 1,
    run: { kind: "catalog", toolId: "qwen2511-remove" },
    promptStyle: "fragment",
  },
  "qwen21-next-scene": {
    id: "qwen21-next-scene",
    specialist: true,
    label: "Next-scene LoRA",
    model: "Qwen-Image 2.1 + next-scene LoRA",
    license: "nc",
    licenseName: "Qwen Research License",
    refs: 1,
    run: { kind: "catalog", toolId: "qwen21-next-scene" },
    // The catalog tool wraps the text as "Next Scene: {prompt}".
    promptStyle: "fragment",
  },
  "qwen21-realism": {
    id: "qwen21-realism",
    specialist: true,
    label: "Phone-photo LoRA",
    model: "Qwen-Image 2.1",
    license: "nc",
    licenseName: "Qwen Research License",
    refs: 1,
    run: { kind: "catalog", toolId: "qwen21-realism" },
    promptStyle: "none",
  },
  "qwen2511-dual": {
    id: "qwen2511-dual",
    label: "Qwen Edit 2511",
    model: "Qwen-Image-Edit 2511",
    license: "apache",
    refs: 2,
    run: {
      kind: "action",
      action: "edit_instruct_dual",
      pack: "qwen-image-edit",
    },
    promptStyle: "instruction",
  },
  "krea2-dual": {
    id: "krea2-dual",
    label: "Krea 2",
    model: "Krea 2 edit + grounded LoRA",
    license: "cap",
    licenseName: "Krea 2 Community License",
    refs: 2,
    run: {
      kind: "action",
      action: "edit_instruct_dual",
      pack: KREA2_EDIT_PACK,
      groundedLora: true,
    },
    promptStyle: "instruction",
  },
};

/** Default single-image engine preference (first available wins). */
export const SINGLE_ENGINES: EditEngineId[] = [
  "krea2",
  "qwen2511",
  "qwen21",
  "flux3",
  "fibo2",
];
/** Two-image (photo + reference) engine preference. */
export const DUAL_ENGINES: EditEngineId[] = ["qwen2511-dual", "krea2-dual"];

export interface EngineContext {
  catalog: CatalogTool[] | null;
  packIds: Set<string> | null;
  editLoras: EditLoraListResponse | null;
}

export interface EngineAvailability {
  available: boolean;
  checking: boolean;
  reason: string | null;
}

export function engineAvailability(
  engine: EditEngine,
  ctx: EngineContext,
): EngineAvailability {
  if (engine.run.kind === "catalog") {
    if (!ctx.catalog) return { available: false, checking: true, reason: null };
    const id = engine.run.toolId;
    const tool = ctx.catalog.find((t) => t.id === id);
    if (!tool)
      return {
        available: false,
        checking: false,
        reason: `${engine.model} tool isn't listed on this server.`,
      };
    if (!tool.available)
      return {
        available: false,
        checking: false,
        reason: `${engine.model} isn't installed on this server.`,
      };
    return { available: true, checking: false, reason: null };
  }
  if (!ctx.packIds) return { available: false, checking: true, reason: null };
  if (!ctx.packIds.has(engine.run.pack))
    return {
      available: false,
      checking: false,
      reason: `The ${engine.run.pack} pack isn't installed on this server.`,
    };
  if (engine.run.groundedLora) {
    if (!ctx.editLoras)
      return { available: false, checking: true, reason: null };
    if (editLorasIn(ctx.editLoras, GROUNDED_FAMILY).length === 0)
      return {
        available: false,
        checking: false,
        reason: "Needs a grounded Krea 2 edit LoRA.",
      };
  }
  return { available: true, checking: false, reason: null };
}

/** Engines from `ids` that can run now, in preference order. */
export function availableEngines(
  ids: EditEngineId[],
  ctx: EngineContext,
): EditEngine[] {
  return ids
    .map((id) => EDIT_ENGINES[id])
    .filter((e) => engineAvailability(e, ctx).available);
}

/**
 * Default engine from an installed list (preference order): a purpose-built
 * specialist listed first, else the first one whose weights allow commercial
 * use, else the first. Non-commercial engines stay one click away in the
 * picker.
 */
export function preferredEngine(engines: EditEngine[]): EditEngine | null {
  if (engines[0]?.specialist) return engines[0];
  return engines.find((e) => e.license !== "nc") ?? engines[0] ?? null;
}

/** Card-level availability over a list of engines (any one is enough). */
export function enginesAvailability(
  ids: EditEngineId[],
  ctx: EngineContext,
): EngineAvailability {
  const states = ids.map((id) => engineAvailability(EDIT_ENGINES[id], ctx));
  if (states.some((s) => s.available))
    return { available: true, checking: false, reason: null };
  if (states.some((s) => s.checking))
    return { available: false, checking: true, reason: null };
  const names = ids.map((id) => EDIT_ENGINES[id].model);
  return {
    available: false,
    checking: false,
    reason: `Needs one of: ${[...new Set(names)].join(", ")} (none installed).`,
  };
}

const ENGINE_BADGE: Record<EngineLicense, LicenseBadge> = {
  apache: "open",
  nc: "nc",
  cap: "cap",
  check: "check",
};

export function engineBadge(engine: EditEngine): LicenseBadge {
  return ENGINE_BADGE[engine.license];
}

export function engineSources(engine: EditEngine): BadgeSource[] {
  return engine.licenseName ? [sourceFor(engine.licenseName)] : [];
}

/** One-line license note for the engine picker (null = open license). */
export function engineLicenseNote(engine: EditEngine): string | null {
  const badge = engineBadge(engine);
  if (badge === "open") return null;
  if (badge === "nc")
    return `Non-commercial license (${engine.licenseName ?? engine.model})`;
  return badgeTooltip(badge, engineSources(engine)).split("\n")[0];
}

// Prompt helpers

/** Collapse whitespace and cap length so user notes can't blow up a prompt. */
export function cleanNotes(notes: string | undefined, max = 300): string {
  return (notes ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Append optional user notes as a final sentence. */
export function withNotes(prompt: string, notes?: string): string {
  const n = cleanNotes(notes);
  if (!n) return prompt;
  return `${prompt.trim()} ${/[.!?]$/.test(n) ? n : `${n}.`}`;
}

/** Fill `{key}` placeholders; unknown keys become empty; tidy spacing. */
export function fillTemplate(
  template: string,
  values: Record<string, string | undefined>,
): string {
  return template
    .replace(/\{(\w+)\}/g, (_, k: string) => cleanNotes(values[k]))
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Template cards (S-tier)

export interface TemplatePreset {
  id: string;
  label: string;
  /** Full instruction for "instruction" engines. */
  prompt: string;
  /** Short object phrase for "fragment" engines (e.g. the Qwen remover). */
  fragment?: string;
  /** Optional section heading in the preset picker (long catalogs). */
  group?: string;
}

export type TemplateId =
  | "remove_text"
  | "headshot"
  | "skin_enhancer"
  | "batch_restyle"
  | "what_if"
  | "commercial_faces"
  | "ai_stylist"
  | "fashion_factory";

/** One-click preset bundle for multi templates (e.g. a capsule wardrobe). */
export interface TemplateSet {
  id: string;
  label: string;
  presetIds: string[];
}

export interface TemplateDef {
  id: TemplateId;
  title: string;
  subtitle: string;
  hubCategory: string;
  icon: string;
  engines: EditEngineId[];
  presets: TemplatePreset[];
  /** Pick several presets at once; one job per preset. */
  multi?: { max: number; defaultCount: number };
  /** Multi only: one-click bundles that replace the selection. */
  sets?: TemplateSet[];
  notesLabel: string;
  notesPlaceholder: string;
  aliases?: string[];
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: "remove_text",
    title: "Remove Text",
    subtitle: "Erase captions, signs, logos and watermarks",
    hubCategory: "Edit",
    icon: "Type",
    engines: ["qwen2511-remove", "krea2", "qwen2511", "qwen21", "flux3"],
    presets: [
      {
        id: "all",
        label: "All text",
        fragment:
          "all visible text, letters, captions, subtitles, logos and watermarks",
        prompt:
          "Erase every piece of visible text in the picture, including captions, subtitles, signs, logos and watermarks. Fill those areas so the surfaces underneath look untouched, and leave everything else exactly as it is.",
      },
      {
        id: "overlay",
        label: "Overlays only",
        fragment: "the overlaid captions, subtitles and watermarks",
        prompt:
          "Remove the captions, subtitles and watermarks laid over the picture. Keep text that physically belongs to the scene, such as signs and labels, and restore the pixels behind the overlays.",
      },
      {
        id: "signs",
        label: "Signs and labels",
        fragment: "the writing on signs, labels and packaging",
        prompt:
          "Blank out the writing on signs, labels, posters and packaging so the surfaces are plain, keeping their shape, color and lighting. Do not change anything else.",
      },
    ],
    notesLabel: "Anything specific (optional)",
    notesPlaceholder: "the red watermark in the corner",
    aliases: ["watermark", "caption", "text remover"],
  },
  {
    id: "headshot",
    title: "Headshot Generator",
    subtitle: "Turn a casual photo into a professional headshot",
    hubCategory: "Identity",
    icon: "UserSquare",
    engines: ["krea2", "qwen2511", "qwen21", "flux3"],
    presets: [
      {
        id: "corporate",
        label: "Corporate",
        prompt:
          "Make this a professional corporate headshot of the same person: shoulders-up framing, a tailored dark blazer, a plain soft-gray studio backdrop, soft key light with gentle fill, sharp eyes, natural skin. Keep their face, identity and hairstyle unchanged.",
      },
      {
        id: "creative",
        label: "Creative",
        prompt:
          "Make this a modern creative-industry headshot of the same person: relaxed smart-casual clothes, a warm textured studio wall, window-style side light, shallow depth of field. Keep their face and identity unchanged.",
      },
      {
        id: "outdoor",
        label: "Outdoor",
        prompt:
          "Make this an outdoor portrait headshot of the same person: golden-hour backlight, a softly blurred park or street background, natural smile, crisp focus on the eyes. Keep their face and identity unchanged.",
      },
      {
        id: "bw",
        label: "Black and white",
        prompt:
          "Make this a classic black-and-white studio headshot of the same person: dramatic single key light, deep black background, fine film grain, rich midtones. Keep their face and identity unchanged.",
      },
      {
        id: "linkedin",
        label: "Bright and friendly",
        prompt:
          "Make this a bright, friendly profile headshot of the same person: clean white background, even high-key lighting, a light shirt, approachable expression. Keep their face and identity unchanged.",
      },
    ],
    notesLabel: "Extra details (optional)",
    notesPlaceholder: "navy suit, no tie",
    aliases: ["portrait", "profile photo", "linkedin"],
  },
  {
    id: "skin_enhancer",
    title: "Skin Enhancer",
    subtitle: "Realistic skin texture, without the plastic look",
    hubCategory: "Enhance",
    icon: "Sparkles",
    engines: ["krea2", "qwen2511", "qwen21", "flux3", "qwen21-realism"],
    presets: [
      {
        id: "natural",
        label: "Natural texture",
        prompt:
          "Give the person realistic skin: visible pores, fine texture and subtle natural variation in tone, replacing any smooth or waxy look. Keep the face shape, makeup, expression, lighting and everything else the same.",
      },
      {
        id: "retouch",
        label: "Light retouch",
        prompt:
          "Lightly retouch the skin: even out redness and blemishes while keeping real pores and texture, like a careful magazine retouch. Keep identity, lighting and composition unchanged.",
      },
      {
        id: "glow",
        label: "Healthy glow",
        prompt:
          "Give the skin a healthy, slightly dewy glow with natural highlights on the cheekbones and nose, keeping real texture and pores. Do not change the person's features or the scene.",
      },
    ],
    notesLabel: "Extra details (optional)",
    notesPlaceholder: "keep the freckles",
    aliases: ["skin", "retouch", "realism", "pores"],
  },
  {
    id: "batch_restyle",
    title: "Photo Dump",
    subtitle: "One photo in, a set of restyled shots out",
    hubCategory: "Portraits",
    icon: "LayoutGrid",
    engines: ["krea2", "qwen2511", "qwen21", "flux3"],
    multi: { max: 10, defaultCount: 4 },
    presets: [
      {
        id: "film",
        label: "35mm film",
        prompt:
          "Re-shoot this as a candid 35mm film snapshot: warm color cast, soft grain, slight halation around highlights. Keep the same person and scene.",
      },
      {
        id: "flash",
        label: "Night flash",
        prompt:
          "Turn this into a night-time photo lit by a harsh on-camera flash, deep shadows behind the subject, party-snapshot feel. Keep the same person.",
      },
      {
        id: "golden",
        label: "Golden hour",
        prompt:
          "Relight this as golden hour: low warm sun from the side, long soft shadows, glowing rim light on the hair. Keep the same person and composition.",
      },
      {
        id: "mirror",
        label: "Mirror selfie",
        prompt:
          "Make this a mirror selfie of the same person in a stylish apartment, phone in hand, natural daylight from a window.",
      },
      {
        id: "cafe",
        label: "Cafe table",
        prompt:
          "Place the same person at a sunny sidewalk cafe table with a coffee cup, relaxed pose, soft background bokeh.",
      },
      {
        id: "beach",
        label: "Beach day",
        prompt:
          "Place the same person on a bright beach at midday, light summer clothes, turquoise water behind, crisp sunlight.",
      },
      {
        id: "city",
        label: "City street",
        prompt:
          "Place the same person walking down a busy city street at dusk, neon signs and car lights blurred in the background.",
      },
      {
        id: "polaroid",
        label: "Instant photo",
        prompt:
          "Make this look like an instant-camera photo: faded colors, soft focus, slight vignette, creamy highlights. Keep the same person and scene.",
      },
      {
        id: "bw",
        label: "Black and white",
        prompt:
          "Convert this into a moody black-and-white street photo with strong contrast and fine grain. Keep the same person and scene.",
      },
      {
        id: "studio",
        label: "Studio color",
        prompt:
          "Re-shoot the same person in a studio against a bold solid-color backdrop, fashion lighting, clean sharp look.",
      },
    ],
    notesLabel: "Applies to every shot (optional)",
    notesPlaceholder: "wearing a black leather jacket",
    aliases: ["instadump", "batch", "restyle", "photo dump"],
  },
  {
    id: "what_if",
    title: "What If",
    subtitle: "You in your 80s, as a statue, in the 1920s and more",
    hubCategory: "Portraits",
    icon: "WandSparkles",
    engines: ["krea2", "qwen2511", "qwen21", "flux3"],
    multi: { max: 6, defaultCount: 1 },
    presets: WHAT_IF_PRESETS,
    notesLabel: "Applies to every shot (optional)",
    notesPlaceholder: "keep the red scarf",
    aliases: ["what if", "transform", "age", "statue", "era", "costume"],
  },
  {
    id: "commercial_faces",
    title: "Commercial Faces",
    subtitle:
      "Casting looks for ads: lifestyle, professional, beauty, studio setups",
    hubCategory: "Identity",
    icon: "UserSquare",
    engines: ["krea2", "qwen2511", "qwen21", "flux3"],
    multi: { max: 6, defaultCount: 1 },
    presets: COMMERCIAL_FACE_PRESETS,
    notesLabel: "Extra details (optional)",
    notesPlaceholder: "short curly hair, warm smile",
    aliases: ["casting", "commercial", "ad model", "headshot", "comp card"],
  },
  {
    id: "ai_stylist",
    title: "AI Stylist",
    subtitle:
      "Try on outfits from a built-in wardrobe, no garment photo needed",
    hubCategory: "Edit",
    icon: "Shirt",
    engines: ["krea2", "qwen2511", "qwen21", "flux3"],
    multi: { max: 4, defaultCount: 1 },
    presets: WARDROBE_PRESETS,
    notesLabel: "Color or fit (optional)",
    notesPlaceholder: "make it dark green and slightly oversized",
    aliases: ["stylist", "wardrobe", "outfit", "try on", "clothes", "fashion"],
  },
  {
    id: "fashion_factory",
    title: "Fashion Factory",
    subtitle:
      "One model photo, a whole outfit set: pick a capsule and get every look in one click",
    hubCategory: "Portraits",
    icon: "Shirt",
    engines: ["krea2", "qwen2511", "qwen21", "flux3"],
    multi: { max: 8, defaultCount: 0 },
    sets: FASHION_SETS,
    presets: WARDROBE_PRESETS,
    notesLabel: "Applies to every look (optional)",
    notesPlaceholder: "keep the same white sneakers in every look",
    aliases: [
      "fashion factory",
      "lookbook",
      "outfit set",
      "capsule wardrobe",
      "catalog",
      "batch outfits",
      "model photo",
    ],
  },
];

/** Preset ids of a set, unknown ids dropped, capped at the template's max. */
export function templateSetIds(template: TemplateDef, setId: string): string[] {
  const set = template.sets?.find((x) => x.id === setId);
  if (!set) return [];
  const known = new Set(template.presets.map((p) => p.id));
  return set.presetIds
    .filter((id, i, a) => known.has(id) && a.indexOf(id) === i)
    .slice(0, template.multi?.max ?? 1);
}

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Prompt for one preset on one engine. Fragment engines get the short object
 * phrase (notes appended with a comma); "none" engines get "".
 */
export function compileTemplatePrompt(
  template: TemplateDef,
  presetId: string,
  engine: EditEngine,
  notes?: string,
): string {
  const preset =
    template.presets.find((p) => p.id === presetId) ?? template.presets[0];
  if (engine.promptStyle === "none") return "";
  if (engine.promptStyle === "fragment") {
    const base = preset.fragment ?? preset.prompt;
    const n = cleanNotes(notes);
    return n ? `${base}, and ${n}` : base;
  }
  return withNotes(preset.prompt, notes);
}

/** Presets split into their `group` sections, in first-seen order. */
export function presetGroups(
  presets: TemplatePreset[],
): { group: string | null; presets: TemplatePreset[] }[] {
  const out: { group: string | null; presets: TemplatePreset[] }[] = [];
  for (const p of presets) {
    const group = p.group ?? null;
    let g = out.find((x) => x.group === group);
    if (!g) {
      g = { group, presets: [] };
      out.push(g);
    }
    g.presets.push(p);
  }
  return out;
}

/** Batch: one prompt per selected preset (unknown ids dropped, capped). */
export function compileBatchPrompts(
  template: TemplateDef,
  presetIds: string[],
  engine: EditEngine,
  notes?: string,
): { presetId: string; label: string; prompt: string }[] {
  const max = template.multi?.max ?? 1;
  const seen = new Set<string>();
  const out: { presetId: string; label: string; prompt: string }[] = [];
  for (const id of presetIds) {
    if (seen.has(id)) continue;
    const preset = template.presets.find((p) => p.id === id);
    if (!preset) continue;
    seen.add(id);
    out.push({
      presetId: id,
      label: preset.label,
      prompt: compileTemplatePrompt(template, id, engine, notes),
    });
    if (out.length >= max) break;
  }
  return out;
}

// Soul Cast-style actor builder → Imagine prompt

export interface CastOption {
  id: string;
  label: string;
  text: string;
}

export interface CastField {
  key: "genre" | "era" | "archetype" | "build" | "age" | "outfit" | "shot";
  label: string;
  options: CastOption[];
}

export const CAST_FIELDS: CastField[] = [
  {
    key: "genre",
    label: "Genre",
    options: [
      { id: "drama", label: "Drama", text: "a grounded character drama" },
      { id: "action", label: "Action", text: "a high-stakes action film" },
      { id: "noir", label: "Noir", text: "a rain-soaked film noir" },
      { id: "horror", label: "Horror", text: "a slow-burn horror film" },
      { id: "comedy", label: "Comedy", text: "a warm ensemble comedy" },
      {
        id: "scifi",
        label: "Sci-fi",
        text: "a near-future science-fiction film",
      },
      { id: "western", label: "Western", text: "a dusty frontier western" },
      { id: "fantasy", label: "Fantasy", text: "an epic fantasy saga" },
    ],
  },
  {
    key: "era",
    label: "Era",
    options: [
      { id: "1920s", label: "1920s", text: "set in the 1920s" },
      { id: "1960s", label: "1960s", text: "set in the 1960s" },
      { id: "1980s", label: "1980s", text: "set in the 1980s" },
      { id: "1990s", label: "1990s", text: "set in the 1990s" },
      { id: "2000s", label: "2000s", text: "set in the early 2000s" },
      { id: "today", label: "Today", text: "set in the present day" },
      { id: "future", label: "Future", text: "set decades in the future" },
    ],
  },
  {
    key: "archetype",
    label: "Archetype",
    options: [
      {
        id: "hero",
        label: "Hero",
        text: "a determined hero with quiet resolve",
      },
      {
        id: "rebel",
        label: "Rebel",
        text: "a restless rebel who breaks the rules",
      },
      { id: "sage", label: "Sage", text: "a calm, watchful sage" },
      { id: "explorer", label: "Explorer", text: "a weathered explorer" },
      { id: "lover", label: "Lover", text: "a romantic lead with a soft gaze" },
      { id: "jester", label: "Jester", text: "a mischievous joker" },
      { id: "ruler", label: "Ruler", text: "a commanding leader" },
      {
        id: "caregiver",
        label: "Caregiver",
        text: "a kind, protective caregiver",
      },
      { id: "creator", label: "Creator", text: "an obsessive artist" },
      { id: "magician", label: "Magician", text: "an enigmatic mystic" },
      {
        id: "everyman",
        label: "Everyman",
        text: "an ordinary, relatable everyman",
      },
      { id: "innocent", label: "Innocent", text: "a hopeful innocent" },
    ],
  },
  {
    key: "age",
    label: "Age",
    options: [
      { id: "20s", label: "20s", text: "in their twenties" },
      { id: "30s", label: "30s", text: "in their thirties" },
      { id: "40s", label: "40s", text: "in their forties" },
      { id: "60s", label: "60+", text: "in their sixties" },
    ],
  },
  {
    key: "build",
    label: "Look",
    options: [
      { id: "any", label: "Any", text: "" },
      {
        id: "rugged",
        label: "Rugged",
        text: "rugged features and a stubbled jaw",
      },
      { id: "elegant", label: "Elegant", text: "elegant, sharp features" },
      {
        id: "freckled",
        label: "Freckled",
        text: "freckles and a bright complexion",
      },
      {
        id: "scarred",
        label: "Scarred",
        text: "a faint scar across one cheek",
      },
      { id: "athletic", label: "Athletic", text: "an athletic build" },
    ],
  },
  {
    key: "outfit",
    label: "Wardrobe",
    options: [
      {
        id: "period",
        label: "Period",
        text: "wearing period-accurate costume",
      },
      { id: "street", label: "Street", text: "wearing worn streetwear" },
      { id: "formal", label: "Formal", text: "wearing a sharp formal outfit" },
      { id: "work", label: "Workwear", text: "wearing practical workwear" },
      { id: "uniform", label: "Uniform", text: "wearing a uniform" },
      { id: "armor", label: "Armor", text: "wearing battle-worn armor" },
    ],
  },
  {
    key: "shot",
    label: "Shot",
    options: [
      { id: "portrait", label: "Close-up", text: "tight close-up portrait" },
      { id: "medium", label: "Medium", text: "medium shot from the waist up" },
      { id: "full", label: "Full body", text: "full-body shot in the set" },
    ],
  },
];

export type CastSelection = Partial<Record<CastField["key"], string>>;

export function defaultCastSelection(): CastSelection {
  const out: CastSelection = {};
  for (const f of CAST_FIELDS) out[f.key] = f.options[0].id;
  return out;
}

function castText(key: CastField["key"], sel: CastSelection): string {
  const field = CAST_FIELDS.find((f) => f.key === key);
  if (!field) return "";
  const opt = field.options.find((o) => o.id === sel[key]) ?? field.options[0];
  return opt.text;
}

/**
 * Compile the actor sheet into a single cinematic t2i prompt for Imagine
 * (default pack). Deterministic: same selection → same prompt.
 */
export function compileCastPrompt(sel: CastSelection, notes?: string): string {
  const archetype = castText("archetype", sel);
  const age = castText("age", sel);
  const look = castText("build", sel);
  const outfit = castText("outfit", sel);
  const genre = castText("genre", sel);
  const era = castText("era", sel);
  const shot = castText("shot", sel);
  const who = [archetype, age, look ? `with ${look}` : "", outfit]
    .filter(Boolean)
    .join(", ");
  const base = `Cinematic film still, ${shot} of ${who}. A casting photo for ${genre} ${era}. Motivated lighting, anamorphic lens, shallow depth of field, natural skin texture, film grain`;
  return withNotes(`${base}.`, notes);
}

// Placeholder cards (no open model wired yet)

export interface PlaceholderDef {
  id: string;
  title: string;
  subtitle: string;
  hubCategory: string;
  icon: string;
  reason: string;
}

export const PLACEHOLDERS: PlaceholderDef[] = [];
