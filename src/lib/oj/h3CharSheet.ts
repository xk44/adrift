/**
 * H3 Character Sheet (MiniMax H3 Ref2VA, packs/minimax/charsheet.json): a
 * prompt/layout compiler that turns a character description, 1-3 reference
 * photos and a set of chosen views into one turnaround sheet. The graph runs
 * MiniMaxH3ReferenceToVideo for 5 frames (the node's minimum) and saves
 * frame 0 as the still sheet.
 *
 * View catalog and the structured Ref2VA sheet-prompt idea adapted from
 * H3-Character-Sheet-Designer, MIT (c) ukr8b3g-cmyk
 * (github.com/ukr8b3g-cmyk/H3-Character-Sheet-Designer). Re-implemented
 * here; none of its artwork or code is shipped.
 *
 *   params.views        CSV or array of view ids (CHAR_SHEET_VIEWS)
 *   params.prompt       character description
 *   params.name         character name (optional)
 *   params.size         CHAR_SHEET_SIZES id (default "landscape")
 *   params.render       CHAR_SHEET_RENDERS id (default "none")
 *   params.secondRefImage / params.extraRefImages  references 2..3
 *   params.refRoles     role per reference 2..3, aligned with those refs
 *   params.h3Speed / seed   as Reference to Video (Turbo 8-step by default)
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { applyH3ExtraLoras } from "./h3Video";
import { applyH3Speed } from "./h3Speed";

export const CHAR_SHEET_ACTION = "h3_charsheet";
export const CHAR_SHEET_MAX_REFS = 3;
/** MiniMaxH3ReferenceToVideo's minimum length (17k + 5 grid). */
export const CHAR_SHEET_FRAMES = 5;
const R2V_CLASS = "MiniMaxH3ReferenceToVideo";
const GRID = 32;

export type CharSheetGroup = "head" | "body" | "outfit" | "details";
/** Layout rows: heads on top, full figures in the middle, details below. */
export type CharSheetBand = "head" | "figure" | "details";

export interface CharSheetView {
  id: string;
  group: CharSheetGroup;
  label: string;
  /** Panel description used in the prompt. */
  pose: string;
}

export const CHAR_SHEET_GROUPS: { id: CharSheetGroup; label: string }[] = [
  { id: "head", label: "Head" },
  { id: "body", label: "Body" },
  { id: "outfit", label: "Outfit" },
  { id: "details", label: "Hands & feet" },
];

const BAND_OF: Record<CharSheetGroup, CharSheetBand> = {
  head: "head",
  body: "figure",
  outfit: "figure",
  details: "details",
};

/** Relative row height per band. */
const BAND_WEIGHT: Record<CharSheetBand, number> = {
  head: 1,
  figure: 2,
  details: 1,
};

/** Narrowest panel before a band wraps onto another row. */
export const CHAR_SHEET_MIN_CELL = 160;

