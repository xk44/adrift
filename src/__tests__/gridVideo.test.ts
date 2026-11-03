/**
 * Grid Video: planning math (src/lib/tools/gridVideo.ts), the grid_video
 * builder (src/lib/oj/gridVideo.ts), the executor (gridVideoRunner.ts) with
 * a mock fetch, and the hub card. No ComfyUI.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import registry from "@/lib/oj/registry.json";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import {
  GRID_VIDEO_ACTION,
  GRID_VIDEO_NODE,
  buildGridVideoWorkflow,
  gridVideoPlan,
} from "@/lib/oj/gridVideo";
import {
  GRID_EFFECTS,
  GRID_MAX_SEGMENTS,
  GRID_VIDEO_FPS,
  GRID_VIDEO_KEY,
  GRID_VIDEO_MAX_SECONDS,
  beatTimes,
  gridRows,
  gridVideoCard,
  gridVideoParams,
  gridVideoSize,
  infectedCount,
  infectionOrder,
  mulberry32,
  normalizeGridParams,
  planGridVideo,
  segmentBounds,
  type GridPlan,
  type GridVideoInputs,
} from "@/lib/tools/gridVideo";
import { gridVideoError, runGridVideo } from "@/lib/tools/gridVideoRunner";
import { buildHubCards } from "@/lib/tools/hub";
import type { EngineContext } from "@/lib/tools/templates";

const BEATS = Array.from(
  { length: 80 },
  (_, i) => +(0.469 * (i + 1)).toFixed(3),
);

const inputs = (over: Partial<GridVideoInputs> = {}): GridVideoInputs => ({
  source: "cj_clip_a1.mp4 [input]",
  sourceKind: "video",
  sourceSeconds: 15,
  audio: "cj_audio_a2.mp3 [input]",
  audioSeconds: 40,
  beats: BEATS,
  bpm: 128,
  ...over,
});

function plan(
  style: "poster" | "infection" | "mosaic",
  over: Record<string, unknown> = {},
): GridPlan {
  return gridVideoPlan({
    ...gridVideoParams(inputs(), {
      style,
      aspect: "1:1",
      gridMax: 4,
      intensity: "high",
      seed: 7,
    }),
    ...over,
  });
}

/** Segments tile 0..frames exactly, tiles = rows * cols, values in range. */
function expectWellFormed(p: GridPlan) {
  expect(p.segments[0].f0).toBe(0);
  expect(p.segments[p.segments.length - 1].f1).toBe(p.frames);
  p.segments.forEach((s, i) => {
    expect(s.f1).toBeGreaterThan(s.f0);
    if (i) expect(s.f0).toBe(p.segments[i - 1].f1);
    expect(s.tiles).toHaveLength(s.rows * s.cols);
    for (const t of s.tiles) {
      expect(t).toHaveLength(9);
      const [o, sp, z0, z1, cx, cy, m, fx, fl] = t;
      expect(Number.isInteger(o) && o >= 0).toBe(true);
      expect(sp).toBeGreaterThanOrEqual(0);
      expect(z0).toBeGreaterThanOrEqual(1);
      expect(z1).toBeGreaterThanOrEqual(1);
      expect(cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1).toBe(true);
      expect([0, 1]).toContain(m);
      expect(fx >= -1 && fx < p.fx.length).toBe(true);
      expect(fl >= 0 && fl <= 1).toBe(true);
    }
  });
}

describe("timing", () => {
  it("beatTimes sorts, drops near-duplicates and out-of-range beats", () => {
    expect(beatTimes([2, 1, 1.05, 0, 9.99, 5], 10, null)).toEqual([1, 2, 5]);
  });

  it("beatTimes falls back to a bpm grid with < 2 beats", () => {
    expect(beatTimes([], 2.1, 120)).toEqual([0.5, 1, 1.5, 2]);
    expect(beatTimes([1], 1.6, null)).toEqual([0.5, 1, 1.5]); // 120 default
  });

  it("segmentBounds cuts every N beats on frame boundaries", () => {
    const b = segmentBounds([0.5, 1, 1.5, 2, 2.5, 3], 96, 24, 2);
    expect(b).toEqual([0, 24, 48, 72, 96]);
  });

  it("segmentBounds doubles beats per cut when beats are too dense", () => {
    // 0.125 s apart (480 bpm): 1 beat/cut -> 2 -> 0.25 s
    const beats = Array.from({ length: 30 }, (_, i) => 0.125 * (i + 1));
    const b = segmentBounds(beats, 96, 24, 1);
    const lens = b.slice(1).map((f, i) => f - b[i]);
    expect(Math.min(...lens)).toBeGreaterThanOrEqual(6);
  });

  it("segmentBounds never leaves a sliver at the end and caps segment count", () => {
    const b = segmentBounds([0.5, 1, 3.95], 96, 24, 1);
    expect(b).toEqual([0, 12, 24, 96]);
    const many = Array.from({ length: 1500 }, (_, i) => 0.3 * (i + 1));
    const capped = segmentBounds(many, 24 * 460, 24, 1);
    expect(capped.length - 1).toBeLessThanOrEqual(GRID_MAX_SEGMENTS);
  });
});

