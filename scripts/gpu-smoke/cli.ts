/**
 * GPU smoke runner CLI parsing + the --run guard. Pure (no app imports) so
 * run.ts can refuse before anything touches ComfyUI.
 */

export type SmokeMode = "dry-run" | "run";

export interface SmokeArgs {
  mode: SmokeMode;
  comfyUrl: string;
  outDir?: string;
  only: string[];
  skip: string[];
  skipHeavy: boolean;
  includeBlocked: boolean;
  /** --run: seconds to wait for someone else's queue to drain. */
  queueWaitSec: number;
  /** --source <id>=<input path>: real footage in place of a procedural asset. */
  sources: string[];
  /** --param <entryId>:<key>=<value>: override one entry param. */
  params: string[];
  help: boolean;
}

export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";

export const USAGE = `GPU smoke runner (default: --dry-run)

  ./node_modules/.bin/vite-node --config vitest.config.ts scripts/gpu-smoke/run.ts [flags]

  --dry-run            build every graph + validate against GET /object_info (no POST) [default]
  --run                POST /prompt one job at a time, poll /history (needs ADRIFT_GPU_OK=1)
  --comfy <url>        ComfyUI base URL (default: $COMFY_HTTP_URL or ${DEFAULT_COMFY_URL})
  --out <dir>          report directory (default: <tmpdir>/adrift-gpu-smoke)
  --only <id,...>      run only these entry ids (prefix match, e.g. action.dub)
  --skip <id,...>      skip these entry ids (prefix match)
  --skip-heavy         skip MiniMax H3 entries
  --include-blocked    --run: also queue entries whose weights are known missing
  --queue-wait <sec>   --run: max wait for a busy queue before stopping (default 600)
  --source <id>=<path> use a file already in ComfyUI input/ for a source id
                       (e.g. clip=tests/street.mp4) for a quality pass on real footage
  --param <id>:<k>=<v> override one param of an entry, e.g.
                       action.video_object_remove:target=red car
`;

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSmokeArgs(
  argv: string[],
  env: Record<string, string | undefined> = {},
): SmokeArgs {
  const args: SmokeArgs = {
    mode: "dry-run",
    comfyUrl: env.COMFY_HTTP_URL || DEFAULT_COMFY_URL,
    only: [],
    skip: [],
    skipHeavy: false,
    includeBlocked: false,
    queueWaitSec: 600,
    sources: [],
    params: [],
    help: false,
  };
  let sawDry = false;
  let sawRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--dry-run":
        sawDry = true;
        break;
      case "--run":
        sawRun = true;
        break;
      case "--comfy":
        args.comfyUrl = value();
        break;
      case "--out":
        args.outDir = value();
        break;
      case "--only":
        args.only.push(...list(value()));
        break;
      case "--skip":
        args.skip.push(...list(value()));
        break;
      case "--skip-heavy":
        args.skipHeavy = true;
        break;
      case "--include-blocked":
        args.includeBlocked = true;
        break;
      case "--queue-wait":
        args.queueWaitSec = Math.max(0, Number(value()) || 0);
        break;
      case "--source":
        args.sources.push(value());
        break;
      case "--param":
        args.params.push(value());
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (sawDry && sawRun) throw new Error("--dry-run and --run are exclusive");
  if (sawRun) args.mode = "run";
  args.comfyUrl = args.comfyUrl.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(args.comfyUrl))
    throw new Error(
      `--comfy must be a bare http(s)://host:port URL, got ${args.comfyUrl}`,
    );
  return args;
}

/**
 * --run queues real GPU work: it is refused unless ADRIFT_GPU_OK=1 is set.
 */
export function checkRunGuard(
  args: Pick<SmokeArgs, "mode">,
  env: Record<string, string | undefined>,
): { ok: true } | { ok: false; reason: string } {
  if (args.mode !== "run") return { ok: true };
  if (env.ADRIFT_GPU_OK === "1") return { ok: true };
  return {
    ok: false,
    reason:
      "--run queues GPU jobs and is refused unless ADRIFT_GPU_OK=1 is set. Use --dry-run (the default) otherwise.",
  };
}

/** Prefix match for --only / --skip. */
export function selectEntry(
  id: string,
  args: Pick<SmokeArgs, "only" | "skip">,
): boolean {
  const hit = (p: string) => id === p || id.startsWith(p);
  if (args.only.length && !args.only.some(hit)) return false;
  return !args.skip.some(hit);
}
