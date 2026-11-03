import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import overlayNodes from "./fixtures/overlayNodes.objectInfo.json";
import { VIDEO_INPUT_ACTIONS, actionBuilderFor } from "@/lib/oj/actionBuilders";
import {
  OVC_NODES,
  buildOverlayCompositeWorkflow,
  overlayLayersFrom,
} from "@/lib/oj/overlayComposite";
import {
  OVERLAY_BLENDS,
  OVERLAY_COMPOSITE_ACTION,
  OVERLAY_FPS,
  OVERLAY_LOOKS,
  overlayFps,
  OVERLAY_MAX_LAYERS,
  OVERLAY_MAX_SECONDS,
  overlayFrameCount,
  overlayFrameSize,
  overlayLookPrompt,
  overlayPlacement,
  overlaySeconds,
  overlayWindow,
  parseOverlayLayer,
} from "@/lib/tools/overlayComposite";
import {
  OVERLAY_CUTOUT_TOOL,
  lookLayer,
  overlayParams,
  overlayPreviewBox,
  runOverlayComposite,
  uploadLayer,
  type OverlayDeps,
  type OverlayInputLayer,
} from "@/lib/tools/overlayRunner";
import {
  OVERLAY_COMPOSITE_KEY,
  overlayCompositeCard,
  overlayLooksAvailable,
} from "@/lib/tools/pipelineCards";
import { buildHubCards } from "@/lib/tools/hub";
import type { ToolVideo } from "@/lib/tools/runTool";
import type { EngineContext } from "@/lib/tools/templates";

const ctx = (packs: string[]): EngineContext => ({
  catalog: [],
  packIds: new Set(packs),
  editLoras: {
    families: [],
    loras: [],
  } as unknown as EngineContext["editLoras"],
});

const PACKS = path.join(process.cwd(), "public/workflows");
const reg = registry as unknown as {
  templates: Record<string, { file: string; kind: string }>;
  actions: Record<
    string,
    { template: string; requiresImage?: boolean; group?: string }
  >;
};
const base = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        PACKS,
        reg.templates[reg.actions[OVERLAY_COMPOSITE_ACTION].template].file,
      ),
      "utf8",
    ),
  ) as Workflow;

type InputSpec = [unknown, Record<string, unknown>?];
const INFO = overlayNodes as unknown as Record<
  string,
  {
    input: Record<string, Record<string, InputSpec>>;
    output: string[];
  }
>;

function options(spec: InputSpec): string[] | null {
  if (Array.isArray(spec[0])) return spec[0] as string[];
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options))
    return spec[1]!.options as string[];
  return null;
}

/** object_info check: classes, declared inputs, combos, ranges, links + output slots, required. */
function validate(wf: Workflow): string[] {
  const errors: string[] = [];
  for (const [id, node] of Object.entries(wf)) {
    if (id.startsWith("_")) continue;
    const info = INFO[node.class_type];
    if (!info) {
      errors.push(`${id}: unknown class ${node.class_type}`);
      continue;
    }
    const all = { ...info.input.required, ...info.input.optional };
    for (const [key, value] of Object.entries(node.inputs)) {
      const spec = all[key];
      if (!spec) {
        errors.push(`${id}.${key}: not an input of ${node.class_type}`);
        continue;
      }
      if (Array.isArray(value)) {
        const [src, slot] = value as [string, number];
        const target = wf[src];
        if (!target) errors.push(`${id}.${key}: link to missing node ${src}`);
        else {
          const outs = INFO[target.class_type]?.output ?? [];
          const want = spec[0];
          if (slot >= outs.length)
            errors.push(`${id}.${key}: ${src} has no output ${slot}`);
          else if (typeof want === "string" && outs[slot] !== want)
            errors.push(
              `${id}.${key}: wants ${want}, got ${outs[slot]} from ${src}`,
            );
        }
        continue;
      }
      const opts = options(spec);
      // File pickers list host files; skip those.
      if (
        opts &&
        key !== "image" &&
        key !== "video" &&
        !opts.includes(String(value))
      )
        errors.push(`${id}.${key}: ${String(value)} not in options`);
      const range = spec[1] as { min?: number; max?: number } | undefined;
      if (typeof value === "number" && range) {
        if (typeof range.min === "number" && value < range.min)
          errors.push(`${id}.${key}: ${value} < min ${range.min}`);
        if (typeof range.max === "number" && value > range.max)
          errors.push(`${id}.${key}: ${value} > max ${range.max}`);
      }
    }
    for (const req of Object.keys(info.input.required ?? {})) {
      if (!(req in node.inputs)) errors.push(`${id}: missing required ${req}`);
    }
  }
  return errors;
}

