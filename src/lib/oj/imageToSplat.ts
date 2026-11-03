/**
 * "Image to 3D" (packs/triposplat/image_to_splat.json): one photo → a
 * Gaussian splat with core ComfyUI nodes only (VAST-AI TripoSplat).
 * BiRefNet cuts the subject out, TripoSplatPreprocessImage centres it,
 * TripoSplatConditioning encodes it (DINOv3 ViT-H + FLUX.2 VAE), KSampler
 * samples the splat latent and VAEDecodeTripoSplat decodes the Gaussians.
 * SaveGLB writes the splat file (.ply, or the smaller .spz); RenderSplat
 * orbits it into a turntable mp4 so the job has something to play.
 *
 * Knobs (params): format ply | spz, mesh on | off (SplatToMesh → .glb),
 * seed. The graph carries the mesh branch; the builder drops it when off.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const IMAGE_TO_SPLAT_ACTION = "image_to_splat";

export type SplatFileFormat = "ply" | "spz";

/** Node ids in image_to_splat.json. */
export const SPLAT_ID = {
  loadImage: "1",
  sampler: "9",
  decode: "11",
  toFile: "12",
  saveSplat: "13",
  render: "15",
  saveVideo: "17",
  toMesh: "18",
  saveMesh: "19",
} as const;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function splatFormat(value: unknown): SplatFileFormat {
  return str(value) === "spz" ? "spz" : "ply";
}

/** Mesh export is opt-in: only an explicit on/true keeps SplatToMesh. */
export function splatMesh(value: unknown): boolean {
  if (value === true) return true;
  return ["on", "true", "1", "yes", "glb", "mesh", "detailed"].includes(str(value));
}

/** "detailed": grid 576 against 384. 18-25% lower p95 error, 2.2-2.5x the faces. */
export const SPLAT_MESH_DETAILED_RESOLUTION = 576;

function numberOr(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : undefined;
}

export function buildImageToSplatWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef) {
    throw new Error(`${IMAGE_TO_SPLAT_ACTION}: source run has no image`);
  }
  for (const id of [
    SPLAT_ID.loadImage,
    SPLAT_ID.sampler,
    SPLAT_ID.decode,
    SPLAT_ID.toFile,
    SPLAT_ID.saveSplat,
  ]) {
    if (!workflow[id]) {
      throw new Error(`${IMAGE_TO_SPLAT_ACTION}: workflow is missing node ${id}`);
    }
  }
  setNodeInput(workflow, SPLAT_ID.loadImage, "image", imageRef);
  setNodeInput(workflow, SPLAT_ID.toFile, "format", splatFormat(params.format));

  if (!splatMesh(params.mesh)) {
    delete workflow[SPLAT_ID.toMesh];
    delete workflow[SPLAT_ID.saveMesh];
  } else if (str(params.mesh) === "detailed") {
    setNodeInput(workflow, SPLAT_ID.toMesh, "resolution", SPLAT_MESH_DETAILED_RESOLUTION);
  }

  const seed = numberOr(params.seed) ?? Math.floor(Math.random() * 2147483647);
  setNodeInput(workflow, SPLAT_ID.sampler, "seed", seed);
  setNodeInput(workflow, SPLAT_ID.decode, "seed", seed);

  return {
    workflow,
    slots: {
      ksamplerId: SPLAT_ID.sampler,
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: SPLAT_ID.loadImage,
    },
    seed,
  };
}
