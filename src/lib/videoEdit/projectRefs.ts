/**
 * Video editor: which uploads a saved project still uses.
 *
 * The project itself lives in the browser (persisted store), so the editor
 * registers the upload files its timeline references under a random project
 * id: data/video-edit/projects/<id>.json = { files, at }. The work-dir sweep
 * never removes a registered upload. Opening the editor re-registers (so
 * `at` stays fresh); closing a project drops its entry.
 *
 * How long an entry that is never refreshed keeps pinning is a server
 * setting ("Keep uploads for saved projects", runtime_settings.json
 * `videoEditRefDays`): by default forever, so a saved project never loses
 * its clips. With 30 / 90 / 365 days, an entry not refreshed for that long is
 * treated as abandoned (browser data cleared) and removed. Either way,
 * releaseStaleProjectRefs lets the user drop old entries by hand.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { parseWorkFile } from "./sourceRef";

export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DAY = 24 * 3_600_000;
/** Allowed "keep uploads for saved projects" choices; null = forever. */
export const REF_KEEP_DAYS = [30, 90, 365] as const;
export type RefKeepDays = (typeof REF_KEEP_DAYS)[number];

/** A valid keep-days choice, or null (forever) for anything else. */
export function parseRefKeepDays(v: unknown): RefKeepDays | null {
  return REF_KEEP_DAYS.includes(v as RefKeepDays) ? (v as RefKeepDays) : null;
}

/** Keep-days choice -> max entry age in ms (null = never expire). */
export function refMaxAgeMs(days: number | null | undefined): number | null {
  return days && days > 0 ? days * DAY : null;
}
/** More than a timeline can hold (MAX_CLIPS), with room for extra refs. */
export const MAX_REF_FILES = 256;
const REFS_DIR = "projects";

export interface RefsRequest {
  projectId: string;
  /** Work files ("uploads/<name>.<ext>"); empty = release the project. */
  files: string[];
}

/** Validate a POST /api/video-edit/refs body. Only upload files count. */
export function parseRefsRequest(
  raw: unknown,
): { ok: true; value: RefsRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "body must be an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.projectId !== "string" || !PROJECT_ID_RE.test(o.projectId))
    return { ok: false, error: "bad projectId" };
  if (!Array.isArray(o.files) || o.files.length > MAX_REF_FILES)
    return { ok: false, error: "files must be a list" };
  const files = new Set<string>();
  for (const f of o.files) {
    const w = parseWorkFile(f);
    if (!w || w.area !== "uploads")
      return { ok: false, error: "files must be editor uploads" };
    files.add(w.file);
  }
  return { ok: true, value: { projectId: o.projectId, files: [...files] } };
}

function refsPath(root: string, projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error("bad project id");
  return path.join(root, REFS_DIR, `${projectId}.json`);
}

/** Register (or, with no files, release) a project's uploads. */
export function writeProjectRefs(
  root: string,
  req: RefsRequest,
  now = Date.now(),
): void {
  const abs = refsPath(root, req.projectId);
  if (req.files.length === 0) {
    fs.rmSync(abs, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ files: req.files, at: now }));
  fs.renameSync(tmp, abs);
}

function refNames(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, REFS_DIR));
  } catch {
    return [];
  }
}

function readRefEntry(abs: string): { files?: unknown; at?: unknown } | null {
  try {
    const data = JSON.parse(fs.readFileSync(abs, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Upload files ("uploads/<name>.<ext>") some live project references.
 * With a maxAge (ms), abandoned entries older than that are deleted on the
 * way; null / undefined (the default) never expires an entry.
 */
export function referencedUploads(
  root: string,
  now = Date.now(),
  maxAge?: number | null,
): Set<string> {
  const out = new Set<string>();
  const dir = path.join(root, REFS_DIR);
  for (const name of refNames(root)) {
    const abs = path.join(dir, name);
    if (name.endsWith(".tmp")) {
      // A write that died half way; harmless once it is old.
      try {
        if (now - fs.statSync(abs).mtimeMs > 3_600_000) fs.rmSync(abs);
      } catch {
        // gone already
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const data = readRefEntry(abs);
    if (!data) continue; // unreadable: leave it, pins nothing
    const at = typeof data.at === "number" ? data.at : 0;
    if (maxAge != null && maxAge > 0 && now - at > maxAge) {
      fs.rmSync(abs, { force: true });
      continue;
    }
    if (!Array.isArray(data.files)) continue;
    for (const f of data.files) {
      const w = parseWorkFile(f);
      if (w?.area === "uploads") out.add(w.file);
    }
  }
  return out;
}

export interface ProjectRefsSummary {
  /** Saved projects pinning uploads. */
  projects: number;
  /** `at` of the least recently opened one (null when none). */
  oldestAt: number | null;
}

/** How many projects pin uploads, and when the stalest was last opened. */
export function projectRefsSummary(root: string): ProjectRefsSummary {
  let projects = 0;
  let oldestAt: number | null = null;
  for (const name of refNames(root)) {
    if (!name.endsWith(".json")) continue;
    const data = readRefEntry(path.join(root, REFS_DIR, name));
    if (!data) continue;
    projects += 1;
    const at = typeof data.at === "number" ? data.at : 0;
    if (oldestAt === null || at < oldestAt) oldestAt = at;
  }
  return { projects, oldestAt };
}

/**
 * Release (delete the entries of) projects not opened for `olderThanMs`.
 * Their uploads stay on disk; they only become sweepable. Returns the count.
 */
export function releaseStaleProjectRefs(
  root: string,
  olderThanMs: number,
  now = Date.now(),
): number {
  let released = 0;
  for (const name of refNames(root)) {
    if (!name.endsWith(".json")) continue;
    const abs = path.join(root, REFS_DIR, name);
    const data = readRefEntry(abs);
    if (!data) continue;
    const at = typeof data.at === "number" ? data.at : 0;
    if (now - at <= olderThanMs) continue;
    try {
      fs.rmSync(abs);
      released += 1;
    } catch {
      // gone already
    }
  }
  return released;
}
