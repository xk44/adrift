#!/usr/bin/env node
/**
 * Is the production build (.next-build, from `npm run build`) current?
 * Used by ./adrift, install.sh and the Windows scripts to pick `next start`
 * over the dev server.
 *
 *   node scripts/build-fresh.mjs           exit 0 = fresh, 1 = stale, 2 = no build
 *   node scripts/build-fresh.mjs --stamp   record the build-time env (after a build)
 *
 * Stale = package.json, the lockfile, a config file or anything under src/ is
 * newer than the build, or (when a stamp exists) a value baked into the
 * browser bundle changed in .env.local (NEXT_PUBLIC_*, CJ_DEFAULT_PACK).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(
  appDir,
  process.env.ADRIFT_BUILD_DIR || ".next-build",
);
const buildId = path.join(distDir, "BUILD_ID");
const stampFile = path.join(distDir, "adrift-env-stamp");

function bakedEnv() {
  const file = path.join(appDir, ".env.local");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) =>
      /^(?:export\s+)?(NEXT_PUBLIC_[A-Z0-9_]*|CJ_DEFAULT_PACK)\s*=/.test(l),
    )
    .sort()
    .join("\n");
}

if (process.argv.includes("--stamp")) {
  if (!existsSync(buildId)) {
    console.error("build-fresh: no build to stamp");
    process.exit(2);
  }
  writeFileSync(stampFile, bakedEnv());
  process.exit(0);
}

if (!existsSync(buildId)) process.exit(2);
const built = statSync(buildId).mtimeMs;

function newer(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) {
      if (e === "__tests__" || e.startsWith(".")) continue;
      const hit = newer(path.join(p, e));
      if (hit) return hit;
    }
    return null;
  }
  return st.mtimeMs > built ? p : null;
}

const inputs = [
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "tailwind.config.ts",
  "postcss.config.mjs",
  "src",
];
for (const rel of inputs) {
  const hit = newer(path.join(appDir, rel));
  if (hit) {
    console.log(`build is older than ${path.relative(appDir, hit)}`);
    process.exit(1);
  }
}
if (existsSync(stampFile) && readFileSync(stampFile, "utf8") !== bakedEnv()) {
  console.log(
    "build is older than the NEXT_PUBLIC_* / CJ_DEFAULT_PACK values in .env.local",
  );
  process.exit(1);
}
process.exit(0);
