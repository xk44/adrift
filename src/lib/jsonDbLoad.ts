/**
 * Decide whether a JSON-DB load failure may be treated as "no DB yet".
 *
 * Load-then-save handlers that fall back to an empty DB on ANY error will,
 * on the next save, atomically replace a hand-corrupted or unreadable file
 * with a near-empty one — silent data loss. Only a missing file is safe to
 * treat as empty; parse errors and I/O errors (EACCES, EISDIR, …) must
 * surface so the caller 500s and leaves the file alone.
 */
export function isMissingDbError(err: unknown): boolean {
  if (err instanceof SyntaxError) return false;
  const code = (err as { code?: unknown } | null)?.code;
  return code === undefined || code === "ENOENT";
}
