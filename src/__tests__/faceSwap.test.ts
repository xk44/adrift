/**
 * H3 face swap: graph recipe, builder, action-route dispatch, the model-file
 * presence check, and the Tools-tab video path (availability + submission).
 */
import { H3_TURBO_FL2V_8 } from "@/lib/oj/h3Speed";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import {
  FACE_SWAP_LORA,
  FACE_SWAP_PROMPT,
  buildFaceSwapWorkflow,
} from "@/lib/oj/faceSwap";
import { resolveWorkflow } from "@/lib/oj/packs";
import {
  missingWorkflowModels,
  workflowModelRequirements,
} from "@/lib/tools/modelStatus";
import {
  ACTION_TOOLS,
  ToolInputError,
  actionAvailability,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { submitVideoTool, videoUploadName } from "@/lib/tools/runTool";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(require("path").join(require("os").tmpdir(), "cj-fs-")) as string;
});
vi.mock("@/lib/env", () => ({ env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" } }));
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("fs/promises", async (orig) => {
  const real = await orig<typeof import("fs/promises")>();
  return { ...real, default: real };
});
vi.mock("@/lib/comfy/http", () => ({
  queuePrompt: vi.fn(),
  fetchHistory: vi.fn(),
  extractImageUrls: vi.fn(() => []),
  ComfyAPIError: class ComfyAPIError extends Error {},
}));
vi.mock("@/lib/comfy/workflows", () => ({ loadWorkflowFromSelection: vi.fn() }));
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

const GRAPH = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows/packs/minimax/face_swap.json"),
      "utf-8",
    ),
  );
const VIDEO_URL =
  "http://127.0.0.1:8188/view?filename=clip.mp4&subfolder=cj&type=input";

function videoRun(): ImagineRun {
  return {
    run_id: "seed-video",
    prompt: "",
    parsedPrompt: "",
    width: 1280,
    height: 720,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      { seed: 0, index: 0, status: "done", progress: 100, images: [], videos: [VIDEO_URL] },
    ],
    params: { seed_upload: true, video_seconds: 6 },
  } as ImagineRun;
}
const byClass = (wf: Workflow, cls: string) =>
  Object.values(wf).find((n) => n.class_type === cls)!.inputs as Record<
    string,
    unknown
  >;

describe("face_swap.json graph", () => {
  const wf = GRAPH();
  it("chains accel LoRA then FaceSwap at strength 1, trigger prompt only", () => {
    const loras = Object.values(wf)
      .filter((n) => n.class_type === "LoraLoaderModelOnly")
      .map((n) => [n.inputs.lora_name, n.inputs.strength_model]);
    expect(loras).toEqual([
      [H3_TURBO_FL2V_8, 1],
      [FACE_SWAP_LORA, 1],
    ]);
    expect(FACE_SWAP_LORA).toBe("FaceSwap_H3_REF2VA.safetensors");
    const h3 = byClass(wf, "MiniMaxH3ReferenceToVideo");
    expect(h3.prompt).toBe("Faceswap");
    expect(h3["ref_images.ref_image_0"]).toEqual(["15", 0]);
    expect(h3["ref_videos.ref_video_0"]).toEqual(["19", 0]);
    expect(byClass(wf, "BasicGuider").model).toEqual(["20", 0]);
    expect(byClass(wf, "MiniMaxH3SigmaShift")).toMatchObject({
      model: ["17", 0],
      shift_video: 12,
      shift_audio: 3,
    });
    expect(byClass(wf, "CreateVideo").fps).toBe(24);
    expect(byClass(wf, "SaveVideo").filename_prefix).toMatch(/FaceSwap/);
  });
});

