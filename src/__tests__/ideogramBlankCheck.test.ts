import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blankCanvasStats,
  blankCheckSettled,
  isBlankCanvas,
  isIdeogramGraph,
  SAFETY_FILTER_MESSAGE,
  shouldAutoRerollBlank,
} from "@/lib/imageQc/blank";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function solid(w: number, h: number, rgb: number[], channels = 3) {
  const d = new Uint8Array(w * h * channels);
  for (let p = 0; p < w * h; p++)
    for (let c = 0; c < channels; c++) d[p * channels + c] = rgb[c] ?? 255;
  return d;
}

function noisy(base: Uint8Array, amp: number, seed = 1) {
  const r = rng(seed);
  return base.map((v) =>
    Math.max(0, Math.min(255, Math.round(v + (r() * 2 - 1) * amp))),
  );
}

function gradient(w: number, h: number) {
  const d = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      d[i] = Math.round((x / (w - 1)) * 255);
      d[i + 1] = Math.round((y / (h - 1)) * 255);
      d[i + 2] = 128;
    }
  return d;
}

describe("blank canvas detector", () => {
  it("flags solid canvases of any colour", () => {
    for (const c of [
      [0, 0, 0],
      [255, 255, 255],
      [128, 128, 128],
      [30, 90, 200],
    ])
      expect(isBlankCanvas(blankCanvasStats(solid(96, 96, c), 3))).toBe(true);
  });

  it("flags a near-solid canvas with faint noise", () => {
    const s = blankCanvasStats(noisy(solid(96, 96, [12, 12, 12]), 2), 3);
    expect(s.std).toBeLessThan(2);
    expect(isBlankCanvas(s)).toBe(true);
  });

  it("ignores alpha and handles RGBA buffers", () => {
    const d = solid(32, 32, [200, 10, 10, 0], 4);
    for (let i = 3; i < d.length; i += 8) d[i] = 255;
    expect(isBlankCanvas(blankCanvasStats(d, 4))).toBe(true);
  });

  it("does not flag gradients, noise or flat scenes with grain", () => {
    expect(isBlankCanvas(blankCanvasStats(gradient(96, 96), 3))).toBe(false);
    const r = rng(7);
    const pure = new Uint8Array(96 * 96 * 3).map(() => Math.floor(r() * 256));
    expect(isBlankCanvas(blankCanvasStats(pure, 3))).toBe(false);
    // A plain wall/sky: mostly flat, real sensor-like grain.
    const wall = noisy(solid(96, 96, [180, 200, 230]), 12, 3);
    expect(isBlankCanvas(blankCanvasStats(wall, 3))).toBe(false);
  });

  it("does not flag a flat canvas with a small subject", () => {
    const d = solid(96, 96, [255, 255, 255]);
    for (let y = 40; y < 52; y++)
      for (let x = 40; x < 52; x++)
        d.fill(0, (y * 96 + x) * 3, (y * 96 + x) * 3 + 3);
    expect(isBlankCanvas(blankCanvasStats(d, 3))).toBe(false);
  });

  it("treats an empty buffer as not blank", () => {
    expect(isBlankCanvas(blankCanvasStats(new Uint8Array(0), 3))).toBe(false);
  });
});

describe("isIdeogramGraph", () => {
  it("matches the Ideogram 4 scheduler or text encoder", () => {
    expect(
      isIdeogramGraph({
        "9": { class_type: "Ideogram4Scheduler", inputs: {} },
      }),
    ).toBe(true);
    expect(
      isIdeogramGraph({
        "3": { class_type: "CLIPLoader", inputs: { type: "ideogram4" } },
      }),
    ).toBe(true);
  });

  it("does not match other tools (masks, solid fills, SD)", () => {
    expect(isIdeogramGraph(null)).toBe(false);
    expect(
      isIdeogramGraph({
        "1": { class_type: "SolidMask", inputs: { value: 1 } },
        "2": { class_type: "EmptyImage", inputs: { color: 0 } },
        "3": { class_type: "CLIPLoader", inputs: { type: "flux2" } },
        "4": { class_type: "KSampler", inputs: {} },
      }),
    ).toBe(false);
  });
});

describe("reroll-once policy", () => {
  it("re-rolls only a blank first attempt that hasn't re-rolled", () => {
    expect(shouldAutoRerollBlank(true, 1, false)).toBe(true);
    expect(shouldAutoRerollBlank(false, 1, false)).toBe(false);
    expect(shouldAutoRerollBlank(true, 1, true)).toBe(false);
    expect(shouldAutoRerollBlank(true, 2, false)).toBe(false);
  });

  it("settles polling once nothing more will happen on its own", () => {
    const k = "output/a.png";
    const fail = { [k]: { status: "fail" } };
    expect(blankCheckSettled(null, k)).toBe(false);
    expect(blankCheckSettled({ attempt: 1, outputs: {} }, k)).toBe(false);
    expect(blankCheckSettled({ attempt: 1, outputs: fail }, k)).toBe(false);
    expect(
      blankCheckSettled(
        { attempt: 1, outputs: { [k]: { status: "pass" } } },
        k,
      ),
    ).toBe(true);
    expect(
      blankCheckSettled({ attempt: 1, outputs: fail, rerolls: [{}] }, k),
    ).toBe(true);
    expect(blankCheckSettled({ attempt: 2, outputs: fail }, k)).toBe(true);
    expect(
      blankCheckSettled({ attempt: 1, outputs: fail, error: "x" }, k),
    ).toBe(true);
  });
});

