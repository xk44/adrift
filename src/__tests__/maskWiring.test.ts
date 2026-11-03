/**
 * Smart-mask wiring: which tools get which mask picker, how per-subject
 * masks reach /api/jobs/action, and the server side: one paste-back pass per
 * mask, each clamped to its own mask (faces of two subjects never mix).
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { buildActionWorkflow } from "@/lib/oj/engine";
import { buildFiboEditWorkflow } from "@/lib/oj/fiboEdit";
import {
  PASTEBACK_CLASS,
  configurePasteBack,
  PASTEBACK_KNOB_SHORT_SIDE,
  PASTEBACK_MASK_CLAMP_GROW,
  PASTEBACK_MASK_MAX_SIDE,
  PASTEBACK_MAX_MASKS,
  pasteBackClampGrow,
  pasteBackMasks,
  pasteBackRequest,
} from "@/lib/oj/imagePasteBack";
import {
  MASK_PICKER_EXCLUSIONS,
  REGION_MASK_TOOLS,
  actionBodyMask,
  maskPickerKind,
  regionMaskTool,
  regionMasksToSend,
  withRegionMasks,
} from "@/lib/tools/maskWiring";
import { SMART_TRACK_ACTIONS } from "@/lib/tools/smartTrack";
import {
  ACTION_TOOLS,
  defaultSettings,
  MASK_MAX_SIDE,
  getActionTool,
  type EditLoraListResponse,
} from "@/lib/tools/toolsPage";
import { submitActionTool, type FetchLike } from "@/lib/tools/runTool";
import type { ImagineRun, Workflow } from "@/types";

const WORKFLOWS_DIR = path.join(process.cwd(), "public", "workflows");
type Node = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};
type G = Record<string, Node>;

function load(rel: string): G {
  const g = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, rel), "utf-8"));
  delete g._meta;
  return g;
}

function danglingRefs(graph: G): string[] {
  const ids = new Set(Object.keys(graph));
  const bad: string[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const val of Object.values(node.inputs ?? {})) {
      if (Array.isArray(val) && typeof val[0] === "string" && !ids.has(val[0]))
        bad.push(`${nodeId} -> ${val[0]}`);
    }
  }
  return bad;
}

const idsOf = (g: G, cls: string) =>
  Object.keys(g).filter((id) => g[id].class_type === cls);
const link = (v: unknown) => (v as [string, number])[0];

const sourceRun = {
  run_id: "run-m",
  prompt: "two people",
  parsedPrompt: "two people",
  width: 1024,
  height: 1024,
  jobs: [
    {
      seed: 1,
      index: 0,
      status: "done",
      progress: 100,
      images: ["/api/comfy/view?filename=src.png&type=output"],
    },
  ],
  status: "done",
  params: {},
  createdAt: "2026-10-25T00:00:00Z",
} as unknown as ImagineRun;

const M1 = "cj_region_mask1_a.png [input]";
const M2 = "cj_region_mask2_b.png [input]";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

function generic(rel: string, action: string, params: Record<string, unknown>) {
  const { workflow, slots } = buildActionWorkflow(
    load(rel) as unknown as Workflow,
    action,
    sourceRun,
    0,
    params,
  );
  return {
    g: workflow as unknown as G,
    imageInputId: (slots as { imageInputId?: string }).imageInputId!,
  };
}

/** Walk SaveImage back through the clamp chain: [pass, mask ref] per subject. */
function passes(g: G): { pass: string; ref: string; dest: string }[] {
  const save = idsOf(g, "SaveImage").find((id) =>
    Array.isArray(g[id].inputs.images),
  )!;
  const out: { pass: string; ref: string; dest: string }[] = [];
  let cur = link(g[save].inputs.images);
  while (g[cur]?.class_type === "ImageCompositeMasked") {
    const c = g[cur].inputs;
    const pass = link(c.source);
    expect(g[pass].class_type).toBe(PASTEBACK_CLASS);
    const grow = g[link(c.mask)];
    expect(grow.class_type).toBe("GrowMask");
    expect(grow.inputs.expand).toBe(PASTEBACK_MASK_CLAMP_GROW);
    // Clamp copy normalized to a 1024 long side before the grow.
    const norm = g[link(grow.inputs.mask)];
    expect(norm.class_type).toBe("ImageToMask");
    const scaled = g[link(norm.inputs.image)];
    expect(scaled.class_type).toBe("ImageScaleToMaxDimension");
    expect(scaled.inputs.largest_size).toBe(PASTEBACK_MASK_MAX_SIDE);
    const asImage = g[link(scaled.inputs.image)];
    expect(asImage.class_type).toBe("MaskToImage");
    const loadMask = g[link(asImage.inputs.mask)];
    expect(loadMask.class_type).toBe("LoadImageMask");
    // The pass's own region is the same mask it is clamped to.
    expect(link(g[pass].inputs.region)).toBe(link(asImage.inputs.mask));
    // Each pass pastes onto what its clamp composites over.
    expect(g[pass].inputs.original).toEqual(c.destination);
    out.unshift({
      pass,
      ref: loadMask.inputs.image as string,
      dest: link(c.destination),
    });
    cur = link(c.destination);
  }
  return out;
}

