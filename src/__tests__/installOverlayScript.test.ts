/**
 * scripts/install-overlay.sh: links the bridge node into ComfyUI installs.
 * Runs the real script against throwaway dirs (HOME is sandboxed so no real
 * desktop-app config is discovered).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/install-overlay.sh");
const NODE_SRC = realpathSync(join(process.cwd(), "comfy_nodes/adrift_overlay"));
const NODES_PACK = realpathSync(join(process.cwd(), "comfy_nodes/sref_system"));

let root: string;
let home: string;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      // Point the sibling-checkout probe at an empty dir.
      COMFY_DIR: join(root, "no-sibling"),
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
}

function makeComfy(name: string) {
  const base = join(root, name);
  mkdirSync(join(base, "custom_nodes"), { recursive: true });
  return base;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cj install overlay ")));
  home = join(root, "home");
  mkdirSync(home);
});

// Temp dirs are left for the OS to reap; nothing outside them is touched.

describe("install-overlay.sh", () => {
  it("links into an explicit base whose path contains spaces", () => {
    const base = makeComfy("Comfy UI install");
    const res = run([base]);
    expect(res.status).toBe(0);
    const dest = join(base, "custom_nodes/adrift_overlay");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(realpathSync(dest)).toBe(NODE_SRC);
  });

  it("is idempotent and does not nest a link inside the linked dir", () => {
    const base = makeComfy("comfy");
    expect(run([base]).status).toBe(0);
    const second = run([base]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already linked");
    // `ln -sfn` without the guard on a real dir would create adrift_overlay/adrift_overlay.
    expect(existsSync(join(NODE_SRC, "adrift_overlay"))).toBe(false);
  });

  it("replaces a stale or dangling link", () => {
    const base = makeComfy("comfy");
    const dest = join(base, "custom_nodes/adrift_overlay");
    symlinkSync(join(root, "gone"), dest);
    const res = run([base]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("relinked");
    expect(realpathSync(dest)).toBe(NODE_SRC);
  });

  it("refuses to touch a real adrift_overlay directory", () => {
    const base = makeComfy("comfy");
    const dest = join(base, "custom_nodes/adrift_overlay");
    mkdirSync(dest);
    writeFileSync(join(dest, "user.txt"), "keep");
    const res = run([base]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("not a symlink");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readdirSync(dest)).toEqual(["user.txt"]);
  });

  it("rejects a base without custom_nodes and writes nothing", () => {
    const bare = join(root, "bare");
    mkdirSync(bare);
    const res = run([bare]);
    expect(res.status).toBe(1);
    expect(readdirSync(bare)).toEqual([]);
  });

  it("dedupes the same install reached via a symlinked path", () => {
    const base = makeComfy("real");
    const alias = join(root, "alias");
    symlinkSync(base, alias);
    const res = run([base, alias]);
    expect(res.status).toBe(0);
    expect(res.stdout.match(/linked:/g)?.length).toBe(1);
  });

  it("discovers the desktop app basePath but ignores relative ones", () => {
    const base = makeComfy("desktop base");
    const cfgDir = join(home, ".config/ComfyUI");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ basePath: base }),
    );
    const res = run([]);
    expect(res.status).toBe(0);
    expect(readlinkSync(join(base, "custom_nodes/adrift_overlay"))).toBe(NODE_SRC);

    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ basePath: "relative/comfy" }),
    );
    const rel = run([]);
    // A relative basePath is not a target, so nothing is discovered.
    expect(rel.status).toBe(1);
    expect(rel.stderr).toContain("No ComfyUI installs found");
  });

  it("keeps an old sref_system link to this repo and says the overlay moved", () => {
    const base = makeComfy("comfy");
    const old = join(base, "custom_nodes/sref_system");
    symlinkSync(NODES_PACK, old);
    const res = run([base]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("overlay moved to adrift_overlay");
    expect(realpathSync(old)).toBe(NODES_PACK);
    expect(realpathSync(join(base, "custom_nodes/adrift_overlay"))).toBe(NODE_SRC);
  });
});
