/**
 * GPU smoke runner entry. Default --dry-run (GET /object_info only);
 * --run queues real jobs and needs ADRIFT_GPU_OK=1.
 *
 *   ./node_modules/.bin/vite-node --config vitest.config.ts \
 *     scripts/gpu-smoke/run.ts --dry-run --comfy http://127.0.0.1:8188
 *
 * See ./README.md for the full GPU-window recipe.
 */
import { USAGE, checkRunGuard, parseSmokeArgs } from "./cli";

async function start(): Promise<number> {
  let args;
  try {
    args = parseSmokeArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const guard = checkRunGuard(args, process.env);
  if (!guard.ok) {
    console.error(guard.reason);
    return 3;
  }
  // src/lib/env.ts runs dev-server startup side effects (Bonjour advert,
  // ComfyUI probes) at import unless NODE_ENV is "test", and pins
  // COMFY_HTTP_URL at import: set both before loading any app module.
  (process.env as Record<string, string>).NODE_ENV = "test";
  process.env.COMFY_HTTP_URL = args.comfyUrl;
  if (args.sources.length) {
    const { setSmokeSourceOverride, smokeSourceOverrides } = await import("./assets");
    try {
      args.sources.forEach(setSmokeSourceOverride);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    console.log(`source overrides: ${JSON.stringify(smokeSourceOverrides())}`);
  }
  if (args.params.length) {
    const { applySmokeParamOverride } = await import("./manifest");
    try {
      args.params.forEach(applySmokeParamOverride);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    console.log(`param overrides: ${JSON.stringify(args.params)}`);
  }
  const { main } = await import("./runner");
  return main(args);
}

start().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