describe("tool -> mask picker table", () => {
  it("every region tool is a real image action (not a video tool)", () => {
    for (const id of Object.keys(REGION_MASK_TOOLS)) {
      const spec = getActionTool(id);
      expect(spec, id).toBeDefined();
      expect(spec!.videoInput, id).toBeUndefined();
      expect(SMART_TRACK_ACTIONS.has(id), id).toBe(false);
    }
  });

  it("every SMART_TRACK action is a video tool", () => {
    for (const id of SMART_TRACK_ACTIONS) {
      expect(getActionTool(id)?.videoInput, id).toBeTruthy();
    }
  });

  it("subject-naming tools without a picker are excluded with a reason", () => {
    for (const [id, why] of Object.entries(MASK_PICKER_EXCLUSIONS)) {
      expect(getActionTool(id), id).toBeDefined();
      expect(SMART_TRACK_ACTIONS.has(id), id).toBe(false);
      expect(regionMaskTool(id), id).toBeNull();
      expect(maskPickerKind({ specId: id }), id).toBeNull();
      expect(why.length, id).toBeGreaterThan(20);
    }
    expect(MASK_PICKER_EXCLUSIONS.character_swap).toMatch(/no mask input/);
    // fps is no longer the blocker (client sends sourceFps); no open TODO.
    expect(MASK_PICKER_EXCLUSIONS.video_bg_change).toMatch(/sourceFps/);
    for (const why of Object.values(MASK_PICKER_EXCLUSIONS))
      expect(why).not.toMatch(/TODO/);
  });

  it("every video tool with a subject text is wired or excluded", () => {
    const subjectish = /what to|who to|whose|target/i;
    for (const spec of ACTION_TOOLS) {
      if (!spec.videoInput || !spec.text) continue;
      if (!subjectish.test(spec.text.label)) continue;
      const wired = SMART_TRACK_ACTIONS.has(spec.id);
      const excluded = Object.prototype.hasOwnProperty.call(
        MASK_PICKER_EXCLUSIONS,
        spec.id,
      );
      expect(wired || excluded, spec.id).toBe(true);
    }
  });

  it("picks the right picker per tool", () => {
    expect(maskPickerKind({ specId: "video_remove_text" })).toBe("track");
    expect(maskPickerKind({ specId: "character_swap" })).toBeNull();
    expect(maskPickerKind({ catalogNeedsMask: true })).toBe("inpaint");
    expect(maskPickerKind({ specId: "video_object_swap" })).toBe("track");
    expect(maskPickerKind({ specId: "video_lipsync" })).toBe("track");
    expect(maskPickerKind({ specId: "remove_object" })).toBe("region");
    expect(maskPickerKind({ specId: "replace_person" })).toBe("region");
    expect(maskPickerKind({ specId: "edit_fibo" })).toBe("region");
    expect(maskPickerKind({ specId: "music" })).toBeNull();
    expect(maskPickerKind({})).toBeNull();
    expect(regionMaskTool("__proto__")).toBeNull();
    expect(regionMaskTool(undefined)).toBeNull();
  });

  it("text targets stay optional where a mask replaces them", () => {
    expect(getActionTool("remove_object")!.text?.required).toBe(false);
    expect(getActionTool("replace_person")!.text?.required).toBe(false);
    expect(REGION_MASK_TOOLS.replace_person.subjects).toBe(1);
  });

  it("covers every Edit-category image tool with paste-back", () => {
    const pasteBackTools = ACTION_TOOLS.filter((t) =>
      t.pickers?.some((p) => p.key === "pasteBack"),
    ).map((t) => t.id);
    for (const id of pasteBackTools)
      expect(regionMaskTool(id), id).not.toBeNull();
  });
});

