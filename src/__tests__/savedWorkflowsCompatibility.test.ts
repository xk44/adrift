import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  getSavedWorkflowsDir,
  listSavedWorkflows,
  loadWorkflowFromSelection,
} from "@/lib/comfy/workflows";

async function collectJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectJsonFiles(fullPath);
      if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
      return [];
    }),
  );
  return files.flat();
}

// Host-dependent: reads the saved workflows under COMFY_ROOT. Opt in with
// COMFY_RUNTIME_COMPAT=1 (and COMFY_ROOT set) so fresh clones / CI pass.
describe.skipIf(process.env.COMFY_RUNTIME_COMPAT !== "1")("saved ComfyUI workflow compatibility", () => {
  it("discovers saved workflows recursively so imported packs are assignable", async () => {
    const root = getSavedWorkflowsDir();
    const recursiveFiles = await collectJsonFiles(root);
    const workflows = await listSavedWorkflows();

    expect(workflows.length).toBe(recursiveFiles.length);
    expect(workflows.some((workflow) => workflow.file.includes("/"))).toBe(
      recursiveFiles.some((file) => path.relative(root, file).includes(path.sep)),
    );
  });

  it("can parse every discovered saved workflow without crashing", async () => {
    const workflows = await listSavedWorkflows();
    expect(workflows.length).toBeGreaterThan(0);

    const failures: string[] = [];

    for (const workflow of workflows) {
      try {
        await loadWorkflowFromSelection(`saved:${workflow.file}`);
      } catch (error) {
        failures.push(
          `${workflow.file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
