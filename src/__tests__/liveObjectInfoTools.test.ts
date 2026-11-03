/**
 * Tools-page graphs vs a LIVE ComfyUI /object_info snapshot.
 *
 * The per-tool suites check their graphs against hand-written node specs,
 * which can drift from what ComfyUI really ships. This suite builds each
 * newer tool end to end (UI settings -> buildActionRequest -> action builder,
 * plus the Smart select preview graphs) and validates every node against an
 * /object_info dump: class installed, required inputs present, no unknown
 * inputs, combo values listed, numbers in range, links in range.
 *
 * Opt-in (needs a running ComfyUI):
 *   curl -s http://127.0.0.1:8188/object_info > /tmp/object_info.json
 *   LIVE_OBJECT_INFO=/tmp/object_info.json vitest run src/__tests__/liveObjectInfoTools.test.ts
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { buildSmartMaskWorkflow } from "@/lib/tools/smartMask";
import { applyH3Speed, FASTH3_RECIPES } from "@/lib/oj/h3Speed";
import {
  buildToolWorkflow,
  getEditTool,
  renderToolPrompt,
  resolveToolLoras,
  resolveToolOptions,
  stripNonNodes,
  toolWorkflowPath,
} from "@/lib/tools/editTools";
import {
  buildFramePreviewWorkflow,
  buildTrackPreviewWorkflow,
  parseSmartTrack,
} from "@/lib/tools/smartTrack";

const INFO_FILE = process.env.LIVE_OBJECT_INFO;
const INFO: Record<string, any> | null =
  INFO_FILE && fs.existsSync(INFO_FILE)
    ? JSON.parse(fs.readFileSync(INFO_FILE, "utf-8"))
    : null;

/** validatePrompt problems + unknown input names (validatePrompt skips those). */
export function liveProblems(
  wf: Workflow,
  info: Record<string, any>,
): string[] {
  const all = validatePrompt(wf, info);
  if (process.env.LIVE_VERBOSE)
    for (const p of all)
      console.log(
        `[live] ${p.classType}.${p.input}: ${p.message.slice(0, 160)}`,
      );
  const out = all
    // Model files differ per machine; installs are checked by model-status.
    .filter(
      (p) =>
        !(
          p.kind === "invalid_combo_value" &&
          /(_name|^name|ckpt|model|checkpoint|lora|vae|clip|unet)/i.test(
            p.input ?? "",
          )
        ),
    )
    .map((p) => `${p.nodeId} ${p.classType}: ${p.message}`);
  for (const [id, node] of Object.entries(wf)) {
    if (id.startsWith("_") || !node?.class_type) continue;
    const def = info[node.class_type];
    if (!def) continue;
    const names = new Set(
      ["required", "optional", "hidden"].flatMap((s) =>
        Object.keys(def.input?.[s] ?? {}),
      ),
    );
    for (const name of Object.keys(node.inputs ?? {})) {
      if (name === "upload") continue;
      if (names.has(name) || names.has(name.split(".")[0])) continue;
      out.push(`${id} ${node.class_type}: unknown input "${name}"`);
    }
  }
  return out;
}

const reg = registry as unknown as {
  actions: Record<string, { template: string }>;
  templates: Record<string, { file: string }>;
};

function baseGraph(action: string): Workflow {
  const file = reg.templates[reg.actions[action].template].file;
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "public/workflows", file),
      "utf-8",
    ),
  ) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).filter(([k]) => !k.startsWith("_")),
  ) as Workflow;
}

