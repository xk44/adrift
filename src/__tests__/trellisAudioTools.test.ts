import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { getPack } from "@/lib/oj/packs";
import { actionBuilderFor } from "@/lib/oj/actionBuilders";
import { routeBackend } from "@/lib/comfy/backends";
import {
  buildMake3dTrellisWorkflow,
  TRELLIS_QUALITY,
  trellisEngine,
  trellisQuality,
  trellisTexture,
} from "@/lib/oj/trellis3d";
import {
  buildMusicWorkflow,
  buildSfxWorkflow,
  INSTRUMENTAL_LYRICS,
  musicKey,
  TEXT_ONLY_ACTIONS,
} from "@/lib/oj/audioGen";
import {
  ACTION_TOOLS,
  buildActionRequest,
  CATEGORY_ORDER,
  defaultSettings,
  getActionTool,
  type ToolSettings,
} from "@/lib/tools/toolsPage";
import { CARD_OVERRIDES, HUB_CATEGORY_LABELS } from "@/lib/tools/hub";
import { audioExt, galleryTileCount } from "@/lib/galleryMedia";
import { textOnlySeedRun } from "@/lib/seedRun";
import { submitTextTool } from "@/lib/tools/runTool";

const PACKS = path.join(process.cwd(), "public/workflows/packs");
const load = (rel: string): Workflow =>
  JSON.parse(fs.readFileSync(path.join(PACKS, rel), "utf8")) as Workflow;

const imageRun = (): ImagineRun => ({
  run_id: "r1",
  prompt: "a ceramic teapot",
  parsedPrompt: "a ceramic teapot",
  width: 1024,
  height: 1024,
  createdAt: "2026-10-23T00:00:00Z",
  status: "done",
  jobs: [
    {
      seed: 1,
      index: 0,
      status: "done",
      progress: 100,
      images: ["http://h/view?filename=teapot.png&subfolder=cj&type=input"],
    },
  ],
  params: {},
});

/** Every [id, slot] link points at a node that exists. */
function danglingLinks(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    for (const [key, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && !wf[v[0]]) {
        out.push(`${id}.${key}->${v[0]}`);
      }
    }
  }
  return out;
}

const classes = (wf: Workflow) =>
  new Set(Object.values(wf).map((n) => n.class_type));

