/**
 * POST /api/tools/smart-mask
 * Click-to-mask for image tools (MaskPainter "Smart" mode) via core SAM3.
 * Body: {
 *   image: "data:image/...;base64,..." | "<input ref returned earlier>",
 *   include: [{x,y}], exclude?: [{x,y}],   // natural image pixels
 *   width?, height?, threshold?
 * }
 * Reply: { ok: true, mask: "data:image/png;base64,...", image: "<ref>", ms }
 * The client uploads once (data URL) and reuses the returned `image` ref for
 * every following click. Uploads are content-hashed, so a repeat upload of the
 * same picture overwrites the same file instead of adding a new one.
 */
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { apiCorsHeaders } from "@/lib/api";
import { withRateLimit } from "@/lib/rateLimit";
import {
  ComfyAPIError,
  fetchHistory,
  fetchImageBase64,
  queuePrompt,
  uploadImageToComfy,
} from "@/lib/comfy/http";
import {
  buildSmartMaskWorkflow,
  isSafeInputRef,
  SMART_MASK_OUTPUT_NODE,
  SmartMaskError,
} from "@/lib/tools/smartMask";
import { PromptValidationError } from "@/lib/comfy/validatePrompt";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 4096;
const WAIT_MS = 30_000;
const POLL_MS = 250;

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(req, "POST, OPTIONS"),
  });
}

export async function POST(req: NextRequest) {
  const headers = apiCorsHeaders(req, "POST, OPTIONS");
  const fail = (error: string, status: number) =>
    NextResponse.json({ ok: false, error }, { status, headers });

  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  // Clicks are debounced client-side; this is a runaway guard, not a quota.
  const rl = withRateLimit(req, { windowMs: 60_000, max: 120 });
  if (!rl.ok) return rl.response;

  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return fail("Payload too large", 413);
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object") return fail("Invalid JSON body", 400);

  const t0 = Date.now();
  try {
    // 1. Resolve the image: reuse a ref, or upload a data URL once.
    let ref: string;
    const image = body.image;
    if (typeof image === "string" && image.startsWith("data:image/")) {
      const bytes = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
      if (bytes.length === 0) return fail("empty image", 400);
      if (bytes.length > MAX_IMAGE_BYTES) return fail("Payload too large", 413);
      const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
      ref = await uploadImageToComfy(
        new Uint8Array(bytes),
        `smartmask_${hash}.png`,
      );
    } else if (isSafeInputRef(image)) {
      ref = image;
    } else {
      return fail(
        "image must be a data:image URL or an uploaded image ref",
        400,
      );
    }

    // 2. Build + queue (validation errors are the client's fault -> 400).
    const workflow = buildSmartMaskWorkflow({
      image: ref,
      include: body.include as never,
      exclude: body.exclude as never,
      width: body.width as number | undefined,
      height: body.height as number | undefined,
      threshold: body.threshold as number | undefined,
    });
    const { prompt_id: promptId } = await queuePrompt(
      workflow,
      `smartmask-${Date.now().toString(36)}`,
      undefined,
      { front: true },
    );

    // 3. Poll history until done (SAM3 is ~0.3s warm, ~1.5s cold).
    const deadline = t0 + WAIT_MS;
    while (Date.now() < deadline) {
      const entry = await fetchHistory(promptId).catch(() => null);
      const status = entry?.status?.status_str;
      if (status === "error") {
        return fail("SAM3 failed on ComfyUI (see ComfyUI log)", 502);
      }
      const out = entry?.outputs?.[SMART_MASK_OUTPUT_NODE]?.images?.[0];
      if (out) {
        const mask = await fetchImageBase64(
          out.filename,
          out.subfolder ?? "",
          out.type ?? "temp",
        );
        return NextResponse.json(
          { ok: true, mask, image: ref, ms: Date.now() - t0 },
          { headers },
        );
      }
      if (entry?.status?.completed) {
        return fail("SAM3 returned no mask", 502);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return fail("Timed out waiting for SAM3 (ComfyUI busy?)", 504);
  } catch (e) {
    if (e instanceof SmartMaskError) return fail(e.message, 400);
    if (e instanceof ComfyAPIError) {
      const s = e.statusCode;
      return fail(e.message, s && s >= 400 && s < 600 ? s : 502);
    }
    if (e instanceof PromptValidationError) return fail(e.message, 422);
    return fail(e instanceof Error ? e.message : String(e), 502);
  }
}
