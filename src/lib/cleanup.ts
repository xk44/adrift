/**
 * Background cleanup for stale temp files and thumbnails.
 * Call periodically (e.g. on server startup or cron).
 */
import fs from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { adriftDataPath, comfyOutputDir } from "@/lib/paths/resolveDirs";

/** Inside the data folder (lib/paths/resolveDirs). */
const DATA_DIRS_TO_CLEAN = [
  { dir: "tmp", maxAgeMs: 24 * 60 * 60 * 1000 },
  { dir: "thumbnails", maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
];

export interface CleanupSummary {
  deleted: number;
  errors: number;
  freedBytes: number;
}

export async function cleanupStaleFiles(opts?: {
  includeOutputDir?: boolean;
  outputDir?: string;
  outputMaxAgeMs?: number;
}): Promise<CleanupSummary> {
  const now = Date.now();
  const summary: CleanupSummary = { deleted: 0, errors: 0, freedBytes: 0 };

  const dirs = DATA_DIRS_TO_CLEAN.map((d) => ({
    ...d,
    dir: adriftDataPath(d.dir),
  }));

  if (opts?.includeOutputDir) {
    const outputDir =
      opts.outputDir ??
      comfyOutputDir(env.COMFY_ROOT);
    dirs.push({
      dir: outputDir,
      maxAgeMs: opts.outputMaxAgeMs ?? 30 * 24 * 60 * 60 * 1000,
    });
  }

  for (const { dir, maxAgeMs } of dirs) {
    const fullDir = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
    let entries: string[];
    try {
      entries = await fs.readdir(fullDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(fullDir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          const size = stat.size;
          await fs.unlink(filePath);
          summary.deleted++;
          summary.freedBytes += size;
        }
      } catch {
        summary.errors++;
      }
    }
  }

  if (summary.deleted > 0) {
    console.log(
      `[cleanup] Removed ${summary.deleted} stale files (${(summary.freedBytes / 1024).toFixed(1)} KB freed)`,
    );
  }
  return summary;
}

export function scheduleCleanup(intervalMs = 3_600_000): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const result = await cleanupStaleFiles();
      if (result.deleted > 0)
        console.log(`[cleanup] Removed ${result.deleted} stale files`);
    } catch (e) {
      console.error("[cleanup]", e);
    }
  }, intervalMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return timer;
}

// Auto-start only on the server at runtime (not during build or tests)
if (
  process.env.NODE_ENV !== "test" &&
  process.env.NEXT_PHASE !== "phase-production-build" &&
  typeof globalThis.setInterval === "function"
) {
  // Avoid duplicate timers from hot-reload by storing on globalThis
  const key = "__cj_cleanup_timer";
  if (!(globalThis as Record<string, unknown>)[key]) {
    (globalThis as Record<string, unknown>)[key] = scheduleCleanup();
  }
}
