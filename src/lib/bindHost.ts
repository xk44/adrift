/**
 * Best-effort answer to "which address is this server listening on?", used
 * only to decide how loudly to warn about a missing ADMIN_API_KEY.
 *
 * Sources, in order:
 *  1. `-H` / `--hostname` in process.argv (`next start` runs in-process).
 *  2. `__NEXT_PRIVATE_ORIGIN`, which Next sets once the server is listening
 *     (`next dev` serves from a forked worker whose argv has no -H).
 *     Next writes "localhost" both for `-H localhost` and for "no -H"
 *     (= every network interface), so "localhost" there means unknown;
 *     likewise "[::1]" (written for -H :: too).
 *  3. A wildcard `HOSTNAME` env (standalone server.js, as in Docker).
 */

export type BindKind = "loopback" | "network" | "unknown";

export interface BindHost {
  host: string | null;
  kind: BindKind;
}

/** 127.0.0.0/8, ::1, and the name localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("::ffff:")) return isLoopbackHost(h.slice(7));
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

function hostFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-H" || a === "--hostname") return argv[i + 1] ?? null;
    if (a.startsWith("--hostname=")) return a.slice("--hostname=".length);
    if (a.startsWith("-H=")) return a.slice(3);
  }
  return null;
}

function hostFromOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

export function resolveBindHost(
  opts: {
    env?: Record<string, string | undefined>;
    argv?: readonly string[];
  } = {},
): BindHost {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;

  const fromArgv = hostFromArgv(argv);
  if (fromArgv) {
    return {
      host: fromArgv,
      kind: isLoopbackHost(fromArgv) ? "loopback" : "network",
    };
  }

  // Standalone server.js (Docker) binds to $HOSTNAME; Next then reports the
  // origin as "localhost". Only a wildcard value is trusted here: shells and
  // containers also set HOSTNAME to the machine name.
  const envHost = env.HOSTNAME?.trim();
  if (envHost === "0.0.0.0" || envHost === "::" || envHost === "[::]") {
    return { host: envHost, kind: "network" };
  }

  const fromOrigin = hostFromOrigin(env.__NEXT_PRIVATE_ORIGIN);
  // Next writes "[::1]" for both -H ::1 and -H :: (every interface), so it
  // is as ambiguous as "localhost".
  if (fromOrigin && fromOrigin !== "localhost" && fromOrigin !== "[::1]") {
    return {
      host: fromOrigin,
      kind: isLoopbackHost(fromOrigin) ? "loopback" : "network",
    };
  }
  return { host: null, kind: "unknown" };
}

/**
 * The ADMIN_API_KEY startup message for a bind, or null when none is needed
 * (key set, or listening on this computer only).
 */
export function adminKeyNotice(
  bind: BindHost,
  adminKeySet: boolean,
): { level: "warn"; text: string } | null {
  if (adminKeySet || bind.kind === "loopback") return null;
  if (bind.kind === "network") {
    const bar = "!".repeat(72);
    return {
      level: "warn",
      text:
        `\n${bar}\n[adrift] WARNING: listening on ${bind.host} without ADMIN_API_KEY — authentication is OFF.\n` +
        `Anyone who can reach this address can use every API route (gallery, prompts, styles, files, jobs).\n` +
        `Set ADMIN_API_KEY in .env.local, or start with -H 127.0.0.1 to stay on this computer.\n${bar}\n`,
    };
  }
  return {
    level: "warn",
    text:
      "[adrift] ADMIN_API_KEY is not set and other machines may be able to reach this server. " +
      "Start with -H 127.0.0.1 to keep it on this computer, or set ADMIN_API_KEY.",
  };
}
