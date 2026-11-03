/**
 * Replace-person-in-video (MiniMax H3 + character-swap LoRA) + the dual-image
 * edit action: pure builders, registry/pack resolution, the action route, and
 * the video legs of seed-run / upload.
 */
import { H3_TURBO_FL2V_8 } from "@/lib/oj/h3Speed";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as realFs from "fs";
import * as path from "path";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import {
  CHARACTER_SWAP_LORA,
  CHARACTER_SWAP_PROMPT,
  buildCharacterSwapWorkflow,
  characterSwapDims,
  characterSwapLength,
  characterSwapPrompt,
} from "@/lib/oj/characterSwap";
import { resolveWorkflow } from "@/lib/oj/packs";
import {
  isVideoFilename,
  parseInputRef,
  parseSeedDuration,
} from "@/lib/seedRun";
import { safeUploadName, uploadMimeType } from "@/lib/comfy/uploadName";

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

const WF_DIR = path.join(process.cwd(), "public/workflows");
function loadPackGraph(rel: string): Workflow {
  return JSON.parse(realFs.readFileSync(path.join(WF_DIR, rel), "utf-8"));
}
const SWAP_GRAPH = () => loadPackGraph("packs/minimax/character_swap.json");

const VIDEO_URL =
  "http://127.0.0.1:8188/view?filename=clip.mp4&subfolder=cj&type=input";

function videoRun(extra: Partial<ImagineRun> = {}): ImagineRun {
  return {
    run_id: "seed-video",
    prompt: "",
    parsedPrompt: "",
    width: 1280,
    height: 720,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: [],
        videos: [VIDEO_URL],
      },
    ],
    params: { seed_upload: true, video_seconds: 6 },
    ...extra,
  } as ImagineRun;
}

function byClass(wf: Workflow, cls: string) {
  const hit = Object.values(wf).find((n) => n.class_type === cls);
  if (!hit) throw new Error(`no ${cls}`);
  return hit.inputs as Record<string, unknown>;
}

describe("character swap pure helpers", () => {
  it("prompt keeps the HF-card template and swaps in a target", () => {
    expect(characterSwapPrompt()).toBe(CHARACTER_SWAP_PROMPT);
    expect(characterSwapPrompt("   ")).toBe(CHARACTER_SWAP_PROMPT);
    const p = characterSwapPrompt("  the man in the  red jacket ");
    expect(
      p.startsWith(
        "Replace the man in the red jacket in <Video 1> with the character in <Picture 1>.",
      ),
    ).toBe(true);
    expect(p).toContain("Preserve the scene and the other people.");
  });

  it("length is 24 fps snapped down to n%17==5 and clamped", () => {
    expect(characterSwapLength()).toBe(124);
    expect(characterSwapLength(NaN)).toBe(124);
    expect(characterSwapLength(0)).toBe(124);
    expect(characterSwapLength(5.2)).toBe(124); // 125 → 124
    expect(characterSwapLength(6)).toBe(141); // 144 → 141
    expect(characterSwapLength(10)).toBe(226); // 240 → 226
    expect(characterSwapLength(60)).toBe(362);
    expect(characterSwapLength(0.3)).toBe(22);
    for (const s of [1, 2.5, 4, 7.7, 9.9, 15]) {
      expect(characterSwapLength(s) % 17).toBe(5);
      expect(characterSwapLength(s)).toBeLessThanOrEqual(
        Math.max(22, Math.round(s * 24)),
      );
    }
  });

  it("dims keep aspect at a 480 short edge on the 32 grid", () => {
    expect(characterSwapDims(1920, 1080)).toEqual({ width: 864, height: 480 });
    expect(characterSwapDims(720, 1280)).toEqual({ width: 480, height: 864 });
    expect(characterSwapDims(1000, 1000)).toEqual({ width: 480, height: 480 });
    expect(characterSwapDims(4000, 500)).toEqual({ width: 1024, height: 480 });
    expect(characterSwapDims()).toEqual({ width: 864, height: 480 });
  });
});

