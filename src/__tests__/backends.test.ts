/**
 * Multi-host ComfyUI routing (src/lib/comfy/backends.ts), the cross-host GPU
 * mutex, remote model checks (backendModels.ts) and the transition /
 * video_bg_remove builders. No network: every backend call is mocked.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://mac:8188", COMFY_ROOT: "/nonexistent" },
}));

import {
  BackendBusyError,
  _resetBackendStateForTests,
  backendForSubfolder,
  candidateBackendUrls,
  exclusiveBackendsEnabled,
  otherGroupUrls,
  rememberPromptBackend,
  routeBackend,
  stageInputsForBackend,
  stagedFilename,
  tagOutputsForVideoBackend,
  waitForOthersIdle,
  withExclusiveBackend,
  type GateDeps,
  type QueueCounts,
} from "@/lib/comfy/backends";
import {
  missingAgainstObjectInfo,
  missingOnDefaultBackend,
  modelCheckWorkflowRel,
  videoVariantRel,
} from "@/lib/comfy/backendModels";
import {
  buildTransitionWorkflow,
  transitionEndRef,
  transitionLength,
} from "@/lib/oj/h3ImageVideo";
import { buildVideoBgRemoveWorkflow } from "@/lib/oj/videoBgRemove";
import registry from "@/lib/oj/registry.json";
import type { ImagineRun, Workflow } from "@/types";

const PC = "http://pc:8288";
const ENV_KEYS = [
  "COMFY_VIDEO_HTTP_URL",
  "COMFY_VIDEO_ACTIONS",
  "COMFY_VIDEO_PACKS",
  "COMFY_EXCLUSIVE_BACKENDS",
  "COMFY_VIDEO_OUTPUT_SUBFOLDER",
  "CJ_H3_WARM_URL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  _resetBackendStateForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const loadGraph = (rel: string): Workflow => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf8"),
  ) as Record<string, unknown>;
  delete raw._meta;
  return raw as unknown as Workflow;
};

/** Fake clock + queue script for the gate. */
function gateDeps(script: Record<string, Array<QueueCounts | null>>) {
  let t = 0;
  const calls: string[] = [];
  const deps: GateDeps = {
    fetchQueue: async (url) => {
      calls.push(url);
      const q = script[url];
      return q && q.length > 1 ? q.shift()! : (q?.[0] ?? null);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, calls, elapsed: () => t };
}
const idle: QueueCounts = { running: 0, pending: 0 };
const busy: QueueCounts = { running: 1, pending: 0 };

describe("routing", () => {
  it("single host: everything stays on default", () => {
    expect(routeBackend({ action: "transition" })).toBe("default");
    expect(routeBackend({ workflowPath: "packs/minimax/t2v.json" })).toBe(
      "default",
    );
    expect(exclusiveBackendsEnabled()).toBe(false);
    expect(candidateBackendUrls("p")).toEqual([
      "http://mac:8188",
      "http://127.0.0.1:8189",
    ]);
  });

  it("video actions and minimax pack go to the video host", () => {
    process.env.COMFY_VIDEO_HTTP_URL = `${PC}/`;
    for (const action of [
      "transition",
      "character_swap",
      "face_swap",
      "orbit_360",
      "camera_move",
    ])
      expect(routeBackend({ action })).toBe("video");
    expect(
      routeBackend({
        workflowPath: "/abs/public/workflows/packs/minimax/t2v.json",
      }),
    ).toBe("video");
    expect(routeBackend({ action: "vary_subtle", packId: "minimax" })).toBe(
      "video",
    );
    // A default-host graph wins over a stray video pack id.
    expect(
      routeBackend({
        action: "bg_remove",
        packId: "minimax",
        workflowPath: "packs/utility/bg_remove.json",
      }),
    ).toBe("default");
    expect(routeBackend({ action: "video_bg_remove" })).toBe("default");
    expect(routeBackend({ action: "upscale_2x", packId: "sdxl" })).toBe(
      "default",
    );
    expect(exclusiveBackendsEnabled()).toBe(true);
  });

  it("env overrides the routing tables", () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    process.env.COMFY_VIDEO_ACTIONS = "video_bg_remove";
    process.env.COMFY_VIDEO_PACKS = "";
    expect(routeBackend({ action: "video_bg_remove" })).toBe("video");
    expect(routeBackend({ action: "transition" })).toBe("default");
    expect(routeBackend({ workflowPath: "packs/minimax/t2v.json" })).toBe(
      "default",
    );
    process.env.COMFY_EXCLUSIVE_BACKENDS = "0";
    expect(exclusiveBackendsEnabled()).toBe(false);
  });

  it("subfolder marker picks the backend for /view", () => {
    expect(backendForSubfolder("adrift-video/video")).toBe("default");
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    expect(backendForSubfolder("adrift-video/video")).toBe("video");
    expect(backendForSubfolder("adrift-videos")).toBe("default");
    expect(backendForSubfolder("video")).toBe("default");
    process.env.COMFY_VIDEO_OUTPUT_SUBFOLDER = "pc";
    expect(backendForSubfolder("pc/video")).toBe("video");
  });

  it("tags output prefixes once", () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const wf = loadGraph("packs/minimax/transition.json");
    expect(tagOutputsForVideoBackend(wf)).toBe(1);
    expect(tagOutputsForVideoBackend(wf)).toBe(0);
    const save = Object.values(wf).find((n) => n.class_type === "SaveVideo")!;
    expect(save.inputs.filename_prefix).toBe(
      "adrift-video/video/CJ_MiniMax_H3_Transition",
    );
  });

  it("remembers the queuing backend first for history lookups", () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    rememberPromptBackend("p1", `${PC}/`);
    expect(candidateBackendUrls("p1")[0]).toBe(PC);
    expect(candidateBackendUrls("p2")).toEqual([
      "http://mac:8188",
      "http://127.0.0.1:8189",
      PC,
    ]);
    expect(otherGroupUrls(PC)).toEqual([
      "http://mac:8188",
      "http://127.0.0.1:8189",
    ]);
    expect(otherGroupUrls("http://mac:8188")).toEqual([PC]);
  });
});

