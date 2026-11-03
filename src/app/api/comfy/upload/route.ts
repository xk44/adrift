/**
 * POST /api/comfy/upload
 * Upload a base64 data-URL image to ComfyUI's input dir; returns the annotated
 * LoadImage ref. Used by dual-reference edit modes (insert / try-on / swap) to
 * supply the 2nd reference image. Short video clips (mp4/mov/m4v/webm
 * filename) go through the same path for LoadVideo (character swap); the
 * ref is then "name.mp4 [input]".
 * Body: { image: "data:image|video/...;base64,...", filename?: string }
 * Reply: { ok: true, ref: "filename [input]" }
 */
import { NextRequest, NextResponse } from "next/server";
import { uploadImageToComfy } from "@/lib/comfy/http";
import { contentHashedName } from "@/lib/comfy/contentName";
import { safeUploadName, safeUploadSubfolder } from "@/lib/comfy/uploadName";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { BodyTooLargeError, readJsonCapped } from "@/lib/net/readCapped";
import { withJudge } from "@/lib/judge/judgeServer";

/** Decoded-image cap; the JSON body is ~4/3 of this. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 4096;

async function handlePost(req: NextRequest) {
  // Admin-gated like every other ComfyUI-writing route: on a keyed
  // deployment anyone who could reach the port could otherwise write into
  // ComfyUI's input dir (overwrite=true).
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rl = withRateLimit(req, { windowMs: 60_000, max: 30 });
  if (!rl.ok) return rl.response;

  let image: unknown;
  let filename: unknown;
  let subfolderRaw: unknown;
  try {
    // Streamed cap (chunked bodies carry no Content-Length).
    ({ image, filename, subfolder: subfolderRaw } = (await readJsonCapped(
      req,
      MAX_BODY_BYTES,
    )) as {
      image?: unknown;
      filename?: unknown;
      subfolder?: unknown;
    });
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return NextResponse.json(
        { ok: false, error: "Payload too large" },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  // Optional input subfolder (allowlisted: sa3_train/<name> for audio LoRA clips).
  const subfolder = safeUploadSubfolder(subfolderRaw);
  if (subfolder === null) {
    return NextResponse.json(
      { ok: false, error: "subfolder not allowed" },
      { status: 400 },
    );
  }
  try {
    if (typeof image !== "string" || !image.startsWith("data:")) {
      return NextResponse.json(
        { ok: false, error: "image must be a data: URL" },
        { status: 400 },
      );
    }
    const base64 = image.slice(image.indexOf(",") + 1);
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    if (bytes.length > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { ok: false, error: "Payload too large" },
        { status: 413 },
      );
    }
    if (bytes.length === 0) {
      return NextResponse.json(
        { ok: false, error: "empty image" },
        { status: 400 },
      );
    }
    // Root-input uploads are content-addressed so concurrent jobs sending the
    // same client name (or the "cj_ref.png" fallback) can't clobber each
    // other under overwrite=true. Training-clip subfolders keep their names:
    // each dataset dir is per-run and the clip names are the dataset.
    const safeName = safeUploadName(filename);
    const name = subfolder ? safeName : contentHashedName(safeName, bytes);
    const ref = await uploadImageToComfy(bytes, name, subfolder);
    return NextResponse.json({ ok: true, ref });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

// Judge mode: ownership / allowlist / quota checks (no-op otherwise).
export const POST = withJudge("upload", handlePost);