describe("client helpers", () => {
  it("regionMasksToSend keeps painted subjects in order, capped", () => {
    expect(regionMasksToSend("remove_object", [null, PNG])).toEqual([PNG]);
    expect(regionMasksToSend("remove_object", [PNG, PNG + "A"])).toEqual([
      PNG,
      PNG + "A",
    ]);
    expect(regionMasksToSend("replace_person", [PNG, PNG + "A"])).toEqual([
      PNG,
    ]);
    expect(regionMasksToSend("music", [PNG])).toEqual([]);
    expect(regionMasksToSend("edit_photo", ["javascript:x", "", null])).toEqual(
      [],
    );
  });

  it("withRegionMasks forces paste-back and drops the text area / pose", () => {
    const p = {
      prompt: "x",
      pasteBack: false,
      pasteBackArea: "hat",
      pasteBackPose: true,
    };
    expect(withRegionMasks(p, [])).toBe(p);
    expect(withRegionMasks(p, [M1, M2, "c.png [input]"])).toEqual({
      prompt: "x",
      pasteBack: true,
      pasteBackMasks: [M1, M2],
    });
    expect(p.pasteBackArea).toBe("hat");
  });

  it("actionBodyMask only for mask-slot graphs", () => {
    expect(actionBodyMask("edit_inpaint", PNG)).toBe(PNG);
    expect(actionBodyMask("edit_instruct", PNG)).toBeUndefined();
    expect(actionBodyMask("edit_inpaint", null)).toBeUndefined();
  });
});

describe("server: pasteBackMasks parsing", () => {
  it("keeps safe annotated refs only, de-duplicated, capped", () => {
    expect(PASTEBACK_MAX_MASKS).toBe(2);
    expect(pasteBackMasks([M1, M1, "../x.png", PNG, 3, M2, "c.png"])).toEqual([
      M1,
      M2,
    ]);
    expect(pasteBackMasks("a.png")).toEqual([]);
  });

  it("masks turn paste-back on even when it was off; none keeps old shape", () => {
    expect(
      pasteBackRequest({ pasteBack: false, pasteBackMasks: [M1] }, false),
    ).toEqual({ enabled: true, area: "", pose: false, masks: [M1] });
    expect(pasteBackRequest({ pasteBackMasks: ["bad"] }, false)).toEqual({
      enabled: false,
      area: "",
      pose: false,
    });
  });
});

