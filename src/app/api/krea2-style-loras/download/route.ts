import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth";
import { withLock } from "@/lib/locks";
import { withRateLimit } from "@/lib/rateLimit";
import { apiCorsHeaders } from "@/lib/api";
import {
  findStyleLora,
  styleLoraFilename,
  STYLE_LORA_REPO,
} from "@/lib/krea2/styleLoras";
import { inspectDest, resolveContainedDir } from "@/lib/fs/safeDest";
import { downloadErrorStatus, downloadHfFile } from "@/lib/net/hfFileDownload";
import { comfyModelsPath } from "@/lib/paths/resolveDirs";

const CORS_HEADERS = apiCorsHeaders(null, "POST, OPTIONS");

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function fileExists(p: string): Promise<boolean> {
  return (await inspectDest(p)).kind === "file";
}

export async function POST(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const rl = withRateLimit(req, { windowMs: 60_000, max: 10 });
  if (!rl.ok) return rl.response;

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const id = typeof body.id === "string" ? body.id : "";
  // Allowlist: the id MUST resolve to a known catalog entry. This is the only
  // path validation we need — the resolved filename is derived from the
  // catalog, never from user input, so traversal is impossible.
  const entry = findStyleLora(id);
  if (!entry) {
    return NextResponse.json(
      { error: `Unknown style LoRA id: ${id}` },
      { status: 404, headers: CORS_HEADERS },
    );
  }

  const filename = styleLoraFilename(entry.id);
  let destDir: string;
  let present: boolean;
  try {
    // models/loras may itself link to another drive; nothing below it may.
    destDir = await resolveContainedDir(
      comfyModelsPath(env.COMFY_ROOT, "loras"),
    );
    present = await fileExists(path.join(destDir, filename));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: downloadErrorStatus(err), headers: CORS_HEADERS },
    );
  }
  const destPath = path.join(destDir, filename);

  if (present) {
    return NextResponse.json(
      { id: entry.id, filename, installed: true, alreadyPresent: true },
      { headers: CORS_HEADERS },
    );
  }

  // Serialize per-file so concurrent requests don't race the same download.
  let result: { installed: true; alreadyPresent: boolean };
  try {
    result = await withLock(`krea2-style-lora:${entry.id}`, async () => {
      if (await fileExists(destPath)) {
        return { installed: true, alreadyPresent: true } as const;
      }
      const url = `https://huggingface.co/${STYLE_LORA_REPO}/resolve/main/${entry.file}`;
      // Idle timeout + request signal so a stall releases the lock.
      await downloadHfFile({
        url,
        dir: destDir,
        name: filename,
        signal: req.signal,
      });
      return { installed: true, alreadyPresent: false } as const;
    });
  } catch (err) {
    // Fetch/stream failures get a JSON error, not an unhandled throw (HTML 500).
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: downloadErrorStatus(err), headers: CORS_HEADERS },
    );
  }

  const bytes = (await stat(destPath).catch(() => null))?.size ?? null;
  return NextResponse.json(
    {
      id: entry.id,
      filename,
      trigger: entry.trigger,
      bytes,
      ...result,
    },
    { headers: CORS_HEADERS },
  );
}