describe("character_swap.json graph", () => {
  const wf = SWAP_GRAPH();
  it("uses native nodes only, with the recipe settings", () => {
    const classes = Object.values(wf).map((n) => n.class_type);
    expect(classes).not.toContain("MiniMaxH3Relay");
    expect(classes.some((c) => /relay/i.test(c))).toBe(false);
    const loras = Object.values(wf)
      .filter((n) => n.class_type === "LoraLoaderModelOnly")
      .map((n) => [n.inputs.lora_name, n.inputs.strength_model]);
    expect(loras).toEqual([
      [H3_TURBO_FL2V_8, 1],
      [CHARACTER_SWAP_LORA, 1],
    ]);
    expect(byClass(wf, "KSamplerSelect").sampler_name).toBe("er_sde");
    expect(byClass(wf, "BasicScheduler")).toMatchObject({
      scheduler: "normal",
      steps: 8,
    });
    expect(byClass(wf, "CreateVideo").fps).toBe(24);
    // CFG 1 ≡ BasicGuider (no negative branch).
    expect(classes).toContain("BasicGuider");
    expect(classes).not.toContain("CFGGuider");
    const h3 = byClass(wf, "MiniMaxH3ReferenceToVideo");
    expect(h3.prompt).toBe(CHARACTER_SWAP_PROMPT);
    expect(h3["ref_videos.ref_video_0"]).toEqual(["19", 0]);
    expect(h3["ref_images.ref_image_0"]).toEqual(["15", 0]);
  });

  it("the sampler model runs through the swap LoRA", () => {
    expect(byClass(wf, "BasicGuider").model).toEqual(["20", 0]);
    expect(byClass(wf, "MiniMaxH3SigmaShift")).toMatchObject({
      model: ["17", 0],
      shift_video: 12,
      shift_audio: 3,
    });
    expect(byClass(wf, "BasicScheduler").model).toEqual(["20", 0]);
  });
});

describe("buildCharacterSwapWorkflow", () => {
  it("wires the seeded video + reference image and sizes the clip", () => {
    const base = SWAP_GRAPH();
    const { workflow, seed } = buildCharacterSwapWorkflow(base, videoRun(), 0, {
      secondRefImage: "cj/person.png [input]",
      target: "the woman on the left",
      seed: 7,
    });
    expect(byClass(workflow, "LoadVideo").file).toBe("cj/clip.mp4 [input]");
    expect(byClass(workflow, "LoadImage").image).toBe("cj/person.png [input]");
    const h3 = byClass(workflow, "MiniMaxH3ReferenceToVideo");
    expect(h3).toMatchObject({ width: 864, height: 480, length: 141 });
    expect(h3.prompt).toMatch(/^Replace the woman on the left in <Video 1>/);
    expect(seed).toBe(7);
    expect(byClass(workflow, "RandomNoise").noise_seed).toBe(7);
    // base untouched
    expect(byClass(base, "LoadVideo").file).toBe("");
  });

  it("explicit <Video 1> prompt wins; params seconds beat run seconds", () => {
    const { workflow, seed } = buildCharacterSwapWorkflow(
      SWAP_GRAPH(),
      videoRun(),
      0,
      {
        secondRefImage: "p.png [input]",
        prompt: "Swap the dancer in <Video 1> for <Picture 1>.",
        video_seconds: 10,
      },
    );
    const h3 = byClass(workflow, "MiniMaxH3ReferenceToVideo");
    expect(h3.prompt).toBe("Swap the dancer in <Video 1> for <Picture 1>.");
    expect(h3.length).toBe(226);
    expect(Number.isInteger(seed)).toBe(true);
  });

  it("refuses a missing video or a non-input / traversal reference", () => {
    const noVideo = videoRun();
    noVideo.jobs[0].videos = [];
    expect(() =>
      buildCharacterSwapWorkflow(SWAP_GRAPH(), noVideo, 0, {
        secondRefImage: "p.png [input]",
      }),
    ).toThrow(/no video/);
    for (const bad of [
      undefined,
      "",
      "p.png [output]",
      "../p.png [input]",
      "clip.mp4 [input]",
    ]) {
      expect(() =>
        buildCharacterSwapWorkflow(SWAP_GRAPH(), videoRun(), 0, {
          secondRefImage: bad,
        }),
      ).toThrow(/secondRefImage/);
    }
  });
});

describe("registry + pack resolution", () => {
  it("edit_instruct_dual resolves to the krea2-edit dual graph", () => {
    const r = resolveWorkflow({
      templateOrAction: "edit_instruct_dual",
      packId: "krea2-edit",
    });
    expect(r.workflowPath).toMatch(/packs\/krea2-edit\/edit_v2_dual\.json$/);
  });
  it("character_swap resolves to the minimax pack graph", () => {
    const r = resolveWorkflow({
      templateOrAction: "character_swap",
      packId: "minimax",
    });
    expect(r.workflowPath).toMatch(/packs\/minimax\/character_swap\.json$/);
  });
});