describe("input staging", () => {
  const deps = () => ({
    download: vi.fn(
      async (_b: string, _r: unknown) => new Uint8Array([1, 2, 3]),
    ),
    upload: vi.fn(
      async (_b: string, _d: Uint8Array, name: string, sub: string) =>
        `${sub}/${name} [input]`,
    ),
  });

  it("copies refs from the other host and rewrites them", async () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const wf: Workflow = {
      "1": { class_type: "LoadImage", inputs: { image: "a.png [input]" } },
      "2": { class_type: "LoadImage", inputs: { image: "a.png [input]" } },
      "3": {
        class_type: "LoadVideo",
        inputs: { file: "adrift-video/video/x.mp4 [output]" },
      },
      "4": { class_type: "LoadImage", inputs: { image: "plain.png" } },
    };
    const d = deps();
    expect(await stageInputsForBackend(wf, "video", d)).toBe(2);
    // a.png lives on the mac → one download, cached for node 2.
    expect(d.download).toHaveBeenCalledTimes(1);
    expect(d.download.mock.calls[0][0]).toBe("http://mac:8188");
    expect(d.upload.mock.calls[0][0]).toBe(PC);
    expect(wf["1"].inputs.image).toBe("adrift-video/xfer/input__a.png [input]");
    expect(wf["2"].inputs.image).toBe(wf["1"].inputs.image);
    // Already on the pc, and plain names, stay untouched.
    expect(wf["3"].inputs.file).toBe("adrift-video/video/x.mp4 [output]");
    expect(wf["4"].inputs.image).toBe("plain.png");
  });

  it("stages pc outputs back to the mac", async () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const wf: Workflow = {
      "1": {
        class_type: "LoadVideo",
        inputs: { file: "adrift-video/video/x.mp4 [output]" },
      },
    };
    const d = deps();
    expect(await stageInputsForBackend(wf, "default", d)).toBe(1);
    expect(d.download.mock.calls[0][0]).toBe(PC);
    expect(d.upload.mock.calls[0][0]).toBe("http://mac:8188");
    expect(wf["1"].inputs.file).toBe(
      "adrift-xfer/output__adrift-video__video__x.mp4 [input]",
    );
  });

  it("is a no-op on a single host", async () => {
    const wf: Workflow = {
      "1": { class_type: "LoadImage", inputs: { image: "a.png [input]" } },
    };
    const d = deps();
    expect(await stageInputsForBackend(wf, "video", d)).toBe(0);
    expect(d.download).not.toHaveBeenCalled();
  });

  it("flattens names safely", () => {
    expect(
      stagedFilename({ subfolder: "a b/c", filename: "x$.png", type: "temp" }),
    ).toBe("temp__a_b__c__x_.png");
  });
});

