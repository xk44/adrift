/**
 * Training routes without StyleVault (STYLEVAULT_API_URL unset) fall back to
 * Adrift's local runner; with it set they keep proxying. child_process is
 * mocked: nothing is ever executed.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock("node:child_process", async (orig) => {
  const actual = (await orig()) as typeof import("node:child_process");
  const spawn = vi.fn(() => {
    const { EventEmitter: EE } =
      require("node:events") as typeof import("node:events");
    const c = new EE() as EventEmitter & { pid: number };
    c.pid = 50000 + h.children.length;
    h.children.push(c);
    return c;
  });
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import { spawn } from "node:child_process";

const fetchMock = vi.fn();
let tmp = "";
let cwd = "";
let kreaRoot = "";

function configureMusubi() {
  const repo = path.join(tmp, "musubi-tuner");
  for (const rel of [
    "src/musubi_tuner/krea2_cache_latents.py",
    "src/musubi_tuner/krea2_cache_text_encoder_outputs.py",
    "src/musubi_tuner/krea2_train_network.py",
  ]) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), "");
  }
  const py = path.join(repo, ".venv/bin/python");
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, "");
  fs.chmodSync(py, 0o755);
  const models: Record<string, string> = {};
  for (const k of ["krea2Dit", "krea2TextEncoder", "krea2Vae"]) {
    models[k] = path.join(tmp, `${k}.safetensors`);
    fs.writeFileSync(models[k], "");
  }
  fs.writeFileSync(
    path.join(tmp, "rt.json"),
    JSON.stringify({
      version: 1,
      training: {
        backends: { "musubi-tuner": { repoPath: repo, pythonBin: py } },
        models,
      },
    }),
  );
  return { repo, py };
}

function writeBoard() {
  const boardDir = path.join(kreaRoot, "01_Test_images");
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, "a.png"), Buffer.from([1, 2, 3]));
  fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "data/moodboards.json"),
    JSON.stringify({
      version: 1,
      moodboards: [
        {
          id: "board-id",
          name: "Test Board",
          images: [
            {
              url: "/api/moodboards/krea?board=01_Test_images&file=a.png",
              weight: 1,
            },
          ],
        },
      ],
    }),
  );
}

function trainRequest(body: unknown) {
  return new NextRequest(
    "http://localhost:3000/api/moodboards/board-id/train",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
const params = { params: Promise.resolve({ id: "board-id" }) };

async function fresh(styleVault: boolean) {
  vi.resetModules();
  if (styleVault) vi.stubEnv("STYLEVAULT_API_URL", "http://stylevault.test");
  vi.stubEnv("KREA_MOODBOARDS_DIR", kreaRoot);
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(tmp, "rt.json"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubGlobal("fetch", fetchMock);
  const runner = await import("@/lib/training/local/runner");
  runner.resetRunnerForTests();
  return runner;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  h.children = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cj-local-train-"));
  cwd = path.join(tmp, "app");
  kreaRoot = path.join(tmp, "krea");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(kreaRoot, { recursive: true });
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(async () => {
  const runner = await import("@/lib/training/local/runner");
  runner.resetRunnerForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/identity-lora", () => {
  it("reports the local trainer (not configured) without calling StyleVault", async () => {
    await fresh(false);
    const { GET } = await import("@/app/api/identity-lora/route");
    const body = await (
      await GET(new NextRequest("http://localhost:3000/api/identity-lora"))
    ).json();
    expect(body).toMatchObject({
      trainer: "local",
      configured: false,
      families: [],
    });
    expect(body.error).toMatch(/Settings → Training/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports krea2 once musubi-tuner is set up", async () => {
    configureMusubi();
    await fresh(false);
    const { GET } = await import("@/app/api/identity-lora/route");
    const body = await (
      await GET(new NextRequest("http://localhost:3000/api/identity-lora"))
    ).json();
    expect(body).toMatchObject({
      trainer: "local",
      configured: true,
      families: ["krea2"],
    });
  });

  it("keeps asking StyleVault when STYLEVAULT_API_URL is set", async () => {
    configureMusubi();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await fresh(true);
    const { GET } = await import("@/app/api/identity-lora/route");
    const body = await (
      await GET(new NextRequest("http://localhost:3000/api/identity-lora"))
    ).json();
    expect(body.trainer).not.toBe("local");
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("POST /api/moodboards/[id]/train (local)", () => {
  it("409 with a setup hint when no trainer is configured, before materializing", async () => {
    writeBoard();
    await fresh(false);
    const { POST } = await import("@/app/api/moodboards/[id]/train/route");
    const res = await POST(trainRequest({ trigger_word: "ohwx" }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.setup).toBe(true);
    expect(body.error).toMatch(/Settings → Training/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(cwd, "data/moodboard-training/board-id")),
    ).toBe(false);
  });

  it("rejects out-of-range params", async () => {
    configureMusubi();
    writeBoard();
    await fresh(false);
    const { POST } = await import("@/app/api/moodboards/[id]/train/route");
    const res = await POST(
      trainRequest({ trigger_word: "ohwx", steps: 10_000_000 }),
      params,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Validation: steps must be 100–50000 (got 10000000)",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts a local job (argv, no shell, repo cwd) and answers busy while it runs", async () => {
    const { repo, py } = configureMusubi();
    writeBoard();
    await fresh(false);
    const { POST, GET } = await import("@/app/api/moodboards/[id]/train/route");
    const res = await POST(
      trainRequest({ trigger_word: "ohwx", steps: 1000 }),
      params,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "queued",
      trainer: "local",
      backend: "musubi-tuner",
      materialized: 1,
    });
    expect(body.job_id).toMatch(/^local-[0-9a-f]{12}$/);
    expect(fetchMock).not.toHaveBeenCalled();

    for (let i = 0; i < 50 && h.children.length === 0; i++)
      await new Promise((r) => setTimeout(r, 0));
    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe(py);
    expect(args[0]).toBe(
      path.join(repo, "src/musubi_tuner/krea2_cache_latents.py"),
    );
    expect(opts).toMatchObject({ cwd: repo, detached: true, shell: false });
    expect(JSON.stringify(opts.env)).not.toMatch(/STYLEVAULT|ADMIN_API_KEY/);

    const runDir = path.join(cwd, "data/moodboard-training/board-id");
    const [version] = fs.readdirSync(runDir);
    const files = fs.readdirSync(path.join(runDir, version!));
    const caption = files.find((f) => f.endsWith(".txt"));
    expect(caption).toBeDefined();
    expect(
      fs.readFileSync(path.join(runDir, version!, caption!), "utf8").trim(),
    ).toBe("ohwx");

    const busy = await POST(trainRequest({ trigger_word: "ohwx" }), params);
    expect(busy.status).toBe(409);
    expect((await busy.json()).active_job_id).toBe(body.job_id);

    const runs = await (
      await GET(
        new NextRequest("http://localhost:3000/api/moodboards/board-id/train"),
        params,
      )
    ).json();
    expect(JSON.stringify(runs)).toContain(body.job_id);
  });
});

describe("/api/vault/training/jobs/local-* (local job proxy)", () => {
  async function vault() {
    await fresh(false);
    return import("@/app/api/vault/[...path]/route");
  }
  const ctx = (segs: string[]) => ({ params: Promise.resolve({ path: segs }) });

  it("404s an unknown local job without proxying", async () => {
    const { GET } = await vault();
    const res = await GET(
      new NextRequest(
        "http://localhost:3000/api/vault/training/jobs/local-0123456789ab",
      ),
      ctx(["training", "jobs", "local-0123456789ab"]),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves detail, cancel and refuses deploy for an unfinished job", async () => {
    configureMusubi();
    writeBoard();
    const runner = await fresh(false);
    const train = await import("@/app/api/moodboards/[id]/train/route");
    const { job_id } = await (
      await train.POST(trainRequest({ trigger_word: "ohwx" }), params)
    ).json();
    for (let i = 0; i < 50 && h.children.length === 0; i++)
      await new Promise((r) => setTimeout(r, 0));
    const { GET, POST } = await import("@/app/api/vault/[...path]/route");

    const detail = await GET(
      new NextRequest(
        `http://localhost:3000/api/vault/training/jobs/${job_id}`,
      ),
      ctx(["training", "jobs", job_id]),
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ job_id, status: "running" });

    const deploy = await POST(
      new NextRequest(
        `http://localhost:3000/api/vault/training/jobs/${job_id}/deploy`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ name: "x" }),
        },
      ),
      ctx(["training", "jobs", job_id, "deploy"]),
    );
    expect(deploy.status).toBe(400);

    const cancel = await POST(
      new NextRequest(
        `http://localhost:3000/api/vault/training/jobs/${job_id}/cancel`,
        {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
        },
      ),
      ctx(["training", "jobs", job_id, "cancel"]),
    );
    expect(cancel.status).toBe(200);
    const child = h.children[0] as EventEmitter;
    child.emit("exit", null, "SIGTERM");
    for (let i = 0; i < 50 && runner.activeJobId(); i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(runner.getJob(job_id)?.status).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
