/**
 * Catalog availability vs the GPU backend: when /object_info is reachable it
 * decides whether a tool's base weights exist (the web host's COMFY_ROOT may
 * be a different machine), with the precision-variant fallback honoured.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeAvailability,
  getEditTool,
  installedLorasFor,
  loadPackWorkflow,
  toolWorkflowPath,
} from "@/lib/tools/editTools";

const COMBO_INPUTS: Record<string, string[]> = {
  UNETLoader: ["unet_name"],
  CLIPLoader: ["clip_name"],
  DualCLIPLoader: ["clip_name1", "clip_name2"],
  VAELoader: ["vae_name"],
};

/** object_info with every class the graph uses; loader combos list the
 *  graph's own files, run through `edit` (name -> listed names). */
function infoFor(
  wf: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  edit: (file: string) => string[] = (f) => [f],
): Record<string, unknown> {
  const out: Record<string, { input: { required: Record<string, unknown> } }> =
    {};
  for (const n of Object.values(wf)) {
    const entry = (out[n.class_type] ??= { input: { required: {} } });
    for (const input of COMBO_INPUTS[n.class_type] ?? []) {
      const v = n.inputs[input];
      if (typeof v !== "string") continue;
      const prev =
        (entry.input.required[input] as [string[]] | undefined)?.[0] ?? [];
      entry.input.required[input] = [[...prev, ...edit(v)]];
    }
  }
  return out;
}

describe("computeAvailability with a remote GPU backend", async () => {
  const tool = getEditTool("qwen2511-remove")!;
  const wf = (await loadPackWorkflow(toolWorkflowPath(tool, undefined))) as Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >;
  const unet = Object.values(wf).find((n) => n.class_type === "UNETLoader")!
    .inputs.unet_name as string;
  // empty web-host disk: the old disk check would say "unavailable"
  const root = mkdtempSync(join(tmpdir(), "cj-avail-backend-"));

  it("trusts object_info over the web host's disk when the backend lists the weights", async () => {
    expect(tool).toBeDefined();
    const a = await computeAvailability(
      tool,
      root,
      new Set(),
      undefined,
      infoFor(wf),
    );
    expect(a.packAvailable).toBe(true);
    expect(a.missingModels).toBeUndefined();
  });

  it("marks the pack unavailable when the backend lacks the base UNET", async () => {
    const oi = infoFor(wf, (f) => (f === unet ? [] : [f]));
    const a = await computeAvailability(tool, root, new Set(), undefined, oi);
    expect(a.packAvailable).toBe(false);
    expect(a.missingModels).toEqual([`diffusion_models/${unet}`]);
  });

  it("counts an installed precision sibling as available (queuePrompt swaps it)", async () => {
    expect(unet).toMatch(/bf16/);
    const sibling = unet.replace("bf16", "fp8_e4m3fn");
    const oi = infoFor(wf, (f) => (f === unet ? [sibling] : [f]));
    const a = await computeAvailability(tool, root, new Set(), undefined, oi);
    expect(a.packAvailable).toBe(true);
  });

  it("falls back to the disk check when object_info is unknown", async () => {
    const a = await computeAvailability(tool, root, new Set(), undefined, null);
    expect(a.packAvailable).toBe(false);
    expect(a.missingModels).toBeUndefined();
  });
});

describe("installedLorasFor", () => {
  const root = mkdtempSync(join(tmpdir(), "cj-lora-backend-"));

  it("uses the backend LoRA combo list when object_info has a LoRA loader", async () => {
    const s = await installedLorasFor(root, {
      LoraLoaderModelOnly: {
        input: { required: { lora_name: [["edit_tools\\Foo.safetensors", "bar.safetensors"]] } },
      },
    });
    expect([...s].sort()).toEqual(["bar.safetensors", "edit_tools/foo.safetensors"]);
  });

  it("falls back to the web host's disk when object_info is unknown or has no LoRA loader", async () => {
    expect((await installedLorasFor(root, null)).size).toBe(0);
    expect((await installedLorasFor(root, { KSampler: {} })).size).toBe(0);
  });
});
