/**
 * "Material maps" (packs/qwen-edit-2509/material_maps.json): one image →
 * Marigold V2 depth, normal and albedo maps, each saved as its own image
 * (usable as PBR texture maps). Every map is one denoising step of
 * Qwen-Image-Edit-2509 with that map's LoRA, VAE and precomputed
 * conditioning, then core MarigoldV2PostProcess.
 *
 * Knobs (params): depth | normals | albedo on/off (default all on; at least
 * one required), detail standard (1 MP) | high (2 MP). Maps are scaled back
 * to the source size.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";

export const MATERIAL_MAPS_ACTION = "material_maps";

export const MATERIAL_MAP_KINDS = ["depth", "normals", "albedo"] as const;
export type MaterialMapKind = (typeof MATERIAL_MAP_KINDS)[number];

/** Shared node ids in material_maps.json. */
export const MATERIAL_ID = {
  loadImage: "1",
  scale: "2",
  unet: "3",
  sampler: "4",
  sigmas: "5",
  noise: "6",
  size: "7",
} as const;

/** First node id of each map's branch (branch = base .. base + 10). */
export const MATERIAL_BRANCH: Record<MaterialMapKind, number> = {
  depth: 10,
  normals: 30,
  albedo: 50,
};
export const MATERIAL_BRANCH_SIZE = 11;
/** Offsets inside a branch. */
export const MATERIAL_OFFSET = { postProcess: 8, save: 10 } as const;

/** Working resolution (megapixels) per detail choice. */
export const MATERIAL_DETAIL_MP: Record<string, number> = {
  standard: 1.0,
  high: 2.0,
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function on(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;
  const v = str(value);
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

/** Maps the params select, in graph order (all three when none are set). */
export function materialMapsSelected(
  params: Record<string, unknown> = {},
): MaterialMapKind[] {
  return MATERIAL_MAP_KINDS.filter((k) => on(params[k]));
}

export function materialDetailMp(value: unknown): number {
  return MATERIAL_DETAIL_MP[str(value)] ?? MATERIAL_DETAIL_MP.standard;
}

export function materialBranchIds(kind: MaterialMapKind): string[] {
  const base = MATERIAL_BRANCH[kind];
  return Array.from({ length: MATERIAL_BRANCH_SIZE }, (_, i) =>
    String(base + i),
  );
}

export function buildMaterialMapsWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const workflow = cloneWorkflow(baseWorkflow);
  const job = sourceRun.jobs[sourceJobIndex];
  const imageRef = comfyImageRefFromViewUrl(job?.images?.[0]);
  if (!imageRef)
    throw new Error(`${MATERIAL_MAPS_ACTION}: source run has no image`);
  const required = [
    ...Object.values(MATERIAL_ID),
    ...MATERIAL_MAP_KINDS.flatMap(materialBranchIds),
  ];
  for (const id of required) {
    if (!workflow[id])
      throw new Error(
        `${MATERIAL_MAPS_ACTION}: workflow is missing node ${id}`,
      );
  }

  const selected = materialMapsSelected(params);
  if (!selected.length)
    throw new Error(`${MATERIAL_MAPS_ACTION}: pick at least one map`);

  setNodeInput(workflow, MATERIAL_ID.loadImage, "image", imageRef);
  setNodeInput(
    workflow,
    MATERIAL_ID.scale,
    "megapixels",
    materialDetailMp(params.detail),
  );
  for (const kind of MATERIAL_MAP_KINDS) {
    if (selected.includes(kind)) continue;
    for (const id of materialBranchIds(kind)) delete workflow[id];
  }

  return {
    workflow,
    slots: {
      ksamplerId: "",
      posTextId: "",
      posTextInputName: "",
      negTextId: "",
      latentDimsId: "",
      imageInputId: MATERIAL_ID.loadImage,
    },
    seed: typeof job?.seed === "number" ? job.seed : 0,
  };
}
