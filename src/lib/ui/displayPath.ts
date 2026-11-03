/**
 * Compact a filesystem path for on-screen display so demos and screenshots
 * never leak the full home-directory layout. The full path should go in a
 * `title` attribute for hover.
 *
 * "/Users/me/Projects/ComfyUI/user/default/workflows" → "~/…/default/workflows"
 * "C:\\ComfyUI\\user\\default\\workflows"             → "…\\default\\workflows"
 */
export function compactPath(path: string, keepSegments = 2): string {
  const raw = (path || "").trim();
  if (!raw) return "";
  const sep = raw.includes("\\") && !raw.includes("/") ? "\\" : "/";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const keep = Math.max(1, keepSegments);
  if (parts.length <= keep) {
    // Already short; still hide a bare home dir name.
    return raw;
  }
  const tail = parts.slice(-keep).join(sep);
  const isHome =
    /^\/(Users|home)\//.test(raw) || raw.startsWith("~") || /^[A-Za-z]:\\Users\\/i.test(raw);
  return isHome ? `~${sep}…${sep}${tail}` : `…${sep}${tail}`;
}