describe("buildFaceSwapWorkflow", () => {
  it("wires clip + face, forces the trigger prompt, snaps length to n%17==5", () => {
    const base = GRAPH();
    const { workflow, seed } = buildFaceSwapWorkflow(base, videoRun(), 0, {
      secondRefImage: "cj/face.png [input]",
      prompt: "ignored free text <Video 1>",
      seed: 9,
    });
    expect(byClass(workflow, "LoadVideo").file).toBe("cj/clip.mp4 [input]");
    expect(byClass(workflow, "LoadImage").image).toBe("cj/face.png [input]");
    const h3 = byClass(workflow, "MiniMaxH3ReferenceToVideo");
    expect(h3).toMatchObject({
      prompt: FACE_SWAP_PROMPT,
      width: 864,
      height: 480,
      length: 141,
    });
    expect((h3.length as number) % 17).toBe(5);
    expect(seed).toBe(9);
    expect(byClass(workflow, "RandomNoise").noise_seed).toBe(9);
    expect(byClass(base, "LoadVideo").file).toBe("");
  });

  it("refuses a missing clip or a non-input face reference", () => {
    const noVideo = videoRun();
    noVideo.jobs[0].videos = [];
    expect(() =>
      buildFaceSwapWorkflow(GRAPH(), noVideo, 0, {
        secondRefImage: "f.png [input]",
      }),
    ).toThrow(/face_swap: source run has no video/);
    for (const bad of [undefined, "", "f.png [output]", "../f.png [input]"]) {
      expect(() =>
        buildFaceSwapWorkflow(GRAPH(), videoRun(), 0, { secondRefImage: bad }),
      ).toThrow(/secondRefImage/);
    }
  });
});

describe("registry + action route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
  });
  const req = (body: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", ...body }),
    });

  it("resolves to the minimax pack graph", () => {
    const r = resolveWorkflow({
      templateOrAction: "face_swap",
      packId: "minimax",
    });
    expect(r.workflowPath).toMatch(/packs\/minimax\/face_swap\.json$/);
  });

  it("queues the face-swap graph against the seeded clip", async () => {
    vi.mocked(getActiveRun).mockReturnValue(videoRun());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(GRAPH() as never);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "seed-video",
        job_index: 0,
        action: "face_swap",
        params: { pack_id: "minimax", secondRefImage: "cj/face.png [input]" },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/minimax\/face_swap\.json$/,
    );
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(byClass(queued, "LoadImage").image).toBe("cj/face.png [input]");
    expect(byClass(queued, "MiniMaxH3ReferenceToVideo").prompt).toBe("Faceswap");
    expect(byClass(queued, "BasicScheduler")).toMatchObject({ steps: 8 });
  });

  it("409s on an image-only source run", async () => {
    const run = videoRun();
    run.jobs[0].videos = undefined;
    run.jobs[0].images = ["http://127.0.0.1:8188/view?filename=a.png&type=output"];
    vi.mocked(getActiveRun).mockReturnValue(run);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "r",
        job_index: 0,
        action: "face_swap",
        params: { pack_id: "minimax" },
      }),
    );
    expect(res.status).toBe(409);
    expect(queuePrompt).not.toHaveBeenCalled();
  });
});

describe("model presence check", () => {
  it("lists loader weights from a graph", () => {
    const reqs = workflowModelRequirements(GRAPH()).map((r) => r.file);
    expect(reqs).toContain(FACE_SWAP_LORA);
    expect(reqs).toContain("minimax_h3_ref2va_pruned_int8_convrot.safetensors");
  });

  it("reports absent files, then none once they exist (any of the loader's folders)", async () => {
    const wf = GRAPH();
    const missing = await missingWorkflowModels(wf, tmpRoot);
    expect(missing).toContain(`loras/${FACE_SWAP_LORA}`);
    expect(missing).toContain("diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors");

    const put = (dir: string, file: string) => {
      const p = path.join(tmpRoot, "models", dir, file);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    };
    for (const r of workflowModelRequirements(wf)) {
      // any of the loader's folders counts (last = e.g. models/unet)
      put(r.dirs[r.dirs.length - 1], r.file);
    }
    expect(await missingWorkflowModels(wf, tmpRoot)).toEqual([]);
    fs.rmSync(path.join(tmpRoot, "models"), { recursive: true, force: true });
  });

  it("GET /api/tools/model-status flags face_swap while the LoRA is absent", async () => {
    const { GET } = await import("@/app/api/tools/model-status/route");
    const res = await GET(new NextRequest("http://localhost/api/tools/model-status"));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tools.face_swap.missing).toContain(`loras/${FACE_SWAP_LORA}`);
  });
});

