/**
 * Pack "wan22": motion presets (wan_motion) + Fun Camera control (wan_camera).
 * Pure builders over the real pack graphs, preset table coverage, and the
 * registry / pack / tools-page / hub wiring.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  WAN_NODES,
  buildWanCameraWorkflow,
  buildWanMotionWorkflow,
} from "@/lib/oj/wanMotion";
import {
  DEFAULT_WAN_MOTION_PRESET,
  WAN_CAMERA_POSES,
  WAN_EFFECT_SECTIONS,
  WAN_MOTION_PRESETS,
  getWanCameraPose,
  getWanMotionPreset,
  wanCameraPrompt,
  wanCameraSpeed,
  wanDims,
  wanLength,
  wanMotionPrompt,
} from "@/lib/oj/wanMotionPresets";
import { CAMERA_MOVE_GROUPS } from "@/lib/oj/cameraMoveCatalog";
import { getPack, resolveWorkflow } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { DEFAULT_VIDEO_PACKS } from "@/lib/comfy/backends";
import {
  ACTION_TOOLS,
  buildActionRequest,
  defaultSettings,
  getActionTool,
  groupOptions,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES } from "@/lib/tools/hub";
import registry from "@/lib/oj/registry.json";

const WF_ROOT = path.join(process.cwd(), "public/workflows");
const load = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(WF_ROOT, rel), "utf8")) as Workflow;
const motionWf = () => load("packs/wan22/wan_motion.json");
const cameraWf = () => load("packs/wan22/wan_camera.json");

function run(width = 1024, height = 1024): ImagineRun {
  return {
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width,
    height,
    jobs: [
      {
        seed: 0,
        index: 0,
        status: "complete",
        progress: 100,
        images: ["/api/comfy/view?filename=src.png&subfolder=&type=output"],
      },
    ],
    createdAt: "",
    status: "complete",
    params: {},
  } as unknown as ImagineRun;
}

/** Every LoRA in pc loras/wan_motion/ (2026-10-23). */
const PC_WAN_MOTION_FILES = [
  "360_Orbit.safetensors",
  "Arc_shot.safetensors",
  "Hero_run.safetensors",
  "Wan21_I2V_rotation_000003750.safetensors",
  "boxing_10_epochs.safetensors",
  "cakeify_16_epochs.safetensors",
  "car_chase.safetensors",
  "crane_down.safetensors",
  "crane_overhead.safetensors",
  "crane_up.safetensors",
  "crash_zoom_in.safetensors",
  "crash_zoom_out.safetensors",
  "crush_20_epochs.safetensors",
  "dolly_25_epochs.safetensors",
  "electrify_50_epochs.safetensors",
  "explode_30_epochs.safetensors",
  "eye_10_epochs.safetensors",
  "fire_12_epochs.safetensors",
  "fisheye_15_epochs.safetensors",
  "fus_ro_dah_20_epochs.safetensors",
  "inflate_20_epochs.safetensors",
  "jumpscare_35_epochs.safetensors",
  "kissing_30_epochs.safetensors",
  "matrix_shot.safetensors",
  "motionpushin-v5-wan-i2v-14b-720p-400.safetensors",
  "muscle_18_epochs.safetensors",
  "pov_driving_5_epochs.safetensors",
  "rotate_20_epochs.safetensors",
  "squish_18.safetensors",
  "tornado_10_epochs.safetensors",
  "tsunami_4_epochs.safetensors",
  "ultra_wide_5_epochs.safetensors",
  "wan22_14b_i2v_orbit_high_noise.safetensors",
  "wan22_14b_i2v_orbit_low_noise.safetensors",
]
  .map((f) => `wan_motion/${f}`)
  .concat(
    // Effect LoRAs in loras/wan2x/effects/ (the wan21 boxing / crash_zoom_out /
    // explode copies there duplicate wan_motion/ and stay unused).
    [
      "wan22/effects/Disintegration_Redmond_high_noise.safetensors",
      "wan22/effects/Disintegration_Redmond_low_noise.safetensors",
      "wan22/effects/Explosion_Redmond_high_noise.safetensors",
      "wan22/effects/Explosion_Redmond_low_noise.safetensors",
      "wan22/effects/Metalcification_Redmond_high_noise.safetensors",
      "wan22/effects/Metalcification_Redmond_low_noise.safetensors",
      "wan21/effects/robot_face_reveal_35_epochs.safetensors",
    ],
  );