// Server wiring: decode -> flag -> auto re-roll at most once.

type Qc = {
  version: 1;
  status: string;
  attempt: number;
  outputs: Record<string, { status: string; issues: { kind: string }[] }>;
  rerolls?: { auto: boolean }[];
  error?: string;
};

const store = new Map<string, Qc>();
const graphs = new Map<string, Record<string, unknown>>();
let pngBytes: Buffer;

const rerollJob = vi.fn(async (jobId: string) => {
  const newId = `${jobId}-r`;
  store.set(newId, { version: 1, status: "pending", attempt: 2, outputs: {} });
  const q = store.get(jobId)!;
  q.rerolls = [...(q.rerolls ?? []), { auto: true }];
  return { jobId: newId };
});

vi.mock("@/lib/db", () => ({
  getDB: () => ({
    prepare: () => ({
      get: (jobId: string) =>
        store.has(jobId) || graphs.has(jobId)
          ? { prompt_id_comfy: `p-${jobId}` }
          : undefined,
    }),
  }),
}));
vi.mock("@/lib/comfy/http", () => ({
  fetchImageResponse: vi.fn(async () => new Response(new Uint8Array(pngBytes))),
}));
vi.mock("@/lib/videoEdit/server", () => ({ redactPaths: (s: string) => s }));
vi.mock("@/lib/videoQc/server", () => ({
  outputKey: (v: { type: string; subfolder: string; filename: string }) =>
    `${v.type}/${v.subfolder ? `${v.subfolder}/` : ""}${v.filename}`,
  readJobQc: (id: string) => store.get(id) ?? null,
  updateJobQc: (id: string, fn: (q: Qc) => void) => {
    const q =
      store.get(id) ??
      ({ version: 1, status: "pending", attempt: 1, outputs: {} } as Qc);
    fn(q);
    store.set(id, q);
    return q;
  },
  historyFor: async (promptId: string) => {
    const jobId = promptId.slice(2);
    return {
      prompt: [0, promptId, graphs.get(jobId) ?? {}, {}],
      outputs: {
        "15": {
          images: [{ filename: "a.png", subfolder: "", type: "output" }],
        },
      },
      status: { completed: true, status_str: "success" },
    };
  },
  graphOf: (h: { prompt: unknown[] }) => h.prompt[2],
  rerollJob: (jobId: string) => rerollJob(jobId),
}));

const IDEOGRAM = { "9": { class_type: "Ideogram4Scheduler", inputs: {} } };
const REF = { filename: "a.png", subfolder: "", type: "output" as const };

async function png(raw: Uint8Array, w: number, h: number) {
  return sharp(Buffer.from(raw), { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

describe("scheduleBlankCheck", () => {
  beforeEach(() => {
    store.clear();
    graphs.clear();
    rerollJob.mockClear();
  });

  it("flags a blank Ideogram output and re-rolls exactly once", async () => {
    const { scheduleBlankCheck } = await import("@/lib/imageQc/server");
    pngBytes = await png(solid(256, 256, [0, 0, 0]), 256, 256);
    graphs.set("run:0", IDEOGRAM);

    await scheduleBlankCheck("run:0", REF);
    const qc = store.get("run:0")!;
    expect(qc.outputs["output/a.png"].status).toBe("fail");
    expect(qc.outputs["output/a.png"].issues[0]).toMatchObject({
      kind: "safety_filter",
      message: SAFETY_FILTER_MESSAGE,
    });
    expect(rerollJob).toHaveBeenCalledTimes(1);

    // A forced re-check of the same job does not re-roll again.
    await scheduleBlankCheck("run:0", REF, { force: true });
    expect(rerollJob).toHaveBeenCalledTimes(1);

    // The re-roll comes back blank too: flagged, no further re-roll.
    graphs.set("run:0-r", IDEOGRAM);
    await scheduleBlankCheck("run:0-r", REF);
    expect(store.get("run:0-r")!.outputs["output/a.png"].status).toBe("fail");
    expect(rerollJob).toHaveBeenCalledTimes(1);
  });

  it("passes a real-looking Ideogram image without re-rolling", async () => {
    const { scheduleBlankCheck } = await import("@/lib/imageQc/server");
    pngBytes = await png(gradient(256, 256), 256, 256);
    graphs.set("run2:0", IDEOGRAM);
    await scheduleBlankCheck("run2:0", REF);
    expect(store.get("run2:0")!.outputs["output/a.png"].status).toBe("pass");
    expect(rerollJob).not.toHaveBeenCalled();
  });

  it("leaves flat outputs of non-Ideogram graphs alone", async () => {
    const { scheduleBlankCheck } = await import("@/lib/imageQc/server");
    pngBytes = await png(solid(64, 64, [255, 255, 255]), 64, 64);
    graphs.set("mask:0", { "1": { class_type: "SolidMask", inputs: {} } });
    await scheduleBlankCheck("mask:0", REF);
    expect(store.has("mask:0")).toBe(false);
    expect(rerollJob).not.toHaveBeenCalled();
  });
});
