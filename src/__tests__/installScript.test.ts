/**
 * install.sh (+ scripts/install-env.mjs, scripts/build-fresh.mjs): runs the
 * real installer against a throwaway copy of the app folder. --dry-run must
 * plan the right commands and write nothing; real runs here only touch
 * .env.local (node_modules is marked in sync, the build is skipped), so
 * nothing is ever installed or downloaded.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const SRC = process.cwd();
const FILES = [
  "install.sh",
  ".env.example",
  "package.json",
  "package-lock.json",
  "scripts/install-env.mjs",
  "scripts/build-fresh.mjs",
  "docker/comfyui-constraints.txt",
];

let root: string;
let app: string;
let home: string;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [join(app, "install.sh"), ...args], {
    cwd: app,
    encoding: "utf8",
    input: "",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
}

/** Every file under dir with its size and mtime, for "nothing was written". */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out.push(`${relative(root, p)} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "adrift install ")));
  app = join(root, "adrift");
  home = join(root, "home");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(app, "docker"));
  mkdirSync(join(app, "node_modules"));
  mkdirSync(home);
  for (const f of FILES) copyFileSync(join(SRC, f), join(app, f));
  // Mark node_modules in sync with the lockfile so no npm ci is planned.
  const sum = spawnSync(
    "sh",
    ["-c", "cksum < package-lock.json | awk '{print $1 \"-\" $2}'"],
    {
      cwd: app,
      encoding: "utf8",
    },
  ).stdout;
  writeFileSync(join(app, "node_modules/.adrift-lock"), sum);
  // The installer proves the database driver loads; stand in for it here.
  stubSqlite("module.exports = class { close() {} };");
});

function stubSqlite(source: string) {
  const dir = join(app, "node_modules/better-sqlite3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), source);
}

describe("install.sh --dry-run", () => {
  it("--no-comfy plans the env file and the build, writes nothing", () => {
    const before = snapshot(root);
    const res = run(["--dry-run", "--yes", "--no-comfy"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("node_modules matches package-lock.json");
    expect(res.stdout).toContain("would create .env.local from .env.example");
    expect(res.stdout).toMatch(
      /\[dry-run\] env NEXT_DIST_DIR=\.next-build .*next build/,
    );
    expect(res.stdout).toContain("Dry run finished");
    expect(res.stdout).toContain("./adrift");
    expect(res.stdout).not.toMatch(/git clone|pip install/);
    expect(snapshot(root)).toEqual(before);
  });

  it("plans npm ci when node_modules is out of date", () => {
    writeFileSync(join(app, "node_modules/.adrift-lock"), "stale");
    const res = run(["--dry-run", "--yes", "--no-comfy", "--no-build"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("[dry-run] npm ci");
    expect(res.stdout).not.toContain("next build");
  });

  it("--comfy PATH plans COMFY_ROOT, writes nothing", () => {
    const comfy = join(root, "My ComfyUI");
    mkdirSync(join(comfy, "venv/bin"), { recursive: true });
    writeFileSync(join(comfy, "main.py"), "");
    const before = snapshot(root);
    const res = run(["--dry-run", "--yes", "--comfy", comfy]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`would set COMFY_ROOT=${comfy}`);
    expect(res.stdout).toContain("Node packs skipped");
    expect(snapshot(root)).toEqual(before);
  });

  it("--comfy rejects a folder without main.py", () => {
    const res = run(["--dry-run", "--yes", "--comfy", join(root, "nope")]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("is not a ComfyUI folder");
  });

  it("--install-comfy DIR plans clone, pinned commit, venv, torch and requirements", () => {
    const dir = join(root, "ComfyUI");
    const before = snapshot(root);
    const res = run(["--dry-run", "--yes", "--install-comfy", dir, "--packs"]);
    // A box without Python 3.10-3.13 stops with guidance instead.
    if (res.status !== 0) {
      expect(res.stderr).toContain("Python 3.10-3.13 is needed");
      return;
    }
    const out = res.stdout;
    expect(out).toContain(
      `[dry-run] git clone https://github.com/Comfy-Org/ComfyUI ${dir.replace(/ /g, "\\ ")}`,
    );
    expect(out).toContain(
      "checkout -q e3bee7ffcb7d6547ed0bcd15221792f3b8646b17",
    );
    expect(out).toMatch(/-m venv .*ComfyUI\/venv/);
    expect(out).toMatch(/pip install torch torchvision torchaudio/);
    expect(out).toMatch(/pip install -r .*ComfyUI\/requirements\.txt/);
    expect(out).toContain("docker/install-comfy-packs.py");
    expect(out).toContain("docker/comfyui-packs-requirements.txt");
    // packs' deps are pinned with the ComfyUI constraints (torch pins dropped)
    expect(out).toMatch(/comfyui-packs-requirements\.txt -c \S*adrift-constraints\./);
    expect(out).toContain(`would set COMFY_ROOT=${dir}`);
    expect(existsSync(dir)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  it("ADRIFT_TORCH_INDEX overrides the wheel index", () => {
    const res = run(
      ["--dry-run", "--yes", "--install-comfy", join(root, "C"), "--no-build"],
      {
        ADRIFT_TORCH_INDEX: "https://download.pytorch.org/whl/rocm6.4",
      },
    );
    if (res.status !== 0) return; // no suitable Python on this box
    expect(res.stdout).toContain(
      "--index-url https://download.pytorch.org/whl/rocm6.4",
    );
  });

  it("--remote plans the URL keys", () => {
    const res = run([
      "--dry-run",
      "--yes",
      "--remote",
      "http://gpu-box:8188/",
      "--no-build",
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(
      "would set COMFY_HTTP_URL=http://gpu-box:8188",
    );
    expect(res.stdout).toContain(
      "would set NEXT_PUBLIC_COMFY_WS_BASE=ws://gpu-box:8188",
    );
    expect(res.stdout).toContain("would set COMFY_WS_BASE=ws://gpu-box:8188");
  });

  it("rejects two ComfyUI modes and unknown flags", () => {
    expect(run(["--no-comfy", "--remote", "http://x:8188"]).status).toBe(2);
    expect(run(["--frobnicate"]).status).toBe(2);
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--install-comfy [DIR]");
  });
});

describe("install.sh real runs (env file only)", () => {
  it("stops when the database driver cannot load", () => {
    stubSqlite('throw new Error("no native binding");');
    const res = run(["--yes", "--no-comfy", "--no-build"]);
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(
      "better-sqlite3 still does not load",
    );
    expect(existsSync(join(app, ".env.local"))).toBe(false);
  });

  it("creates .env.local unpinned, then sets COMFY_ROOT with a backup", () => {
    const first = run(["--yes", "--no-comfy", "--no-build"]);
    expect(first.status, first.stderr).toBe(0);
    const env1 = readFileSync(join(app, ".env.local"), "utf8");
    // The wizard can only save a connection when the URL is not env-pinned.
    expect(env1).not.toMatch(/^COMFY_HTTP_URL=/m);
    expect(env1).not.toMatch(/^NEXT_PUBLIC_COMFY_WS_BASE=/m);
    expect(env1).toMatch(/^# COMFY_HTTP_URL=/m);
    expect(existsSync(join(app, ".env.local.bak"))).toBe(false);

    writeFileSync(join(app, ".env.local"), env1 + "CIVITAI_API_KEY=keep-me\n");
    const comfy = join(root, "ComfyUI");
    mkdirSync(join(comfy, "venv/bin"), { recursive: true });
    writeFileSync(join(comfy, "main.py"), "");
    const second = run(["--yes", "--comfy", comfy, "--no-build"]);
    expect(second.status, second.stderr).toBe(0);
    const env2 = readFileSync(join(app, ".env.local"), "utf8");
    expect(env2).toMatch(new RegExp(`^COMFY_ROOT=${comfy}$`, "m"));
    expect(env2).toContain("CIVITAI_API_KEY=keep-me");
    expect(env2.match(/^COMFY_ROOT=/gm)).toHaveLength(1);
    expect(readFileSync(join(app, ".env.local.bak"), "utf8")).toBe(
      env1 + "CIVITAI_API_KEY=keep-me\n",
    );

    // Re-run: nothing changes, the backup is not rewritten.
    const bakTime = statSync(join(app, ".env.local.bak")).mtimeMs;
    const third = run(["--yes", "--comfy", comfy, "--no-build"]);
    expect(third.stdout).toContain(".env.local already up to date");
    expect(statSync(join(app, ".env.local.bak")).mtimeMs).toBe(bakTime);
  });
});

describe("scripts/build-fresh.mjs", () => {
  const fresh = () =>
    spawnSync(process.execPath, [join(app, "scripts/build-fresh.mjs")], {
      encoding: "utf8",
    }).status;

  it("missing, fresh, stale source, stale baked env", () => {
    expect(fresh()).toBe(2);
    mkdirSync(join(app, ".next-build"));
    writeFileSync(
      join(app, ".env.local"),
      "NEXT_PUBLIC_COMFY_WS_BASE=ws://a:1\n",
    );
    const old = new Date(Date.now() - 60_000);
    for (const f of ["package.json", "package-lock.json", ".env.local"])
      utimesSync(join(app, f), old, old);
    writeFileSync(join(app, ".next-build/BUILD_ID"), "x");
    expect(
      spawnSync(process.execPath, [
        join(app, "scripts/build-fresh.mjs"),
        "--stamp",
      ]).status,
    ).toBe(0);
    expect(fresh()).toBe(0);
    writeFileSync(
      join(app, ".env.local"),
      "NEXT_PUBLIC_COMFY_WS_BASE=ws://b:1\nOTHER=1\n",
    );
    expect(fresh()).toBe(1);
    writeFileSync(
      join(app, ".env.local"),
      "NEXT_PUBLIC_COMFY_WS_BASE=ws://a:1\nOTHER=2\n",
    );
    expect(fresh()).toBe(0); // non-baked keys do not matter
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(app, "package.json"), later, later);
    expect(fresh()).toBe(1);
  });
});
