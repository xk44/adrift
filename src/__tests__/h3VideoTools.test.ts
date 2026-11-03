/**
 * H3 image-to-video LoRA tools (360 orbit, camera move), the generic
 * motion-repair / handheld LoRA toggles, the person remover, the unavailable
 * CrossView card, and the model-status option report.
 *
 * Graph inputs are checked against the required inputs of ComfyUI's own node
 * schemas (comfy_extras/nodes_minimax_h3.py + core nodes.py); a live
 * /object_info audit needs a running server and is not part of this suite.
 */
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ImagineRun, Workflow } from "@/types";
import {
  CAMERA_LORA,
  CAMERA_PRESETS,
  H3_EXTRA_LORAS,
  ORBIT_LORA,
  ORBIT_PROMPT,
  CAMERA_TRAINED_COUNT,
  applyH3ExtraLoras,
  cameraMovePrompt,
  orbitPrompt,
} from "@/lib/oj/h3Video";
import {
  buildCameraMoveWorkflow,
  buildOrbit360Workflow,
  h3ImageDims,
} from "@/lib/oj/h3ImageVideo";
import { resolveWorkflow } from "@/lib/oj/packs";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  PERSON_REMOVE_ACTION,
  PERSON_REMOVE_LORA,
  PERSON_REMOVE_MAX_SECONDS,
  PR_NODES,
  buildPersonRemoveWorkflow,
  cleanBackground,
  cleanFramePrompt,
} from "@/lib/oj/personRemove";
import { parseImagineInput } from "@/lib/oj/parser";
import { workflowModelRequirements } from "@/lib/tools/modelStatus";
import {
  ACTION_TOOLS,
  ToolInputError,
  actionAvailability,
  buildActionRequest,
  buildToolCards,
  defaultSettings,
  getActionTool,
  groupOptions,
} from "@/lib/tools/toolsPage";

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return mkdtempSync(
    require("path").join(require("os").tmpdir(), "cj-h3v-"),
  ) as string;
});
vi.mock("@/lib/env", () => ({
  env: { COMFY_ROOT: tmpRoot, ADMIN_API_KEY: "" },
}));
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

const load = (name: string): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        "public/workflows/packs/minimax",
        `${name}.json`,
      ),
      "utf-8",
    ),
  );
const IMAGE_URL =
  "http://127.0.0.1:8188/view?filename=src.png&subfolder=cj&type=input";
function imageRun(width = 1024, height = 1024): ImagineRun {
  return {
    run_id: "seed-img",
    prompt: "",
    parsedPrompt: "",
    width,
    height,
    createdAt: new Date().toISOString(),
    status: "done",
    jobs: [
      { seed: 0, index: 0, status: "done", progress: 100, images: [IMAGE_URL] },
    ],
    params: { seed_upload: true },
  } as ImagineRun;
}
const byClass = (wf: Workflow, cls: string) =>
  Object.values(wf).find((n) => n.class_type === cls)!.inputs as Record<
    string,
    unknown
  >;
const loraEntries = (wf: Workflow) =>
  Object.values(wf)
    .filter((n) => n.class_type === "LoraLoaderModelOnly")
    .map((n) => [n.inputs.lora_name, n.inputs.strength_model]);
