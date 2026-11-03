/**
 * Mask plumbing for /api/jobs/action (krea2-edit `edit_inpaint`): mask-slot
 * detection, mask normalization, engine wiring of the real CropAndStitch
 * graph, and the route (400 without a mask, upload + wire with one). Nothing
 * reaches ComfyUI: queuePrompt / uploadImageToComfy are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as realFs from "fs";
import * as path from "path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import {
  applyActionMask,
  checkActionMask,
  findMaskSlotIds,
  normalizeActionMask,
  parseActionMask,
  rgbaToBinaryMask,
} from "@/lib/comfy/actionMask";
import { buildActionWorkflow } from "@/lib/oj/engine";
import { resolveWorkflow } from "@/lib/oj/packs";
import { stripWorkflowMetaKeys } from "@/lib/comfy/workflowMeta";

const { fsAccessSpy } = vi.hoisted(() => ({ fsAccessSpy: vi.fn() }));
vi.mock("fs/promises", () => ({
  default: { access: fsAccessSpy, readFile: vi.fn(), mkdir: vi.fn() },
  access: fsAccessSpy,
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
  uploadImageToComfy: vi.fn(),
  extractImageUrls: vi.fn(() => []),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));
vi.mock("@/lib/comfy/workflows", () => ({
  loadWorkflowFromSelection: vi.fn(),
}));
vi.mock("@/lib/comfy/runs", () => ({
  getActiveRun: vi.fn(),
  addActiveRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  insertPrompt: vi.fn(),
  insertRun: vi.fn(),
  insertJob: vi.fn(),
}));

import { queuePrompt, uploadImageToComfy } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { getActiveRun } from "@/lib/comfy/runs";

type G = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title?: string };
  }
>;

const WF_DIR = path.join(process.cwd(), "public/workflows");
const INPAINT = "packs/krea2-edit/edit_inpaint.json";
const load = (rel: string): G =>
  stripWorkflowMetaKeys(
    JSON.parse(realFs.readFileSync(path.join(WF_DIR, rel), "utf-8")) as G,
  );

function imageRun(params: Record<string, unknown> = {}): ImagineRun {
  return {
    run_id: "seed-img",
    prompt: "a red car",
    parsedPrompt: "a red car",
    width: 1344,
    height: 768,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 3,
        index: 0,
        status: "done",
        progress: 100,
        images: [
          "http://127.0.0.1:8188/view?filename=src.png&subfolder=&type=output",
        ],
      },
    ],
    params,
  } as ImagineRun;
}

/** Red strokes on a transparent canvas (editor paint layer convention). */
async function editorMaskPng(paint: boolean): Promise<string> {
  const w = 16;
  const h = 12;
  const rgba = Buffer.alloc(w * h * 4);
  if (paint) {
    for (let y = 2; y < 6; y++) {
      for (let x = 3; x < 9; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 255;
        rgba[i + 3] = 255;
      }
    }
  }
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

describe("findMaskSlotIds / checkActionMask", () => {
  it("finds the LoadImageMask of the krea2-edit inpaint graph only", () => {
    expect(findMaskSlotIds(load(INPAINT) as unknown as Workflow)).toEqual([
      "6",
    ]);
  });

  it("treats a LoadImage titled as a mask as a mask slot", () => {
    const wf = {
      "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
      "2": {
        class_type: "LoadImage",
        inputs: { image: "m.png" },
        _meta: { title: "Inpaint Mask" },
      },
    } as unknown as Workflow;
    expect(findMaskSlotIds(wf)).toEqual(["2"]);
  });

  it("ignores non-loader nodes titled mask (bg_remove)", () => {
    expect(
      findMaskSlotIds(
        load("packs/utility/bg_remove.json") as unknown as Workflow,
      ),
    ).toEqual([]);
  });

  it("requires a mask for mask graphs and rejects one for others", () => {
    const inpaint = load(INPAINT) as unknown as Workflow;
    expect(() => checkActionMask(inpaint, undefined)).toThrow(/needs a mask/);
    expect(checkActionMask(inpaint, "m.png [input]")).toEqual(["6"]);
    const plain = { "1": { class_type: "LoadImage", inputs: {} } } as Workflow;
    expect(checkActionMask(plain, undefined)).toEqual([]);
    expect(() => checkActionMask(plain, "m.png [input]")).toThrow(
      /no mask input/,
    );
  });
});

describe("mask parsing / normalization", () => {
  it("parses data URLs and annotated refs, rejects anything else", () => {
    expect(parseActionMask("cj/m.png [input]")).toEqual({
      kind: "ref",
      ref: "cj/m.png [input]",
    });
    expect(parseActionMask("data:image/png;base64,AAAA").kind).toBe("data");
    expect(() => parseActionMask("../etc/passwd [input]")).toThrow();
    expect(() => parseActionMask("http://x/y.png")).toThrow();
    expect(() => parseActionMask(42)).toThrow();
  });

  it("binarizes both painter conventions (red-on-alpha, white-on-black)", () => {
    const px = (r: number, g: number, b: number, a: number) => [r, g, b, a];
    const rgba = Uint8Array.from([
      ...px(255, 0, 0, 255), // editor red stroke
      ...px(255, 255, 255, 255), // MaskPainter white
      ...px(0, 0, 0, 255), // opaque black
      ...px(0, 0, 0, 0), // transparent
      ...px(255, 0, 0, 40), // faint antialias edge
    ]);
    const { rgb, painted } = rgbaToBinaryMask(rgba);
    expect(painted).toBe(2);
    expect(Array.from(rgb)).toEqual([
      255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("normalizes an editor mask to a white-on-black PNG; empty -> error", async () => {
    const url = await editorMaskPng(true);
    const parsed = parseActionMask(url);
    if (parsed.kind !== "data") throw new Error("expected data");
    const out = await normalizeActionMask(parsed.bytes);
    expect([out.width, out.height]).toEqual([16, 12]);
    const { data, info } = await sharp(out.png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) =>
      data[(y * info.width + x) * info.channels];
    expect(at(4, 3)).toBe(255);
    expect(at(0, 0)).toBe(0);

    const empty = parseActionMask(await editorMaskPng(false));
    if (empty.kind !== "data") throw new Error("expected data");
    await expect(normalizeActionMask(empty.bytes)).rejects.toThrow(/empty/);
  });

  it("applyActionMask wires the ref and grow/feather px (clamped)", () => {
    const wf = load(INPAINT) as unknown as Workflow;
    applyActionMask(wf, ["6"], "cj/m.png [input]", {
      maskExpand: 24.4,
      maskBlend: 9999,
    });
    expect(wf["6"].inputs).toMatchObject({
      image: "cj/m.png [input]",
      channel: "red",
    });
    expect(wf["7"].inputs).toMatchObject({
      mask_expand_pixels: 24,
      mask_blend_pixels: 256,
    });
  });
});

describe("edit_inpaint resolution + engine", () => {
  it("resolves to the CropAndStitch graph with and without the pack id", () => {
    for (const packId of [undefined, "krea2-edit"]) {
      expect(
        resolveWorkflow({ templateOrAction: "edit_inpaint", packId })
          .workflowPath,
      ).toBe(INPAINT);
    }
  });

  it("keeps the inpaint LoRA, locks the latent to the crop target, injects source", () => {
    const run = imageRun({ ar: "16:9", lora: "someone_else.safetensors" });
    const { workflow } = buildActionWorkflow(
      load(INPAINT) as unknown as Workflow,
      "edit_inpaint",
      run,
      0,
      { prompt: "make the car matte black" },
    );
    const g = workflow as unknown as G;
    expect(g["2"].inputs.lora_name).toBe(
      "edit_tools/krea2_inpaint_edit_v2_17500.safetensors",
    );
    expect(g["13"].inputs).toMatchObject({ width: 1024, height: 1024 });
    expect(g["5"].inputs.image).toBe("src.png [output]");
    expect(g["6"].inputs.image).toBe("mask.png"); // route owns the mask
    expect(g["10"].inputs.prompt).toBe("make the car matte black");
    // masked area is blacked out before the Ostris encoder sees it
    expect(g["10"].inputs.image1).toEqual(["8", 0]);
    expect(g["8"].inputs.mask).toEqual(["7", 2]);
    expect(g["14"].inputs.model).toEqual(["9", 0]);
  });
});

describe("POST /api/jobs/action — mask graphs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsAccessSpy.mockResolvedValue(undefined);
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
    vi.mocked(uploadImageToComfy).mockResolvedValue("cj_mask_up.png [input]");
    vi.mocked(getActiveRun).mockReturnValue(imageRun());
  });

  const req = (body: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "cid",
        run_id: "seed-img",
        job_index: 0,
        ...body,
      }),
    });

  it("400 mask_required for edit_inpaint without a mask; nothing uploaded or queued", async () => {
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load(INPAINT) as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({ action: "edit_inpaint", params: { prompt: "x" } }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.code).toBe("mask_required");
    expect(json.error).toMatch(/mask/i);
    expect(uploadImageToComfy).not.toHaveBeenCalled();
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("uploads a data-URL mask (binarized) and wires it + grow px into the graph", async () => {
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load(INPAINT) as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const mask = await editorMaskPng(true);
    const res = await POST(
      req({
        action: "edit_inpaint",
        params: { prompt: "a blue door", maskExpand: 16 },
        mask,
      }),
    );
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/krea2-edit\/edit_inpaint\.json$/,
    );
    expect(uploadImageToComfy).toHaveBeenCalledTimes(1);
    const [bytes, name] = vi.mocked(uploadImageToComfy).mock.calls[0];
    expect(name).toMatch(/_mask\.png$/);
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect([meta.width, meta.height, meta.channels]).toEqual([16, 12, 3]);

    const q = vi.mocked(queuePrompt).mock.calls[0][0] as unknown as G;
    expect(q["6"].inputs.image).toBe("cj_mask_up.png [input]");
    expect(q["5"].inputs.image).toBe("src.png [output]");
    expect(q["7"].inputs.mask_expand_pixels).toBe(16);
    expect(q["10"].inputs.prompt).toBe("a blue door");
    // Turbo sampler recipe from the LoRA card; source-run steps/cfg must not leak in
    // (raw + cfg>1 renders the masked fill as speckle noise).
    expect(q["1"].inputs.unet_name).toBe("krea2_turbo_bf16.safetensors");
    expect(q["14"].inputs).toMatchObject({ steps: 8, cfg: 1, sampler_name: "euler_ancestral" });
    // The mask never lands in persisted run params.
    expect(JSON.stringify(json.run.params)).not.toContain("base64");
  });

  it("keeps the turbo 8-step / cfg 1 recipe when the source run carried its own steps/cfg", async () => {
    vi.mocked(getActiveRun).mockReturnValue(imageRun({ steps: 28, cfg: 4 }));
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load(INPAINT) as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "edit_inpaint",
        params: { prompt: "a blue door" },
        mask: await editorMaskPng(true),
      }),
    );
    expect(res.status).toBe(200);
    const q = vi.mocked(queuePrompt).mock.calls[0][0] as unknown as G;
    expect(q["14"].inputs).toMatchObject({ steps: 8, cfg: 1 });
  });

  it("passes an annotated ref (mask_data alias) through without uploading", async () => {
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load(INPAINT) as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "edit_inpaint",
        params: { prompt: "x" },
        mask_data: "cj/painted.png [input]",
      }),
    );
    expect(res.status).toBe(200);
    expect(uploadImageToComfy).not.toHaveBeenCalled();
    const q = vi.mocked(queuePrompt).mock.calls[0][0] as unknown as G;
    expect(q["6"].inputs.image).toBe("cj/painted.png [input]");
  });

  it("400 invalid_mask for an empty painted mask", async () => {
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load(INPAINT) as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "edit_inpaint",
        params: { prompt: "x" },
        mask: await editorMaskPng(false),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).details.code).toBe("invalid_mask");
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("honors a top-level pack_id when resolving the graph (EnhanceOptions shape)", async () => {
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load("packs/krea2-edit/edit_v2.json") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "edit_instruct",
        pack_id: "krea2-edit",
        params: { prompt: "make it night" },
      }),
    );
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/krea2-edit\/edit_v2\.json$/,
    );
  });

  it("400 mask_unsupported when a mask is sent to a mask-less graph", async () => {
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load("packs/krea2-edit/edit_v2.json") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        action: "edit_instruct",
        params: { prompt: "x" },
        mask: "cj/m.png [input]",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).details.code).toBe("mask_unsupported");
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});
