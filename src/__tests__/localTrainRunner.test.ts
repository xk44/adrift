import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ dataDir: "", children: [] as unknown[] }));

vi.mock("@/lib/paths/resolveDirs", () => ({
  adriftDataPath: (...segs: string[]) => {
    const p = require("node:path") as typeof import("node:path");
    return p.join(h.dataDir, ...segs);
  },
}));

vi.mock("node:child_process", () => {
  const spawn = vi.fn(() => {
    const { EventEmitter: EE } =
      require("node:events") as typeof import("node:events");
    const c = new EE() as EventEmitter & { pid: number };
    c.pid = 40000 + h.children.length;
    h.children.push(c);
    return c;
  });
  return {
    spawn,
    execFileSync: vi.fn(() => ""),
    default: { spawn },
  };
});

import { spawn } from "node:child_process";
import {
  TrainerBusyError,
  activeJobId,
  cancelJob,
  getJob,
  isLocalJobId,
  jobDetail,
  logPathFor,
  parseLog,
  resetRunnerForTests,
  startJob,
  trainerEnv,
} from "@/lib/training/local/runner";
import type { TrainPlan } from "@/lib/training/local/plan";

type FakeChild = EventEmitter & { pid: number };

function plan(jobDir: string): TrainPlan {
  return {
    backend: "musubi-tuner",
    family: "krea2",
    cwd: "/opt/musubi-tuner",
    commands: [
      { name: "cache latents", argv: ["/py", "a.py", "--x"] },
      { name: "train", argv: ["/py", "-m", "accelerate.commands.launch"] },
    ],
    files: [
      { path: path.join(jobDir, "dataset.toml"), content: "[general]\n" },
    ],
    outputDir: path.join(jobDir, "output"),
  };
}

const jobDir = (id: string) => path.join(h.dataDir, "training", "jobs", id);
const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 100 && !fn(); i++) await flush();
  expect(fn()).toBe(true);
}

