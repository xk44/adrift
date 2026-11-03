/**
 * GET    /api/user-tools/:id  -> { tool: UserToolRecord } (includes the graph)
 * PATCH  /api/user-tools/:id  { name?, icon?, category?, description?, params? }
 * DELETE /api/user-tools/:id
 */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiCorsHeaders, apiError, apiOk, apiOptions } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import {
  deleteUserTool,
  getUserTool,
  summarizeUserTool,
  updateUserTool,
} from "@/lib/userTools/store";
import {
  readJsonObject,
  userToolErrorResponse,
} from "@/lib/userTools/http";

type Ctx = { params: Promise<{ id: string }> };

const notFound = (requestId: string) =>
  apiError("That tool was not found", {
    status: 404,
    requestId,
    headers: apiCorsHeaders(),
  });

export async function OPTIONS(): Promise<NextResponse> {
  return apiOptions();
}

export async function GET(
  request: NextRequest,
  { params }: Ctx,
): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;
  const { id } = await params;
  try {
    const tool = await getUserTool(id);
    if (!tool) return notFound(requestId);
    return apiOk({ tool }, { requestId, headers: apiCorsHeaders() });
  } catch (e) {
    return userToolErrorResponse(e, requestId, "get");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: Ctx,
): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  const { id } = await params;
  const body = await readJsonObject(request);
  if (!body) return apiError("Invalid JSON body", { status: 400, requestId });
  try {
    const tool = await updateUserTool(id, {
      name: body.name,
      icon: body.icon,
      category: body.category,
      description: body.description,
      params: body.params,
    });
    if (!tool) return notFound(requestId);
    return apiOk(
      { tool: summarizeUserTool(tool) },
      { requestId, headers: apiCorsHeaders() },
    );
  } catch (e) {
    return userToolErrorResponse(e, requestId, "update");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: Ctx,
): Promise<NextResponse> {
  const requestId = uuidv4();
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(request, { windowMs: 60_000, max: 60 });
  if (!rl.ok) return rl.response;
  const { id } = await params;
  try {
    if (!(await deleteUserTool(id))) return notFound(requestId);
    return apiOk({ deleted: id }, { requestId, headers: apiCorsHeaders() });
  } catch (e) {
    return userToolErrorResponse(e, requestId, "delete");
  }
}