describe("Tools tab: face swap card", () => {
  const spec = getActionTool("face_swap")!;
  const packs = new Set(["minimax"]);

  it("is a registered video-in action tool", () => {
    expect(ACTION_TOOLS.map((t) => t.id)).toContain("face_swap");
    expect(spec.videoInput).toBeTruthy();
    expect(spec.modelCheck).toEqual({ pack: "minimax", action: "face_swap" });
  });

  it("shows a model-not-installed state, then enables when files are present", () => {
    expect(actionAvailability(spec, packs, null, null)).toMatchObject({
      available: false,
      checking: true,
    });
    const missing = actionAvailability(spec, packs, null, {
      tools: { face_swap: { missing: [`loras/${FACE_SWAP_LORA}`] } },
    });
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/Model not installed: FaceSwap_H3_REF2VA\.safetensors/);
    expect(
      actionAvailability(spec, packs, null, { tools: { face_swap: { missing: [] } } })
        .available,
    ).toBe(true);
    const failed = actionAvailability(spec, packs, null, { tools: {}, failed: true });
    expect(failed).toMatchObject({ available: false, checking: false });
    expect(
      actionAvailability(spec, new Set(), null, { tools: {} }).reason,
    ).toMatch(/minimax pack/);
  });

  it("buildToolCards carries the state to the card", () => {
    const cards = buildToolCards({
      catalog: [],
      packIds: packs,
      editLoras: null,
      modelStatus: { tools: { face_swap: { missing: ["loras/x.safetensors"] } } },
    });
    const card = cards.find((c) => c.key === "action:face_swap")!;
    expect(card.available).toBe(false);
    expect(card.unavailableReason).toMatch(/Model not installed/);
  });

  it("builds the action request: face required, no prompt knob", () => {
    expect(() =>
      buildActionRequest(spec, defaultSettings(spec), null),
    ).toThrow(ToolInputError);
    expect(
      buildActionRequest(spec, defaultSettings(spec), null, "cj/f.png [input]"),
    ).toEqual({
      action: "face_swap",
      params: { pack_id: "minimax", secondRefImage: "cj/f.png [input]" },
      overrides: {},
    });
  });
});

describe("submitVideoTool", () => {
  const spec = getActionTool("face_swap")!;
  const video = {
    id: "v",
    previewUrl: "blob:x",
    dataUrl: "data:video/mp4;base64,AAAA",
    label: "My Clip.MOV",
    duration: 5.5,
    width: 1920,
    height: 1080,
  };
  const face = {
    id: "f",
    source: "upload" as const,
    previewUrl: "data:image/png;base64,AA",
    dataUrl: "data:image/png;base64,AA",
    label: "f.png",
    width: 512,
    height: 512,
  };

  it("uploads face + clip, seeds the clip with its duration, queues face_swap", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      const json =
        url === "/api/comfy/upload"
          ? { ok: true, ref: `cj/${body.filename} [input]` }
          : url === "/api/jobs/seed-run"
            ? { ok: true, run: { run_id: "R", jobs: [{ index: 0 }] } }
            : { ok: true, run: { run_id: "NEW", jobs: [] } };
      return { ok: true, status: 200, json: async () => json };
    });
    const run = await submitVideoTool({
      fetchImpl,
      spec,
      settings: defaultSettings(spec),
      video,
      face,
      clientId: "cid",
    });
    expect(run.run_id).toBe("NEW");
    const [upFace, upVideo, seed, action] = calls;
    expect(upFace.body.filename).toMatch(/^cj_face_.*\.png$/);
    expect(upVideo.body.filename).toMatch(/^cj_clip_.*\.mov$/);
    expect(seed.body).toMatchObject({
      ref: `cj/${upVideo.body.filename} [input]`,
      width: 1920,
      height: 1080,
      duration: 5.5,
    });
    expect(action.url).toBe("/api/jobs/action");
    expect(action.body).toMatchObject({
      run_id: "R",
      action: "face_swap",
      params: {
        pack_id: "minimax",
        secondRefImage: `cj/${upFace.body.filename} [input]`,
      },
    });
  });

  it("validates inputs before uploading anything", async () => {
    const fetchImpl = vi.fn();
    await expect(
      submitVideoTool({ fetchImpl, spec, settings: defaultSettings(spec), video: null, face, clientId: "c" }),
    ).rejects.toThrow(/source video/);
    await expect(
      submitVideoTool({ fetchImpl, spec, settings: defaultSettings(spec), video, face: null, clientId: "c" }),
    ).rejects.toThrow(/face photo/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a loadable video extension", () => {
    expect(videoUploadName("a.webm")).toMatch(/\.webm$/);
    expect(videoUploadName("noext")).toMatch(/\.mp4$/);
    expect(videoUploadName("x.avi")).toMatch(/\.mp4$/);
  });
});