describe("cross-host GPU mutex", () => {
  it("waits until the other backend's queue drains", async () => {
    const { deps, elapsed } = gateDeps({ [PC]: [busy, busy, idle] });
    await waitForOthersIdle([PC], { timeoutMs: 60_000, pollMs: 1000, deps });
    expect(elapsed()).toBe(2000);
  });

  it("counts pending work as busy", async () => {
    const { deps, elapsed } = gateDeps({
      [PC]: [{ running: 0, pending: 2 }, idle],
    });
    await waitForOthersIdle([PC], { timeoutMs: 60_000, pollMs: 500, deps });
    expect(elapsed()).toBe(500);
  });

  it("times out with BackendBusyError (503)", async () => {
    const { deps } = gateDeps({ [PC]: [busy] });
    const err = await waitForOthersIdle([PC], {
      timeoutMs: 3000,
      pollMs: 1000,
      deps,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendBusyError);
    expect(err.status).toBe(503);
    expect(err.busy).toEqual([PC]);
  });

  it("treats an unreachable backend as idle", async () => {
    const { deps, elapsed } = gateDeps({ [PC]: [null] });
    await waitForOthersIdle([PC], { timeoutMs: 1000, pollMs: 100, deps });
    expect(elapsed()).toBe(0);
  });

  it("does not submit until the other side is idle", async () => {
    const { deps } = gateDeps({ [PC]: [busy, idle] });
    const order: string[] = [];
    deps.sleep = async () => {
      order.push("sleep");
    };
    await withExclusiveBackend(
      "http://mac:8188",
      async () => {
        order.push("submit");
      },
      { enabled: true, others: [PC], timeoutMs: 10_000, pollMs: 1, deps },
    );
    expect(order).toEqual(["sleep", "submit"]);
  });

  it("serializes concurrent submissions", async () => {
    const { deps } = gateDeps({ [PC]: [idle] });
    let active = 0;
    let maxActive = 0;
    const submit = (id: string) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return id;
    };
    const opts = {
      enabled: true,
      others: [PC],
      timeoutMs: 1000,
      pollMs: 1,
      deps,
    };
    const results = await Promise.all([
      withExclusiveBackend("http://mac:8188", submit("a"), opts),
      withExclusiveBackend("http://mac:8188", submit("b"), opts),
      withExclusiveBackend("http://mac:8188", submit("c"), opts),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
  });

  it("a failed submission does not wedge the chain", async () => {
    const { deps } = gateDeps({ [PC]: [idle] });
    const opts = {
      enabled: true,
      others: [PC],
      timeoutMs: 10,
      pollMs: 1,
      deps,
    };
    await expect(
      withExclusiveBackend(
        "http://mac:8188",
        async () => {
          throw new Error("boom");
        },
        opts,
      ),
    ).rejects.toThrow("boom");
    await expect(
      withExclusiveBackend("http://mac:8188", async () => "ok", opts),
    ).resolves.toBe("ok");
  });

  it("disabled / single host passes straight through", async () => {
    const fetchQueue = vi.fn();
    expect(
      await withExclusiveBackend("http://mac:8188", async () => 1, {
        deps: { fetchQueue },
      }),
    ).toBe(1);
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    process.env.COMFY_EXCLUSIVE_BACKENDS = "off";
    expect(
      await withExclusiveBackend(PC, async () => 2, { deps: { fetchQueue } }),
    ).toBe(2);
    expect(fetchQueue).not.toHaveBeenCalled();
  });

  it("enabled by default with two hosts: a pc job waits for mac + warm", async () => {
    process.env.COMFY_VIDEO_HTTP_URL = PC;
    const { deps, calls } = gateDeps({
      "http://mac:8188": [busy, idle],
      "http://127.0.0.1:8189": [null],
    });
    await withExclusiveBackend(PC, async () => "queued", {
      deps,
      pollMs: 1,
      timeoutMs: 1000,
    });
    expect(new Set(calls)).toEqual(
      new Set(["http://mac:8188", "http://127.0.0.1:8189"]),
    );
  });
});

describe("remote model checks", () => {
  const info = {
    LoadImage: { input: { required: { image: [["a.png"]] } } },
    UNETLoader: {
      input: {
        required: {
          unet_name: [
            [
              "minimax_h3_ref2va_turbo11_charswap15_merged_int8_convrot.safetensors",
            ],
          ],
          weight_dtype: [["default"]],
        },
      },
    },
    LoadBackgroundRemovalModel: {
      input: { required: { bg_removal_name: ["COMBO", { options: [] }] } },
    },
  };

  it("reports missing node classes and loader files", () => {
    const wf: Workflow = {
      "1": {
        class_type: "UNETLoader",
        inputs: { unet_name: "minimax_h3_fl2va_pruned_bf16.safetensors" },
      },
      "2": {
        class_type: "UNETLoader",
        inputs: {
          unet_name:
            "minimax_h3_ref2va_turbo11_charswap15_merged_int8_convrot.safetensors",
        },
      },
      "3": { class_type: "TripoSRSampler", inputs: {} },
      "4": {
        class_type: "CustomChunkedAttention",
        inputs: {},
        _meta: { optional: true },
      } as Workflow[string],
      "5": {
        class_type: "LoadBackgroundRemovalModel",
        inputs: { bg_removal_name: "birefnet.safetensors" },
      },
    };
    expect(missingAgainstObjectInfo(wf, info)).toEqual([
      "diffusion_models/minimax_h3_fl2va_pruned_bf16.safetensors",
      "node:TripoSRSampler",
      "background_removal/birefnet.safetensors",
    ]);
  });

  it("pc charswap variant only needs files the pc lists", () => {
    const wf = loadGraph("packs/minimax/character_swap.video.json");
    const classes = Object.values(wf).map((n) => n.class_type);
    expect(classes).not.toContain("LoraLoaderModelOnly");
    expect(classes).toContain("MiniMaxH3SigmaShift");
    const unet = Object.values(wf).find((n) => n.class_type === "UNETLoader")!;
    expect(unet.inputs.unet_name).toBe(
      "minimax_h3_ref2va_turbo11_charswap15_merged_int8_convrot.safetensors",
    );
  });

  it("resolves model-check graphs via the registry template", () => {
    const reg = registry as unknown as Parameters<
      typeof modelCheckWorkflowRel
    >[2];
    // Make 3D defaults to TRELLIS.2 (TripoSR is hidden, opt-in only).
    expect(modelCheckWorkflowRel(undefined, "make_3d", reg)).toBe(
      "packs/trellis2/make_3d_trellis.json",
    );
    expect(modelCheckWorkflowRel(undefined, "video_bg_remove", reg)).toBe(
      "packs/utility/video_bg_remove.json",
    );
    expect(
      modelCheckWorkflowRel("packs/minimax/x.json", "transition", reg),
    ).toBe("packs/minimax/x.json");
    expect(videoVariantRel("packs/minimax/character_swap.json")).toBe(
      "packs/minimax/character_swap.video.json",
    );
  });

  it("a TripoSR graph reports its nodes missing (object_info and offline)", async () => {
    const wf = loadGraph("i23d.json");
    const online = await missingOnDefaultBackend(wf, {
      diskMissing: async () => [],
      objectInfo: async () => ({ LoadImage: {}, SaveGLB: {} }),
      customNodeDirs: async () => [],
    });
    expect(online).toEqual(
      expect.arrayContaining([
        "node:TripoSRModelLoader",
        "node:TripoSRSampler",
      ]),
    );
    const offline = await missingOnDefaultBackend(wf, {
      diskMissing: async () => [],
      objectInfo: async () => null,
      customNodeDirs: async () => ["ComfyUI-Manager"],
    });
    expect(offline).toEqual(
      expect.arrayContaining([
        "node:TripoSRModelLoader",
        "node:TripoSRSampler",
      ]),
    );
    const installed = await missingOnDefaultBackend(wf, {
      diskMissing: async () => [],
      objectInfo: async () => null,
      customNodeDirs: async () => ["ComfyUI-Flowty-TripoSR"],
    });
    expect(installed).toEqual([]);
  });

  it("default backend: disk files kept, object_info adds bg-removal model", async () => {
    const wf = loadGraph("packs/utility/video_bg_remove.json");
    const missing = await missingOnDefaultBackend(wf, {
      diskMissing: async () => ["loras/x.safetensors"],
      objectInfo: async () => {
        const all: Record<string, unknown> = {};
        for (const n of Object.values(wf)) all[n.class_type] = {};
        all.LoadBackgroundRemovalModel = info.LoadBackgroundRemovalModel;
        return all;
      },
      customNodeDirs: async () => [],
    });
    expect(missing).toEqual([
      "loras/x.safetensors",
      "background_removal/birefnet.safetensors",
    ]);
  });
});

describe("default backend: object_info is authoritative for files", () => {
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "a_fp8.safetensors" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "te.safetensors" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "v.safetensors" } },
  } as unknown as Workflow;
  const combo = (input: string, files: string[]) => ({
    input: { required: { [input]: [files] } },
  });
  it("drops disk misses the backend lists (extra_model_paths / remote tree)", async () => {
    const missing = await missingOnDefaultBackend(wf, {
      diskMissing: async () => [
        "diffusion_models/a_fp8.safetensors",
        "text_encoders/te.safetensors",
      ],
      objectInfo: async () => ({
        UNETLoader: combo("unet_name", ["a_fp8.safetensors"]),
        CLIPLoader: combo("clip_name", ["other.safetensors"]),
        VAELoader: combo("vae_name", []),
      }),
      customNodeDirs: async () => [],
    });
    // te: unlisted on the backend too; v: on local disk but not on the backend.
    expect(missing).toEqual([
      "text_encoders/te.safetensors",
      "vae/v.safetensors",
    ]);
  });
  it("offline: disk check alone", async () => {
    const missing = await missingOnDefaultBackend(wf, {
      diskMissing: async () => ["diffusion_models/a_fp8.safetensors"],
      objectInfo: async () => null,
      customNodeDirs: async () => [],
    });
    expect(missing).toEqual(["diffusion_models/a_fp8.safetensors"]);
  });
});

