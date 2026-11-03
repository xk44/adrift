/**
 * Safe destinations for files written from remote sources.
 *
 * - leaf names are plain basenames with an allowed extension;
 * - the target directory is resolved with realpath and must stay inside the
 *   trusted base's realpath (a symlinked sub-folder can't point elsewhere;
 *   the base itself may be a symlink, e.g. models/ on another drive);
 * - an existing symlink at the final path is refused;
 * - finishing never silently replaces a file unless asked to.
 *
 * Server-side only.
 */
import { randomUUID } from "crypto";
import { link, lstat, mkdir, realpath, rename, unlink } from "fs/promises";
import path from "path";

export type SafeDestErrorCode =
  "name" | "ext" | "escape" | "symlink" | "exists";

export class SafeDestError extends Error {
  constructor(
    public readonly code: SafeDestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeDestError";
  }
}

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Validate a single file name; returns it unchanged or throws. */
export function validateLeafName(
  name: unknown,
  allowedExts: readonly string[],
  maxLength = 200,
): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > maxLength
  ) {
    throw new SafeDestError("name", "Invalid file name");
  }
  if (
    path.basename(name) !== name ||
    /[/\\]/.test(name) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.startsWith(".") ||
    name.trim() !== name
  ) {
    throw new SafeDestError("name", "Invalid file name");
  }
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (!allowedExts.includes(ext)) {
    throw new SafeDestError(
      "ext",
      `File type ${ext || "(none)"} isn't allowed here`,
    );
  }
  return name;
}

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * mkdir -p `base/...segments` and return its realpath, guaranteed to be
 * inside realpath(base).
 */
export async function resolveContainedDir(
  base: string,
  segments: readonly string[] = [],
): Promise<string> {
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === "." || seg === "..") {
      throw new SafeDestError("escape", "Invalid folder");
    }
  }
  await mkdir(base, { recursive: true });
  const realBase = await realpath(base);
  const target = path.join(realBase, ...segments);
  await mkdir(target, { recursive: true });
  const realTarget = await realpath(target);
  if (!isInside(realBase, realTarget)) {
    throw new SafeDestError(
      "escape",
      "Folder points outside its allowed location",
    );
  }
  return realTarget;
}

export type ExistingFile = { kind: "missing" } | { kind: "file"; size: number };

/** What sits at `p` now. Symlinks and non-files are refused. */
export async function inspectDest(p: string): Promise<ExistingFile> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink())
      throw new SafeDestError("symlink", "A link already sits at that path");
    if (!st.isFile())
      throw new SafeDestError(
        "exists",
        "Something that isn't a file already sits at that path",
      );
    return { kind: "file", size: st.size };
  } catch (err) {
    if (err instanceof SafeDestError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "missing" };
    throw err;
  }
}

/** Hidden temp file next to the final one (same filesystem for rename). */
export function tempPathFor(dir: string, name: string): string {
  return path.join(dir, `.${name}.${randomUUID()}.part`);
}

/**
 * Move a finished temp file into place. Without `overwrite`, an existing
 * file wins and SafeDestError("exists") is thrown (hard link is atomic
 * create-if-absent; filesystems without hard links fall back to a check).
 */
export async function finalizeTemp(
  temp: string,
  final: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<void> {
  // Throws on a symlink or non-file at `final`, overwrite or not.
  const existing = await inspectDest(final);
  if (overwrite) {
    await rename(temp, final);
    return;
  }
  const taken = () => new SafeDestError("exists", "A file with that name already exists");
  if (existing.kind !== "missing") throw taken();
  try {
    await link(temp, final);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw taken();
    // Filesystems without hard links (exFAT, some network shares).
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? "")) throw err;
    if ((await inspectDest(final)).kind !== "missing") throw taken();
    await rename(temp, final);
    return;
  }
  await unlink(temp).catch(() => {});
}

/** `name`, or `name-2.ext`, `name-3.ext`, … whichever is free in `dir`. */
export async function uniqueName(
  dir: string,
  name: string,
  maxTries = 1000,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i <= maxTries; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    if ((await inspectDest(path.join(dir, candidate))).kind === "missing")
      return candidate;
  }
  throw new SafeDestError("exists", "Too many files with that name");
}
