/**
 * Outpaint seam harmonize: pan / zoom graphs get a low-denoise masked img2img
 * pass over a feathered band straddling the source edge, composited back in
 * front of SaveImage. Covers band geometry, graph wiring for all three
 * outpaint templates, the registry toggle, and (opt-in) a LIVE object_info
 * check of every node the pass adds.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import { buildActionWorkflow, seamHarmonizeOptionsFor } from "@/lib/oj/engine";
import {
  SEAM_HARMONIZE_DEFAULTS,
  SEAM_TITLE_PREFIX,
  addSeamHarmonize,
  planSeamBand,
} from "@/lib/oj/outpaintSeam";
import { validatePrompt } from "@/lib/comfy/validatePrompt";
import registry from "@/lib/oj/registry.json";

const packFile = (rel: string): Workflow =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/workflows", rel), "utf-8"),
  );

const run = (width: number, height: number): ImagineRun =>
  ({
    run_id: "r1",
    prompt: "a fox in a meadow",
    parsedPrompt: "a fox in a meadow",
    width,
    height,
    jobs: [
      { seed: 7, index: 0, status: "completed", progress: 100, images: [] },
    ],
    createdAt: new Date().toISOString(),
    status: "completed",
    params: {},
  }) as unknown as ImagineRun;

type Node = Workflow[string];
const seamNodes = (wf: Workflow): Array<[string, Node]> =>
  Object.entries(wf).filter(([, n]) =>
    n?._meta?.title?.startsWith(SEAM_TITLE_PREFIX),
  );
const byTitle = (wf: Workflow, suffix: string): [string, Node] => {
  const hit = seamNodes(wf).find(
    ([, n]) => n._meta?.title === `${SEAM_TITLE_PREFIX}: ${suffix}`,
  );
  if (!hit) throw new Error(`no seam node "${suffix}"`);
  return hit;
};
const saveNode = (wf: Workflow): Node =>
  Object.values(wf).find((n) => n?.class_type === "SaveImage") as Node;

/** Rasterize the band mask the graph builds (SolidMask + MaskComposite). */
function rasterizeMask(wf: Workflow, id: string): Float32Array & { w: number } {
  const node = wf[id];
  const ins = node.inputs as Record<string, any>;
  if (node.class_type === "SolidMask") {
    const m = new Float32Array(ins.width * ins.height).fill(ins.value) as any;
    m.w = ins.width;
    return m;
  }
  if (node.class_type === "MaskComposite") {
    const dst = rasterizeMask(wf, ins.destination[0]);
    const src = rasterizeMask(wf, ins.source[0]);
    const out = Float32Array.from(dst) as any;
    out.w = dst.w;
    const dh = dst.length / dst.w;
    const sh = src.length / src.w;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < src.w; x++) {
        const dx = ins.x + x;
        const dy = ins.y + y;
        if (dx >= dst.w || dy >= dh) continue;
        const i = dy * dst.w + dx;
        const v = src[y * src.w + x];
        out[i] =
          ins.operation === "add"
            ? Math.min(1, out[i] + v)
            : Math.max(0, out[i] - v);
      }
    return out;
  }
  throw new Error(`unexpected mask node ${node.class_type}`);
}