const put = (dir: string, file: string) => {
  const p = path.join(tmpRoot, "models", dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
};
const clearModels = () =>
  fs.rmSync(path.join(tmpRoot, "models"), { recursive: true, force: true });

// Required inputs per ComfyUI's schemas (nodes_minimax_h3.py / nodes.py / comfy_extras).
const REQUIRED: Record<string, string[]> = {
  UNETLoader: ["unet_name", "weight_dtype"],
  CLIPLoader: ["clip_name", "type"],
  VAELoader: ["vae_name"],
  LoadImage: ["image"],
  LoraLoaderModelOnly: ["model", "lora_name", "strength_model"],
  MiniMaxH3ImageToVideo: ["clip", "vae", "prompt", "width", "height", "length"],
  KSamplerSelect: ["sampler_name"],
  BasicScheduler: ["model", "scheduler", "steps", "denoise"],
  RandomNoise: ["noise_seed"],
  BasicGuider: ["model", "conditioning"],
  SamplerCustomAdvanced: [
    "noise",
    "guider",
    "sampler",
    "sigmas",
    "latent_image",
  ],
  VAEDecode: ["samples", "vae"],
  VAEDecodeAudio: ["samples", "vae"],
  CreateVideo: ["images", "fps"],
  SaveVideo: ["video", "filename_prefix", "format", "codec"],
  // person_remove Smart select click-track subgraph (core SAM3 + VHS).
  LoadVideo: ["file"],
  "Video Slice": ["video", "start_time", "duration"],
  GetVideoComponents: ["video"],
  ImageFromBatch: ["image", "batch_index", "length"],
  SAM3_Detect: [
    "model",
    "image",
    "threshold",
    "refine_iterations",
    "individual_masks",
  ],
  SAM3_VideoTrack: [
    "images",
    "model",
    "detection_threshold",
    "max_objects",
    "detect_interval",
  ],
  SAM3_TrackToMask: ["track_data", "object_indices"],
  MaskToImage: ["mask"],
  ImageToMask: ["image", "channel"],
  ImageScale: ["image", "upscale_method", "width", "height", "crop"],
  ImageBatch: ["image1", "image2"],
  MaskComposite: ["destination", "source", "x", "y", "operation"],
  VHS_SelectImages: ["image", "indexes", "err_if_missing", "err_if_empty"],
  VHS_SelectMasks: ["mask", "indexes", "err_if_missing", "err_if_empty"],
};

describe.each([
  ["orbit_360", ORBIT_LORA, 1, 28],
  ["camera_move", CAMERA_LORA, 0.9, 20],
])("%s.json graph", (name, lora, strength, steps) => {
  const wf = load(name);
  it("has every required input for each node class", () => {
    for (const [id, node] of Object.entries(wf)) {
      const need = REQUIRED[node.class_type];
      expect(
        need,
        `unknown class ${node.class_type} (node ${id})`,
      ).toBeDefined();
      for (const key of need) {
        expect(node.inputs, `${node.class_type}.${key}`).toHaveProperty(key);
      }
    }
  });
  it("routes the model through the LoRA into scheduler and guider (no CFG)", () => {
    expect(loraEntries(wf)).toEqual([[lora, strength]]);
    const loraId = Object.keys(wf).find(
      (k) => wf[k].class_type === "LoraLoaderModelOnly",
    )!;
    expect(byClass(wf, "BasicScheduler")).toMatchObject({
      model: [loraId, 0],
      steps,
    });
    expect(byClass(wf, "BasicGuider").model).toEqual([loraId, 0]);
    expect(Object.values(wf).some((n) => n.class_type === "CFGGuider")).toBe(
      false,
    );
    expect((byClass(wf, "MiniMaxH3ImageToVideo").length as number) % 17).toBe(
      5,
    );
  });
  it("declares the LoRA as a model requirement", () => {
    expect(workflowModelRequirements(wf).map((r) => r.file)).toContain(lora);
  });
});

describe("orbit graph keyframes", () => {
  it("feeds the same image as first AND last frame on the FL2VA model", () => {
    const wf = load("orbit_360");
    const h3 = byClass(wf, "MiniMaxH3ImageToVideo");
    expect(h3.first_frame).toEqual(["15", 0]);
    expect(h3.last_frame).toEqual(["15", 0]);
    expect(byClass(wf, "UNETLoader").unet_name).toMatch(/fl2va/);
  });
  it("camera move is first-frame only", () => {
    expect(
      byClass(load("camera_move"), "MiniMaxH3ImageToVideo"),
    ).not.toHaveProperty("last_frame");
  });
});

describe("prompts", () => {
  it("orbit uses the card prompt verbatim, user text appended", () => {
    expect(
      ORBIT_PROMPT.startsWith(
        "One frozen instant. Only the camera moves. In a continuous 360 orbit.",
      ),
    ).toBe(true);
    expect(orbitPrompt()).toBe(ORBIT_PROMPT);
    expect(orbitPrompt("  keep   the sign lit ")).toBe(
      `${ORBIT_PROMPT} keep the sign lit`,
    );
  });
  it("camera prompt opens with the trigger, then the preset, then user text", () => {
    expect(cameraMovePrompt("crane")).toBe("camera motion, crane reveal");
    expect(cameraMovePrompt("push_in", "a rainy street")).toBe(
      "camera motion, a rainy street, slow push-in",
    );
    expect(cameraMovePrompt("nope")).toBe("camera motion, slow push-in");
  });
  it("preset ids are unique and match the Tools-tab picker", () => {
    const ids = CAMERA_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const picker = getActionTool("camera_move")!.pickers!.find(
      (p) => p.key === "cameraMove",
    )!;
    expect(picker.options.map((o) => o.id)).toEqual(ids);
  });
  it("adds the prompt-steered Cinema Studio moves after the trained ones", () => {
    const ids = CAMERA_PRESETS.map((p) => p.id);
    for (const id of [
      "dutch_angle",
      "snorricam",
      "robo_arm",
      "through_object",
      "hyperlapse",
      "wiggle",
      "fpv",
    ])
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf("pan_right"));
    expect(cameraMovePrompt("snorricam", "a runner")).toMatch(
      /^camera motion, a runner, snorricam, /,
    );
  });
  it("covers the remaining camera-control names as prompt-steered moves", () => {
    const ids = CAMERA_PRESETS.map((p) => p.id);
    expect(ids[CAMERA_TRAINED_COUNT - 1]).toBe("pan_right");
    for (const id of [
      "truck_left",
      "truck_right",
      "super_dolly_in",
      "super_dolly_out",
      "double_dolly",
      "whip_pan",
      "focus_change",
      "timelapse_people",
      "timelapse_landscape",
      "timelapse_glam",
      "incline",
      "glam",
      "low_shutter",
      "buckle_up",
      "object_pov",
      "hero_cam",
      "behind_scenes",
      "eating_zoom",
      "flying_cam",
      "eyes_in",
      "mouth_in",
      "car_mount",
      "fisheye",
    ])
      expect(ids.indexOf(id)).toBeGreaterThanOrEqual(CAMERA_TRAINED_COUNT);
    for (const p of CAMERA_PRESETS) {
      expect(p.label.length).toBeGreaterThan(2);
      expect(p.text.length).toBeGreaterThan(5);
    }
    expect(cameraMovePrompt("whip_pan", "a market")).toMatch(
      /^camera motion, a market, .*whip/,
    );
  });
  it("camera picker is a dropdown split into trained and prompt-steered", () => {
    const picker = getActionTool("camera_move")!.pickers!.find(
      (p) => p.key === "cameraMove",
    )!;
    expect(picker.dropdown).toBe(true);
    const groups = groupOptions(picker.options);
    expect(groups.map((g) => g.group)).toEqual([
      "Trained moves",
      "Prompt-steered",
    ]);
    expect(groups[0].options).toHaveLength(CAMERA_TRAINED_COUNT);
  });
});

