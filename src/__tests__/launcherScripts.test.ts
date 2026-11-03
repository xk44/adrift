/**
 * First-run friction in the shell launchers (./adrift, scripts/launch-adrift.sh,
 * scripts/start-comfyui.sh, install.sh) and the wizard's local ComfyUI probe.
 * Every script runs against stubs: a fake ComfyUI whose "python" only echoes
 * its arguments, fake node/npm on PATH, and throwaway HTTP servers on random
 * ports. Nothing is installed, downloaded or started for real.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  probeLocalCandidates,
  type ProbeResult,
} from "@/lib/onboarding/comfyProbe";

const SRC = process.cwd();
const SCRIPTS = [
  "install.sh",
  "adrift",
  "scripts/launch-adrift.sh",
  "scripts/start-comfyui.sh",
  "scripts/install-overlay.sh",
  "scripts/mock-comfy/dev.sh",
];

let root: string;
let servers: Server[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "adrift-launch-")));
});
afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  servers = [];
});

function exe(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Async run, so in-process HTTP servers can answer the script's curl. */
function runAsync(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd = root,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          ...env,
        } as unknown as NodeJS.ProcessEnv,
        timeout: 60_000,
      },
      (error: Error | null, stdout: string, stderr: string) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: String(stdout),
          err: String(stderr),
        }),
    );
  });
}

