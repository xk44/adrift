/**
 * "Make 3D (TRELLIS.2)" (packs/trellis2/make_3d_trellis.json): image → GLB
 * with core ComfyUI nodes only. Converted from the official
 * 3d_pixal3d_trellis2_image_to_model template: BiRefNet background removal →
 * crop to the subject → DINOv3 conditioning (Pixal3D adds a MoGe-2 camera FOV
 * estimate) → TRELLIS.2 structure / shape / upsample / texture stages →
 * remesh, decimate, UV unwrap, PBR bake → SaveGLB, plus a RenderMesh preview
 * PNG so the job also has an image for the feed / lightbox.
 *
 * Knobs (params): engine pixal3d | trellis2, quality high | fast,
 * texture on | off, seed. The graph carries every branch; the builder keeps
 * one engine and drops the texture stage when texture is off.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const MAKE_3D_TRELLIS_ACTION = "make_3d_trellis";

export type Trellis3dEngine = "pixal3d" | "trellis2";
export type Trellis3dQuality = "high" | "fast";

/** Node ids in make_3d_trellis.json (template ids kept for traceability). */
const ID = {
  loadImage: "122",
  pixalCond: "298",
  trellisCond: "299",
  pixalUnet: "319",
  trellisUnet: "40",
  structureSampler: "3",
  shapeSampler: "18",
  upsample: "94",
  upsampleSampler: "23",
  textureSampler: "12",
  remesh: "241",
  decimate: "186",
  smoothed: "238",
  unwrap: "196",
  bakeColor: "147",
  bakeNormal: "224",
  bakeAo: "233",
  textured: "260",
  saveGlb: "400",
  render: "401",
} as const;

/** Pixal3D-only helpers (MoGe camera FOV). */
const PIXAL_ONLY = ["55", "56", "242", ID.pixalCond, ID.pixalUnet];
const TRELLIS_ONLY = [ID.trellisCond, ID.trellisUnet];
/** Texture stage + PBR bake; dropped when texture is off. */
const TEXTURE_NODES = [
  "98",
  ID.textureSampler,
  "93",
  "118",
  ID.unwrap,
  ID.bakeColor,
  ID.bakeNormal,
  ID.bakeAo,
  "210",
  ID.textured,
];

/** Per-quality settings; `high` = the official template values. */
export const TRELLIS_QUALITY: Record<
  Trellis3dQuality,
  {
    structureSteps: number;
    shapeSteps: number;
    upsampleResolution: number;
    upsampleSteps: number;
    textureSteps: number;
    remeshResolution: number;
    faces: number;
    textureSize: number;
    normalSize: number;
    aoSize: number;
    aoSamples: number;
  }
> = {
  high: {
    structureSteps: 12,
    shapeSteps: 20,
    upsampleResolution: 1536,
    upsampleSteps: 12,
    textureSteps: 12,
    remeshResolution: 768,
    faces: 700_000,
    textureSize: 4096,
    normalSize: 2048,
    aoSize: 1024,
    aoSamples: 64,
  },
  fast: {
    structureSteps: 8,
    shapeSteps: 12,
    upsampleResolution: 1024,
    upsampleSteps: 8,
    textureSteps: 8,
    remeshResolution: 512,
    faces: 200_000,
    textureSize: 2048,
    normalSize: 1024,
    aoSize: 512,
    aoSamples: 32,
  },
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function trellisEngine(value: unknown): Trellis3dEngine {
  return str(value) === "trellis2" ? "trellis2" : "pixal3d";
}

export function trellisQuality(value: unknown): Trellis3dQuality {
  return str(value) === "fast" ? "fast" : "high";
}

export function trellisTexture(value: unknown): boolean {
  if (value === false) return false;
  return !["off", "false", "none", "0", "no"].includes(str(value));
}

function numberOr(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : undefined;
}

/** Point every link that reads `from` at `to` (same output slot). */
function relink(workflow: Workflow, from: string, to: string): void {
  for (const node of Object.values(workflow)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value[0] === from) {
        node.inputs[key] = [to, value[1]];
      }
    }
  }
}

export function buildMake3dTrellisWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) {
    throw new Error(`${MAKE_3D_TRELLIS_ACTION}: source run has no image`);
  }
  for (const id of [ID.loadImage, ID.saveGlb, ID.structureSampler]) {
    if (!workflow[id]) {
      throw new Error(
        `${MAKE_3D_TRELLIS_ACTION}: workflow is missing node ${id}`,
      );
    }
  }
  setNodeInput(workflow, ID.loadImage, "image", imageRef);

  const engine = trellisEngine(params.engine);
  if (engine === "trellis2") {
    relink(workflow, ID.pixalCond, ID.trellisCond);
    relink(workflow, ID.pixalUnet, ID.trellisUnet);
    for (const id of PIXAL_ONLY) delete workflow[id];
  } else {
    for (const id of TRELLIS_ONLY) delete workflow[id];
  }

  const textured = trellisTexture(params.texture);
  if (!textured) {
    // Geometry only: the cleaned, decimated mesh goes straight to the savers.
    relink(workflow, ID.textured, ID.smoothed);
    for (const id of TEXTURE_NODES) delete workflow[id];
  }

  const q = TRELLIS_QUALITY[trellisQuality(params.quality)];
  const set = (id: string, input: string, value: unknown) => {
    if (workflow[id]) setNodeInput(workflow, id, input, value);
  };
  set(ID.structureSampler, "steps", q.structureSteps);
  set(ID.shapeSampler, "steps", q.shapeSteps);
  set(ID.upsample, "target_resolution", q.upsampleResolution);
  set(ID.upsampleSampler, "steps", q.upsampleSteps);
  set(ID.textureSampler, "steps", q.textureSteps);
  set(ID.remesh, "resolution", q.remeshResolution);
  set(ID.decimate, "target_face_count", q.faces);
  set(ID.unwrap, "resolution", q.textureSize);
  set(ID.bakeColor, "texture_size", q.textureSize);
  set(ID.bakeNormal, "resolution", q.normalSize);
  set(ID.bakeAo, "resolution", q.aoSize);
  set(ID.bakeAo, "samples", q.aoSamples);
  set(ID.render, "mode", textured ? "auto" : "solid");

  const seed = numberOr(params.seed) ?? Math.floor(Math.random() * 2147483647);
  for (const id of [
    ID.structureSampler,
    ID.shapeSampler,
    ID.upsampleSampler,
    ID.textureSampler,
  ]) {
    set(id, "seed", seed);
  }

  return {
    workflow,
    slots: {
      ksamplerId: ID.structureSampler,
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: ID.loadImage,
    },
    seed,
  };
}
