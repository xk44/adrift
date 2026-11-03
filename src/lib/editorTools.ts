/**
 * Edit page "Tools" panel: run the image tools on the current canvas.
 *
 * Same catalog as the lightbox Tools panel (lib/ui/lightboxTools.ts), cut to
 * tools that take one image, sorted into Image / Video / 3D by what they make.
 *  - inline rows (Expand, Detail, Face Enhancer, Realism, 3D) queue their
 *    action straight from the editor on the canvas image;
 *  - every other row opens its Tools page card with the canvas preloaded
 *    (lib/tools/toolHandoff.ts) and, when the tool takes a mask, the editor's
 *    painted selection as that mask.
 * Runs started from the editor are tracked; image results come back as a new
 * layer + canvas version (undoable), video / 3D results open in their usual
 * view. Pure (no React, no DOM) so the rules are unit-tested.
 */

import type { GalleryImage, ImagineRun } from "@/types";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import {
  buildLightboxTools,
  filterLightboxTools,
  groupLightboxTools,
  type LightboxTool,
  type LightboxToolGroup,
} from "@/lib/ui/lightboxTools";
import { regionMaskTool } from "@/lib/tools/maskWiring";
import type { ToolHandoff } from "@/lib/tools/toolHandoff";

/** What a tool makes from the canvas image. */
export type EditorToolOutput = "image" | "video" | "3d";

export const EDITOR_TOOL_SECTIONS: readonly {
  output: EditorToolOutput;
  label: string;
}[] = [
  { output: "image", label: "Image" },
  { output: "video", label: "Video" },
  { output: "3d", label: "3D" },
];

/**
 * How a tool uses the editor's painted selection:
 *  - "region": per-subject paste-back (REGION_MASK_TOOLS); the edit is clamped
 *    to the mask and everything outside stays original;
 *  - "inpaint": catalog tool with a mask slot (the mask is the area to redo).
 */
export type EditorMaskUse = "region" | "inpaint";

export interface EditorTool extends LightboxTool {
  output: EditorToolOutput;
  /** null = the tool ignores the selection. */
  mask: EditorMaskUse | null;
}

/**
 * Rows that make no sense on a canvas: Remix / Reuse send the prompt back to
 * Create, Describe returns text.
 */
export const EDITOR_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "inline:remix",
  "inline:reuse",
  "action:describe",
]);

const THREE_D_KEYS = new Set([
  "inline:3d",
  "action:make_3d",
  "action:make_3d_trellis",
  "action:image_to_splat",
  "action:body_3d",
]);

/** Image-in tools whose result is a clip (Hub section or not). */
const VIDEO_KEYS = new Set([
  "action:lipsync",
  "action:talking_avatar",
  "app:sketch_to_video",
]);

export function editorToolOutput(tool: LightboxTool): EditorToolOutput {
  if (THREE_D_KEYS.has(tool.key)) return "3d";
  if (VIDEO_KEYS.has(tool.key) || tool.group === "Video") return "video";
  return "image";
}

/** Action id for "action:<id>" keys, else null. */
function actionId(key: string): string | null {
  return key.startsWith("action:") ? key.slice("action:".length) : null;
}

export function editorToolMask(
  key: string,
  catalog: CatalogTool[] | null,
): EditorMaskUse | null {
  const id = actionId(key);
  if (id && regionMaskTool(id)) return "region";
  if (key.startsWith("catalog:")) {
    const tool = catalog?.find((t) => `catalog:${t.id}` === key);
    if (tool?.needsMask) return "inpaint";
  }
  return null;
}

/** Every tool that can take the canvas image (catalog null until loaded). */
export function buildEditorTools(
  catalog: CatalogTool[] | null = null,
): EditorTool[] {
  return buildLightboxTools(catalog)
    .filter(
      (t) => t.media.includes("image") && !EDITOR_EXCLUDED_KEYS.has(t.key),
    )
    .map((t) => ({
      ...t,
      output: editorToolOutput(t),
      mask: editorToolMask(t.key, catalog),
    }));
}

/** Same AND-of-words search as the lightbox panel. */
export function filterEditorTools(
  tools: EditorTool[],
  query: string,
): EditorTool[] {
  // The canvas always has pixels a run can start from (uploads are seeded),
  // so inline rows stay visible for pasted / uploaded images too.
  return filterLightboxTools(tools, {
    media: "image",
    external: false,
    query,
  }) as EditorTool[];
}

export interface EditorToolSection {
  output: EditorToolOutput;
  label: string;
  groups: LightboxToolGroup[];
}

/** Sections this small show as one flat list (no sub-headings). */
const FLAT_SECTION_MAX = 4;

