/**
 * Merge imported user tools into the app's tool lists (pure, client-safe):
 *  - Tools page "My tools" section (search + category filter);
 *  - lightbox / editor Tools panels (tools with an image input);
 *  - Workflows page assignment options ("user:<id>").
 */

import type { HubCategory } from "@/lib/tools/hub";
import type { LightboxMediaKind, LightboxTool } from "@/lib/ui/lightboxTools";
import type { EditorTool, EditorToolOutput } from "@/lib/editorTools";
import {
  userToolKey,
  type UserToolSummary,
} from "./types";

export const MY_TOOLS_GROUP = "My tools";

export function userToolSubtitle(t: UserToolSummary): string {
  if (t.description) return t.description;
  const takes = new Set(
    t.params.filter((p) => p.exposed).map((p) => p.kind),
  );
  const ins: string[] = [];
  if (takes.has("image")) ins.push("an image");
  if (takes.has("video")) ins.push("a clip");
  if (takes.has("audio")) ins.push("audio");
  const out =
    t.output === "video"
      ? "a clip"
      : t.output === "audio"
        ? "audio"
        : t.output === "mesh"
          ? "a 3D model"
          : "an image";
  return ins.length
    ? `Turns ${ins.join(" + ")} into ${out}`
    : `Makes ${out} from a prompt`;
}

/** Search (AND of words over name/description/category) + category filter. */
export function filterUserTools(
  tools: UserToolSummary[],
  query: string,
  only: HubCategory | null,
): UserToolSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools.filter((t) => {
    if (only && t.category !== only) return false;
    if (!words.length) return true;
    const hay = [t.name, t.description ?? "", t.category, t.workflowType, "my tools imported"]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function mediaOf(t: UserToolSummary): LightboxMediaKind[] {
  const kinds = new Set(t.params.filter((p) => p.exposed).map((p) => p.kind));
  const out: LightboxMediaKind[] = [];
  if (kinds.has("image")) out.push("image");
  if (kinds.has("video")) out.push("video");
  return out;
}

/** Lightbox Tools panel rows: tools that take an image or a clip. */
export function userToolLightboxEntries(
  tools: UserToolSummary[] | null,
): LightboxTool[] {
  const out: LightboxTool[] = [];
  for (const t of tools ?? []) {
    const media = mediaOf(t);
    if (media.length === 0) continue;
    const key = userToolKey(t.id);
    out.push({
      key,
      title: t.name,
      subtitle: userToolSubtitle(t),
      group: MY_TOOLS_GROUP,
      icon: t.icon,
      media,
      localOnly: false,
      aliases: ["my tools", "imported", t.workflowType],
      target: { kind: "open", toolKey: key },
    });
  }
  return out;
}

function editorOutput(t: UserToolSummary): EditorToolOutput | null {
  if (t.output === "video") return "video";
  if (t.output === "mesh") return "3d";
  if (t.output === "image") return "image";
  return null;
}

/** Editor Tools panel rows: image-in tools; a mask input takes the selection. */
export function userToolEditorEntries(
  tools: UserToolSummary[] | null,
): EditorTool[] {
  const out: EditorTool[] = [];
  for (const entry of userToolLightboxEntries(tools)) {
    if (!entry.media.includes("image")) continue;
    const t = tools!.find((x) => userToolKey(x.id) === entry.key)!;
    const output = editorOutput(t);
    if (!output) continue;
    const hasMask = t.params.some((p) => p.exposed && p.kind === "mask");
    out.push({
      ...entry,
      media: ["image"],
      output,
      mask: hasMask ? "inpaint" : null,
    });
  }
  return out;
}

export interface UserToolWorkflowOption {
  value: string;
  label: string;
}

/** Workflows page assignment options ("user:<id>"). */
export function userToolWorkflowOptions(
  tools: UserToolSummary[] | null,
): UserToolWorkflowOption[] {
  return (tools ?? [])
    .map((t) => ({ value: userToolKey(t.id), label: t.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** True for a Civitai model listing that is a ComfyUI workflow. */
export function isCivitaiWorkflowModel(model: { type?: string }): boolean {
  return (model.type ?? "").toLowerCase() === "workflows";
}

/** Civitai page link the import route accepts, pinned to one version. */
export function civitaiWorkflowImportUrl(
  source: "com" | "red",
  modelId: number,
  versionId?: number,
): string {
  const base = `https://civitai.${source}/models/${modelId}`;
  return versionId ? `${base}?modelVersionId=${versionId}` : base;
}