describe("builders", () => {
  it("orbit: source image, card length/size, seed", () => {
    const base = load("orbit_360");
    const { workflow, seed } = buildOrbit360Workflow(base, imageRun(), 0, {
      seed: 5,
    });
    expect(byClass(workflow, "LoadImage").image).toBe("cj/src.png [input]");
    expect(byClass(workflow, "MiniMaxH3ImageToVideo")).toMatchObject({
      prompt: ORBIT_PROMPT,
      width: 768,
      height: 768,
      length: 73,
    });
    expect(seed).toBe(5);
    expect(byClass(workflow, "RandomNoise").noise_seed).toBe(5);
    expect(byClass(base, "LoadImage").image).toBe("");
  });
  it("camera move: preset prompt, native 768 by default, 480 draft", () => {
    const build = (extra: Record<string, unknown> = {}) =>
      buildCameraMoveWorkflow(load("camera_move"), imageRun(1920, 1080), 0, {
        cameraMove: "orbit",
        prompt: "a cat",
        ...extra,
      }).workflow;
    expect(byClass(build(), "MiniMaxH3ImageToVideo")).toMatchObject({
      prompt: "camera motion, a cat, slow orbit around the subject",
      width: 1344,
      height: 768,
    });
    expect(
      byClass(build({ resolution: "480" }), "MiniMaxH3ImageToVideo"),
    ).toMatchObject({ width: 864, height: 480 });
  });
  it("dims snap to /32, cap the long edge, default square", () => {
    expect(h3ImageDims(768)).toEqual({ width: 768, height: 768 });
    expect(h3ImageDims(480, 1080, 1920)).toEqual({ width: 480, height: 864 });
    // Past the native 1344 long edge both sides shrink: aspect is kept.
    expect(h3ImageDims(480, 4000, 1000)).toEqual({ width: 1344, height: 352 });
    expect(h3ImageDims(768, 1920, 1080)).toEqual({ width: 1344, height: 768 });
    expect(h3ImageDims(768, 2688, 1536)).toEqual({ width: 1344, height: 768 });
  });
  it("refuses a run without an image", () => {
    const run = imageRun();
    run.jobs[0].images = [];
    expect(() => buildOrbit360Workflow(load("orbit_360"), run, 0)).toThrow(
      /orbit_360: source run has no image/,
    );
  });
});