describe("server: one clamped paste-back pass per mask", () => {
  it.each([
    ["packs/flux3/edit.json", "edit_flux3"],
    ["packs/qwen-image-21/edit.json", "edit_qwen21"],
    ["packs/krea2-edit/edit_v2.json", "edit_instruct"],
    ["packs/krea2-edit/edit_v2_dual.json", "edit_instruct_dual"],
  ])("%s: two masks -> two chained passes", (rel, action) => {
    const { g, imageInputId } = generic(rel, action, {
      prompt: "x",
      pasteBackArea: "ignored",
      pasteBackPose: true,
      pasteBackMasks: [M1, M2],
    });
    expect(danglingRefs(g)).toEqual([]);
    const chain = passes(g);
    expect(chain.map((c) => c.ref)).toEqual([M1, M2]);
    // Pass 1 starts from the untouched original, pass 2 from pass 1's clamp.
    expect(chain[0].dest).toBe(imageInputId);
    expect(g[chain[1].dest].class_type).toBe("ImageCompositeMasked");
    expect(link(g[chain[1].dest].inputs.source)).toBe(chain[0].pass);
    expect(chain[0].pass).not.toBe(chain[1].pass);
    for (const { pass } of chain) {
      const inputs = g[pass].inputs;
      // Same edit, separate passes; pose inputs gone, face protect kept.
      expect(inputs.edited).toEqual(g[chain[0].pass].inputs.edited);
      expect(inputs.subject).toBeUndefined();
      expect(inputs.new_content).toBeUndefined();
      // Blobs that sprawl out of the mask are clipped to it, not to the clamp.
      expect(inputs.reach).toBe(0);
      expect(inputs.strict).toBe(true);
      expect(g[link(inputs.protect)].class_type).toBe("SAM3_Detect");
    }
    // The text-prompted region SAM3 is gone (only face protect remains).
    expect(idsOf(g, "SAM3_Detect")).toHaveLength(1);
    expect(idsOf(g, PASTEBACK_CLASS)).toHaveLength(2);
  });

  it("one mask -> one pass, original paste-back node reused", () => {
    const { g, imageInputId } = generic("packs/flux3/edit.json", "edit_flux3", {
      prompt: "x",
      pasteBackMasks: [M1],
    });
    expect(danglingRefs(g)).toEqual([]);
    const chain = passes(g);
    expect(chain).toHaveLength(1);
    expect(chain[0].dest).toBe(imageInputId);
    expect(idsOf(g, PASTEBACK_CLASS)).toEqual([chain[0].pass]);
  });

  it("FIBO 2.0 (shipped chain) honours masks too", () => {
    const { workflow } = buildFiboEditWorkflow(
      load("packs/fibo2/edit.json") as unknown as Workflow,
      sourceRun,
      0,
      { prompt: "make the jacket red", pasteBackMasks: [M1, M2] },
    );
    const g = workflow as unknown as G;
    expect(danglingRefs(g)).toEqual([]);
    expect(passes(g).map((c) => c.ref)).toEqual([M1, M2]);
  });

  it("no masks: graph unchanged by this feature (no clamp nodes)", () => {
    const { g } = generic("packs/flux3/edit.json", "edit_flux3", {
      prompt: "x",
      pasteBack: true,
      pasteBackArea: "hat",
    });
    expect(idsOf(g, "ImageCompositeMasked")).toEqual([]);
    expect(idsOf(g, "LoadImageMask")).toEqual([]);
  });
});

