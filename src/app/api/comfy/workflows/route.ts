import * as path from "path";
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError, apiLog, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  getSavedWorkflowsDir,
  listSavedWorkflows,
  loadWorkflowFromSelection,
  readSavedWorkflowFile,
} from "@/lib/comfy/workflows";
import { validateOptionalString } from "@/lib/validate";
import {
  classifyWorkflowRuntimeCompatibility,
  createRuntimeLookups,
  uncheckedRuntime,
  type WorkflowRuntimeCompatibility,
} from "@/lib/comfy/manager";

export function OPTIONS(): NextResponse {
  return apiOptions();
}

export async function GET(request: NextRequest) {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;

  const cors = apiCorsHeaders(request);
  const { searchParams } = new URL(request.url);
  const rawWorkflowPath = validateOptionalString(searchParams.get("path"), 512);
  const includeRuntime = searchParams.get("includeRuntime") === "1";

  // If path is provided, return the workflow content for analysis
  if (rawWorkflowPath) {
    // Block path traversal: reject absolute paths (unless saved: prefix) and ..
    if (
      !rawWorkflowPath.startsWith("saved:") &&
      (path.isAbsolute(rawWorkflowPath) ||
        path.normalize(rawWorkflowPath).includes(".."))
    ) {
      return apiError("Invalid workflow path", {
        status: 400,
        headers: cors,
      });
    }

    try {
      const selection = rawWorkflowPath.startsWith("saved:")
        ? rawWorkflowPath
        : `saved:${rawWorkflowPath}`;
      // ?format=ui: the file as saved (graph format), for ComfyUI's editor.
      const workflow =
        searchParams.get("format") === "ui"
          ? await readSavedWorkflowFile(selection)
          : await loadWorkflowFromSelection(selection);
      apiLog("WorkflowsAPI", "Loaded workflow for analysis", { selection });
      return apiOk({ workflow }, { headers: cors });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return apiError(message, { status: 500, headers: cors });
    }
  }

  // Otherwise, return the list of workflows
  try {
    const workflows = await listSavedWorkflows();
    apiLog("WorkflowsAPI", "Listed workflows", { count: workflows.length });

    // Optionally enrich each workflow with runtime compatibility data
    if (includeRuntime) {
      // One /object_info + at most one getmappings for the whole list.
      const lookups = createRuntimeLookups();
      const enriched = await Promise.all(
        workflows.map(async (wf) => {
          let runtime: WorkflowRuntimeCompatibility;
          try {
            const workflow = await loadWorkflowFromSelection(
              `saved:${wf.file}`,
            );
            runtime = await classifyWorkflowRuntimeCompatibility(workflow, {
              lookups,
            });
          } catch (error) {
            // Keep the row honest: it was not checked, and here is why.
            runtime = uncheckedRuntime(
              lookups.comfyBaseUrl,
              `Could not read this workflow: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
            );
          }
          return { ...wf, runtime };
        }),
      );

      return apiOk(
        { workflows: enriched, directory: getSavedWorkflowsDir() },
        { headers: cors },
      );
    }

    return apiOk(
      { workflows, directory: getSavedWorkflowsDir() },
      { headers: cors },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return apiError(message, {
      status: 500,
      details: { workflows: [] },
      headers: cors,
    });
  }
}
