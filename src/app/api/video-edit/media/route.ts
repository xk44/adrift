/**
 * GET /api/video-edit/media?f=<area>/<name>.<ext>
 * Serve a video-editor work file (uploads, range cuts, renders, filmstrips,
 * frames) with Range support so <video> can seek. Generated names only;
 * the path is validated and must stay inside the work dir.
 */
import fs from "fs";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { apiCorsHeaders, apiError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { withRateLimit } from "@/lib/rateLimit";
import { parseByteRange } from "@/lib/videoEdit/requests";
import { WORK_MIME, workPath } from "@/lib/videoEdit/server";
import { parseWorkFile } from "@/lib/videoEdit/sourceRef";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;
  // A <video> element issues many small range requests while scrubbing
  // (several per second per clip), so this limit is deliberately loose.
  const rl = withRateLimit(request, { windowMs: 60_000, max: 6000 });
  if (!rl.ok) return rl.response;
  const f = new URL(request.url).searchParams.get("f");
  const w = parseWorkFile(f);
  const abs = w ? workPath(w.file) : null;
  if (!w || !abs) return apiError("Invalid file", { status: 400 });
  let size: number;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return apiError("Not found", { status: 404 });
  }
  const headers = new Headers(apiCorsHeaders(request, "GET"));
  headers.set("Content-Type", WORK_MIME[w.ext] ?? "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `inline; filename="${w.file.split("/")[1]}"`);
  const range = parseByteRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new NextResponse(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const stream = Readable.toWeb(
    fs.createReadStream(abs, { start, end }),
  ) as unknown as ReadableStream<Uint8Array>;
  return new NextResponse(stream, { status: range ? 206 : 200, headers });
}
