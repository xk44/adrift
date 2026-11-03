/**
 * Contain a client-supplied workflow selection to the shipped workflow
 * folder (public/workflows). Used by routes that read a workflow file named
 * in the request body.
 *
 * - "saved:<name>" selections pass through (lib/comfy/workflows contains them
 *   to the saved-workflows folder).
 * - Anything else must be a relative *.json path that, after resolving
 *   symlinks, is still inside public/workflows. "public/workflows/" prefixes
 *   are accepted. Absolute paths, "..", NUL bytes and non-JSON files
 *   (e.g. .env.local) are refused.
 *
 * Returns the real path to read, or null. Callers answer null with a generic
 * error so nothing about the filesystem leaks.
 */
import fs from "fs/promises";
import path from "path";

export function publicWorkflowsDir(): string {
  return path.join(process.cwd(), "public", "workflows");
}

export async function resolveContainedWorkflowPath(
  selection: string,
  baseDir: string = publicWorkflowsDir(),
): Promise<string | null> {
  if (selection.startsWith("saved:")) return selection;
  if (!selection || selection.includes("\0")) return null;
  if (path.isAbsolute(selection) || path.win32.isAbsolute(selection)) return null;
  const segments = selection.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some((s) => s === "..")) return null;
  if (segments[0] === "public" && segments[1] === "workflows") segments.splice(0, 2);
  if (!segments.length || !/\.json$/i.test(segments[segments.length - 1])) return null;
  try {
    const realBase = await fs.realpath(baseDir);
    const real = await fs.realpath(path.join(realBase, ...segments));
    const rel = path.relative(realBase, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    if (!/\.json$/i.test(real)) return null;
    const st = await fs.stat(real);
    return st.isFile() ? real : null;
  } catch {
    return null;
  }
}