function run(job: Partial<ImagineRun["jobs"][number]>): ImagineRun {
  return {
    id: "r",
    prompt: "p",
    params: {},
    width: 1024,
    height: 576,
    jobs: [{ status: "done", images: [], ...job }],
  } as unknown as ImagineRun;
}

describe("transition builder", () => {
  const base = () => loadGraph("packs/minimax/transition.json");
  const src = run({
    images: ["/api/comfy/view?filename=start.png&subfolder=&type=output"],
  });

  it("wires start + end frames, prompt, length and size", () => {
    const { workflow, seed } = buildTransitionWorkflow(base(), src, 0, {
      endImage: "end.png [input]",
      prompt: "day turns to night",
      length: 100,
      seed: 7,
    });
    expect(seed).toBe(7);
    expect(workflow["15"].inputs.image).toBe("start.png [output]");
    expect(workflow["17"].inputs.image).toBe("end.png [input]");
    const h3 = workflow["5"].inputs;
    expect(h3.prompt).toMatch(/^day turns to night One continuous shot/);
    expect(h3.length).toBe(90);
    expect(h3.width).toBeGreaterThan(h3.height as number);
    expect(Math.min(h3.width as number, h3.height as number)).toBe(768);
    expect(
      Object.values(workflow).some(
        (n) => n.class_type === "LoraLoaderModelOnly",
      ),
    ).toBe(false);
  });

  it("accepts secondRefImage and rejects bad end refs", () => {
    expect(transitionEndRef({ secondRefImage: "e.png [input]" })).toBe(
      "e.png [input]",
    );
    expect(transitionEndRef({ endImage: "../x.png [input]" })).toBeNull();
    expect(transitionEndRef({ endImage: "plain.png" })).toBeNull();
    expect(() => buildTransitionWorkflow(base(), src, 0, {})).toThrow(
      /endImage/,
    );
    expect(() =>
      buildTransitionWorkflow(base(), run({ images: [] }), 0, {
        endImage: "e.png [input]",
      }),
    ).toThrow(/no image/);
  });

  it("snaps length to the 17k+5 grid within [22, 241]", () => {
    expect(transitionLength(undefined)).toBe(73);
    expect(transitionLength(1)).toBe(22);
    expect(transitionLength(39)).toBe(39);
    expect(transitionLength(5000)).toBe(241);
  });
});