describe("clamp margin covers the pass's grow + feather", () => {
  // Pass alpha in image px: blur(dilate(region, g*px), sigma f*px), px =
  // short/880. Reach of the alpha in normalized clamp-mask px (long = 1024).
  const reachInMaskPx = (w: number, h: number, g = 12, f = 6) => {
    const px = Math.min(w, h) / PASTEBACK_KNOB_SHORT_SIDE;
    const toMask = PASTEBACK_MASK_MAX_SIDE / Math.max(w, h);
    return (g + 3 * f) * px * toMask;
  };

  it("pins the margin math", () => {
    expect(PASTEBACK_KNOB_SHORT_SIDE).toBe(880);
    // The server normalizes the clamp copy itself; the browser exports at
    // source size (up to the canvas cap), which is never smaller.
    expect(PASTEBACK_MASK_MAX_SIDE).toBe(1024);
    expect(MASK_MAX_SIDE).toBeGreaterThanOrEqual(PASTEBACK_MASK_MAX_SIDE);
    // ceil((12 + 3*6) * 1024 / 880) + 1 = ceil(34.9) + 1
    expect(PASTEBACK_MASK_CLAMP_GROW).toBe(36);
    expect(pasteBackClampGrow(12, 6)).toBe(36);
    expect(pasteBackClampGrow(0, 0)).toBe(1);
    expect(pasteBackClampGrow(24, 12)).toBe(71);
    expect(pasteBackClampGrow(Number.NaN, -3)).toBe(1);
  });

  it("reaches >= 3 sigma past the grown region at every source size", () => {
    const sizes: [number, number][] = [
      [1024, 1024],
      [1536, 1536],
      [2048, 2048],
      [4096, 4096],
      [3840, 2160],
      [2160, 3840],
      [800, 600],
      [512, 512],
    ];
    for (const [w, h] of sizes) {
      expect(PASTEBACK_MASK_CLAMP_GROW, `${w}x${h}`).toBeGreaterThan(
        reachInMaskPx(w, h),
      );
    }
    // The old fixed 16 px stopped short on square sources (the seam).
    expect(16).toBeLessThan(reachInMaskPx(1024, 1024));
  });

  it("follows the pass's own grow_px / feather_px", () => {
    const g = {
      "1": { class_type: "LoadImage", inputs: { image: "src.png" } },
      "2": { class_type: "VAEDecode", inputs: {} },
      "3": {
        class_type: PASTEBACK_CLASS,
        inputs: {
          original: ["1", 0],
          edited: ["2", 0],
          grow_px: 24,
          feather_px: 12,
        },
      },
      "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    } as unknown as Workflow;
    configurePasteBack(g, {
      enabled: true,
      area: "",
      pose: false,
      masks: [M1],
    });
    const gg = g as unknown as G;
    const grow = gg[idsOf(gg, "GrowMask")[0]];
    expect(grow.inputs.expand).toBe(pasteBackClampGrow(24, 12));
    expect(danglingRefs(gg)).toEqual([]);
  });
});

describe("submitActionTool uploads each subject mask", () => {
  const loras: EditLoraListResponse = {
    families: { krea2edit: { label: "Krea 2 Edit" } },
    loras: [
      {
        id: "k1",
        name: "K1",
        file: "k1.safetensors",
        family: "krea2edit",
        base: "krea2",
        defaultStrength: 0.9,
        installed: true,
      },
    ] as EditLoraListResponse["loras"],
  };
  const gallery = {
    id: "g",
    source: "gallery" as const,
    previewUrl: "/x.png",
    label: "x",
    width: 512,
    height: 512,
    runId: "run1",
    jobIndex: 0,
  };
  const ok = (data: unknown) => ({
    ok: true,
    status: 200,
    json: async () => data,
  });

  it("two subjects -> two uploads -> pasteBackMasks", async () => {
    const uploads: string[] = [];
    let n = 0;
    const f: FetchLike = vi.fn(async (url, init) => {
      if (url === "/api/comfy/upload") {
        uploads.push(JSON.parse(String(init?.body)).image);
        n += 1;
        return ok({ ok: true, ref: `m${n}.png [input]` });
      }
      return ok({ ok: true, run: { run_id: "n" } });
    });
    await submitActionTool({
      fetchImpl: f,
      spec: getActionTool("remove_object")!,
      settings: { ...defaultSettings(), text: "" },
      editLoras: loras,
      image: gallery,
      secondImage: null,
      clientId: "c",
      subjectMasks: [PNG, PNG + "B"],
      mask: PNG,
    });
    expect(uploads).toEqual([PNG, PNG + "B"]);
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    const [url, init] = calls[calls.length - 1];
    expect(url).toBe("/api/jobs/action");
    const body = JSON.parse(String(init.body));
    expect(body.params.pasteBack).toBe(true);
    expect(body.params.pasteBackMasks).toEqual([
      "m1.png [input]",
      "m2.png [input]",
    ]);
    // Not a mask-slot graph: the union is not sent as body.mask.
    expect(body.mask).toBeUndefined();
  });

  it("no masks: request is unchanged", async () => {
    const f: FetchLike = vi.fn(async () =>
      ok({ ok: true, run: { run_id: "n" } }),
    );
    await submitActionTool({
      fetchImpl: f,
      spec: getActionTool("edit_photo")!,
      settings: { ...defaultSettings(), text: "red" },
      editLoras: loras,
      image: gallery,
      secondImage: null,
      clientId: "c",
      subjectMasks: [null, null],
    });
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((f as ReturnType<typeof vi.fn>).mock.calls[0][1].body),
    );
    expect(body.params.pasteBackMasks).toBeUndefined();
    expect(body.mask).toBeUndefined();
  });
});