describe("POST /api/jobs/action — character_swap / edit_instruct_dual", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsAccessSpy.mockResolvedValue(undefined);
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
  });

  function req(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", ...body }),
    });
  }

  it("queues the swap graph against the seeded clip", async () => {
    vi.mocked(getActiveRun).mockReturnValue(videoRun());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      SWAP_GRAPH() as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "seed-video",
        job_index: 0,
        action: "character_swap",
        params: { pack_id: "minimax", secondRefImage: "cj/ref.png [input]" },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/minimax\/character_swap\.json$/,
    );
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(byClass(queued, "LoadVideo").file).toBe("cj/clip.mp4 [input]");
    expect(byClass(queued, "LoadImage").image).toBe("cj/ref.png [input]");
    // pack defaults (20 steps, res_multistep) must not leak into the recipe
    expect(byClass(queued, "BasicScheduler")).toMatchObject({ steps: 8, scheduler: "normal" });
    expect(byClass(queued, "KSamplerSelect").sampler_name).toBe("er_sde");
  });

  it("409s character_swap on an image-only run", async () => {
    const run = videoRun();
    run.jobs[0].videos = undefined;
    run.jobs[0].images = [
      "http://127.0.0.1:8188/view?filename=a.png&type=output",
    ];
    vi.mocked(getActiveRun).mockReturnValue(run);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "r",
        job_index: 0,
        action: "character_swap",
        params: { pack_id: "minimax" },
      }),
    );
    expect(res.status).toBe(409);
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("edit_instruct_dual no longer 400s (registry action exists)", async () => {
    const run = videoRun();
    run.jobs[0].images = [
      "http://127.0.0.1:8188/view?filename=src.png&subfolder=&type=input",
    ];
    vi.mocked(getActiveRun).mockReturnValue(run);
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      loadPackGraph("packs/krea2-edit/edit_v2_dual.json") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "r",
        job_index: 0,
        action: "edit_instruct_dual",
        params: {
          pack_id: "krea2-edit",
          prompt: "Replace the person in image 1 with the person from image 2.",
          secondRefImage: "cj/person.png [input]",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(loadWorkflowFromSelection).mock.calls[0][0]).toMatch(
      /packs\/krea2-edit\/edit_v2_dual\.json$/,
    );
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    const images = Object.values(queued)
      .filter((n) => n.class_type === "LoadImage")
      .map((n) => n.inputs.image);
    expect(images).toContain("src.png [input]");
    expect(images).toContain("cj/person.png [input]");
  });
});

describe("seed-run + upload video legs", () => {
  it("parseInputRef only takes videos when allowed", () => {
    expect(parseInputRef("cj/clip.mp4 [input]")).toBeNull();
    expect(parseInputRef("cj/clip.mp4 [input]", { allowVideo: true })).toEqual({
      filename: "clip.mp4",
      subfolder: "cj",
    });
    for (const ok of ["a.MOV", "a.m4v", "a.webm"]) {
      expect(
        parseInputRef(`${ok} [input]`, { allowVideo: true }),
      ).not.toBeNull();
    }
    expect(parseInputRef("a.avi [input]", { allowVideo: true })).toBeNull();
    expect(parseInputRef("../a.mp4 [input]", { allowVideo: true })).toBeNull();
    expect(isVideoFilename("x.mp4")).toBe(true);
    expect(isVideoFilename("x.png")).toBe(false);
  });

  it("parseSeedDuration bounds", () => {
    expect(parseSeedDuration(6.25)).toBe(6.25);
    expect(parseSeedDuration(0.1)).toBeNull();
    expect(parseSeedDuration(61)).toBeNull();
    expect(parseSeedDuration("6")).toBeNull();
    expect(parseSeedDuration(Infinity)).toBeNull();
  });

  it("upload names keep video extensions and MIME follows the extension", () => {
    expect(safeUploadName("clip.mp4")).toBe("clip.mp4");
    expect(safeUploadName("../../x/My Clip.MOV")).toBe("My_Clip.MOV");
    expect(safeUploadName("evil.sh")).toBe("cj_ref.png");
    expect(safeUploadName(`${"a".repeat(200)}.mp4`)).toMatch(/^a+\.mp4$/);
    expect(safeUploadName(`${"a".repeat(200)}.mp4`).length).toBe(128);
    expect(uploadMimeType("a.mp4")).toBe("video/mp4");
    expect(uploadMimeType("a.mov")).toBe("video/quicktime");
    expect(uploadMimeType("a.webm")).toBe("video/webm");
    expect(uploadMimeType("a.jpg")).toBe("image/jpeg");
    expect(uploadMimeType("a.png")).toBe("image/png");
    expect(uploadMimeType("noext")).toBe("image/png");
  });
});
