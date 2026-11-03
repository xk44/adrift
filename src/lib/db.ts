/**
 * SQLite database for persistent storage of prompts, workflows, and outputs.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { adriftDataDir } from "@/lib/paths/resolveDirs";

/**
 * <data folder>/adrift.db (the data folder resolves in lib/paths/resolveDirs:
 * ADRIFT_DATA_DIR, else the one set in Settings, else data/). A checkout from
 * before the Adrift rename keeps using its existing legacy database file
 * (never moved) until adrift.db exists. `cwd` (tests) means <cwd>/data.
 */
export function resolveDbFile(cwd?: string): string {
  const dir = cwd ? path.join(cwd, "data") : adriftDataDir();
  const file = path.join(dir, "adrift.db");
  const legacy = path.join(dir, "comfyjourney.db"); // legacy-name
  return !fs.existsSync(file) && fs.existsSync(legacy) ? legacy : file;
}

let _db: Database.Database | null = null;

export function getDB(): Database.Database {
  if (!_db) {
    // data/ is gitignored; on a fresh checkout SQLite can't create the file
    // without its parent directory ("unable to open database file").
    const dbFile = resolveDbFile();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    _db = new Database(dbFile);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      parsed_params TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      workflow_path TEXT,
      source TEXT DEFAULT 'user'
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL REFERENCES prompts(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      node_count INTEGER,
      parsed_prompt TEXT,
      params TEXT,
      width INTEGER,
      height INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      prompt_id_comfy TEXT,
      seed INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      progress REAL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      filename TEXT NOT NULL,
      subfolder TEXT DEFAULT '',
      type TEXT DEFAULT 'output',
      output_type TEXT DEFAULT 'image',
      width INTEGER,
      height INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT,
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_runs_prompt ON runs(prompt_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id);
    CREATE INDEX IF NOT EXISTS idx_outputs_job ON outputs(job_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_comfy ON jobs(prompt_id_comfy);
  `);

  // Additive migrations for existing databases
  for (const sql of [
    "ALTER TABLE outputs ADD COLUMN output_type TEXT DEFAULT 'image'",
    "ALTER TABLE runs ADD COLUMN parsed_prompt TEXT",
    "ALTER TABLE runs ADD COLUMN params TEXT",
    "ALTER TABLE runs ADD COLUMN width INTEGER",
    "ALTER TABLE runs ADD COLUMN height INTEGER",
    // Post-render video QC (lib/videoQc): verdict + JSON detail per job.
    "ALTER TABLE jobs ADD COLUMN qc_status TEXT",
    "ALTER TABLE jobs ADD COLUMN qc TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
  // Machine that accepted the job (backends.ts id: "default", "video", saved id).
  try {
    db.exec("ALTER TABLE jobs ADD COLUMN backend TEXT");
  } catch {
    // exists
  }
}

// Helpers

export function insertPrompt(
  id: string,
  text: string,
  parsedParams?: string,
  workflowPath?: string,
) {
  getDB()
    .prepare(
      "INSERT OR IGNORE INTO prompts (id, text, parsed_params, workflow_path) VALUES (?, ?, ?, ?)",
    )
    .run(id, text, parsedParams ?? null, workflowPath ?? null);
}

export type RunDetails = {
  parsedPrompt?: string;
  params?: Record<string, unknown>;
  width?: number;
  height?: number;
};

export function insertRun(
  id: string,
  promptId: string,
  nodeCount?: number,
  details: RunDetails = {},
) {
  getDB()
    .prepare(
      `INSERT OR IGNORE INTO runs
       (id, prompt_id, node_count, parsed_prompt, params, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      promptId,
      nodeCount ?? null,
      details.parsedPrompt ?? null,
      details.params ? JSON.stringify(details.params) : null,
      details.width ?? null,
      details.height ?? null,
    );
}

export function insertJob(
  id: string,
  runId: string,
  seed?: number,
  comfyPromptId?: string,
  backend?: string,
) {
  if (backend) {
    getDB()
      .prepare(
        "INSERT OR IGNORE INTO jobs (id, run_id, seed, prompt_id_comfy, backend) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, runId, seed ?? null, comfyPromptId ?? null, backend);
    return;
  }
  getDB()
    .prepare(
      "INSERT OR IGNORE INTO jobs (id, run_id, seed, prompt_id_comfy) VALUES (?, ?, ?, ?)",
    )
    .run(id, runId, seed ?? null, comfyPromptId ?? null);
}

export function updateJobStatus(id: string, status: string, error?: string) {
  const completedAt = ["done", "error"].includes(status)
    ? Math.floor(Date.now() / 1000)
    : null;
  getDB()
    .prepare(
      "UPDATE jobs SET status = ?, error = ?, completed_at = ? WHERE id = ?",
    )
    .run(status, error ?? null, completedAt, id);
}

export function insertOutput(
  jobId: string,
  filename: string,
  subfolder?: string,
  width?: number,
  height?: number,
  outputType?: "image" | "video" | "audio" | "mesh",
) {
  getDB()
    .prepare(
      "INSERT INTO outputs (job_id, filename, subfolder, width, height, output_type) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      jobId,
      filename,
      subfolder ?? "",
      width ?? null,
      height ?? null,
      outputType ?? "image",
    );
}

export function updateRunStatus(id: string, status: string, error?: string) {
  const completedAt = ["done", "error"].includes(status)
    ? Math.floor(Date.now() / 1000)
    : null;
  getDB()
    .prepare(
      "UPDATE runs SET status = ?, error = ?, completed_at = ? WHERE id = ?",
    )
    .run(status, error ?? null, completedAt, id);
}

export function insertWorkflow(
  id: string,
  name: string,
  file: string,
  filePath: string,
  kind?: string,
  isDefault?: boolean,
) {
  const now = Math.floor(Date.now() / 1000);
  getDB()
    .prepare(
      `INSERT INTO workflows (id, name, file, path, kind, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         file = excluded.file,
         path = excluded.path,
         kind = excluded.kind,
         is_default = excluded.is_default,
         updated_at = excluded.updated_at`,
    )
    .run(id, name, file, filePath, kind ?? null, isDefault ? 1 : 0, now, now);
}

export function getSavedWorkflows() {
  return getDB()
    .prepare("SELECT * FROM workflows ORDER BY is_default DESC, name ASC")
    .all();
}

export function getDefaultWorkflow() {
  return getDB()
    .prepare("SELECT * FROM workflows WHERE is_default = 1 LIMIT 1")
    .get();
}

export function getRecentPrompts(limit = 50) {
  return getDB()
    .prepare("SELECT * FROM prompts ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

export function getRunsByPrompt(promptId: string) {
  return getDB()
    .prepare("SELECT * FROM runs WHERE prompt_id = ? ORDER BY created_at")
    .all(promptId);
}

/**
 * Insert an output row unless the job already has one with that filename
 * and subfolder. For writers that run outside the per-job reconcile lock
 * (the background USDZ export, the on-demand convert route).
 */
export function recordOutputOnce(
  jobId: string,
  filename: string,
  subfolder: string,
  outputType: "image" | "video" | "audio" | "mesh",
): boolean {
  const db = getDB();
  const insert = db.transaction(() => {
    const hit = db
      .prepare(
        "SELECT 1 FROM outputs WHERE job_id = ? AND filename = ? AND COALESCE(subfolder, '') = ?",
      )
      .get(jobId, filename, subfolder);
    if (hit) return false;
    insertOutput(jobId, filename, subfolder, undefined, undefined, outputType);
    return true;
  });
  return insert();
}

/** Job that recorded a given output file, if any (newest first). */
export function findJobIdForOutput(
  filename: string,
  subfolder: string,
): string | null {
  const row = getDB()
    .prepare(
      "SELECT job_id FROM outputs WHERE filename = ? AND COALESCE(subfolder, '') = ? ORDER BY id DESC LIMIT 1",
    )
    .get(filename, subfolder) as { job_id: string } | undefined;
  return row?.job_id ?? null;
}

export function getOutputsByJob(jobId: string) {
  return getDB()
    .prepare("SELECT * FROM outputs WHERE job_id = ? ORDER BY created_at")
    .all(jobId);
}

export type RecentRunRow = {
  run_id: string;
  prompt: string;
  parsed_prompt: string | null;
  params: string | null;
  width: number | null;
  height: number | null;
  created_at: number;
  job_id: string | null;
  seed: number | null;
  job_status: string | null;
  progress: number | null;
  prompt_id_comfy: string | null;
  job_error: string | null;
  output_filename: string | null;
  output_subfolder: string | null;
  /** ComfyUI folder type ("output"/"temp"/"input") — the proxy's `type`. */
  output_type: string | null;
  /** Media kind recorded by insertOutput: image | video | audio | mesh. */
  output_media: string | null;
};

const RUN_ROW_COLUMNS = `
         r.id AS run_id, p.text AS prompt, r.parsed_prompt, r.params,
         r.width, r.height, r.created_at,
         j.id AS job_id, j.seed, j.status AS job_status, j.progress,
         j.prompt_id_comfy, j.error AS job_error,
         o.filename AS output_filename, o.subfolder AS output_subfolder,
         o.type AS output_type, o.output_type AS output_media`;

/** Flat joined rows for a page of runs; callers group jobs and outputs. */
export function getRecentRunRows(limit: number, offset: number): RecentRunRow[] {
  return getDB()
    .prepare(
      `WITH recent_runs AS (
         SELECT r.id
         FROM runs r
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?
       )
       SELECT${RUN_ROW_COLUMNS}
       FROM recent_runs rr
       JOIN runs r ON r.id = rr.id
       JOIN prompts p ON p.id = r.prompt_id
       LEFT JOIN jobs j ON j.run_id = r.id
       LEFT JOIN outputs o ON o.job_id = j.id
       ORDER BY r.created_at DESC, r.id DESC, j.created_at ASC, o.id ASC`,
    )
    .all(limit, offset) as RecentRunRow[];
}

/** Same row shape as getRecentRunRows for one run (empty when unknown). */
export function getRunRowsById(runId: string): RecentRunRow[] {
  return getDB()
    .prepare(
      `SELECT${RUN_ROW_COLUMNS}
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
       LEFT JOIN jobs j ON j.run_id = r.id
       LEFT JOIN outputs o ON o.job_id = j.id
       WHERE r.id = ?
       ORDER BY j.created_at ASC, o.id ASC`,
    )
    .all(runId) as RecentRunRow[];
}

/** ComfyUI prompt ids (of `ids`) that already have a job row. */
export function existingComfyPromptIds(ids: string[]): Set<string> {
  const found = new Set<string>();
  const stmt = getDB().prepare(
    "SELECT 1 FROM jobs WHERE prompt_id_comfy = ? LIMIT 1",
  );
  for (const id of ids) if (stmt.get(id)) found.add(id);
  return found;
}

export type ComfyHistoryImport = {
  /** ComfyUI prompt_id — dedupe key (jobs.prompt_id_comfy). */
  comfyPromptId: string;
  /** Unix seconds (from the history status timestamps). */
  createdAt: number;
  completedAt: number;
  text: string;
  params: Record<string, unknown>;
  seed: number | null;
  width: number | null;
  height: number | null;
  nodeCount: number | null;
  outputs: {
    filename: string;
    subfolder: string;
    mediaType: "image" | "video" | "audio" | "mesh";
  }[];
};

/**
 * Insert one finished ComfyUI history job as prompt/run/job/outputs with
 * its original timestamps. Atomic; returns false (no writes) when a job with
 * that ComfyUI prompt_id already exists.
 */
export function importComfyHistoryJob(item: ComfyHistoryImport): boolean {
  const db = getDB();
  const tx = db.transaction(() => {
    const hit = db
      .prepare("SELECT 1 FROM jobs WHERE prompt_id_comfy = ? LIMIT 1")
      .get(item.comfyPromptId);
    if (hit) return false;
    const promptRowId = `comfy-import-${item.comfyPromptId}`;
    const runId = `comfy-${item.comfyPromptId}`;
    const jobId = `${runId}:0`;
    db.prepare(
      `INSERT INTO prompts (id, text, parsed_params, created_at, source)
       VALUES (?, ?, ?, ?, 'comfy_history')`,
    ).run(promptRowId, item.text, JSON.stringify(item.params), item.createdAt);
    db.prepare(
      `INSERT INTO runs
       (id, prompt_id, status, created_at, completed_at, node_count,
        parsed_prompt, params, width, height)
       VALUES (?, ?, 'done', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      promptRowId,
      item.createdAt,
      item.completedAt,
      item.nodeCount,
      item.text,
      JSON.stringify(item.params),
      item.width,
      item.height,
    );
    db.prepare(
      `INSERT INTO jobs
       (id, run_id, prompt_id_comfy, seed, status, progress, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'done', 100, ?, ?)`,
    ).run(
      jobId,
      runId,
      item.comfyPromptId,
      item.seed,
      item.createdAt,
      item.completedAt,
    );
    const out = db.prepare(
      `INSERT INTO outputs (job_id, filename, subfolder, type, output_type, created_at)
       VALUES (?, ?, ?, 'output', ?, ?)`,
    );
    for (const o of item.outputs) {
      out.run(jobId, o.filename, o.subfolder, o.mediaType, item.completedAt);
    }
    return true;
  });
  return tx();
}

export type LocalOutputRun = {
  runId: string;
  text: string;
  params: Record<string, unknown>;
  width: number | null;
  height: number | null;
  /** prompts.source tag, e.g. "video_edit". */
  source: string;
  output: {
    filename: string;
    subfolder: string;
    /** ComfyUI folder type the proxy reads it from. */
    type: "output" | "input";
    mediaType: "image" | "video";
  };
};

/**
 * Record a finished output made outside ComfyUI (video editor export) as a
 * done prompt/run/job/output so it shows up in history like any other run.
 * Atomic.
 */
export function insertLocalOutputRun(item: LocalOutputRun): void {
  const db = getDB();
  const now = Math.floor(Date.now() / 1000);
  const promptId = `${item.source}-${item.runId}`;
  const jobId = `${item.runId}:0`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO prompts (id, text, parsed_params, created_at, source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(promptId, item.text, JSON.stringify(item.params), now, item.source);
    db.prepare(
      `INSERT INTO runs
       (id, prompt_id, status, created_at, completed_at, parsed_prompt, params, width, height)
       VALUES (?, ?, 'done', ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.runId,
      promptId,
      now,
      now,
      item.text,
      JSON.stringify(item.params),
      item.width,
      item.height,
    );
    db.prepare(
      `INSERT INTO jobs (id, run_id, seed, status, progress, created_at, completed_at)
       VALUES (?, ?, 0, 'done', 100, ?, ?)`,
    ).run(jobId, item.runId, now, now);
    db.prepare(
      `INSERT INTO outputs (job_id, filename, subfolder, type, output_type, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      item.output.filename,
      item.output.subfolder,
      item.output.type,
      item.output.mediaType,
      item.width,
      item.height,
      now,
    );
  })();
}
