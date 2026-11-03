// Every environment variable the app reads must be documented in .env.example
// (one place a new user can look). Framework vars and vars derived in
// next.config.ts are exempt.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

// Set by Node/Next itself, or derived from a documented var in next.config.ts.
const EXEMPT = new Set([
  "NODE_ENV",
  "NEXT_PHASE",
  "NEXT_RUNTIME",
  "NEXT_PUBLIC_CJ_DEFAULT_PACK", // = CJ_DEFAULT_PACK
  "VITEST", // set by the test runner
  "HOSTNAME", // set by the shell / Next standalone server.js (Docker)
  "NEXT_PUBLIC_", // a comment about the NEXT_PUBLIC_* prefix, not a var
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name))
      out.push(p);
  }
  return out;
}

function envReads(): Set<string> {
  const files = [
    ...sourceFiles(path.join(ROOT, "src")),
    path.join(ROOT, "next.config.ts"),
  ];
  const names = new Set<string>();
  const re =
    /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])/g;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(re)) names.add(m[1] ?? m[2]);
  }
  return names;
}

describe(".env.example", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

  it("documents every env var the app reads", () => {
    const reads = envReads();
    expect(reads.size).toBeGreaterThan(20); // the scan itself works
    const missing = [...reads]
      .filter((v) => !EXEMPT.has(v))
      .filter((v) => !new RegExp(`^#?\\s*${v}=`, "m").test(example))
      .sort();
    expect(missing).toEqual([]);
  });

  it("leaves optional add-on services commented out", () => {
    for (const v of [
      "STYLEVAULT_API_URL",
      "KREA2_BACKEND_URL",
      "NEVO_BACKEND_URL",
      "HAIRDECK_BACKEND_URL",
    ]) {
      expect(example).not.toMatch(new RegExp(`^${v}=`, "m"));
    }
  });

  it("states the CJ_HOST / ADMIN_API_KEY rule", () => {
    expect(example).toMatch(/^# CJ_HOST=127\.0\.0\.1$/m);
    expect(example).toMatch(/non-loopback CJ_HOST REQUIRES ADMIN_API_KEY/);
  });
});
