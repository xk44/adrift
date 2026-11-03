/**
 * Browser calls for user tools (imported workflows): list / import / save /
 * edit / delete / run. Media inputs upload through /api/comfy/upload like the
 * other runners; gallery images go by run + job (no pixel round trip).
 */

import type { ImagineRun } from "@/types";
import { nodeWarningsOf } from "@/lib/comfy/nodeWarnings";
import {
  audioUploadName,
  uploadDataUrl,
  uploadName,
  videoUploadName,
  type FetchLike,
  type ToolAudio,
  type ToolImage,
  type ToolVideo,
} from "@/lib/tools/runTool";
import type { UserToolAnalysis, UserToolParam, UserToolSummary } from "./types";
import type { ModelOverride } from "./modelOverrides";

export class UserToolClientError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "UserToolClientError";
  }
}

async function readJson(
  res: Pick<Response, "ok" | "status" | "json">,
): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || data.ok === false) {
    const msg =
      typeof data.error === "string" && data.error
        ? data.error
        : res.status === 401
          ? "Sign in as admin to manage tools."
          : `Request failed (${res.status})`;
    throw new UserToolClientError(msg, res.status);
  }
  return data;
}

function send(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  body?: unknown,
) {
  return fetchImpl(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function listUserToolsApi(
  fetchImpl: FetchLike,
): Promise<UserToolSummary[]> {
  const data = await readJson(await fetchImpl("/api/user-tools"));
  return Array.isArray(data.tools) ? (data.tools as UserToolSummary[]) : [];
}

export type ImportRequest =
  { url: string } | { file: { name: string; data: string } };

export async function analyzeImportApi(
  fetchImpl: FetchLike,
  req: ImportRequest,
): Promise<UserToolAnalysis> {
  const data = await readJson(
    await send(fetchImpl, "/api/user-tools/import", "POST", req),
  );
  return data.analysis as UserToolAnalysis;
}

export interface SaveUserToolBody {
  name: string;
  icon: string;
  category: string;
  description?: string;
  analysis: UserToolAnalysis;
  params: UserToolParam[];
  /** Missing model -> installed stand-in picks (validated server side). */
  modelOverrides?: ModelOverride[];
}

export async function saveUserToolApi(
  fetchImpl: FetchLike,
  b: SaveUserToolBody,
): Promise<UserToolSummary> {
  const data = await readJson(
    await send(fetchImpl, "/api/user-tools", "POST", {
      name: b.name,
      icon: b.icon,
      category: b.category,
      description: b.description,
      workflowType: b.analysis.workflowType,
      output: b.analysis.output,
      workflow: b.analysis.workflow,
      params: b.params,
      source: b.analysis.source,
      ...(b.modelOverrides?.length
        ? { modelOverrides: b.modelOverrides }
        : {}),
    }),
  );
  return data.tool as UserToolSummary;
}

export async function updateUserToolApi(
  fetchImpl: FetchLike,
  id: string,
  patch: Partial<
    Pick<
      UserToolSummary,
      "name" | "icon" | "category" | "description" | "params"
    >
  >,
): Promise<UserToolSummary> {
  const data = await readJson(
    await send(
      fetchImpl,
      `/api/user-tools/${encodeURIComponent(id)}`,
      "PATCH",
      patch,
    ),
  );
  return data.tool as UserToolSummary;
}

export async function deleteUserToolApi(
  fetchImpl: FetchLike,
  id: string,
): Promise<void> {
  await readJson(
    await send(
      fetchImpl,
      `/api/user-tools/${encodeURIComponent(id)}`,
      "DELETE",
    ),
  );
}

/**
 * Download a saved tool as an Adrift tool pack (.zip). Returns the zip and
 * the server's file name; errors come back as UserToolClientError.
 */
export async function exportUserToolApi(
  fetchImpl: (
    input: string,
    init?: RequestInit,
  ) => Promise<
    Pick<Response, "ok" | "status" | "json" | "headers" | "blob">
  >,
  id: string,
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetchImpl(
    `/api/user-tools/${encodeURIComponent(id)}/export`,
    { method: "GET" },
  );
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("zip")) {
    await readJson(res);
    throw new UserToolClientError(`Export failed (${res.status})`, res.status);
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(cd);
  return { blob: await res.blob(), filename: m?.[1] ?? "adrift-tool.zip" };
}

/** A media value picked in the runner, by param kind. */
export type UserToolMedia =
  | { kind: "image"; image: ToolImage }
  | { kind: "video"; video: ToolVideo }
  | { kind: "audio"; audio: ToolAudio };

type MediaRef = string | { run_id: string; job_index: number };

async function mediaRef(
  fetchImpl: FetchLike,
  m: UserToolMedia,
): Promise<MediaRef> {
  if (m.kind === "image") {
    const img = m.image;
    if (img.source === "gallery" && img.runId) {
      return { run_id: img.runId, job_index: img.jobIndex ?? 0 };
    }
    if (img.comfyRef) return img.comfyRef;
    if (!img.dataUrl) throw new UserToolClientError("The image is not ready");
    return uploadDataUrl(fetchImpl, img.dataUrl, uploadName("cj_tool"));
  }
  if (m.kind === "video") {
    return uploadDataUrl(
      fetchImpl,
      m.video.dataUrl,
      videoUploadName(m.video.label),
    );
  }
  return uploadDataUrl(
    fetchImpl,
    m.audio.dataUrl,
    audioUploadName(m.audio.label),
  );
}

export async function runUserToolApi(args: {
  fetchImpl: FetchLike;
  id: string;
  values: Record<string, string | number>;
  media: Record<string, UserToolMedia>;
  clientId?: string;
  onWarnings?: (warnings: string[]) => void;
}): Promise<ImagineRun> {
  const media: Record<string, MediaRef> = {};
  for (const [key, m] of Object.entries(args.media)) {
    media[key] = await mediaRef(args.fetchImpl, m);
  }
  const data = await readJson(
    await send(
      args.fetchImpl,
      `/api/user-tools/${encodeURIComponent(args.id)}/run`,
      "POST",
      { values: args.values, media, client_id: args.clientId },
    ),
  );
  const warnings = nodeWarningsOf(data);
  if (warnings.length) args.onWarnings?.(warnings);
  if (!data.run)
    throw new UserToolClientError("The server did not queue a run");
  return data.run as ImagineRun;
}

/** Read a picked File as base64 for the import route (data: URL works too). */
export function fileToImportRequest(
  name: string,
  dataUrl: string,
): ImportRequest {
  return { file: { name, data: dataUrl } };
}
