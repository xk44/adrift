import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { guardRoute } from "@/lib/routeGuard";
import { apiCorsHeaders } from "@/lib/api";
import { invalidPart } from "@/lib/moodboards";
import { BOARD_RE, FILE_RE, resolveKreaUrl } from "@/lib/moodboards/resolve";

function contentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "GET, OPTIONS"),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 600 });
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  if (
    invalidPart(params.get("board"), BOARD_RE) ||
    invalidPart(params.get("file"), FILE_RE)
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid Krea moodboard image path" },
      { status: 400 },
    );
  }

  // Shared with the sv2 style-ref reader: same root default
  // (KREA_MOODBOARDS_DIR or ~/krea-moodboards) and the WebP-mirror fallback.
  const realFile = await resolveKreaUrl(new URL(request.url));
  if (!realFile) {
    return NextResponse.json(
      { ok: false, error: "File not found" },
      { status: 404 },
    );
  }

  try {
    const fileStat = await fs.stat(realFile);
    const stream = Readable.toWeb(createReadStream(realFile));
    return new NextResponse(stream as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType(realFile),
        "Content-Length": fileStat.size.toString(),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "File not found" },
      { status: 404 },
    );
  }
}