describe("generic extra LoRAs (motionRepair / handheld)", () => {
  it("chains them after the sampler model, rewiring scheduler + guider", () => {
    const wf = load("orbit_360");
    const ids = applyH3ExtraLoras(wf, { motionRepair: true, handheld: "on" });
    expect(ids).toHaveLength(2);
    expect(loraEntries(wf)).toEqual([
      [ORBIT_LORA, 1],
      ["Motion_Repair_V2.safetensors", 0.9],
      ["handheld_h3_100.safetensors", 1],
    ]);
    const tail = ids[1];
    expect(byClass(wf, "BasicScheduler").model).toEqual([tail, 0]);
    expect(byClass(wf, "BasicGuider").model).toEqual([tail, 0]);
    expect(wf[ids[0]].inputs.model).toEqual(["16", 0]);
    expect(wf[tail].inputs.model).toEqual([ids[0], 0]);
    // the previous LoRA keeps reading the UNET
    expect(wf["16"].inputs.model).toEqual(["1", 0]);
  });
  it("works on a plain pack graph (i2v) and the swap graphs; idempotent", () => {
    for (const name of ["i2v", "face_swap", "character_swap", "t2v"]) {
      const wf = load(name);
      const before = Object.keys(wf).length;
      const ids = applyH3ExtraLoras(wf, { motionRepair: true });
      expect(ids, name).toHaveLength(1);
      expect(Object.keys(wf)).toHaveLength(before + 1);
      expect(applyH3ExtraLoras(wf, { motionRepair: true }), name).toEqual([]);
      // swap graphs keep their MiniMaxH3SigmaShift tail; the LoRA goes in front
      const g = byClass(wf, "BasicGuider").model as [string, number];
      const tail =
        wf[g[0]].class_type === "MiniMaxH3SigmaShift"
          ? wf[g[0]].inputs.model
          : g;
      expect(tail, name).toEqual([ids[0], 0]);
    }
  });
  it("is a no-op without flags and for non-H3 graphs", () => {
    const wf = load("i2v");
    expect(applyH3ExtraLoras(wf, {})).toEqual([]);
    expect(applyH3ExtraLoras(wf, { motionRepair: false })).toEqual([]);
    const moss = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "public/workflows/packs/moss-image/t2i.json"),
        "utf-8",
      ),
    );
    delete moss._meta;
    expect(applyH3ExtraLoras(moss, { motionRepair: true })).toEqual([]);
  });
  it("the --motion-repair / --handheld flags parse to params", () => {
    const parsed = parseImagineInput(
      "a man flips --video --packId minimax --motion-repair --handheld",
    );
    expect(parsed.params.motionRepair).toBe(true);
    expect(parsed.params.handheld).toBe(true);
    expect(H3_EXTRA_LORAS.map((l) => l.key)).toEqual([
      "motionRepair",
      "handheld",
    ]);
  });
  it("applies through the builders", () => {
    const { workflow } = buildOrbit360Workflow(
      load("orbit_360"),
      imageRun(),
      0,
      {
        handheld: true,
      },
    );
    expect(loraEntries(workflow).map((e) => e[0])).toEqual([
      ORBIT_LORA,
      "handheld_h3_100.safetensors",
    ]);
  });
});

