/**
 * Put a HairDeck result in Adrift's outputs: files go to ComfyUI's
 * output/adrift_hairdeck when ComfyUI is on this machine (else they are
 * uploaded to its input dir), then one done run is recorded with a job per
 * seed (preview image + meshes) so history and Export for Blender see it.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { uploadImageToComfy } from "@/lib/comfy/http";
import { getDB, getRunRowsById } from "@/lib/db";
import { env } from "@/lib/env";
import { groupRuns, proxyUrl, type RecentRun } from "@/lib/jobs/recentRuns";
import { resolveOutputPath } from "@/lib/mesh/usdz";
import { comfyIsLocalMachine, comfyOutputDir } from "@/lib/paths/resolveDirs";
import type { HairDeckRequest } from "./config";
import type { HairDeckFile, HairDeckFileKind } from "./gradio";

export const HAIRDECK_SUBFOLDER = "adrift_hairdeck";
const SOURCE = "hairdeck";

export interface SavedHairDeckFile {
  name: string;
  kind: HairDeckFileKind;
  seed: number | null;
  url: string;
}

export interface HairDeckResult {
  run: RecentRun | null;
  /** One entry per seed, in job order. */
  seeds: {
    seed: number;
    preview: string | null;
    meshes: string[];
    downloads: SavedHairDeckFile[];
  }[];
}

type Store = (
  bytes: Uint8Array,
  filename: string,
) => Promise<{ subfolder: string; type: "output" | "input" }>;

/** Default store: local output dir, else upload to the remote ComfyUI. */
async function storeFile(
  bytes: Uint8Array,
  filename: string,
): Promise<{ subfolder: string; type: "output" | "input" }> {
  const outputRoot = comfyOutputDir(env.COMFY_ROOT);
  const dest = comfyIsLocalMachine()
    ? resolveOutputPath(outputRoot, filename, HAIRDECK_SUBFOLDER)
    : null;
  if (dest && fs.existsSync(outputRoot)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes, { flag: "wx" });
    return { subfolder: HAIRDECK_SUBFOLDER, type: "output" };
  }
  const ref = await uploadImageToComfy(bytes, filename, HAIRDECK_SUBFOLDER);
  const m = /^(?:(.*)\/)?([^/]+) \[input\]$/.exec(ref);
  return { subfolder: m?.[1] ?? HAIRDECK_SUBFOLDER, type: "input" };
}

export async function saveHairDeckResult(
  files: HairDeckFile[],
  req: HairDeckRequest,
  opts: { store?: Store; now?: Date } = {},
): Promise<HairDeckResult> {
  const store = opts.store ?? storeFile;
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const tag = crypto.randomBytes(3).toString("hex");

  const saved: (SavedHairDeckFile & {
    filename: string;
    subfolder: string;
    type: string;
  })[] = [];
  for (const f of files) {
    const filename = `hairdeck_${stamp}_${tag}_${f.name}`;
    const where = await store(f.bytes, filename);
    saved.push({
      name: f.name,
      kind: f.kind,
      seed: f.seed,
      filename,
      ...where,
      url: proxyUrl(filename, where.subfolder, where.type),
    });
  }

  const preview = saved.find((s) => s.kind === "preview") ?? null;
  const seeds = [
    ...new Set(
      saved.filter((s) => s.seed !== null).map((s) => s.seed as number),
    ),
  ].sort((a, b) => a - b);
  const runId = `hairdeck-${now.getTime().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const params = {
    tool: SOURCE,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    variations: req.variations,
    chains: req.chains,
  };
  const text = "HairDeck hair cards";
  const ts = Math.floor(now.getTime() / 1000);
  const db = getDB();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO prompts (id, text, parsed_params, created_at, source) VALUES (?, ?, ?, ?, ?)`,
    ).run(`${SOURCE}-${runId}`, text, JSON.stringify(params), ts, SOURCE);
    db.prepare(
      `INSERT INTO runs (id, prompt_id, status, created_at, completed_at, parsed_prompt, params, width, height)
       VALUES (?, ?, 'done', ?, ?, ?, ?, NULL, NULL)`,
    ).run(runId, `${SOURCE}-${runId}`, ts, ts, text, JSON.stringify(params));
    const job = db.prepare(
      `INSERT INTO jobs (id, run_id, seed, status, progress, created_at, completed_at)
       VALUES (?, ?, ?, 'done', 100, ?, ?)`,
    );
    const out = db.prepare(
      `INSERT INTO outputs (job_id, filename, subfolder, type, output_type, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    );
    seeds.forEach((seed, i) => {
      const jobId = `${runId}:${i}`;
      job.run(jobId, runId, seed, ts, ts);
      if (preview)
        out.run(
          jobId,
          preview.filename,
          preview.subfolder,
          preview.type,
          "image",
          ts,
        );
      for (const m of saved.filter((s) => s.seed === seed && s.kind === "mesh"))
        out.run(jobId, m.filename, m.subfolder, m.type, "mesh", ts);
    });
  })();

  const strip = ({ name, kind, seed, url }: SavedHairDeckFile) => ({
    name,
    kind,
    seed,
    url,
  });
  return {
    run: groupRuns(getRunRowsById(runId))[0] ?? null,
    seeds: seeds.map((seed) => ({
      seed,
      preview: preview?.url ?? null,
      meshes: saved
        .filter((s) => s.seed === seed && s.kind === "mesh")
        .map((s) => s.url),
      downloads: saved.filter((s) => s.seed === seed).map(strip),
    })),
  };
}
