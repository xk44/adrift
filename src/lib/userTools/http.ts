/** Shared error -> response mapping for the /api/user-tools routes. */

import type { NextResponse } from "next/server";
import { apiCorsHeaders, apiErr, apiError } from "@/lib/api";
import { CivitaiImportError } from "./civitaiImport";
import { WorkflowExtractError } from "./extract";
import { UserToolInputError } from "./build";
import { UserToolsStoreError } from "./store";
import { UserToolRequestError } from "./service";

export function userToolErrorResponse(
  error: unknown,
  requestId: string,
  where: string,
): NextResponse {
  let status = 500;
  if (
    error instanceof UserToolRequestError ||
    error instanceof CivitaiImportError ||
    error instanceof UserToolsStoreError
  ) {
    status = error.status;
  } else if (
    error instanceof WorkflowExtractError ||
    error instanceof UserToolInputError
  ) {
    status = 400;
  }
  const message =
    status === 500
      ? "Something went wrong. Check the server log."
      : (error as Error).message;
  if (status === 500) {
    apiErr("UserTools", `${where} failed`, {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return apiError(message, { status, requestId, headers: apiCorsHeaders() });
}

/** Parse a JSON object body, or null. */
export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