/** All links in a graph point at nodes that exist. */
function danglingLinks(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && typeof v[0] === "string" && !wf[v[0]]) {
        out.push(`${id}.${k}->${v[0]}`);
      }
    }
  }
  return out;
}

const loras = (wf: Workflow) =>
  Object.values(wf)
    .filter((n) => n.class_type === "LoraLoaderModelOnly")
    .map((n) => n.inputs.lora_name);

describe("wan motion preset table", () => {
  it("has unique ids and covers every pc wan_motion LoRA", () => {
    const ids = WAN_MOTION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const used = new Set(WAN_MOTION_PRESETS.flatMap((p) => p.loras));
    for (const f of PC_WAN_MOTION_FILES) expect(used, f).toContain(f);
    for (const f of used) expect(PC_WAN_MOTION_FILES).toContain(f);
  });

  it("matches LoRA count to base and keeps a prompt-only preset", () => {
    for (const p of WAN_MOTION_PRESETS) {
      if (p.base === "wan21") expect(p.loras, p.id).toHaveLength(1);
      else expect([0, 2], p.id).toContain(p.loras.length);
      expect(p.prompt, p.id).toContain("{s}");
      expect(p.strength).toBeGreaterThan(0);
    }
    const none = getWanMotionPreset("none");
    expect(none.category).toBe("none");
    expect(none.loras).toEqual([]);
    expect(getWanMotionPreset("orbit_360_wan22").loras).toHaveLength(2);
  });

  it("falls back to the default preset", () => {
    expect(getWanMotionPreset("nope").id).toBe(DEFAULT_WAN_MOTION_PRESET);
    expect(getWanMotionPreset(undefined).id).toBe(DEFAULT_WAN_MOTION_PRESET);
  });

  it("slots the subject and capitalises sentence starts", () => {
    const squish = getWanMotionPreset("squish");
    expect(wanMotionPrompt(squish, "a red bicycle.")).toContain(
      "a red bicycle",
    );
    expect(wanMotionPrompt(squish, "a red bicycle")).not.toContain("{s}");
    const none = getWanMotionPreset("none");
    expect(wanMotionPrompt(none, "")).toMatch(/^The main subject moves/);
    expect(wanMotionPrompt(none, "a fox runs.")).toBe("a fox runs");
  });
});

describe("wan dims / length", () => {
  it("follows the source aspect, snapped to 16", () => {
    expect(wanDims("480p", 1024, 1024)).toEqual({ width: 624, height: 624 });
    const land = wanDims("480p", 1920, 1080);
    expect(land.width).toBeGreaterThan(land.height);
    expect(land.width % 16).toBe(0);
    expect(land.height % 16).toBe(0);
    const hd = wanDims("720p", 1024, 1024);
    expect(hd.width).toBeGreaterThan(900);
    // unknown / unset resolution falls back to the 720p default
    expect(wanDims(undefined, 1024, 1024)).toEqual(hd);
    // extreme aspect clamps to 21:9
    const wide = wanDims("480p", 4000, 100);
    expect(wide.width / wide.height).toBeLessThan(2.5);
  });
  it("maps duration to frame count", () => {
    expect(wanLength("5s")).toBe(81);
    expect(wanLength("3s")).toBe(49);
    expect(wanLength(undefined)).toBe(81);
  });
});