describe("make_3d_trellis builder", () => {
  const base = load("trellis2/make_3d_trellis.json");

  it("patches the source image and defaults to Pixal3D, textured, high", () => {
    const { workflow, seed } = buildMake3dTrellisWorkflow(base, imageRun(), 0, {
      seed: 42,
    });
    expect(seed).toBe(42);
    expect(workflow["122"].inputs.image).toBe("cj/teapot.png [input]");
    expect(danglingLinks(workflow)).toEqual([]);
    const c = classes(workflow);
    expect(c.has("Pixal3DConditioning")).toBe(true);
    expect(c.has("Trellis2Conditioning")).toBe(false);
    expect(c.has("RemoveBackground")).toBe(true);
    expect(c.has("BakeTextureFromVoxel")).toBe(true);
    expect(c.has("SaveGLB")).toBe(true);
    expect(workflow["186"].inputs.target_face_count).toBe(
      TRELLIS_QUALITY.high.faces,
    );
    for (const id of ["3", "18", "23", "12"]) {
      expect(workflow[id].inputs.seed).toBe(42);
    }
    // Base graph untouched.
    expect(base["122"].inputs.image).toBe("example.png");
  });

  it("TRELLIS.2 engine drops the Pixal3D/MoGe branch", () => {
    const { workflow } = buildMake3dTrellisWorkflow(base, imageRun(), 0, {
      engine: "trellis2",
    });
    expect(danglingLinks(workflow)).toEqual([]);
    const c = classes(workflow);
    expect(c.has("Trellis2Conditioning")).toBe(true);
    expect(c.has("Pixal3DConditioning")).toBe(false);
    expect(c.has("MoGeInference")).toBe(false);
    const unets = Object.values(workflow)
      .filter((n) => n.class_type === "UNETLoader")
      .map((n) => n.inputs.unet_name);
    expect(unets).toEqual(["trellis_2_int8_convrot.safetensors"]);
  });

  it("fast + shape-only removes the texture stage and lowers budgets", () => {
    const { workflow } = buildMake3dTrellisWorkflow(base, imageRun(), 0, {
      quality: "fast",
      texture: "off",
    });
    expect(danglingLinks(workflow)).toEqual([]);
    const c = classes(workflow);
    expect(c.has("Trellis2TextureStage")).toBe(false);
    expect(c.has("BakeTextureFromVoxel")).toBe(false);
    expect(c.has("VAELoader")).toBe(true); // shape VAE stays
    expect((workflow["400"].inputs.mesh as unknown[])[0]).toBe("238");
    expect(workflow["401"].inputs.mode).toBe("solid");
    expect(workflow["186"].inputs.target_face_count).toBe(
      TRELLIS_QUALITY.fast.faces,
    );
    expect(workflow["18"].inputs.steps).toBe(TRELLIS_QUALITY.fast.shapeSteps);
  });

  it("knob parsers and missing source", () => {
    expect(trellisEngine("TRELLIS2")).toBe("trellis2");
    expect(trellisEngine(undefined)).toBe("pixal3d");
    expect(trellisQuality("fast")).toBe("fast");
    expect(trellisQuality("x")).toBe("high");
    expect(trellisTexture("off")).toBe(false);
    expect(trellisTexture(false)).toBe(false);
    expect(trellisTexture(undefined)).toBe(true);
    const run = imageRun();
    run.jobs[0].images = [];
    expect(() => buildMake3dTrellisWorkflow(base, run, 0, {})).toThrow(
      /no image/,
    );
  });
});

describe("audio builders", () => {
  const music = load("audio/music.json");
  const sfx = load("audio/sfx.json");
  const text = textOnlySeedRun("t1", "x");

  it("music sets tags, instrumental default, clamps and key", () => {
    const { workflow, seed } = buildMusicWorkflow(music, text, 0, {
      prompt: "lofi, piano",
      duration: 999,
      bpm: 10,
      key: "am",
      seed: 7,
    });
    const enc = workflow["5"].inputs;
    expect(enc.tags).toBe("lofi, piano");
    expect(enc.lyrics).toBe(INSTRUMENTAL_LYRICS);
    // Generated 4/3 longer, then trimmed back to the clamp (silent-tail fix).
    expect(enc.duration).toBe(320);
    expect(enc.bpm).toBe(40);
    expect(enc.keyscale).toBe("A minor");
    expect(enc.seed).toBe(7);
    expect(workflow["7"].inputs.seconds).toBe(320);
    expect(workflow["11"].class_type).toBe("TrimAudioDuration");
    expect(workflow["11"].inputs.duration).toBe(240);
    expect(workflow["11"].inputs.audio).toEqual(["9", 0]);
    expect(workflow["10"].inputs.audio).toEqual(["11", 0]);
    expect(workflow["8"].inputs.seed).toBe(7);
    expect(seed).toBe(7);
    expect(danglingLinks(workflow)).toEqual([]);
  });

  it("music keeps lyrics and requires a prompt", () => {
    const { workflow } = buildMusicWorkflow(music, text, 0, {
      prompt: "pop",
      lyrics: "[verse]\nhello",
      duration: "30",
    });
    expect(workflow["5"].inputs.lyrics).toBe("[verse]\nhello");
    expect(workflow["5"].inputs.duration).toBe(40);
    expect(workflow["11"].inputs.duration).toBe(30);
    expect(() => buildMusicWorkflow(music, text, 0, {})).toThrow(/prompt/);
  });

  it("music without a trim node generates the exact length", () => {
    const bare = JSON.parse(JSON.stringify(music)) as Workflow;
    delete bare["11"];
    bare["10"].inputs.audio = ["9", 0];
    const { workflow } = buildMusicWorkflow(bare, text, 0, {
      prompt: "pop",
      duration: 30,
    });
    expect(workflow["5"].inputs.duration).toBe(30);
    expect(workflow["7"].inputs.seconds).toBe(30);
  });

  it("musicKey normalizes or falls back", () => {
    expect(musicKey("F# minor")).toBe("F# minor");
    expect(musicKey("Bb")).toBe("Bb major");
    expect(musicKey("H major")).toBe("C major");
    expect(musicKey("")).toBe("C major");
  });

  it("sfx sets prompt, duration clamp and seed", () => {
    const { workflow } = buildSfxWorkflow(sfx, text, 0, {
      prompt: "door creak",
      duration: 0,
      seed: 3,
    });
    expect(workflow["3"].inputs.text).toBe("door creak");
    expect(workflow["4"].inputs.text).toBe("");
    expect(workflow["5"].inputs.seconds).toBe(1);
    expect(workflow["6"].inputs.seed).toBe(3);
    expect(() => buildSfxWorkflow(sfx, text, 0, { prompt: " " })).toThrow();
  });
});