describe("local trainer runner", () => {
  let kill: { mockRestore(): void };

  beforeEach(() => {
    h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-runner-"));
    h.children = [];
    vi.mocked(spawn).mockClear();
    resetRunnerForTests();
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    kill.mockRestore();
    resetRunnerForTests();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  });

  it("runs every command without a shell, detached, in the repo cwd", async () => {
    const id = "local-aaaaaaaaaaaa";
    const rec = startJob({
      plan: plan(jobDir(id)),
      runName: "r",
      datasetDir: "/d",
      jobId: id,
    });
    expect(rec.status).toBe("queued");
    expect(fs.existsSync(path.join(jobDir(id), "dataset.toml"))).toBe(true);
    await waitFor(() => h.children.length === 1);
    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe("/py");
    expect(args).toEqual(["a.py", "--x"]);
    expect(opts).toMatchObject({
      cwd: "/opt/musubi-tuner",
      detached: true,
      shell: false,
    });
    expect(getJob(id)?.status).toBe("running");
  });

  it("transitions running -> done and finds the output LoRA", async () => {
    const id = "local-bbbbbbbbbbbb";
    const onDone = vi.fn(async () => ({
      deployed_path: "/loras/r.safetensors",
    }));
    startJob({
      plan: plan(jobDir(id)),
      runName: "r",
      datasetDir: "/d",
      jobId: id,
      onDone,
    });
    await waitFor(() => h.children.length === 1);
    fs.appendFileSync(logPathFor(id), "caching 3/3\n");
    (h.children[0] as FakeChild).emit("exit", 0, null);
    await waitFor(() => h.children.length === 2);
    fs.appendFileSync(logPathFor(id), "steps: 50%| 5/10 avr_loss=0.12\n");
    fs.writeFileSync(path.join(jobDir(id), "output", "r.safetensors"), "x");
    (h.children[1] as FakeChild).emit("exit", 0, null);
    await waitFor(() => activeJobId() === null);
    const rec = getJob(id)!;
    expect(rec.status).toBe("done");
    expect(rec.output_lora_path).toBe(
      path.join(jobDir(id), "output", "r.safetensors"),
    );
    expect(rec.deployed_path).toBe("/loras/r.safetensors");
    expect(rec.step).toBe(5);
    expect(rec.total_steps).toBe(10);
    expect(onDone).toHaveBeenCalledOnce();
    const detail = jobDetail(rec);
    expect(detail.status).toBe("done");
    expect(detail.progress).toBe(1);
  });

  it("a failing command marks the job failed (public status error)", async () => {
    const id = "local-cccccccccccc";
    startJob({
      plan: plan(jobDir(id)),
      runName: "r",
      datasetDir: "/d",
      jobId: id,
    });
    await waitFor(() => h.children.length === 1);
    (h.children[0] as FakeChild).emit("exit", 2, null);
    await waitFor(() => activeJobId() === null);
    const rec = getJob(id)!;
    expect(rec.status).toBe("failed");
    expect(rec.returncode).toBe(2);
    expect(h.children).toHaveLength(1);
    expect(jobDetail(rec)).toMatchObject({
      status: "error",
      local_status: "failed",
    });
  });

  it("refuses a second job while one runs", async () => {
    const id = "local-dddddddddddd";
    startJob({
      plan: plan(jobDir(id)),
      runName: "r",
      datasetDir: "/d",
      jobId: id,
    });
    expect(() =>
      startJob({
        plan: plan(jobDir("local-eeeeeeeeeeee")),
        runName: "r2",
        datasetDir: "/d",
        jobId: "local-eeeeeeeeeeee",
      }),
    ).toThrow(TrainerBusyError);
  });

  it("cancel kills the whole process group and ends cancelled", async () => {
    const id = "local-ffffffffffff";
    startJob({
      plan: plan(jobDir(id)),
      runName: "r",
      datasetDir: "/d",
      jobId: id,
    });
    await waitFor(() => h.children.length === 1);
    const child = h.children[0] as FakeChild;
    expect(cancelJob(id)).not.toBeNull();
    if (process.platform !== "win32")
      expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    child.emit("exit", null, "SIGTERM");
    await waitFor(() => activeJobId() === null);
    expect(getJob(id)?.status).toBe("cancelled");
    expect(h.children).toHaveLength(1);
  });

  it("marks jobs left running by a previous server as failed", () => {
    const id = "local-111111111111";
    fs.mkdirSync(jobDir(id), { recursive: true });
    fs.writeFileSync(
      path.join(jobDir(id), "job.json"),
      JSON.stringify({ job_id: id, status: "running", commands: [], phase: 0 }),
    );
    expect(getJob(id)?.status).toBe("failed");
  });
});

describe("runner helpers", () => {
  it("job ids are strict", () => {
    expect(isLocalJobId("local-0123456789ab")).toBe(true);
    expect(isLocalJobId("local-../../etc")).toBe(false);
    expect(isLocalJobId("abc")).toBe(false);
  });

  it("parseLog reads the current phase only", () => {
    const p = parseLog(
      "[adrift] phase 1 of 2: cache\n3/3\n[adrift] phase 2 of 2: train\nsteps 7/100 avr_loss=0.5 pred_std=1.1\n",
    );
    expect(p.step).toBe(7);
    expect(p.total).toBe(100);
    expect(p.losses).toEqual([0.5]);
    expect(p.predStd).toBe(1.1);
  });

  it("trainer env drops secrets", () => {
    const env = trainerEnv({
      PATH: "/bin",
      ADMIN_API_KEY: "s",
      CIVITAI_API_KEY: "s",
      HF_HOME: "/hf",
    } as unknown as NodeJS.ProcessEnv);
    expect(env).toEqual({
      PATH: "/bin",
      HF_HOME: "/hf",
      PYTHONUNBUFFERED: "1",
    });
  });
});