/** An HTTP server on a random loopback port; returns the port. */
async function serve(
  handler: (url: string) => { status: number; body: string },
): Promise<number> {
  const s = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

/** A port nothing listens on (bound, then released). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("shell scripts parse", () => {
  it.each(SCRIPTS)("bash -n %s", (f) => {
    const r = spawnSync("bash", ["-n", join(SRC, f)], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("scripts/start-comfyui.sh", () => {
  const script = join(SRC, "scripts/start-comfyui.sh");
  /** Fake ComfyUI: main.py plus a venv "python" that prints its argv. */
  function fakeComfy(): string {
    const dir = join(root, "ComfyUI");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.py"), "");
    exe(join(dir, "venv/bin/python"), 'echo "ARGS: $*"');
    return dir;
  }

  it("passes --preview-method auto, the CORS origin and the port", async () => {
    const dir = fakeComfy();
    const port = await freePort();
    const r = await runAsync("bash", [script], {
      COMFY_ROOT: dir,
      COMFY_PORT: String(port),
      CJ_CACHE_RAM: "0",
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("--preview-method auto");
    expect(r.out).toContain("--enable-cors-header http://localhost:3000");
    expect(r.out).toContain(`--port ${port}`);
    expect(r.out).toContain("--listen 127.0.0.1");
  });

  it("no ComfyUI: names the install.sh options", async () => {
    const r = await runAsync("bash", [script], {
      COMFY_ROOT: join(root, "missing"),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("no ComfyUI found");
    expect(r.err).toContain("./install.sh --comfy /path/to/ComfyUI");
    expect(r.err).toContain("./install.sh --remote http://HOST:8188");
    expect(r.err).toContain("./install.sh --install-comfy");
  });

  it("ComfyUI without a venv: says how to create one", async () => {
    const dir = join(root, "Bare");
    mkdirSync(dir);
    writeFileSync(join(dir, "main.py"), "");
    const r = await runAsync("bash", [script], { COMFY_ROOT: dir });
    expect(r.code).toBe(1);
    expect(r.err).toContain("has no venv/ or .venv/");
    expect(r.err).toContain(`./install.sh --install-comfy ${dir}`);
  });

  it("port taken by another program: fails fast with the fix", async () => {
    const dir = fakeComfy();
    const port = await serve(() => ({ status: 404, body: "nope" }));
    const r = await runAsync("bash", [script], {
      COMFY_ROOT: dir,
      COMFY_PORT: String(port),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`port ${port} is in use by another program`);
    expect(r.out).not.toContain("ARGS:");
  });

  it("ComfyUI already on the port: exits 0 without starting another", async () => {
    const dir = fakeComfy();
    const port = await serve(() => ({ status: 200, body: '{"system":{}}' }));
    const r = await runAsync("bash", [script], {
      COMFY_ROOT: dir,
      COMFY_PORT: String(port),
    });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("already running");
    expect(r.out).not.toContain("ARGS:");
  });
});

describe("scripts/launch-adrift.sh ports", () => {
  const script = join(SRC, "scripts/launch-adrift.sh");
  const env = (port: number) => ({
    PORT: String(port),
    ADRIFT_COMFY: "0",
    ADRIFT_NO_OPEN: "1",
    ADRIFT_LOG_DIR: join(root, "logs"),
  });

  it("another program on the app port: exits 1 and suggests PORT=", async () => {
    const port = await serve(() => ({ status: 200, body: "<html></html>" }));
    const r = await runAsync("bash", [script], env(port));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`port ${port} is in use by another program`);
    expect(r.err).toContain("PORT=3001 ./adrift");
  });

  it("Adrift already on the app port: leaves it alone", async () => {
    const port = await serve((u) =>
      u.startsWith("/api/health")
        ? { status: 200, body: '{"ok":true,"comfyui":"connected","uptime":5}' }
        : { status: 200, body: "<html></html>" },
    );
    const r = await runAsync("bash", [script], env(port));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Adrift already running on :${port}`);
    expect(r.out).not.toContain("starting Adrift app");
  });

  it("another program on the ComfyUI port: says so, still starts nothing there", async () => {
    const app = await serve((u) =>
      u.startsWith("/api/health")
        ? { status: 200, body: '{"ok":true,"uptime":1}' }
        : { status: 200, body: "" },
    );
    const comfy = await serve(() => ({ status: 404, body: "" }));
    const r = await runAsync("bash", [script], {
      ...env(app),
      ADRIFT_COMFY: "1",
      COMFY_PORT: String(comfy),
    });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain(`port ${comfy} is in use by another program`);
    expect(r.out).not.toContain("starting ComfyUI");
  });
});

describe("./adrift prerequisites", () => {
  let app: string;
  beforeEach(() => {
    app = join(root, "app");
    mkdirSync(join(app, "scripts"), { recursive: true });
    copyFileSync(join(SRC, "adrift"), join(app, "adrift"));
    chmodSync(join(app, "adrift"), 0o755);
  });

  it("Node too old: names the version and the fix", async () => {
    const bin = join(root, "bin");
    exe(
      join(bin, "node"),
      'case "$1" in -p) echo 18 ;; -v) echo v18.19.0 ;; esac',
    );
    const r = await runAsync("bash", [join(app, "adrift")], {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Node.js v18.19.0 is too old");
    expect(r.err).toMatch(/brew install node@22|nvm install --lts|winget/);
  });

  it("not installed yet (no terminal): points at ./install.sh", async () => {
    const r = await runAsync("bash", [join(app, "adrift")], {});
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("Run ./install.sh first");
  });
});

describe("install.sh failures are never silent", () => {
  it("a failing npm ci names the command, the step and the re-run", () => {
    const app = join(root, "adrift");
    mkdirSync(join(app, "scripts"), { recursive: true });
    mkdirSync(join(app, "docker"));
    mkdirSync(join(app, "node_modules"));
    for (const f of [
      "install.sh",
      ".env.example",
      "package.json",
      "package-lock.json",
      "scripts/install-env.mjs",
      "scripts/build-fresh.mjs",
    ])
      copyFileSync(join(SRC, f), join(app, f));
    const bin = join(root, "bin");
    exe(
      join(bin, "npm"),
      'if [ "$1" = -v ]; then echo 10.0.0; exit 0; fi\necho "npm ERR! boom" >&2; exit 7',
    );
    const r = spawnSync(
      "bash",
      [join(app, "install.sh"), "--yes", "--no-comfy", "--no-build"],
      {
        cwd: app,
        encoding: "utf8",
        input: "",
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          HOME: root,
        } as unknown as NodeJS.ProcessEnv,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("failed (exit 7): npm ci");
    expect(r.stderr).toContain("Step: App dependencies");
    expect(r.stderr).toContain("run ./install.sh again");
    expect(r.stdout).not.toContain("Adrift is installed");
  });

  it("--help lists --start", () => {
    const r = spawnSync("bash", [join(SRC, "install.sh"), "--help"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--start / --no-start");
    expect(r.stdout).toContain("-h, --help");
  });
});

describe("probeLocalCandidates", () => {
  const fail = (url: string, code: string): ProbeResult =>
    ({ ok: false, url, code, error: code }) as ProbeResult;

  it("first answer wins", async () => {
    const seen: string[] = [];
    const r = await probeLocalCandidates(["a", "b"], async (u) => {
      seen.push(u);
      return u === "a"
        ? ({ ok: true, url: u } as unknown as ProbeResult)
        : fail(u, "unreachable");
    });
    expect(r?.ok).toBe(true);
    expect(seen).toEqual(["a"]);
  });

  it("all silent: reports the first (:8188), not the last", async () => {
    const r = await probeLocalCandidates(["8188", "8000"], async (u) =>
      fail(u, "unreachable"),
    );
    expect(r?.url).toBe("8188");
  });

  it("something answered on a later port: that failure is reported", async () => {
    const r = await probeLocalCandidates(["8188", "8000"], async (u) =>
      fail(u, u === "8000" ? "not_comfy" : "timeout"),
    );
    expect(r).toMatchObject({ url: "8000", code: "not_comfy" });
  });

  it("no candidates: null", async () => {
    expect(await probeLocalCandidates([])).toBeNull();
  });
});