describe("planSeamBand", () => {
  it("zoom: a ring straddling all four source edges", () => {
    const b = planSeamBand(
      {
        canvasWidth: 1536,
        canvasHeight: 1536,
        x0: 256,
        y0: 256,
        x1: 1280,
        y1: 1280,
      },
      24,
    )!;
    expect(b.sides).toEqual({
      left: true,
      right: true,
      top: true,
      bottom: true,
    });
    expect(b.outer).toEqual({ x: 232, y: 232, width: 1072, height: 1072 });
    expect(b.inner).toEqual({ x: 280, y: 280, width: 976, height: 976 });
  });

  it("pan left: one vertical strip, centred on the left source edge", () => {
    const b = planSeamBand(
      {
        canvasWidth: 1536,
        canvasHeight: 1024,
        x0: 512,
        y0: 0,
        x1: 1536,
        y1: 1024,
      },
      24,
    )!;
    expect(b.sides).toEqual({
      left: true,
      right: false,
      top: false,
      bottom: false,
    });
    expect(b.outer).toEqual({ x: 488, y: 0, width: 1048, height: 1024 });
    expect(b.inner).toEqual({ x: 536, y: 0, width: 1000, height: 1024 });
  });

  it("pan down: one horizontal strip on the bottom edge", () => {
    const b = planSeamBand(
      {
        canvasWidth: 1024,
        canvasHeight: 1536,
        x0: 0,
        y0: 0,
        x1: 1024,
        y1: 1024,
      },
      32,
    )!;
    expect(b.outer).toEqual({ x: 0, y: 0, width: 1024, height: 1056 });
    expect(b.inner).toEqual({ x: 0, y: 0, width: 1024, height: 992 });
  });

  it("clamps to the canvas and drops a fully covered interior", () => {
    const b = planSeamBand(
      { canvasWidth: 64, canvasHeight: 64, x0: 8, y0: 8, x1: 56, y1: 56 },
      30,
    )!;
    expect(b.outer).toEqual({ x: 0, y: 0, width: 64, height: 64 });
    expect(b.inner).toBeNull();
  });

  it("no padded side = nothing to harmonize", () => {
    expect(
      planSeamBand(
        { canvasWidth: 512, canvasHeight: 512, x0: 0, y0: 0, x1: 512, y1: 512 },
        24,
      ),
    ).toBeNull();
  });
});

describe("registry toggle", () => {
  it("outpaint template has the pass on by default", () => {
    const t = (registry as any).templates.outpaint.seamHarmonize;
    expect(t.enabled).toBe(true);
    expect(t.denoise).toBeGreaterThanOrEqual(0.2);
    expect(t.denoise).toBeLessThanOrEqual(0.35);
    expect(t.bandPx).toBeGreaterThanOrEqual(32);
    expect(t.bandPx).toBeLessThanOrEqual(64);
  });

  it.each([
    "pan_up",
    "pan_down",
    "pan_left",
    "pan_right",
    "zoom_1_5x",
    "zoom_2x",
  ])("%s resolves the registry settings", (action) => {
    expect(seamHarmonizeOptionsFor(action, {})).toEqual({
      denoise: 0.3,
      bandPx: 48,
      featherPx: 16,
    });
  });

  it("params.seamHarmonize=false turns it off for a run", () => {
    expect(
      seamHarmonizeOptionsFor("pan_left", { seamHarmonize: false }),
    ).toBeNull();
  });

  it("non-outpaint actions never get it", () => {
    expect(seamHarmonizeOptionsFor("vary_subtle", {})).toBeNull();
  });
});

const TEMPLATES = [
  "outpaint.json",
  "packs/krea2/outpaint.json",
  "packs/krea2/outpaintv2.json",
];

