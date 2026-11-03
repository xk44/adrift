/**
 * wan_move free draw: drawing parser, path walking, motion-brush seeds,
 * pixel tracks, builder + Tools page request wiring.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImagineRun, Workflow } from "@/types";
import {
  WAN_MOVE_DRAW_LIMITS,
  hasWanMoveDraw,
  parseWanMoveDraw,
  pathLength,
  pointAlong,
  sampleMaskSeeds,
  simplifyStroke,
  startCluster,
  wanMoveDrawTracks,
  type WanMoveDraw,
} from "@/lib/oj/wanMoveDraw";
import {
  WAN_MOVE_NODES as N,
  buildWanMoveWorkflow,
  wanMoveDrawPrompt,
} from "@/lib/oj/wanMove";
import {
  ToolInputError,
  buildActionRequest,
  defaultSettings,
  getActionTool,
  pickerVisible,
} from "@/lib/tools/toolsPage";

const MOVE: Workflow = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "public/workflows/packs/wan22/wan_move.json"),
    "utf-8",
  ),
);

function run(width = 1024, height = 1024): ImagineRun {
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
        images: ["/api/comfy/view?filename=src.png&subfolder=&type=input"],
      },
    ],
    params: {},
  } as ImagineRun;
}

const RIGHT: WanMoveDraw = {
  paths: [
    {
      points: [
        { x: 0.2, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.8, y: 0.5 },
      ],
    },
  ],
};

describe("parseWanMoveDraw", () => {
  it("keeps a clean drawing and clamps/rounds coordinates", () => {
    const d = parseWanMoveDraw({
      paths: [
        {
          points: [
            { x: -0.5, y: 0.123456 },
            { x: 1.7, y: 0.5 },
          ],
          seeds: [
            { x: 0.1, y: 0.2 },
            { x: "a", y: 1 },
          ],
        },
      ],
      pins: [{ x: 0.9, y: 0.9 }, null],
    });
    expect(d).toEqual({
      paths: [
        {
          points: [
            { x: 0, y: 0.1235 },
            { x: 1, y: 0.5 },
          ],
          seeds: [{ x: 0.1, y: 0.2 }],
        },
      ],
      pins: [{ x: 0.9, y: 0.9 }],
    });
  });

  it("drops taps, garbage and pins-only drawings", () => {
    expect(parseWanMoveDraw(null)).toBeNull();
    expect(parseWanMoveDraw({ paths: "x" })).toBeNull();
    expect(
      parseWanMoveDraw({
        paths: [
          {
            points: [
              { x: 0.5, y: 0.5 },
              { x: 0.505, y: 0.5 },
            ],
          },
        ],
        pins: [{ x: 0.1, y: 0.1 }],
      }),
    ).toBeNull();
    expect(
      parseWanMoveDraw({ paths: [{ points: [{ x: 0.5, y: 0.5 }] }] }),
    ).toBeNull();
    expect(hasWanMoveDraw(RIGHT)).toBe(true);
    expect(hasWanMoveDraw({ paths: [] })).toBe(false);
  });

  it("caps paths, points, seeds and pins", () => {
    const L = WAN_MOVE_DRAW_LIMITS;
    const long = Array.from({ length: 500 }, (_, i) => ({
      x: i / 499,
      y: 0.5,
    }));
    const many = Array.from({ length: 100 }, (_, i) => ({
      x: (i % 10) / 10,
      y: Math.floor(i / 10) / 10,
    }));
    const d = parseWanMoveDraw({
      paths: Array.from({ length: 20 }, () => ({ points: long, seeds: many })),
      pins: many,
    })!;
    expect(d.paths).toHaveLength(L.paths);
    expect(d.paths[0].points).toHaveLength(L.pathPoints);
    // First and last stroke points survive the thinning.
    expect(d.paths[0].points[0]).toEqual({ x: 0, y: 0.5 });
    expect(d.paths[0].points.at(-1)).toEqual({ x: 1, y: 0.5 });
    expect(d.paths[0].seeds).toHaveLength(L.seedsPerPath);
    expect(d.pins).toHaveLength(L.pins);
  });
});

describe("path walking", () => {
  it("walks by arc length", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0 },
      { x: 0.3, y: 0.1 },
    ];
    expect(pathLength(pts)).toBeCloseTo(0.4);
    expect(pointAlong(pts, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAlong(pts, 0.5).x).toBeCloseTo(0.2);
    expect(pointAlong(pts, 0.875).y).toBeCloseTo(0.05);
    expect(pointAlong(pts, 1)).toEqual({ x: 0.3, y: 0.1 });
  });

  it("simplifies a jittery stroke to evenly spaced points", () => {
    const raw = Array.from({ length: 300 }, (_, i) => ({
      x: 0.1 + (0.6 * i) / 299,
      y: 0.5 + (i % 2 ? 0.0001 : 0),
    }));
    const s = simplifyStroke(raw);
    expect(s.length).toBeGreaterThan(10);
    expect(s.length).toBeLessThanOrEqual(WAN_MOVE_DRAW_LIMITS.pathPoints);
    expect(s[0].x).toBeCloseTo(0.1);
    expect(s.at(-1)!.x).toBeCloseTo(0.7, 3);
    expect(simplifyStroke([{ x: 0.2, y: 0.2 }])).toHaveLength(1);
  });

  it("start cluster is round in pixels", () => {
    const c = startCluster({ x: 0.5, y: 0.5 }, 2); // 2:1 frame
    expect(c).toHaveLength(5);
    const dxPx = (c[2].x - c[0].x) * 2; // x scaled by aspect
    const dyPx = c[4].y - c[0].y;
    expect(dxPx).toBeCloseTo(dyPx);
  });
});

describe("sampleMaskSeeds", () => {
  const W = 64;
  const H = 32;
  const gray = (inside: (x: number, y: number) => boolean) => {
    const a = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) a[y * W + x] = inside(x, y) ? 255 : 0;
    return a;
  };

  it("returns [] for an empty mask", () => {
    expect(
      sampleMaskSeeds(
        gray(() => false),
        W,
        H,
      ),
    ).toEqual([]);
  });

  it("spreads points inside a blob, capped", () => {
    // Circle centered (16, 16) r 10.
    const m = gray((x, y) => Math.hypot(x - 16, y - 16) <= 10);
    const s = sampleMaskSeeds(m, W, H, 12);
    expect(s.length).toBeGreaterThan(4);
    expect(s.length).toBeLessThanOrEqual(12);
    for (const p of s) {
      expect(Math.hypot(p.x * W - 16, p.y * H - 16)).toBeLessThanOrEqual(11);
    }
  });

  it("reads RGBA overlays (opaque + bright) and white-on-black PNGs", () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 40; x < 60; x++) {
        const i = (y * W + x) * 4;
        rgba.set([236, 72, 153, 255], i);
      }
    // Opaque black elsewhere (mask PNG background) must not count.
    for (let y = 0; y < H; y++)
      for (let x = 0; x < 40; x++) rgba[(y * W + x) * 4 + 3] = 255;
    const s = sampleMaskSeeds(rgba, W, H);
    expect(s.length).toBeGreaterThan(0);
    for (const p of s) expect(p.x * W).toBeGreaterThanOrEqual(40);
  });

  it("finds a thin sliver the grid misses", () => {
    const s = sampleMaskSeeds(
      gray((x, y) => x === 33 && y === 7),
      W,
      H,
    );
    expect(s).toHaveLength(1);
    expect(s[0].x).toBeCloseTo(33.5 / W, 3);
    expect(s[0].y).toBeCloseTo(7.5 / H, 3);
  });
});

describe("wanMoveDrawTracks", () => {
  it("moves the start cluster along the path, one point per frame", () => {
    const t = wanMoveDrawTracks(RIGHT, 800, 400, 49);
    expect(t).toHaveLength(5);
    for (const tr of t) {
      expect(tr).toHaveLength(49);
      expect(tr[48].x - tr[0].x).toBeGreaterThan(0.55 * 800);
      expect(tr[48].y).toBe(tr[0].y);
    }
    expect(t[0][0]).toEqual({ x: 160, y: 200 });
    // Ease-in-out: slow start.
    expect(t[0][2].x - t[0][0].x).toBeLessThan(5);
  });

  it("motion brush: every region seed follows the path displacement", () => {
    const seeds = [
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.6 },
    ];
    const t = wanMoveDrawTracks(
      { paths: [{ ...RIGHT.paths[0], seeds }] },
      1000,
      1000,
      17,
    );
    expect(t).toHaveLength(2);
    expect(t[0][0]).toEqual({ x: 100, y: 100 });
    expect(t[1][0]).toEqual({ x: 300, y: 600 });
    expect(t[0][16]).toEqual({ x: 700, y: 100 });
    expect(t[1][16]).toEqual({ x: 900, y: 600 });
  });

  it("follows curves, clamps to the frame, and appends static pins", () => {
    const d: WanMoveDraw = {
      paths: [
        {
          points: [
            { x: 0.5, y: 0.9 },
            { x: 0.5, y: 0.1 },
            { x: 0.9, y: 0.1 },
          ],
          seeds: [{ x: 0.95, y: 0.5 }],
        },
      ],
      pins: [{ x: 0.2, y: 0.8 }],
    };
    const t = wanMoveDrawTracks(d, 832, 480, 81);
    expect(t).toHaveLength(2);
    const seed = t[0];
    // Goes up first, then right (clamped at the right edge).
    expect(Math.min(...seed.map((p) => p.y))).toBeLessThan(seed[0].y - 150);
    expect(seed[80].x).toBe(831);
    for (const p of seed) expect(p.y).toBeGreaterThanOrEqual(0);
    const pin = t[1];
    expect(new Set(pin.map((p) => `${p.x},${p.y}`)).size).toBe(1);
    expect(pin[0]).toEqual({ x: 166, y: 384 });
  });
});

describe("buildWanMoveWorkflow with a drawing", () => {
  it("writes drawn tracks and the path prompt instead of the preset", () => {
    const { workflow } = buildWanMoveWorkflow(MOVE, run(1920, 1080), 0, {
      draw: RIGHT,
      trajectory: "swirl",
      region: "top",
      duration: "3s",
      prompt: "the paper boat",
      seed: 1,
    });
    const tracks = JSON.parse(String(workflow[N.coords].inputs.value));
    expect(tracks).toHaveLength(5);
    expect(tracks[0]).toHaveLength(49);
    expect(tracks[0][0]).toEqual({ x: Math.round(0.2 * 848), y: 240 });
    expect(tracks[0][48].x).toBeGreaterThan(tracks[0][0].x + 400);
    expect(workflow[N.pos].inputs.text).toBe(
      "The paper boat moves smoothly along its path; the rest of the scene stays natural.",
    );
    expect(workflow[N.tracks].class_type).toBe("WanMoveTracksFromCoords");
    expect(workflow[N.tracks].inputs.track_coords).toEqual([N.coords, 0]);
    expect(workflow[N.move].inputs.tracks).toEqual([N.tracks, 0]);
    expect(workflow[N.move].inputs.length).toBe(49);
  });

  it("rejects an unusable drawing instead of silently using a preset", () => {
    expect(() =>
      buildWanMoveWorkflow(MOVE, run(), 0, { draw: { paths: [] } }),
    ).toThrow(/drawing/);
    // Absent / null draw = preset path.
    const { workflow } = buildWanMoveWorkflow(MOVE, run(), 0, {
      draw: null,
      anchor: false,
    });
    expect(JSON.parse(String(workflow[N.coords].inputs.value))).toHaveLength(
      16,
    );
  });

  it("anchors only fully-seeded drawings", () => {
    const coords = (draw: WanMoveDraw) =>
      JSON.parse(
        String(
          buildWanMoveWorkflow(MOVE, run(), 0, { draw, seed: 1 }).workflow[N.coords]
            .inputs.value,
        ),
      ) as unknown[];
    const seeded: WanMoveDraw = {
      paths: [{ ...RIGHT.paths[0], seeds: [{ x: 0.2, y: 0.5 }, { x: 0.25, y: 0.55 }] }],
    };
    expect(coords(seeded).length).toBeGreaterThan(2);
    expect(coords({ paths: [RIGHT.paths[0]] })).toHaveLength(
      wanMoveDrawTracks({ paths: [RIGHT.paths[0]] }, 480, 480, 81).length,
    );
  });

  it("multi-path prompt", () => {
    expect(wanMoveDrawPrompt("", 2)).toMatch(
      /^The subject and the marked parts/,
    );
  });
});

describe("Tools page: Draw your own", () => {
  const spec = getActionTool("wan_move")!;

  it("hides preset pickers in draw mode and keeps presets the default", () => {
    const s = defaultSettings(spec);
    const vis = (key: string, picks: Record<string, string>) =>
      pickerVisible(
        spec.pickers!.find((p) => p.key === key)!,
        spec,
        { ...s, picks },
      );
    expect(spec.pickers![0].key).toBe("source");
    expect(vis("trajectory", {})).toBe(true);
    expect(vis("region", {})).toBe(true);
    expect(vis("trajectory", { source: "draw" })).toBe(false);
    expect(vis("region", { source: "draw" })).toBe(false);
  });

  it("requires a path, then sends the sanitized drawing", () => {
    const s = { ...defaultSettings(spec), picks: { source: "draw" } };
    expect(() => buildActionRequest(spec, s, null)).toThrow(ToolInputError);
    const req = buildActionRequest(
      spec,
      { ...s, text: "the kite", wanMoveDraw: RIGHT },
      null,
    );
    expect(req).toEqual({
      action: "wan_move",
      params: {
        pack_id: "wan22",
        draw: RIGHT,
        mode: "fast",
        duration: "5s",
        prompt: "the kite",
      },
      overrides: {},
    });
  });
});
