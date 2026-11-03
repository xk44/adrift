/**
 * scripts/serve.mjs: `npm run dev/start` bind 127.0.0.1 by default, honour
 * CJ_HOST / -H, and refuse a non-loopback bind without ADMIN_API_KEY.
 * Runs a copy of the script in a temp dir (no .env.local) in dry-run mode, so
 * no server is ever started.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-serve-"));
fs.mkdirSync(path.join(tmp, "scripts"));
fs.copyFileSync(
  path.join(process.cwd(), "scripts/serve.mjs"),
  path.join(tmp, "scripts/serve.mjs"),
);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CJ_HOST" && k !== "ADMIN_API_KEY") base[k] = v;
  }
  return spawnSync(process.execPath, [path.join(tmp, "scripts/serve.mjs"), ...args], {
    env: { ...base, CJ_SERVE_DRY_RUN: "1", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

describe("scripts/serve.mjs", () => {
  it("binds 127.0.0.1 by default", () => {
    const r = run(["dev"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ mode: "dev", host: "127.0.0.1" });
  });

  it("honours CJ_HOST and -H, passing other args through", () => {
    expect(JSON.parse(run(["start"], { CJ_HOST: "localhost" }).stdout).host).toBe("localhost");
    const r = run(["dev", "-H", "::1", "-p", "3132"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ host: "::1", args: ["-p", "3132"] });
  });

  it("refuses a non-loopback bind without ADMIN_API_KEY", () => {
    for (const env of [{ CJ_HOST: "0.0.0.0" }, { CJ_HOST: "192.168.1.20" }]) {
      const r = run(["dev"], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/ADMIN_API_KEY is not set/);
    }
    expect(run(["dev", "--hostname=0.0.0.0"]).status).toBe(1);
  });

  it("allows a non-loopback bind once ADMIN_API_KEY is set", () => {
    const r = run(["start"], { CJ_HOST: "0.0.0.0", ADMIN_API_KEY: "k".repeat(40) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).host).toBe("0.0.0.0");
  });
});