export const CHAR_SHEET_VIEWS: CharSheetView[] = [
  {
    id: "head_front",
    group: "head",
    label: "Front",
    pose: "head and shoulders, facing the viewer straight on, both eyes and ears visible, neutral expression",
  },
  {
    id: "head_34_right",
    group: "head",
    label: "3/4 right",
    pose: "head and shoulders turned three-quarters toward screen right, nose points to screen RIGHT, the far eye partly hidden",
  },
  {
    id: "head_profile_right",
    group: "head",
    label: "Profile right",
    pose: "strict side profile, nose points to screen RIGHT, only one eye visible, the back of the head toward screen left",
  },
  {
    id: "head_back",
    group: "head",
    label: "Back",
    pose: "the back of the head and shoulders, face not visible, hairstyle seen from behind",
  },
  {
    id: "head_profile_left",
    group: "head",
    label: "Profile left",
    pose: "strict side profile, nose points to screen LEFT, only one eye visible, the back of the head toward screen right",
  },
  {
    id: "head_34_left",
    group: "head",
    label: "3/4 left",
    pose: "head and shoulders turned three-quarters toward screen left, nose points to screen LEFT, the far eye partly hidden",
  },
  {
    id: "body_front",
    group: "body",
    label: "Front",
    pose: "full body from head to toe, facing the viewer, relaxed A-pose with arms slightly away from the body, feet visible",
  },
  {
    id: "body_side",
    group: "body",
    label: "Side",
    pose: "full body from head to toe in strict side view, nose points to screen RIGHT, arms relaxed, feet visible",
  },
  {
    id: "body_back",
    group: "body",
    label: "Back",
    pose: "full body from head to toe seen from behind, face not visible, arms relaxed, feet visible",
  },
  {
    id: "outfit_front",
    group: "outfit",
    label: "Outfit front",
    pose: "the complete outfit from the front, full figure, every garment, fastening and accessory clearly readable",
  },
  {
    id: "outfit_back",
    group: "outfit",
    label: "Outfit back",
    pose: "the complete outfit from behind, full figure, back details of every garment clearly readable",
  },
  {
    id: "hands",
    group: "details",
    label: "Hands",
    pose: "close-up of both hands, one palm up and one palm down, showing gloves, rings or nails as in the reference",
  },
  {
    id: "feet",
    group: "details",
    label: "Feet",
    pose: "close-up of both feet from the front and side, showing the footwear exactly as in the reference",
  },
];

const VIEW_BY_ID = new Map(CHAR_SHEET_VIEWS.map((v) => [v.id, v]));
const VIEW_ORDER = new Map(CHAR_SHEET_VIEWS.map((v, i) => [v.id, i]));

export const CHAR_SHEET_DEFAULT_VIEWS = [
  "head_front",
  "head_34_right",
  "head_profile_right",
  "body_front",
  "body_side",
  "body_back",
];

export interface CharSheetSize {
  id: string;
  label: string;
  width: number;
  height: number;
  hint?: string;
}

/** Every size is on the 32-px grid; all but "large" stay within 1344x768 px. */
export const CHAR_SHEET_SIZES: CharSheetSize[] = [
  {
    id: "landscape",
    label: "16:9",
    width: 1344,
    height: 768,
    hint: "1344x768 (default)",
  },
  { id: "portrait", label: "9:16", width: 768, height: 1344, hint: "768x1344" },
  { id: "square", label: "1:1", width: 992, height: 992, hint: "992x992" },
  {
    id: "wide",
    label: "Wide",
    width: 1504,
    height: 672,
    hint: "1504x672, a long turnaround strip",
  },
  {
    id: "large",
    label: "Large",
    width: 2816,
    height: 1280,
    hint: "2816x1280: about 3.5x the pixels, needs a 32 GB+ GPU or offloading",
  },
];
export const CHAR_SHEET_DEFAULT_SIZE = "landscape";

export const CHAR_SHEET_RENDERS: { id: string; label: string; line: string }[] =
  [
    { id: "none", label: "As reference", line: "" },
    {
      id: "photo",
      label: "Photoreal",
      line: "photorealistic studio photography, soft even key light, true-to-life skin and fabric texture",
    },
    {
      id: "anime",
      label: "Anime",
      line: "clean anime model-sheet style, crisp line art, flat cel shading",
    },
    {
      id: "3d",
      label: "3D render",
      line: "neutral-lit 3D character render, physically based materials, no stylised post effects",
    },
    {
      id: "painted",
      label: "Painted",
      line: "hand-painted concept-art style, visible brushwork, consistent palette across every panel",
    },
    {
      id: "comic",
      label: "Comic",
      line: "comic-book style, bold ink outlines, flat colours with simple shading",
    },
  ];
export const CHAR_SHEET_DEFAULT_RENDER = "none";

