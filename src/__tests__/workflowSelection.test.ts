import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

async function importWorkflows(comfyRoot: string) {
  vi.resetModules();
  process.env.COMFY_ROOT = comfyRoot;
  return import("@/lib/comfy/workflows");
}

afterEach(() => {
  delete process.env.COMFY_ROOT;
  vi.resetModules();
});

describe("loadWorkflowFromSelection saved paths", () => {
  it("rejects saved path traversal before reading outside the workflows dir", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-workflows-"));
    const { loadWorkflowFromSelection } = await importWorkflows(tmp);

    await expect(
      loadWorkflowFromSelection("saved:../../../etc/passwd"),
    ).rejects.toThrow("Invalid saved workflow path");
  });

  it("loads a normal saved workflow path", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-workflows-"));
    const savedDir = path.join(tmp, "user/default/workflows");
    await fs.mkdir(savedDir, { recursive: true });
    await fs.writeFile(
      path.join(savedDir, "foo.json"),
      JSON.stringify({
        "1": { class_type: "KSampler", inputs: { steps: 20 } },
      }),
      "utf-8",
    );
    const { loadWorkflowFromSelection } = await importWorkflows(tmp);

    const workflow = await loadWorkflowFromSelection("saved:foo.json");

    expect(workflow["1"]?.class_type).toBe("KSampler");
  });

  it("rejects a saved symlink that points outside the workflows dir", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-workflows-"));
    const savedDir = path.join(tmp, "user/default/workflows");
    await fs.mkdir(savedDir, { recursive: true });
    const outside = path.join(tmp, "secret.json");
    await fs.writeFile(outside, JSON.stringify({ "1": { class_type: "X", inputs: {} } }));
    await fs.symlink(outside, path.join(savedDir, "link.json"));
    const { loadWorkflowFromSelection } = await importWorkflows(tmp);

    await expect(loadWorkflowFromSelection("saved:link.json")).rejects.toThrow(
      "Invalid saved workflow path",
    );
  });

  it("rejects saved paths that aren't .json", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-workflows-"));
    const { loadWorkflowFromSelection } = await importWorkflows(tmp);

    await expect(loadWorkflowFromSelection("saved:notes.txt")).rejects.toThrow(
      "Invalid saved workflow path",
    );
  });
});
