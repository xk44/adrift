import blocklistData from "./node-blocklist.json";

/**
 * Supply-chain blocklist enforcement for ComfyUI-Manager installs.
 *
 * The entries come from a static sweep of the ComfyUI-Manager catalog that flagged
 * env-exfil / secret-harvest / obfuscation / covert-webhook patterns. Blocking is
 * the conservative default; a human clears an entry only after re-auditing.
 *
 * This runs at the single install choke point (queueComfyManagerInstall), so no UI
 * path — workflow missing-node install OR the Manager tab — can install a flagged
 * pack.
 */

export interface BlocklistEntry {
  slug: string; // "owner/repo", lowercased
  url: string;
  rules: string[];
}

interface BlocklistFile {
  generated: string;
  source: string;
  entries: BlocklistEntry[];
}

const data = blocklistData as unknown as BlocklistFile;

/** owner/repo -> entry */
const bySlug = new Map<string, BlocklistEntry>();
/** repo basename -> entries (basename is ambiguous, so keep a list) */
const byBasename = new Map<string, BlocklistEntry[]>();

for (const entry of data.entries) {
  const slug = entry.slug.toLowerCase();
  bySlug.set(slug, entry);
  const base = slug.split("/").pop() ?? slug;
  const list = byBasename.get(base) ?? [];
  list.push(entry);
  byBasename.set(base, list);
}

export interface BlockMatch {
  packId: string;
  slug: string;
  rules: string[];
  matchedOn: "url" | "basename";
}

/** Extract "owner/repo" (lowercased) from a GitHub URL, or null. */
function githubSlug(id: string): string | null {
  const m = id.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  );
  if (!m) return null;
  return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
}

/**
 * Decide whether a Manager pack ID is blocklisted.
 *
 * Pack IDs arrive as either a GitHub URL (owner/repo is authoritative) or a bare
 * CNR id (a repo-name-ish string with no owner — matched on basename, which can
 * be ambiguous; we err toward blocking).
 */
export function matchBlockedPackId(id: string): BlockMatch | null {
  const trimmed = id.trim();
  if (!trimmed) return null;

  const slug = githubSlug(trimmed);
  if (slug) {
    const entry = bySlug.get(slug);
    if (entry) {
      return {
        packId: id,
        slug: entry.slug,
        rules: entry.rules,
        matchedOn: "url",
      };
    }
    // A GitHub URL that isn't in the blocklist is not blocked, even if its
    // basename collides — the owner is authoritative here.
    return null;
  }

  // Bare CNR id: match on basename (owner unknown). Conservative: block on any hit.
  const base = trimmed.toLowerCase().replace(/\.git$/, "");
  const entries = byBasename.get(base);
  if (entries && entries.length > 0) {
    const entry = entries[0];
    return {
      packId: id,
      slug: entry.slug,
      rules: entry.rules,
      matchedOn: "basename",
    };
  }
  return null;
}

/** Partition pack IDs into allowed vs blocked. */
export function partitionBlockedPackIds(ids: string[]): {
  allowed: string[];
  blocked: BlockMatch[];
} {
  const allowed: string[] = [];
  const blocked: BlockMatch[] = [];
  for (const id of ids) {
    const match = matchBlockedPackId(id);
    if (match) blocked.push(match);
    else allowed.push(id);
  }
  return { allowed, blocked };
}

export function blocklistCount(): number {
  return data.entries.length;
}

export function blocklistSlugs(): string[] {
  return data.entries.map((e) => e.slug);
}