/** What references 2..3 show. Reference 1 is always the identity. */
export const CHAR_SHEET_REF_ROLES: {
  id: string;
  label: string;
  text: string;
}[] = [
  {
    id: "outfit",
    label: "Outfit",
    text: "the outfit: garments, colours, materials and accessories",
  },
  { id: "face", label: "Face", text: "a closer look at the face and hair" },
  {
    id: "body",
    label: "Full body",
    text: "the full body: build and proportions",
  },
  {
    id: "props",
    label: "Props & details",
    text: "props and small details: jewellery, gloves, footwear, carried items",
  },
];
export const CHAR_SHEET_DEFAULT_ROLE = "outfit";

const clean = (v: unknown, max = 600) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const sentence = (s: string) => {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};

/** View ids from CSV or an array: known ids only, deduped, catalog order. */
export function parseCharSheetViews(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const ids = new Set<string>();
  for (const v of raw) {
    const id = typeof v === "string" ? v.trim() : "";
    if (VIEW_BY_ID.has(id)) ids.add(id);
  }
  return [...ids].sort((a, b) => VIEW_ORDER.get(a)! - VIEW_ORDER.get(b)!);
}

export function charSheetSize(id: unknown): CharSheetSize {
  return (
    CHAR_SHEET_SIZES.find((s) => s.id === id) ??
    CHAR_SHEET_SIZES.find((s) => s.id === CHAR_SHEET_DEFAULT_SIZE)!
  );
}

