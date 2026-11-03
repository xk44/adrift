/**
 * Tools whose graphs need this repo's custom node packs (comfy_nodes/*)
 * read "needs setup" with a pack reason setupHint can parse, and the pack
 * ids / node classes are the real ones (graphs, comfy_nodes sources and,
 * opt-in, a live /object_info dump via LIVE_OBJECT_INFO).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  actionAvailability,
  getActionTool,
  nodePackReason,
  type ModelStatusResponse,
} from "@/lib/tools/toolsPage";
import { setupHint } from "@/lib/tools/setupHint";
import { missingOnDefaultBackend } from "@/lib/comfy/backendModels";
import type { Workflow } from "@/types";

const ROOT = process.cwd();
const LIVE_INFO_FILE = process.env.LIVE_OBJECT_INFO;
const LIVE: Record<string, { python_module?: string }> | null =
  LIVE_INFO_FILE && fs.existsSync(LIVE_INFO_FILE)
    ? JSON.parse(fs.readFileSync(LIVE_INFO_FILE, "utf-8"))
    : null;

const graph = (pack: string, action: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "public/workflows/packs", pack, `${action}.json`),
      "utf-8",
    ),
  );
  delete raw._meta;
  return raw as Workflow;
};
const classes = (wf: Workflow) =>
  new Set(
    Object.values(wf)
      .filter((n) => n && typeof n === "object" && "class_type" in n)
      .map((n) => (n as { class_type: string }).class_type),
  );

const PACKED = {
  vectorize: { id: "cj_image_tools", nodes: ["CJVectorize"] },
  breakdown: { id: "cj_image_tools", nodes: ["CJCutouts"] },
  video_palette: { id: "cj_h3_tools", nodes: ["CJVideoPalette"] },
} as const;
const PACKS = new Set<string>();
const status = (id: string, missing: string[]): ModelStatusResponse => ({
  tools: { [id]: { missing } },
});

describe("tool node packs", () => {
  for (const [id, pack] of Object.entries(PACKED)) {
    it(`${id}: nodePack matches its graph and comfy_nodes/${pack.id}`, () => {
      const spec = getActionTool(id)!;
      expect(spec.nodePack).toEqual(pack);
      expect(spec.requireStatusEntry).toBe(true);
      const wf = graph(spec.modelCheck!.pack, spec.modelCheck!.action);
      const dir = path.join(ROOT, "comfy_nodes", pack.id);
      const src = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".py"))
        .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
        .join("\n");
      for (const node of pack.nodes) {
        expect(classes(wf).has(node)).toBe(true);
        expect(src).toContain(node);
      }
    });

    it(`${id}: missing pack node -> needs setup with a pack hint`, () => {
      const spec = getActionTool(id)!;
      const av = actionAvailability(
        spec,
        PACKS,
        null,
        status(id, [`node:${pack.nodes[0]}`]),
      );
      expect(av.available).toBe(false);
      expect(av.reason).toMatch(
        new RegExp(`^The ${pack.id} pack isn't installed`),
      );
      expect(setupHint(av.reason)).toBe(`Needs the ${pack.id} pack`);
      // No status entry yet: still not ready (requireStatusEntry).
      expect(
        actionAvailability(spec, PACKS, null, { tools: {} }).available,
      ).toBe(false);
      expect(
        actionAvailability(spec, PACKS, null, status(id, [])).available,
      ).toBe(true);
    });
  }

  it("pack reason lists other missing files; weights-only stays a model reason", () => {
    const spec = getActionTool("breakdown")!;
    const both = ["node:CJCutouts", "checkpoints/sam3.safetensors"];
    expect(nodePackReason(spec, both)).toContain(
      "Also missing: sam3.safetensors.",
    );
    const weights = actionAvailability(
      spec,
      PACKS,
      null,
      status("breakdown", ["checkpoints/sam3.safetensors"]),
    );
    expect(weights.available).toBe(false);
    expect(weights.reason).not.toContain("pack isn't installed");
    expect(nodePackReason(spec, ["node:SomethingElse"])).toBeNull();
    expect(nodePackReason(getActionTool("layers")!, both)).toBeNull();
  });

  it("layers: core nodes only, weights checked through model-status", () => {
    const spec = getActionTool("layers")!;
    expect(spec.modelCheck).toEqual({ pack: "qwen-layered", action: "layers" });
    expect(spec.requireStatusEntry).toBe(true);
    expect(spec.nodePack).toBeUndefined();
    const av = actionAvailability(
      spec,
      PACKS,
      null,
      status("layers", ["diffusion_models/qwen_image_layered.safetensors"]),
    );
    expect(av.available).toBe(false);
    expect(setupHint(av.reason)).toMatch(/^Needs /);
  });

  it("offline fallback reports the pack nodes when custom_nodes lacks the pack", async () => {
    const deps = (dirs: string[]) => ({
      diskMissing: async () => [] as string[],
      objectInfo: async () => null,
      customNodeDirs: async () => dirs,
    });
    for (const [id, pack] of Object.entries(PACKED)) {
      const spec = getActionTool(id)!;
      const wf = graph(spec.modelCheck!.pack, spec.modelCheck!.action);
      expect(await missingOnDefaultBackend(wf, deps([]))).toEqual(
        pack.nodes.map((n) => `node:${n}`),
      );
      expect(await missingOnDefaultBackend(wf, deps([pack.id]))).toEqual([]);
    }
  });

  it.skipIf(!LIVE)(
    "live /object_info: pack nodes come from those packs",
    () => {
      for (const pack of Object.values(PACKED))
        for (const node of pack.nodes)
          expect(LIVE![node]?.python_module).toBe(`custom_nodes.${pack.id}`);
      const layers = graph("qwen-layered", "layers");
      for (const node of classes(layers)) {
        const mod = LIVE![node]?.python_module ?? "";
        expect(mod.startsWith("custom_nodes."), `${node} ${mod}`).toBe(false);
      }
    },
  );
});