/**
 * Image / Video / 3D, each split into the lightbox groups in their order.
 * A small section is one flat group, and a hub group named like its
 * section ("Image" under Image) reads "More" so headings never repeat.
 */
export function groupEditorTools(tools: EditorTool[]): EditorToolSection[] {
  return EDITOR_TOOL_SECTIONS.map(({ output, label }) => {
    const inSection = tools.filter((t) => t.output === output);
    const groups: LightboxToolGroup[] =
      inSection.length === 0
        ? []
        : inSection.length <= FLAT_SECTION_MAX
          ? [{ group: label, tools: inSection }]
          : groupLightboxTools(inSection).map((g) =>
              g.group === label ? { ...g, group: "More" } : g,
            );
    return { output, label, groups };
  }).filter((s) => s.groups.length > 0);
}

// Canvas source

export interface EditorSourceRun {
  runId: string;
  jobIndex: number;
}

/**
 * The local run behind the canvas image: the one a tool result set, else
 * the gallery item the editor was opened from. Null for uploads / pastes.
 */
export function editorSourceRun(
  current: EditorSourceRun | null,
  sourceImageId: string | null,
  gallery: Pick<GalleryImage, "id" | "runId" | "jobIndex">[],
): EditorSourceRun | null {
  if (current) return current;
  if (!sourceImageId) return null;
  const item = gallery.find((g) => g.id === sourceImageId);
  if (!item?.runId) return null;
  return { runId: item.runId, jobIndex: item.jobIndex ?? 0 };
}

export interface EditorCanvasSource {
  url: string;
  id: string | null;
  width: number;
  height: number;
  run: EditorSourceRun | null;
}

/**
 * Hand-off that opens `tool` on the Tools page with the canvas as its first
 * input. The selection rides along only when the tool uses one.
 */
export function editorHandoff(
  tool: Pick<EditorTool, "key" | "mask">,
  canvas: EditorCanvasSource,
  maskDataUrl: string | null,
  now: number,
): ToolHandoff {
  return {
    toolKey: tool.key,
    media: "image",
    itemId: canvas.id ?? `editor:${now}`,
    url: canvas.url,
    label: "Editor canvas",
    width: canvas.width,
    height: canvas.height,
    ...(canvas.run
      ? { runId: canvas.run.runId, jobIndex: canvas.run.jobIndex }
      : {}),
    origin: "editor",
    ...(tool.mask && maskDataUrl ? { mask: maskDataUrl } : {}),
    at: now,
  };
}

// Result routing

/** A run started from the editor that has not come back yet. */
export interface EditorToolRun {
  runId: string;
  title: string;
  /** "inline" = queued from the editor panel; "tool" = from a Tools page card. */
  origin: "inline" | "tool";
  at: number;
}

export type EditorToolRoute =
  | { kind: "wait" }
  | { kind: "failed"; message: string }
  /** Image outputs: each becomes a layer, the first one the canvas. */
  | { kind: "apply"; images: string[]; runId: string; jobIndex: number }
  /** Inline video / 3D: open the result in the lightbox. */
  | { kind: "open"; output: "video" | "3d" | "audio"; runId: string }
  /** Tools page run with a non-image result: the tool page shows it. */
  | { kind: "notify"; output: "video" | "3d" | "audio" };

/**
 * What to do with a tracked run now. A run missing from the store keeps
 * waiting (it may not have been added yet).
 */
export function routeEditorToolRun(
  tracked: EditorToolRun,
  run: ImagineRun | undefined,
): EditorToolRoute {
  if (!run) return { kind: "wait" };
  const jobs = run.jobs ?? [];
  if (jobs.length === 0) return { kind: "wait" };
  if (jobs.some((j) => j.status === "queued" || j.status === "running"))
    return { kind: "wait" };
  const done = jobs.filter((j) => j.status === "done");
  if (done.length === 0) {
    const failed = jobs.find((j) => j.status === "error");
    return {
      kind: "failed",
      message: failed?.error
        ? `${tracked.title} failed: ${failed.error}`
        : `${tracked.title} did not finish.`,
    };
  }
  const job = done[0];
  const other: "video" | "3d" | "audio" | null = job.meshes?.length
    ? "3d"
    : job.videos?.length
      ? "video"
      : job.audios?.length
        ? "audio"
        : null;
  if (other) {
    return tracked.origin === "inline"
      ? { kind: "open", output: other, runId: run.run_id }
      : { kind: "notify", output: other };
  }
  const images = done.flatMap((j) => j.images ?? []).filter(Boolean);
  if (images.length === 0)
    return { kind: "failed", message: `${tracked.title} returned no image.` };
  return { kind: "apply", images, runId: run.run_id, jobIndex: job.index };
}