export interface CharSheetCell {
  view: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CharSheetRow {
  band: CharSheetBand;
  y: number;
  h: number;
  cells: CharSheetCell[];
}

export interface CharSheetLayout {
  width: number;
  height: number;
  rows: CharSheetRow[];
}

const snap = (n: number) => Math.max(GRID, Math.round(n / GRID) * GRID);

/**
 * Split `total` px into `parts` weighted spans on the 32-px grid; the last
 * span takes the remainder so the spans tile `total` exactly. Callers keep
 * total >= parts * 32.
 */
function splitGrid(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let used = 0;
  weights.forEach((w, i) => {
    const left = weights.length - i - 1;
    if (!left) {
      out.push(total - used);
      return;
    }
    const span = Math.min(snap((total * w) / sum), total - used - left * GRID);
    out.push(span);
    used += span;
  });
  return out;
}

/**
 * Panel grid for the chosen views: one band per kind (heads, full figures,
 * details), a band wrapping onto more rows when its panels would get
 * narrower than CHAR_SHEET_MIN_CELL. Rows and panels snap to the 32-px grid
 * and tile the canvas exactly.
 */
export function charSheetLayout(
  views: string[],
  width: number,
  height: number,
): CharSheetLayout {
  const ids = parseCharSheetViews(views);
  const perRow = Math.max(1, Math.floor(width / CHAR_SHEET_MIN_CELL));
  const bandRows: { band: CharSheetBand; views: string[] }[] = [];
  for (const band of ["head", "figure", "details"] as CharSheetBand[]) {
    const inBand = ids.filter(
      (id) => BAND_OF[VIEW_BY_ID.get(id)!.group] === band,
    );
    if (!inBand.length) continue;
    const rows = Math.ceil(inBand.length / perRow);
    const each = Math.ceil(inBand.length / rows);
    for (let i = 0; i < inBand.length; i += each)
      bandRows.push({ band, views: inBand.slice(i, i + each) });
  }
  const maxRows = Math.max(1, Math.floor(height / GRID));
  const kept = bandRows.slice(0, maxRows);
  const heights = kept.length
    ? splitGrid(
        height,
        kept.map((r) => BAND_WEIGHT[r.band]),
      )
    : [];
  let y = 0;
  const rows = kept.map((r, i) => {
    const h = heights[i];
    const widths = splitGrid(
      width,
      r.views.map(() => 1),
    );
    let x = 0;
    const cells = r.views.map((view, j) => {
      const cell = { view, x, y, w: widths[j], h };
      x += widths[j];
      return cell;
    });
    const row = { band: r.band, y, h, cells };
    y += h;
    return row;
  });
  return { width, height, rows };
}

export function charSheetRefRole(id: unknown) {
  return (
    CHAR_SHEET_REF_ROLES.find((r) => r.id === id) ??
    CHAR_SHEET_REF_ROLES.find((r) => r.id === CHAR_SHEET_DEFAULT_ROLE)!
  );
}

const ROW_NAMES = ["Top", "Second", "Third", "Fourth", "Fifth", "Sixth"];

/**
 * Structured Ref2VA prompt (subject_definitions / summary /
 * retention_analysis / detailed_description / overall_soundscape) for a
 * still sheet: an explicit panel count, row-by-row panel poses, strict
 * profile wording, garment-retention rules and a no-motion line, since the
 * sampler renders a 5-frame clip whose first frame is kept.
 *
 * `refCount` is the number of wired references (1-3; reference 1 is
 * always the character); `refRoles` describes references 2..refCount.
 */
export function charSheetPrompt(opts: {
  layout: CharSheetLayout;
  description?: unknown;
  name?: unknown;
  render?: unknown;
  refCount: number;
  refRoles?: unknown[];
}): string {
  const { layout } = opts;
  const panels = layout.rows.reduce((n, r) => n + r.cells.length, 0);
  if (!panels)
    throw new Error(`${CHAR_SHEET_ACTION}: choose at least one view`);
  const refs = Math.max(
    1,
    Math.min(CHAR_SHEET_MAX_REFS, Math.floor(opts.refCount)),
  );
  const name = clean(opts.name, 60);
  const who = name ? `${name} (<Subject 1>)` : "<Subject 1>";
  const description = clean(opts.description, 900);
  const render =
    CHAR_SHEET_RENDERS.find((r) => r.id === opts.render)?.line ?? "";
  const roles = Array.from({ length: refs - 1 }, (_, i) =>
    charSheetRefRole(opts.refRoles?.[i]),
  );

  const lines = [
    "subject_definitions:",
    `<Subject 1> is the character in <Picture 1>${name ? `, named ${name}` : ""}.`,
    ...roles.map(
      (role, i) => `<Picture ${i + 2}> shows the same <Subject 1>: ${role.text}.`,
    ),
  ];

  const rowCount = layout.rows.length;
  lines.push(
    "",
    "summary:",
    `[reference generation] A single static character reference sheet of ${who}: exactly ${panels} panel${panels === 1 ? "" : "s"} in ${rowCount} row${rowCount === 1 ? "" : "s"} on a plain light-grey studio background, every panel showing the same character from a different view. This is a still image: no motion, no camera movement, no animation between frames.`,
  );
  if (description) lines.push(sentence(description));

  lines.push("", "retention_analysis:");
  lines.push(
    `<Subject 1> (every panel): fully_preserved - face, hair, skin tone, body proportions and outfit match <Picture 1> exactly.`,
  );
  roles.forEach((role, i) =>
    lines.push(
      `<Picture ${i + 2}>: fully_preserved - ${role.text} are taken from <Picture ${i + 2}>.`,
    ),
  );
  lines.push(
    "Garments: keep every garment, layer and colour; do not add, remove or swap clothing between panels.",
    "Gloves and footwear: keep them exactly as shown, on both hands and both feet, in every panel.",
  );

  lines.push("", "detailed_description:");
  layout.rows.forEach((row, i) => {
    const where =
      rowCount === 1 ? "One row" : `${ROW_NAMES[i] ?? `Row ${i + 1}`} row`;
    const n = row.cells.length;
    const desc = row.cells
      .map((c, j) => `(${j + 1}) ${VIEW_BY_ID.get(c.view)!.pose}`)
      .join("; ");
    lines.push(
      `${where}, ${n} panel${n === 1 ? "" : "s"} from left to right: ${desc}.`,
    );
  });
  lines.push(
    "Panels are evenly spaced and the same scale within a row; the character is centred in each panel and never cropped.",
    "Strict view directions: left and right mean screen left and screen right.",
    "Neutral flat lighting, identical in every panel. No text, labels, captions, numbers, arrows, logos or watermarks.",
  );
  if (render) lines.push(`Rendering technique: ${render}.`);
  lines.push("", "overall_soundscape:", "Silence.");
  return lines.join("\n").slice(0, 6000);
}

const ANNOTATED_REF_RE = /^[^\s].* \[(input|output|temp)\]$/;

function validRef(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ref = v.trim();
  return ref.length <= 300 &&
    ANNOTATED_REF_RE.test(ref) &&
    !ref.split(" [")[0].split("/").includes("..")
    ? ref
    : null;
}

/**
 * References 2..3 with their roles. Invalid or empty slots are dropped and
 * their roles with them, so roles stay aligned with the refs that remain.
 */
export function charSheetExtraRefs(
  params: Record<string, unknown>,
): { ref: string; role: string }[] {
  const raw = [
    params.secondRefImage,
    ...(Array.isArray(params.extraRefImages) ? params.extraRefImages : []),
  ];
  const roles = Array.isArray(params.refRoles) ? params.refRoles : [];
  return raw
    .map((r, i) => ({ ref: validRef(r), role: charSheetRefRole(roles[i]).id }))
    .filter((r): r is { ref: string; role: string } => Boolean(r.ref))
    .slice(0, CHAR_SHEET_MAX_REFS - 1);
}

function nodeIdOf(workflow: Workflow, classType: string): string | undefined {
  return Object.keys(workflow).find(
    (id) => workflow[id].class_type === classType,
  );
}

function nextId(workflow: Workflow): string {
  const n = Math.max(
    0,
    ...Object.keys(workflow).map(Number).filter(Number.isFinite),
  );
  return String(n + 1);
}

const linkId = (v: unknown): string | undefined =>
  Array.isArray(v) ? String(v[0]) : undefined;

export function buildCharSheetWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = CHAR_SHEET_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const firstRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!firstRef) throw new Error(`${A}: source run has no image`);

  const r2vId = nodeIdOf(workflow, R2V_CLASS);
  if (!r2vId) throw new Error(`${A}: workflow needs ${R2V_CLASS}`);
  const r2v = workflow[r2vId].inputs as Record<string, unknown>;
  const ref0Id = linkId(r2v["ref_images.ref_image_0"]);
  if (!ref0Id || workflow[ref0Id]?.class_type !== "LoadImage")
    throw new Error(`${A}: ref_image_0 must come from a LoadImage node`);

  const views = parseCharSheetViews(params.views ?? CHAR_SHEET_DEFAULT_VIEWS);
  if (!views.length) throw new Error(`${A}: choose at least one view`);
  const { width, height } = charSheetSize(params.size);
  const layout = charSheetLayout(views, width, height);
  const extras = charSheetExtraRefs(params);

  setNodeInput(workflow, ref0Id, "image", firstRef);
  extras.forEach(({ ref }, i) => {
    const id = nextId(workflow);
    workflow[id] = {
      class_type: "LoadImage",
      inputs: { image: ref },
      _meta: { title: `Reference ${i + 2}` },
    };
    r2v[`ref_images.ref_image_${i + 1}`] = [id, 0];
  });

  setNodeInput(
    workflow,
    r2vId,
    "prompt",
    charSheetPrompt({
      layout,
      description: params.prompt,
      name: params.name,
      render: params.render,
      refCount: 1 + extras.length,
      refRoles: extras.map((e) => e.role),
    }),
  );
  setNodeInput(workflow, r2vId, "width", width);
  setNodeInput(workflow, r2vId, "height", height);
  setNodeInput(workflow, r2vId, "length", CHAR_SHEET_FRAMES);

  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  const noiseId = nodeIdOf(workflow, "RandomNoise");
  if (noiseId) setNodeInput(workflow, noiseId, "noise_seed", seed);

  applyH3ExtraLoras(workflow, params);
  applyH3Speed(workflow, { ...params, h3Speed: params.h3Speed ?? "turbo8" });

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: r2vId,
      posTextInputName: "prompt",
      negTextId: "",
      latentDimsId: r2vId,
      imageInputId: ref0Id,
    },
    seed,
  };
}
