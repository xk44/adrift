import { describe, it, expect, vi } from "vitest";
import registry from "@/lib/tools/editToolRegistry.json";
import objectInfo from "./fixtures/comfy-contract/object_info.json";
import {
  STORY_STRUCTURES,
  STORYBOARD_ENGINES,
  STORYBOARD_FRAME_COUNTS,
  STORYBOARD_MAX_FRAMES,
  STORYBOARD_MIN_FRAMES,
  animatableFrames,
  clampFrameCount,
  firstFrameRefPrompt,
  firstFrameT2IPrompt,
  frameAsImage,
  initialFrames,
  nextFrameEngineIds,
  nextFramePrompt,
  nextFrameToSubmit,
  pickBeatIndices,
  planShots,
  resetFrom,
  submitStoryFrame,
  validateStoryStructures,
  type FrameState,
} from "@/lib/tools/storyboard";
import { EDIT_ENGINES, type EngineContext } from "@/lib/tools/templates";
import { buildHubCards, STORYBOARD_KEY } from "@/lib/tools/hub";
import type { CatalogTool } from "@/lib/tools/toolsPage";
import type { ToolImage } from "@/lib/tools/runTool";

function catalogTool(over: Partial<CatalogTool> = {}): CatalogTool {
  return {
    id: "t1",
    label: "Tool",
    category: "Story",
    base: "qwen21",
    baseLabel: "Qwen-Image 2.1",
    description: "d",
    loras: [],
    extras: { keepFraming: null },
    speed: { supported: false },
    defaults: { steps: 28, cfg: 1 },
    refCount: 1,
    refLabels: ["Current frame"],
    needsMask: false,
    outpaint: null,
    promptMode: "required",
    promptTemplate: "Next Scene: {prompt}",
    promptHint: "",
    options: [],
    requiresNodes: null,
    license: { name: "x", commercial: false, note: "" },
    sourceUrl: "",
    installed: true,
    packAvailable: true,
    available: true,
    ...over,
  } as CatalogTool;
}

const ctx: EngineContext = {
  catalog: [
    catalogTool({ id: "qwen21-next-scene" }),
    catalogTool({ id: "krea2-general-edit", promptTemplate: "" }),
  ],
  packIds: new Set(["qwen-image-edit", "qwen-image-21"]),
  editLoras: { families: {}, loras: [] },
};

const emptyCtx: EngineContext = {
  catalog: [],
  packIds: new Set(),
  editLoras: { families: {}, loras: [] },
};

function mockFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    const json =
      url === "/api/comfy/upload"
        ? { ok: true, ref: `${body.filename} [input]` }
        : url === "/api/jobs/seed-run"
          ? { ok: true, run: { run_id: "SEED", jobs: [{ index: 0 }] } }
          : {
              ok: true,
              run: { run_id: `NEW${calls.length}`, jobs: [{ index: 0 }] },
            };
    return { ok: true, status: 200, json: async () => json };
  });
  return { calls, fetchImpl };
}

const characterRef: ToolImage = {
  id: "c",
  source: "upload",
  previewUrl: "data:image/png;base64,AA",
  dataUrl: "data:image/png;base64,AA",
  label: "hero.png",
  width: 768,
  height: 1024,
};

const done = (runId: string): FrameState => ({
  status: "done",
  runId,
  jobIndex: 0,
  imageUrl: `/img/${runId}.png`,
});

// Contest rule: no trademarks / IP / real names in preset text.
const BANNED =
  /\b(marvel|disney|pixar|star wars|batman|superman|pokemon|nintendo|higgsfield|nike|apple|coca)\b/i;

describe("story structure catalog", () => {
  it("validates", () => {
    expect(validateStoryStructures(STORY_STRUCTURES)).toEqual([]);
    expect(STORY_STRUCTURES.length).toBeGreaterThanOrEqual(4);
  });

  it("catches broken entries", () => {
    expect(validateStoryStructures(null)).toEqual([
      "structures must be an array",
    ]);
    const bad = [
      { id: "Bad Id", label: "", description: "x", beats: [] },
      {
        ...STORY_STRUCTURES[0],
        id: "dup",
        beats: STORY_STRUCTURES[0].beats.map((b, i) =>
          i === 2 ? { ...b, beat: "{premise} and {other}" } : b,
        ),
      },
      { ...STORY_STRUCTURES[0], id: "dup" },
    ];
    const errs = validateStoryStructures(bad).join("\n");
    expect(errs).toMatch(/snake_case/);
    expect(errs).toMatch(/label required/);
    expect(errs).toMatch(/exactly 8 beats/);
    expect(errs).toMatch(/unknown placeholder/);
    expect(errs).toMatch(/duplicate id/);
  });

  it("preset text is original (no brands or IP)", () => {
    for (const s of STORY_STRUCTURES) {
      const text = [
        s.label,
        s.description,
        ...s.beats.flatMap((b) => [b.camera, b.beat, b.motion]),
      ].join(" | ");
      expect(text, s.id).not.toMatch(BANNED);
    }
  });
});