const view = (name: string) =>
  `/api/comfy/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;

function srcRun(opts: {
  image?: boolean;
  video?: boolean;
  audio?: boolean;
  params?: Record<string, unknown>;
}): ImagineRun {
  return {
    run_id: "qa",
    prompt: "",
    parsedPrompt: "",
    width: 1280,
    height: 720,
    createdAt: "",
    status: "done",
    params: opts.params ?? {},
    jobs: [
      {
        seed: 1,
        index: 0,
        status: "done",
        progress: 100,
        images: opts.image ? [view("qa_src.png")] : [],
        ...(opts.video ? { videos: [view("qa_clip.mp4")] } : {}),
        ...(opts.audio ? { audios: [view("qa_speech.wav")] } : {}),
      },
    ],
  } as unknown as ImagineRun;
}

const CLICKS = parseSmartTrack([
  { t: 0.5, positive: [{ x: 300, y: 200 }], negative: [{ x: 20, y: 20 }] },
  { t: 2, positive: [{ x: 320, y: 210 }] },
]);

const DRAW = {
  paths: [
    {
      points: [
        { x: 0.2, y: 0.5 },
        { x: 0.5, y: 0.45 },
        { x: 0.8, y: 0.5 },
      ],
    },
  ],
};

interface Case {
  name: string;
  tool: string;
  settings?: Partial<ToolSettings>;
  secondRef?: string;
  audio?: { ref: string; seconds?: number };
  extraRefs?: string[];
  run: ImagineRun;
}

const VIDEO_PARAMS = { video_seconds: 6, audio_seconds: 4.2 };

const CASES: Case[] = [
  {
    name: "video_lipsync text target",
    tool: "video_lipsync",
    settings: { text: "the man on the left" },
    audio: { ref: "qa_speech.wav [input]", seconds: 4.2 },
    run: srcRun({ video: true, audio: true, params: VIDEO_PARAMS }),
  },
  {
    name: "video_lipsync smart select",
    tool: "video_lipsync",
    settings: { smartTrack: CLICKS },
    audio: { ref: "qa_speech.wav [input]", seconds: 9 },
    run: srcRun({
      video: true,
      audio: true,
      params: { video_seconds: 12, audio_seconds: 9 },
    }),
  },
  ...["balanced", "fast"].flatMap((speed): Case[] => [
    {
      name: `video_object_swap text ${speed}`,
      tool: "video_object_swap",
      settings: {
        text: "the red mug",
        secondText: "a blue vase",
        picks: { speed },
      },
      secondRef: "qa_ref.png [input]",
      run: srcRun({ video: true, params: VIDEO_PARAMS }),
    },
    {
      name: `video_object_swap smart select ${speed}`,
      tool: "video_object_swap",
      settings: { smartTrack: CLICKS, picks: { speed, refPrep: "as_is" } },
      secondRef: "qa_ref.png [input]",
      run: srcRun({ video: true, params: VIDEO_PARAMS }),
    },
    {
      name: `video_object_remove smart select ${speed}`,
      tool: "video_object_remove",
      settings: { smartTrack: CLICKS, picks: { speed } },
      run: srcRun({ video: true, params: VIDEO_PARAMS }),
    },
  ]),
  {
    name: "person_remove smart select",
    tool: "person_remove",
    settings: { smartTrack: CLICKS },
    run: srcRun({ video: true, params: VIDEO_PARAMS }),
  },
  ...["off", "fast8"].map(
    (h3Speed): Case => ({
      name: `transition ${h3Speed}`,
      tool: "transition",
      settings: { text: "day turns to night", picks: { h3Speed } },
      secondRef: "qa_end.png [input]",
      run: srcRun({ image: true }),
    }),
  ),
  {
    name: "multiframe_ref 2 keyframes",
    tool: "multiframe_ref",
    secondRef: "qa_end.png [input]",
    run: srcRun({ image: true }),
  },
  {
    name: "multiframe_ref 4 keyframes as refs, custom timing, fast8",
    tool: "multiframe_ref",
    settings: {
      picks: { keysAsRefs: "refs", timing: "custom", h3Speed: "fast8" },
    },
    secondRef: "qa_k2.png [input]",
    extraRefs: ["qa_k3.png [input]", "qa_k4.png [input]"],
    run: srcRun({ image: true }),
  },
  ...["keep", "model"].map(
    (faceDetail): Case => ({
      name: `relight match a reference (faces ${faceDetail})`,
      tool: "relight",
      settings: {
        text: "keep the window frame sharp",
        picks: { preset: "reference", faceDetail },
      },
      secondRef: "qa_light.png [input]",
      run: srcRun({ image: true }),
    }),
  ),
  // Character swap mannequin: Motion guide Pose (default, RT-DETR + SDPose +
  // H3 Fun ControlNet) and Off; pose strength from the slider; 2K finish.
  ...([
    { motionGuide: "pose" },
    { motionGuide: "pose", poseStrength: "60" },
    { motionGuide: "off" },
    // 2K finish (Open-H3-Regenerate + core MiniMaxH3LatentUpscaleWithModel).
    { finish: "2k" },
    { finish: "2k", finishStrength: "70", motionGuide: "off" },
  ] as Record<string, string>[]).map(
    (picks): Case => ({
      name: `character_swap mannequin ${Object.values(picks).join(" ")}`,
      tool: "character_swap",
      settings: { smartTrack: CLICKS, picks: { mode: "mannequin", ...picks } },
      secondRef: "qa_ref.png [input]",
      run: srcRun({ video: true, params: VIDEO_PARAMS }),
    }),
  ),
  {
    name: "h3_charsheet default views, 1 ref",
    tool: "h3_charsheet",
    run: srcRun({ image: true }),
  },
  {
    name: "h3_charsheet every view, 3 refs, Large, Turbo 4-step",
    tool: "h3_charsheet",
    settings: {
      picks: {
        views: "head_front,head_34_right,head_profile_right,head_back,head_profile_left,head_34_left,body_front,body_side,body_back,outfit_front,outfit_back,hands,feet",
        size: "large",
        h3Speed: "turbo4",
      },
    },
    secondRef: "qa_outfit.png [input]",
    extraRefs: ["qa_props.png [input]"],
    run: srcRun({ image: true }),
  },
  {
    name: "wan_move preset",
    tool: "wan_move",
    settings: { text: "the boat" },
    run: srcRun({ image: true }),
  },
  {
    name: "image_to_splat default (.ply)",
    tool: "image_to_splat",
    run: srcRun({ image: true }),
  },
  {
    name: "image_to_splat .spz + mesh",
    tool: "image_to_splat",
    settings: { picks: { format: "spz", mesh: "on" } },
    run: srcRun({ image: true }),
  },
  {
    name: "body_3d photo (mesh overlay, .glb)",
    tool: "body_3d",
    run: srcRun({ image: true }),
  },
  {
    name: "body_3d photo skeleton .bvh",
    tool: "body_3d",
    settings: { picks: { view: "skeleton", file: "bvh" } },
    run: srcRun({ image: true }),
  },
  {
    name: "body_3d_video smoothed",
    tool: "body_3d_video",
    run: srcRun({ video: true, params: VIDEO_PARAMS }),
  },
  {
    name: "body_3d_video raw, body only",
    tool: "body_3d_video",
    settings: { picks: { smooth: "off", view: "solo" } },
    run: srcRun({ video: true, params: VIDEO_PARAMS }),
  },
  {
    name: "see_through defaults",
    tool: "see_through",
    run: srcRun({ image: true }),
  },
  {
    name: "see_through fast, 20 steps, no split, low VRAM",
    tool: "see_through",
    settings: {
      picks: { detail: "fast", steps: "20", split: "off", lowVram: "on" },
      seed: 11,
    },
    run: srcRun({ image: true }),
  },
  {
    name: "moge_geometry photo defaults",
    tool: "moge_geometry",
    run: srcRun({ image: true }),
  },
  {
    name: "moge_geometry panorama, light mesh, colored depth",
    tool: "moge_geometry",
    settings: {
      picks: { source: "panorama", mesh: "light", depth: "colored" },
    },
    run: srcRun({ image: true }),
  },
  {
    name: "moge_geometry no mesh, DirectX normals, fast",
    tool: "moge_geometry",
    settings: { picks: { mesh: "off", normals: "directx", detail: "fast" } },
    run: srcRun({ image: true }),
  },
  {
    name: "moge_geometry MoGe-3 giant",
    tool: "moge_geometry",
    settings: { picks: { model: "moge3" } },
    run: srcRun({ image: true }),
  },
  {
    name: "material_maps all three maps",
    tool: "material_maps",
    run: srcRun({ image: true }),
  },
  {
    name: "material_maps albedo only, high detail",
    tool: "material_maps",
    settings: { picks: { depth: "off", normals: "off", detail: "high" } },
    run: srcRun({ image: true }),
  },
  {
    name: "wan_move free draw",
    tool: "wan_move",
    settings: { picks: { source: "draw" }, wanMoveDraw: DRAW as never },
    run: srcRun({ image: true }),
  },
];

describe.skipIf(!INFO)("tool graphs vs live /object_info", () => {
  it.each(CASES)("$name", (c) => {
    const spec = getActionTool(c.tool);
    expect(spec, c.tool).toBeTruthy();
    const settings = {
      ...defaultSettings(spec),
      ...c.settings,
    } as ToolSettings;
    const req = buildActionRequest(
      spec!,
      settings,
      null,
      c.secondRef,
      c.audio,
      c.extraRefs,
    );
    const builder = actionBuilderFor(req.action);
    expect(builder, req.action).toBeTypeOf("function");
    const { workflow } = builder!(baseGraph(req.action), c.run, 0, req.params);
    expect(liveProblems(workflow, INFO!)).toEqual([]);
  });

  it("H3 fast8 (FastH3): t2v / i2v / r2v pack graphs + DiT files listed", () => {
    const unets: string[] =
      INFO!.UNETLoader?.input?.required?.unet_name?.[1]?.options ??
      INFO!.UNETLoader?.input?.required?.unet_name?.[0] ??
      [];
    for (const r of Object.values(FASTH3_RECIPES))
      expect(unets, r.unet).toContain(r.unet);
    for (const name of ["t2v", "i2v", "r2v"]) {
      const wf = Object.fromEntries(
        Object.entries(
          JSON.parse(
            fs.readFileSync(
              path.join(
                process.cwd(),
                "public/workflows/packs/minimax",
                `${name}.json`,
              ),
              "utf-8",
            ),
          ) as Record<string, unknown>,
        ).filter(([k]) => !k.startsWith("_")),
      ) as Workflow;
      expect(applyH3Speed(wf, { h3Speed: "fast8" }), name).toHaveLength(3);
      expect(liveProblems(wf, INFO!), name).toEqual([]);
    }
  });

  it("pipeline_script (shorts, ad with product image)", () => {
    const b = actionBuilderFor("pipeline_script")!;
    for (const [run, params] of [
      [srcRun({}), { kind: "shorts", topic: "how tides work", scenes: 4 }],
      [
        srcRun({ image: true }),
        { kind: "ad", topic: "a ceramic mug", scenes: 5, preset: "luxury" },
      ],
    ] as const) {
      const { workflow } = b(baseGraph("pipeline_script"), run, 0, {
        ...params,
      });
      expect(liveProblems(workflow, INFO!)).toEqual([]);
    }
  });

  it("pipeline_assemble (narration + captions + music)", () => {
    const scene = (i: number, seconds: number) => ({
      video: `video/clip${i}_00001_.mp4 [output]`,
      audio: `audio/voice${i}_00001_.mp3 [output]`,
      caption: `Scene ${i} caption`,
      clipSeconds: 4.04,
      seconds,
    });
    const { workflow } = actionBuilderFor("pipeline_assemble")!(
      baseGraph("pipeline_assemble"),
      srcRun({}),
      0,
      {
        scenes: [
          scene(0, 4),
          scene(1, 6.5),
          { ...scene(2, 3), audio: undefined },
        ],
        music: "audio/bed_00001_.mp3 [output]",
        size: "1080x1920",
        fps: 24,
      },
    );
    expect(liveProblems(workflow, INFO!)).toEqual([]);
  });

  // Needs comfy_nodes/cj_h3_tools (CJGridVideo) deployed on the box.
  it("grid_video (poster grid, music soundtrack)", () => {
    const { workflow } = actionBuilderFor("grid_video")!(
      baseGraph("grid_video"),
      srcRun({}),
      0,
      {
        source: "cj_clip_lint.mp4 [input]",
        sourceKind: "video",
        sourceSeconds: 15,
        audio: "cj_audio_lint.mp3 [input]",
        audioSeconds: 40,
        beats: Array.from({ length: 80 }, (_, i) => 0.47 * (i + 1)),
        bpm: 128,
        style: "poster",
        aspect: "1:1",
        gridMax: 4,
        intensity: "high",
        seed: 7,
      },
    );
    expect(liveProblems(workflow, INFO!)).toEqual([]);
  });

  // Needs comfy_nodes/cj_h3_tools (CJVideoPalette) deployed on the box.
  it("video_palette (hex palette, keep luminance, skin protect)", () => {
    const { workflow } = actionBuilderFor("video_palette")!(
      baseGraph("video_palette"),
      srcRun({ video: true }),
      0,
      {
        source: "hex",
        palette: "#0b3c49, #1f7a8c:2, #e07a2f",
        strength: 0.8,
        preserveLuminance: true,
        skinProtect: 0.85,
      },
    );
    expect(liveProblems(workflow, INFO!)).toEqual([]);
  });

  it.each([
    ["qwen21-remove-bg", {}, undefined],
    ["qwen2511-camera", {}, "keep the scarf"],
    ["qwen2511-camera", { fast: false, azimuth: "back", elevation: "low-angle", distance: "wide" }, ""],
  ] as const)("edit tool %s %j", (id, options, prompt) => {
    const t = getEditTool(id)!;
    expect(t, id).toBeTruthy();
    const o = resolveToolOptions(t, options);
    const base = stripNonNodes(
      JSON.parse(
        fs.readFileSync(
          path.join(process.cwd(), "public/workflows", toolWorkflowPath(t, undefined)),
          "utf-8",
        ),
      ),
    );
    const wf = buildToolWorkflow({
      workflow: base,
      tool: t,
      prompt: renderToolPrompt(t, prompt, o.choices),
      loras: resolveToolLoras(t, o),
      steps: o.steps,
      cfg: o.cfg,
      seed: 1,
      imageRefs: ["qa_src.png [input]"],
      latent: { width: 1024, height: 1024 },
      choices: o.choices,
    });
    expect(liveProblems(wf, INFO!)).toEqual([]);
  });

  it("Smart select graphs (image mask, frame preview, track preview)", () => {
    const graphs = [
      buildSmartMaskWorkflow({
        image: "qa_src.png [input]",
        include: [{ x: 10, y: 10 }],
        exclude: [{ x: 50, y: 50 }],
      }),
      buildFramePreviewWorkflow(
        "qa_clip.mp4 [input]",
        1.5,
        CLICKS[0].positive,
        [],
      ),
      buildTrackPreviewWorkflow("qa_clip.mp4 [input]", CLICKS, 6, {
        saveMasks: true,
      }),
    ];
    for (const wf of graphs) expect(liveProblems(wf, INFO!)).toEqual([]);
  });
});
