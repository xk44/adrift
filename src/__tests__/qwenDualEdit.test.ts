/**
 * Qwen-Image-Edit 2511 two-image edit (edit_instruct_dual on the
 * qwen-image-edit pack): graph wiring, pack resolution (krea2-edit unchanged),
 * engine injection of both references, and the action route. Nothing is
 * queued for real — queuePrompt is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as realFs from "fs";
import * as path from "path";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import { resolveWorkflow } from "@/lib/oj/packs";
import { buildActionWorkflow } from "@/lib/oj/engine";
import { discoverT2ISlots } from "@/lib/oj/discovery";

const fsAccessSpy = vi.fn();
vi.mock("fs/promises", () => ({
  default: { access: fsAccessSpy, readFile: vi.fn(), mkdir: vi.fn() },
  access: fsAccessSpy,
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
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

import { queuePrompt } from "@/lib/comfy/http";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { getActiveRun } from "@/lib/comfy/runs";

type G = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

const DUAL = "packs/qwen-image-edit/edit_dual.json";
const SINGLE = "packs/qwen-image-edit/edit.json";
const WF_DIR = path.join(process.cwd(), "public/workflows");
const load = (rel: string): G =>
  JSON.parse(realFs.readFileSync(path.join(WF_DIR, rel), "utf-8"));

function danglingRefs(graph: G): string[] {
  const ids = new Set(Object.keys(graph));
  const bad: string[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const val of Object.values(node.inputs ?? {})) {
      if (Array.isArray(val) && typeof val[0] === "string" && !ids.has(val[0]))
        bad.push(`${nodeId} -> ${val[0]}`);
    }
  }
  return bad;
}

function imageRun(): ImagineRun {
  return {
    run_id: "seed-img",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 3,
        index: 0,
        status: "done",
        progress: 100,
        images: [
          "http://127.0.0.1:8188/view?filename=src.png&subfolder=&type=input",
        ],
      },
    ],
    params: { seed_upload: true },
  } as ImagineRun;
}

const PROMPT =
  "Replace the person in image 1 with the person from image 2. Keep their face.";

describe("qwen-image-edit edit_dual.json graph", () => {
  const g = load(DUAL);

  it("has no dangling refs and only the single-image graph's node classes", () => {
    expect(danglingRefs(g)).toEqual([]);
    const single = new Set(
      Object.values(load(SINGLE)).map((n) => n.class_type),
    );
    for (const n of Object.values(g))
      expect(single.has(n.class_type)).toBe(true);
  });

  it("feeds both references to the positive encoder, negative stays empty", () => {
    const loads = Object.entries(g).filter(
      ([, n]) => n.class_type === "LoadImage",
    );
    expect(loads.map(([id]) => id)).toEqual(["6", "14"]);
    expect(g["8"].class_type).toBe("TextEncodeQwenImageEditPlus");
    expect(g["8"].inputs.image1).toEqual(["6", 0]);
    expect(g["8"].inputs.image2).toEqual(["14", 0]);
    expect(g["8"].inputs.image3).toBeUndefined();
    expect(g["9"].inputs).not.toHaveProperty("image1");
    expect(g["9"].inputs).not.toHaveProperty("image2");
    expect(g["11"].inputs).toMatchObject({
      positive: ["8", 0],
      negative: ["9", 0],
      steps: 4,
      cfg: 2,
    });
  });

  it("keeps the pipeline LoRAs; the multi-angle edit LoRA is off by default", () => {
    const single = load(SINGLE);
    expect(g["3"].inputs).toEqual(single["3"].inputs); // Lightning 4-step
    expect(g["30"].inputs).toEqual(single["30"].inputs); // --lora stack slot
    expect(g["2"].inputs.lora_name).toBe(single["2"].inputs.lora_name);
    expect(g["2"].inputs.strength_model).toBe(0);
  });
});

describe("edit_instruct_dual resolution", () => {
  it("qwen-image-edit pack resolves to its own dual graph", () => {
    expect(
      resolveWorkflow({
        templateOrAction: "edit_instruct_dual",
        packId: "qwen-image-edit",
      }).workflowPath,
    ).toBe(DUAL);
  });
  it("krea2-edit dual + qwen single-image routes are unchanged", () => {
    expect(
      resolveWorkflow({
        templateOrAction: "edit_instruct_dual",
        packId: "krea2-edit",
      }).workflowPath,
    ).toBe("packs/krea2-edit/edit_v2_dual.json");
    expect(
      resolveWorkflow({
        templateOrAction: "edit_qwen",
        packId: "qwen-image-edit",
      }).workflowPath,
    ).toBe(SINGLE);
  });
});

describe("buildActionWorkflow on the qwen dual graph", () => {
  it("source → node 6, secondRefImage → node 14, instruction → node 8", () => {
    const { workflow, slots } = buildActionWorkflow(
      load(DUAL) as unknown as Workflow,
      "edit_instruct_dual",
      imageRun(),
      0,
      { prompt: PROMPT, secondRefImage: " cj/person.png [input] " },
    );
    const w = workflow as unknown as G;
    expect((slots as { imageInputId?: string }).imageInputId).toBe("6");
    expect(w["6"].inputs.image).toBe("src.png [input]");
    expect(w["14"].inputs.image).toBe("cj/person.png [input]");
    expect(slots.posTextId).toBe("8");
    expect(w["8"].inputs.prompt).toBe(PROMPT);
    expect(w["9"].inputs.prompt).toBe("");
    expect(slots.loraLoaderIds).toEqual(["30"]);
    // discovery still sees the empty-negative encoder as the negative slot
    expect(discoverT2ISlots(load(DUAL) as unknown as Workflow).negTextId).toBe(
      "9",
    );
  });
});

describe("POST /api/jobs/action — edit_instruct_dual on qwen-image-edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsAccessSpy.mockResolvedValue(undefined);
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
  });

  const req = (body: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", ...body }),
    });

  it("queues the qwen dual graph with both refs and the dropdown LoRA override", async () => {
    vi.mocked(getActiveRun).mockReturnValue(imageRun());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(load(DUAL) as never);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "seed-img",
        job_index: 0,
        action: "edit_instruct_dual",
        params: {
          pack_id: "qwen-image-edit",
          prompt: PROMPT,
          secondRefImage: "cj/person.png [input]",
        },
        workflow_control_overrides: {
          "2.lora_name": "my-qwen-edit.safetensors",
          "2.strength_model": 0.8,
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/qwen-image-edit\/edit_dual\.json$/,
    );
    expect(queuePrompt).toHaveBeenCalledTimes(1);
    const q = vi.mocked(queuePrompt).mock.calls[0][0] as unknown as G;
    expect(q["6"].inputs.image).toBe("src.png [input]");
    expect(q["14"].inputs.image).toBe("cj/person.png [input]");
    expect(q["8"].inputs.prompt).toBe(PROMPT);
    expect(q["2"].inputs).toMatchObject({
      lora_name: "my-qwen-edit.safetensors",
      strength_model: 0.8,
    });
    expect(q["3"].inputs.lora_name).toBe(
      "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
    );
  });

  it("krea2-edit dual still loads the krea2 graph", async () => {
    vi.mocked(getActiveRun).mockReturnValue(imageRun());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load("packs/krea2-edit/edit_v2_dual.json") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "seed-img",
        job_index: 0,
        action: "edit_instruct_dual",
        params: {
          pack_id: "krea2-edit",
          prompt: PROMPT,
          secondRefImage: "cj/p.png [input]",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/krea2-edit\/edit_v2_dual\.json$/,
    );
  });
});
