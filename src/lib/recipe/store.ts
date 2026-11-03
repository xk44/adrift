/**
 * Recipes in the DB, keyed by ComfyUI prompt id (jobs.prompt_id_comfy links
 * them to a run). The table is created on first use. Server-only.
 */

import { getDB } from "@/lib/db";
import { parseRecipe, type AdriftRecipe } from "./recipe";

let ready = false;

function db() {
  const d = getDB();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS recipes (
        prompt_id TEXT PRIMARY KEY,
        recipe TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    ready = true;
  }
  return d;
}

export function saveRecipe(promptId: string, recipe: AdriftRecipe): void {
  db()
    .prepare("INSERT OR REPLACE INTO recipes (prompt_id, recipe) VALUES (?, ?)")
    .run(promptId, JSON.stringify(recipe));
}

export function getRecipeByPromptId(promptId: string): AdriftRecipe | null {
  const row = db()
    .prepare("SELECT recipe FROM recipes WHERE prompt_id = ?")
    .get(promptId) as { recipe: string } | undefined;
  if (!row) return null;
  const parsed = parseRecipe(row.recipe);
  return parsed.ok ? parsed.recipe : null;
}

/** Stored recipe for job `jobIndex` of a run (falls back to the run's first job). */
export function getRecipeForRun(
  runId: string,
  jobIndex = 0,
): AdriftRecipe | null {
  const rows = db()
    .prepare(
      `SELECT j.id AS id, r.recipe AS recipe FROM jobs j
       JOIN recipes r ON r.prompt_id = j.prompt_id_comfy
       WHERE j.run_id = ?`,
    )
    .all(runId) as Array<{ id: string; recipe: string }>;
  if (rows.length === 0) return null;
  const want = `${runId}:${jobIndex}`;
  const row = rows.find((r) => r.id === want) ?? rows[0];
  const parsed = parseRecipe(row.recipe);
  return parsed.ok ? parsed.recipe : null;
}

/** The run's stored params (runs.params), for runs queued before recipes existed. */
export function getRunParams(runId: string): Record<string, unknown> | null {
  const row = db()
    .prepare("SELECT params FROM runs WHERE id = ?")
    .get(runId) as { params: string | null } | undefined;
  if (!row?.params) return null;
  try {
    const v = JSON.parse(row.params);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
