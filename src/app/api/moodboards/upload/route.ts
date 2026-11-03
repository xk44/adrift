/**
 * Moodboard Image Upload API
 * Accepts multipart file uploads, saves to data/moodboard-uploads/,
 * returns a serveable URL.
 *
 * POST /api/moodboards/upload  (multipart/form-data, field: "file")
 * Returns: { ok: true, url: "/api/moodboards/upload?file=<filename>" }
 *
 * GET /api/moodboards/upload?file=<filename>
 * Serves the uploaded file.
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { guardRoute } from "@/lib/routeGuard";
import { apiCorsHeaders } from "@/lib/api";
import { MOODBOARD_UPLOAD_DIR, uploadUrl } from "@/lib/moodboards";
import {
  BodyTooLargeError,
  cappedRequest,
  sniffImageType,
} from "@/lib/net/readCapped";

const UPLOAD_DIR = MOODBOARD_UPLOAD_DIR;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
/** Whole multipart body cap: file cap plus room for boundaries/other fields. */
const MAX_BODY = MAX_SIZE + 256 * 1024;

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
  };
  return map[mime] ?? ".bin";
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, POST, OPTIONS"),
  });
}

/** GET — serve an uploaded file (admin-only, user-uploaded content) */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 600 });
  if (!auth.ok) return auth.response;
  const filename = new URL(request.url).searchParams.get("file");
  if (
    !filename ||
    filename.includes("..") ||
    /[/\\\0]/.test(filename) ||
    path.basename(filename) !== filename
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid filename" },
      { status: 400 },
    );
  }

  const filePath = path.join(UPLOAD_DIR, filename);
  try {
    const fileStat = await fs.stat(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".avif": "image/avif",
    };
    const stream = Readable.toWeb(createReadStream(filePath));
    return new NextResponse(stream as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": mimeMap[ext] ?? "application/octet-stream",
        "Content-Length": fileStat.size.toString(),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "File not found" },
      { status: 404 },
    );
  }
}

/** POST — upload an image file */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 30 });
  if (!auth.ok) return auth.response;

  try {
    // Cap the body before multipart parsing buffers it (chunked bodies carry
    // no Content-Length, so the per-file size check alone is too late).
    let capped: Request;
    try {
      capped = await cappedRequest(request, MAX_BODY);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return NextResponse.json(
          { ok: false, error: "File too large (max 10MB)" },
          { status: 413, headers: apiCorsHeaders(null, "GET, POST, OPTIONS") },
        );
      }
      throw e;
    }
    const formData = await capped.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { ok: false, error: "No file provided" },
        { status: 400, headers: apiCorsHeaders(null, "GET, POST, OPTIONS") },
      );
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported file type: ${file.type}` },
        { status: 400, headers: apiCorsHeaders(null, "GET, POST, OPTIONS") },
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { ok: false, error: "File too large (max 10MB)" },
        { status: 400, headers: apiCorsHeaders(null, "GET, POST, OPTIONS") },
      );
    }

    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    // Trust the bytes, not the client-declared MIME type.
    const sniffed = sniffImageType(buffer);
    if (!sniffed || !ALLOWED_TYPES.has(sniffed)) {
      return NextResponse.json(
        { ok: false, error: "File content is not a supported image" },
        { status: 400, headers: apiCorsHeaders(null, "GET, POST, OPTIONS") },
      );
    }
    const filename = `${uuidv4()}${extFromMime(sniffed)}`;
    await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);

    const url = uploadUrl(filename);

    return NextResponse.json(
      { ok: true, url },
      { status: 200, headers: apiCorsHeaders(null, "GET, POST, OPTIONS") },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Moodboard Upload] Error:", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: apiCorsHeaders(null, "GET, POST, OPTIONS") },
    );
  }
}
