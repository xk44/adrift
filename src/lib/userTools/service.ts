/**
 * Server glue for the user-tools API routes: turn an import request
 * ({ url } or { file }) into an analysis, and turn run media values into
 * ComfyUI refs. Dependencies are injectable so routes stay thin and testable.
 */

import type { ObjectInfoIndex } from "@/lib/oj/inputSpec";
import {
  fetchCustomNodeMappings,
  resolveMissingNodePacks,
} from "@/lib/comfy/manager";

type CustomNodeMappings = Awaited<ReturnType<typeof fetchCustomNodeMappings>>;
import { analyzeWorkflow, findMissingNodes } from "./analyze";
import { extractWorkflow } from "./extract";
import { applyToolPack, readToolPackManifest } from "./pack";
import {
  CivitaiImportError,
  downloadCapped,
  parseCivitaiWorkflowUrl,
  resolveCivitaiWorkflow,
  type ResolvedCivitaiWorkflow,
  type CivitaiWorkflowRef,
} from "./civitaiImport";
import type { UserToolAnalysis, UserToolSource } from "./types";
import type { BackendProfile } from "@/lib/models/compat";

/** Uploaded file cap (decoded bytes). */
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

export class UserToolRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UserToolRequestError";
  }
}

export interface ImportDeps {
  objectInfo: () => Promise<Record<string, unknown> | null>;
  mappings: () => Promise<CustomNodeMappings>;
  apiKey: () => Promise<string>;
  resolveCivitai?: (
    ref: CivitaiWorkflowRef,
  ) => Promise<ResolvedCivitaiWorkflow>;
  download?: typeof downloadCapped;
  /** Backend GPU profile for ranking model stand-ins (optional). */
  profile?: () => Promise<BackendProfile | null>;
}

const SAFE_NAME = /^[^\0/\\]{1,200}$/;

function decodeFile(file: unknown): { name: string; bytes: Buffer } {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new UserToolRequestError("file must be { name, data }");
  }
  const f = file as Record<string, unknown>;
  const name =
    typeof f.name === "string" && SAFE_NAME.test(f.name.trim())
      ? f.name.trim()
      : "workflow";
  if (typeof f.data !== "string" || !f.data) {
    throw new UserToolRequestError("file.data must be base64 text");
  }
  const b64 = f.data.startsWith("data:")
    ? f.data.slice(f.data.indexOf(",") + 1)
    : f.data;
  if (b64.length > Math.ceil((MAX_IMPORT_FILE_BYTES * 4) / 3) + 8) {
    throw new UserToolRequestError("That file is too large (max 25 MB)", 413);
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) throw new UserToolRequestError("The file is empty");
  return { name, bytes };
}

/** Pack candidates for unknown node classes, keyed by class type. */
async function packsFor(
  missing: string[],
  deps: ImportDeps,
): Promise<Record<string, { id: string; label: string }[]> | null> {
  if (missing.length === 0) return null;
  try {
    const reports = resolveMissingNodePacks(missing, await deps.mappings());
    const out: Record<string, { id: string; label: string }[]> = {};
    for (const r of reports) {
      out[r.nodeType] = r.candidates
        .slice(0, 3)
        .map((c) => ({ id: c.id, label: c.label }));
    }
    return out;
  } catch {
    // Manager not installed / offline: still report the missing classes.
    return null;
  }
}

/**
 * Analyze (do not save) a workflow from a Civitai URL or an uploaded file.
 * Throws UserToolRequestError / CivitaiImportError / WorkflowExtractError.
 */
export async function analyzeImport(
  body: Record<string, unknown>,
  deps: ImportDeps,
): Promise<UserToolAnalysis> {
  let bytes: Uint8Array;
  let filename: string;
  let source: UserToolSource;
  let title: string | undefined;

  if (typeof body.url === "string" && body.url.trim()) {
    const ref = parseCivitaiWorkflowUrl(body.url.trim());
    if (!ref) {
      throw new UserToolRequestError(
        "Paste a civitai.com model link, like https://civitai.com/models/123",
      );
    }
    const resolved = await (deps.resolveCivitai ?? resolveCivitaiWorkflow)(ref);
    const key = await deps.apiKey().catch(() => "");
    bytes = await (deps.download ?? downloadCapped)(resolved.file.downloadUrl, {
      apiKey: key || null,
    });
    filename = resolved.file.name;
    title = resolved.title;
    source = {
      type: "civitai",
      url: resolved.pageUrl,
      modelId: resolved.modelId,
      versionId: resolved.versionId,
      file: resolved.file.name,
    };
  } else if (body.file !== undefined) {
    const f = decodeFile(body.file);
    bytes = f.bytes;
    filename = f.name;
    source = { type: "file", file: f.name };
  } else {
    throw new UserToolRequestError("Send a Civitai link or a workflow file");
  }

  const extracted = extractWorkflow(bytes, filename);
  const oi = (await deps
    .objectInfo()
    .catch(() => null)) as ObjectInfoIndex | null;
  const missing = oi
    ? findMissingNodes(extracted.workflow, oi).map((m) => m.classType)
    : [];
  const profile =
    oi && deps.profile ? await deps.profile().catch(() => null) : null;
  const analysis = analyzeWorkflow(extracted, {
    objectInfo: oi,
    profile,
    mappings: await packsFor(missing, deps),
    source,
    title,
  });
  // An Adrift tool pack (Export on a tool) restores its own name, icon and
  // exposed settings instead of the guesses.
  const manifest = readToolPackManifest(bytes);
  return manifest ? applyToolPack(analysis, manifest) : analysis;
}

export { CivitaiImportError };

/** Media value from the client: an uploaded ref string or a run image. */
export type MediaValue = string | { run_id: string; job_index: number };

const REF_RE = /^[^\0\n\r]{1,400}$/;

/**
 * Validate run media into ComfyUI ref strings. `lookupRun` returns the
 * annotated ref of a finished run's image (or null when not ready).
 */
export function resolveMedia(
  media: unknown,
  lookupRun: (runId: string, jobIndex: number) => string | null,
): Record<string, string> {
  if (media === undefined || media === null) return {};
  if (typeof media !== "object" || Array.isArray(media)) {
    throw new UserToolRequestError("media must be an object");
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(media as Record<string, unknown>)) {
    if (typeof v === "string") {
      if (!REF_RE.test(v) || v.split(/[\\/]/).some((s) => s === "..")) {
        throw new UserToolRequestError(`media "${key}" is not a valid file`);
      }
      out[key] = v;
      continue;
    }
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { run_id?: unknown }).run_id === "string" &&
      Number.isInteger((v as { job_index?: unknown }).job_index) &&
      (v as { job_index: number }).job_index >= 0
    ) {
      const { run_id, job_index } = v as { run_id: string; job_index: number };
      const ref = lookupRun(run_id, job_index);
      if (!ref) {
        throw new UserToolRequestError(
          "That image is not ready yet. Wait for it to finish, then try again.",
          409,
        );
      }
      out[key] = ref;
      continue;
    }
    throw new UserToolRequestError(`media "${key}" is not a valid file`);
  }
  return out;
}