describe("shot planning", () => {
  it("frame counts are 4-8", () => {
    expect([...STORYBOARD_FRAME_COUNTS]).toEqual([4, 5, 6, 7, 8]);
    expect(clampFrameCount(2)).toBe(STORYBOARD_MIN_FRAMES);
    expect(clampFrameCount(99)).toBe(STORYBOARD_MAX_FRAMES);
    expect(clampFrameCount(Number.NaN)).toBe(STORYBOARD_MIN_FRAMES);
  });

  it("samples beats evenly, keeping first and last", () => {
    expect(pickBeatIndices(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pickBeatIndices(4)).toEqual([0, 2, 5, 7]);
    for (const n of STORYBOARD_FRAME_COUNTS) {
      const idx = pickBeatIndices(n);
      expect(idx).toHaveLength(n);
      expect(idx[0]).toBe(0);
      expect(idx[n - 1]).toBe(7);
      expect(new Set(idx).size).toBe(n);
    }
  });

  it("fills the premise into the opening shot only", () => {
    const shots = planShots("three_act", "a fox opens a bakery.", 5);
    expect(shots).toHaveLength(5);
    expect(shots[0].text).toContain("a fox opens a bakery");
    expect(shots[0].text).not.toContain("..");
    for (const s of shots) {
      expect(s.text).not.toMatch(/\{\w+\}/);
      expect(s.motion.length).toBeGreaterThan(0);
    }
    expect(shots.slice(1).every((s) => !s.text.includes("fox"))).toBe(true);
    // Unknown structure falls back; empty premise still yields shots.
    expect(planShots("nope", "", 4)[0].text).toContain("an original story");
  });
});

describe("prompts", () => {
  const shot = { text: "Close-up: she smiles.", motion: "m" };
  it("frame 1 text-to-image carries premise + shot + style", () => {
    const p = firstFrameT2IPrompt(shot, "a rainy city");
    expect(p).toMatch(/^a rainy city\. Close-up: she smiles\. Cinematic/);
  });
  it("frame 1 from a character keeps identity", () => {
    const p = firstFrameRefPrompt(shot, "a rainy city");
    expect(p).toContain("same character");
    expect(p).toContain("about a rainy city");
    expect(p).toContain("Keep their face");
  });
  it("next-scene LoRA gets the bare shot; others get an instruction", () => {
    expect(nextFramePrompt(shot, EDIT_ENGINES["qwen21-next-scene"])).toBe(
      "Close-up: she smiles.",
    );
    expect(nextFramePrompt(shot, EDIT_ENGINES.qwen2511)).toMatch(
      /^Show the next shot of the same story\. Close-up: she smiles\. Keep the same character/,
    );
    expect(nextFramePrompt(shot, EDIT_ENGINES["qwen2511-dual"])).toContain(
      "identical to the reference image",
    );
  });
});

describe("engines + hub card", () => {
  it("next-scene LoRA is first; dual engines only with a character", () => {
    expect(nextFrameEngineIds(false)[0]).toBe("qwen21-next-scene");
    expect(nextFrameEngineIds(false)).not.toContain("qwen2511-dual");
    expect(nextFrameEngineIds(true)).toContain("qwen2511-dual");
    expect(STORYBOARD_ENGINES).toEqual(nextFrameEngineIds(false));
    expect(EDIT_ENGINES["qwen21-next-scene"].license).toBe("nc");
  });

  it("next-scene engine maps to the registry tool whose LoRA ComfyUI lists", () => {
    const run = EDIT_ENGINES["qwen21-next-scene"].run;
    expect(run).toEqual({ kind: "catalog", toolId: "qwen21-next-scene" });
    const tool = (
      registry as unknown as {
        tools: {
          id: string;
          loras: { file: string }[];
          promptTemplate: string;
          license: { commercial: boolean };
        }[];
      }
    ).tools.find((t) => t.id === "qwen21-next-scene")!;
    expect(tool.promptTemplate).toBe("Next Scene: {prompt}");
    expect(tool.license.commercial).toBe(false);
    const listed = (
      objectInfo as unknown as Record<
        string,
        { input: { required: Record<string, [string[]]> } }
      >
    ).LoraLoaderModelOnly.input.required.lora_name[0];
    for (const l of tool.loras) expect(listed).toContain(l.file);
  });

  it("hub card is available with the next-scene tool, NC-flagged, in Image", () => {
    const card = buildHubCards({ toolCards: [], ctx }).find(
      (c) => c.key === STORYBOARD_KEY,
    )!;
    expect(card).toMatchObject({
      kind: "special",
      hubCategory: "Image",
      available: true,
      nc: true,
    });
    expect(card.aliases).toContain("popcorn");
    const off = buildHubCards({ toolCards: [], ctx: emptyCtx }).find(
      (c) => c.key === STORYBOARD_KEY,
    )!;
    expect(off.available).toBe(false);
    expect(off.unavailableReason).toMatch(/Needs one of/);
  });
});

describe("chain state machine", () => {
  it("does nothing until started, then runs strictly in order", () => {
    let f = initialFrames(4);
    expect(f).toHaveLength(4);
    expect(nextFrameToSubmit(f, false)).toBeNull();
    expect(nextFrameToSubmit(f, true)).toBe(0);
    f[0] = { status: "queued", runId: "A" };
    expect(nextFrameToSubmit(f, true)).toBeNull();
    f[0] = done("A");
    expect(nextFrameToSubmit(f, true)).toBe(1);
    f[1] = { status: "error", error: "boom" };
    expect(nextFrameToSubmit(f, true)).toBeNull();
    f = [done("A"), done("B"), done("C"), done("D")];
    expect(nextFrameToSubmit(f, true)).toBeNull();
  });

  it("re-roll resets one frame or the rest of the chain", () => {
    const f = [done("A"), done("B"), done("C"), done("D")];
    const one = resetFrom(f, 1, false);
    expect(one.map((x) => x.status)).toEqual([
      "done",
      "pending",
      "done",
      "done",
    ]);
    expect(nextFrameToSubmit(one, true)).toBe(1);
    const rest = resetFrom(f, 1, true);
    expect(rest.map((x) => x.status)).toEqual([
      "done",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("animatable frames are the finished ones", () => {
    const f: FrameState[] = [
      done("A"),
      { status: "queued", runId: "B" },
      { status: "done", image: characterRef },
      { status: "error" },
    ];
    expect(animatableFrames(f)).toEqual([0, 2]);
  });

  it("frameAsImage turns a finished run into a gallery input", () => {
    expect(
      frameAsImage({ status: "pending" }, 0, { width: 1, height: 1 }),
    ).toBeNull();
    expect(
      frameAsImage(done("R"), 2, { width: 640, height: 360 }),
    ).toMatchObject({
      source: "gallery",
      runId: "R",
      jobIndex: 0,
      label: "Frame 3",
      width: 640,
    });
  });
});

describe("submitStoryFrame", () => {
  const shots = planShots("action", "a courier in a flooded city", 4);
  const base = {
    shots,
    premise: "a courier in a flooded city",
    ctx,
    clientId: "cid",
  };

  it("frame 2+ chains the next-scene tool off the previous frame's run", async () => {
    const { calls, fetchImpl } = mockFetch();
    const frames = [done("PREV"), ...initialFrames(4).slice(1)];
    const run = await submitStoryFrame({
      ...base,
      fetchImpl,
      index: 1,
      frames,
      reference: null,
      refRole: "character",
      engine: EDIT_ENGINES["qwen21-next-scene"],
      firstEngine: null,
    });
    expect(run.run_id).toBe("NEW1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/jobs/tool");
    expect(calls[0].body).toMatchObject({
      toolId: "qwen21-next-scene",
      images: [{ run_id: "PREV", job_index: 0 }],
      prompt: shots[1].text,
      client_id: "cid",
    });
  });

  it("frame 1 from a character ref edits the uploaded reference", async () => {
    const { calls, fetchImpl } = mockFetch();
    await submitStoryFrame({
      ...base,
      fetchImpl,
      index: 0,
      frames: initialFrames(4),
      reference: characterRef,
      refRole: "character",
      engine: EDIT_ENGINES["qwen21-next-scene"],
      firstEngine: EDIT_ENGINES.krea2,
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/comfy/upload",
      "/api/jobs/tool",
    ]);
    expect(calls[1].body.toolId).toBe("krea2-general-edit");
    expect(String(calls[1].body.prompt)).toContain("same character");
  });

  it("dual engine sends the character as the second reference", async () => {
    const { calls, fetchImpl } = mockFetch();
    await submitStoryFrame({
      ...base,
      fetchImpl,
      index: 2,
      frames: [done("A"), done("B"), ...initialFrames(4).slice(2)],
      reference: characterRef,
      refRole: "character",
      engine: EDIT_ENGINES["qwen2511-dual"],
      firstEngine: EDIT_ENGINES.krea2,
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/comfy/upload",
      "/api/jobs/action",
    ]);
    expect(calls[1].body).toMatchObject({
      run_id: "B",
      action: "edit_instruct_dual",
      params: { pack_id: "qwen-image-edit" },
    });
    expect(
      (calls[1].body.params as Record<string, unknown>).secondRefImage,
    ).toMatch(/^cj_ref2_/);
  });

  it("refuses to run ahead of an unfinished frame or without a ref", async () => {
    const { fetchImpl } = mockFetch();
    await expect(
      submitStoryFrame({
        ...base,
        fetchImpl,
        index: 1,
        frames: initialFrames(4),
        reference: null,
        refRole: "character",
        engine: EDIT_ENGINES["qwen21-next-scene"],
        firstEngine: null,
      }),
    ).rejects.toThrow(/not finished/);
    await expect(
      submitStoryFrame({
        ...base,
        fetchImpl,
        index: 0,
        frames: initialFrames(4),
        reference: null,
        refRole: "character",
        engine: EDIT_ENGINES["qwen21-next-scene"],
        firstEngine: EDIT_ENGINES.krea2,
      }),
    ).rejects.toThrow(/character reference/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