describe("video_bg_remove builder", () => {
  const base = () => loadGraph("packs/utility/video_bg_remove.json");
  const src = run({
    videos: ["/api/comfy/view?filename=clip.mp4&subfolder=video&type=output"],
  });
  const classes = (wf: Workflow) => Object.values(wf).map((n) => n.class_type);

  it("defaults to a green-screen mp4 with source audio", () => {
    const { workflow } = buildVideoBgRemoveWorkflow(base(), src, 0, {});
    expect(workflow["1"].inputs.file).toBe("video/clip.mp4 [output]");
    expect(workflow["6"].inputs.color).toBe(0x00ff00);
    expect(classes(workflow)).toContain("SaveVideo");
    expect(classes(workflow)).not.toContain("SaveAnimatedPNG");
  });

  it("chroma colour and alpha branch", () => {
    expect(
      buildVideoBgRemoveWorkflow(base(), src, 0, { background: "blue" })
        .workflow["6"].inputs.color,
    ).toBe(0x0000ff);
    const { workflow } = buildVideoBgRemoveWorkflow(base(), src, 0, {
      background: "alpha",
    });
    expect(classes(workflow)).toContain("SaveAnimatedPNG");
    expect(classes(workflow)).not.toContain("SaveVideo");
    expect(classes(workflow)).not.toContain("EmptyImage");
    // JoinImageWithAlpha inverts its mask: it must get the BACKGROUND mask.
    const join = Object.values(workflow).find(
      (n) => n.class_type === "JoinImageWithAlpha",
    )!;
    const maskNode = workflow[String((join.inputs.alpha as unknown[])[0])];
    expect(maskNode.class_type).toBe("InvertMask");
  });

  it("needs a source video", () => {
    expect(() => buildVideoBgRemoveWorkflow(base(), run({}), 0, {})).toThrow(
      /no video/,
    );
  });
});
