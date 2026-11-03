import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("listSavedWorkflows with a fresh ComfyUI", () => {
  it("returns an empty list when user/default/workflows does not exist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj-comfy-"));
    vi.stubEnv("COMFY_ROOT", root);
    vi.resetModules();
    const { listSavedWorkflows, getSavedWorkflowsDir } =
      await import("@/lib/comfy/workflows");
    expect(getSavedWorkflowsDir()).toBe(
      path.join(root, "user/default/workflows"),
    );
    await expect(listSavedWorkflows()).resolves.toEqual([]);
    fs.rmdirSync(root);
  });

  it("still lists workflows when the folder exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cj-comfy-"));
    const dir = path.join(root, "user/default/workflows");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "my_flow.json"), JSON.stringify({}));
    vi.stubEnv("COMFY_ROOT", root);
    vi.resetModules();
    const { listSavedWorkflows } = await import("@/lib/comfy/workflows");
    const list = await listSavedWorkflows();
    expect(list.map((w) => w.file)).toEqual(["my_flow.json"]);
    fs.rmSync(root, { recursive: true });
  });
});
