/**
 * Open-weights camera move catalog (lib/oj/cameraMoveCatalog.ts): table
 * shape, prompt helpers, and its wiring as LoRA-free wan_motion presets with
 * an "auto" length and grouped, searchable picker entries.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  CAMERA_MOVES,
  CAMERA_MOVE_GROUPS,
  cameraMovePrompt,
  getCameraMove,
  withCameraMove,
} from "@/lib/oj/cameraMoveCatalog";
import {
  CAMERA_CATALOG_PRESETS,
  WAN_MOTION_PRESETS,
  getWanMotionPreset,
  wanMotionLength,
} from "@/lib/oj/wanMotionPresets";
import { WAN_NODES, buildWanMotionWorkflow } from "@/lib/oj/wanMotion";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { choiceGroups, filterChoiceGroups } from "@/lib/tools/choiceGroups";

const motionWf = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows/packs/wan22/wan_motion.json"),
      "utf8",
    ),
  ) as Workflow;

function run(): ImagineRun {
  return {
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 576,
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

const presetPicker = () =>
  getActionTool("wan_motion")!.pickers!.find((p) => p.key === "preset")!;

describe("camera move catalog table", () => {
  it("has 100+ distinct named moves with unique ids and labels", () => {
    expect(CAMERA_MOVES.length).toBeGreaterThanOrEqual(100);
    expect(new Set(CAMERA_MOVES.map((m) => m.id)).size).toBe(
      CAMERA_MOVES.length,
    );
    expect(new Set(CAMERA_MOVES.map((m) => m.label.toLowerCase())).size).toBe(
      CAMERA_MOVES.length,
    );
    for (const m of CAMERA_MOVES) expect(m.id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("every group is used, in picker order, and contiguous", () => {
    const order = CAMERA_MOVE_GROUPS.map((g) => g.id);
    const seen: string[] = [];
    for (const m of CAMERA_MOVES)
      if (seen[seen.length - 1] !== m.group) seen.push(m.group);
    expect(seen).toEqual(order);
    for (const g of order)
      expect(
        CAMERA_MOVES.filter((m) => m.group === g).length,
        g,
      ).toBeGreaterThanOrEqual(5);
  });

  it("covers the core cinematography vocabulary", () => {
    const text = CAMERA_MOVES.map((m) => m.prompt.toLowerCase()).join(" ");
    for (const term of [
      "dollies",
      "crane",
      "jib",
      "whips",
      "fpv",
      "racks",
      "vertigo",
      "orbit",
      "handheld",
      "zoom",
      "time stops",
      "drone",
      "dutch",
    ])
      expect(text, term).toContain(term);
  });

  it("prompts are clean single-move fragments with a subject slot", () => {
    for (const m of CAMERA_MOVES) {
      expect(m.prompt, m.id).toContain("{s}");
      expect(m.prompt, m.id).toMatch(/\.$/);
      expect([3, 5, 8], m.id).toContain(m.seconds);
      // No LoRA trigger tokens (digits inside words) and no H3 references.
      expect(m.prompt, m.id).not.toMatch(/[a-z]\d|\d[a-z]/i);
      expect(m.prompt.toLowerCase(), m.id).not.toMatch(/\bh3\b|hunyuan/);
    }
    // Snaps / whips read best short; slow reveals get the long length.
    expect(getCameraMove("whip_left")!.seconds).toBe(3);
    expect(getCameraMove("pull_reveal")!.seconds).toBe(8);
  });
});

describe("camera move prompt helpers", () => {
  it("slots and capitalizes the subject", () => {
    const m = getCameraMove("locked_off")!;
    expect(cameraMovePrompt(m, "a red fox.")).toBe(
      "Static locked-off camera on a tripod, no camera movement at all, only a red fox moves.",
    );
    const frozen = cameraMovePrompt(getCameraMove("frozen_sweep")!, "a dancer");
    expect(frozen.startsWith("Time stops: A dancer hangs")).toBe(true);
    expect(cameraMovePrompt(m)).toContain("only the main subject moves");
    expect(getCameraMove("nope")).toBeUndefined();
    expect(getCameraMove(42)).toBeUndefined();
  });

  it("withCameraMove appends to a free prompt", () => {
    expect(withCameraMove("a cat on a roof", "slow_push", "the cat")).toBe(
      "a cat on a roof. The camera dollies slowly and steadily forward toward the cat on a smooth track, the framing tightening from a medium shot to a close-up.",
    );
    expect(withCameraMove("Rain falls!", "locked_off")).toMatch(
      /^Rain falls! Static locked-off/,
    );
    expect(withCameraMove("  ", "locked_off")).toMatch(/^Static locked-off/);
    expect(withCameraMove("keep me", "unknown")).toBe("keep me");
  });
});

describe("catalog as wan_motion presets", () => {
  it("adds one LoRA-free Wan 2.2 camera preset per move", () => {
    expect(CAMERA_CATALOG_PRESETS).toHaveLength(CAMERA_MOVES.length);
    for (const p of CAMERA_CATALOG_PRESETS) {
      expect(p.id.startsWith("cam_")).toBe(true);
      expect(p.category).toBe("camera");
      expect(p.base).toBe("wan22");
      expect(p.loras).toEqual([]);
      expect(p.group).toBeTruthy();
      expect(WAN_MOTION_PRESETS).toContain(p);
    }
    const cameraIds = WAN_MOTION_PRESETS.filter(
      (p) => p.category === "camera",
    ).map((p) => p.id);
    expect(cameraIds.length).toBeGreaterThanOrEqual(100);
  });

  it("builds a LoRA-free graph with the move prompt and auto length", () => {
    const { workflow } = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "cam_fpv_dive",
      prompt: "a surfer",
      duration: "auto",
    });
    const text = String(workflow[WAN_NODES.pos].inputs.text);
    expect(text).toContain("dives steeply");
    expect(text).toContain("a surfer");
    expect(text).not.toContain("{s}");
    for (const n of Object.values(workflow))
      if (n.class_type === "LoraLoaderModelOnly")
        expect(String(n.inputs.lora_name ?? "")).not.toContain("wan_motion/");
    expect(workflow[WAN_NODES.i2v].inputs.length).toBe(81);

    const whip = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "cam_whip_left",
    }).workflow;
    expect(whip[WAN_NODES.i2v].inputs.length).toBe(49);
    const forced = buildWanMotionWorkflow(motionWf(), run(), 0, {
      preset: "cam_whip_left",
      duration: "5s",
    }).workflow;
    expect(forced[WAN_NODES.i2v].inputs.length).toBe(81);
  });

  it("auto length keeps 5 s for LoRA presets", () => {
    expect(wanMotionLength(getWanMotionPreset("orbit_360"), "auto")).toBe(81);
    expect(wanMotionLength(getWanMotionPreset("cam_pull_reveal"), "auto")).toBe(
      81,
    );
    expect(wanMotionLength(getWanMotionPreset("cam_snap_zoom_in"), "3s")).toBe(
      49,
    );
  });

  it("picker groups every catalog move and search finds them", () => {
    const picker = presetPicker();
    const ids = new Set(picker.options.map((o) => o.id));
    for (const p of CAMERA_CATALOG_PRESETS) expect(ids).toContain(p.id);
    const groups = choiceGroups(picker.options);
    for (const g of CAMERA_MOVE_GROUPS)
      expect(groups.map((x) => x.group)).toContain(`Camera · ${g.label}`);
    const aerial = filterChoiceGroups(groups, "drone");
    expect(aerial.map((g) => g.group)).toContain("Camera · Drone & aerial");
    const vertigo = filterChoiceGroups(groups, "vertigo");
    expect(vertigo.flatMap((g) => g.options.map((o) => o.id))).toEqual(
      expect.arrayContaining(["cam_vertigo_in", "cam_vertigo_out"]),
    );
  });

  it("tool request sends the picked move and the auto length", () => {
    const spec = getActionTool("wan_motion")!;
    const lengthPicker = spec.pickers!.find((p) => p.key === "duration")!;
    expect(lengthPicker.options[0].id).toBe("auto");
    const settings = defaultSettings(spec);
    settings.picks = { ...settings.picks, preset: "cam_orbit_fast" };
    const req = buildActionRequest(spec, settings, null);
    expect(req.params).toMatchObject({
      preset: "cam_orbit_fast",
      duration: "auto",
    });
    // Other Wan tools keep the plain 5 s / 3 s length picker.
    const cam = getActionTool("wan_camera")!;
    expect(cam.pickers!.find((p) => p.key === "duration")!.options[0].id).toBe(
      "5s",
    );
  });
});