describe.each(TEMPLATES)("%s gets the seam pass", (file) => {
  it("zoom_2x: band pass wired in front of SaveImage", () => {
    const { workflow, slots } = buildActionWorkflow(
      packFile(file),
      "zoom_2x",
      run(1024, 768),
      0,
    );
    const [compId, comp] = byTitle(workflow, "composite");
    expect(comp.class_type).toBe("ImageCompositeMasked");
    expect(saveNode(workflow).inputs.images).toEqual([compId, 0]);

    const [, ks] = byTitle(workflow, "sampler");
    const ksIn = ks.inputs as Record<string, any>;
    expect(ks.class_type).toBe("KSampler");
    expect(ksIn.denoise).toBe(0.3);
    const main = workflow[slots.ksamplerId].inputs as Record<string, any>;
    expect(main.denoise).toBe(1);
    expect(ksIn.seed).toBe(main.seed);
    expect(ksIn.steps).toBe(main.steps);

    // encode the outpaint result -> noise-masked latent -> sampler -> decode
    const [encId, enc] = byTitle(workflow, "encode");
    const [maskedId, masked] = byTitle(workflow, "noise mask");
    const [decId, dec] = byTitle(workflow, "decode");
    expect(enc.class_type).toBe("VAEEncode");
    expect(masked.class_type).toBe("SetLatentNoiseMask");
    expect(masked.inputs.samples).toEqual([encId, 0]);
    expect(ksIn.latent_image).toEqual([maskedId, 0]);
    expect(dec.inputs.samples).toEqual([byTitle(workflow, "sampler")[0], 0]);
    expect(comp.inputs.source).toEqual([decId, 0]);
    // the composite destination is the original outpaint output, which is
    // also what got re-encoded: untouched pixels outside the band
    expect(comp.inputs.destination).toEqual(enc.inputs.pixels);
    expect((comp.inputs.destination as unknown[])[0]).not.toBe(compId);

    // feathered composite mask
    const [, featherOut] = byTitle(workflow, "feather out");
    expect(comp.inputs.mask).toEqual([byTitle(workflow, "feather out")[0], 0]);
    expect(featherOut.class_type).toBe("ImageToMask");
    const [, blur] = byTitle(workflow, "feather");
    expect(blur.class_type).toBe("ImageBlur");
    expect(blur.inputs.blur_radius).toBe(16);
  });

  it("zoom_2x: band masks sit on the source edge (1024x768 at 512,384)", () => {
    const { workflow } = buildActionWorkflow(
      packFile(file),
      "zoom_2x",
      run(1024, 768),
      0,
    );
    // 2x zoom pads 512 px per side horizontally, 384 vertically
    const W = 2048;
    const blend = rasterizeMask(
      workflow,
      byTitle(workflow, "blend band cut inner")[0],
    );
    const noise = rasterizeMask(
      workflow,
      byTitle(workflow, "noise band cut inner")[0],
    );
    expect(blend.w).toBe(W);
    expect(blend.length / W).toBe(1536);
    const at = (m: Float32Array, x: number, y: number) => m[y * W + x];
    const midY = 384 + 384; // a row through the middle of the source
    // left seam at x=512: band [488, 536)
    expect(at(blend, 487, midY)).toBe(0);
    expect(at(blend, 488, midY)).toBe(1);
    expect(at(blend, 535, midY)).toBe(1);
    expect(at(blend, 536, midY)).toBe(0);
    // source interior + far outpaint area untouched
    expect(at(blend, 1024, midY)).toBe(0);
    expect(at(blend, 100, midY)).toBe(0);
    // top seam at y=384
    expect(at(blend, 1024, 360)).toBe(1);
    expect(at(blend, 1024, 407)).toBe(1);
    expect(at(blend, 1024, 408)).toBe(0);
    // right/bottom seams at x=1536, y=1152
    expect(at(blend, 1559, midY)).toBe(1);
    expect(at(blend, 1560, midY)).toBe(0);
    expect(at(blend, 1024, 1175)).toBe(1);
    expect(at(blend, 1024, 1176)).toBe(0);
    // noise band = blend band + feather on each side
    expect(at(noise, 472, midY)).toBe(1);
    expect(at(noise, 471, midY)).toBe(0);
    expect(at(noise, 551, midY)).toBe(1);
    expect(at(noise, 552, midY)).toBe(0);
    // the latent noise mask is the wider band
    const [, masked] = byTitle(workflow, "noise mask");
    expect(masked.inputs.mask).toEqual([
      byTitle(workflow, "noise band cut inner")[0],
      0,
    ]);
  });

  it("pan_left: a single vertical strip at the left source edge", () => {
    const { workflow } = buildActionWorkflow(
      packFile(file),
      "pan_left",
      run(1024, 1024),
      0,
    );
    const blend = rasterizeMask(
      workflow,
      byTitle(workflow, "blend band cut inner")[0],
    );
    const W = 1536;
    expect(blend.w).toBe(W);
    const at = (x: number, y: number) => blend[y * W + x];
    for (const y of [0, 512, 1023]) {
      expect(at(487, y)).toBe(0);
      expect(at(488, y)).toBe(1);
      expect(at(535, y)).toBe(1);
      expect(at(536, y)).toBe(0);
      expect(at(1530, y)).toBe(0); // far (right) edge is the canvas edge, no seam
    }
  });

  it("params.seamHarmonize=false leaves the graph without the pass", () => {
    const { workflow } = buildActionWorkflow(
      packFile(file),
      "pan_right",
      run(1024, 1024),
      0,
      { seamHarmonize: false },
    );
    expect(seamNodes(workflow)).toHaveLength(0);
  });
});