describe("registry / packs / routing wiring", () => {
  it.each([
    [
      "make_3d_trellis",
      "trellis2",
      "packs/trellis2/make_3d_trellis.json",
      true,
    ],
    ["music", "audio", "packs/audio/music.json", false],
    ["sfx", "audio", "packs/audio/sfx.json", false],
  ])("%s", (action, pack, rel, requiresImage) => {
    const actions = registry.actions as Record<
      string,
      { template: string; requiresImage?: boolean }
    >;
    const templates = registry.templates as Record<string, { file: string }>;
    expect(actions[action].requiresImage).toBe(requiresImage);
    expect(templates[actions[action].template].file).toBe(rel);
    expect(getPack(pack)?.workflows[action]).toBe(rel);
    expect(actionBuilderFor(action)).toBeTypeOf("function");
    expect(
      fs.existsSync(path.join(process.cwd(), "public/workflows", rel)),
    ).toBe(true);
    vi.stubEnv("COMFY_VIDEO_HTTP_URL", "http://video:8188");
    try {
      expect(routeBackend({ action, workflowPath: rel })).toBe("video");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("text-only set and graphs carry no personal paths", () => {
    expect([...TEXT_ONLY_ACTIONS].sort()).toEqual(["music", "sfx", "voiceover"]);
    for (const rel of [
      "trellis2/make_3d_trellis.json",
      "audio/music.json",
      "audio/sfx.json",
    ]) {
      const raw = fs.readFileSync(path.join(PACKS, rel), "utf8");
      expect(raw).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/);
    }
  });
});

describe("tools page + hub", () => {
  const settings = (over: Partial<ToolSettings> = {}): ToolSettings => ({
    ...defaultSettings(),
    ...over,
  });

  it("make_3d_trellis request carries pack and knobs", () => {
    const spec = getActionTool("make_3d_trellis")!;
    expect(spec.modelCheck).toEqual({
      pack: "trellis2",
      action: "make_3d_trellis",
    });
    expect(buildActionRequest(spec, settings(), null)).toEqual({
      action: "make_3d_trellis",
      params: {
        pack_id: "trellis2",
        engine: "pixal3d",
        quality: "high",
        texture: "on",
      },
      overrides: {},
    });
    const fast = buildActionRequest(
      spec,
      settings({
        picks: { quality: "fast", texture: "off", engine: "trellis2" },
      }),
      null,
    );
    expect(fast.params).toMatchObject({
      quality: "fast",
      texture: "off",
      engine: "trellis2",
    });
  });

  it("music / sfx requests are text-only and need text", () => {
    const music = getActionTool("music")!;
    const sfx = getActionTool("sfx")!;
    expect(music.noSourceInput && sfx.noSourceInput).toBe(true);
    expect(() => buildActionRequest(music, settings(), null)).toThrow();
    expect(
      buildActionRequest(
        music,
        settings({ text: "jazz", secondText: " [verse] hi " }),
        null,
      ),
    ).toEqual({
      action: "music",
      params: {
        pack_id: "audio",
        prompt: "jazz",
        lyrics: "[verse] hi",
        duration: 30,
        bpm: 120,
        key: "C major",
      },
      overrides: {},
    });
    expect(
      buildActionRequest(
        sfx,
        settings({ text: "rain", picks: { duration: "4" } }),
        null,
      ),
    ).toEqual({
      action: "sfx",
      params: { pack_id: "audio", prompt: "rain", duration: 4 },
      overrides: {},
    });
  });

  it("Audio category and hub cards", () => {
    expect(CATEGORY_ORDER).toContain("Audio");
    expect(HUB_CATEGORY_LABELS.Audio).toBe("Audio");
    expect(CARD_OVERRIDES["action:make_3d_trellis"].title).toBe("3D Model");
    expect(CARD_OVERRIDES["action:music"].hub).toBe("Audio");
    expect(CARD_OVERRIDES["action:sfx"].hub).toBe("Audio");
    const ids = ACTION_TOOLS.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(["make_3d_trellis", "music", "sfx"]),
    );
  });
});

describe("text-only submission + gallery media", () => {
  it("submitTextTool seeds a text run then queues the action", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, body });
      const run =
        url === "/api/jobs/seed-run"
          ? textOnlySeedRun("seed-1", body.prompt)
          : { ...textOnlySeedRun("act-1", "x"), status: "queued" };
      return { ok: true, status: 200, json: async () => ({ ok: true, run }) };
    });
    const run = await submitTextTool({
      fetchImpl,
      spec: getActionTool("sfx")!,
      settings: { ...defaultSettings(), text: "thunder" },
      clientId: "c1",
    });
    expect(run.run_id).toBe("act-1");
    expect(calls[0]).toEqual({
      url: "/api/jobs/seed-run",
      body: { text_only: true, prompt: "thunder" },
    });
    expect(calls[1].url).toBe("/api/jobs/action");
    expect(calls[1].body).toMatchObject({
      run_id: "seed-1",
      job_index: 0,
      action: "sfx",
      client_id: "c1",
      params: { pack_id: "audio", prompt: "thunder", duration: 8 },
    });
  });

  it("seed-run route accepts text_only without a ref", async () => {
    vi.resetModules();
    const { POST } = await import("@/app/api/jobs/seed-run/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(
      new NextRequest("http://localhost:3000/api/jobs/seed-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text_only: true, prompt: "lofi" }),
      }),
    );
    expect(res.status).toBe(200);
    const { run } = await res.json();
    expect(run.prompt).toBe("lofi");
    expect(run.jobs[0].images).toEqual([]);
    expect(run.params.text_only).toBe(true);
  });

  it("gallery counts audio / mesh-only jobs and keeps the audio container", () => {
    const job = textOnlySeedRun("x", "y").jobs[0];
    expect(galleryTileCount(job)).toBe(0);
    expect(galleryTileCount({ ...job, audios: ["a"] })).toBe(1);
    expect(galleryTileCount({ ...job, meshes: ["m"] })).toBe(1);
    expect(
      galleryTileCount({ ...job, images: ["i", "j"], meshes: ["m"] }),
    ).toBe(2);
    expect(galleryTileCount({ ...job, status: "running", audios: ["a"] })).toBe(
      0,
    );
    expect(
      audioExt("/api/comfy/view?filename=adrift_music_00001.mp3&type=output"),
    ).toBe(".mp3");
    expect(audioExt("http://h/x.flac")).toBe(".flac");
    expect(audioExt(undefined)).toBe(".wav");
  });
});
