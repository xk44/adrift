import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import {
  cancelDownload,
  fetchArgs,
  getJob,
  listedDests,
  pushLines,
  safeDest,
  setupFileDest,
  startDownload,
} from "@/lib/tools/setupDownload";

describe("safeDest", () => {
  it.each([
    ["loras/x.safetensors", true],
    ["diffusion_models/a b.safetensors", false],
    ["../etc/passwd", false],
    ["/abs/x", false],
    ["loras//x", false],
    ["loras/./x", false],
    ["loras/x;rm", false],
    [42, false],
  ])("%s -> %s", (d, ok) => expect(safeDest(d)).toBe(ok));
});

describe("setupFileDest", () => {
  it("joins folder and file", () => {
    expect(setupFileDest({ file: "a.safetensors", folder: "loras/", byName: false })).toBe(
      "loras/a.safetensors",
    );
  });
  it("is null for by-name and folderless files", () => {
    expect(setupFileDest({ file: "x", folder: "loras", byName: true })).toBeNull();
    expect(setupFileDest({ file: "x", folder: null, byName: false })).toBeNull();
  });
});

describe("listedDests", () => {
  it("collects dest and also, dropping unsafe paths", () => {
    const s = listedDests({
      files: [
        { dest: "vae/a.safetensors", also: ["vae/b.safetensors", "../c"] },
        { dest: "/root/x" },
      ],
    });
    expect([...s].sort()).toEqual(["vae/a.safetensors", "vae/b.safetensors"]);
    expect(listedDests(null).size).toBe(0);
  });
});

describe("pushLines", () => {
  it("splits CRs, strips ANSI, collapses progress redraws, caps length", () => {
    const lines: string[] = [];
    pushLines(lines, "start\n\x1b[32mok\x1b[0m\r\n");
    pushLines(lines, "x.safetensors:  10%|#  | 1/10\rx.safetensors:  50%|#####  | 5/10\r");
    expect(lines).toEqual(["start", "ok", "x.safetensors:  50%|#####  | 5/10"]);
    for (let i = 0; i < 10; i++) pushLines(lines, `l${i}\n`, 5);
    expect(lines).toEqual(["l5", "l6", "l7", "l8", "l9"]);
  });
});

describe("fetchArgs", () => {
  it("passes each dest as its own --only, no shell", () => {
    const a = fetchArgs("/srv/ComfyUI", ["loras/a.safetensors", "vae/b.safetensors"]);
    expect(a.slice(1)).toEqual([
      "--comfy",
      "/srv/ComfyUI",
      "--yes",
      "--set",
      "full",
      "--only",
      "loras/a.safetensors",
      "--only",
      "vae/b.safetensors",
    ]);
    expect(a[0]).toMatch(/scripts[\\/]fetch-models\.mjs$/);
  });
});

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 0;
  c.kill = vi.fn();
  return c;
}

describe("startDownload", () => {
  it("tracks output and exit code", () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const job = startDownload("k", ["loras/a.safetensors"], "/c", spawnFn);
    expect(job.state).toBe("running");
    const [bin, args, opts] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(args).toContain("--only");
    expect(opts.shell).toBeUndefined();
    child.stdout.emit("data", Buffer.from("fetching a\n"));
    child.emit("close", 0);
    expect(getJob(job.id)?.state).toBe("done");
    expect(getJob(job.id)?.lines).toEqual(["fetching a"]);
  });

  it("marks failures and cancels running jobs", () => {
    const failing = fakeChild();
    const j1 = startDownload("k", ["loras/a.safetensors"], "/c", (() => failing) as never);
    failing.emit("close", 1);
    expect(getJob(j1.id)?.state).toBe("failed");

    const running = fakeChild();
    const j2 = startDownload("k", ["loras/a.safetensors"], "/c", (() => running) as never);
    expect(cancelDownload(j2.id)).toBe(true);
    expect(running.kill).toHaveBeenCalledWith("SIGTERM");
    expect(getJob(j2.id)?.state).toBe("cancelled");
    running.emit("close", null);
    expect(getJob(j2.id)?.state).toBe("cancelled");
    expect(cancelDownload(j2.id)).toBe(false);
  });
});