describe("Krea 2 bbox graph", () => {
  it("band pass uses the base UNET + plain prompt encode, not the outpaint LoRA path", () => {
    const { workflow } = buildActionWorkflow(
      packFile("packs/krea2/outpaintv2.json"),
      "zoom_1_5x",
      run(1024, 1024),
      0,
    );
    const [, ks] = byTitle(workflow, "sampler");
    expect(ks.inputs.model).toEqual(["1", 0]); // UNETLoader, before LoRA/patch
    const [posId, pos] = byTitle(workflow, "prompt");
    expect(pos.class_type).toBe("CLIPTextEncode");
    expect(pos.inputs.text).toBe(workflow["7"].inputs.prompt);
    expect(ks.inputs.positive).toEqual([posId, 0]);
    const [, neg] = byTitle(workflow, "negative");
    expect(neg.class_type).toBe("ConditioningZeroOut");
    // the composite keeps the multiband Krea2OutpaintComposite output underneath
    const [, comp] = byTitle(workflow, "composite");
    expect(comp.inputs.destination).toEqual(["12", 0]);
  });
});

describe("addSeamHarmonize", () => {
  it("is idempotent", () => {
    const { workflow } = buildActionWorkflow(
      packFile("outpaint.json"),
      "pan_up",
      run(1024, 1024),
      0,
    );
    const before = JSON.stringify(workflow);
    expect(
      addSeamHarmonize(
        workflow,
        {
          canvasWidth: 1024,
          canvasHeight: 1536,
          x0: 0,
          y0: 512,
          x1: 1024,
          y1: 1536,
        },
        SEAM_HARMONIZE_DEFAULTS,
      ),
    ).toBeNull();
    expect(JSON.stringify(workflow)).toBe(before);
  });

  it("leaves a graph without SaveImage untouched", () => {
    const wf = packFile("outpaint.json");
    delete wf["9"];
    const before = JSON.stringify(wf);
    expect(
      addSeamHarmonize(wf, {
        canvasWidth: 1536,
        canvasHeight: 1024,
        x0: 512,
        y0: 0,
        x1: 1536,
        y1: 1024,
      }),
    ).toBeNull();
    expect(JSON.stringify(wf)).toBe(before);
  });
});

const INFO_FILE = process.env.LIVE_OBJECT_INFO;
const INFO: Record<string, any> | null =
  INFO_FILE && fs.existsSync(INFO_FILE)
    ? JSON.parse(fs.readFileSync(INFO_FILE, "utf-8"))
    : null;

describe.skipIf(!INFO)("seam pass vs LIVE object_info", () => {
  it.each(TEMPLATES)("%s zoom_2x seam nodes validate", (file) => {
    const { workflow } = buildActionWorkflow(
      packFile(file),
      "zoom_2x",
      run(1024, 768),
      0,
    );
    const seamIds = new Set(seamNodes(workflow).map(([id]) => id));
    const problems = validatePrompt(workflow, INFO!)
      .filter((p) => seamIds.has(p.nodeId ?? ""))
      .map((p) => `${p.nodeId} ${p.classType}: ${p.message}`);
    expect(problems).toEqual([]);
    for (const id of seamIds)
      expect(INFO![workflow[id].class_type]).toBeTruthy();
  });
});