describe("grid geometry", () => {
  it("sizes per aspect (even, 720 / 1080 short side)", () => {
    expect(gridVideoSize("1:1")).toEqual({ width: 720, height: 720 });
    expect(gridVideoSize("9:16")).toEqual({ width: 720, height: 1280 });
    expect(gridVideoSize("16:9", 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it("rows keep tiles near square", () => {
    expect(gridRows(4, 720, 720)).toBe(4);
    expect(gridRows(3, 720, 1280)).toBe(5);
    expect(gridRows(4, 1280, 720)).toBe(2);
    expect(gridRows(1, 1280, 720)).toBe(1);
  });

  it("infectionOrder visits every tile once, each next to an earlier one", () => {
    const rows = 5;
    const cols = 4;
    const order = infectionOrder(rows, cols, 9, mulberry32(3));
    expect(order[0]).toBe(9);
    expect([...order].sort((a, b) => a - b)).toEqual(
      Array.from({ length: rows * cols }, (_, i) => i),
    );
    const seen = new Set([order[0]]);
    for (const i of order.slice(1)) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const nb = [
        [r - 1, c],
        [r + 1, c],
        [r, c - 1],
        [r, c + 1],
      ]
        .filter(([y, x]) => y >= 0 && y < rows && x >= 0 && x < cols)
        .map(([y, x]) => y * cols + x);
      expect(
        nb.some((j) => seen.has(j)),
        `tile ${i}`,
      ).toBe(true);
      seen.add(i);
    }
  });

  it("infectedCount grows from 1 to every tile", () => {
    const counts = [1, 2, 3, 4].map((s) => infectedCount(s, 4, 16));
    expect(counts).toEqual([1, 4, 9, 16]);
    for (let s = 1; s < 8; s++)
      expect(infectedCount(s + 1, 8, 36)).toBeGreaterThanOrEqual(
        infectedCount(s, 8, 36),
      );
  });
});

describe("planGridVideo", () => {
  it.each(["poster", "infection", "mosaic"] as const)(
    "%s plan is well formed and as long as the music",
    (style) => {
      const p = plan(style);
      expect(p.frames).toBe(40 * GRID_VIDEO_FPS);
      expect(p.srcFrames).toBe(15 * GRID_VIDEO_FPS);
      expect(p.width).toBe(720);
      expectWellFormed(p);
    },
  );

  it("is deterministic per seed", () => {
    expect(plan("poster")).toEqual(plan("poster"));
    expect(plan("poster", { seed: 8 })).not.toEqual(plan("poster"));
  });

  it("poster ramps the grid 1x1 -> NxN and cuts on every beat at high intensity", () => {
    const p = plan("poster");
    expect(p.segments.slice(0, 5).map((s) => s.cols)).toEqual([1, 2, 3, 4, 1]);
    // first cut on the first beat (0.469 s -> frame 11)
    expect(p.segments[0].f1).toBe(11);
    expect(p.segments.length).toBeGreaterThan(70);
    expect(p.segments[0].gap).toBe(0);
    expect(p.segments[1].gap).toBeGreaterThan(0);
  });

  it("lower intensity cuts less often", () => {
    const med = plan("poster", { intensity: "medium" });
    const low = plan("poster", { intensity: "low" });
    expect(med.segments.length).toBeLessThan(plan("poster").segments.length);
    expect(low.segments.length).toBeLessThan(med.segments.length);
  });

  it("infection spreads one effect until the frame is full, then resets with the next", () => {
    const p = plan("infection"); // high: 4 steps + 1 hold per cycle
    const infected = p.segments.map(
      (s) => s.tiles.filter((t) => t[7] >= 0).length,
    );
    expect(infected.slice(0, 6)).toEqual([1, 4, 9, 16, 16, 1]);
    const fxOf = (i: number) => p.segments[i].tiles.find((t) => t[7] >= 0)![7];
    expect(new Set(p.segments[3].tiles.map((t) => t[7])).size).toBe(1);
    expect(fxOf(5)).toBe((fxOf(0) + 1) % GRID_EFFECTS.length);
    // newly infected tiles flash, already infected ones do not
    const fresh = p.segments[1].tiles.filter((t) => t[8] > 0).length;
    expect(fresh).toBe(3);
  });

  it("mosaic ripples offsets out from a centre and alternates two grid sizes", () => {
    const p = plan("mosaic", { gridMax: 5 });
    expect(p.segments.slice(0, 4).map((s) => s.cols)).toEqual([5, 4, 5, 4]);
    for (const s of p.segments.slice(0, 6)) {
      const offsets = s.tiles.map((t) => t[0]);
      const centre = offsets.indexOf(Math.min(...offsets));
      expect(s.tiles[centre][8]).toBeGreaterThan(0); // centre flashes
      expect(Math.max(...offsets)).toBeGreaterThan(Math.min(...offsets));
    }
  });

  it("a still image gets frozen tiles with a Ken Burns zoom", () => {
    const p = planGridVideo(
      normalizeGridParams(
        gridVideoParams(
          inputs({
            source: "cj_grid_x.png [input]",
            sourceKind: "image",
            sourceSeconds: null,
          }),
          {
            style: "poster",
            aspect: "9:16",
            gridMax: 3,
            intensity: "medium",
            seed: 1,
          },
        ),
      ),
    );
    expect(p.still).toBe(true);
    expect(p.srcFrames).toBe(1);
    expect(p.height).toBe(1280);
    expectWellFormed(p);
    for (const s of p.segments)
      for (const t of s.tiles) {
        expect(t[0]).toBe(0);
        expect(t[1]).toBe(0);
        expect(t[3]).toBeGreaterThan(t[2]);
      }
  });

  it("caps the output at the max length and the source at what the node holds", () => {
    const p = planGridVideo(
      normalizeGridParams(
        gridVideoParams(inputs({ audioSeconds: 200, sourceSeconds: 60 }), {
          style: "mosaic",
          aspect: "16:9",
          gridMax: 6,
          intensity: "low",
        }),
      ),
    );
    expect(p.frames).toBe(GRID_VIDEO_MAX_SECONDS * GRID_VIDEO_FPS);
    expect(p.srcFrames).toBe(20 * GRID_VIDEO_FPS);
    expectWellFormed(p);
  });

  it("no beats -> steady 120 bpm cuts", () => {
    const p = plan("poster", { beats: [], bpm: null });
    expect(p.segments[0].f1).toBe(12);
    expect(p.segments[1].f1).toBe(24);
  });
});

describe("params validation", () => {
  const ok = () =>
    gridVideoParams(inputs(), {
      style: "poster",
      aspect: "1:1",
      gridMax: 4,
      intensity: "medium",
      seed: 1,
    });

  it("round-trips", () => {
    const spec = normalizeGridParams(ok());
    expect(spec).toMatchObject({
      style: "poster",
      aspect: "1:1",
      gridMax: 4,
      intensity: "medium",
      resolution: 720,
      audioSeconds: 40,
      sourceSeconds: 15,
    });
  });

  it.each([
    [{ source: "../etc/passwd [input]" }, /source/],
    [{ source: "clip.png [input]" }, /source/],
    [{ audio: "song.exe [input]" }, /audio/],
    [{ audioSeconds: 0 }, /audioSeconds/],
    [{ audioSeconds: 1 }, /under 2 s/],
    [{ style: "glitter" }, /style/],
    [{ aspect: "4:3" }, /aspect/],
    [{ resolution: 480 }, /resolution/],
    [{ beats: new Array(3000).fill(1) }, /too many beats/],
  ])("rejects %j", (over, re) => {
    expect(() => normalizeGridParams({ ...ok(), ...over })).toThrow(re);
  });

  it("clamps the grid size and accepts an image source", () => {
    expect(normalizeGridParams({ ...ok(), gridMax: 40 }).gridMax).toBe(6);
    expect(normalizeGridParams({ ...ok(), gridMax: 1 }).gridMax).toBe(2);
    expect(
      normalizeGridParams({
        ...ok(),
        source: "cj_grid_1.png [input]",
        sourceKind: "image",
      }).sourceKind,
    ).toBe("image");
  });
});

describe("grid_video builder + registry", () => {
  const base = JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        "public/workflows/packs/utility/grid_video.json",
      ),
      "utf-8",
    ),
  ) as Workflow;
  const run = { run_id: "r", jobs: [] } as unknown as ImagineRun;

  it("is registered", () => {
    const reg = registry as unknown as {
      actions: Record<string, { template: string }>;
      templates: Record<string, { file: string }>;
    };
    expect(reg.actions[GRID_VIDEO_ACTION].template).toBe("grid_video");
    expect(reg.templates.grid_video.file).toBe("packs/utility/grid_video.json");
    expect(ACTION_BUILDERS[GRID_VIDEO_ACTION]).toBe(buildGridVideoWorkflow);
  });

  it("fills the node with refs + the plan JSON", () => {
    const params = gridVideoParams(inputs(), {
      style: "infection",
      aspect: "9:16",
      gridMax: 3,
      intensity: "low",
      seed: 5,
    });
    const { workflow, slots, seed } = buildGridVideoWorkflow(
      base,
      run,
      0,
      params,
    );
    const id = Object.keys(workflow).find(
      (k) => workflow[k]?.class_type === GRID_VIDEO_NODE,
    )!;
    const node = workflow[id].inputs;
    expect(node.source).toBe("cj_clip_a1.mp4 [input]");
    expect(node.audio).toBe("cj_audio_a2.mp3 [input]");
    expect(node.filename_prefix).toBe("video/adrift_grid");
    expect(JSON.parse(node.plan as string)).toEqual(gridVideoPlan(params));
    expect(slots.ksamplerId).toBe(id);
    expect(seed).toBe(0);
    expect(base["1"].inputs.plan).toBe(""); // template untouched
  });

  it("throws on bad params", () => {
    expect(() =>
      buildGridVideoWorkflow(base, run, 0, { source: "x.mp4" }),
    ).toThrow(/grid_video/);
  });
});

