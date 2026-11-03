/**
 * "Depth & normals" (packs/image-tools/moge_geometry.json): one image →
 * MoGe-2 geometry (core ComfyUI MoGe nodes) → depth map, normal map,
 * point-map mesh (.glb, textured with the source) and the estimated camera
 * FOV as a text output.
 *
 * Knobs (params): source photo | panorama (equirectangular: 12 perspective
 * splits merged into one distance map; no intrinsics, so no FOV), detail
 * max | balanced | fast (resolution_level), mesh light (default) | full |
 * preview | off,
 * normals opengl | directx, depth gray | colored, model moge2 | moge3.
 *
 * MoGe-3 ViT-G (node 14) is ~3.8x the size of MoGe-2 ViT-L, so it stays
 * opt-in: the pack marks it optional (its weights do not gate the tool);
 * picking it rewires node 3 to it, drops that flag so a missing file fails
 * loudly, and enables the MoGe-3 refiner (refine_steps, ignored by v2).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const MOGE_GEOMETRY_ACTION = "moge_geometry";

/** Node ids in moge_geometry.json. */
export const MOGE_ID = {
  loadImage: "1",
  model: "2",
  infer: "3",
  depth: "4",
  saveDepth: "5",
  normal: "6",
  saveNormal: "7",
  mesh: "8",
  saveMesh: "9",
  fovH: "10",
  fovV: "11",
  fovText: "12",
  fovOut: "13",
  modelV3: "14",
} as const;

const FOV_NODES = [MOGE_ID.fovH, MOGE_ID.fovV, MOGE_ID.fovText, MOGE_ID.fovOut];
const MESH_NODES = [MOGE_ID.mesh, MOGE_ID.saveMesh];

export type MogeSource = "photo" | "panorama";
export type MogeMesh = "full" | "light" | "preview" | "off";
export type MogeModel = "moge2" | "moge3";

/** MoGe-3 refiner steps (node default); MoGe-2 has no refiner. */
export const MOGE3_REFINE_STEPS = 3;

/** resolution_level per detail choice (0 = fastest, 9 = most detail). */
export const MOGE_DETAIL_LEVELS: Record<string, number> = {
  max: 9,
  balanced: 6,
  fast: 3,
};

/** Point-map vertex stride per mesh choice. */
/**
 * Vertex stride per mesh choice. A ~1 MP image at stride 1 is ~830k
 * vertices (~38 MB GLB, slow in the browser viewer), so "light" (stride 2,
 * about a quarter of that) is the default and "full" is opt-in.
 */
export const MOGE_MESH_DECIMATION: Record<Exclude<MogeMesh, "off">, number> = {
  full: 1,
  light: 2,
  preview: 4,
};

/** MoGePanoramaInference split / merge sizes (node defaults). */
export const MOGE_PANORAMA = { split: 512, merge: 1920, batch: 4 } as const;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function mogeSource(value: unknown): MogeSource {
  return str(value) === "panorama" ? "panorama" : "photo";
}

export function mogeMesh(value: unknown): MogeMesh {
  const v = str(value);
  return v === "full" || v === "preview" || v === "off" ? v : "light";
}

export function mogeModel(value: unknown): MogeModel {
  return str(value) === "moge3" ? "moge3" : "moge2";
}

export function mogeDetail(value: unknown): number {
  return MOGE_DETAIL_LEVELS[str(value)] ?? MOGE_DETAIL_LEVELS.max;
}

export function buildMogeGeometryWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef)
    throw new Error(`${MOGE_GEOMETRY_ACTION}: source run has no image`);
  for (const id of Object.values(MOGE_ID)) {
    if (!workflow[id])
      throw new Error(
        `${MOGE_GEOMETRY_ACTION}: workflow is missing node ${id}`,
      );
  }

  setNodeInput(workflow, MOGE_ID.loadImage, "image", imageRef);
  const level = mogeDetail(params.detail);
  const v3 = mogeModel(params.model) === "moge3";
  const modelId = v3 ? MOGE_ID.modelV3 : MOGE_ID.model;
  const refineSteps = v3 ? MOGE3_REFINE_STEPS : 0;

  if (mogeSource(params.source) === "panorama") {
    workflow[MOGE_ID.infer] = {
      ...workflow[MOGE_ID.infer],
      class_type: "MoGePanoramaInference",
      inputs: {
        moge_model: [modelId, 0],
        image: [MOGE_ID.loadImage, 0],
        resolution_level: level,
        split_resolution: MOGE_PANORAMA.split,
        merge_resolution: MOGE_PANORAMA.merge,
        batch_size: MOGE_PANORAMA.batch,
        refine_steps: refineSteps,
      },
    };
    for (const id of FOV_NODES) delete workflow[id];
  } else {
    setNodeInput(workflow, MOGE_ID.infer, "resolution_level", level);
    setNodeInput(workflow, MOGE_ID.infer, "moge_model", [modelId, 0]);
    setNodeInput(workflow, MOGE_ID.infer, "refine_steps", refineSteps);
  }

  if (v3) {
    delete workflow[MOGE_ID.model];
    delete workflow[MOGE_ID.modelV3]._meta?.optional;
  } else {
    delete workflow[MOGE_ID.modelV3];
  }

  setNodeInput(
    workflow,
    MOGE_ID.depth,
    "output",
    str(params.depth) === "colored" ? "depth_colored" : "depth",
  );
  setNodeInput(
    workflow,
    MOGE_ID.normal,
    "output",
    str(params.normals) === "directx" ? "normal_directx" : "normal_opengl",
  );

  const mesh = mogeMesh(params.mesh);
  if (mesh === "off") {
    for (const id of MESH_NODES) delete workflow[id];
  } else {
    setNodeInput(
      workflow,
      MOGE_ID.mesh,
      "decimation",
      MOGE_MESH_DECIMATION[mesh],
    );
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: MOGE_ID.loadImage,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}