describe("registry + action route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModels();
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid" } as never);
  });
  const req = (body: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", ...body }),
    });

  it.each(["orbit_360", "camera_move"])(
    "%s resolves to the minimax graph",
    (action) => {
      const r = resolveWorkflow({
        templateOrAction: action,
        packId: "minimax",
      });
      expect(r.workflowPath).toMatch(
        new RegExp(`packs/minimax/${action}\\.json$`),
      );
    },
  );

  it("queues the orbit graph against the source image", async () => {
    vi.mocked(getActiveRun).mockReturnValue(imageRun());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load("orbit_360") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "seed-img",
        job_index: 0,
        action: "orbit_360",
        params: { pack_id: "minimax" },
      }),
    );
    expect(res.status).toBe(200);
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(byClass(queued, "LoadImage").image).toBe("cj/src.png [input]");
    expect(byClass(queued, "MiniMaxH3ImageToVideo").prompt).toBe(ORBIT_PROMPT);
    expect(byClass(queued, "BasicScheduler")).toMatchObject({ steps: 28 });
  });

  it("queues camera_move with the chosen preset", async () => {
    vi.mocked(getActiveRun).mockReturnValue(imageRun());
    vi.mocked(loadWorkflowFromSelection).mockResolvedValue(
      load("camera_move") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "seed-img",
        job_index: 0,
        action: "camera_move",
        params: { pack_id: "minimax", cameraMove: "crane" },
      }),
    );
    expect(res.status).toBe(200);
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(byClass(queued, "MiniMaxH3ImageToVideo").prompt).toBe(
      "camera motion, crane reveal",
    );
  });

  it("409s while a requested extra LoRA is missing, queues once installed", async () => {
    vi.mocked(getActiveRun).mockReturnValue(imageRun());
    vi.mocked(loadWorkflowFromSelection).mockImplementation(
      async () => load("orbit_360") as never,
    );
    const { POST } = await import("@/app/api/jobs/action/route");
    const body = {
      run_id: "seed-img",
      job_index: 0,
      action: "orbit_360",
      params: { pack_id: "minimax", motionRepair: true },
    };
    const miss = await POST(req(body));
    expect(miss.status).toBe(409);
    expect((await miss.json()).error).toMatch(
      /loras\/Motion_Repair_V2\.safetensors/,
    );
    expect(queuePrompt).not.toHaveBeenCalled();

    put("loras", "Motion_Repair_V2.safetensors");
    const ok = await POST(req(body));
    expect(ok.status).toBe(200);
    const queued = vi.mocked(queuePrompt).mock.calls[0][0] as Workflow;
    expect(loraEntries(queued).map((e) => e[0])).toContain(
      "Motion_Repair_V2.safetensors",
    );
  });

  it("requires a source image (registry requiresImage)", async () => {
    const run = imageRun();
    run.jobs[0].images = [];
    vi.mocked(getActiveRun).mockReturnValue(run);
    const { POST } = await import("@/app/api/jobs/action/route");
    const res = await POST(
      req({
        run_id: "r",
        job_index: 0,
        action: "orbit_360",
        params: { pack_id: "minimax" },
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("GET /api/tools/model-status", () => {
  beforeEach(clearModels);
  it("flags the orbit / camera LoRAs and reports optional LoRA state", async () => {
    const { GET } = await import("@/app/api/tools/model-status/route");
    const get = async () =>
      (
        await GET(new NextRequest("http://localhost/api/tools/model-status"))
      ).json();
    let body = await get();
    expect(body.tools.orbit_360.missing).toContain(`loras/${ORBIT_LORA}`);
    expect(body.tools.camera_move.missing).toContain(`loras/${CAMERA_LORA}`);
    expect(body.options.motionRepair).toEqual({
      file: "Motion_Repair_V2.safetensors",
      missing: ["loras/Motion_Repair_V2.safetensors"],
    });
    expect(body.options.handheld.missing).toHaveLength(1);
    // h3Speed: both the fl2v and ref2v Turbo files are reported
    expect(body.options.h3Turbo8.missing).toEqual([
      "loras/minimax_h3_fl2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors",
      "loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
    ]);
    expect(body.options.h3Turbo4.missing).toHaveLength(2);
    // h3Speed fast8: both FastH3 DiTs (no video backend -> local disk)
    const FAST = [
      "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
      "fasth3_omniref_8step_pruned_int8_convrot.safetensors",
    ];
    expect(body.options.h3Fast8).toEqual({
      file: FAST[0],
      missing: FAST.map((f) => `diffusion_models/${f}`),
    });

    put("loras", ORBIT_LORA);
    put("loras", "handheld_h3_100.safetensors");
    for (const f of FAST) put("diffusion_models", f);
    body = await get();
    expect(body.tools.orbit_360.missing).not.toContain(`loras/${ORBIT_LORA}`);
    expect(body.options.handheld.missing).toEqual([]);
    expect(body.options.h3Fast8.missing).toEqual([]);
  });
});

describe("Tools tab cards", () => {
  const packs = new Set(["minimax"]);
  it("orbit_360 + camera_move are image-in action tools gated on their LoRA", () => {
    for (const id of ["orbit_360", "camera_move"] as const) {
      const spec = getActionTool(id)!;
      expect(spec.videoInput).toBeUndefined();
      expect(spec.modelCheck).toEqual({ pack: "minimax", action: id });
      expect(
        actionAvailability(spec, packs, null, {
          tools: { [id]: { missing: ["loras/x"] } },
        }).reason,
      ).toMatch(/Model not installed/);
      expect(
        actionAvailability(spec, packs, null, {
          tools: { [id]: { missing: [] } },
        }).available,
      ).toBe(true);
    }
  });
  it("transition: Quality by default, Fast (8 steps) sends h3Speed fast8", () => {
    const spec = getActionTool("transition")!;
    const settings = { ...defaultSettings(spec), text: "day to night" };
    const quality = buildActionRequest(spec, settings, null, "end.png [input]");
    expect(quality.params.h3Speed).toBeUndefined();
    const fast = buildActionRequest(
      spec,
      { ...settings, picks: { h3Speed: "fast8" } },
      null,
      "end.png [input]",
    );
    expect(fast.params).toMatchObject({
      pack_id: "minimax",
      secondRefImage: "end.png [input]",
      h3Speed: "fast8",
    });
  });
  it("builds requests: toggles default off, preset + text forwarded", () => {
    const orbit = getActionTool("orbit_360")!;
    expect(buildActionRequest(orbit, defaultSettings(orbit), null)).toEqual({
      action: "orbit_360",
      params: { pack_id: "minimax" },
      overrides: {},
    });
    const cam = getActionTool("camera_move")!;
    const s = {
      ...defaultSettings(cam),
      text: "a market",
      picks: { cameraMove: "tilt_up", motionRepair: "on", handheld: "on" },
    };
    expect(buildActionRequest(cam, s, null)).toEqual({
      action: "camera_move",
      params: {
        pack_id: "minimax",
        cameraMove: "tilt_up",
        resolution: "768",
        prompt: "a market",
        motionRepair: true,
        handheld: true,
      },
      overrides: {},
    });
    expect(
      buildActionRequest(cam, defaultSettings(cam), null).params.cameraMove,
    ).toBe("push_in");
  });
  it("CrossView is listed but unavailable with requiresNodes text", () => {
    const spec = getActionTool("crossview")!;
    expect(ACTION_TOOLS.map((t) => t.id)).toContain("crossview");
    expect(spec.requiresNodes).toBeTruthy();
    const av = actionAvailability(spec, packs, null, { tools: {} });
    expect(av).toMatchObject({ available: false, checking: false });
    expect(av.reason).toMatch(/^Needs custom nodes: /);
    expect(() => buildActionRequest(spec, defaultSettings(spec), null)).toThrow(
      ToolInputError,
    );
  });
  it("person remover is a video-in tool gated on its model-status entry", () => {
    const spec = getActionTool("person_remove")!;
    expect(spec.requiresNodes).toBeUndefined();
    expect(spec.videoInput).toBeTruthy();
    expect(spec.secondImageOptional).toBe(true);
    expect(spec.modelCheck).toEqual({
      pack: "minimax",
      action: "person_remove",
    });
    expect(spec.requireStatusEntry).toBe(true);
    expect(
      actionAvailability(spec, packs, null, {
        tools: { person_remove: { missing: [`loras/${PERSON_REMOVE_LORA}`] } },
      }).reason,
    ).toMatch(/Model not installed/);
    expect(
      actionAvailability(spec, packs, null, {
        tools: { person_remove: { missing: [] } },
      }).available,
    ).toBe(true);
    expect(buildActionRequest(spec, defaultSettings(spec), null)).toEqual({
      action: "person_remove",
      params: { pack_id: "minimax" },
      overrides: {},
    });
    expect(
      buildActionRequest(
        spec,
        { ...defaultSettings(spec), text: "man in a red coat" },
        null,
        "clean.png [input]",
      ).params,
    ).toEqual({
      pack_id: "minimax",
      target: "man in a red coat",
      secondRefImage: "clean.png [input]",
    });
    expect(
      buildActionRequest(
        spec,
        { ...defaultSettings(spec), secondText: "  empty park bench " },
        null,
      ).params,
    ).toEqual({ pack_id: "minimax", background: "empty park bench" });
    const cards = buildToolCards({
      catalog: [],
      packIds: packs,
      editLoras: null,
      modelStatus: { tools: { person_remove: { missing: [] } } },
    });
    expect(cards.find((c) => c.key === "action:person_remove")!.available).toBe(
      true,
    );
  });
});

describe("person_remove graph + builder", () => {
  const prGraph = (): Workflow => {
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "public/workflows/packs/minimax/person_remove.json",
        ),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    delete raw._meta;
    return raw as Workflow;
  };
  const prRun = (): ImagineRun =>
    ({
      run_id: "src",
      prompt: "clip",
      parsedPrompt: "clip",
      width: 480,
      height: 832,
      jobs: [
        {
          seed: 0,
          index: 0,
          status: "completed",
          progress: 100,
          images: [],
          videos: ["/api/comfy/view?filename=cj%2Fdance.mp4&type=input"],
        },
      ],
      createdAt: new Date().toISOString(),
      status: "completed",
    }) as unknown as ImagineRun;
  const linked = (wf: Workflow) => {
    for (const [id, node] of Object.entries(wf))
      for (const v of Object.values(node.inputs))
        if (Array.isArray(v) && typeof v[0] === "string")
          expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
  };

  it("is wired in registry, pack map and video-input builders", () => {
    expect(
      resolveWorkflow({ templateOrAction: "person_remove", packId: "minimax" })
        .workflowPath,
    ).toMatch(/packs\/minimax\/person_remove\.json$/);
    expect(VIDEO_INPUT_ACTIONS.has(PERSON_REMOVE_ACTION)).toBe(true);
    expect(actionBuilderFor(PERSON_REMOVE_ACTION)).toBe(
      buildPersonRemoveWorkflow,
    );
  });

  it("default: SAM text target, 24 fps prep, Qwen clean frame", () => {
    const { workflow: wf, seed } = buildPersonRemoveWorkflow(
      prGraph(),
      prRun(),
      0,
      {
        target: "  woman in a  yellow shirt ",
        seed: 7,
      },
    );
    linked(wf);
    expect(seed).toBe(7);
    expect(wf[PR_NODES.loadVideo].inputs.file).toBe("cj/dance.mp4 [input]");
    expect(wf[PR_NODES.prep].class_type).toBe("LabsH3PrepareVideo");
    expect(wf[PR_NODES.prep].inputs.duration_seconds).toBe(
      PERSON_REMOVE_MAX_SECONDS,
    );
    expect(wf[PR_NODES.samText].inputs.text).toBe("woman in a yellow shirt");
    const rm = wf[PR_NODES.remover];
    expect(rm.class_type).toBe("CJPersonRemoverAuto");
    expect(rm.inputs).toMatchObject({
      seed: 7,
      steps: 12,
      window_frames: "22",
      max_attempts: 4,
      // Real-footage grid: clean windows score green <= 0.08, SAM3 "person" 0.26-0.33 on
      // empty seats; "hand" and haze stay <= 0.006 on clean frames, 0.15-0.19 on remnants.
      green_limit: 0.1,
      person_limit: 0.4,
      part_limit: 0.05,
      haze_limit: 0.008,
    });
    // The remover prompt names the background: a Qwen3-VL caption of the clean frame.
    expect(rm.inputs.background).toEqual([PR_NODES.bgCaption, 0]);
    expect(wf[PR_NODES.bgCaption].class_type).toBe("TextGenerate");
    expect(wf[PR_NODES.bgCaption].inputs.image).toEqual([PR_NODES.qwenResize, 0]);
    expect(wf[PR_NODES.bgCaption].inputs.clip).toEqual([PR_NODES.bgClip, 0]);
    expect(wf[PR_NODES.bgClip].inputs.clip_name).toBe("qwen3vl_8b_bf16.safetensors");
    // The per-window gate's person check reuses the tracking SAM3 + its "person" prompt.
    expect(rm.inputs.sam_model).toEqual(["11", 0]);
    expect(rm.inputs.person_cond).toEqual(["17", 0]);
    expect(rm.inputs.part_cond).toEqual([PR_NODES.partCond, 0]);
    expect(wf[PR_NODES.partCond].inputs).toEqual({ clip: ["11", 1], text: "hand" });
    expect(rm.inputs.fps).toEqual([PR_NODES.prep, 6]);
    expect(rm.inputs.clean_first_frame).toEqual([PR_NODES.qwenResize, 0]);
    expect(wf[PR_NODES.qwenPrompt].inputs.prompt).toBe(
      cleanFramePrompt("woman in a yellow shirt"),
    );
    // Cast shadows survive removal unless both prompts name them.
    expect(cleanFramePrompt("woman in a yellow shirt")).toContain(
      "their shadow",
    );
    expect(String(rm.inputs.prompt)).toContain("their shadow");
    expect(wf[PR_NODES.userImage]).toBeUndefined();
    const lora = Object.values(wf).find(
      (n) =>
        n.class_type === "LoraLoaderModelOnly" &&
        n.inputs.lora_name === PERSON_REMOVE_LORA,
    );
    expect(lora?.inputs.strength_model).toBe(1);
  });

  it("user clean frame replaces the Qwen branch; bad refs rejected", () => {
    const { workflow: wf } = buildPersonRemoveWorkflow(prGraph(), prRun(), 0, {
      secondRefImage: "clean_1.png [input]",
    });
    linked(wf);
    expect(wf[PR_NODES.samText].inputs.text).toBe("person");
    expect(wf[PR_NODES.userImage].inputs.image).toBe("clean_1.png [input]");
    expect(wf[PR_NODES.remover].inputs.clean_first_frame).toEqual([
      PR_NODES.userResize,
      0,
    ]);
    for (const id of PR_NODES.qwenBranch) expect(wf[id]).toBeUndefined();
    // The caption reads the uploaded clean frame instead of the deleted Qwen one.
    expect(wf[PR_NODES.bgCaption].inputs.image).toEqual([PR_NODES.userResize, 0]);
    expect(() =>
      buildPersonRemoveWorkflow(prGraph(), prRun(), 0, {
        secondRefImage: "/etc/passwd",
      }),
    ).toThrow(/secondRefImage/);
    const noVideo = prRun();
    noVideo.jobs[0].videos = [];
    expect(() => buildPersonRemoveWorkflow(prGraph(), noVideo, 0)).toThrow(
      /no video/,
    );
  });

  it("typed background replaces the caption branch", () => {
    const { workflow: wf } = buildPersonRemoveWorkflow(prGraph(), prRun(), 0, {
      background: "  an empty  park bench,\n trees behind ",
    });
    linked(wf);
    expect(wf[PR_NODES.remover].inputs.background).toBe(
      "an empty park bench, trees behind",
    );
    expect(wf[PR_NODES.bgCaption]).toBeUndefined();
    expect(wf[PR_NODES.bgClip]).toBeUndefined();
    expect(cleanBackground(42)).toBe("");
    expect(cleanBackground("x".repeat(400))).toHaveLength(300);
  });

  it("smart select clicks replace the text-SAM branch; Qwen branch intact", () => {
    const base = buildPersonRemoveWorkflow(prGraph(), prRun(), 0, { seed: 1 })
      .workflow;
    const consumers = Object.entries(base).filter(([, n]) =>
      Object.values(n.inputs).some(
        (v) => Array.isArray(v) && v[0] === PR_NODES.samMask,
      ),
    );
    expect(consumers.length).toBeGreaterThan(0);
    const { workflow: wf } = buildPersonRemoveWorkflow(prGraph(), prRun(), 0, {
      seed: 1,
      smartTrack: [
        {
          t: 4.5,
          positive: [
            { x: 290, y: 110 },
            { x: 250, y: 330 },
            { x: 430, y: 420 },
          ],
        },
        { t: 9, positive: [{ x: 1, y: 1 }] }, // past 5.2 s: dropped
      ],
    });
    linked(wf);
    for (const id of [PR_NODES.samDetect, PR_NODES.samTrack, PR_NODES.samMask])
      expect(wf[id]).toBeUndefined();
    for (const id of PR_NODES.qwenBranch) expect(wf[id]).toBeDefined();
    // Every former consumer of the text mask now reads the click track.
    for (const [id] of consumers) {
      const ref = Object.values(wf[id].inputs).find(
        (v) => Array.isArray(v) && wf[v[0] as string]?.class_type === "ImageToMask",
      );
      expect(ref, `node ${id} rewired`).toBeDefined();
    }
    const added = Object.entries(wf).filter(([id]) => !base[id]);
    for (const [id, node] of added) {
      const need = REQUIRED[node.class_type];
      expect(need, `unknown class ${node.class_type} (node ${id})`).toBeDefined();
      for (const key of need) expect(node.inputs).toHaveProperty(key);
    }
    const tracks = added.filter(([, n]) => n.class_type === "SAM3_VideoTrack");
    expect(tracks).toHaveLength(2); // forward + backward from 4.5 s
    for (const [, n] of tracks) expect(n.inputs.model).toEqual([PR_NODES.samModel, 0]);
    expect(
      added.filter(([, n]) => n.class_type === "SAM3_Detect"),
    ).toHaveLength(1);
  });
});
