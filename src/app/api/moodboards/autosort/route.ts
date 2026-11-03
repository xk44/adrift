import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import { apiCorsHeaders } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import { env } from "@/lib/env";
import {
  IMAGE_EXTENSIONS,
  copyImageToMoodboardUploads,
  createMoodboardEntry,
  expandHome,
  isInside,
  realpath,
} from "@/lib/moodboards";

const MAX_IMPORT_IMAGES = 2000;

const autosortSchema = z.object({
  dir: z.string().min(1).max(2000),
  minClusterSize: z.number().int().min(2).max(1000).optional(),
  model: z.string().min(1).max(100).optional(),
  namePrefix: z.string().min(1).max(80).optional(),
  kind: z.enum(["moodboard", "character", "style"]).optional(),
});

interface ClusterImagesResponse {
  clusters: { label: number; members: string[] }[];
  noise: string[];
  skipped: string[];
  model: string;
}

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}

function importRoot(): string {
  return expandHome(env.MOODBOARD_IMPORT_ROOT || os.homedir());
}

async function resolveImportDir(dir: string): Promise<string> {
  if (dir.includes("\0")) {
    throw new Error("Invalid import directory");
  }

  const root = path.resolve(expandHome(importRoot()));
  const expanded = expandHome(dir);
  const candidate = path.resolve(
    path.isAbsolute(expanded) ? expanded : path.join(root, expanded),
  );
  if (!isInside(root, candidate)) {
    throw new Error("Invalid import directory");
  }

  let realRoot: string;
  let realDir: string;
  try {
    realRoot = await realpath(root);
    realDir = await realpath(candidate);
  } catch {
    throw new Error("Invalid import directory");
  }
  if (!isInside(realRoot, realDir)) {
    throw new Error("Invalid import directory");
  }
  return realDir;
}

async function listImages(
  dir: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const paths = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => path.join(dir, entry.name))
    .sort();
  return {
    paths: paths.slice(0, MAX_IMPORT_IMAGES),
    truncated: paths.length > MAX_IMPORT_IMAGES,
  };
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 10 });
  if (!auth.ok) return auth.response;

  try {
    const parsed = autosortSchema.safeParse(await request.json());
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return jsonResponse(
        {
          ok: false,
          error: `Validation: ${firstError?.path.join(".")} - ${firstError?.message}`,
        },
        400,
      );
    }

    const dir = await resolveImportDir(parsed.data.dir);
    const { paths, truncated } = await listImages(dir);
    if (truncated) {
      console.warn(
        `[Moodboard Autosort] Import capped at ${MAX_IMPORT_IMAGES} images: ${dir}`,
      );
    }

    const svResponse = await fetch(`${env.STYLEVAULT_API_URL}/cluster/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths,
        min_cluster_size: parsed.data.minClusterSize ?? 4,
        model: parsed.data.model ?? "color-histogram",
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!svResponse.ok) {
      const body = await svResponse.json().catch(() => ({}));
      return jsonResponse(
        {
          ok: false,
          error: body?.detail || body?.error || "StyleVault clustering failed",
        },
        502,
      );
    }

    const clusters = (await svResponse.json()) as ClusterImagesResponse;
    const moodboards = [];
    for (const cluster of clusters.clusters) {
      const members = [];
      for (const member of cluster.members) {
        try {
          const realMember = await realpath(member);
          if (isInside(dir, realMember)) members.push(realMember);
        } catch {
          continue;
        }
        if (members.length >= 20) break;
      }
      if (!members.length) continue;
      const images = [];
      for (const member of members) {
        const copied = await copyImageToMoodboardUploads(member);
        images.push({ url: copied.url, weight: 1 });
      }
      const name = `${parsed.data.namePrefix || "Auto"} ${cluster.label + 1} (${images.length} images)`;
      const moodboard = await createMoodboardEntry({
        name,
        images,
        kind: parsed.data.kind,
      });
      moodboards.push({
        id: moodboard.id,
        name: moodboard.name,
        imageCount: images.length,
      });
    }

    return jsonResponse({
      ok: true,
      created: moodboards.length,
      moodboards,
      skipped: clusters.skipped.length,
      noise: clusters.noise.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Invalid import directory" ? 400 : 500;
    console.error("[Moodboard Autosort] Error:", message);
    return jsonResponse({ ok: false, error: message }, status);
  }
}