describe("buildWanMotionWorkflow", () => {
  it("wan21 preset: keeps only the 2.1 branch with distill + motion LoRA", () => {
    const { workflow, seed } = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "squish",
      prompt: "a red bicycle",
      seed: 7,
    });
    expect(seed).toBe(7);
    expect(workflow[WAN_NODES.unetHi]).toBeUndefined();
    expect(workflow[WAN_NODES.samplerLo]).toBeUndefined();
    expect(workflow[WAN_NODES.lora21].inputs.lora_name).toBe(
      "wan_motion/squish_18.safetensors",
    );
    expect(workflow[WAN_NODES.sampler21].inputs).toMatchObject({
      seed: 7,
      steps: 4,
      cfg: 1,
    });
    expect(workflow[WAN_NODES.decode].inputs.samples).toEqual([
      WAN_NODES.sampler21,
      0,
    ]);
    expect(workflow[WAN_NODES.i2v].inputs).toMatchObject({
      width: 960,
      height: 960,
      length: 81,
    });
    expect(workflow[WAN_NODES.image].inputs.image).toBe("src.png [output]");
    expect(String(workflow[WAN_NODES.pos].inputs.text)).toContain(
      "a red bicycle",
    );
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("wan21 quality: drops the distill LoRA and samples 20 steps", () => {
    const { workflow } = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "orbit_360",
      mode: "quality",
    });
    expect(workflow[WAN_NODES.distill21]).toBeUndefined();
    expect(workflow[WAN_NODES.lora21].inputs.model).toEqual([
      WAN_NODES.unet21,
      0,
    ]);
    expect(workflow[WAN_NODES.sampler21].inputs).toMatchObject({
      steps: 20,
      cfg: 5,
    });
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("wan22 preset: hi/lo LoRA pair, split sampler, no clip vision", () => {
    const { workflow } = buildWanMotionWorkflow(motionWf(), run(1280, 720), 0, {
      preset: "orbit_360_wan22",
      seed: 3,
      duration: "3s",
    });
    expect(workflow[WAN_NODES.unet21]).toBeUndefined();
    expect(workflow[WAN_NODES.clipVision]).toBeUndefined();
    expect(workflow[WAN_NODES.i2v].inputs.clip_vision_output).toBeUndefined();
    expect(loras(workflow)).toEqual(
      expect.arrayContaining([
        "wan_motion/wan22_14b_i2v_orbit_high_noise.safetensors",
        "wan_motion/wan22_14b_i2v_orbit_low_noise.safetensors",
      ]),
    );
    expect(workflow[WAN_NODES.samplerHi].inputs).toMatchObject({
      noise_seed: 3,
      steps: 4,
      end_at_step: 2,
    });
    expect(workflow[WAN_NODES.samplerLo].inputs.start_at_step).toBe(2);
    expect(workflow[WAN_NODES.decode].inputs.samples).toEqual([
      WAN_NODES.samplerLo,
      0,
    ]);
    const i2v = workflow[WAN_NODES.i2v].inputs;
    expect(i2v.length).toBe(49);
    expect(Number(i2v.width)).toBeGreaterThan(Number(i2v.height));
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("effect presets wire the wan2x/effects LoRAs on the right branch", () => {
    const dis = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "disintegrate",
      prompt: "a stone statue",
    }).workflow;
    expect(dis[WAN_NODES.unet21]).toBeUndefined();
    expect(dis[WAN_NODES.loraHi].inputs.lora_name).toBe(
      "wan22/effects/Disintegration_Redmond_high_noise.safetensors",
    );
    expect(dis[WAN_NODES.loraLo].inputs.lora_name).toBe(
      "wan22/effects/Disintegration_Redmond_low_noise.safetensors",
    );
    expect(String(dis[WAN_NODES.pos].inputs.text)).toMatch(
      /^Disintegration\. A stone statue/,
    );
    expect(danglingLinks(dis)).toEqual([]);
    for (const id of ["explosion_wan22", "metal"]) {
      const wf = buildWanMotionWorkflow(motionWf(), run(), 0, {
        preset: id,
      }).workflow;
      expect(
        loras(wf).filter((l) => String(l).startsWith("wan22/effects/")),
      ).toHaveLength(2);
    }
    expect(
      String(
        buildWanMotionWorkflow(motionWf(), run(), 0, {
          preset: "explosion_wan22",
        }).workflow[WAN_NODES.pos].inputs.text,
      ),
    ).toContain("EXPLOSION");
    const robot = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "robot_face_reveal",
    }).workflow;
    expect(robot[WAN_NODES.unetHi]).toBeUndefined();
    expect(robot[WAN_NODES.lora21].inputs.lora_name).toBe(
      "wan21/effects/robot_face_reveal_35_epochs.safetensors",
    );
    expect(String(robot[WAN_NODES.pos].inputs.text)).toContain("r8b8t1c");
    expect(danglingLinks(robot)).toEqual([]);
  });

  it("none preset: no motion LoRAs, speed LoRAs kept; quality drops them", () => {
    const fast = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "none",
    }).workflow;
    expect(loras(fast).every((l) => String(l).startsWith("wan_speed/"))).toBe(
      true,
    );
    expect(loras(fast)).toHaveLength(2);
    expect(danglingLinks(fast)).toEqual([]);
    const q = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "none",
      mode: "quality",
    }).workflow;
    expect(loras(q)).toEqual([]);
    expect(q[WAN_NODES.samplerHi].inputs.steps).toBe(20);
    expect(danglingLinks(q)).toEqual([]);
  });

  it("throws without a source image", () => {
    const r = run();
    r.jobs[0].images = [];
    expect(() => buildWanMotionWorkflow(motionWf(), r, 0, {})).toThrow(
      /no image/,
    );
  });
});