describe("runGridVideo (mock fetch)", () => {
  function mockFetch() {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let uploads = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200 });
      if (url === "/api/comfy/upload")
        return json({ ref: `${body.filename} [input]`, n: uploads++ });
      if (url === "/api/jobs/seed-run")
        return json({ run: { run_id: "seed", jobs: [{ index: 0 }] } });
      if (url === "/api/jobs/action")
        return json({
          run: { run_id: "grid", jobs: [{ index: 0, prompt_id: "p1" }] },
          prompt_id: "p1",
        });
      if (url.startsWith("/api/comfy/history/"))
        return json({
          status: "completed",
          videos: [
            {
              filename: "adrift_grid_00001_.mp4",
              subfolder: "video",
              type: "output",
              url: "/api/comfy/view?filename=adrift_grid_00001_.mp4&subfolder=video&type=output",
            },
          ],
          images: [],
          audios: [],
        });
      return new Response("nope", { status: 404 });
    };
    return { calls, fetchImpl };
  }

  it("uploads source + music, sends grid_video with beats, returns the clip", async () => {
    const { calls, fetchImpl } = mockFetch();
    const res = await runGridVideo(
      {
        kind: "video",
        dataUrl: "data:video/mp4;base64,AA",
        label: "a.mp4",
        seconds: 12,
      },
      {
        dataUrl: "data:audio/mpeg;base64,AA",
        label: "song.mp3",
        seconds: 30,
        beats: [0.5, 1, 1.5],
        bpm: 120,
      },
      {
        style: "mosaic",
        aspect: "1:1",
        gridMax: 4,
        intensity: "medium",
        seed: 3,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        clientId: "c",
        pollMs: 0,
        sleep: async () => {},
        measure: async () => 30,
      },
    );
    const act = calls.find((c) => c.url === "/api/jobs/action")!;
    expect(act.body.action).toBe("grid_video");
    const params = act.body.params as Record<string, unknown>;
    expect(params.source).toMatch(/^cj_clip_.*\.mp4 \[input\]$/);
    expect(params.audio).toMatch(/^cj_audio_.*\.mp3 \[input\]$/);
    expect(params).toMatchObject({
      style: "mosaic",
      beats: [0.5, 1, 1.5],
      audioSeconds: 30,
      sourceSeconds: 12,
    });
    expect(res.video.ref).toBe("video/adrift_grid_00001_.mp4 [output]");
    expect(res.video.seconds).toBe(30);
  });

  it("explains a missing CJGridVideo node", () => {
    expect(
      gridVideoError(
        new Error("Cannot execute because node CJGridVideo does not exist."),
      ).message,
    ).toMatch(/cj_h3_tools/);
    const other = new Error("boom");
    expect(gridVideoError(other)).toBe(other);
  });
});

describe("hub card", () => {
  it("shape", () => {
    const c = gridVideoCard();
    expect(c.key).toBe(GRID_VIDEO_KEY);
    expect(c.kind).toBe("special");
    expect(c.hubCategory).toBe("Video");
    expect(c.available).toBe(true);
    expect(c.aliases).toEqual(
      expect.arrayContaining(["music video", "beat sync", "mosaic"]),
    );
  });

  it("is on the hub", () => {
    const ctx: EngineContext = {
      catalog: [],
      packIds: new Set<string>(),
      editLoras: null,
    };
    const keys = buildHubCards({ toolCards: [], ctx }).map((c) => c.key);
    expect(keys).toContain(GRID_VIDEO_KEY);
  });
});
