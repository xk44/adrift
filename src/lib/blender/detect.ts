/**
 * Where Blender is on this machine, for "Open in Blender" and the USDZ
 * export. Server-only.
 *
 * Precedence: BLENDER_PATH (env) → the path saved in Settings
 * (runtime_settings.json `blenderPath`) → the platform's standard install
 * locations → PATH. A configured path that is not a file is reported and
 * skipped, so a stale setting never hides a working install.
 *
 * Each platform keeps its own candidate list; nothing here replaces another
 * platform's paths. The version comes from `blender --version` run with
 * execFile (argv array, timeout), never a shell string.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isValidDirSetting, readBlenderPathSetting } from "@/lib/runtimeSettings";

export type FsProbe = {
  exists: (p: string) => boolean;
  readdir: (p: string) => string[];
};

export type BlenderSource = "env" | "settings" | "auto" | "none";

export interface BlenderStatus {
  path: string | null;
  version?: string;
  source: BlenderSource;
  /** A configured path (env or Settings) that is not a file. */
  missing?: { source: "env" | "settings"; path: string };
  hint?: string;
}

type Env = Record<string, string | undefined>;

const realFs: FsProbe = {
  exists: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readdir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
};

const FLATPAK_EXPORT = "flatpak/exports/bin/org.blender.Blender";

/**
 * A configured path as an executable path: `~` expanded and, on macOS, a
 * pasted `Blender.app` mapped to the binary inside it.
 */
export function normalizeBlenderPath(
  raw: string,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  let out = raw.trim();
  if (out === "~") out = home;
  else if (out.startsWith("~/") || out.startsWith("~\\"))
    out = p.join(home, out.slice(2));
  if (platform === "darwin" && /\.app\/?$/i.test(out))
    out = p.join(out, "Contents/MacOS/Blender");
  return out;
}

/** Standard install locations for a platform, then PATH. Pure given `probe`. */
export function autoBlenderCandidates(
  platform: NodeJS.Platform,
  env: Env,
  probe: FsProbe = realFs,
): string[] {
  const out: string[] = [];
  // Platform paths use the platform's own path flavour so tests can run
  // any platform's list on any host.
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin") {
    out.push("/Applications/Blender.app/Contents/MacOS/Blender");
    if (env.HOME)
      out.push(
        p.join(env.HOME, "Applications/Blender.app/Contents/MacOS/Blender"),
      );
    out.push("/opt/homebrew/bin/blender", "/usr/local/bin/blender");
  } else if (platform === "win32") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      const foundation = p.join(root, "Blender Foundation");
      // "Blender 5.1", "Blender 4.2" … newest first.
      const versions = probe
        .readdir(foundation)
        .filter((d) => /^Blender/i.test(d))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const dir of versions)
        out.push(p.join(foundation, dir, "blender.exe"));
    }
  } else {
    out.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender");
    if (env.HOME) out.push(p.join(env.HOME, ".local/bin/blender"));
    out.push("/opt/blender/blender");
    out.push(`/var/lib/${FLATPAK_EXPORT}`);
    if (env.HOME) out.push(p.join(env.HOME, `.local/share/${FLATPAK_EXPORT}`));
  }
  const exe = platform === "win32" ? "blender.exe" : "blender";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (dir) out.push(p.join(dir, exe));
  }
  return [...new Set(out)];
}

/** BLENDER_PATH first, then the auto candidates (the USDZ export's order). */
export function blenderCandidates(
  platform: NodeJS.Platform,
  env: Env,
  probe: FsProbe = realFs,
): string[] {
  const auto = autoBlenderCandidates(platform, env, probe);
  return env.BLENDER_PATH ? [...new Set([env.BLENDER_PATH, ...auto])] : auto;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: Env;
  /** The path saved in Settings (unexpanded); defaults to the saved one. */
  saved?: string | null;
  probe?: FsProbe;
  home?: string;
}

/** Which Blender would be used, without running it. */
export function resolveBlender(opts: ResolveOptions = {}): BlenderStatus {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? realFs;
  const home = opts.home ?? env.HOME ?? os.homedir();
  const saved =
    opts.saved !== undefined ? opts.saved : readBlenderPathSetting();
  let missing: BlenderStatus["missing"];
  const configured: {
    source: "env" | "settings";
    raw: string | null | undefined;
  }[] = [
    { source: "env", raw: env.BLENDER_PATH },
    { source: "settings", raw: saved },
  ];
  for (const { source, raw } of configured) {
    if (!raw?.trim()) continue;
    const p = normalizeBlenderPath(raw, platform, home);
    if (probe.exists(p)) return withHint({ path: p, source, missing });
    missing ??= { source, path: p };
  }
  const hit = autoBlenderCandidates(platform, env, probe).find((c) =>
    probe.exists(c),
  );
  return hit
    ? withHint({ path: hit, source: "auto", missing })
    : { path: null, source: "none", ...(missing ? { missing } : {}) };
}