describe("buildWanCameraWorkflow", () => {
  it("sets pose, speed and dims on the camera embedding", () => {
    const { workflow } = buildWanCameraWorkflow(cameraWf(), run(), 0, {
      camera: "pan_right",
      cameraSpeed: "slow",
      prompt: "A leopard rests",
      seed: 9,
    });
    expect(workflow[WAN_NODES.cameraEmbed].inputs).toMatchObject({
      camera_pose: "Pan Right",
      speed: 0.5,
      width: 960,
      height: 960,
      length: 81,
    });
    expect(workflow[WAN_NODES.samplerHi].inputs.noise_seed).toBe(9);
    expect(String(workflow[WAN_NODES.pos].inputs.text)).toMatch(
      /^A leopard rests, /,
    );
    expect(loras(workflow)).toHaveLength(2);
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("fast mode samples 8 steps split 4/8 with the speed LoRAs", () => {
    const { workflow } = buildWanCameraWorkflow(cameraWf(), run(), 0, {});
    expect(workflow[WAN_NODES.samplerHi].inputs).toMatchObject({
      steps: 8,
      cfg: 1,
      end_at_step: 4,
    });
    expect(workflow[WAN_NODES.samplerLo].inputs).toMatchObject({
      steps: 8,
      start_at_step: 4,
    });
    expect(workflow[WAN_NODES.shiftHi].inputs.shift).toBe(8);
    expect(loras(workflow)).toHaveLength(2);
  });

  it("quality mode bypasses the speed LoRAs", () => {
    const { workflow } = buildWanCameraWorkflow(cameraWf(), run(), 0, {
      mode: "quality",
    });
    expect(loras(workflow)).toEqual([]);
    expect(workflow[WAN_NODES.samplerLo].inputs.start_at_step).toBe(10);
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("covers every WanCameraEmbedding pose", () => {
    expect(WAN_CAMERA_POSES.map((p) => p.pose).sort()).toEqual(
      [
        "Static",
        "Pan Up",
        "Pan Down",
        "Pan Left",
        "Pan Right",
        "Zoom In",
        "Zoom Out",
        "Anti Clockwise (ACW)",
        "ClockWise (CW)",
      ].sort(),
    );
    expect(getWanCameraPose("Zoom Out").id).toBe("zoom_out");
    expect(getWanCameraPose("bogus").id).toBe(WAN_CAMERA_POSES[0].id);
    expect(wanCameraSpeed("fast")).toBe(2);
    expect(wanCameraSpeed(99)).toBe(10);
    expect(wanCameraPrompt(getWanCameraPose("zoom_in"))).toMatch(
      /^The scene comes to life/,
    );
  });
});

describe("wan22 wiring", () => {
  it("registry, pack and action builders agree", () => {
    for (const id of ["wan_motion", "wan_camera"]) {
      const resolved = resolveWorkflow({
        templateOrAction: id,
        packId: "wan22",
      });
      expect(resolved.workflowPath).toBe(`packs/wan22/${id}.json`);
      expect(actionBuilderFor(id)).toBeTypeOf("function");
      const action = (
        registry as unknown as {
          actions: Record<string, { requiresImage?: boolean }>;
        }
      ).actions[id];
      expect(action.requiresImage).toBe(true);
    }
    const pack = getPack("wan22");
    expect(pack?.workflows).toMatchObject({
      wan_motion: "packs/wan22/wan_motion.json",
      wan_camera: "packs/wan22/wan_camera.json",
    });
    expect(DEFAULT_VIDEO_PACKS).toContain("wan22");
  });

  it("pack graphs carry no personal paths and save video", () => {
    for (const rel of [
      "packs/wan22/wan_motion.json",
      "packs/wan22/wan_camera.json",
    ]) {
      const raw = fs.readFileSync(path.join(WF_ROOT, rel), "utf8");
      expect(raw).not.toMatch(/\/Users\/|\/home\/|\/mnt\//);
      const wf = JSON.parse(raw) as Workflow;
      expect(wf[WAN_NODES.save].class_type).toMatch(/Save/);
    }
  });

  it("tools page specs build the action request the builder expects", () => {
    expect(ACTION_TOOLS.map((t) => t.id)).toEqual(
      expect.arrayContaining(["wan_motion", "wan_camera"]),
    );
    const motion = getActionTool("wan_motion")!;
    const presetPicker = motion.pickers?.find((p) => p.key === "preset");
    expect(presetPicker?.options.map((o) => o.id).sort()).toEqual(
      WAN_MOTION_PRESETS.map((p) => p.id).sort(),
    );
    const req = buildActionRequest(
      motion,
      { ...defaultSettings(motion), text: "a fox" },
      null,
    );
    expect(req.action).toBe("wan_motion");
    expect(req.params).toMatchObject({
      pack_id: "wan22",
      preset: presetPicker?.options[0].id,
      mode: "fast",
      resolution: "720p",
      duration: "auto",
      prompt: "a fox",
    });

    const camera = getActionTool("wan_camera")!;
    const camReq = buildActionRequest(camera, defaultSettings(camera), null);
    expect(camReq.params).toMatchObject({
      pack_id: "wan22",
      camera: "zoom_in",
      cameraSpeed: "normal",
    });
    expect(camReq.params.prompt).toBeUndefined();
  });

  it("effects are sorted into Viral / UGC / Commercial dropdown groups", () => {
    const sectionIds = WAN_EFFECT_SECTIONS.map((s) => s.id);
    const effects = WAN_MOTION_PRESETS.filter((p) => p.category === "effect");
    expect(effects.length).toBeGreaterThanOrEqual(100);
    for (const p of effects) expect(sectionIds).toContain(p.section);
    for (const sec of sectionIds)
      expect(
        effects.filter((p) => p.section === sec).length,
      ).toBeGreaterThanOrEqual(10);
    expect(new Set(WAN_MOTION_PRESETS.map((p) => p.label)).size).toBe(
      WAN_MOTION_PRESETS.length,
    );
    const picker = getActionTool("wan_motion")!.pickers!.find(
      (p) => p.key === "preset",
    )!;
    expect(picker.dropdown).toBe(true);
    expect(groupOptions(picker.options).map((g) => g.group)).toEqual([
      "Camera",
      ...CAMERA_MOVE_GROUPS.map((g) => `Camera · ${g.label}`),
      ...WAN_EFFECT_SECTIONS.map((s) => s.label),
      "Prompt only",
    ]);
  });

  it("prompt-steered effects run LoRA-free on the lightx2v path", () => {
    const steered = WAN_MOTION_PRESETS.filter(
      (p) => p.category === "effect" && p.loras.length === 0,
    );
    expect(steered.length).toBeGreaterThanOrEqual(80);
    for (const p of steered) {
      expect(p.base).toBe("wan22");
      expect(p.prompt).toContain("{s}");
    }
    const { workflow } = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "angel_wings",
      prompt: "a dancer",
    });
    expect(loras(workflow)).toHaveLength(2);
    expect(
      Object.values(workflow).some(
        (n) =>
          n.class_type === "LoraLoaderModelOnly" &&
          !String(n.inputs.lora_name ?? ""),
      ),
    ).toBe(false);
    expect(String(workflow[WAN_NODES.pos].inputs.text)).toMatch(/a dancer/i);
    expect(String(workflow[WAN_NODES.pos].inputs.text)).not.toContain("{s}");
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("hub cards land in the Video hub", () => {
    expect(CARD_OVERRIDES["action:wan_motion"].hub).toBe("Video");
    expect(CARD_OVERRIDES["action:wan_camera"].hub).toBe("Video");
  });
});
