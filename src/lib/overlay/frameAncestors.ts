/**
 * Origins allowed to embed Adrift in an iframe (the ComfyUI overlay bridge),
 * i.e. the CSP `frame-ancestors` list next.config.ts sends.
 *
 * Built once when the server starts from:
 *  - the usual ComfyUI ports on loopback (browser ComfyUI :8188, desktop app
 *    :8000),
 *  - the configured ComfyUI address (env COMFY_HTTP_URL, else the one saved
 *    in Settings) plus any extra ComfyUI machines saved in Settings, so the
 *    overlay works for the configured instance without extra setup,
 *  - CJ_FRAME_ANCESTORS (space-separated origins) for anything else.
 *
 * Imported by next.config.ts, so it uses only node built-ins and relative
 * paths (no "@/" alias, no app modules).
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ANCESTORS = [
  "http://localhost:8188",
  "http://127.0.0.1:8188",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** http(s) origin of a URL, or null. */
export function originOf(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The origin plus its localhost / 127.0.0.1 twin when it is loopback. */
function withLoopbackTwin(origin: string): string[] {
  const u = new URL(origin);
  if (!LOOPBACK.has(u.hostname)) return [origin];
  const port = u.port ? `:${u.port}` : "";
  return [`${u.protocol}//localhost${port}`, `${u.protocol}//127.0.0.1${port}`];
}

/** ComfyUI URLs saved in the runtime settings file (none if unreadable). */
export function savedComfyUrls(file: string): {
  main?: string;
  instances: string[];
} {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      comfy?: { httpUrl?: unknown };
      comfyInstances?: { httpUrl?: unknown }[];
    };
    const main =
      typeof raw?.comfy?.httpUrl === "string" ? raw.comfy.httpUrl : undefined;
    const instances = Array.isArray(raw?.comfyInstances)
      ? raw.comfyInstances
          .map((i) => i?.httpUrl)
          .filter((u): u is string => typeof u === "string")
      : [];
    return { main, instances };
  } catch {
    return { instances: [] };
  }
}

export function buildFrameAncestors(opts: {
  comfyUrls?: readonly string[];
  extra?: string;
}): string[] {
  const list = new Set<string>(["'self'", ...DEFAULT_ANCESTORS]);
  for (const url of opts.comfyUrls ?? []) {
    const o = originOf(url);
    if (o) for (const v of withLoopbackTwin(o)) list.add(v);
  }
  for (const v of opts.extra?.split(/\s+/).filter(Boolean) ?? []) list.add(v);
  return [...list];
}

/** The list for this process (env + saved settings). */
export function frameAncestorsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const settingsFile = env.ADRIFT_RUNTIME_SETTINGS_FILE?.trim()
    ? path.resolve(env.ADRIFT_RUNTIME_SETTINGS_FILE.trim())
    : path.join(cwd, "data", "runtime_settings.json");
  const envUrl = env.COMFY_HTTP_URL?.trim();
  const saved = savedComfyUrls(settingsFile);
  // An env-pinned ComfyUI URL replaces the saved main one; saved extra
  // machines still apply.
  const main = envUrl || saved.main;
  const comfyUrls = [...(main ? [main] : []), ...saved.instances];
  return buildFrameAncestors({ comfyUrls, extra: env.CJ_FRAME_ANCESTORS });
}

/** Whether a ComfyUI origin may frame Adrift under this list. */
export function originAllowed(
  list: readonly string[],
  origin: string,
): boolean {
  return list.includes(origin);
}
