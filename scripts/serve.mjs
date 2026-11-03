#!/usr/bin/env node
/**
 * `npm run dev` / `npm run start` entry point (works on macOS, Linux and
 * Windows). Binds Next to 127.0.0.1 unless you ask for something else:
 *
 *   CJ_HOST=0.0.0.0 npm run dev        # or: npm run dev -- -H 0.0.0.0
 *
 * The chosen address is exported to the server as CJ_HOST. A non-loopback
 * address without ADMIN_API_KEY is refused here, at boot
 * (src/instrumentation.ts) and per request (src/middleware.ts), because it
 * would expose an unauthenticated API to your network.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode = "dev", ...rest] = process.argv.slice(2);
if (mode !== "dev" && mode !== "start") {
  console.error(`serve.mjs: unknown mode "${mode}" (use dev or start)`);
  process.exit(2);
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Hostname that only ever means this machine (mirrors src/lib/net/bindPolicy.ts). */
function isLoopbackHostname(hostname) {
  const h = String(hostname).trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h === "::1"
  );
}

/** Pull a value for KEY out of .env.local / .env without printing anything. */
function envFileValue(key) {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(appDir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1] === key) return m[2].replace(/^(['"])(.*)\1$/, "$2").trim();
    }
  }
  return "";
}

let host = "";
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "-H" || a === "--hostname") {
    host = rest[++i] ?? "";
    continue;
  }
  const eq = /^(?:-H|--hostname)=(.*)$/.exec(a);
  if (eq) {
    host = eq[1];
    continue;
  }
  args.push(a);
}
host = (host || process.env.CJ_HOST || envFileValue("CJ_HOST") || "127.0.0.1").trim();

const adminKey = (process.env.ADMIN_API_KEY || envFileValue("ADMIN_API_KEY")).trim();
if (!isLoopbackHostname(host) && !adminKey) {
  console.error(
    `\nAdrift won't start on ${host}: other devices could reach it, but ADMIN_API_KEY is not set.\n` +
      `Set ADMIN_API_KEY in .env.local (for example the output of "openssl rand -hex 32"),\n` +
      `or start without CJ_HOST to stay on 127.0.0.1.\n`,
  );
  process.exit(1);
}

if (process.env.CJ_SERVE_DRY_RUN === "1") {
  console.log(JSON.stringify({ mode, host, args }));
  process.exit(0);
}

const require = createRequire(path.join(appDir, "package.json"));
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, mode, "-H", host, ...args], {
  cwd: appDir,
  stdio: "inherit",
  // Adrift sends no telemetry; this also keeps the Next.js CLI quiet.
  env: { NEXT_TELEMETRY_DISABLED: "1", ...process.env, CJ_HOST: host },
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => {
  if (signal) {
    // Drop our forwarding handler first, or re-raising would just be caught
    // and the wrapper would exit 0 instead of reporting the signal.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 0);
});
