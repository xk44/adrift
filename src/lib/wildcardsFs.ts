import fs from "fs";
import path from "path";
import {
  hasWildcards,
  isValidWildcardName,
  parseWildcardFile,
  expandWildcards,
  type WildcardExpansion,
} from "@/lib/wildcards";
import { adriftDataPath } from "@/lib/paths/resolveDirs";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_OPTIONS = 5000;
const MAX_FILES = 500;

export function wildcardRoot(): string {
  return adriftDataPath("wildcards");
}

/**
 * Resolve a wildcard name to a real file path strictly inside the root, or
 * null. Rejects invalid names, symlinks escaping the root, non-files.
 */
export function resolveWildcardPath(
  name: string,
  root: string = wildcardRoot(),
): string | null {
  if (!isValidWildcardName(name)) return null;
  const candidate = path.resolve(root, `${name}.txt`);
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    if (!real.startsWith(realRoot + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return real;
  } catch {
    return null;
  }
}

export function readWildcard(name: string, root?: string): string[] | null {
  const p = resolveWildcardPath(name, root);
  if (!p) return null;
  try {
    return parseWildcardFile(fs.readFileSync(p, "utf8")).slice(0, MAX_OPTIONS);
  } catch {
    return null;
  }
}

export function listWildcards(
  root: string = wildcardRoot(),
): { name: string; count: number }[] {
  const out: { name: string; count: number }[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 4 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
      else if (e.isFile() && e.name.endsWith(".txt")) {
        const name = `${prefix}${e.name.slice(0, -4)}`;
        const opts = readWildcard(name, root);
        if (opts) out.push({ name, count: opts.length });
      }
    }
  };
  walk(root, "", 0);
  return out;
}

export function expandWildcardsFromDisk(
  prompt: string,
  seed: number,
  opts: { braces?: boolean; root?: string } = {},
): WildcardExpansion {
  return expandWildcards(prompt, (n) => readWildcard(n, opts.root), seed, opts);
}

/** What a seeded wildcard expansion did; persisted as params.wildcards. */
export type PromptWildcardInfo = {
  original: string;
  seed: number;
  used: string[];
  missing: string[];
};

/**
 * Shared route helper: expand `__wildcard__` tokens in a submitted prompt
 * with a reproducible seed. Seed precedence: explicit `opts.seed` (e.g. a
 * tool/inpaint body seed) -> the prompt's `--seed N` -> random. Brace
 * alternation is skipped in `--grid` prompts (grid owns `{a,b}` syntax).
 * Returns the prompt unchanged (no info) when it has no wildcard tokens.
 * Callers revalidate `text` (expansion can grow it).
 */
export function expandPromptWildcards(
  prompt: string,
  opts: { seed?: number | null; braces?: boolean; root?: string } = {},
): { text: string; info?: PromptWildcardInfo } {
  if (!hasWildcards(prompt)) return { text: prompt };
  let seed: number;
  if (typeof opts.seed === "number" && Number.isFinite(opts.seed)) {
    seed = Math.abs(Math.floor(opts.seed)) % 4294967296;
  } else {
    const m = prompt.match(/(?:^|\s)--seed\s+(\d+)/);
    seed = m
      ? Number(m[1]) % 4294967296
      : Math.floor(Math.random() * 4294967296);
  }
  const braces = opts.braces ?? !/(^|\s)--grid(\s|$)/.test(prompt);
  const expansion = expandWildcardsFromDisk(prompt, seed, {
    braces,
    root: opts.root,
  });
  return {
    text: expansion.text,
    info: {
      original: prompt,
      seed,
      used: expansion.used,
      missing: expansion.missing,
    },
  };
}

/** Stored form (params.wildcards) — `missing` is response-only. */
export function wildcardParams(info: PromptWildcardInfo): {
  original: string;
  seed: number;
  used: string[];
} {
  return { original: info.original, seed: info.seed, used: info.used };
}