function withHint(s: BlenderStatus): BlenderStatus {
  const out: BlenderStatus = { path: s.path, source: s.source };
  if (s.missing) out.missing = s.missing;
  if (s.path?.includes(FLATPAK_EXPORT))
    out.hint =
      "Flatpak build: it can only open files in folders it has access to.";
  return out;
}

let cachedHit: { key: string; path: string } | null = null;

/**
 * First usable Blender executable on this host, or null. A hit is
 * remembered per configuration and re-checked with one stat per call; a
 * miss is not remembered, so installing Blender needs no restart.
 */
export function findBlender(probe: FsProbe = realFs): string | null {
  if (probe !== realFs) return resolveBlender({ probe }).path;
  const key = `${process.env.BLENDER_PATH ?? ""}\0${readBlenderPathSetting() ?? ""}`;
  if (cachedHit?.key === key && probe.exists(cachedHit.path))
    return cachedHit.path;
  const hit = resolveBlender({ probe }).path;
  cachedHit = hit ? { key, path: hit } : null;
  return hit;
}

/** Test hook: forget the remembered Blender path and versions. */
export function resetBlenderCache(): void {
  cachedHit = null;
  versionCache.clear();
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export const VERSION_TIMEOUT_MS = 8000;

/** "Blender 4.2.3 LTS" → "4.2.3"; undefined when the output isn't Blender's. */
export function parseBlenderVersion(stdout: string): string | undefined {
  return /^Blender\s+(\d+\.\d+(?:\.\d+)?)/m.exec(stdout)?.[1];
}

const versionCache = new Map<string, Promise<string | undefined>>();

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * `blender --version`, bounded by a timeout. Resolves undefined on any
 * failure. Real runs are cached per path + mtime (an upgrade in place is
 * picked up); concurrent callers share one run.
 */
export function probeBlenderVersion(
  exe: string,
  opts: { execFile?: ExecFileFn; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const run = opts.execFile ?? (execFile as unknown as ExecFileFn);
  const probe = () =>
    new Promise<string | undefined>((resolve) => {
      try {
        run(
          exe,
          ["--version"],
          {
            timeout: opts.timeoutMs ?? VERSION_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 256 * 1024,
          },
          (err, stdout) => {
            resolve(err ? undefined : parseBlenderVersion(String(stdout)));
          },
        );
      } catch {
        resolve(undefined);
      }
    });
  if (opts.execFile) return probe();
  const key = `${exe}\0${mtimeOf(exe)}`;
  let hit = versionCache.get(key);
  if (!hit) {
    hit = probe().then((v) => {
      // Don't pin a failed probe (timeout on a cold start, say).
      if (v === undefined) versionCache.delete(key);
      return v;
    });
    versionCache.set(key, hit);
  }
  return hit;
}

/** resolveBlender plus the version of the Blender it found. */
export async function detectBlender(
  opts: ResolveOptions & { execFile?: ExecFileFn; timeoutMs?: number } = {},
): Promise<BlenderStatus> {
  const status = resolveBlender(opts);
  if (!status.path) return status;
  const version = await probeBlenderVersion(status.path, opts);
  return version ? { ...status, version } : status;
}

/**
 * Check a path typed in Settings. Returns the value to save (trimmed,
 * unexpanded; null clears) or a short error. The file must be local, exist
 * and be named like Blender, so this field can't point Adrift at any other
 * program.
 */
export function parseBlenderPathInput(
  raw: unknown,
  opts: { platform?: NodeJS.Platform; probe?: FsProbe; home?: string } = {},
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "path must be a string" };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (!isValidDirSetting(value))
    return { ok: false, error: "Use a full path (or one starting with ~/)" };
  // A network share (\\host\share, //host/share) would make the existence
  // check and the run reach another machine: Windows would hand it this
  // user's NTLM credentials and execute whatever the share serves.
  if (/^[\\/]{2}/.test(value))
    return { ok: false, error: "Use a path on this computer, not a network share" };
  const platform = opts.platform ?? process.platform;
  const exe = normalizeBlenderPath(value, platform, opts.home ?? os.homedir());
  const base = (platform === "win32" ? path.win32 : path.posix).basename(exe);
  if (!/blender/i.test(base))
    return { ok: false, error: "That isn't a Blender executable" };
  if (!(opts.probe ?? realFs).exists(exe))
    return { ok: false, error: `No file at ${exe}` };
  return { ok: true, value };
}