const byClass = (wf: Workflow, cls: string) =>
  Object.entries(wf).filter(
    ([k, n]) => !k.startsWith("_") && n.class_type === cls,
  );

const clipRun = (over: Partial<ImagineRun> = {}): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "",
    parsedPrompt: "",
    width: 1920,
    height: 1080,
    createdAt: "2026-10-25T00:00:00Z",
    status: "done",
    params: { video_seconds: 6 },
    jobs: [
      {
        seed: 7,
        index: 0,
        status: "done",
        progress: 100,
        images: [],
        videos: [
          "http://127.0.0.1:8188/view?filename=clip.mp4&subfolder=&type=input",
        ],
      },
    ],
    ...over,
  }) as unknown as ImagineRun;

const still = (over: Record<string, unknown> = {}) => ({
  ref: "sticker.png [input]",
  kind: "image",
  width: 1024,
  height: 1024,
  x: 0.5,
  y: 0.5,
  scale: 0.25,
  opacity: 1,
  blend: "normal",
  start: 0,
  end: null,
  ...over,
});

const build = (overlays: unknown[], run = clipRun(), extra = {}) =>
  buildOverlayCompositeWorkflow(base(), run, 0, { overlays, ...extra })
    .workflow;

describe("overlay geometry", () => {
  it("fits the frame to 1280 px on multiples of 8", () => {
    expect(overlayFrameSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(overlayFrameSize(1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(overlayFrameSize(640, 360)).toEqual({ width: 640, height: 360 });
    const odd = overlayFrameSize(1001, 563);
    expect(odd.width % 8).toBe(0);
    expect(odd.height % 8).toBe(0);
    expect(overlayFrameSize(0, 0)).toEqual({ width: 1280, height: 720 });
  });

  it("caps the span and floors the frame count", () => {
    expect(overlaySeconds(4.25)).toBe(4.25);
    expect(overlaySeconds(60)).toBe(OVERLAY_MAX_SECONDS);
    expect(overlaySeconds(null)).toBe(OVERLAY_MAX_SECONDS);
    expect(overlayFrameCount(2.99)).toBe(Math.floor(2.99 * OVERLAY_FPS));
    expect(overlayFrameCount(0)).toBe(1);
  });

  it("centres, clips and rejects off-frame overlays", () => {
    const frame = { width: 1280, height: 720 };
    const c = overlayPlacement(
      { width: 200, height: 100, x: 0.5, y: 0.5, scale: 0.25 },
      frame,
    )!;
    expect(c).toMatchObject({ sw: 320, sh: 160, x: 480, y: 280 });
    expect(c.clipped).toBe(false);
    expect([c.vx, c.vy, c.vw, c.vh, c.cropX, c.cropY]).toEqual([
      480, 280, 320, 160, 0, 0,
    ]);

    const edge = overlayPlacement(
      { width: 100, height: 100, x: 1, y: 0, scale: 0.25 },
      frame,
    )!;
    expect(edge.clipped).toBe(true);
    expect(edge).toMatchObject({ vx: 1120, vy: 0, vw: 160, vh: 160 });
    expect(edge.cropX).toBe(0);
    expect(edge.cropY).toBe(160);

    const big = overlayPlacement(
      { width: 100, height: 100, x: 0.5, y: 0.5, scale: 2 },
      frame,
    )!;
    expect(big).toMatchObject({ vx: 0, vy: 0, vw: 1280, vh: 720 });
    expect(big.cropX).toBe(640);

    expect(
      overlayPlacement(
        { width: 100, height: 100, x: 0, y: 0, scale: 0 },
        { width: 1, height: 1 },
      ),
    ).not.toBeNull();
  });

  it("turns seconds into a clamped frame window", () => {
    expect(overlayWindow({ start: 0, end: null }, 144)).toEqual({
      startFrame: 0,
      endFrame: 144,
    });
    expect(overlayWindow({ start: 1, end: 3 }, 144)).toEqual({
      startFrame: 24,
      endFrame: 72,
    });
    expect(overlayWindow({ start: 9, end: 20 }, 144)).toEqual({
      startFrame: 143,
      endFrame: 144,
    });
  });

  it("preview box uses the graph's maths", () => {
    const box = overlayPreviewBox(
      { width: 200, height: 100, x: 0.5, y: 0.5, scale: 0.25 },
      { width: 1280, height: 720 },
    );
    expect(box.width).toBeCloseTo(25);
    expect(box.height).toBeCloseTo((160 / 720) * 100);
    expect(box.left).toBeCloseTo(37.5);
  });
});

describe("overlay layer parsing", () => {
  it("accepts uploaded stills and clips only", () => {
    expect(typeof parseOverlayLayer(still(), 0)).toBe("object");
    expect(
      typeof parseOverlayLayer(
        still({ kind: "video", ref: "loop.webm [input]" }),
        0,
      ),
    ).toBe("object");
    for (const bad of [
      still({ ref: "sticker.png" }),
      still({ ref: "../x.png [input]" }),
      still({ ref: "photo.jpg [input]" }),
      still({ ref: "loop.webm [input]" }),
      still({ kind: "video", ref: "a.png [input]" }),
      still({ width: 0 }),
      "nope",
    ])
      expect(typeof parseOverlayLayer(bad, 0)).toBe("string");
  });

  it("clamps knobs and drops bad blends / windows", () => {
    const l = parseOverlayLayer(
      still({
        x: 3,
        y: -1,
        scale: 9,
        opacity: 2,
        blend: "dodge",
        start: 4,
        end: 2,
      }),
      0,
    );
    expect(l).toMatchObject({
      x: 1,
      y: 0,
      scale: 2,
      opacity: 1,
      blend: "normal",
      start: 4,
      end: null,
    });
  });

  it("limits the layer count", () => {
    expect(() => overlayLayersFrom({})).toThrow(/at least one/);
    expect(() =>
      overlayLayersFrom({
        overlays: Array.from({ length: OVERLAY_MAX_LAYERS + 1 }, () => still()),
      }),
    ).toThrow(/at most/);
  });
});

describe("overlay looks", () => {
  it("ships 6-10 original looks with valid defaults", () => {
    expect(OVERLAY_LOOKS.length).toBeGreaterThanOrEqual(6);
    expect(OVERLAY_LOOKS.length).toBeLessThanOrEqual(10);
    expect(new Set(OVERLAY_LOOKS.map((l) => l.id)).size).toBe(
      OVERLAY_LOOKS.length,
    );
    for (const look of OVERLAY_LOOKS) {
      expect(OVERLAY_BLENDS).toContain(look.blend);
      const p = overlayLookPrompt(look);
      expect(p).toMatch(/white background/);
      expect(p.endsWith("--ar 1:1")).toBe(true);
      expect(
        overlayPlacement(
          { width: 1, height: 1, ...look },
          { width: 1280, height: 720 },
        ),
      ).not.toBeNull();
    }
  });

  it("sanitises the extra theme words", () => {
    const p = overlayLookPrompt(OVERLAY_LOOKS[0], "pastel --ar 9:16 :: x");
    expect(p).not.toMatch(/--ar 9:16/);
    expect(p).not.toContain("::");
  });
});

describe("overlay_composite action", () => {
  it("is registered with a template and as a clip-sourced builder", () => {
    expect(reg.actions[OVERLAY_COMPOSITE_ACTION]).toMatchObject({
      template: OVERLAY_COMPOSITE_ACTION,
      requiresImage: false,
    });
    expect(reg.templates[OVERLAY_COMPOSITE_ACTION].file).toBe(
      "packs/utility/overlay_composite.json",
    );
    expect(actionBuilderFor(OVERLAY_COMPOSITE_ACTION)).toBe(
      buildOverlayCompositeWorkflow,
    );
    expect(VIDEO_INPUT_ACTIONS.has(OVERLAY_COMPOSITE_ACTION)).toBe(true);
    expect(validate(base())).toEqual([]);
  });

  it("composites one still over the whole clip", () => {
    const wf = build([still()]);
    expect(validate(wf)).toEqual([]);
    const load = wf[OVC_NODES.load].inputs;
    expect(load).toMatchObject({
      video: "clip.mp4 [input]",
      force_rate: OVERLAY_FPS,
      custom_width: 1280,
      custom_height: 720,
      frame_load_cap: 6 * OVERLAY_FPS,
      format: "None",
    });
    expect(byClass(wf, "LoadImage")[0][1].inputs.image).toBe(
      "sticker.png [input]",
    );
    const [[compId, comp]] = byClass(wf, "ImageCompositeMasked");
    expect(comp.inputs).toMatchObject({
      destination: [OVC_NODES.load, 0],
      x: 480,
      y: 200,
      resize_source: false,
    });
    expect(wf[OVC_NODES.combine].inputs.images).toEqual([compId, 0]);
    expect(wf[OVC_NODES.combine].inputs.audio).toEqual([OVC_NODES.load, 2]);
    expect(byClass(wf, "ImageScale")[0][1].inputs).toMatchObject({
      width: 320,
      height: 320,
      upscale_method: "area",
    });
    expect(byClass(wf, "ImageCrop")).toHaveLength(0);
    expect(byClass(wf, "VHS_SplitImages")).toHaveLength(0);
    expect(byClass(wf, "MaskComposite")).toHaveLength(0);
    expect(byClass(wf, "ImageBlend")).toHaveLength(0);
  });

  it("wires clip, opacity, blend and a time window", () => {
    const wf = build([
      still({
        x: 1,
        y: 0,
        opacity: 0.5,
        blend: "screen",
        start: 1,
        end: 3,
      }),
    ]);
    expect(validate(wf)).toEqual([]);
    const splits = byClass(wf, "VHS_SplitImages");
    expect(splits.map(([, n]) => n.inputs.split_index)).toEqual([24, 48]);
    expect(byClass(wf, "SolidMask")[0][1].inputs.value).toBe(0.5);
    expect(byClass(wf, "ImageBlend")[0][1].inputs).toMatchObject({
      blend_mode: "screen",
      blend_factor: 1,
    });
    // overlay crop + region crop
    expect(byClass(wf, "ImageCrop")).toHaveLength(2);
    const batches = byClass(wf, "ImageBatch");
    expect(batches).toHaveLength(2);
    expect(wf[OVC_NODES.combine].inputs.images).toEqual([batches[1][0], 0]);
    const final = byClass(wf, "ImageCompositeMasked").find(
      ([, n]) => "mask" in n.inputs,
    )![1];
    expect(final.inputs).toMatchObject({ x: 1120, y: 0 });
  });

  it("loads animated overlays as a capped, looping clip", () => {
    const wf = build([
      still({ kind: "video", ref: "loop.webm [input]", start: 2 }),
    ]);
    expect(validate(wf)).toEqual([]);
    const [[, v]] = byClass(wf, "VHS_LoadVideoFFmpeg");
    expect(v.inputs).toMatchObject({
      video: "loop.webm [input]",
      force_rate: OVERLAY_FPS,
      frame_load_cap: 6 * OVERLAY_FPS - 48,
      format: "None",
    });
    expect(byClass(wf, "VHS_SplitImages")).toHaveLength(1);
  });

  it("stacks up to four layers in order", () => {
    const wf = build([
      still(),
      still({ blend: "multiply" }),
      still({ kind: "video", ref: "a.mov [input]" }),
      still({ opacity: 0.3, start: 0.5 }),
    ]);
    expect(validate(wf)).toEqual([]);
    const finals = byClass(wf, "ImageCompositeMasked").filter(
      ([, n]) => "mask" in n.inputs,
    );
    expect(finals).toHaveLength(4);
    // layer 2 composites onto layer 1's output
    expect(finals[1][1].inputs.destination).toEqual([finals[0][0], 0]);
  });

  it("ignores time windows when the clip length is unknown", () => {
    const run = clipRun({ params: {} } as Partial<ImagineRun>);
    const wf = build([still({ start: 2, end: 4 })], run);
    expect(validate(wf)).toEqual([]);
    expect(byClass(wf, "VHS_SplitImages")).toHaveLength(0);
    expect(wf[OVC_NODES.load].inputs.frame_load_cap).toBe(
      OVERLAY_MAX_SECONDS * OVERLAY_FPS,
    );
  });

  it("uses client dims + seconds over the run's", () => {
    const wf = build([still()], clipRun(), {
      width: 1080,
      height: 1920,
      seconds: 2,
    });
    expect(wf[OVC_NODES.load].inputs).toMatchObject({
      custom_width: 720,
      custom_height: 1280,
      frame_load_cap: 48,
    });
  });

  it("rejects bad sources and layers", () => {
    expect(() =>
      build([still()], clipRun({ jobs: [{ index: 0 }] } as never)),
    ).toThrow(/no video/);
    expect(() => build([still({ ref: "x.png" })])).toThrow(/uploaded PNG/);
    expect(() => build([])).toThrow(/at least one/);
  });
});

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function server() {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const kindOf = new Map<string, string>();
  let n = 0;
  const file = (name: string, sub: string) => ({
    filename: name,
    subfolder: sub,
    type: "output",
    url: `/api/comfy/image?filename=${name}&subfolder=${sub}&type=output`,
  });
  const queue = (kind: string) => {
    const pid = `p-${kind}-${++n}`;
    kindOf.set(pid, kind);
    return { run_id: `${kind}${n}`, jobs: [{ index: 0, prompt_id: pid }] };
  };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    calls.push({ url, body });
    if (url === "/api/comfy/upload")
      return json({
        ref: `up${++n}${/\.[a-z0-9]+$/i.exec(String(body?.filename))?.[0] ?? ""} [input]`,
      });
    if (url === "/api/jobs/seed-run")
      return json({ run: { run_id: `seed${++n}`, jobs: [{ index: 0 }] } });
    if (url === "/api/jobs/imagine") return json({ runs: [queue("imagine")] });
    if (url === "/api/jobs/tool") return json({ run: queue("cutout") });
    if (url === "/api/jobs/action")
      return json({ run: queue(String(body!.action)) });
    if (url.startsWith("/api/comfy/history/")) {
      const pid = decodeURIComponent(url.slice("/api/comfy/history/".length));
      const kind = kindOf.get(pid) ?? "";
      if (kind === "imagine")
        return json({ ok: true, images: [file("sticker_1.png", "")] });
      if (kind === "cutout")
        return json({ ok: true, images: [file("cut_1.png", "")] });
      return json({
        ok: true,
        videos: [file("adrift_overlay_1.mp4", "video")],
      });
    }
    return json({ error: "unexpected" }, 500);
  });
  return { fetchImpl, calls };
}

const video: ToolVideo = {
  id: "v",
  previewUrl: "blob:v",
  dataUrl: "data:video/mp4;base64,AAAA",
  label: "clip.mp4",
  duration: 6,
  width: 1920,
  height: 1080,
};

const deps = (srv: ReturnType<typeof server>): OverlayDeps => ({
  fetchImpl: srv.fetchImpl,
  clientId: "c1",
  sleep: async () => {},
  toDataUrl: async () => "data:image/png;base64,AAAA",
  imageSize: async () => ({ width: 1024, height: 768 }),
  measure: async () => 6,
});

describe("overlay runner", () => {
  it("uploads stills, generates + cuts out looks, then composites", async () => {
    const srv = server();
    const up = uploadLayer({
      id: "a",
      kind: "image",
      label: "logo.png",
      dataUrl: "data:image/png;base64,AAAA",
      width: 400,
      height: 200,
    });
    const look = lookLayer("comic-burst", "b");
    const updates: [string, string][] = [];
    const out = await runOverlayComposite(
      { video, layers: [up, look], lookExtra: "pastel" },
      deps(srv),
      (id, u) => updates.push([id, u.status]),
    );
    const urls = srv.calls.map((c) => c.url.replace(/\/p-.*$/, ""));
    expect(urls).toEqual([
      "/api/comfy/upload",
      "/api/jobs/imagine",
      "/api/comfy/history",
      "/api/jobs/tool",
      "/api/comfy/history",
      "/api/comfy/upload",
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
      "/api/comfy/history",
    ]);
    const imagine = srv.calls[1].body!;
    expect(String(imagine.prompt)).toContain("pastel");
    expect(String(imagine.prompt)).toContain("--ar 1:1");
    const tool = srv.calls[3].body!;
    expect(tool.toolId).toBe(OVERLAY_CUTOUT_TOOL);
    // The sticker's file ref, not { run_id, job_index }: the tool route
    // cannot resolve an imagine run's images from the in-memory run.
    expect(tool.images).toEqual(["sticker_1.png [output]"]);
    const act = srv.calls[8].body!;
    expect(act.action).toBe(OVERLAY_COMPOSITE_ACTION);
    const params = act.params as { overlays: OverlayInputLayer[] };
    expect(params.overlays).toHaveLength(2);
    expect(params.overlays[1]).toMatchObject({
      kind: "image",
      width: 1024,
      height: 768,
      blend: "normal",
    });
    // params survive the server-side parser
    expect(() => overlayLayersFrom(params)).not.toThrow();
    expect(updates).toEqual([
      ["a", "uploading"],
      ["a", "ready"],
      ["b", "generating"],
      ["b", "cutting"],
      ["b", "ready"],
    ]);
    expect(out.output.seconds).toBe(6);
    expect(out.layers.every((l) => !!l.ref)).toBe(true);
  });

  it("reuses resolved layers and the seeded clip on a re-run", async () => {
    const srv = server();
    const d = deps(srv);
    d.clip = { runId: "seedX", jobIndex: 0 };
    const ready: OverlayInputLayer = {
      ...lookLayer("chalk-arrows", "c"),
      ref: "done.png [input]",
    };
    await runOverlayComposite({ video, layers: [ready] }, d);
    expect(srv.calls.map((c) => c.url)[0]).toBe("/api/jobs/action");
    expect(srv.calls[0].body!.run_id).toBe("seedX");
  });

  it("sends animated uploads with a clip extension", async () => {
    const srv = server();
    const layer = uploadLayer({
      id: "v",
      kind: "video",
      label: "loop.webm",
      dataUrl: "data:video/webm;base64,AAAA",
      width: 512,
      height: 512,
    });
    await runOverlayComposite({ video, layers: [layer] }, deps(srv));
    expect(String(srv.calls[0].body!.filename)).toMatch(/\.webm$/);
    const act = srv.calls.find((c) => c.url === "/api/jobs/action")!.body!;
    expect(() =>
      overlayLayersFrom(act.params as Record<string, unknown>),
    ).not.toThrow();
  });

  it("fails clearly", async () => {
    const srv = server();
    await expect(
      runOverlayComposite({ video, layers: [] }, deps(srv)),
    ).rejects.toThrow(/Add an overlay/);
    const noReupload = { ...deps(srv), toDataUrl: undefined };
    await expect(
      runOverlayComposite(
        { video, layers: [lookLayer("retro-badge", "r")] },
        noReupload,
      ),
    ).rejects.toThrow(/re-upload/);
    expect(() => overlayParams(video, [lookLayer("retro-badge", "r")])).toThrow(
      /not ready/,
    );
    expect(() => lookLayer("nope", "x")).toThrow(/Unknown/);
  });
});

describe("overlay frame rate follows the source clip", () => {
  it("keeps the source fps, halving rates above 30", () => {
    expect(overlayFps(undefined)).toBe(OVERLAY_FPS);
    expect(overlayFps("junk")).toBe(OVERLAY_FPS);
    expect(overlayFps(23.976)).toBe(23.976);
    expect(overlayFps(30)).toBe(30);
    expect(overlayFps(60)).toBe(30);
    expect(overlayFps(50)).toBe(25);
    expect(overlayFps(119.88)).toBe(29.97);
  });

  it("decodes, times layers and encodes at the source rate", () => {
    const wf = build([still({ start: 1, end: 2 })], clipRun(), { sourceFps: 30 });
    expect(wf[OVC_NODES.load].inputs).toMatchObject({
      force_rate: 30,
      frame_load_cap: 6 * 30,
    });
    expect(wf[OVC_NODES.combine].inputs.frame_rate).toBe(30);
    expect(overlayWindow({ start: 1, end: 2 }, 180, 30)).toEqual({
      startFrame: 30,
      endFrame: 60,
    });
    const vid = build([still({ kind: "video", ref: "o.mp4 [input]" })], clipRun(), {
      sourceFps: 25,
    });
    expect(byClass(vid, "VHS_LoadVideoFFmpeg")[0][1].inputs.force_rate).toBe(25);
  });

  it("the runner sends the probed fps", () => {
    const ready = { ...lookLayer("retro-badge", "r"), ref: "a.png [input]" };
    expect(overlayParams({ ...video, fps: 29.97 }, [ready]).sourceFps).toBe(29.97);
    expect(overlayParams(video, [ready]).sourceFps).toBeUndefined();
  });
});

describe("overlay hub card", () => {
  it("is on the Video hub and always available", () => {
    const cards = buildHubCards({ toolCards: [], ctx: ctx(["audio"]) });
    const card = cards.find((c) => c.key === OVERLAY_COMPOSITE_KEY);
    expect(card).toBeTruthy();
    expect(card).toMatchObject({
      hubCategory: "Video",
      available: true,
      nc: false,
    });
    expect(overlayCompositeCard().aliases).toContain("mixed media");
  });

  it("gates looks on the Qwen-Image 2.1 pack", () => {
    expect(overlayLooksAvailable({ ...ctx([]), packIds: null }).available).toBe(
      true,
    );
    expect(overlayLooksAvailable(ctx(["qwen-image-21"])).available).toBe(true);
    const off = overlayLooksAvailable(ctx(["audio"]));
    expect(off.available).toBe(false);
    expect(off.reason).toMatch(/Qwen-Image 2\.1/);
  });
});
