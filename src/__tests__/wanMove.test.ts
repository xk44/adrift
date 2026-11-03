/**
 * Pack "wan22": wan_move (Wan-Move trajectory i2v, core nodes) — track
 * generation, builder over the real graph, registry/pack/tools/hub wiring.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  WAN_MOVE_NODES as N,
  WAN_MOVE_REGIONS,
  WAN_MOVE_TRAJECTORIES,
  buildWanMoveWorkflow,
  getWanMoveTrajectory,
  wanMoveAnchorTracks,
  wanMoveBox,
  wanMovePrompt,
  wanMoveTracks,
} from "@/lib/oj/wanMove";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import registry from "@/lib/oj/registry.json";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES } from "@/lib/tools/hub";

const MOVE: Workflow = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "public/workflows/packs/wan22/wan_move.json"),
    "utf-8",
  ),
);

function run(width = 1024, height = 1024, images = ["src.png"]): ImagineRun {
  return {
    run_id: "r",
    prompt: "",
    parsedPrompt: "",
    width,
    height,
    createdAt: "",
    status: "done",
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "done",
        progress: 100,
        images: images.map(
          (n) => `/api/comfy/view?filename=${n}&subfolder=&type=input`,
        ),
      },
    ],
    params: {},
  } as ImagineRun;
}

const nodesOf = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(([, n]) => n?.class_type === cls);

function linksResolve(wf: Workflow): void {
  for (const [id, node] of Object.entries(wf)) {
    if (id === "_meta") continue;
    for (const v of Object.values(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string") {
        expect(wf[v[0]], `${id} -> ${v[0]}`).toBeDefined();
      }
    }
  }
}

describe("wan_move graph + wiring", () => {
  it("uses the Wan-Move unet, lightx2v LoRA and core track nodes", () => {
    expect(MOVE[N.unet].inputs.unet_name).toBe(
      "Wan21-WanMove_fp8_scaled_e4m3fn_KJ.safetensors",
    );
    expect(MOVE[N.lora].inputs.lora_name).toBe(
      "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
    );
    expect(MOVE[N.tracks].inputs.track_coords).toEqual([N.coords, 0]);
    expect(MOVE[N.move].inputs.tracks).toEqual([N.tracks, 0]);
    expect(nodesOf(MOVE, "CLIPVisionLoader")[0][1].inputs.clip_name).toBe(
      "clip_vision_h.safetensors",
    );
    expect(JSON.stringify(MOVE)).not.toMatch(/\/Users\/|\/home\//);
    linksResolve(MOVE);
  });

  it("is registered in the pack, registry, builders, tools and hub", () => {
    expect(getPack("wan22")?.workflows.wan_move).toBe(
      "packs/wan22/wan_move.json",
    );
    expect(
      resolveWorkflow({ templateOrAction: "wan_move", packId: "wan22" })
        .workflowPath,
    ).toMatch(/wan_move\.json$/);
    const r = registry as unknown as {
      templates: Record<string, { file: string }>;
      actions: Record<string, { template: string; requiresImage: boolean }>;
    };
    expect(r.templates.wan_move.file).toBe("packs/wan22/wan_move.json");
    expect(r.actions.wan_move).toMatchObject({
      template: "wan_move",
      requiresImage: true,
    });
    expect(ACTION_BUILDERS.wan_move).toBe(buildWanMoveWorkflow);
    expect(getActionTool("wan_move")).toMatchObject({
      requiredPack: "wan22",
      modelCheck: { pack: "wan22", action: "wan_move" },
    });
    expect(CARD_OVERRIDES["action:wan_move"]).toBeDefined();
  });

  it("maps pickers/text to builder params", () => {
    const spec = getActionTool("wan_move")!;
    const s = defaultSettings(spec);
    expect(buildActionRequest(spec, s, null)).toEqual({
      action: "wan_move",
      params: {
        pack_id: "wan22",
        trajectory: "slide_left",
        region: "center",
        mode: "fast",
        duration: "5s",
      },
      overrides: {},
    });
    expect(
      buildActionRequest(
        spec,
        {
          ...s,
          text: "the kite",
          picks: { trajectory: "swirl", region: "top" },
        },
        null,
      ).params,
    ).toMatchObject({ trajectory: "swirl", region: "top", prompt: "the kite" });
  });
});

describe("wan_move tracks", () => {
  const slide = getWanMoveTrajectory("slide_left");

  it("has unique preset and region ids, default slide_left", () => {
    const ids = WAN_MOVE_TRAJECTORIES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "slide_left",
        "arc_up",
        "swirl",
        "zoom_in",
        "apart",
      ]),
    );
    expect(getWanMoveTrajectory("nope").id).toBe("slide_left");
    expect(wanMoveBox("nope")).toEqual(WAN_MOVE_REGIONS[0].box);
  });

  it("builds a 4x4 grid of in-frame pixel tracks, one point per frame", () => {
    for (const t of WAN_MOVE_TRAJECTORIES) {
      const tracks = wanMoveTracks(t, wanMoveBox("center"), 832, 480, 49);
      expect(tracks).toHaveLength(16);
      for (const tr of tracks) {
        expect(tr).toHaveLength(49);
        for (const p of tr) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThan(832);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThan(480);
        }
      }
    }
  });

  it("moves points the way the preset says", () => {
    const box = wanMoveBox("center");
    const s = wanMoveTracks(slide, box, 800, 800, 81);
    expect(s[0][80].x).toBeLessThan(s[0][0].x - 250);
    expect(s[0][80].y).toBe(s[0][0].y);
    // Ease-in-out: little motion in the first frames.
    expect(s[0][0].x - s[0][4].x).toBeLessThan(5);

    const z = wanMoveTracks(getWanMoveTrajectory("zoom_in"), box, 800, 800, 81);
    const spread = (f: number) => z[15][f].x - z[0][f].x;
    expect(spread(80)).toBeGreaterThan(spread(0) * 1.5);

    const a = wanMoveTracks(getWanMoveTrajectory("apart"), box, 800, 800, 81);
    expect(a[0][80].x).toBeLessThan(a[0][0].x); // left column goes left
    expect(a[3][80].x).toBeGreaterThan(a[3][0].x); // right column goes right

    const sw = wanMoveTracks(getWanMoveTrajectory("swirl"), box, 800, 800, 81);
    const c = { x: 400, y: 400 };
    const r = (p: { x: number; y: number }) => Math.hypot(p.x - c.x, p.y - c.y);
    expect(Math.abs(r(sw[0][40]) - r(sw[0][0]))).toBeLessThan(3);
    expect(sw[0][80]).not.toEqual(sw[0][0]);

    const up = wanMoveTracks(getWanMoveTrajectory("arc_up"), box, 800, 800, 81);
    expect(Math.min(...up[5].map((p) => p.y))).toBeLessThan(up[5][0].y - 100);
    expect(up[5][80].x).toBeGreaterThan(up[5][0].x);
  });

  it("accepts an explicit normalized box and ignores bad ones", () => {
    expect(wanMoveBox("center", [0.8, 0.9, 0.2, 0.1])).toEqual([
      0.2, 0.1, 0.8, 0.9,
    ]);
    expect(wanMoveBox("left", [0.5, 0.5, 0.5, 0.5])).toEqual(
      WAN_MOVE_REGIONS.find((r) => r.id === "left")!.box,
    );
    expect(wanMoveBox("center", [0, 0, "x", 1])).toEqual(
      WAN_MOVE_REGIONS[0].box,
    );
  });

  it("names the subject in the prompt", () => {
    expect(wanMovePrompt(slide, " the fox ")).toBe(
      "The fox moves smoothly to the left across the frame.",
    );
    expect(wanMovePrompt(slide, "")).toMatch(/^The subject moves/);
  });
});

describe("buildWanMoveWorkflow", () => {
  it("writes tracks, dims, length, prompt and fast sampling", () => {
    const { workflow, seed } = buildWanMoveWorkflow(MOVE, run(1920, 1080), 0, {
      trajectory: "swirl",
      region: "right",
      duration: "3s",
      prompt: "the kite",
      seed: 5,
    });
    expect(seed).toBe(5);
    expect(workflow[N.photo].inputs.image).toBe("src.png [input]");
    expect(workflow[N.pos].inputs.text).toBe(
      "The kite spins around in a swirling circular motion.",
    );
    const { width, height, length } = workflow[N.move].inputs;
    expect({ width, height, length }).toEqual({
      width: 848,
      height: 480,
      length: 49,
    });
    const tracks = JSON.parse(String(workflow[N.coords].inputs.value));
    // 16 subject tracks, then static background anchors
    expect(tracks.length).toBeGreaterThan(16);
    for (const t of tracks.slice(16)) {
      expect(new Set(t.map((q: { x: number; y: number }) => `${q.x},${q.y}`)).size).toBe(1);
    }
    expect(tracks[0]).toHaveLength(49);
    expect(tracks[0][0].x).toBeGreaterThan(848 * 0.6);
    expect(workflow[N.sampler].inputs).toMatchObject({
      steps: 6,
      cfg: 1,
      seed: 5,
    });
    expect(workflow[N.lora]).toBeDefined();
    linksResolve(workflow);
    expect(MOVE[N.coords].inputs.value).toBe("[]");
  });

  it("quality mode drops the distill LoRA", () => {
    const { workflow } = buildWanMoveWorkflow(MOVE, run(), 0, {
      mode: "quality",
    });
    expect(workflow[N.lora]).toBeUndefined();
    expect(workflow[N.shift].inputs.model).toEqual([N.unet, 0]);
    expect(workflow[N.sampler].inputs).toMatchObject({ steps: 20, cfg: 6 });
    expect(workflow[N.move].inputs.length).toBe(81);
    linksResolve(workflow);
  });

  it("needs a source image", () => {
    expect(() =>
      buildWanMoveWorkflow(MOVE, run(1024, 1024, []), 0, {}),
    ).toThrow(/image/);
  });
});

describe("wanMoveAnchorTracks (background pinning)", () => {
  const W = 624, H = 624, F = 49;
  const subject = wanMoveTracks(
    getWanMoveTrajectory("slide_left"),
    wanMoveBox("center", undefined),
    W, H, F,
  );

  it("emits static grid points that stay clear of the swept subject", () => {
    const a = wanMoveAnchorTracks([subject], W, H, F);
    expect(a.length).toBeGreaterThan(50);
    const xs = subject.flatMap((t) => t.map((p) => p.x));
    const ys = subject.flatMap((t) => t.map((p) => p.y));
    const [sx0, sx1] = [Math.min(...xs), Math.max(...xs)];
    const [sy0, sy1] = [Math.min(...ys), Math.max(...ys)];
    for (const t of a) {
      expect(t).toHaveLength(F);
      expect(t.every((p) => p.x === t[0].x && p.y === t[0].y)).toBe(true);
      const { x, y } = t[0];
      expect(x >= sx0 && x <= sx1 && y >= sy0 && y <= sy1).toBe(false);
    }
  });

  it("anchor: false keeps only the subject tracks", () => {
    const { workflow } = buildWanMoveWorkflow(MOVE, run(), 0, { anchor: false, seed: 1 });
    expect(JSON.parse(String(workflow[N.coords].inputs.value))).toHaveLength(16);
  });

  it("a full-frame group leaves no anchors", () => {
    const full = [[{ x: 0, y: 0 }], [{ x: W - 1, y: H - 1 }]];
    expect(wanMoveAnchorTracks([full], W, H, 1)).toHaveLength(0);
  });
});
